import { describeSkip, type AIStatusDTO, type ClientMsg, type HelloMsg, type ServerMsg } from "../../shared/protocol";
import { newWorld as createWorld } from "../../sim";
import { AIDirector } from "../../sim/ai/director";
import { createFreeAIClient } from "../../sim/ai/freeai";
import { applyGodCommand, GodError } from "../../sim/god";
import { prepareLoadedWorld } from "../../sim/migrate";
import { SimRunner } from "../../sim/runner";
import * as snap from "../../sim/snapshot";
import type { WorldState } from "../../sim/types";

// The "server" for the standalone build: runs the whole simulation inside the
// browser tab and talks to the UI with exactly the same messages the Node
// server sends over its WebSocket. Saves go to the browser's IndexedDB.
// Citizens think with the built-in AI. Their conversations are written by a
// free public AI (no account, no key) whenever it can keep up; the built-in
// AI fills in the rest. Switch it off in the AI panel to stay fully offline.

const DB_NAME = "ai-hustle-city";
const STORE = "worlds";
const KEY = "current";
const AUTOSAVE_MS = 15_000;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readSave(): Promise<string | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function writeSave(json: string): Promise<boolean> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(json, KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  } catch {
    return false;
  }
}

const AI_PREF = "hustle.ai";

/** "?freeai=<url>" points the free AI somewhere else (tests); "?freeai=off" switches it off. */
function freeAIUrl(): string | null | undefined {
  try {
    const v = new URLSearchParams(location.search).get("freeai");
    return v === "off" ? null : v || undefined;
  } catch {
    return undefined;
  }
}

function aiWanted(): boolean {
  try {
    return localStorage.getItem(AI_PREF) !== "off";
  } catch {
    return true;
  }
}

export class LocalHost {
  private runner!: SimRunner;
  private readonly director: AIDirector;
  private selected: { kind: "citizen" | "business"; id: string } | null = null;
  private dashboardOpen = false;
  private lastEventId = 0;
  private lastTxId = 0;
  private savedAt: number | null = null;
  private storageOk = true;
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(private deliver: (msg: ServerMsg) => void) {
    const url = freeAIUrl();
    this.director = new AIDirector(url === null ? null : createFreeAIClient({ url }), { total: () => 0, add: () => undefined }, { maxConcurrent: 1, minIntervalMs: 4000, timeoutMs: 45_000 });
    this.director.attach();
  }

  get world(): WorldState {
    return this.runner.world;
  }

  async start(): Promise<void> {
    const raw = await readSave();
    let world: WorldState | null = null;
    if (raw) {
      try {
        world = prepareLoadedWorld(JSON.parse(raw));
      } catch {
        world = null;
      }
    }
    if (world) this.savedAt = world.time;
    this.runner = new SimRunner(world ?? this.fresh());
    this.configureAI(this.runner.world);
    this.runner.afterSteps = (w) => {
      this.director.pump(w);
      for (const n of this.director.notices.splice(0)) this.toast(n.text, n.level);
    };
    this.sendHello();
    this.runner.start();
    this.timers.push(setInterval(() => this.deliver(snap.frame(this.world, this.runner.speed, this.runner.paused)), 100));
    this.timers.push(setInterval(() => this.pushState(), 500));
    this.timers.push(setInterval(() => this.dashboardOpen && this.deliver(snap.dashboard(this.world)), 1500));
    this.timers.push(setInterval(() => void this.save(), AUTOSAVE_MS));
    const saveOnLeave = () => {
      if (document.visibilityState === "hidden") void this.save();
    };
    document.addEventListener("visibilitychange", saveOnLeave);
    window.addEventListener("pagehide", () => void this.save());
    if (!world && raw) this.toast("Your saved city couldn't be loaded, so a new one was started.", "error");
  }

  private fresh(seed?: number): WorldState {
    const s = seed ?? Date.now() % 1_000_000;
    const w = createWorld(s);
    w.id = `w${s.toString(36)}-${Date.now().toString(36)}`;
    return w;
  }

  private configureAI(world: WorldState): void {
    world.ai.model = this.director.model;
    world.ai.maxCallsPerDay = 5000;
    world.ai.mode = this.director.available && aiWanted() ? "llm" : "off";
  }

  private aiStatus(): AIStatusDTO {
    const ai = this.world.ai;
    return {
      mode: ai.mode,
      available: this.director.available,
      model: ai.model,
      spentUsd: 0,
      budgetUsd: 0,
      calls: ai.calls,
      callsToday: ai.callsToday,
      maxCallsPerDay: ai.maxCallsPerDay,
      pending: this.director.pending,
      reason: this.director.available ? null : "the free AI is switched off for this page.",
      writer: this.director.writer,
      free: true,
    };
  }

  private sendHello(): void {
    const w = this.world;
    const hello: HelloMsg = { type: "hello", worldName: w.name, seed: w.seed, map: w.map, persistence: this.storageOk ? "this browser" : "none (storage blocked)" };
    this.deliver(hello);
    this.lastEventId = Math.max(0, w.events[w.events.length - 41]?.id ?? 0);
    this.lastTxId = 0;
    this.pushState();
  }

  private toast(text: string, level: "info" | "error" = "info"): void {
    this.deliver({ type: "toast", text, level });
  }

  private pushState(): void {
    const w = this.world;
    const events = w.events.filter((e) => e.id > this.lastEventId).slice(-60);
    if (events.length) this.lastEventId = events[events.length - 1].id;
    const fx = this.lastTxId > 0 ? snap.moneyFx(w, this.lastTxId) : [];
    this.lastTxId = w.transactions[w.transactions.length - 1]?.id ?? this.lastTxId;
    this.deliver(snap.state(w, { speed: this.runner.speed, paused: this.runner.paused, events, ai: this.aiStatus(), savedAt: this.savedAt, fx }));
    this.pushDetail();
  }

  private pushDetail(): void {
    const sel = this.selected;
    const detail = !sel ? null : sel.kind === "citizen" ? snap.citizenDetail(this.world, sel.id) : snap.businessDetail(this.world, sel.id);
    if (sel) this.deliver({ type: "detail", detail });
  }

  async save(): Promise<boolean> {
    const w = this.world;
    const ok = await writeSave(JSON.stringify(w));
    this.storageOk = ok;
    if (ok) this.savedAt = w.time;
    return ok;
  }

  /** The whole world as JSON (for "copy save"). */
  exportJson(): string {
    return JSON.stringify(this.world);
  }

  private replaceWorld(world: WorldState): void {
    this.runner.world = world;
    this.configureAI(world);
    this.selected = null;
    this.savedAt = null;
    this.sendHello();
    void this.save();
  }

  handle(msg: ClientMsg): void {
    const w = this.world;
    switch (msg.type) {
      case "speed":
        this.runner.setSpeed(msg.speed);
        this.runner.paused = false;
        break;
      case "pause":
        this.runner.paused = msg.paused;
        break;
      case "select":
        this.selected = msg.kind && msg.id ? { kind: msg.kind, id: msg.id } : null;
        if (this.selected) this.pushDetail();
        else this.deliver({ type: "detail", detail: null });
        break;
      case "dashboard":
        this.dashboardOpen = msg.open;
        if (msg.open) this.deliver(snap.dashboard(w));
        break;
      case "god":
        try {
          this.toast(`⚡ ${applyGodCommand(w, msg.command)}`);
        } catch (err) {
          this.toast(err instanceof GodError ? err.message : `God mode failed: ${(err as Error).message}`, "error");
        }
        break;
      case "ai":
        if (msg.mode === "llm" && !this.director.available) this.toast("The free AI is switched off for this page.", "error");
        else if (msg.mode) {
          w.ai.mode = msg.mode;
          try {
            localStorage.setItem(AI_PREF, msg.mode === "llm" ? "on" : "off");
          } catch {
            // a private window: the choice lasts until the page closes
          }
          this.toast(msg.mode === "llm" ? "🌐 The free AI is writing conversations again." : "⚙️ Built-in AI only: no calls leave this page.");
        }
        this.pushState();
        break;
      case "skip": {
        const minutes = Number(msg.minutes);
        if (!Number.isFinite(minutes) || minutes <= 0) break;
        const n = this.runner.skip(minutes);
        this.pushState();
        if (this.dashboardOpen) this.deliver(snap.dashboard(w));
        this.toast(`⏩ Skipped ${describeSkip(minutes)} — ${n} things happened. It's now ${snap.describeTime(w.time)}.`);
        break;
      }
      case "unscripted":
      case "invent": {
        const why = msg.type === "unscripted" ? this.director.unscripted(w, Number(msg.convId)) : this.director.invent(w, typeof msg.idea === "string" ? msg.idea : "");
        this.toast(why ?? (msg.type === "unscripted" ? "✨ The free AI is writing their conversation…" : "✨ The free AI is dreaming something up…"), why ? "error" : "info");
        break;
      }
      case "save":
        void this.save().then((ok) => this.toast(ok ? "💾 Saved in this browser." : "Couldn't save: this browser is blocking storage for the page.", ok ? "info" : "error"));
        break;
      case "reset":
        this.replaceWorld(this.fresh(msg.seed));
        this.toast(`🌱 A brand-new city (seed ${this.world.seed}).`);
        break;
      case "import": {
        const loaded = prepareLoadedWorld(msg.world);
        if (!loaded) {
          this.toast("That file isn't an AI Hustle City save.", "error");
          break;
        }
        this.replaceWorld(loaded);
        this.toast(`📂 Loaded ${loaded.name} at ${snap.describeTime(loaded.time)}.`);
        break;
      }
      default:
        break;
    }
  }
}
