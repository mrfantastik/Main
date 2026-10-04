import type { LLMClient, LLMRequest, LLMResponse } from "../../sim/ai/llm";
import { readChoice, readDiary, readLines, readPlan, readThought, readTurn, type SmallPrompt } from "../../sim/ai/small";
import { downloadModel, MODEL_CHOICES, saveToDisk } from "./models";
import { forgetPack, packInfo, storedPack, storePack } from "./pack";
import type { BrainEvent, BrainRequest, BrainSource, GenerateOptions } from "./protocol";

// The page's side of the town's brain: starts the worker (the AI engine,
// hustle-brain.js, or the copy inside a single-file game), finds the model
// (a model file you give it, the one kept in this browser, or files published
// next to the page; or it downloads one you choose, once), and turns the
// director's requests into short prompts and the plain-text replies back into
// what the director expects. Nothing is sent anywhere but the worker.

export type BrainState = "off" | "loading" | "ready" | "error";

export interface BrainStatus {
  state: BrainState;
  name: string;
  /** Where the model came from: "file" (a model file, given or kept in this browser), "page" (published with it) or "huggingface" (downloading). */
  from: "page" | "huggingface" | "file" | null;
  device: "webgpu" | "wasm" | null;
  stage: "download" | "compile" | null;
  loaded: number;
  total: number;
  error: string | null;
  /** Generated tokens per second, recent average. */
  speed: number;
  replies: number;
  /** There's no model yet: the player chooses one (or loads their model file). */
  needsModel: boolean;
  /** The AI engine is here (hustle-brain.js, or built into the page). */
  engine: boolean;
  /** It came as its own file (hustle-brain.js), not built into a single-file game. */
  engineFile: boolean;
  /** The model kept in this browser, if any. */
  stored: string | null;
}

const ORT_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort-wasm-simd-threaded.asyncify.wasm";

type Engine = { __HUSTLE_BRAIN__?: string; __HUSTLE_ORT__?: string };

/** The engine's WebAssembly runtime, if the engine file carries it (gzipped; a fresh copy each time: it's handed over to the worker). */
async function engineWasm(): Promise<ArrayBuffer | undefined> {
  const b64 = (globalThis as Engine).__HUSTLE_ORT__;
  if (!b64 || typeof DecompressionStream === "undefined") return undefined;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new Response(new Blob([out]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

/** The model published next to the page (brain/manifest.json), if there is one. */
export async function pageSource(): Promise<BrainSource | null> {
  if (location.protocol === "file:") return null; // pages opened from disk can't read files next to them
  try {
    const base = new URL("brain/", document.baseURI).href;
    const res = await fetch(new URL("manifest.json", base).href);
    if (res.ok) return { ...((await res.json()) as Omit<BrainSource, "base">), base };
  } catch {
    // not published with the page (e.g. opened from a file)
  }
  return null;
}

/** A model file published next to the page (hustle-model.bin), when the page is served from somewhere. `peek` only checks it's there. */
async function pagePack(peek = false): Promise<Blob | null> {
  if (location.protocol === "file:") return null; // pages opened from disk can't read files next to them
  try {
    const res = await fetch(new URL("hustle-model.bin", document.baseURI).href);
    // A server that answers every path with the page itself doesn't count.
    if (!res.ok || /text\/html/.test(res.headers.get("content-type") ?? "")) return null;
    if (peek && res.body) {
      const reader = res.body.getReader();
      let got = new Uint8Array(0);
      while (got.byteLength < 12) {
        const { done, value } = await reader.read();
        if (done) break;
        const next = new Uint8Array(got.byteLength + value.byteLength);
        next.set(got);
        next.set(value, got.byteLength);
        got = next;
      }
      void reader.cancel();
      return new TextDecoder().decode(got.subarray(0, 12)) === "HUSTLEMODEL1" ? new Blob([got]) : null;
    }
    const blob = await res.blob();
    await packInfo(blob);
    return blob;
  } catch {
    return null;
  }
}

/** The shared start of every prompt with this system message (the model's work on it is kept). */
function chatmlStart(system: string): string {
  return `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n`;
}

function chatml(system: string, user: string, prefill: string): string {
  return `${chatmlStart(system)}${user}<|im_end|>\n<|im_start|>assistant\n${prefill}`;
}

type Reply = { text: string; promptTokens: number; newTokens: number; ms: number; prefillMs: number };

export class BrainClient implements LLMClient {
  readonly model = "SmolLM2 (in your browser)";
  readonly free = true;
  readonly small = true;
  readonly label = "Town brain (runs on your computer)";
  status: BrainStatus = { state: "off", name: "", from: null, device: null, stage: null, loaded: 0, total: 0, error: null, speed: 0, replies: 0, needsModel: false, engine: !!(globalThis as Engine).__HUSTLE_BRAIN__, engineFile: !!(globalThis as Engine).__HUSTLE_ORT__, stored: null };
  /** Tests: write the reply instead of sampling it (the model still runs every step). */
  forced = false;
  onChange: (() => void) | null = null;
  private worker: Worker | null = null;
  private seq = 1;
  private waiting = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();

  ready(): boolean {
    return this.status.state === "ready";
  }

  /**
   * On a graphics card it writes for up to four people at once (one step
   * costs about the same), with a couple more waiting so it can put
   * similar-length replies together; on a processor, one at a time.
   */
  parallel(): number {
    return this.status.device === "webgpu" ? 6 : 1;
  }

  /** On a processor and slower than ~15 tokens a second: a conversation would keep people waiting. */
  slow(): boolean {
    return this.status.device === "wasm" && (this.status.speed === 0 || this.status.speed < 15);
  }

  private set(patch: Partial<BrainStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onChange?.();
  }

  private startWorker(source: BrainSource, fromFile: boolean): Worker {
    const inline = (globalThis as Engine).__HUSTLE_BRAIN__;
    // Published with the page: the worker file sits next to the model. Otherwise it's the engine file (or carried inside the page).
    if (fromFile) return new Worker(new URL("worker.js", source.base).href, { type: "module" });
    if (!inline) throw new Error("the AI engine file (hustle-brain.js) isn't next to the game. Keep all three files in the same folder");
    const code = new TextDecoder().decode(Uint8Array.from(atob(inline), (ch) => ch.charCodeAt(0)));
    return new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
  }

  /** Check what's kept in this browser (for the panel). */
  async refresh(): Promise<void> {
    const blob = await storedPack();
    let stored: string | null = null;
    if (blob) {
      try {
        stored = (await packInfo(blob)).name;
      } catch {
        await forgetPack(); // not a model file after all
      }
    }
    // Nothing to wake with yet: say so up front, so "wake" goes straight to choosing one.
    const needsModel = this.status.state !== "ready" && this.status.state !== "loading" && !stored && !(await this.hasModel());
    this.set({ stored, needsModel });
  }

  /** Is there a model to wake with, without asking the player? */
  async hasModel(): Promise<boolean> {
    return !!(await storedPack()) || !!(await pagePack(true)) || !!(await pageSource());
  }

  /**
   * Start the model: the model file given (kept in this browser for next
   * time), or the one already kept, or the one published with the page. With
   * none, it asks the player to choose one (needsModel).
   */
  async load(device: "auto" | "webgpu" | "wasm" = "auto", given?: Blob): Promise<void> {
    if (this.status.state === "loading" || this.status.state === "ready") return;
    this.set({ state: "loading", stage: "compile", loaded: 0, error: null, needsModel: false });
    try {
      let source: BrainSource | null = null;
      let from: BrainStatus["from"] = "file";
      const kept = given ?? (await storedPack());
      const blob = kept ?? (await pagePack());
      if (blob && !kept) from = "page";
      if (blob) {
        const meta = await packInfo(blob);
        if (given) {
          try {
            await storePack(given);
            this.set({ stored: meta.name });
          } catch {
            // a private window: it works for now, but has to be loaded again next time
          }
        }
        const wasmBinary = await engineWasm();
        source = { base: ORT_CDN.slice(0, ORT_CDN.lastIndexOf("/") + 1), shards: {}, model: meta.model, pastType: meta.pastType, wasm: wasmBinary ? [] : [ORT_CDN], name: meta.name, bytes: blob.size, pack: blob, wasmBinary };
      } else {
        source = await pageSource();
        from = "page";
      }
      if (!source) {
        // Nothing to run yet: the player picks a model (or loads their model file).
        this.set({ state: "off", stage: null, needsModel: true });
        return;
      }
      this.set({ name: source.name, from, total: source.bytes });
      // The worker file next to the model first; if the page isn't allowed to start it, the copy inside the page.
      let started = false;
      try {
        await this.boot(source, device, from === "page", () => (started = true));
      } catch (err) {
        if (from !== "page" || started) throw err;
        await this.boot(source, device, false, () => (started = true));
      }
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.fail(message);
      throw new Error(message);
    }
  }

  /** Download a model (once), give the player their copy of the model file, keep it in this browser, and start it. */
  async getModel(id: string, device: "auto" | "webgpu" | "wasm" = "auto"): Promise<void> {
    const choice = MODEL_CHOICES.find((c) => c.id === id);
    if (!choice) throw new Error("no such model");
    if (this.status.state === "loading" || this.status.state === "ready") return;
    this.set({ state: "loading", stage: "download", loaded: 0, total: choice.mb * 1e6, name: choice.name, from: "huggingface", error: null, needsModel: false });
    let blob: Blob;
    try {
      blob = await downloadModel(choice, (loaded, total) => this.set({ loaded, total }));
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.fail(message);
      throw new Error(message);
    }
    saveToDisk(blob);
    this.set({ state: "off" });
    await this.load(device, blob);
  }

  /** Forget the model kept in this browser (it can be loaded again from the model file). */
  async forget(): Promise<void> {
    await forgetPack();
    await this.refresh();
  }

  private async boot(source: BrainSource, device: "auto" | "webgpu" | "wasm", fromFile: boolean, onStarted: () => void): Promise<void> {
    {
      this.worker?.terminate();
      const w = this.startWorker(source, fromFile);
      this.worker = w;
      await new Promise<void>((resolve, reject) => {
        w.onerror = (e) => reject(new Error(e.message || "the brain's worker couldn't start here"));
        w.onmessage = (ev: MessageEvent<BrainEvent>) => {
          const m = ev.data;
          onStarted();
          if (m.type === "progress") this.set({ stage: m.stage, loaded: m.loaded, total: Math.max(m.total, m.loaded) });
          else if (m.type === "ready") {
            this.set({ state: "ready", device: m.device, stage: null, loaded: this.status.total });
            resolve();
          } else if (m.type === "error" && m.id === undefined) reject(new Error(m.message));
          else this.onResult(m);
        };
        // The runtime is handed over, not copied (the model file goes as a reference to it).
        w.postMessage({ type: "load", source, device } satisfies BrainRequest, source.wasmBinary ? [source.wasmBinary] : []);
      });
      w.onmessage = (ev: MessageEvent<BrainEvent>) => this.onResult(ev.data);
      w.onerror = (e) => this.fail(e.message || "the brain stopped");
    }
  }

  unload(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const w of this.waiting.values()) w.reject(new Error("the brain was switched off"));
    this.waiting.clear();
    this.set({ state: "off", device: null, stage: null });
  }

  private fail(message: string): void {
    this.worker?.terminate();
    this.worker = null;
    for (const w of this.waiting.values()) w.reject(new Error(message));
    this.waiting.clear();
    this.set({ state: "error", error: message, stage: null });
  }

  private onResult(m: BrainEvent): void {
    if (m.type !== "result" && !(m.type === "error" && m.id !== undefined)) return;
    const w = this.waiting.get(m.id!);
    if (!w) return;
    this.waiting.delete(m.id!);
    if (m.type === "error") w.reject(new Error(m.message));
    else {
      // Writing speed, for everyone it was writing for at once (reading the prompt is quicker, and not what people wait on line by line).
      const writing = m.rate;
      const speed = !writing ? this.status.speed : this.status.speed ? this.status.speed * 0.7 + writing * 0.3 : writing;
      this.set({ replies: this.status.replies + 1, speed });
      w.resolve(m);
    }
  }

  /** Generate a raw continuation (also used by tests). */
  generate(opts: GenerateOptions): Promise<Reply> {
    if (!this.worker || this.status.state !== "ready") return Promise.reject(new Error("the brain isn't awake"));
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker!.postMessage({ type: "generate", id, opts } satisfies BrainRequest);
    });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const p = req.small;
    if (!p) throw new Error("the in-page brain only takes short prompts");
    const base = { prompt: chatml(p.system, p.user, p.prefill), cachePrefix: chatmlStart(p.system), topK: 50, seed: Math.floor(Math.random() * 2 ** 31) };
    // How long, how adventurous, and where to stop, for each kind of reply.
    const shape: Record<SmallPrompt["kind"], Omit<GenerateOptions, "prompt" | "cachePrefix" | "topK" | "seed">> = {
      lines: { maxNewTokens: 220, temperature: 0.85, topP: 0.92, repetitionPenalty: 1.15, stop: ["<|im_", "\n\n\n"] },
      // One person's next line: short, and stop before anyone else speaks.
      turn: { maxNewTokens: 48, temperature: 0.85, topP: 0.92, repetitionPenalty: 1.15, stop: ["\n", "<|im_"] },
      thought: { maxNewTokens: 60, temperature: 0.9, topP: 0.92, repetitionPenalty: 1.1, stop: ["\n"] },
      // A pick and a reason: stop before it starts listing the options again.
      choice: { maxNewTokens: 44, temperature: 0.6, topP: 0.9, repetitionPenalty: 1.05, stop: ["\n\n", "<|im_", ...Array.from({ length: 9 }, (_, i) => `\n${i + 1}`)] },
      plan: { maxNewTokens: 120, temperature: 0.8, topP: 0.92, repetitionPenalty: 1.1, stop: ["\n\n", "<|im_"] },
      diary: { maxNewTokens: 70, temperature: 0.9, topP: 0.92, repetitionPenalty: 1.1, stop: ["\n\n", "<|im_"] },
    };
    const opts: GenerateOptions = { ...base, ...shape[p.kind] };
    if (this.forced) opts.forced = forcedReply(p.kind, p.names ?? [], p.prefill);
    const r = await this.generate(opts);
    const text = p.prefill + r.text;
    let json: unknown = null;
    if (p.kind === "lines") {
      const lines = readLines(text, p.names ?? []);
      json = lines.length >= 2 ? { lines } : null;
    } else if (p.kind === "turn") {
      const line = readTurn(text, p.names?.[0] ?? "", p.names?.[1] ?? "");
      json = line ? { line } : null;
    } else if (p.kind === "thought") {
      const t = readThought(text, "");
      json = t ? { thought: t } : null;
    } else if (p.kind === "plan") {
      const items = readPlan(text, p.options ?? [], p.labels ?? []);
      json = items.length >= 2 ? { items } : null;
    } else if (p.kind === "diary") {
      const t = readDiary(text);
      json = t ? { text: t } : null;
    } else json = readChoice(text, p.options ?? []);
    return { json, inputTokens: r.promptTokens, outputTokens: r.newTokens, model: `brain:${this.status.name}` };
  }
}

/** What a forced (test) reply says: recognisable, and in the right shape. */
let forcedTurns = 0;

function forcedReply(kind: SmallPrompt["kind"], names: string[], prefill: string): string {
  if (kind === "turn") return ` Well, ${names[1] ?? "you"}, that's turn ${++forcedTurns} from me. #brain`;
  if (kind === "lines") return ` Well, look who it is! #brain\n${names[1]}: Hello yourself. #brain\n${names[0]}: Busy day? #brain\n${names[1]}: Always. #brain`;
  if (kind === "thought") return "I wonder what today will bring, #brain.";
  if (kind === "plan") {
    // From the first time it was given, every two and a half hours: the first few things on the list, in order.
    const m = prefill.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)/);
    const start = m ? (Number(m[1]) % 12) + (m[3] === "pm" ? 12 : 0) + (m[2] ? 0.5 : 0) : 8;
    return ` 1 - first things first #brain\n${[1, 2, 3].map((k) => `${Math.floor(start + k * 2.5)}:00: ${k + 1} - then this #brain`).join("\n")}`;
  }
  if (kind === "diary") return " was a long day, #brain. Tomorrow I'll do better.";
  return "1. It feels right. #brain";
}
