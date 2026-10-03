/// <reference lib="webworker" />
// The town's brain: a small open-source language model (SmolLM2 by Hugging
// Face, Apache-2.0) running on the player's own computer with onnxruntime-web,
// on the graphics card (WebGPU) when there is one, otherwise on the CPU
// (WebAssembly). It runs in a Web Worker so the city keeps moving while it
// thinks. Files can arrive split into parts (hosts that cap file sizes);
// they're stitched back together here, and kept in the browser's cache so
// the download only happens once.

import * as ort from "onnxruntime-web/webgpu";
import { Tokenizer } from "@huggingface/tokenizers";
import type { BrainEvent, BrainRequest, BrainSource, GenerateOptions } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;

interface ModelConfig {
  layers: number;
  kvHeads: number;
  headDim: number;
  eos: Set<number>;
}

let session: ort.InferenceSession | null = null;
let tokenizer: Tokenizer | null = null;
let cfg: ModelConfig | null = null;
let device: "webgpu" | "wasm" = "wasm";
let pastType: "float32" | "float16" = "float32";
let busy: Promise<unknown> = Promise.resolve();

const post = (e: BrainEvent) => self.postMessage(e);
const CACHE = "hustle-brain-v1";

/** Fetch a file (or its parts) with progress, from the browser cache when we have it. */
async function fetchBytes(src: BrainSource, name: string, progress: { loaded: number; total: number }): Promise<Uint8Array> {
  const key = new URL(name, src.base).href;
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(key);
    if (hit) {
      const buf = new Uint8Array(await hit.arrayBuffer());
      progress.loaded += buf.byteLength;
      post({ type: "progress", stage: "download", loaded: progress.loaded, total: progress.total, file: name });
      return buf;
    }
  } catch {
    cache = null; // no Cache API here (private window, sandboxed page): just download
  }
  const parts = src.shards[name] ?? [name];
  const chunks: Uint8Array[] = new Array(parts.length);
  let last = 0;
  await Promise.all(
    parts.map(async (part, i) => {
      let res: Response;
      try {
        res = await fetch(new URL(part, src.base).href);
      } catch {
        throw new Error(`couldn't download ${part.split("/").pop()} from ${new URL(part, src.base).host} (no connection)`);
      }
      if (!res.ok || !res.body) throw Object.assign(new Error(`couldn't download ${part.split("/").pop()} (${res.status})`), { status: res.status });
      const reader = res.body.getReader();
      const got: Uint8Array[] = [];
      let n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got.push(value);
        n += value.byteLength;
        progress.loaded += value.byteLength;
        if (performance.now() - last > 200) {
          last = performance.now();
          post({ type: "progress", stage: "download", loaded: progress.loaded, total: progress.total, file: name });
        }
      }
      const buf = new Uint8Array(n);
      let o = 0;
      for (const g of got) {
        buf.set(g, o);
        o += g.byteLength;
      }
      chunks[i] = buf;
    }),
  );
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = chunks.length === 1 ? chunks[0] : new Uint8Array(total);
  if (chunks.length > 1) {
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
  }
  try {
    await cache?.put(key, new Response(out as Uint8Array<ArrayBuffer>));
  } catch {
    // out of storage: fine, it'll download again next time
  }
  return out;
}

async function fetchJson(src: BrainSource, name: string, progress: { loaded: number; total: number }): Promise<Record<string, unknown>> {
  return JSON.parse(new TextDecoder().decode(await fetchBytes(src, name, progress)));
}

async function pickDevice(want: "auto" | "webgpu" | "wasm"): Promise<"webgpu" | "wasm"> {
  if (want === "wasm") return "wasm";
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    const adapter = gpu ? await gpu.requestAdapter() : null;
    if (adapter) return "webgpu";
  } catch {
    // no WebGPU
  }
  return "wasm";
}

async function load(src: BrainSource, want: "auto" | "webgpu" | "wasm"): Promise<void> {
  const t0 = performance.now();
  const progress = { loaded: 0, total: src.bytes };
  const [wasmParts, config, tokJson, tokCfg] = await Promise.all([
    Promise.all(src.wasm.map((w) => fetchBytes(src, w, progress))),
    fetchJson(src, "config.json", progress),
    fetchJson(src, "tokenizer.json", progress),
    fetchJson(src, "tokenizer_config.json", progress),
  ]);
  // The model file; if it isn't there (404), the next best one.
  let modelBytes: Uint8Array | null = null;
  pastType = src.pastType;
  for (const m of [{ model: src.model, pastType: src.pastType }, ...(src.fallbacks ?? [])]) {
    try {
      modelBytes = await fetchBytes(src, m.model, progress);
      pastType = m.pastType;
      break;
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
    }
  }
  if (!modelBytes) throw new Error("the model file isn't where it should be");
  post({ type: "progress", stage: "compile", loaded: progress.total, total: progress.total, file: src.model });

  const wasm = wasmParts.length === 1 ? wasmParts[0] : concat(wasmParts);
  ort.env.wasm.wasmBinary = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = "error";

  tokenizer = new Tokenizer(tokJson as never, tokCfg as never);
  const heads = Number(config.num_attention_heads);
  const eosIds = ([] as unknown[]).concat(config.eos_token_id ?? []).map(Number);
  for (const t of ["<|im_end|>", "<|endoftext|>", "<|im_start|>"]) {
    const id = tokenizer.token_to_id(t);
    if (id !== undefined) eosIds.push(id);
  }
  cfg = {
    layers: Number(config.num_hidden_layers),
    kvHeads: Number(config.num_key_value_heads ?? heads),
    headDim: Number(config.head_dim ?? Number(config.hidden_size) / heads),
    eos: new Set(eosIds),
  };
  device = await pickDevice(want);
  const create = (ep: "webgpu" | "wasm") =>
    ort.InferenceSession.create(modelBytes!, {
      executionProviders: [ep],
      graphOptimizationLevel: "all",
      // Keep the attention cache on the graphics card between steps.
      ...(ep === "webgpu" ? { preferredOutputLocation: Object.fromEntries(Array.from({ length: cfg!.layers }, (_, i) => [[`present.${i}.key`, "gpu-buffer"], [`present.${i}.value`, "gpu-buffer"]]).flat()) } : {}),
    });
  try {
    session = await create(device);
  } catch (err) {
    if (device !== "webgpu") throw err;
    device = "wasm";
    session = await create("wasm");
  }
  post({ type: "ready", device, name: src.name, ms: Math.round(performance.now() - t0) });
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

function emptyPast(batch = 1): Record<string, ort.Tensor> {
  const feeds: Record<string, ort.Tensor> = {};
  for (let i = 0; i < cfg!.layers; i++) {
    for (const kv of ["key", "value"]) {
      feeds[`past_key_values.${i}.${kv}`] =
        pastType === "float16" ? new ort.Tensor("float16", new Uint16Array(0), [batch, cfg!.kvHeads, 0, cfg!.headDim]) : new ort.Tensor("float32", new Float32Array(0), [batch, cfg!.kvHeads, 0, cfg!.headDim]);
    }
  }
  return feeds;
}

/** IEEE half -> float. */
function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

function lastRow(t: ort.Tensor): Float32Array {
  const dims = t.dims;
  const V = Number(dims[dims.length - 1]);
  const rows = t.size / V;
  const start = (rows - 1) * V;
  const data = t.data as Float32Array | Uint16Array;
  if (data instanceof Float32Array) return data.slice(start, start + V);
  const out = new Float32Array(V);
  for (let i = 0; i < V; i++) out[i] = halfToFloat(data[start + i]);
  return out;
}

function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Top-k, top-p sampling with a repetition penalty and a temperature. */
function sample(row: Float32Array, recent: number[], o: GenerateOptions, rand: () => number, banned: Set<number>): number {
  for (const id of new Set(recent)) row[id] = row[id] > 0 ? row[id] / o.repetitionPenalty : row[id] * o.repetitionPenalty;
  for (const id of banned) row[id] = -Infinity;
  const k = Math.max(1, Math.min(o.topK, row.length));
  const top: number[] = [];
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    if (top.length < k) {
      top.push(i);
      if (top.length === k) top.sort((x, y) => row[y] - row[x]);
    } else if (v > row[top[k - 1]]) {
      let j = k - 1;
      while (j > 0 && row[top[j - 1]] < v) {
        top[j] = top[j - 1];
        j--;
      }
      top[j] = i;
    }
  }
  if (top.length < k) top.sort((x, y) => row[y] - row[x]);
  if (o.temperature <= 0) return top[0];
  const max = row[top[0]];
  const p = top.map((i) => Math.exp((row[i] - max) / o.temperature));
  const sum = p.reduce((a, b) => a + b, 0);
  let cum = 0;
  let cut = top.length;
  for (let i = 0; i < top.length; i++) {
    cum += p[i] / sum;
    if (cum >= o.topP) {
      cut = i + 1;
      break;
    }
  }
  const kept = p.slice(0, cut);
  const total = kept.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < cut; i++) {
    r -= kept[i];
    if (r <= 0) return top[i];
  }
  return top[cut - 1];
}

type Past = Record<string, ort.Tensor>;

/** The model's work on shared prompt starts (the system part), kept for reuse: most recently used last. */
const prefixes: { ids: number[]; past: Past }[] = [];
const MAX_PREFIXES = 4;

function startsWith(ids: number[], prefix: number[]): boolean {
  if (prefix.length >= ids.length) return false;
  for (let i = 0; i < prefix.length; i++) if (ids[i] !== prefix[i]) return false;
  return true;
}

function presentNames(): string[] {
  const out: string[] = [];
  for (let i = 0; i < cfg!.layers; i++) out.push(`present.${i}.key`, `present.${i}.value`);
  return out;
}

/** Run the model over some tokens. Without `logits`, only the attention cache is fetched (reading a prompt: no scores needed). */
async function forward(ids: number[], past: Past, pastLen: number, logits: boolean): Promise<{ past: Past; row: Float32Array | null }> {
  const n = ids.length;
  const names = session!.inputNames;
  const feeds: Record<string, ort.Tensor> = {
    input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, n]),
    attention_mask: new ort.Tensor("int64", new BigInt64Array(pastLen + n).fill(1n), [1, pastLen + n]),
    ...past,
  };
  if (names.includes("position_ids")) feeds.position_ids = new ort.Tensor("int64", BigInt64Array.from({ length: n }, (_, i) => BigInt(pastLen + i)), [1, n]);
  if (names.includes("num_logits_to_keep")) feeds.num_logits_to_keep = new ort.Tensor("int64", BigInt64Array.from([1n]), []);
  const res = logits ? await session!.run(feeds) : await session!.run(feeds, presentNames());
  let row: Float32Array | null = null;
  if (res.logits) {
    if (logits) row = lastRow(res.logits);
    res.logits.dispose();
  }
  const next: Past = {};
  for (let i = 0; i < cfg!.layers; i++) {
    next[`past_key_values.${i}.key`] = res[`present.${i}.key`];
    next[`past_key_values.${i}.value`] = res[`present.${i}.value`];
  }
  return { past: next, row };
}

const disposeAll = (p: Past) => {
  for (const t of Object.values(p)) t.dispose();
};

async function generate(id: number, o: GenerateOptions): Promise<void> {
  if (!session || !tokenizer || !cfg) throw new Error("the brain isn't loaded yet");
  const t0 = performance.now();
  const tok = tokenizer;
  const promptIds = tok.encode(o.prompt, { add_special_tokens: false }).ids.map(Number);
  const forced = o.forced ? tok.encode(o.forced, { add_special_tokens: false }).ids.map(Number) : null;
  const rand = rng(o.seed ?? Math.floor(Math.random() * 2 ** 31));
  const special = new Set<number>(cfg.eos);
  // Start from the kept work on the shared start of the prompt, if there is one (making it if it's new).
  let shared = prefixes.filter((p) => startsWith(promptIds, p.ids)).sort((a, b) => b.ids.length - a.ids.length)[0];
  if (!shared && o.cachePrefix) {
    const ids = tok.encode(o.cachePrefix, { add_special_tokens: false }).ids.map(Number);
    if (startsWith(promptIds, ids)) {
      shared = { ids, past: (await forward(ids, emptyPast(), 0, false)).past };
      prefixes.push(shared);
      if (prefixes.length > MAX_PREFIXES) disposeAll(prefixes.shift()!.past);
    }
  }
  if (shared) prefixes.push(...prefixes.splice(prefixes.indexOf(shared), 1));
  let past: Past = shared ? shared.past : emptyPast();
  let pastLen = shared ? shared.ids.length : 0;
  let owned = !shared; // the kept start isn't ours to throw away
  const out: number[] = [];
  let text = "";
  let prefillMs = 0;
  try {
    // Read the rest of the prompt: all but its last token without scores, then the last one with them.
    const rest = promptIds.slice(pastLen);
    if (rest.length > 1) {
      const r = await forward(rest.slice(0, -1), past, pastLen, false);
      if (owned) disposeAll(past);
      past = r.past;
      owned = true;
      pastLen += rest.length - 1;
    }
    let ids = rest.slice(-1);
    for (let step = 0; step < o.maxNewTokens; step++) {
      const r = await forward(ids, past, pastLen, true);
      if (owned) disposeAll(past);
      past = r.past;
      owned = true;
      pastLen += ids.length;
      if (step === 0) prefillMs = performance.now() - t0;
      const row = r.row!;
      const next = forced ? (forced[step] ?? [...cfg.eos][0]) : sample(row, out.slice(-64), o, rand, step === 0 ? special : new Set());
      if (cfg.eos.has(next) || (forced && step >= forced.length)) break;
      out.push(next);
      ids = [next];
      text = tok.decode(out, { skip_special_tokens: true });
      const hit = o.stop.map((s) => text.indexOf(s)).filter((i) => i >= 0);
      if (hit.length) {
        text = text.slice(0, Math.min(...hit));
        break;
      }
    }
  } finally {
    if (owned) disposeAll(past);
  }
  const ms = performance.now() - t0;
  post({ type: "result", id, text, promptTokens: promptIds.length, newTokens: out.length, ms: Math.round(ms), prefillMs: Math.round(prefillMs), rate: out.length > 1 ? (out.length - 1) / Math.max(0.001, (ms - prefillMs) / 1000) : 0, batch: 1 });
}

// ------------------------------------------------- several at once

/** One prompt in a batch: its tokens, how far it's got, and its own sampling. */
interface Row {
  id: number;
  o: GenerateOptions;
  ids: number[];
  forced: number[] | null;
  rand: () => number;
  out: number[];
  text: string;
  /** Attention mask so far: 0 for the padding in front of a short prompt. */
  mask: number[];
  done: boolean;
}

/** The scores for row b's last position. */
function rowAt(t: ort.Tensor, b: number, rows: number): Float32Array {
  const V = Number(t.dims[t.dims.length - 1]);
  const per = t.size / rows;
  const start = b * per + per - V;
  const data = t.data as Float32Array | Uint16Array;
  if (data instanceof Float32Array) return data.slice(start, start + V);
  const out = new Float32Array(V);
  for (let i = 0; i < V; i++) out[i] = halfToFloat(data[start + i]);
  return out;
}

/** Run the model over the same number of new tokens for every row. */
async function forwardBatch(ids: number[][], masks: number[][], pos: number[][], past: Past, logits: boolean): Promise<{ past: Past; rows: Float32Array[] | null }> {
  const B = ids.length;
  const n = ids[0].length;
  const total = masks[0].length;
  const names = session!.inputNames;
  const feeds: Record<string, ort.Tensor> = {
    input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.flat().map(BigInt)), [B, n]),
    attention_mask: new ort.Tensor("int64", BigInt64Array.from(masks.flat().map(BigInt)), [B, total]),
    ...past,
  };
  if (names.includes("position_ids")) feeds.position_ids = new ort.Tensor("int64", BigInt64Array.from(pos.flat().map(BigInt)), [B, n]);
  if (names.includes("num_logits_to_keep")) feeds.num_logits_to_keep = new ort.Tensor("int64", BigInt64Array.from([1n]), []);
  const res = logits ? await session!.run(feeds) : await session!.run(feeds, presentNames());
  let rows: Float32Array[] | null = null;
  if (res.logits) {
    if (logits) rows = Array.from({ length: B }, (_, b) => rowAt(res.logits, b, B));
    res.logits.dispose();
  }
  const next: Past = {};
  for (let i = 0; i < cfg!.layers; i++) {
    next[`past_key_values.${i}.key`] = res[`present.${i}.key`];
    next[`past_key_values.${i}.value`] = res[`present.${i}.value`];
  }
  return { past: next, rows };
}

/** Positions of the given mask columns: real tokens count 0, 1, 2... from the first one; padding sits at 0. */
function positions(mask: number[], from: number, to: number): number[] {
  let seen = 0;
  const out: number[] = [];
  for (let i = 0; i < to; i++) {
    if (mask[i]) seen++;
    if (i >= from) out.push(Math.max(0, seen - 1));
  }
  return out;
}

/**
 * Several prompts at once. On a graphics card one step costs about the same
 * for four as for one, so this writes for several people in the time of one.
 * Shorter prompts are padded in front (and masked out); each reply is sent
 * back as soon as it's finished.
 */
async function generateBatch(reqs: { id: number; o: GenerateOptions }[]): Promise<void> {
  if (!session || !tokenizer || !cfg) throw new Error("the brain isn't loaded yet");
  const t0 = performance.now();
  const tok = tokenizer;
  const B = reqs.length;
  const pad = [...cfg.eos][0];
  const special = new Set<number>(cfg.eos);
  const rows: Row[] = reqs.map(({ id, o }) => {
    const ids = tok.encode(o.prompt, { add_special_tokens: false }).ids.map(Number);
    return { id, o, ids, forced: o.forced ? tok.encode(o.forced, { add_special_tokens: false }).ids.map(Number) : null, rand: rng(o.seed ?? Math.floor(Math.random() * 2 ** 31)), out: [], text: "", mask: [], done: false };
  });
  const width = Math.max(...rows.map((r) => r.ids.length));
  const padded = rows.map((r) => [...new Array<number>(width - r.ids.length).fill(pad), ...r.ids]);
  for (const r of rows) r.mask = [...new Array<number>(width - r.ids.length).fill(0), ...new Array<number>(r.ids.length).fill(1)];
  let past = emptyPast(B);
  let prefillMs = 0;
  let writeStart = 0;
  let written = 0;
  const finish = (r: Row) => {
    r.done = true;
    const now = performance.now();
    const rate = written > B ? (written - B) / Math.max(0.001, (now - writeStart) / 1000) : 0;
    post({ type: "result", id: r.id, text: r.text, promptTokens: r.ids.length, newTokens: r.out.length, ms: Math.round(now - t0), prefillMs: Math.round(prefillMs), rate, batch: B });
  };
  try {
    // Read the prompts: all but the last column without scores, then the last column with them.
    if (width > 1) {
      const res = await forwardBatch(
        padded.map((p) => p.slice(0, -1)),
        rows.map((r) => r.mask.slice(0, width - 1)),
        rows.map((r) => positions(r.mask, 0, width - 1)),
        past,
        false,
      );
      disposeAll(past);
      past = res.past;
    }
    let cur = padded.map((p) => p[width - 1]);
    const longest = Math.max(...rows.map((r) => r.o.maxNewTokens));
    for (let step = 0; step < longest && rows.some((r) => !r.done); step++) {
      const total = rows[0].mask.length;
      const res = await forwardBatch(
        cur.map((t) => [t]),
        rows.map((r) => r.mask),
        rows.map((r) => positions(r.mask, total - 1, total)),
        past,
        true,
      );
      disposeAll(past);
      past = res.past;
      if (step === 0) {
        prefillMs = performance.now() - t0;
        writeStart = performance.now();
      }
      rows.forEach((r, b) => {
        if (r.done) return;
        const next = r.forced ? (r.forced[step] ?? pad) : sample(res.rows![b], r.out.slice(-64), r.o, r.rand, step === 0 ? special : new Set());
        written++;
        if (cfg!.eos.has(next) || (r.forced && step >= r.forced.length)) return finish(r);
        r.out.push(next);
        r.text = tok.decode(r.out, { skip_special_tokens: true });
        const hit = r.o.stop.map((s) => r.text.indexOf(s)).filter((i) => i >= 0);
        if (hit.length) {
          r.text = r.text.slice(0, Math.min(...hit));
          return finish(r);
        }
        if (r.out.length >= r.o.maxNewTokens) finish(r);
      });
      cur = rows.map((r, b) => (r.done ? pad : r.out[r.out.length - 1] ?? padded[b][width - 1]));
      for (const r of rows) r.mask.push(1);
    }
    for (const r of rows) if (!r.done) finish(r);
  } catch (err) {
    for (const r of rows) {
      if (r.done) continue; // already answered
      r.done = true;
      post({ type: "error", id: r.id, message: (err as Error)?.message ?? String(err) });
    }
  } finally {
    disposeAll(past);
  }
}

// ----------------------------------------------------------- the queue

const queue: { id: number; o: GenerateOptions }[] = [];
let running = false;

/** How many at once: several on a graphics card; on a processor each extra one costs nearly as much again. */
let batchOverride = 0;
const maxBatch = () => batchOverride || (device === "webgpu" ? 4 : 1);

/** Long replies (conversations, day plans) are batched together, and short ones (choices, thoughts, diaries) together, oldest first. */
async function drain(): Promise<void> {
  if (running || !session) return;
  running = true;
  try {
    while (queue.length) {
      // Let requests sent together all arrive, so they can go in one batch.
      await new Promise((r) => setTimeout(r, 0));
      const long = (o: GenerateOptions) => o.maxNewTokens > 100;
      const first = queue.shift()!;
      const batch = [first];
      for (let i = 0; i < queue.length && batch.length < maxBatch(); ) {
        if (long(queue[i].o) === long(first.o)) batch.push(...queue.splice(i, 1));
        else i++;
      }
      if (batch.length === 1) {
        try {
          await generate(first.id, first.o);
        } catch (err) {
          post({ type: "error", id: first.id, message: (err as Error)?.message ?? String(err) });
        }
      } else await generateBatch(batch);
    }
  } finally {
    running = false;
  }
}

self.onmessage = (ev: MessageEvent<BrainRequest>) => {
  const msg = ev.data;
  if (msg.type === "generate") {
    queue.push({ id: msg.id, o: msg.opts });
    void busy.then(drain);
    return;
  }
  busy = busy.then(async () => {
    try {
      batchOverride = msg.batch ?? 0;
      await load(msg.source, msg.device);
      void drain();
    } catch (err) {
      post({ type: "error", message: (err as Error)?.message ?? String(err) });
    }
  });
};
