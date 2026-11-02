import { isCloudModel } from "../sim/ai/localai";

// What the free launcher (`npm run free`) works out about your computer and
// your Ollama: which of your models are really local (never a cloud one),
// which to use, which to download if you've none, and how hard the AI can be
// worked once it's seen how fast your computer answers.

/** A model as Ollama lists it (GET /api/tags). */
export interface OllamaModel {
  name: string;
  model?: string;
  size?: number;
  remote_host?: string;
  remote_model?: string;
  details?: { family?: string; families?: string[] | null; parameter_size?: string };
}

/** Models known to talk well and keep to the reply format, best first (no "thinking" models: they're slow and wrap replies in reasoning). */
export const GOOD_MODELS = ["qwen2.5:14b", "mistral-nemo", "gemma3:12b", "qwen2.5:7b", "llama3.1:8b", "gemma2:9b", "gemma3:4b", "qwen2.5:3b", "llama3.2:3b", "qwen2.5:1.5b", "llama3.2:1b"];

/** Really on this computer: not one of Ollama's cloud models (they run on ollama.com and can use paid credits), and not an embedding model. */
export function localModels(models: OllamaModel[]): OllamaModel[] {
  return models.filter((m) => {
    if (m.remote_host || m.remote_model || isCloudModel(m.name) || isCloudModel(m.model)) return false;
    // (A cloud model's stub is a few KB; a real one is hundreds of MB at least.)
    if (typeof m.size === "number" && m.size < 50e6) return false;
    const fam = [m.details?.family ?? "", ...(m.details?.families ?? [])].join(" ");
    return !/embed|bert|clip|rerank/i.test(`${m.name} ${fam}`);
  });
}

/** "qwen2.5:7b" and "qwen2.5:7b-instruct-q4_K_M" are the same model for our purposes; "llama3.1" means ":latest". */
function sameModel(installed: string, wanted: string): boolean {
  const norm = (s: string) => (s.includes(":") ? s : `${s}:latest`).toLowerCase();
  const a = norm(installed);
  const b = norm(wanted);
  return a === b || a.startsWith(`${b}-`) || (b.endsWith(":latest") && a.split(":")[0] === b.split(":")[0]);
}

/** The installed model to use: the one asked for, else the best of the good ones you have, else the biggest you have (null: none). */
export function chooseInstalled(models: OllamaModel[], wanted?: string): OllamaModel | null {
  const local = localModels(models);
  if (wanted) return local.find((m) => sameModel(m.name, wanted)) ?? null;
  for (const g of GOOD_MODELS) {
    const hit = local.find((m) => sameModel(m.name, g));
    if (hit) return hit;
  }
  // Something else: leave out the reasoning models if there's a choice, then the biggest that isn't huge.
  const plain = local.filter((m) => !/r1|qwq|think|reason|qwen3/i.test(m.name));
  const pool = (plain.length ? plain : local).filter((m) => (m.size ?? 0) < 20e9);
  return [...(pool.length ? pool : local)].sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0] ?? null;
}

/** With no model yet: the one to download for this computer (graphics memory and RAM in GB; null: unknown). */
export function modelForHardware(vramGb: number | null, ramGb: number, appleSilicon = false): { name: string; size: string; why: string } {
  const memory = appleSilicon ? ramGb * 0.6 : vramGb;
  if (memory !== null && memory >= 11) return { name: "qwen2.5:14b", size: "9 GB", why: `you've ${appleSilicon ? "plenty of memory" : `a graphics card with ${Math.round(memory)} GB`}` };
  if (memory !== null && memory >= 6) return { name: "qwen2.5:7b", size: "4.7 GB", why: `you've ${appleSilicon ? "enough memory" : `a graphics card with ${Math.round(memory)} GB`}` };
  if (memory !== null && memory >= 3) return { name: "qwen2.5:3b", size: "1.9 GB", why: `your graphics card has ${Math.round(memory)} GB` };
  if (ramGb >= 12) return { name: "qwen2.5:3b", size: "1.9 GB", why: "no big graphics card found, so a small model that runs on the processor" };
  return { name: "qwen2.5:1.5b", size: "1 GB", why: "a small model for a computer without much memory" };
}

/** How hard to work the model, from how long it took to answer one realistic request (seconds). */
export function settingsForSpeed(seconds: number): { concurrency: number; liveChats: number; timeoutMs: number; pace: "fast" | "steady" | "slow"; note: string } {
  if (seconds <= 2.5)
    return { concurrency: 4, liveChats: 20, timeoutMs: 45_000, pace: "fast", note: "fast enough for the whole town to talk at once at 1× speed" };
  if (seconds <= 8)
    return { concurrency: 2, liveChats: 6, timeoutMs: 60_000, pace: "steady", note: "a few conversations at a time; the clock slows down a little when people are waiting on the AI" };
  return {
    concurrency: 1,
    liveChats: 2,
    timeoutMs: 120_000,
    pace: "slow",
    note: "slow (it's running on the processor), so the town will be quiet and the clock will often slow down to wait for it. A graphics card, or a smaller model (npm run free -- --model qwen2.5:1.5b), makes it livelier",
  };
}

/** Ollama's address, from OLLAMA_HOST if it's set ("0.0.0.0:11434", "http://127.0.0.1:11434", "myhost"). */
export function ollamaBase(env: string | undefined): string {
  let h = (env ?? "").trim();
  if (!h) return "http://127.0.0.1:11434";
  if (!/^https?:\/\//.test(h)) h = `http://${h}`;
  const u = new URL(h);
  if (u.hostname === "0.0.0.0" || u.hostname === "::" || u.hostname === "[::]") u.hostname = "127.0.0.1";
  if (!u.port) u.port = "11434";
  return `${u.protocol}//${u.host}`;
}
