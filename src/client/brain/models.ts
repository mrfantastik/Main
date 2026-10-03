import { makePack } from "./pack";

// The free, open-source models the town's brain can run, smallest first. All
// are instruction-tuned, Apache-2.0 licensed, and talk in the same chat format
// (ChatML), so the brain's prompts work with each. Bigger ones write better
// conversations but take longer to download and need more of the computer.

export interface ModelChoice {
  id: string;
  name: string;
  /** Hugging Face repository with the ONNX export. */
  repo: string;
  /** About how big the download is (MB), for the button. */
  mb: number;
  note: string;
}

export const MODEL_CHOICES: ModelChoice[] = [
  { id: "smollm2-360m", name: "SmolLM2 360M Instruct", repo: "HuggingFaceTB/SmolLM2-360M-Instruct", mb: 300, note: "Quick and light. Runs on most computers, even without a graphics card. Simple conversations." },
  { id: "qwen2.5-0.5b", name: "Qwen2.5 0.5B Instruct", repo: "onnx-community/Qwen2.5-0.5B-Instruct", mb: 500, note: "Smarter: follows the story better and writes livelier conversations. A graphics card helps." },
  { id: "qwen2.5-1.5b", name: "Qwen2.5 1.5B Instruct", repo: "onnx-community/Qwen2.5-1.5B-Instruct", mb: 1300, note: "The smartest: real back-and-forth, opinions, jokes. Needs a decent graphics card and about 2 GB of memory." },
];

/** The ONNX files to try, best first: half-precision where the graphics card supports it, then 4-bit, then 8-bit. */
async function candidates(): Promise<{ model: string; pastType: "float32" | "float16" }[]> {
  let f16 = false;
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
    f16 = !!(gpu && (await gpu.requestAdapter())?.features.has("shader-f16"));
  } catch {
    f16 = false;
  }
  return [
    ...(f16 ? [{ model: "onnx/model_q4f16.onnx", pastType: "float16" as const }] : []),
    { model: "onnx/model_q4.onnx", pastType: "float32" },
    { model: "onnx/model_quantized.onnx", pastType: "float32" },
  ];
}

class Missing extends Error {}

/** Fetch one file, reporting bytes as they arrive. */
async function fetchFile(url: string, onBytes: (n: number, total: number) => void): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error(
      "this page couldn't reach Hugging Face. If your internet is working, the page is open somewhere that blocks downloads (a preview inside an app, or claude.ai). Open ai-hustle-city.html in Chrome, Edge, Firefox or Safari and try again, or use the links under the model to download its four files yourself and load them here",
    );
  }
  if (res.status === 404) throw new Missing(url);
  if (!res.ok) throw new Error(`Hugging Face said ${res.status} for ${url.split("/").pop()}`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body) {
    const b = await res.blob();
    onBytes(b.size, total || b.size);
    return b;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    onBytes(value.byteLength, total);
  }
  return new Blob(chunks as BlobPart[]);
}

/**
 * Download a model from Hugging Face (once) and put it together as one model
 * file (hustle-model.bin). `progress` gets bytes so far and the expected total.
 */
export async function downloadModel(choice: ModelChoice, progress: (loaded: number, total: number) => void): Promise<Blob> {
  const base = `https://huggingface.co/${choice.repo}/resolve/main/`;
  let loaded = 0;
  let total = choice.mb * 1e6;
  const tick = (n: number) => {
    loaded += n;
    progress(loaded, Math.max(total, loaded));
  };
  const [config, tokenizer, tokenizerConfig] = await Promise.all(["config.json", "tokenizer.json", "tokenizer_config.json"].map((f) => fetchFile(base + f, tick)));
  for (const c of await candidates()) {
    try {
      const model = await fetchFile(base + c.model, (n, t) => {
        if (t) total = Math.max(total, loaded + t);
        tick(n);
      });
      return makePack({ name: choice.name, model: c.model, pastType: c.pastType, repo: choice.repo }, { "config.json": config, "tokenizer.json": tokenizer, "tokenizer_config.json": tokenizerConfig, [c.model]: model });
    } catch (err) {
      if (!(err instanceof Missing)) throw err;
    }
  }
  throw new Error(`${choice.name} has no model file this game can run`);
}

/** Hand the model file to the player as a download (their copy of the third file). */
export function saveToDisk(blob: Blob, name = "hustle-model.bin"): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

/** The four files of a model, for downloading by hand when the page can't reach Hugging Face itself. */
export function modelFiles(choice: ModelChoice): { name: string; url: string }[] {
  return ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_q4.onnx"].map((f) => ({
    name: f.split("/").pop()!,
    url: `https://huggingface.co/${choice.repo}/resolve/main/${f}?download=true`,
  }));
}

/** A downloaded file's text as JSON, even if the browser saved the page around it (a <pre> in an HTML page). */
function readJson(text: string): Record<string, unknown> | null {
  let t = text.replace(/^\uFEFF/, "").trim();
  if (t.startsWith("<")) {
    const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(t);
    if (!pre) return null;
    t = pre[1].replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
  }
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Put a model's files, downloaded by hand, together as one model file. Takes
 * config.json, tokenizer.json, tokenizer_config.json and the .onnx file. It
 * tells them apart by what's in them, so it doesn't matter what the browser
 * called them ("config (1).json", "tokenizer.json.txt", "download") or whether
 * it saved a JSON file as a web page.
 */
export async function packFromFiles(files: File[]): Promise<Blob> {
  let onnx: File | undefined;
  let config: Record<string, unknown> | undefined;
  let tok: Record<string, unknown> | undefined;
  let tokCfg: Record<string, unknown> | undefined;
  const unknown: string[] = [];
  for (const f of files) {
    const head = new Uint8Array(await f.slice(0, 16).arrayBuffer());
    if (/\.onnx$/i.test(f.name) || head[0] === 0x08) {
      // An ONNX model starts with its IR version (protobuf field 1); a text file never does.
      onnx = f;
      continue;
    }
    if (new TextDecoder().decode(head).startsWith("bplist")) throw new Error(`${f.name} was saved as a Safari web archive. Save it again with File > Save As and choose "Page Source"`);
    const j = f.size < 64e6 ? readJson(await f.text()) : null;
    if (!j) unknown.push(f.name);
    else if ("added_tokens" in j || (typeof j.model === "object" && j.model !== null && "vocab" in j.model)) tok = j;
    else if ("model_type" in j || "architectures" in j || "num_hidden_layers" in j) config = j;
    else if ("tokenizer_class" in j || "chat_template" in j || "added_tokens_decoder" in j || "eos_token" in j) tokCfg = j;
    else unknown.push(f.name);
  }
  const missing = [!config && "config.json", !tok && "tokenizer.json", !tokCfg && "tokenizer_config.json", !onnx && "the .onnx model file"].filter(Boolean);
  if (missing.length)
    throw new Error(`pick all four of the model's files together (missing: ${missing.join(", ")}${unknown.length ? `; couldn't read ${unknown.join(", ")}` : ""})`);
  const path = String(config!._name_or_path ?? "");
  const known = MODEL_CHOICES.find((c) => path && c.repo.split("/").pop()!.toLowerCase() === path.split("/").pop()!.toLowerCase());
  const name = known?.name ?? (path ? path.split("/").pop()!.replace(/-/g, " ") : `Your model (${String(config!.model_type ?? "unknown")})`);
  const onnxName = /\.onnx$/i.test(onnx!.name) ? onnx!.name.toLowerCase().replace(/\s*\(\d+\)(?=\.)/, "") : "model_q4.onnx";
  const model = `onnx/${onnxName}`;
  const bytes = (j: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(j));
  return makePack(
    { name, model, pastType: /f16|fp16/.test(model) ? "float16" : "float32", ...(known ? { repo: known.repo } : {}) },
    { "config.json": bytes(config!), "tokenizer.json": bytes(tok!), "tokenizer_config.json": bytes(tokCfg!), [model]: onnx! },
  );
}
