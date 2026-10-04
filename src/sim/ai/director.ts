import { MEAL_FILLS } from "../economy/living";
import { logEvent } from "../events";
import { remember } from "../memory/memory";
import { updateNeeds } from "../systems/needs";
import { setReflectionHook } from "../mind/reflection";
import { placeName } from "../places";
import { addLiveLine, endLive, isPublic, resolveConversationAI, setConversationAIHook } from "../social/conversation";
import { dayOf } from "../time";
import type { AgentPlanItem, AILogEntry, Citizen, Conversation, ConvValue, Reflection, WorldState } from "../types";
import { inDays, money, newId, pct, pushRing, round2 } from "../util";
import { activityOptions, type ActivityOption } from "./activity";
import { setActivityHook } from "./brain";
import { scoreOf, setThought } from "./decision";
import { addPlayerLine } from "../mind/bot";
import { botSystem, hourLabel, smallChoicePrompt, smallPlayerChatPrompt, smallConversationPrompt, smallDayPlanPrompt, smallDiaryPrompt, smallNextPrompt, smallReactionPrompt, smallThoughtPrompt, smallTurnPrompt, type SmallPrompt, type TurnPhase } from "./small";
import { situation } from "./situation";
import { makeAction } from "./actions";
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
  kind: "strategy" | "conversation" | "reflection" | "invent" | "thought" | "plan" | "dayplan" | "diary" | "chat";
  world: WorldState;
  citizenId: string;
  convId?: number;
  /** A live chat: whose turn it was, and where the chat was. */
  turn?: { speaker: string; phase: TurnPhase };
  fallbackId?: string;
  /** Plans and diaries: which day; plans: the labels of the things they could choose from. */
  day?: number;
  labels?: Record<string, string>;
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

/**
 * A live chat: the AI speaks for each of them in turn, a line at a time, each
 * from their own personality, feelings, memories and what's been said.
 */
interface Live {
  world: WorldState;
  convId: number;
  /** Whose turn it is. */
  next: string;
  phase: TurnPhase;
  /** Lines the AI has written so far, and how many it may write. */
  turns: number;
  max: number;
  /** A request is out for the next line. */
  waiting: boolean;
  failures: number;
  watched: boolean;
  /** What happens, when the town has already decided it (a loan, a job). */
  decided: string | null;
  at: number;
}

/** Said when someone's leaving. */
const GOODBYE = /\b(bye|see you|see ya|catch you|take care|got to go|gotta go|better go|better get (going|back|on)|must dash|i'm off|off now|ta-ra|cheerio|good ?night)\b/i;

/** Activities the next move can be planned during (not walking, talking or between things). */
const PLANNABLE = new Set(["sleep", "work", "eat", "shop", "socialize", "rest", "bank", "browse", "trade", "research", "restock", "job_hunt", "manage"]);
/** Options within this much of the best are offered to the model... */
const SHOW_MARGIN = 1.8;
/** ...and its pick is taken if, when the time comes, it's still within this much of the best. */
const ACCEPT_MARGIN = 2.2;
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
  /** Live chats the town's brain is speaking for, line by line (by conversation id). */
  private live = new Map<number, Live>();
  /** What was asked for last (conversations and choices take turns). */
  private lastKind: Pending["kind"] | null = null;
  /** Messages for the player (the server shows them as toasts). */
  readonly notices: { text: string; level: "info" | "error" }[] = [];
  /** What the AI has done so far: choices people acted on, conversations it wrote, thoughts. */
  readonly tally = { plan: 0, conversation: 0, thought: 0, dayplan: 0, followed: 0, diary: 0 };

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
    if (p.turn) {
      const conv2 = p.convId !== undefined ? world.conversations.find((x) => x.id === p.convId) : undefined;
      const to = conv2 ? world.citizens[p.turn.speaker === conv2.a ? conv2.b : conv2.a]?.name : undefined;
      const lives = [...this.live.values()].filter((l) => l.world === world).length;
      return `Speaking as ${world.citizens[p.turn.speaker]?.name ?? "someone"}${to ? `, talking to ${to}` : ""}${lives > 1 ? ` (${lives} conversations going)` : ""}`;
    }
    const what: Record<Pending["kind"], string> = {
      plan: `Deciding what ${name} does next`,
      dayplan: `Planning ${name}'s day`,
      diary: `Writing ${name}'s diary`,
      conversation: `Writing what ${name}${other ? ` and ${other}` : ""} say`,
      thought: `Thinking as ${name}`,
      strategy: `Weighing up a big decision for ${name}`,
      reflection: `Putting ${name}'s lessons into words`,
      invent: "Making up something that happens",
      chat: `${name} is answering you`,
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
    if (this.inFlight.size >= Math.max(this.opts.maxConcurrent, this.client?.parallel?.() ?? 0)) return false;
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

  private conversationHook(world: WorldState, conv: Conversation, brief: string, outcomeSchema: Record<string, unknown>, stakes: number): boolean | "live" {
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
      // The town's brain speaks for each of them, line by line, as many conversations as it can keep up with.
      if (!this.canCall(world, true)) return false;
      const lives = [...this.live.values()].filter((l) => l.world === world).length;
      const limit = (this.client?.parallel?.() ?? 1) >= 4 ? 3 : 1;
      if (watched || lives < limit) {
        const a = world.citizens[conv.a];
        const leisure = a && ["socialize", "eat", "rest", "talk", "idle", "shop", "browse"].includes(a.activity.kind);
        const max = conv.topic === "chat" ? (leisure ? 10 : 6) : conv.topic === "argue" ? 4 : 6;
        this.live.set(conv.id, { world, convId: conv.id, next: conv.a, phase: "open", turns: 0, max, waiting: false, failures: 0, watched, decided: this.decided(world, conv), at: Date.now() });
        return "live";
      }
      if (this.queue.length >= 2) return false;
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

  /**
   * The player says something to a citizen: their chatbot answers (as soon as
   * there's room: the player comes first). False if no AI can answer.
   */
  playerChat(world: WorldState, citizenId: string, text: string): boolean {
    const c = world.citizens[citizenId];
    const said = text.trim().slice(0, 300);
    if (!c || !said || !this.available || world.ai.mode !== "llm") return false;
    addPlayerLine(world, c, false, said);
    c.chatWaiting = true;
    const small = this.small ? smallPlayerChatPrompt(world, c) : undefined;
    // A bigger AI gets the same character card and chat, and answers in JSON.
    const transcript = (c.playerChat ?? []).slice(-12).map((l) => `${l.me ? c.name : "Visitor"}: ${l.text}`).join("\n");
    const system = botSystem(world, c, null, { place: c.insideId });
    const user = `${transcript}\n\nWrite ${c.name}'s reply to the visitor, in character. JSON: {"reply": "..."}`;
    this.send(world, { kind: "chat", citizenId: c.id }, system, user, { type: "object", properties: { reply: { type: "string" } }, required: ["reply"] }, small);
    return true;
  }

  private applyChatResult(world: WorldState, d: Done): void {
    const c = world.citizens[d.pending.citizenId];
    if (!c) return;
    c.chatWaiting = false;
    const reply = d.json as { line?: unknown; reply?: unknown } | null;
    const text = reply ? (typeof reply.line === "string" ? reply.line : typeof reply.reply === "string" ? reply.reply : "") : "";
    const line = text.trim().replace(/^["“]|["”]$/g, "").slice(0, 300);
    if (!line) {
      this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), d.error ? `error: ${d.error}` : `${c.name} couldn't find the words`);
      addPlayerLine(world, c, true, "...");
      return;
    }
    addPlayerLine(world, c, true, line);
    this.log(world, d, "ok", line, `${c.name} answered you`);
    // Being talked to cheers a person up a little, and they remember it.
    c.needs.social = Math.min(100, c.needs.social + 4);
    const recent = [...c.memories.short].reverse().find((m) => m.key === "visitor");
    if (!recent || world.time - recent.t > 120) remember(world, c, { text: "A visitor stopped to chat with me.", kind: "social", importance: 3, valence: 0.3, people: [], key: "visitor" });
  }

  /** What happens in a conversation the town has already settled, in words (null for a chat). */
  private decided(world: WorldState, conv: Conversation): string | null {
    const A = world.citizens[conv.a]?.name ?? "A";
    const B = world.citizens[conv.b]?.name ?? "B";
    const o = conv.fallback?.outcome ?? {};
    const g = conv.agenda;
    const n = (v: ConvValue | undefined) => (typeof v === "number" ? v : 0);
    switch (conv.topic) {
      case "chat":
        return null;
      case "ask_loan":
        return `${A} asks ${B} to lend them ${money(n(g.amount))}${g.purpose ? ` to ${g.purpose}` : ""}. ${o.agreed ? `${B} agrees to lend ${money(n(o.amount))} at ${pct(n(o.rate))} interest, paid back ${inDays(n(o.days))}.` : `${B} says no.`}`;
      case "pitch_investment":
        return `${A} asks ${B} to invest in their business. ${o.agreed ? `${B} puts in ${money(n(o.amount))} for ${pct(n(o.share))} of the profits.` : `${B} says no.`}`;
      case "ask_job":
        return `${A} asks ${B} for a job. ${o.agreed ? `${B} takes them on at ${money(n(o.wage))} a day.` : `${B} has nothing for them.`}`;
      case "offer_job":
        return `${A} offers ${B} a job. ${o.agreed ? `${B} takes it, at ${money(n(o.wage))} a day.` : `${B} turns it down.`}`;
      case "demand_repayment": {
        const r = String(o.result ?? "");
        return `${A} wants back the money ${B} owes them. ${r === "paid" ? `${B} pays it all back.` : r === "partial" ? `${B} pays some of it now.` : r === "promise" ? `${B} can't pay yet and promises to soon.` : `${B} refuses to pay.`}`;
      }
      case "ask_help":
        return `${A} is broke and asks ${B} for help. ${o.agreed ? `${B} gives them ${money(n(o.gift))}.` : `${B} can't give them money.`}`;
      case "share_tip":
        return `${A} has a tip about where prices are going. ${o.agreed ? `${B} takes it${n(o.price) ? ` for ${money(n(o.price))}` : ""}.` : `${B} isn't interested.`}`;
      case "sell_stock":
        return `${A} offers to sell ${B} some stock. ${o.agreed ? `${B} buys ${n(o.qty)} at ${money(n(o.price))} each.` : "They don't agree on a price."}`;
      case "argue":
        return `${A} has it out with ${B}: "${String(conv.terms.reason ?? "")}". It's an argument; nobody backs down.`;
      default:
        return null;
    }
  }

  /** The next line of the live chat that most needs one (the one being watched first; `watchedOnly`: only that one). */
  private maybeLiveTurn(world: WorldState, watchedOnly = false): boolean {
    for (const [id, l] of this.live) {
      const conv = world.conversations.find((x) => x.id === id);
      if (l.world !== world) continue;
      if (!conv || conv.status !== "live" || conv.live?.done) this.live.delete(id);
    }
    const ready = [...this.live.values()].filter((l) => l.world === world && !l.waiting && (!watchedOnly || l.watched));
    const l = ready.find((x) => x.watched) ?? ready.sort((x, y) => x.at - y.at)[0];
    if (!l) return false;
    const conv = world.conversations.find((x) => x.id === l.convId)!;
    const me = world.citizens[l.next];
    const them = world.citizens[l.next === conv.a ? conv.b : conv.a];
    if (!me || !them) return false;
    l.waiting = true;
    const small = smallTurnPrompt(world, conv, me, them, l.phase, l.decided);
    this.send(world, { kind: "conversation", citizenId: me.id, convId: conv.id, turn: { speaker: me.id, phase: l.phase } }, FREE_CONVERSATION_SYSTEM, small.user, {}, small);
    return true;
  }

  /** A line for a live chat came back: say it, and decide who speaks next and whether they're winding up. */
  private applyTurnResult(world: WorldState, d: Done): void {
    const l = this.live.get(d.pending.convId!);
    const conv = world.conversations.find((x) => x.id === d.pending.convId);
    if (!l || l.world !== world || !conv || conv.status !== "live") {
      this.live.delete(d.pending.convId!);
      return;
    }
    l.waiting = false;
    const speaker = d.pending.turn!.speaker;
    const reply = d.json as { line?: unknown } | null;
    let line = reply && typeof reply.line === "string" ? reply.line.trim() : "";
    // Not the same thing twice, and not the other person's words.
    if (line && conv.lines.some((x) => x.text.toLowerCase() === line.toLowerCase())) line = "";
    if (!line) {
      l.failures++;
      this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), d.error ? `error: ${d.error}` : "no usable line");
      if (l.failures >= 2) {
        // It isn't working: they part with the built-in goodbye (or the built-in conversation, if it never got going).
        endLive(world, conv.id, true);
        this.live.delete(conv.id);
      }
      return;
    }
    l.failures = 0;
    addLiveLine(world, conv.id, { speaker, text: line });
    l.turns++;
    const name = world.citizens[speaker]?.name ?? "someone";
    this.log(world, d, "ok", line, `${name} said it (line ${l.turns}${l.phase === "byeback" ? ", goodbye" : ""})`);
    if (l.phase === "byeback") {
      endLive(world, conv.id, false);
      this.live.delete(conv.id);
      this.tally.conversation++;
      return;
    }
    // Winding up: a goodbye gets one back; near the end, someone says it.
    l.phase = l.phase === "wrap" || (l.turns >= 4 && GOODBYE.test(line)) ? "byeback" : l.turns >= l.max - 2 ? "wrap" : "talk";
    l.next = speaker === conv.a ? conv.b : conv.a;
  }

  // ------------------------------------------------ what's next (free AI)

  /**
   * Keep the free AI busy. First the person the player is looking at: a
   * conversation they're in, their next move, their plan for the day, what
   * they're thinking. Then everyone else: conversations, next moves and
   * plans for the day taking turns (whoever is about to decide or wake goes
   * first); at night, diaries; and now and then what someone's thinking.
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
    // As many as it can take at once (several for the town's brain on a graphics card).
    for (let n = 0; n < 8 && this.free && this.canCall(world); n++) if (!this.scheduleOne(world)) break;
  }

  /** Send the most useful request there is; false when there's nothing to ask. */
  private scheduleOne(world: WorldState): boolean {
    const talk = (): boolean => {
      const q = this.queue.shift();
      if (q) this.send(world, { kind: "conversation", citizenId: q.citizenId, convId: q.convId }, FREE_CONVERSATION_SYSTEM, q.user, q.schema, q.small);
      return !!q;
    };
    if (this.maybeReact(world) || this.maybeLiveTurn(world, true) || (this.queue[0]?.watched && talk()) || this.maybeNext(world, true) || this.maybeDayPlan(world, true) || this.maybeThink(world, true)) return true;
    const turns: [Pending["kind"], () => boolean][] = [
      // Live chats (people are standing there waiting for the next line) take turns with everything else.
      ["conversation", () => this.maybeLiveTurn(world) || talk()],
      ["plan", () => this.maybeNext(world, false)],
      ["dayplan", () => this.maybeDayPlan(world, false)],
    ];
    const after = turns.findIndex(([k]) => k === this.lastKind) + 1;
    if ([...turns.slice(after), ...turns.slice(0, after)].some(([, f]) => f())) return true;
    return this.maybeDiary(world) || this.maybeThink(world, false);
  }

  /** A queued conversation that waited too long: the built-in AI speaks it. */
  private dropQueued(world: WorldState, q: Queued): void {
    const res = resolveConversationAI(world, q.convId, null);
    if (res !== "gone") pushRing(world.ai.log, { id: newId(world), t: world.time, citizenId: q.citizenId, kind: "conversation", prompt: "", response: "", costUsd: 0, ms: Date.now() - q.at, status: "fallback", note: `${this.who.toLowerCase()} was busy: the built-in AI spoke this one` }, 60);
  }

  /**
   * Run the clock and their needs forward to the end of what they're doing
   * (fed after a meal, rested after sleep), call `fn`, then put everything
   * back. `at` moves the clock further (a time later that day).
   */
  private projected<T>(world: WorldState, c: Citizen, fn: (at: (t: number) => void) => T): T {
    const needs = { ...c.needs };
    const now = world.time;
    const left = Math.max(0, Math.min(12 * 60, c.activity.endsAt - now));
    try {
      for (let i = 0; i < left; i++) updateNeeds(c);
      if (c.activity.action?.type === "EAT") c.needs.hunger = Math.min(100, c.needs.hunger + MEAL_FILLS);
      world.time = now + left;
      return fn((t) => (world.time = t));
    } finally {
      Object.assign(c.needs, needs);
      world.time = now;
    }
  }

  /** What someone could do once they've finished what they're doing, as they'll be by then (not halfway through a meal, still hungry). */
  private optionsAfter(world: WorldState, c: Citizen): ActivityOption[] {
    return this.projected(world, c, () => activityOptions(world, c));
  }

  /**
   * Going to see a friend for a chat (someone they like who's out and about).
   * Only the AI chooses this; the utility AI meets people by chance.
   */
  private seeOptions(world: WorldState, c: Citizen): ActivityOption[] {
    const h = (world.time % 1440) / 60;
    if (h < 8 || h >= 22) return [];
    return Object.entries(c.relationships)
      .filter(([, r]) => r.affinity > 15)
      .sort((a, b) => b[1].affinity - a[1].affinity)
      .map(([id]) => world.citizens[id])
      .filter((t) => t && t.id !== c.id && t.insideId && t.insideId !== c.insideId && isPublic(world, t.insideId) && t.activity.kind !== "sleep" && world.time - (c.cooldowns[`miss:${t.id}`] ?? -1e9) >= 180)
      .slice(0, 2)
      .map((t) => ({
        id: `see:${t.id}`,
        label: `Go and see ${t.name} (at ${placeName(world, t.insideId)})`,
        factors: { "wants to see a friend": 0.3 },
        payload: makeAction("MEET", t.insideId!, 10, `Looking for ${t.name}`, { targetId: t.id, topic: "chat" }),
        thought: `I'll go and see ${t.name}.`,
        priority: 2,
      }));
  }

  /** The sensible things for someone to do next, best first, and a friend or two to go and see (what the model chooses between). */
  private sensible(world: WorldState, c: Citizen): ActivityOption[] {
    const options = this.optionsAfter(world, c).sort((a, b) => scoreOf(b) - scoreOf(a));
    if (!options.length) return [];
    const best = scoreOf(options[0]);
    const near = options.filter((o) => scoreOf(o) >= best - SHOW_MARGIN).slice(0, 6);
    // Worn out or starving: no wandering off to see friends.
    const s = situation(world, c);
    return s.tired > 0.8 || s.hungry > 0.8 ? near : [...near, ...this.seeOptions(world, c)];
  }

  /** Ask what someone (the person in focus, or anyone else) will do once they've finished what they're doing. */
  private maybeNext(world: WorldState, focusOnly: boolean): boolean {
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
    const reqId = this.send(world, { kind: "plan", citizenId: c.id }, STRATEGY_SYSTEM, user, schema, this.small ? smallNextPrompt(world, c, list) : undefined);
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
    const option = choice ? (this.optionsAfter(world, c).find((o) => o.id === choice) ?? this.seeOptions(world, c).find((o) => o.id === choice)) : undefined;
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

  // --------------------------------------------- something just happened

  /** Shaken by something that just happened to them (God Mode), and the AI hasn't reacted yet. */
  private shaken(world: WorldState, c: Citizen): boolean {
    return !!c.shock && world.time - c.shock.t < 180 && (c.cooldowns.agentShock ?? -1e9) < c.shock.t;
  }

  /** Before anything else: what goes through their mind (their new plan for the day follows, see dayToPlan). */
  private maybeReact(world: WorldState): boolean {
    const c = world.citizenOrder
      .map((id) => world.citizens[id])
      .filter((x) => this.shaken(world, x) && x.activity.kind !== "sleep")
      .sort((a, b) => (a.id === this.focus ? -1 : b.id === this.focus ? 1 : b.shock!.t - a.shock!.t))[0];
    if (!c) return false;
    c.cooldowns.agentShock = world.time;
    this.plans.delete(c.id); // a pick made before this happened doesn't count
    const { user, schema } = thoughtPrompt(world, c);
    this.send(world, { kind: "thought", citizenId: c.id }, THOUGHT_SYSTEM, `${user}\nJust happened: ${c.shock!.text}`, schema, this.small ? smallReactionPrompt(world, c, c.shock!.text) : undefined);
    return true;
  }

  // ------------------------------------------------- a plan for the day

  /** The day they're planning and when they'll be up, if they need a plan (asked through the night, or first thing if they've none). */
  private dayToPlan(world: WorldState, c: Citizen): { day: number; wake: number } | null {
    // Something's happened since their last plan: they think again, whatever the time.
    const news = !!c.shock && c.shock.t > (c.cooldowns.agentPlan ?? -1e9) && world.time - c.shock.t < 180;
    if ((world.time - (c.cooldowns.agentPlan ?? -1e9) < 240 && !news) || c.awaitingAI) return null;
    if (c.activity.kind === "sleep") {
      const left = c.activity.endsAt - world.time;
      const wake = (c.activity.endsAt % 1440) / 60;
      if (left < 0 || left > 8 * 60 || wake < 4 || wake > 13) return null;
      const day = dayOf(c.activity.endsAt);
      return c.agent?.plan?.day === day ? null : { day, wake };
    }
    const h = (world.time % 1440) / 60;
    const day = dayOf(world.time);
    if (h < 5 || h > (news ? 21 : 17) || c.agent?.plan?.day === day) return null;
    return { day, wake: h + 0.25 };
  }

  /** The things they could do over the day (as they'll be once up), best first, and friends to meet up with. */
  private dayCatalog(world: WorldState, c: Citizen, day: number, wake: number): { id: string; label: string }[] {
    const start = (day - 1) * 1440;
    const hours = [...new Set([wake + 0.5, wake + 2.5, 12.5, 15, 18, 20.5].filter((h) => h >= wake && h < 22.5).map((h) => Math.round(h * 2) / 2))];
    const best = new Map<string, { label: string; score: number }>();
    this.projected(world, c, (at) => {
      for (const h of hours) {
        at(start + Math.round(h * 60));
        for (const o of activityOptions(world, c)) {
          const s = scoreOf(o);
          if (!best.has(o.id) || best.get(o.id)!.score < s) best.set(o.id, { label: o.label, score: s });
        }
      }
    });
    const things = [...best.entries()]
      .filter(([id]) => id !== "sleep")
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 9)
      .map(([id, x]) => ({ id, label: x.label }));
    const friends = Object.entries(c.relationships)
      .filter(([id, r]) => r.affinity > 15 && world.citizens[id])
      .sort((a, b) => b[1].affinity - a[1].affinity)
      .slice(0, 2)
      .map(([id]) => ({ id: `see:${id}`, label: `Meet up with ${world.citizens[id].name}` }));
    return [...things, ...friends];
  }

  /** Ask for someone's plan for the day: the person in focus, or whoever wakes up first. */
  private maybeDayPlan(world: WorldState, focusOnly: boolean): boolean {
    if (!this.small) return false; // the free web services are kept for conversations
    const focus = this.focus ? world.citizens[this.focus] : undefined;
    let c: Citizen | undefined;
    let want: { day: number; wake: number } | null = null;
    if (focusOnly) {
      want = focus ? this.dayToPlan(world, focus) : null;
      c = want ? focus : undefined;
    } else {
      const due = world.citizenOrder
        .map((id) => world.citizens[id])
        .map((x) => ({ x, w: this.dayToPlan(world, x) }))
        .filter((e) => e.w)
        // People something has just happened to first, then whoever wakes first.
        .sort((a, b) => Number(!!b.x.shock && b.x.shock.t > (b.x.cooldowns.agentPlan ?? -1e9)) - Number(!!a.x.shock && a.x.shock.t > (a.x.cooldowns.agentPlan ?? -1e9)) || (a.w!.day - b.w!.day) * 24 + (a.w!.wake - b.w!.wake))[0];
      c = due?.x;
      want = due?.w ?? null;
    }
    if (!c || !want) return false;
    const things = this.dayCatalog(world, c, want.day, want.wake);
    if (things.length < 3) return false;
    const news = c.shock && c.shock.t > (c.cooldowns.agentPlan ?? -1e9) && world.time - c.shock.t < 180 ? c.shock.text : undefined;
    c.cooldowns.agentPlan = world.time;
    const small = smallDayPlanPrompt(world, c, want.day, want.wake, things, news);
    this.send(world, { kind: "dayplan", citizenId: c.id, day: want.day, labels: Object.fromEntries(things.map((t) => [t.id, t.label])) }, small.system, small.user, {}, small);
    return true;
  }

  private applyDayPlanResult(world: WorldState, d: Done): void {
    const c = world.citizens[d.pending.citizenId];
    if (!c) return;
    const labels = d.pending.labels ?? {};
    const raw = (d.json as { items?: unknown } | null)?.items;
    const items: AgentPlanItem[] = (Array.isArray(raw) ? raw : [])
      .filter((x): x is { hour: number; id: string; why?: string } => !!x && typeof x.hour === "number" && typeof x.id === "string" && !!labels[x.id])
      .map((x) => ({ hour: x.hour, id: x.id, label: labels[x.id], why: typeof x.why === "string" ? x.why : "", status: "todo" as const }));
    if (items.length < 2) {
      this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), d.error ? `error: ${d.error}` : "no usable plan: the utility AI runs their day");
      return;
    }
    c.agent ??= { plan: null, diary: [] };
    c.agent.plan = { day: d.pending.day ?? dayOf(world.time), items };
    this.tally.dayplan++;
    this.log(world, d, "ok", JSON.stringify(d.json), `${c.name}'s plan for day ${c.agent.plan.day}: ${items.map((i) => `${hourLabel(i.hour)} ${i.label.charAt(0).toLowerCase()}${i.label.slice(1)}`).join(", ")}`);
  }

  // --------------------------------------------------- what they do

  /**
   * What they do next, when the AI has a say: the move it picked for them
   * while they were busy, or else the next thing on their own plan for the
   * day. Either way only if it still makes sense now (otherwise the utility
   * AI decides).
   */
  private activityHook(world: WorldState, c: Citizen, options: ActivityOption[], utility: ActivityOption): { option: ActivityOption; thought: string | null } | null {
    void utility;
    const best = Math.max(...options.map(scoreOf));
    const s = situation(world, c);
    const fits = (o: ActivityOption) => (o.id.startsWith("see:") ? s.tired <= 0.8 && s.hungry <= 0.8 : scoreOf(o) >= best - ACCEPT_MARGIN);
    const find = (id: string) => options.find((o) => o.id === id) ?? (id.startsWith("see:") ? this.seeOptions(world, c).find((o) => o.id === id) : undefined);
    // Their plan for today: what's due now (things left more than three hours late didn't happen).
    const hour = (world.time % 1440) / 60;
    const plan = c.agent?.plan?.day === dayOf(world.time) ? c.agent.plan : null;
    if (plan) for (const it of plan.items) if (it.status === "todo" && hour > it.hour + 3) it.status = "skipped";
    const due = plan?.items.find((it) => it.status === "todo" && hour >= it.hour - 0.75);

    const pick = this.plans.get(c.id);
    if (pick && pick.reqId >= 0 && world.time <= pick.until) {
      this.plans.delete(c.id);
      const o = pick.choice ? find(pick.choice) : undefined;
      // Things change (they got hungrier, the shop shut): a pick that no longer makes sense is dropped.
      if (o && fits(o)) {
        this.tally.plan++;
        const planned = plan?.items.find((it) => it.status === "todo" && it.id === o.id);
        if (planned) planned.status = "done";
        return { option: o, thought: pick.thought };
      }
    }
    if (due) {
      const o = find(due.id);
      if (o && fits(o)) {
        due.status = "done";
        this.tally.followed++;
        const why = due.why ? due.why.charAt(0).toUpperCase() + due.why.slice(1) : "";
        return { option: o, thought: why ? (/[.!?]$/.test(why) ? why : `${why}.`) : `${hourLabel(due.hour)} on my plan: ${due.label.charAt(0).toLowerCase()}${due.label.slice(1)}.` };
      }
    }
    return null;
  }

  // ------------------------------------------------------- the diary

  /** Asleep for the night with no diary for the day yet: write it (whoever went to bed first). */
  private maybeDiary(world: WorldState): boolean {
    if (!this.small) return false;
    const day = (c: Citizen) => dayOf(c.activity.startedAt - 4 * 60);
    const c = world.citizenOrder
      .map((id) => world.citizens[id])
      .filter((x) => {
        if (x.activity.kind !== "sleep" || world.time - x.activity.startedAt < 5) return false;
        const h = (x.activity.startedAt % 1440) / 60;
        if (h > 4 && h < 19) return false; // a nap
        if (world.time - (x.cooldowns.agentDiary ?? -1e9) < 600) return false;
        return !x.agent?.diary.some((e) => e.day === day(x));
      })
      .sort((a, b) => (a.id === this.focus ? -1 : b.id === this.focus ? 1 : a.activity.startedAt - b.activity.startedAt))[0];
    if (!c) return false;
    c.cooldowns.agentDiary = world.time;
    const small = smallDiaryPrompt(world, c);
    this.send(world, { kind: "diary", citizenId: c.id, day: day(c) }, small.system, small.user, {}, small);
    return true;
  }

  private applyDiaryResult(world: WorldState, d: Done): void {
    const c = world.citizens[d.pending.citizenId];
    if (!c) return;
    const text = (d.json as { text?: unknown } | null)?.text;
    if (typeof text !== "string" || !text) {
      this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), d.error ? `error: ${d.error}` : "no usable diary entry");
      return;
    }
    c.agent ??= { plan: null, diary: [] };
    c.agent.diary.push({ day: d.pending.day ?? dayOf(world.time), text });
    if (c.agent.diary.length > 3) c.agent.diary.shift();
    this.tally.diary++;
    this.log(world, d, "ok", JSON.stringify(d.json), `${c.name}'s diary: "${text}"`);
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
      else if (d.pending.kind === "dayplan") this.applyDayPlanResult(world, d);
      else if (d.pending.kind === "diary") this.applyDiaryResult(world, d);
      else if (d.pending.kind === "chat") this.applyChatResult(world, d);
      else if (d.pending.turn) this.applyTurnResult(world, d);
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
