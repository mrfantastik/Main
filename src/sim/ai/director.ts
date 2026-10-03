import { logEvent } from "../events";
import { setReflectionHook } from "../mind/reflection";
import { resolveConversationAI, setConversationAIHook } from "../social/conversation";
import { dayOf } from "../time";
import type { AILogEntry, Citizen, Conversation, ConvValue, Reflection, WorldState } from "../types";
import { newId, pushRing, round2 } from "../util";
import { scoreOf } from "./decision";
import { CONVERSATION_SYSTEM, conversationPrompt, costUsd, REFLECTION_SYSTEM, reflectionPrompt, STRATEGY_SYSTEM, strategyPrompt, type LLMClient } from "./llm";
import { applyStrategy, setStrategyHook, strategyOptions, type StrategyOption } from "./strategy";
import { applyInvented, applyUnscripted, INVENT_SCHEMA, INVENT_SYSTEM, inventableKinds, inventPrompt, UNSCRIPTED_SCHEMA, UNSCRIPTED_SYSTEM, unscriptedPrompt } from "./unscripted";

// The AI Director decides WHEN it's worth asking Claude, and keeps costs
// under control. Routine life never touches the LLM. Only:
//   - genuine strategic dilemmas with real stakes (career, business, money),
//   - conversations about money, jobs, debts and deals,
//   - at most one night a day: rewording the lessons of the citizen with
//     the most emotional day in their own voice.
// Requests are async; the simulation never waits. Replies are validated
// against the engine's rules and fall back to the utility AI if invalid,
// late, or failed. Spend is tracked per call against a hard budget.

export interface SpendLedger {
  total(): number;
  add(usd: number): void;
}

export interface DirectorOptions {
  maxConcurrent: number;
  minIntervalMs: number;
  timeoutMs: number;
}

interface Pending {
  id: number;
  kind: "strategy" | "conversation" | "reflection" | "unscripted" | "invent";
  world: WorldState;
  citizenId: string;
  convId?: number;
  fallbackId?: string;
  startedAt: number;
  prompt: string;
}

interface Done {
  pending: Pending;
  json: unknown | null;
  costUsd: number;
  ms: number;
  error?: string;
}

const CONVERSATION_TOPICS = new Set(["ask_loan", "pitch_investment", "ask_job", "offer_job", "demand_repayment", "ask_help", "share_tip", "argue", "sell_stock"]);

export class AIDirector {
  private inFlight = new Map<number, Pending>();
  private done: Done[] = [];
  private lastCallAt = 0;
  private disabledReason: string | null = null;
  private seq = 1;

  /** Game day of the last reflection sent (one a night is plenty). */
  private reflectedDay = -1;
  /** News chats sent to Claude today (they get at most a third of the daily calls). */
  private chatDay = -1;
  private chatCalls = 0;
  /** Messages for the player (the server shows them as toasts). */
  readonly notices: { text: string; level: "info" | "error" }[] = [];

  constructor(
    private client: LLMClient | null,
    private ledger: SpendLedger,
    private opts: DirectorOptions = { maxConcurrent: 2, minIntervalMs: 2500, timeoutMs: 25_000 },
  ) {}

  get available(): boolean {
    return !!this.client && !this.disabledReason;
  }

  get model(): string {
    return this.client?.model ?? "none";
  }

  get pending(): number {
    return this.inFlight.size;
  }

  get unavailableReason(): string | null {
    return this.client ? this.disabledReason : "No ANTHROPIC_API_KEY set";
  }

  /** Install the hooks into the simulation. */
  attach(): void {
    setStrategyHook((world, c, options, fallback) => this.strategyHook(world, c, options, fallback));
    setConversationAIHook((world, conv, brief, schema, stakes) => this.conversationHook(world, conv, brief, schema, stakes));
    setReflectionHook((world, c, learned) => this.reflectionHook(world, c, learned));
  }

  private canCall(world: WorldState): boolean {
    const ai = world.ai;
    if (!this.available || ai.mode !== "llm") return false;
    if (this.ledger.total() >= ai.budgetUsd) {
      if (!ai.log.some((l) => l.note === "budget")) {
        pushRing(ai.log, { id: newId(world), t: world.time, citizenId: null, kind: "strategy", prompt: "", response: "", costUsd: 0, ms: 0, status: "fallback", note: "budget" }, 60);
        logEvent(world, "ai", `🧠 Claude budget of $${ai.budgetUsd.toFixed(2)} reached — citizens carry on with the built-in utility AI.`, 3);
      }
      return false;
    }
    if (ai.callsToday >= ai.maxCallsPerDay) return false;
    if (this.inFlight.size >= this.opts.maxConcurrent) return false;
    if (Date.now() - this.lastCallAt < this.opts.minIntervalMs) return false;
    return true;
  }

  // ------------------------------------------------------- strategy

  private strategyHook(world: WorldState, c: Citizen, options: StrategyOption[], fallback: StrategyOption): boolean {
    // Only genuine dilemmas with real stakes are worth a call.
    const ranked = [...options].sort((a, b) => scoreOf(b) - scoreOf(a));
    if (ranked.length < 2) return false;
    const close = scoreOf(ranked[0]) - scoreOf(ranked[1]) < 0.3;
    const stakes = Math.max(ranked[0].payload.stakes, ranked[1].payload.stakes);
    const recently = world.time - (c.cooldowns.llmStrategy ?? -1e9) < 2 * 1440;
    if (!close || stakes < 80 || recently || !this.canCall(world)) return false;
    const top = ranked.slice(0, 5);
    if (!top.includes(fallback)) top.push(fallback);
    const { user, schema } = strategyPrompt(world, c, top.map((o) => ({ id: o.id, label: o.label })));
    c.cooldowns.llmStrategy = world.time;
    c.awaitingAI = true;
    this.send(world, { kind: "strategy", citizenId: c.id, fallbackId: fallback.id }, STRATEGY_SYSTEM, user, schema);
    return true;
  }

  // --------------------------------------------------- conversations

  private conversationHook(world: WorldState, conv: Conversation, brief: string, outcomeSchema: Record<string, unknown>, stakes: number): boolean {
    if (conv.topic === "chat") {
      // Chats where someone has news to share are worth Claude's words, a few a day.
      if (conv.terms.news !== true || !this.canCall(world)) return false;
      const day = dayOf(world.time);
      if (this.chatDay !== day) {
        this.chatDay = day;
        this.chatCalls = 0;
      }
      if (this.chatCalls >= Math.max(1, Math.floor(world.ai.maxCallsPerDay / 3))) return false;
      this.chatCalls++;
      const { user, schema } = conversationPrompt(world, conv, brief, outcomeSchema);
      this.send(world, { kind: "conversation", citizenId: conv.a, convId: conv.id }, CONVERSATION_SYSTEM, user, schema);
      return true;
    }
    if (!CONVERSATION_TOPICS.has(conv.topic)) return false;
    if (stakes < 20 && conv.topic !== "argue" && conv.topic !== "ask_help") return false;
    if (!this.canCall(world)) return false;
    const { user, schema } = conversationPrompt(world, conv, brief, outcomeSchema);
    this.send(world, { kind: "conversation", citizenId: conv.a, convId: conv.id }, CONVERSATION_SYSTEM, user, schema);
    return true;
  }

  // ------------------------------------------------------ reflections

  /** Reword one strongly felt night's lessons per game day (the effects already happened). */
  private reflectionHook(world: WorldState, c: Citizen, learned: Reflection[]): void {
    const day = dayOf(world.time);
    if (this.reflectedDay === day) return;
    const intensity = Math.max(...Object.values(c.emotions));
    if (intensity < 55 || !learned.some((r) => r.kind === "person" || r.kind === "work") || !this.canCall(world)) return;
    this.reflectedDay = day;
    const { user, schema } = reflectionPrompt(world, c, learned);
    this.send(world, { kind: "reflection", citizenId: c.id }, REFLECTION_SYSTEM, user, schema);
  }

  private applyReflectionResult(world: WorldState, d: Done): void {
    const c = world.citizens[d.pending.citizenId];
    if (!c) return;
    const reply = d.json as { lessons?: unknown } | null;
    let changed = 0;
    if (reply && Array.isArray(reply.lessons)) {
      for (const item of reply.lessons as { key?: unknown; text?: unknown }[]) {
        const r = c.reflections.find((x) => x.key === item.key);
        const text = typeof item.text === "string" ? item.text.trim() : "";
        if (!r || !text || text.length > 160) continue;
        r.text = text;
        r.source = "llm";
        changed++;
      }
    }
    this.log(world, d, changed ? "ok" : d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), changed ? `${c.name} put ${changed} lesson${changed > 1 ? "s" : ""} in their own words` : d.error ? `error: ${d.error}` : "invalid reply — template wording kept");
  }

  // ------------------------------------------- on request: unscripted

  /** The player asked Claude to write a conversation from scratch. Returns a reason it can't, or null. */
  unscripted(world: WorldState, convId: number): string | null {
    if (!this.available) return `Claude isn't available: ${this.unavailableReason ?? "no API key"}`;
    if (!this.canCall(world)) return "Claude is busy or out of budget right now. Try again in a moment.";
    const p = unscriptedPrompt(world, convId);
    if (typeof p === "string") return p;
    this.send(world, { kind: "unscripted", citizenId: p.conv.a, convId }, UNSCRIPTED_SYSTEM, p.prompt, UNSCRIPTED_SCHEMA);
    return null;
  }

  /** The player asked Claude to invent something that happens in town. */
  invent(world: WorldState, idea = ""): string | null {
    if (!this.available) return `Claude isn't available: ${this.unavailableReason ?? "no API key"}`;
    if (!this.canCall(world)) return "Claude is busy or out of budget right now. Try again in a moment.";
    if (inventableKinds(world).length === 0) return "Nothing can happen right now. Try at another time of day.";
    this.send(world, { kind: "invent", citizenId: world.citizenOrder[0] }, INVENT_SYSTEM, inventPrompt(world, idea), INVENT_SCHEMA);
    return null;
  }

  private applyUnscriptedResult(world: WorldState, d: Done): void {
    try {
      if (d.error || !d.json) throw new Error(d.error ?? "no reply");
      const msg = applyUnscripted(world, d.pending.convId ?? -1, d.json);
      this.log(world, d, "ok", JSON.stringify(d.json), "wrote a conversation from scratch");
      this.notices.push({ text: msg, level: "info" });
    } catch (err) {
      this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), (err as Error).message);
      this.notices.push({ text: `Claude couldn't write it: ${(err as Error).message}`, level: "error" });
    }
  }

  private applyInventResult(world: WorldState, d: Done): void {
    const h = d.json ? applyInvented(world, d.json) : (d.error ?? "no reply");
    if (typeof h === "string") {
      this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), h);
      this.notices.push({ text: `Claude's idea didn't work out: ${h}`, level: "error" });
      return;
    }
    this.log(world, d, "ok", JSON.stringify(d.json), `invented: ${h.title}`);
    this.notices.push({ text: `✨ ${h.title}.`, level: "info" });
  }

  // ---------------------------------------------------------- calls

  private send(world: WorldState, p: Omit<Pending, "id" | "world" | "startedAt" | "prompt">, system: string, user: string, schema: Record<string, unknown>): void {
    const pending: Pending = { ...p, id: this.seq++, world, startedAt: Date.now(), prompt: user };
    this.inFlight.set(pending.id, pending);
    this.lastCallAt = Date.now();
    world.ai.calls++;
    world.ai.callsToday++;
    const client = this.client!;
    client
      .complete({ system, user, schema, maxTokens: 3000 })
      .then((res) => {
        const cost = costUsd(res.model, res.inputTokens, res.outputTokens);
        this.ledger.add(cost);
        this.finish({ pending, json: res.json, costUsd: cost, ms: Date.now() - pending.startedAt });
      })
      .catch((err: Error & { status?: number }) => {
        if (err.status === 401 || err.status === 403) this.disabledReason = `Claude API rejected the key (${err.status})`;
        this.finish({ pending, json: null, costUsd: 0, ms: Date.now() - pending.startedAt, error: err.message?.slice(0, 200) ?? "error" });
      });
  }

  private finish(d: Done): void {
    if (!this.inFlight.has(d.pending.id)) return; // already timed out
    this.inFlight.delete(d.pending.id);
    this.done.push(d);
  }

  /** Apply finished AI replies to the world. Called by the runner between steps. */
  pump(world: WorldState): void {
    const now = Date.now();
    for (const p of [...this.inFlight.values()]) {
      if (now - p.startedAt > this.opts.timeoutMs) {
        this.inFlight.delete(p.id);
        this.done.push({ pending: p, json: null, costUsd: 0, ms: now - p.startedAt, error: "timed out" });
      }
    }
    const batch = this.done.splice(0);
    for (const d of batch) {
      if (d.pending.world !== world) continue; // world was reset meanwhile
      world.ai.spentUsd = round2((world.ai.spentUsd + d.costUsd) * 10000) / 10000;
      if (d.pending.kind === "strategy") this.applyStrategyResult(world, d);
      else if (d.pending.kind === "reflection") this.applyReflectionResult(world, d);
      else if (d.pending.kind === "unscripted") this.applyUnscriptedResult(world, d);
      else if (d.pending.kind === "invent") this.applyInventResult(world, d);
      else this.applyConversationResult(world, d);
    }
  }

  private log(world: WorldState, d: Done, status: AILogEntry["status"], response: string, note: string): void {
    pushRing(
      world.ai.log,
      { id: newId(world), t: world.time, citizenId: d.pending.citizenId, kind: d.pending.kind, prompt: d.pending.prompt, response, costUsd: Math.round(d.costUsd * 1e5) / 1e5, ms: d.ms, status, note },
      60,
    );
  }

  private applyStrategyResult(world: WorldState, d: Done): void {
    const c = world.citizens[d.pending.citizenId];
    if (!c) return;
    c.awaitingAI = false;
    const options = strategyOptions(world, c);
    const fallback = options.find((o) => o.id === d.pending.fallbackId) ?? options[0];
    const reply = d.json as { choice?: unknown; thought?: unknown } | null;
    const chosen = reply && typeof reply.choice === "string" ? options.find((o) => o.id === reply.choice) : undefined;
    const thought = reply && typeof reply.thought === "string" ? reply.thought.slice(0, 240) : "";
    if (!chosen || !thought) {
      this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), d.error ? `error: ${d.error}` : "invalid or stale choice — used utility AI");
      applyStrategy(world, c, options, fallback, d.error ? "utility" : "llm-rejected", fallback.thought);
      return;
    }
    this.log(world, d, "ok", JSON.stringify(reply), `${c.name} chose "${chosen.label}"${chosen.id !== fallback.id ? ` (utility AI would have picked "${fallback.label}")` : ""}`);
    applyStrategy(world, c, options, chosen, "llm", thought);
    if (chosen.id !== fallback.id) logEvent(world, "ai", `🧠 ${c.name} thought it over: "${thought}"`, 2, [c.id]);
  }

  private applyConversationResult(world: WorldState, d: Done): void {
    const convId = d.pending.convId!;
    const conv = world.conversations.find((x) => x.id === convId);
    if (!conv) return;
    const reply = d.json as { lines?: unknown; outcome?: unknown } | null;
    let parsed: { lines: Conversation["lines"]; outcome: Record<string, ConvValue> } | null = null;
    if (reply && Array.isArray(reply.lines) && reply.outcome && typeof reply.outcome === "object") {
      const lines = (reply.lines as { speaker?: unknown; text?: unknown }[])
        .filter((l) => (l.speaker === "A" || l.speaker === "B") && typeof l.text === "string" && l.text.trim())
        .map((l) => ({ speaker: l.speaker === "A" ? conv.a : conv.b, text: String(l.text).trim().slice(0, 160) }));
      parsed = { lines, outcome: reply.outcome as Record<string, ConvValue> };
    }
    const res = resolveConversationAI(world, convId, parsed);
    this.log(world, d, res === "ok" ? "ok" : d.error ? "error" : "fallback", JSON.stringify(d.json ?? d.error), res === "ok" ? `outcome ${JSON.stringify(conv.outcome)}` : d.error ? `error: ${d.error}` : "invalid reply — template used");
  }
}

/** A director that never calls an LLM (tests / headless / no API key). */
export function offlineDirector(): AIDirector {
  return new AIDirector(null, { total: () => 0, add: () => undefined });
}
