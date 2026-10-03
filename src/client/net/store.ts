import { useSyncExternalStore } from "react";
import type {
  BusinessDetail,
  CitizenDetail,
  ClientMsg,
  ConversationDTO,
  DashboardMsg,
  FrameMsg,
  HelloMsg,
  ServerMsg,
  StateMsg,
} from "../../shared/protocol";
import type { SimEvent } from "../../sim/types";

// Client-side store: holds the latest messages from the server and notifies
// React components. Position frames are kept separately for the renderer
// (they arrive 10x/second and don't need to re-render React).

export type Selection = { kind: "citizen" | "business"; id: string } | null;

export interface ClientState {
  connected: boolean;
  hello: HelloMsg | null;
  state: StateMsg | null;
  detail: CitizenDetail | BusinessDetail | null;
  dashboard: DashboardMsg | null;
  events: SimEvent[];
  selection: Selection;
  panel: "none" | "dashboard" | "god" | "ai" | "help";
  toasts: { id: number; text: string; level: "info" | "error" }[];
  followSelected: boolean;
}

const EVENT_CAP = 400;

class Store {
  s: ClientState = {
    connected: false,
    hello: null,
    state: null,
    detail: null,
    dashboard: null,
    events: [],
    selection: null,
    panel: "none",
    toasts: [],
    followSelected: false,
  };
  frames: FrameMsg[] = [];
  /** Conversation transcripts seen so far (so old feed items can still open them). */
  conversations = new Map<number, ConversationDTO>();
  /** Real time (ms) when the latest frame arrived. */
  lastFrameAt = 0;
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private local: import("./local").LocalHost | null = null;
  private toastId = 1;
  /** True in the single-file build that runs the whole city in the browser. */
  readonly standalone = import.meta.env.MODE === "standalone";

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.s;

  private set(patch: Partial<ClientState>) {
    this.s = { ...this.s, ...patch };
    for (const l of this.listeners) l();
  }

  connect() {
    if (this.standalone) {
      void import("./local").then(async ({ LocalHost }) => {
        const host = new LocalHost((msg) => this.onMessage(msg));
        this.local = host;
        await host.start();
        this.set({ connected: true });
      });
      return;
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.set({ connected: true });
      if (this.s.selection) this.send({ type: "select", kind: this.s.selection.kind, id: this.s.selection.id });
      if (this.s.panel === "dashboard" || this.s.panel === "ai") this.send({ type: "dashboard", open: true });
    };
    ws.onclose = () => {
      this.set({ connected: false });
      setTimeout(() => this.connect(), 1500);
    };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data) as ServerMsg);
  }

  send(msg: ClientMsg) {
    if (this.local) this.local.handle(msg);
    else if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Standalone build only: the current world as JSON. */
  exportWorld(): string | null {
    return this.local?.exportJson() ?? null;
  }

  /** Standalone build only: save straight away (e.g. before the page is replaced). */
  saveNow(): void {
    void this.local?.save();
  }

  private onMessage(msg: ServerMsg) {
    switch (msg.type) {
      case "hello": {
        this.frames = [];
        // A different city (new world / imported save): close whatever was open.
        const otherCity = !!this.s.hello && this.s.hello.seed !== msg.seed;
        this.set({ hello: msg, events: [], detail: null, ...(otherCity ? { selection: null } : {}) });
        break;
      }
      case "frame":
        // After a time skip, old frames would make people glide across town.
        if (this.frames.length && msg.t - this.frames[this.frames.length - 1].t > 120) this.frames = [];
        this.frames.push(msg);
        if (this.frames.length > 40) this.frames.splice(0, this.frames.length - 40);
        this.lastFrameAt = performance.now();
        break;
      case "state": {
        for (const c of msg.conversations) this.conversations.set(c.id, c);
        if (this.conversations.size > 300) {
          const keys = [...this.conversations.keys()].slice(0, this.conversations.size - 300);
          for (const k of keys) this.conversations.delete(k);
        }
        const events = msg.events.length ? [...this.s.events, ...msg.events].slice(-EVENT_CAP) : this.s.events;
        this.set({ state: msg, events });
        break;
      }
      case "detail":
        this.set({ detail: msg.detail });
        break;
      case "dashboard":
        this.set({ dashboard: msg });
        break;
      case "toast":
        this.toast(msg.text, msg.level);
        break;
    }
  }

  toast(text: string, level: "info" | "error" = "info") {
    const id = this.toastId++;
    this.set({ toasts: [...this.s.toasts, { id, text, level }].slice(-4) });
    setTimeout(() => this.set({ toasts: this.s.toasts.filter((t) => t.id !== id) }), 4000);
  }

  select(sel: Selection) {
    this.set({ selection: sel, detail: null });
    this.send({ type: "select", kind: sel?.kind ?? null, id: sel?.id ?? null });
  }

  setPanel(panel: ClientState["panel"]) {
    const next = this.s.panel === panel ? "none" : panel;
    this.set({ panel: next });
    this.send({ type: "dashboard", open: next === "dashboard" || next === "ai" });
  }

  setFollow(follow: boolean) {
    this.set({ followSelected: follow });
  }
}

export const store = new Store();

export function useStore<T>(selector: (s: ClientState) => T): T {
  return selector(useSyncExternalStore(store.subscribe, store.getSnapshot));
}
