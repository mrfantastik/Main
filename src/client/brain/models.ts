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
    throw new Error("couldn't reach Hugging Face. Check your internet connection and try again (pages published on claude.ai can't download it: open the game file instead)");
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
