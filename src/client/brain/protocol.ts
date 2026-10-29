// Messages between the page and the town's brain (a small open-source
// language model running in a Web Worker on the player's own computer).

/** Where the model and runtime files come from. */
export interface BrainSource {
  /** Base URL that file names below are relative to. */
  base: string;
  /** Files that are split into parts (name -> part URLs relative to base); others are fetched whole from base + name. */
  shards: Record<string, string[]>;
  /** The ONNX model file name (relative to base). */
  model: string;
  /** Type of the attention cache tensors the model takes. */
  pastType: "float32" | "float16";
  /** Other files to try if the model file isn't there. */
  fallbacks?: { model: string; pastType: "float32" | "float16" }[];
  /** The onnxruntime WebAssembly binary (one URL, or parts). */
  wasm: string[];
  /** Display name, e.g. "SmolLM2 360M Instruct". */
  name: string;
  /** Total download size in bytes (for the progress bar). */
  bytes: number;
  /** The model file (hustle-model.bin) itself, from disk or this browser: nothing to download. */
  pack?: Blob;
  /** The engine's WebAssembly runtime, already in memory (from hustle-brain.js). */
  wasmBinary?: ArrayBuffer;
}

export interface GenerateOptions {
  /** The whole prompt, chat template already applied. */
  prompt: string;
  /** The start of the prompt that many requests share (the system part): the model's work on it is kept and reused. */
  cachePrefix?: string;
  maxNewTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  repetitionPenalty: number;
  /** Stop when the generated text contains one of these. */
  stop: string[];
  /** Tests only: emit this text token by token instead of sampling (the model still runs every step). */
  forced?: string;
  seed?: number;
}

export type BrainRequest =
  /** `batch`: tests only, how many prompts to run at once (normally 4 on a graphics card, 1 on a processor). */
  | { type: "load"; source: BrainSource; device: "auto" | "webgpu" | "wasm"; batch?: number }
  | { type: "generate"; id: number; opts: GenerateOptions };

export type BrainEvent =
  | { type: "progress"; stage: "download" | "compile"; loaded: number; total: number; file: string }
  | { type: "ready"; device: "webgpu" | "wasm"; name: string; ms: number }
  /**
   * `ms`: the whole request; `prefillMs`: the part spent reading the prompt (the rest is writing the reply).
   * `rate`: tokens written a second by the whole batch it ran in; `batch`: how many prompts ran together.
   */
  | { type: "result"; id: number; text: string; promptTokens: number; newTokens: number; ms: number; prefillMs: number; rate: number; batch: number }
  | { type: "error"; id?: number; message: string };
