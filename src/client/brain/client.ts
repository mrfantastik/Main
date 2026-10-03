import type { LLMClient, LLMRequest, LLMResponse } from "../../sim/ai/llm";
import { readChoice, readDiary, readLines, readPlan, readThought, type SmallPrompt } from "../../sim/ai/small";
import type { BrainEvent, BrainRequest, BrainSource, GenerateOptions } from "./protocol";

// The page's side of the town's brain: starts the worker, finds the model
// files (next to the page when it's published with them, otherwise from
// Hugging Face), and turns the director's requests into short prompts for a
// small model and its plain-text replies back into what the director
// expects. One request at a time; nothing is sent anywhere but the worker.

export type BrainState = "off" | "loading" | "ready" | "error";

export interface BrainStatus {
  state: BrainState;
  name: string;
  /** Where the files come from: "page" (published with it) or "huggingface". */
  from: "page" | "huggingface" | null;
  device: "webgpu" | "wasm" | null;
  stage: "download" | "compile" | null;
  loaded: number;
  total: number;
  error: string | null;
  /** Generated tokens per second, recent average. */
  speed: number;
  replies: number;
}

const HF_BASE = "https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct/resolve/main/";
const ORT_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort-wasm-simd-threaded.asyncify.wasm";

/** Where the model is: published next to the page (brain/manifest.json), or straight from Hugging Face. */
export async function findBrainSource(): Promise<{ source: BrainSource; from: "page" | "huggingface" }> {
  try {
    const base = new URL("brain/", document.baseURI).href;
    const res = await fetch(new URL("manifest.json", base).href);
    if (res.ok) {
      const m = (await res.json()) as Omit<BrainSource, "base">;
      return { source: { ...m, base }, from: "page" };
    }
  } catch {
    // not published with the page (e.g. opened from a file): use Hugging Face
  }
  let f16 = false;
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
    const adapter = gpu ? await gpu.requestAdapter() : null;
    f16 = !!adapter?.features.has("shader-f16");
  } catch {
    f16 = false;
  }
  return {
    from: "huggingface",
    source: {
      base: HF_BASE,
      shards: {},
      model: f16 ? "onnx/model_q4f16.onnx" : "onnx/model_q4.onnx",
      pastType: f16 ? "float16" : "float32",
      fallbacks: [
        { model: "onnx/model_q4.onnx", pastType: "float32" },
        { model: "onnx/model_quantized.onnx", pastType: "float32" },
      ],
      wasm: [ORT_CDN],
      name: "SmolLM2 360M Instruct",
      bytes: (f16 ? 299 : 380) * 1e6 + 27e6,
    },
  };
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
  status: BrainStatus = { state: "off", name: "", from: null, device: null, stage: null, loaded: 0, total: 0, error: null, speed: 0, replies: 0 };
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
    const inline = (globalThis as { __HUSTLE_BRAIN__?: string }).__HUSTLE_BRAIN__;
    // Published with the page: the worker file sits next to the model. Otherwise it's carried inside the page.
    if (fromFile) return new Worker(new URL("worker.js", source.base).href, { type: "module" });
    if (!inline) throw new Error("this page doesn't include the brain");
    const code = new TextDecoder().decode(Uint8Array.from(atob(inline), (ch) => ch.charCodeAt(0)));
    return new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
  }

  /** Download (once; the browser keeps it) and start the model. */
  async load(device: "auto" | "webgpu" | "wasm" = "auto"): Promise<void> {
    if (this.status.state === "loading" || this.status.state === "ready") return;
    this.set({ state: "loading", stage: "download", loaded: 0, error: null });
    try {
      const { source, from } = await findBrainSource();
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
      let message = (err as Error).message ?? String(err);
      if (this.status.from === "huggingface" && /no connection/.test(message))
        message = /claude/.test(location.hostname)
          ? "this copy of the game doesn't include the model, and pages published on claude.ai can't download it. Open the game file in your browser instead"
          : "couldn't download the model from Hugging Face. Check your internet connection and try again";
      this.fail(message);
      throw new Error(message);
    }
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
        w.postMessage({ type: "load", source, device } satisfies BrainRequest);
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
function forcedReply(kind: SmallPrompt["kind"], names: string[], prefill: string): string {
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
