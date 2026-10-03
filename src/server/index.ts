import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { describeSkip, type AIStatusDTO, type ClientMsg, type HelloMsg, type ServerMsg } from "../shared/protocol";
import { newWorld as createWorld } from "../sim";
import { applyGodCommand, GodError } from "../sim/god";
import * as snap from "../sim/snapshot";
import type { WorldState } from "../sim/types";
import { AIDirector } from "../sim/ai/director";
import type { SpendLedger } from "../sim/ai/director";
import { prepareLoadedWorld } from "../sim/migrate";
import { createClaudeClient } from "./anthropic";
import { openJsonStore } from "./persistence/jsonStore";
import { openSqliteStore } from "./persistence/sqliteStore";
import type { WorldStore } from "./persistence/store";
import { SimRunner } from "../sim/runner";

// AI Hustle City server: runs the simulation continuously and streams it to
// any number of browser clients over a WebSocket.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

/** Load settings from .env (if present) without extra dependencies. */
function loadEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (value !== "" && process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnv(path.join(root, ".env"));
const PORT = Number(process.env.PORT ?? 3000);
const PROD = process.argv.includes("--prod");

interface Client {
  ws: WebSocket;
  selected: { kind: "citizen" | "business"; id: string } | null;
  dashboard: boolean;
  lastEventId: number;
  lastTxId: number;
}

const clients = new Set<Client>();
let runner: SimRunner;

// ---- AI (Claude) configuration. Everything works without it.
const AI_MODEL = process.env.AI_MODEL || "claude-opus-5-5";
const AI_BUDGET_USD = Number(process.env.AI_BUDGET_USD ?? 2);
const AI_MAX_CALLS_PER_DAY = Number(process.env.AI_MAX_CALLS_PER_DAY ?? 12);
const DATA_DIR = process.env.DATA_DIR ?? path.join(root, "data");
const AUTOSAVE_MS = Number(process.env.AUTOSAVE_SECONDS ?? 30) * 1000;

let store: WorldStore;
let savedAt: number | null = null;
let savedEventId = 0;
let savedTxId = 0;

/** Lifetime Claude spend, kept in the database so the cap survives restarts and resets. */
const ledger: SpendLedger = {
  total: () => Number(store?.getMeta("aiSpendUsd") ?? 0),
  add: (usd) => store?.setMeta("aiSpendUsd", String(ledger.total() + usd)),
};
const director = new AIDirector(createClaudeClient(AI_MODEL), ledger);
director.attach();

function configureAI(world: WorldState): void {
  world.ai.model = director.model;
  world.ai.budgetUsd = AI_BUDGET_USD;
  world.ai.maxCallsPerDay = AI_MAX_CALLS_PER_DAY;
  world.ai.mode = director.available ? "llm" : "off";
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function hello(world: WorldState): HelloMsg {
  return { type: "hello", worldName: world.name, seed: world.seed, map: world.map, persistence: store.kind };
}

function aiStatus(world: WorldState): AIStatusDTO {
  const ai = world.ai;
  return {
    mode: ai.mode,
    available: director.available,
    model: director.model,
    spentUsd: ledger.total(),
    budgetUsd: ai.budgetUsd,
    calls: ai.calls,
    callsToday: ai.callsToday,
    maxCallsPerDay: ai.maxCallsPerDay,
    pending: director.pending,
    reason: director.unavailableReason,
    writer: director.available ? `Claude (${director.model})` : null,
  };
}

function newWorld(seed?: number): WorldState {
  const s = seed ?? (Date.now() % 1_000_000);
  const world = createWorld(s);
  world.id = `w${s.toString(36)}-${Date.now().toString(36)}`;
  configureAI(world);
  return world;
}

/** Save a snapshot and append new history rows. */
function saveWorld(reason: string): void {
  const world = runner.world;
  try {
    const events = world.events.filter((e) => e.id > savedEventId);
    const txs = world.transactions.filter((t) => t.id > savedTxId);
    store.appendHistory(world.id, events, txs);
    store.saveSnapshot(world);
    savedEventId = world.events[world.events.length - 1]?.id ?? savedEventId;
    savedTxId = world.transactions[world.transactions.length - 1]?.id ?? savedTxId;
    savedAt = world.time;
    if (reason !== "autosave") console.log(`  💾 Saved (${reason}) at game time ${world.time}`);
  } catch (err) {
    console.error("  ⚠️  Save failed:", (err as Error).message);
  }
}

function resumeOrCreate(): WorldState {
  const raw = store.loadLatest();
  const loaded = raw ? prepareLoadedWorld(raw) : null;
  if (loaded && !process.env.SEED) {
    configureAI(loaded);
    savedEventId = loaded.events[loaded.events.length - 1]?.id ?? 0;
    savedTxId = loaded.transactions[loaded.transactions.length - 1]?.id ?? 0;
    savedAt = loaded.time;
    console.log(`  📂 Resumed ${loaded.name} at Day ${Math.floor(loaded.time / 1440) + 1} (seed ${loaded.seed}) from ${store.kind}`);
    return loaded;
  }
  if (raw && !loaded) console.log("  ⚠️  Saved world was incompatible — starting a new one.");
  const w = newWorld(Number(process.env.SEED) || undefined);
  console.log(`  🌱 New world (seed ${w.seed})`);
  return w;
}

function handle(client: Client, msg: ClientMsg): void {
  const world = runner.world;
  switch (msg.type) {
    case "speed":
      runner.setSpeed(msg.speed);
      runner.paused = false;
      break;
    case "pause":
      runner.paused = msg.paused;
      break;
    case "select":
      client.selected = msg.kind && msg.id ? { kind: msg.kind, id: msg.id } : null;
      pushDetail(client);
      break;
    case "dashboard":
      client.dashboard = msg.open;
      if (msg.open) send(client.ws, snap.dashboard(world));
      break;
    case "god": {
      try {
        const text = applyGodCommand(world, msg.command);
        send(client.ws, { type: "toast", text: `⚡ ${text}`, level: "info" });
      } catch (err) {
        send(client.ws, { type: "toast", text: err instanceof GodError ? err.message : `God mode failed: ${(err as Error).message}`, level: "error" });
      }
      break;
    }
    case "ai": {
      if (msg.mode) {
        if (msg.mode === "llm" && !director.available) {
          send(client.ws, { type: "toast", text: `Claude isn't available: ${director.unavailableReason ?? "no API key"}`, level: "error" });
        } else world.ai.mode = msg.mode;
      }
      if (msg.budgetUsd !== undefined && Number.isFinite(msg.budgetUsd) && msg.budgetUsd >= 0) world.ai.budgetUsd = msg.budgetUsd;
      if (msg.maxCallsPerDay !== undefined && msg.maxCallsPerDay >= 0) world.ai.maxCallsPerDay = Math.round(msg.maxCallsPerDay);
      break;
    }
    case "skip": {
      const minutes = Number(msg.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) break;
      const events = runner.skip(minutes);
      broadcastState();
      for (const c of clients) send(c.ws, { type: "toast", text: `⏩ Skipped ${describeSkip(minutes)} — ${events} things happened. It's now ${snap.describeTime(world.time)}.`, level: "info" });
      break;
    }
    case "unscripted":
    case "invent": {
      const why = msg.type === "unscripted" ? director.unscripted(world, Number(msg.convId)) : director.invent(world, typeof msg.idea === "string" ? msg.idea : "");
      send(client.ws, why ? { type: "toast", text: why, level: "error" } : { type: "toast", text: msg.type === "unscripted" ? "✨ Claude is writing their conversation…" : "✨ Claude is dreaming something up…", level: "info" });
      break;
    }
    case "save":
      saveWorld("manual");
      send(client.ws, { type: "toast", text: "💾 World saved.", level: "info" });
      break;
    case "import": {
      const loaded = prepareLoadedWorld(msg.world);
      if (!loaded) {
        send(client.ws, { type: "toast", text: "That file isn't an AI Hustle City save.", level: "error" });
        break;
      }
      saveWorld("before import");
      configureAI(loaded);
      runner.world = loaded;
      savedEventId = loaded.events[loaded.events.length - 1]?.id ?? 0;
      savedTxId = loaded.transactions[loaded.transactions.length - 1]?.id ?? 0;
      saveWorld("imported");
      for (const c of clients) {
        c.lastEventId = Math.max(0, loaded.events[loaded.events.length - 41]?.id ?? 0);
        c.lastTxId = 0;
        c.selected = null;
        send(c.ws, hello(loaded));
        send(c.ws, { type: "toast", text: `📂 Loaded ${loaded.name} at ${snap.describeTime(loaded.time)}.`, level: "info" });
      }
      break;
    }
    case "reset": {
      saveWorld("before reset");
      runner.world = newWorld(msg.seed);
      savedEventId = 0;
      savedTxId = 0;
      saveWorld("new world");
      for (const c of clients) {
        c.lastEventId = 0;
        c.lastTxId = 0;
        c.selected = null;
        send(c.ws, hello(runner.world));
      }
      break;
    }
    default:
      break;
  }
}

function pushDetail(client: Client): void {
  const world = runner.world;
  const sel = client.selected;
  const detail = !sel ? null : sel.kind === "citizen" ? snap.citizenDetail(world, sel.id) : snap.businessDetail(world, sel.id);
  send(client.ws, { type: "detail", detail });
}

function broadcastFrames(): void {
  if (clients.size === 0) return;
  const msg = JSON.stringify(snap.frame(runner.world, runner.speed, runner.paused));
  for (const c of clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(msg);
}

function broadcastState(): void {
  const world = runner.world;
  for (const c of clients) {
    const events = world.events.filter((e) => e.id > c.lastEventId).slice(-60);
    if (events.length) c.lastEventId = events[events.length - 1].id;
    const fx = c.lastTxId > 0 ? snap.moneyFx(world, c.lastTxId) : [];
    c.lastTxId = world.transactions[world.transactions.length - 1]?.id ?? c.lastTxId;
    send(c.ws, snap.state(world, { speed: runner.speed, paused: runner.paused, events, ai: aiStatus(world), savedAt, fx }));
    if (c.selected) pushDetail(c);
  }
}

function broadcastDashboard(): void {
  const world = runner.world;
  for (const c of clients) if (c.dashboard) send(c.ws, snap.dashboard(world));
}

// ------------------------------------------------------------- static files

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const dist = path.join(root, "dist/client");
  const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
  let file = path.join(dist, url);
  if (!file.startsWith(dist)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, "index.html");
  if (!existsSync(file)) {
    res.writeHead(500).end("Client not built. Run: npm run build");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

async function main(): Promise<void> {
  store = (await openSqliteStore(path.join(DATA_DIR, "hustle.db"))) ?? openJsonStore(DATA_DIR);
  console.log(`\n  🗄️  Persistence: ${store.kind} in ${DATA_DIR}`);
  runner = new SimRunner(resumeOrCreate());

  let viteMiddleware: ((req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void) | null = null;
  if (!PROD) {
    const { createServer } = await import("vite");
    const vite = await createServer({
      configFile: path.join(root, "vite.config.ts"),
      server: { middlewareMode: true, hmr: false },
      appType: "spa",
    });
    viteMiddleware = vite.middlewares;
  }

  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/api/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, time: runner.world.time, citizens: runner.world.citizenOrder.length, seed: runner.world.seed, savedAt, persistence: store.kind }));
      return;
    }
    if (req.url?.startsWith("/api/export")) {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="hustle-city-day${Math.floor(runner.world.time / 1440) + 1}.json"` });
      res.end(JSON.stringify(runner.world));
      return;
    }
    if (req.url?.startsWith("/api/history")) {
      const u = new URL(req.url, "http://x");
      const limit = Math.min(500, Number(u.searchParams.get("limit") ?? 100));
      const before = u.searchParams.get("before");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(store.eventHistory(runner.world.id, limit, before ? Number(before) : undefined)));
      return;
    }
    if (viteMiddleware) viteMiddleware(req, res, () => res.writeHead(404).end());
    else serveStatic(req, res);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/ws")) wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  wss.on("connection", (ws) => {
    const client: Client = { ws, selected: null, dashboard: false, lastEventId: 0, lastTxId: 0 };
    clients.add(client);
    send(ws, hello(runner.world));
    // Send recent history so the feed isn't empty.
    client.lastEventId = Math.max(0, (runner.world.events[runner.world.events.length - 41]?.id ?? 0));
    ws.on("message", (data) => {
      try {
        handle(client, JSON.parse(String(data)) as ClientMsg);
      } catch (err) {
        send(ws, { type: "toast", text: `Bad command: ${(err as Error).message}`, level: "error" });
      }
    });
    ws.on("close", () => clients.delete(client));
  });

  runner.afterSteps = (w) => {
    director.pump(w);
    for (const n of director.notices.splice(0)) for (const c of clients) send(c.ws, { type: "toast", text: n.text, level: n.level });
  };
  runner.start();
  setInterval(() => saveWorld("autosave"), AUTOSAVE_MS);
  const shutdown = () => {
    saveWorld("shutdown");
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.log(director.available ? `  🧠 Claude enabled (${director.model}), budget $${AI_BUDGET_USD}, spent so far $${ledger.total().toFixed(3)}` : "  🧠 Claude disabled (no ANTHROPIC_API_KEY) — using the built-in utility AI");
  setInterval(broadcastFrames, 100);
  setInterval(broadcastState, 500);
  setInterval(broadcastDashboard, 1500);

  server.listen(PORT, () => {
    console.log(`\n  🏙️  AI Hustle City is running:  http://localhost:${PORT}\n`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
