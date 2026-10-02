import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { AIStatusDTO, ClientMsg, HelloMsg, ServerMsg } from "../shared/protocol";
import { newWorld as createWorld } from "../sim";
import * as snap from "../sim/snapshot";
import type { WorldState } from "../sim/types";
import { SimRunner } from "./runner";

// AI Hustle City server: runs the simulation continuously and streams it to
// any number of browser clients over a WebSocket.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const PORT = Number(process.env.PORT ?? 3000);
const PROD = process.argv.includes("--prod");

interface Client {
  ws: WebSocket;
  selected: { kind: "citizen" | "business"; id: string } | null;
  dashboard: boolean;
  lastEventId: number;
}

const clients = new Set<Client>();
let runner: SimRunner;

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function hello(world: WorldState): HelloMsg {
  return { type: "hello", worldName: world.name, seed: world.seed, map: world.map, persistence: "memory" };
}

function aiStatus(world: WorldState): AIStatusDTO {
  const ai = world.ai;
  return { mode: ai.mode, available: false, model: ai.model, spentUsd: ai.spentUsd, budgetUsd: ai.budgetUsd, calls: ai.calls, callsToday: ai.callsToday, maxCallsPerDay: ai.maxCallsPerDay, pending: 0 };
}

function newWorld(seed?: number): WorldState {
  const s = seed ?? (Date.now() % 1_000_000);
  return createWorld(s);
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
      if (msg.open) send(client.ws, snap.dashboard(world, world.ai.log));
      break;
    case "reset": {
      runner.world = newWorld(msg.seed);
      for (const c of clients) {
        c.lastEventId = 0;
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
    send(c.ws, snap.state(world, { speed: runner.speed, paused: runner.paused, events, ai: aiStatus(world), savedAt: null }));
    if (c.selected) pushDetail(c);
  }
}

function broadcastDashboard(): void {
  const world = runner.world;
  for (const c of clients) if (c.dashboard) send(c.ws, snap.dashboard(world, world.ai.log));
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
  runner = new SimRunner(newWorld(Number(process.env.SEED) || undefined));

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
      res.end(JSON.stringify({ ok: true, time: runner.world.time, citizens: runner.world.citizenOrder.length }));
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
    const client: Client = { ws, selected: null, dashboard: false, lastEventId: 0 };
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

  runner.start();
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
