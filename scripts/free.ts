// The totally free way to play: every conversation, thought and decision in
// town written by an open-source model running on this computer, through
// Ollama. No account, no API key, no credits, nothing to pay, and nothing
// leaves your computer.
//
//   npm run free                          (Windows: double-click Play-Free.bat)
//   npm run free -- --model qwen2.5:7b    a particular model (downloaded if need be)
//   npm run free -- --no-open             don't open the browser
//   npm run free -- --port 3001           another port
//
// It finds Ollama (and starts it if it's installed but not running), picks one
// of your models (never one of Ollama's cloud models, which run on ollama.com
// and can use paid credits) or downloads a free one that suits your computer,
// times one answer to see how hard the AI can be worked, then starts the game
// with only the AI speaking, thinking and deciding, and opens it in your browser.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import os from "node:os";
import { chooseInstalled, localModels, modelForHardware, ollamaBase, settingsForSpeed, type OllamaModel } from "../src/server/free";
import { isCloudModel } from "../src/sim/ai/localai";

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
};
const flag = (name: string) => args.includes(`--${name}`);

const BASE = ollamaBase(process.env.OLLAMA_HOST);
const PORT = Number(arg("port") ?? process.env.PORT ?? 3000);
const say = (s = "") => console.log(s ? `  ${s}` : "");

async function get<T>(path: string, ms = 3000): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(ms) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

function hasOllama(): boolean {
  const r = spawnSync("ollama", ["--version"], { stdio: "ignore" });
  return !r.error && r.status === 0;
}

function openInBrowser(url: string): void {
  const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    // (No browser to open: the address is printed.)
  }
}

/** Graphics memory in GB, if an NVIDIA card says (null: couldn't tell). */
function vram(): number | null {
  const r = spawnSync("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  const mb = Math.max(...String(r.stdout).split(/\r?\n/).map(Number).filter((n) => Number.isFinite(n) && n > 0));
  return Number.isFinite(mb) ? mb / 1024 : null;
}

let started: ChildProcess | null = null;

/** Ollama answering on BASE: already running, or started here. */
async function ensureOllama(): Promise<boolean> {
  if (await get("/api/version")) return true;
  if (!hasOllama()) return false;
  say("Starting Ollama...");
  started = spawn("ollama", ["serve"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
    // Four at once, and room for the town's longer prompts (only if you haven't set your own).
    env: { ...process.env, OLLAMA_NUM_PARALLEL: process.env.OLLAMA_NUM_PARALLEL ?? "4", OLLAMA_CONTEXT_LENGTH: process.env.OLLAMA_CONTEXT_LENGTH ?? "4096" },
  });
  started.on("error", () => undefined);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await get("/api/version", 1000)) return true;
  }
  return false;
}

/** Download a model with Ollama, showing progress. */
async function pull(name: string): Promise<boolean> {
  const res = await fetch(`${BASE}/api/pull`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: name, stream: true }) }).catch(() => null);
  if (!res?.ok || !res.body) return false;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let last = "";
  let ok = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
        if (j.error) {
          process.stdout.write("\n");
          say(`Ollama couldn't download it: ${j.error}`);
          return false;
        }
        if (j.status === "success") ok = true;
        const bar = j.total && j.completed !== undefined ? ` ${Math.floor((j.completed / j.total) * 100)}% of ${(j.total / 1e9).toFixed(1)} GB` : "";
        const text = `  ${j.status ?? ""}${bar}`;
        if (text !== last) process.stdout.write(`\r${text.padEnd(70)}`);
        last = text;
      } catch {
        // (a partial line; the rest comes next)
      }
    }
  }
  process.stdout.write("\n");
  return ok;
}

/** How long one realistic request takes (seconds; null: it didn't answer). The first also loads the model. */
async function timeOne(model: string): Promise<number | null> {
  const town = Array.from({ length: 60 }, (_, i) => `Fact ${i + 1}: someone in town did something ordinary today.`).join(" ");
  const body = {
    model,
    messages: [
      { role: "system", content: `You speak for a resident of a small British town in a life simulation. ${town} Reply with only JSON.` },
      { role: "user", content: 'Your neighbour says: "Morning! Busy day?" Reply as JSON: {"spoken": "what you say"}' },
    ],
    response_format: { type: "json_object" },
    temperature: 0.9,
  };
  const once = async () => {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) }).catch(() => null);
    if (!res?.ok) return null;
    await res.json().catch(() => null);
    return (Date.now() - t0) / 1000;
  };
  if ((await once()) === null) return null;
  return once();
}

async function main(): Promise<void> {
  say();
  say("🏙️  AI Hustle City, totally free: the AI runs on this computer with Ollama.");
  say("    No account, no API key, no credits: nothing to pay, and nothing leaves your computer.");
  say();

  if (!(await ensureOllama())) {
    say("Ollama isn't installed (or isn't running). It's free:");
    say("  1. Download it from https://ollama.com/download and install it.");
    say("     (You don't need an ollama.com account, an API key or any credits: those are for Ollama's");
    say("     cloud models, which this game never uses.)");
    say("  2. Run this again.");
    if (!flag("no-open")) openInBrowser("https://ollama.com/download");
    process.exit(1);
  }

  const wanted = arg("model") ?? process.env.AI_MODEL;
  if (wanted && isCloudModel(wanted)) {
    say(`${wanted} is one of Ollama's cloud models: it runs on ollama.com and can use up paid credits, so the free version won't use it.`);
    say("Pick a model that runs on this computer, e.g. --model qwen2.5:7b");
    process.exit(1);
  }
  const tags = (await get<{ models?: OllamaModel[] }>("/api/tags"))?.models ?? [];
  let model = chooseInstalled(tags, wanted)?.name ?? null;
  if (!model) {
    const pick = wanted ? { name: wanted, size: "", why: "you asked for it" } : modelForHardware(vram(), os.totalmem() / 2 ** 30, process.platform === "darwin" && process.arch === "arm64");
    const others = localModels(tags).map((m) => m.name);
    say(`${others.length ? `You have ${others.join(", ")}, but` : "You haven't got a model yet, so"} downloading ${pick.name}${pick.size ? ` (${pick.size}, free, once)` : ""}: ${pick.why}.`);
    if (!(await pull(pick.name))) {
      say(`Couldn't download ${pick.name}. Check your internet connection, or download one yourself with: ollama pull ${pick.name}`);
      process.exit(1);
    }
    model = pick.name;
  }
  say(`Model: ${model} (on this computer).`);

  say("Timing an answer (the first one also loads the model, so it takes a moment)...");
  const secs = await timeOne(model);
  if (secs === null) {
    say(`${model} didn't answer. Try: ollama run ${model}   (to see what's wrong), then run this again.`);
    process.exit(1);
  }
  const plan = settingsForSpeed(secs);
  say(`It answered in ${secs.toFixed(1)} s: ${plan.note}.`);
  say();

  // Everything the game needs to know, and nothing that could cost money.
  Object.assign(process.env, {
    LOCAL_ONLY: "1",
    AI_PROVIDER: "free",
    FREE_AI_URL: `${BASE}/v1/chat/completions`,
    AI_MODEL: model,
    AI_ONLY: process.env.AI_ONLY ?? "1",
    FREE_AI_INTERVAL_MS: "0",
    FREE_AI_TIMEOUT_MS: String(plan.timeoutMs),
    AI_CONCURRENCY: process.env.AI_CONCURRENCY ?? String(plan.concurrency),
    AI_LIVE_CHATS: process.env.AI_LIVE_CHATS ?? String(plan.liveChats),
    AI_MAX_CALLS_PER_DAY: "1000000",
    PORT: String(PORT),
    // Only this computer can open it (so Windows doesn't ask to let it through the firewall).
    HOST: process.env.HOST ?? "127.0.0.1",
  });
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.FREE_AI_KEY;
  process.on("exit", () => {
    try {
      started?.kill();
    } catch {
      // already gone
    }
  });

  await import("../src/server/index");
  if (!flag("no-open")) {
    const url = `http://localhost:${PORT}`;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const up = await fetch(`http://127.0.0.1:${PORT}`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
      if (up) break;
    }
    openInBrowser(url);
    say(`Opened ${url} in your browser. Leave this window open while you play; close it (or press Ctrl+C) to stop.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
