import { MEAL_FILLS } from "../economy/living";
import { logEvent } from "../events";
import { updateNeeds } from "../systems/needs";
import { setReflectionHook } from "../mind/reflection";
import { resolveConversationAI, setConversationAIHook } from "../social/conversation";
import { dayOf } from "../time";
import type { AILogEntry, Citizen, Conversation, ConvValue, Reflection, WorldState } from "../types";
import { newId, pushRing, round2 } from "../util";
import { activityOptions, type ActivityOption } from "./activity";
import { setActivityHook } from "./brain";
import { scoreOf, setThought } from "./decision";
import { smallChoicePrompt, smallConversationPrompt, smallPlanPrompt, smallThoughtPrompt, type SmallPrompt } from "./small";
import type { FreeAIClient, FreeAIStatus } from "./freeai";
import { CONVERSATION_SYSTEM, conversationPrompt, costUsd, FREE_CONVERSATION_SYSTEM, freeConversationPrompt, REFLECTION_SYSTEM, reflectionPrompt, STRATEGY_SYSTEM, strategyPrompt, THOUGHT_SYSTEM, thoughtPrompt, type LLMClient } from "./llm";
import { applyStrategy, setStrategyHook, strategyOptions, type StrategyOption } from "./strategy";
import { cleanLines } from "./lines";
import { applyInvented, INVENT_SCHEMA, INVENT_SYSTEM, inventableKinds, inventPrompt } from "./unscripted";

// The AI Director decides WHEN it's worth asking a language model.
// With a free AI (the town's brain running in the page, or a free service)
// there's no bill, only time, so the model is kept busy all the time:
//   - it picks what people do next: while someone is busy, it's asked what
//     they'll do after, from the things the utility AI thinks make sense for
//     them right now, and their reason becomes what they're thinking,
//   - it writes the words of every conversation it can get to: chats, deals,
//     arguments (the town has already decided what happens; the model says
//     it, so every conversation is its own but nothing breaks),
//   - in between, it says what's on someone's mind.
// The person the player is looking at comes first. Whatever it can't get to
// in time is done by the built-in AI.
// With Claude (a paid API key), calls are kept for big moments:
//   - genuine strategic dilemmas with real stakes (career, business, money),
//   - conversations about money, jobs, debts and deals, and some news chats,
//   - at most one night a day: rewording the lessons of the citizen with
//     the most emotional day in their own voice,
// and spend is tracked per call against a hard budget.
// Requests are async; the simulation never waits. Replies are validated
// against the engine's rules and fall back to the utility AI if invalid,
// late, or failed.

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
  kind: "strategy" | "conversation" | "reflection" | "invent" | "thought" | "plan";
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

/** A citizen's next move, asked for while they're still busy. */
interface Plan {
  /** The request it came from. */
  reqId: number;
  /** Too late after this (game time): they've moved on. */
  until: number;
  /** The pick (an activity option id) and why, once the reply is in. */
  choice: string | null;
  thought: string | null;
}

/** A conversation waiting for the brain to be free (it does one thing at a time). */
interface Queued {
  world: WorldState;
  convId: number;
  citizenId: string;
  /** The player is watching one of them. */
  watched: boolean;
  small: SmallPrompt;
  user: string;
  schema: Record<string, unknown>;
  at: number;
}

/** Activities the next move can be planned during (not walking, talking or between things). */
const PLANNABLE = new Set(["sleep", "work", "eat", "shop", "socialize", "rest", "bank", "browse", "trade", "research", "restock", "job_hunt", "manage"]);
/** Options within this much of the best are the sensible ones to choose between. */
const PLAN_MARGIN = 1.0;
/** A queued conversation gives up after this long (ms) and the built-in AI speaks it. */
const QUEUE_WAIT_MS = 15_000;

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
  /** The free AI asked us to slow down, or couldn't be reached: no calls until then. */
  private backoffUntil = 0;
  private failures = 0;
  private toldBlocked = false;
  /** The citizen the player is looking at: their thoughts come first. */
  focus: string | null = null;
  /** Free AI: when the next inner thought may be asked for (real time), for anyone and for the person in focus. */
  private nextThoughtAt = 0;
  private nextFocusThoughtAt = 0;
  /** Next moves asked for (by citizen). */
  private plans = new Map<string, Plan>();
  /** Conversations waiting for the town's brain. */
  private queue: Queued[] = [];
  /** What was asked for last (conversations and choices take turns). */
  private lastKind: Pending["kind"] | null = null;
  /** Messages for the player (the server shows them as toasts). */
  readonly notices: { text: string; level: "info" | "error" }[] = [];
  /** What the AI has done so far: choices people acted on, conversations it wrote, thoughts. */
  readonly tally = { plan: 0, conversation: 0, thought: 0 };

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

  /** A free AI: no budget, just a rate limit. */
  get free(): boolean {
    return !!this.client?.free;
  }

  /** A small model running in the page: short prompts, nothing too ambitious. */
  get small(): boolean {
    return !!this.client?.small;
  }

  /** Who writes the words, as the player sees it (null: nobody). */
  get writer(): string | null {
    return this.available ? (this.client!.label ?? `Claude (${this.model})`) : null;
  }

  /** The free AI's connection report (null for Claude or no AI). */
  freeStatus(): FreeAIStatus | null {
    return this.free && !this.small ? (this.client as FreeAIClient).status() : null;
  }

  /** Free AI: try every service now (the "Test connection" button). */
  async probe(): Promise<FreeAIStatus | null> {
    if (!this.free || this.small) return null;
    this.backoffUntil = 0;
    this.failures = 0;
    const st = await (this.client as FreeAIClient).probe();
    if (st.connected) this.toldBlocked = false;
    return st;
  }

  /** Free AI: the player's own endpoint (any OpenAI-style URL), tried first. */
  setCustomEndpoint(custom: { url: string; model?: string; key?: string } | null): void {
    if (this.free && !this.small) (this.client as FreeAIClient).setCustom(custom);
    this.backoffUntil = 0;
    this.failures = 0;
  }

  /** Short name for messages ("The town's brain", "The free AI", "Claude"). */
  private get who(): string {
    return this.small ? "The town's brain" : this.free ? "The free AI" : "Claude";
  }

  get pending(): number {
    return this.inFlight.size;
  }

  /** What it's working on right now, in words (for the AI panel). */
  doing(world: WorldState): string | null {
    const p = [...this.inFlight.values()].find((x) => x.world === world);
    if (!p) return null;
    const name = world.citizens[p.citizenId]?.name ?? "someone";
    const conv = p.convId !== undefined ? world.conversations.find((x) => x.id === p.convId) : undefined;
    const other = conv ? world.citizens[conv.b]?.name : undefined;
    const waiting = this.queue.length ? ` (${this.queue.length} conversation${this.queue.length > 1 ? "s" : ""} waiting)` : "";
    const what: Record<Pending["kind"], string> = {
      plan: `Deciding what ${name} does next`,
      conversation: `Writing what ${name}${other ? ` and ${other}` : ""} say`,
      thought: `Thinking as ${name}`,
      strategy: `Weighing up a big decision for ${name}`,
      reflection: `Putting ${name}'s lessons into words`,
      invent: "Making up something that happens",
    };
    return what[p.kind] + waiting;
  }

  get unavailableReason(): string | null {
    return this.client ? this.disabledReason : "No ANTHROPIC_API_KEY set";
  }

  /** Install the hooks into the simulation. */
  attach(): void {
    setStrategyHook((world, c, options, fallback) => this.strategyHook(world, c, options, fallback));
    setConversationAIHook((world, conv, brief, schema, stakes) => this.conversationHook(world, conv, brief, schema, stakes));
    setReflectionHook((world, c, learned) => this.reflectionHook(world, c, learned));
    setActivityHook((world, c, options, utility) => this.activityHook(world, c, options, utility));
  }

  /** Whether a call can go now (`later`: whether one could once the calls in flight are done). */
  private canCall(world: WorldState, later = false): boolean {
    const ai = world.ai;
    if (!this.available || ai.mode !== "llm") return false;
    if (this.client?.ready && !this.client.ready()) return false;
    if (Date.now() < this.backoffUntil) return false;
    if (later) return ai.callsToday < ai.maxCallsPerDay;
    if (!this.free && this.ledger.total() >= ai.budgetUsd) {
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
    // Free AI: no bill, so more of the close calls are thought through by it.
    const recently = world.time - (c.cooldowns.llmStrategy ?? -1e9) < (this.free ? 1440 : 2 * 1440);
    if (!close || stakes < (this.free ? 40 : 80) || recently || !this.canCall(world)) return false;
    const top = ranked.slice(0, 5);
    if (!top.includes(fallback)) top.push(fallback);
    const { user, schema } = strategyPrompt(world, c, top.map((o) => ({ id: o.id, label: o.label })));
    c.cooldowns.llmStrategy = world.time;
    c.awaitingAI = true;
    const small = this.small ? smallChoicePrompt(world, c, top.map((o) => ({ id: o.id, label: o.label }))) : undefined;
    this.send(world, { kind: "strategy", citizenId: c.id, fallbackId: fallback.id }, STRATEGY_SYSTEM, user, schema, small);
    return true;
  }

  // --------------------------------------------------- conversations

  private conversationHook(world: WorldState, conv: Conversation, brief: string, outcomeSchema: Record<string, unknown>, stakes: number): boolean {
    if (this.free) {
      // Free: voice every conversation there's room for.
      if (conv.topic !== "chat" && !CONVERSATION_TOPICS.has(conv.topic)) return false;
      const watched = conv.a === this.focus || conv.b === this.focus;
      // A slow in-page model only voices the conversations the player is watching (nobody waits long).
      if (this.client?.slow?.() && !watched) return false;
      const { user, schema } = freeConversationPrompt(world, conv, brief);
      if (!this.small) {
        if (!this.canCall(world)) return false;
        this.send(world, { kind: "conversation", citizenId: conv.a, convId: conv.id }, FREE_CONVERSATION_SYSTEM, user, schema);
        return true;
      }
      // The town's brain does one thing at a time: the conversation waits its turn (briefly; see schedule).
      if (!this.canCall(world, true) || (this.queue.length >= 2 && !watched)) return false;
      const q: Queued = { world, convId: conv.id, citizenId: conv.a, watched, small: smallConversationPrompt(world, conv, brief), user, schema, at: Date.now() };
      if (watched) this.queue.unshift(q);
      else this.queue.push(q);
      if (this.queue.length > 2) this.dropQueued(world, this.queue.pop()!);
      return true;
    }
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

  // ------------------------------------------------ what's next (free AI)

  /**
   * Keep the free AI busy. First the person the player is looking at: a
   * conversation they're in, their next move, what they're thinking. Then
   * everyone else, conversations and next moves taking turns (whoever is
   * about to decide goes first), and now and then what someone's thinking.
   */
  private schedule(world: WorldState): void {
    for (const q of [...this.queue]) {
      const waiting = world.conversations.some((x) => x.id === q.convId && x.status === "awaiting_ai");
      if (q.world !== world || !waiting) this.queue.splice(this.queue.indexOf(q), 1);
      else if (Date.now() - q.at > QUEUE_WAIT_MS) {
        this.queue.splice(this.queue.indexOf(q), 1);
        if (q.world === world) this.dropQueued(world, q);
      }
    }
    if (!this.free || !this.canCall(world)) return;
    const talk = (): boolean => {
      const q = this.queue.shift();
      if (q) this.send(world, { kind: "conversation", citizenId: q.citizenId, convId: q.convId }, FREE_CONVERSATION_SYSTEM, q.user, q.schema, q.small);
      return !!q;
    };
    if ((this.queue[0]?.watched && talk()) || this.maybePlan(world, true) || this.maybeThink(world, true)) return;
    const turns = this.lastKind === "conversation" ? [() => this.maybePlan(world, false), talk] : [talk, () => this.maybePlan(world, false)];
    if (turns.some((f) => f())) return;
    this.maybeThink(world, false);
  }

  /** A queued conversation that waited too long: the built-in AI speaks it. */
  private dropQueued(world: WorldState, q: Queued): void {
    const res = resolveConversationAI(world, q.convId, null);
    if (res !== "gone") pushRing(world.ai.log, { id: newId(world), t: world.time, citizenId: q.citizenId, kind: "conversation", prompt: "", response: "", costUsd: 0, ms: Date.now() - q.at, status: "fallback", note: `${this.who.toLowerCase()} was busy: the built-in AI spoke this one` }, 60);
  }

  /**
   * What someone could do once they've finished what they're doing: as
   * they'll be by then (fed, rested, tired from work) and at that time of
   * day, not as they are now (halfway through a meal they're still hungry).
   */
  private optionsAfter(world: WorldState, c: Citizen): ActivityOption[] {
    const needs = { ...c.needs };
    const now = world.time;
    const left = Math.max(0, Math.min(12 * 60, c.activity.endsAt - now));
    try {
      for (let i = 0; i < left; i++) updateNeeds(c);
      if (c.activity.action?.type === "EAT") c.needs.hunger = Math.min(100, c.needs.hunger + MEAL_FILLS);
      world.time = now + left;
      return activityOptions(world, c);
    } finally {
      Object.assign(c.needs, needs);
      world.time = now;
    }
  }

  /** The sensible things for someone to do next, best first (what the model chooses between). */
  private sensible(world: WorldState, c: Citizen): ActivityOption[] {
    const options = this.optionsAfter(world, c).sort((a, b) => scoreOf(b) - scoreOf(a));
    if (!options.length) return [];
    const best = scoreOf(options[0]);
    return options.filter((o) => scoreOf(o) >= best - PLAN_MARGIN).slice(0, 4);
  }

  /** Ask what someone (the person in focus, or anyone else) will do once they've finished what they're doing. */
  private maybePlan(world: WorldState, focusOnly: boolean): boolean {
    for (const [id, p] of this.plans) if (world.time > p.until) this.plans.delete(id);
    const left = (c: Citizen) => c.activity.endsAt - world.time;
    const ready = (c: Citizen) => PLANNABLE.has(c.activity.kind) && c.path.length === 0 && !c.awaitingAI && !this.plans.has(c.id);
    const focus = this.focus ? world.citizens[this.focus] : undefined;
    let c: Citizen | undefined = focusOnly && focus && ready(focus) && left(focus) > 2 && left(focus) < 12 * 60 ? focus : undefined;
    // A free service has a rate limit to share with the conversations: only the person being watched.
    if (!focusOnly && this.small) {
      c = world.citizenOrder
        .map((cid) => world.citizens[cid])
        .filter((x) => ready(x) && left(x) > 8 && left(x) < 180)
        .sort((x, y) => left(x) - left(y))[0];
    }
    if (!c) return false;
    const options = this.sensible(world, c);
    // A chat on the way out can hold them up; the pick is still checked against how things are by then.
    const until = c.activity.endsAt + 120;
    if (options.length < 2) {
      // Nothing to choose between (e.g. bedtime): don't ask again during this activity.
      this.plans.set(c.id, { reqId: -1, until, choice: null, thought: null });
      return false;
    }
    const list = options.map((o) => ({ id: o.id, label: o.label }));
    const { user, schema } = strategyPrompt(world, c, list);
    const reqId = this.send(world, { kind: "plan", citizenId: c.id }, STRATEGY_SYSTEM, user, schema, this.small ? smallPlanPrompt(world, c, list) : undefined);
    this.plans.set(c.id, { reqId, until, choice: null, thought: null });
    return true;
  }

  private applyPlanResult(world: WorldState, d: Done): void {
    const c = world.citizens[d.pending.citizenId];
    const plan = this.plans.get(d.pending.citizenId);
    if (!c) return;
    if (!plan || plan.reqId !== d.pending.id) {
      this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), d.error ? `error: ${d.error}` : `too late: ${c.name} had already moved on`);
      return;
    }
    const reply = d.json as { choice?: unknown; thought?: unknown } | null;
    const choice = reply && typeof reply.choice === "string" ? reply.choice : null;
    const option = choice ? this.optionsAfter(world, c).find((o) => o.id === choice) : undefined;
    if (!option) {
      // Left unanswered (not asked again during this activity): the utility AI decides.
      this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), d.error ? `error: ${d.error}` : "no usable choice: the utility AI decides");
      return;
    }
    const raw = typeof reply!.thought === "string" ? reply!.thought.replace(/\s+/g, " ").trim() : "";
    plan.choice = option.id;
    plan.thought = raw.length >= 4 && raw.length <= 240 ? raw : null;
    this.log(world, d, "ok", JSON.stringify(reply), `${c.name} will ${option.label.charAt(0).toLowerCase()}${option.label.slice(1)} next${plan.thought ? `: "${plan.thought}"` : ""}`);
  }

  /** The model's pick, when it's in and still makes sense; otherwise the utility AI decides. */
  private activityHook(world: WorldState, c: Citizen, options: ActivityOption[], utility: ActivityOption): { option: ActivityOption; thought: string | null } | null {
    const plan = this.plans.get(c.id);
    if (!plan || plan.reqId < 0 || world.time > plan.until) return null;
    this.plans.delete(c.id);
    if (!plan.choice) return null; // not answered in time
    const option = options.find((o) => o.id === plan.choice);
    // Things change (they got hungrier, the shop shut): a pick that no longer makes sense is dropped.
    if (!option || scoreOf(option) < scoreOf(utility) - PLAN_MARGIN * 1.3) return null;
    this.tally.plan++;
    return { option, thought: plan.thought };
  }

  // --------------------------------------------------------- thoughts

  /**
   * Free AI: now and then, ask for what someone is thinking right now. The
   * person the player is looking at comes first; otherwise whoever's been
   * longest without one. It's only words: nothing in the world changes.
   */
  private maybeThink(world: WorldState, focusOnly: boolean): boolean {
    const awake = (c: Citizen) => c.activity.kind !== "sleep" && !c.awaitingAI;
    const since = (c: Citizen) => world.time - (c.cooldowns.llmThought ?? -1e9);
    const focus = this.focus ? world.citizens[this.focus] : undefined;
    let c: Citizen | undefined;
    if (focusOnly) c = focus && awake(focus) && since(focus) >= 30 && Date.now() >= this.nextFocusThoughtAt ? focus : undefined;
    else if (Date.now() >= this.nextThoughtAt)
      c = world.citizenOrder
        .map((id) => world.citizens[id])
        .filter((x) => awake(x) && since(x) >= 240)
        .sort((x, y) => since(y) - since(x))[0];
    if (!c) return false;
    c.cooldowns.llmThought = world.time;
    // Fast-forwarding mustn't turn into nothing but thoughts.
    if (focusOnly) this.nextFocusThoughtAt = Date.now() + (this.small ? 8_000 : 10_000);
    else this.nextThoughtAt = Date.now() + (this.small ? 6_000 : 10_000);
    const { user, schema } = thoughtPrompt(world, c);
    this.send(world, { kind: "thought", citizenId: c.id }, THOUGHT_SYSTEM, user, schema, this.small ? smallThoughtPrompt(world, c) : undefined);
    return true;
  }

  private applyThoughtResult(world: WorldState, d: Done): void {
    const c = world.citizens[d.pending.citizenId];
    if (!c) return;
    const raw = (d.json as { thought?: unknown } | null)?.thought;
    const text = typeof raw === "string" ? raw.replace(/^["“'\s]+|["”'\s]+$/g, "").replace(/\s+/g, " ").trim() : "";
    if (!text || text.length < 4 || text.length > 240) {
      this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), d.error ? `error: ${d.error}` : "no usable thought — kept the built-in one");
      return;
    }
    setThought(world, c, text, Math.max(3, c.thoughtPriority), "llm");
    this.tally.thought++;
    this.log(world, d, "ok", JSON.stringify(d.json), `${c.name}: "${text}"`);
  }

  // ------------------------------------------------------ reflections

  /** Reword one strongly felt night's lessons per game day (the effects already happened). */
  private reflectionHook(world: WorldState, c: Citizen, learned: Reflection[]): void {
    if (this.small) return; // rewording lessons as JSON is too much for a small model
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

  // ------------------------------------------------ on request: invent

  /** The player asked Claude to invent something that happens in town. */
  invent(world: WorldState, idea = ""): string | null {
    if (!this.available) return `The AI isn't available: ${this.unavailableReason ?? "no AI configured"}`;
    if (world.ai.mode !== "llm") return "The AI is switched off. Turn it on in the 🧠 AI panel.";
    if (!this.canCall(world)) return `${this.who} is busy${this.free ? "" : " or out of budget"} right now. Try again in a moment.`;
    if (this.small) return "Making up events needs a bigger AI than the town's brain. Pick one from the list instead.";
    if (inventableKinds(world).length === 0) return "Nothing can happen right now. Try at another time of day.";
    this.send(world, { kind: "invent", citizenId: world.citizenOrder[0] }, INVENT_SYSTEM, inventPrompt(world, idea), INVENT_SCHEMA);
    return null;
  }

  private applyInventResult(world: WorldState, d: Done): void {
    const h = d.json ? applyInvented(world, d.json) : (d.error ?? "no reply");
    if (typeof h === "string") {
      this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), h);
      this.notices.push({ text: `${this.who}'s idea didn't work out: ${h}`, level: "error" });
      return;
    }
    this.log(world, d, "ok", JSON.stringify(d.json), `invented: ${h.title}`);
    this.notices.push({ text: `✨ ${h.title}.`, level: "info" });
  }

  // ---------------------------------------------------------- calls

  /** Send a request (the reply is applied in pump); returns its id. */
  private send(world: WorldState, p: Omit<Pending, "id" | "world" | "startedAt" | "prompt">, system: string, user: string, schema: Record<string, unknown>, small?: SmallPrompt): number {
    const pending: Pending = { ...p, id: this.seq++, world, startedAt: Date.now(), prompt: small ? `${small.system}\n\n${small.user}\n\n${small.prefill}` : user };
    this.lastKind = p.kind;
    this.inFlight.set(pending.id, pending);
    this.lastCallAt = Date.now();
    world.ai.calls++;
    world.ai.callsToday++;
    const client = this.client!;
    client
      .complete({ system, user, schema, maxTokens: 3000, small })
      .then((res) => {
        const cost = client.free ? 0 : costUsd(res.model, res.inputTokens, res.outputTokens);
        if (cost) this.ledger.add(cost);
        this.failures = 0;
        this.finish({ pending, json: res.json, costUsd: cost, ms: Date.now() - pending.startedAt });
      })
      .catch((err: Error & { status?: number }) => {
        if (client.free) this.slowDown(err.status ?? 0);
        else if (err.status === 401 || err.status === 403) this.disabledReason = `Claude API rejected the key (${err.status})`;
        this.finish({ pending, json: null, costUsd: 0, ms: Date.now() - pending.startedAt, error: err.message?.slice(0, 200) ?? "error" });
      });
    return pending.id;
  }

  /** The free AI is rate limited or unreachable: wait longer each time it happens, then try again. */
  private slowDown(status: number): void {
    this.failures++;
    if (this.small) {
      // The town's brain doesn't get busy, but it can stumble (e.g. the graphics card was reset): a short pause.
      this.backoffUntil = Date.now() + Math.min(30_000, 2_000 * this.failures);
      return;
    }
    const wait = Math.min(120_000, 5_000 * 2 ** (this.failures - 1));
    this.backoffUntil = Date.now() + wait;
    const st = this.freeStatus();
    if (st?.blocked && !this.toldBlocked) {
      this.toldBlocked = true;
      this.notices.push({
        text: "Can't reach any free AI service from here, so the built-in AI is doing the thinking and talking. (Pages published on claude.ai aren't allowed to reach the internet: download the game file and open it in your browser, or run it with npm start.)",
        level: "error",
      });
    } else if (this.failures === 3 && !st?.blocked) {
      this.notices.push({ text: `The free AI services are busy (${status || "no answer"}). The built-in AI fills in until they're back.`, level: "error" });
    }
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
      else if (d.pending.kind === "invent") this.applyInventResult(world, d);
      else if (d.pending.kind === "thought") this.applyThoughtResult(world, d);
      else if (d.pending.kind === "plan") this.applyPlanResult(world, d);
      else this.applyConversationResult(world, d);
    }
    // Replies first, so the next request goes out as soon as the last one is in.
    this.schedule(world);
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
    // A small model may pick well but explain badly: then they think the option's own thought.
    const thought = reply && typeof reply.thought === "string" && reply.thought ? reply.thought.slice(0, 240) : this.small && chosen ? chosen.thought : "";
    if (!chosen || !thought) {
      this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), d.error ? `error: ${d.error}` : "invalid or stale choice — used utility AI");
      applyStrategy(world, c, options, fallback, d.error ? "utility" : "llm-rejected", fallback.thought);
      return;
    }
    this.log(world, d, "ok", JSON.stringify(reply), `${c.name} chose "${chosen.label}"${chosen.id !== fallback.id ? ` (utility AI would have picked "${fallback.label}")` : ""}`);
    applyStrategy(world, c, options, chosen, "llm", thought);
    this.tally.plan++;
    if (chosen.id !== fallback.id) logEvent(world, "ai", `🧠 ${c.name} thought it over: "${thought}"`, 2, [c.id]);
  }

  private applyConversationResult(world: WorldState, d: Done): void {
    const convId = d.pending.convId!;
    const conv = world.conversations.find((x) => x.id === convId);
    if (!conv) return;
    const reply = d.json as { lines?: unknown; outcome?: unknown } | null;
    let parsed: { lines: Conversation["lines"]; outcome: Record<string, ConvValue> } | null = null;
    // The free AI only writes the words: the outcome is the one the town decided.
    const outcome = this.free ? (conv.fallback?.outcome ?? {}) : reply?.outcome;
    if (reply && Array.isArray(reply.lines) && outcome && typeof outcome === "object") {
      parsed = { lines: cleanLines(world, conv, reply.lines), outcome: outcome as Record<string, ConvValue> };
    }
    const res = resolveConversationAI(world, convId, parsed);
    if (res === "ok") this.tally.conversation++;
    this.log(world, d, res === "ok" ? "ok" : d.error ? "error" : "fallback", JSON.stringify(d.json ?? d.error), res === "ok" ? `outcome ${JSON.stringify(conv.outcome)}` : d.error ? `error: ${d.error}` : "invalid reply — template used");
  }
}

/** A director that never calls an LLM (tests / headless / no API key). */
export function offlineDirector(): AIDirector {
  return new AIDirector(null, { total: () => 0, add: () => undefined });
}
