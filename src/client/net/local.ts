import { describeSkip, type AIStatusDTO, type ClientMsg, type HelloMsg, type ServerMsg } from "../../shared/protocol";
import { newWorld as createWorld } from "../../sim";
import { AIDirector } from "../../sim/ai/director";
import { BrainClient } from "../brain/client";
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
const BRAIN_PREF = "hustle.brain";
const AI_ENDPOINT = "hustle.ai.endpoint";

type Endpoint = { url: string; model?: string; key?: string };

function savedEndpoint(): Endpoint | null {
  try {
    const v = JSON.parse(localStorage.getItem(AI_ENDPOINT) ?? "null") as Endpoint | null;
    return v && typeof v.url === "string" && v.url ? v : null;
  } catch {
    return null;
  }
}

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
  private endpoint: Endpoint | null = null;
  /** The town's brain: an open-source model running in this page (the default AI here). */
  private readonly brain: BrainClient | null;
  private lastBrainPush = 0;
  private selected: { kind: "citizen" | "business"; id: string } | null = null;
  private dashboardOpen = false;
  private lastEventId = 0;
  private lastTxId = 0;
  private savedAt: number | null = null;
  private storageOk = true;
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(private deliver: (msg: ServerMsg) => void) {
    const url = freeAIUrl();
    const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
    if (url === undefined) {
      // The default: a small open-source model running right here, on the player's computer.
      this.brain = new BrainClient();
      this.brain.forced = params.get("brain") === "forced";
      this.brain.onChange = () => {
        // Download progress arrives often; the panel doesn't need every byte.
        if (Date.now() - this.lastBrainPush > 300 || this.brain!.status.state !== "loading") {
          this.lastBrainPush = Date.now();
          this.pushState();
        }
      };
      this.director = new AIDirector(this.brain, { total: () => 0, add: () => undefined }, { maxConcurrent: 1, minIntervalMs: 0, timeoutMs: 120_000 });
    } else {
      // ?freeai=<url> (tests, or a model server of your own): a free OpenAI-style endpoint instead.
      this.brain = null;
      this.endpoint = url === null ? null : savedEndpoint();
      this.director = new AIDirector(url === null ? null : createFreeAIClient({ url, custom: this.endpoint }), { total: () => 0, add: () => undefined }, { maxConcurrent: 2, minIntervalMs: 2500, timeoutMs: 45_000 });
    }
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
    if (this.brain) {
      // With a model here (kept in this browser, or published with the page) it wakes by itself,
      // unless the player put it to sleep last time.
      const b = this.brain;
      let pref: string | null = null;
      try {
        pref = localStorage.getItem(BRAIN_PREF);
      } catch {
        pref = null;
      }
      void b.refresh().then(() => {
        if (this.world.ai.mode === "llm" && pref !== "off" && !b.status.needsModel) this.wakeBrain();
        this.pushState();
      });
    } else if (this.director.available && this.world.ai.mode === "llm")
      // Find a free AI service that answers from here (or learn that none can).
      void this.director.probe().then((st) => {
        if (st?.blocked) this.toast("🧠 This page can't reach the internet, so the built-in AI is doing the thinking and talking.", "error");
        else if (st?.connected) this.toast(`🌐 Free AI connected (${st.active}): it's writing thoughts and conversations.`);
        this.pushState();
      });
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

  /** Wake the brain: with the model file given, or the one it already has (or ask for one). `run` downloads one instead. */
  private wakeBrain(given?: Blob, run?: (b: BrainClient) => Promise<void>): void {
    const b = this.brain;
    if (!b || b.status.state === "loading" || b.status.state === "ready") return;
    try {
      localStorage.setItem(BRAIN_PREF, "on");
    } catch {
      // a private window: it'll ask again next time
    }
    if (this.world.ai.mode !== "llm") this.world.ai.mode = "llm";
    (run ? run(b) : b.load("auto", given)).then(
      () => {
        const s = b.status;
        if (s.needsModel) this.toast("🧠 The town's brain needs a model first. Choose one in the 🧠 AI panel (free, downloaded once), or load your hustle-model.bin.");
        else if (s.state === "ready") this.toast(`🧠 The town's brain is awake (${s.name}, ${s.device === "webgpu" ? "on your graphics card" : "on your processor"}). Every citizen is thinking, planning and talking for themselves now.`);
        this.pushState();
      },
      (err: Error) => {
        this.toast(`🧠 The brain couldn't start: ${err.message}. The built-in AI carries on.`, "error");
        this.pushState();
      },
    );
    this.pushState();
  }

  /** The player's model file (hustle-model.bin), picked from disk. */
  loadBrainFile(file: Blob): void {
    if (!this.brain) return;
    if (this.brain.status.state === "ready") this.brain.unload();
    this.toast("🧠 Loading your model file…");
    this.wakeBrain(file);
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
      doing: this.director.doing(this.world),
      done: { ...this.director.tally },
      free: true,
      connection: this.brain ? null : this.director.freeStatus(),
      endpoint: this.endpoint ? { url: this.endpoint.url, model: this.endpoint.model } : null,
      brain: this.brain ? { ...this.brain.status } : null,
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
        this.director.focus = this.selected?.kind === "citizen" ? this.selected.id : null;
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
        if (msg.brain === "load") {
          this.wakeBrain();
          this.pushState();
          break;
        }
        if (msg.brain === "get" && msg.model) {
          const id = msg.model;
          this.toast("🧠 Downloading the model from Hugging Face (free, just this once). It'll be saved as hustle-model.bin in your downloads, and kept in this browser.");
          this.wakeBrain(undefined, (b) => b.getModel(id));
          break;
        }
        if (msg.brain === "forget") {
          void this.brain?.forget().then(() => {
            this.toast("🧠 Forgotten. Load your hustle-model.bin again any time.");
            this.pushState();
          });
          break;
        }
        if (msg.brain === "unload") {
          this.brain?.unload();
          try {
            localStorage.setItem(BRAIN_PREF, "off");
          } catch {
            // fine
          }
          this.toast("🧠 The brain is asleep. The built-in AI does the thinking and talking.");
          this.pushState();
          break;
        }
        if (msg.endpoint !== undefined) {
          this.endpoint = msg.endpoint && msg.endpoint.url ? { url: msg.endpoint.url.trim(), model: msg.endpoint.model?.trim() || undefined, key: msg.endpoint.key?.trim() || undefined } : null;
          try {
            if (this.endpoint) localStorage.setItem(AI_ENDPOINT, JSON.stringify(this.endpoint));
            else localStorage.removeItem(AI_ENDPOINT);
          } catch {
            // a private window: it lasts until the page closes
          }
          this.director.setCustomEndpoint(this.endpoint);
          this.toast(this.endpoint ? `🔌 Using your endpoint first: ${this.endpoint.url}` : "🔌 Back to the built-in list of free services.");
          msg = { type: "ai", probe: true };
        }
        if (msg.probe) {
          this.toast("🌐 Testing the free AI services…");
          void this.director.probe().then((st) => {
            if (!st) return;
            const ok = st.providers.filter((p) => p.state === "ok").map((p) => p.name);
            this.toast(ok.length ? `🌐 Connected: ${ok.join(", ")}.` : st.blocked ? "Can't reach the internet from this page. Pages published on claude.ai can't; download the game file and open it in your browser." : "No free AI service answered just now. Try again in a minute.", ok.length ? "info" : "error");
            this.pushState();
          });
          break;
        }
        if (msg.mode === "llm" && !this.director.available) this.toast("The free AI is switched off for this page.", "error");
        else if (msg.mode) {
          w.ai.mode = msg.mode;
          try {
            localStorage.setItem(AI_PREF, msg.mode === "llm" ? "on" : "off");
          } catch {
            // a private window: the choice lasts until the page closes
          }
          this.toast(
            msg.mode === "llm"
              ? this.brain
                ? "🧠 The town's brain is running things again."
                : "🌐 The free AI is writing conversations again."
              : this.brain
                ? "⏸ The town's brain is resting: the built-in AI runs things."
                : "⚙️ Built-in AI only: no calls leave this page.",
          );
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
      case "invent": {
        const why = this.director.invent(w, typeof msg.idea === "string" ? msg.idea : "");
        this.toast(why ?? "✨ The free AI is dreaming something up…", why ? "error" : "info");
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
