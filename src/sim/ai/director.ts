import { MEAL_FILLS } from "../economy/living";
import { logEvent } from "../events";
import { remember } from "../memory/memory";
import { updateNeeds } from "../systems/needs";
import { setReflectionHook } from "../mind/reflection";
import { placeName } from "../places";
import { endLive, isPublic, sayLive, setConversationAIHook } from "../social/conversation";
import { builtInTurn, isDeal, modelRequest, planTurn, readModelTurn, whoseTurn, type Directive } from "../dialogue";
import { builtInGroupTurn, groupRequest, readGroupTurn, type GroupPlan } from "../dialogue/group";
import { nextGroupPlan, sayGroup } from "../social/group";
import { applyModelDecision, decide, rulesDecide, setDecisionHook } from "../society/tick";
import { decisionPrompt, smallDecisionPrompt } from "../society/prompt";
import type { AgentAction } from "../society/types";
import { dayOf } from "../time";
import type { AgentPlanItem, AILogEntry, Citizen, Conversation, Reflection, WorldState } from "../types";
import { newId, pushRing, round2 } from "../util";
import { activityOptions, type ActivityOption } from "./activity";
import { setActivityHook, waitingForAI } from "./brain";
import { choiceKind, lapseChoice, settleChoice, waitingChoices } from "./choices";
import { scoreOf, setThought } from "./decision";
import { addPlayerLine } from "../mind/bot";
import { botSystem, hourLabel, smallChoicePrompt, smallPlayerChatPrompt, smallDayPlanPrompt, smallDiaryPrompt, smallNextPrompt, smallReactionPrompt, smallThoughtPrompt, type SmallPrompt } from "./small";
import { situation } from "./situation";
import { makeAction } from "./actions";
import type { FreeAIClient, FreeAIStatus } from "./freeai";
import { costUsd, readHour, REFLECTION_SYSTEM, reflectionPrompt, STRATEGY_SYSTEM, strategyPrompt, THOUGHT_SYSTEM, thoughtPrompt, type LLMClient } from "./llm";
import { matchOption } from "./match";
import { applyStrategy, askAgainLater, setStrategyHook, strategyOptions, type StrategyOption } from "./strategy";
import { SOCIETY } from "../society/config";
import { societyOf } from "../society/state";
import { applyInvented, INVENT_SCHEMA, INVENT_SYSTEM, inventableKinds, inventPrompt } from "./unscripted";

// The AI Director decides WHEN it's worth asking a language model.
// With a free AI (the town's brain running in the page, or a free service)
// there's no bill, only time, so the model is kept busy all the time:
//   - it picks what people do next: while someone is busy, it's asked what
//     they'll do after, from the things the utility AI thinks make sense for
//     them right now, and their reason becomes what they're thinking,
//   - it speaks for people in the conversations it can get to (chats, deals,
//     arguments), one turn at a time, each person from their own private
//     context: the dialogue engine plans the turn (what they mean to do, from
//     what they know), the model says it, the engine checks it and keeps
//     track. A turn it can't write, or writes badly, is said by the built-in
//     voice instead, so the conversation never stalls,
//   - in between, it says what's on someone's mind.
// The person the player is looking at comes first. Whatever it can't get to
// in time is done by the built-in AI.
// With Claude (a paid API key), calls are kept for big moments:
//   - genuine strategic dilemmas with real stakes (career, business, money),
//   - conversations about money, jobs, debts and deals, some news chats, and
//     whatever conversation the player is watching (a turn at a time),
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
  /** Requests out at once. */
  maxConcurrent: number;
  /** Gap between calls (ms). */
  minIntervalMs: number;
  timeoutMs: number;
  /**
   * How many conversations the AI voices at once, any conversation at all
   * (unset: a couple at a time, and with Claude only the ones worth paying
   * for). Set it high and every conversation in town is spoken by the AI.
   */
  liveChats?: number;
}

/** The limits the player can change while it runs. */
export type DirectorLimits = Pick<DirectorOptions, "maxConcurrent" | "minIntervalMs" | "liveChats">;

interface Pending {
  id: number;
  kind: "strategy" | "conversation" | "reflection" | "invent" | "thought" | "plan" | "dayplan" | "diary" | "chat" | "decide" | "choice";
  world: WorldState;
  citizenId: string;
  convId?: number;
  /** A live chat: whose turn it was. */
  turn?: { speaker: string };
  fallbackId?: string;
  /** Plans and diaries: which day; plans: the labels of the things they could choose from. */
  day?: number;
  /** A decision about something that came up (see ai/choices.ts). */
  choiceId?: number;
  /** An agent's decision asked for again (only the AI deciding): how many times so far. */
  tries?: number;
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

/**
 * A live chat: the AI speaks for each of them in turn, a line at a time, each
 * from their own personality, feelings, memories and what's been said (and
 * nothing the other one is privately thinking).
 */
interface Live {
  world: WorldState;
  convId: number;
  /** A request is out for the next line. */
  waiting: boolean;
  /** The turn being written: who, what they mean to do, and what they were given to go on. */
  turn: LiveTurn | null;
  failures: number;
  watched: boolean;
  /** Lines the AI wrote, and lines the built-in voice had to say instead. */
  byModel: number;
  byBuiltIn: number;
  at: number;
}

/** The line being written for a live chat: who, what they mean to do, what they were given, and (AI-only) how many tries so far and why the last was turned down. */
interface LiveTurn {
  speaker: string;
  d?: Directive;
  given: string;
  plan?: GroupPlan;
  req?: { system: string; user: string; schema: Record<string, unknown>; small?: SmallPrompt };
  attempts?: number;
  /** Tries that got no answer at all (it was busy or slow). */
  missed?: number;
  why?: string;
}

/** AI-only: tries at one line before the conversation ends there. */
const AI_ONLY_ATTEMPTS = 4;

/** What to tell the model when its line was turned down, so the next try is different. */
function retryNote(why: string): string {
  if (/repeats/.test(why)) return "That was too close to something already said: say something new.";
  const who = why.match(/^mentions (\w+)/);
  if (who) return `You don't know anyone called ${who[1]}, so don't mention them.`;
  if (/^made up £/.test(why)) return "Don't make up sums of money.";
  if (/assistant/.test(why)) return "Talk like a real person, not an assistant.";
  if (/not speech|empty/.test(why)) return "Reply with only the words you say out loud.";
  if (/^deal: /.test(why)) return `That move isn't possible (${why.slice(6)}).`;
  if (/no decision about the deal/.test(why)) return 'Say what you do about the deal, in "deal".';
  if (/not a goodbye/.test(why)) return "You're saying goodbye: keep it to that.";
  return "";
}

/** A prompt with a note on the end (for another try at a line). */
function withNote(req: NonNullable<LiveTurn["req"]>, note: string): NonNullable<LiveTurn["req"]> {
  if (!note) return req;
  const extra = `\n(Your last try was turned down. ${note})`;
  const small = req.small
    ? {
        ...req.small,
        user: `${req.small.user}${extra}`,
        ...(req.small.messages
          ? { messages: req.small.messages.map((m, i, all) => (i === all.length - 1 && m.role === "user" ? { ...m, content: `${m.content}${extra}` } : m)).concat(req.small.messages[req.small.messages.length - 1]?.role === "user" ? [] : [{ role: "user" as const, content: extra.trim() }]) }
          : {}),
      }
    : undefined;
  return { ...req, user: `${req.user}${extra}`, small };
}

/** Only the AI deciding: an agent whose decision the AI couldn't make thinks again in a little while. */
function thinkAgainSoon(world: WorldState, c: Citizen): void {
  societyOf(world, c).lastThought = world.time - SOCIETY.thinkEvery + SOCIETY.retryAfter;
}

/** What a decision waiting for the AI is about, in words. */
function choiceTitle(world: WorldState, id: number | undefined): string {
  const req = waitingChoices(world).find((r) => r.id === id);
  const c = req ? world.citizens[req.who] : undefined;
  return (req && c && choiceKind(req.kind)?.title(world, c, req)) || "something that came up";
}

/** Activities the next move can be planned during (not walking, talking or between things). */
const PLANNABLE = new Set(["sleep", "work", "eat", "shop", "socialize", "rest", "bank", "browse", "trade", "research", "restock", "job_hunt", "manage"]);
/** Options within this much of the best are offered to the model... */
const SHOW_MARGIN = 1.8;
/** ...and its pick is taken if, when the time comes, it's still within this much of the best. */
const ACCEPT_MARGIN = 2.2;
/** Only the AI deciding: the options it chooses between run this far below the best (the town's scores only order them). */
const AI_ONLY_MARGIN = 4;
/** A live chat whose AI keeps failing is finished by the built-in voices after this many failures in a row. */
const LIVE_FAILURES = 3;
/** AI-only: tries at a line when no answer came back at all (it was busy, or slow), before the conversation ends there. */
const AI_ONLY_NO_ANSWER = 6;
/** The longest a reply of each kind needs to be (tokens; a free model is cut off after that, Claude gets plenty). */
const REPLY_TOKENS: Record<Pending["kind"], number> = { strategy: 400, conversation: 400, reflection: 800, invent: 1500, thought: 250, plan: 400, dayplan: 600, diary: 300, chat: 300, decide: 600, choice: 400 };
/** The next thing on someone's plan for the day may be started this early (hours). */
const PLAN_EARLY_H = 0.75;


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
  /** Agents on the roster waiting to have a decision thought through (by citizen), and why. */
  private wantDecide = new Map<string, { world: WorldState; why: string; at: number; tries?: number }>();
  /** Only the AI deciding: big decisions (career, business, money) waiting for it (by citizen). */
  private wantStrategy = new Map<string, { world: WorldState; at: number }>();
  /** Decisions about something that came up, out with the AI now (choice ids). */
  private choicesOut = new Set<number>();
  /** Only the AI deciding: which kind of request goes first next time (they take turns). */
  private turnNo = 0;
  /** For a small model's choice: the actions it was offered (by request id). */
  private decideOptions = new Map<number, AgentAction[]>();
  /** Live chats the town's brain is speaking for, line by line (by conversation id). */
  private live = new Map<number, Live>();
  /** What was asked for last (conversations and choices take turns). */
  private lastKind: Pending["kind"] | null = null;
  /** Messages for the player (the server shows them as toasts). */
  readonly notices: { text: string; level: "info" | "error" }[] = [];
  /** How the AI's been answering (real time): the last answer, the last failure and why, and the last few minutes' answers. */
  private health = { okAt: 0, failAt: 0, lastError: "", streak: 0, recent: [] as { at: number; ok: boolean; ms: number }[] };
  /** Since when (real time) a crowd has been standing there waiting for the AI (0: nobody much). */
  private crowdSince = 0;
  /** What the AI has done so far: choices people acted on, conversations it wrote, thoughts. */
  readonly tally = { plan: 0, conversation: 0, thought: 0, dayplan: 0, followed: 0, diary: 0, decide: 0, choice: 0 };

  /** When it was made (real time): "hasn't answered for" counts from here until the first answer. */
  private readonly startedAt = Date.now();

  constructor(
    private client: LLMClient | null,
    private ledger: SpendLedger,
    private opts: DirectorOptions = { maxConcurrent: 2, minIntervalMs: 2500, timeoutMs: 25_000 },
  ) {}

  get available(): boolean {
    return !!this.client && !this.disabledReason;
  }

  /** The player is watching someone in this conversation (or on their way over to it). */
  private watching(conv: Conversation): boolean {
    const f = this.focus;
    return !!f && (conv.a === f || conv.b === f || !!conv.group?.present.includes(f) || !!conv.group?.arriving.some((x) => x.who === f));
  }

  /** How many conversations it speaks at once: what the player set, or what this model can keep up with. */
  private liveLimit(conv?: Conversation): number {
    if (this.opts.liveChats !== undefined) return this.opts.liveChats;
    const base = this.small ? ((this.client?.parallel?.() ?? 1) >= 4 ? 3 : 1) : 2;
    // (A deal or a favour gets a slot of its own.)
    return base + (conv && conv.topic !== "chat" && !this.small ? 1 : 0);
  }

  /** How many requests at once, the gap between calls, and how many conversations it voices at once. */
  get limits(): DirectorLimits {
    return { maxConcurrent: this.opts.maxConcurrent, minIntervalMs: this.opts.minIntervalMs, liveChats: this.opts.liveChats };
  }

  /** Change the limits (a model of your own can take far more than a free public one). */
  setLimits(l: Partial<Omit<DirectorLimits, "liveChats">> & { liveChats?: number | null }): void {
    const n = (v: number | undefined, lo: number, hi: number) => (v === undefined || !Number.isFinite(v) ? undefined : Math.max(lo, Math.min(hi, Math.round(v))));
    this.opts = {
      ...this.opts,
      ...(n(l.maxConcurrent, 1, 32) !== undefined ? { maxConcurrent: n(l.maxConcurrent, 1, 32)! } : {}),
      ...(n(l.minIntervalMs, 0, 60_000) !== undefined ? { minIntervalMs: n(l.minIntervalMs, 0, 60_000)! } : {}),
      ...("liveChats" in l ? { liveChats: n(l.liveChats ?? undefined, 0, 50) } : {}),
    };
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
    const c = this.client as FreeAIClient | null;
    return this.free && !this.small && typeof c?.status === "function" ? c.status() : null;
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
    const waiting = "";
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
      decide: `Thinking as ${name}: what to do about people and plans`,
      choice: `Deciding for ${name}: ${choiceTitle(world, p.choiceId)}`,
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
    setDecisionHook(
      (world, c, why) => this.decisionHook(world, c, why),
      (world) => this.available && world.ai.mode === "llm" && (!this.client?.slow?.() || !!world.ai.aiOnly),
    );
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
    // Only the AI decides: every big decision is the AI's, as soon as it can get to it.
    if (world.ai.aiOnly) {
      if (!this.canCall(world, true)) return false;
      this.wantStrategy.set(c.id, { world, at: world.time });
      return true;
    }
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

  private conversationHook(world: WorldState, conv: Conversation, _brief: string, _outcomeSchema: Record<string, unknown>, stakes: number): boolean | "live" {
    // (Any conversation the town has: chats, rows, and every kind of deal, all negotiated turn by turn.)
    if (conv.topic !== "chat" && conv.topic !== "argue" && !isDeal(conv.topic)) return false;
    const watched = this.watching(conv);
    const lives = [...this.live.values()].filter((l) => l.world === world).length;
    // Set by the player (a number of chats at once, or only the AI speaks): whatever they're about.
    if (this.opts.liveChats !== undefined || world.ai.aiOnly) {
      if (this.client?.slow?.() && !watched) return false;
      if (!this.canCall(world, true) || (!this.free && this.ledger.total() >= world.ai.budgetUsd)) return false;
      if (!watched && lives >= this.liveLimit(conv)) return false;
    } else if (this.free) {
      // Free: speak for as many conversations as it can keep up with (the watched one always).
      // A slow in-page model only does the ones the player is watching (nobody waits long).
      if (this.client?.slow?.() && !watched) return false;
      if (!this.canCall(world, true)) return false;
      const limit = this.small ? ((this.client?.parallel?.() ?? 1) >= 4 ? 3 : 1) : 2;
      // (A deal or a favour gets a slot of its own: chats, groups especially, can wait.)
      if (!watched && lives >= limit + (conv.topic !== "chat" ? 1 : 0)) return false;
    } else {
      // Claude: the conversations worth paying for (money, jobs, debts, rows, news chats,
      // and whatever the player is watching), a few at a time, within the budget.
      if (!this.canCall(world, true) || this.ledger.total() >= world.ai.budgetUsd) return false;
      let worth = watched;
      if (!worth && conv.topic === "chat" && conv.terms.news === true) {
        const day = dayOf(world.time);
        if (this.chatDay !== day) {
          this.chatDay = day;
          this.chatCalls = 0;
        }
        worth = this.chatCalls < Math.max(1, Math.floor(world.ai.maxCallsPerDay / 30));
        if (worth) this.chatCalls++;
      }
      if (!worth && conv.topic !== "chat") worth = stakes >= 20 || conv.topic === "argue" || conv.topic === "ask_help";
      if (!worth || lives >= (watched ? 3 : 2)) return false;
    }
    this.live.set(conv.id, { world, convId: conv.id, waiting: false, turn: null, failures: 0, watched, byModel: 0, byBuiltIn: 0, at: Date.now() });
    return "live";
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

  /** The next line of the live chat that most needs one (the one being watched first; `watchedOnly`: only that one). */
  private maybeLiveTurn(world: WorldState, watchedOnly = false): boolean {
    for (const [id, l] of this.live) {
      const conv = world.conversations.find((x) => x.id === id);
      if (l.world !== world) continue;
      if (!conv || conv.status !== "live" || conv.live?.done) this.live.delete(id);
    }
    // Only the AI speaks: a conversation nobody's speaking for (after loading a save) is picked up again.
    if (world.ai.aiOnly) this.adoptLiveChats(world);
    for (let tries = 0; tries < 3; tries++) {
      // (A group stays at most a line ahead of what's been shown: who speaks next depends on what was just said.)
      const groupReady = (l: Live) => {
        const c = world.conversations.find((x) => x.id === l.convId);
        return !c?.group || (c.group.driver === "ai" && c.revealed >= c.lines.length - 1);
      };
      // The one being watched comes first, but nobody's left standing in silence for long.
      const waited = (x: Live) => {
        const c = world.conversations.find((v) => v.id === x.convId);
        return world.time - (c?.live?.lastLineT ?? world.time) + (x.watched ? 30 : 0);
      };
      const all = [...this.live.values()].filter((l) => l.world === world && !l.waiting && groupReady(l));
      if (watchedOnly && all.some((x) => !x.watched && waited(x) > 40)) return false;
      const ready = all.filter((l) => !watchedOnly || l.watched);
      const l = ready.sort((x, y) => waited(y) - waited(x) || x.at - y.at)[0];
      if (!l) return false;
      const conv = world.conversations.find((x) => x.id === l.convId)!;
      // Another go at a line the AI got wrong (only the AI speaks), if it's still theirs to say.
      if (l.turn?.req) {
        const still = conv.group ? conv.lines.length === l.turn.plan?.at : whoseTurn(conv) === l.turn.speaker;
        if (still) {
          const req = withNote(l.turn.req, l.turn.why ? retryNote(l.turn.why) : "");
          l.waiting = true;
          this.send(world, { kind: "conversation", citizenId: l.turn.speaker, convId: conv.id, turn: { speaker: l.turn.speaker } }, req.system, req.user, req.schema, req.small);
          return true;
        }
        l.turn = null;
      }
      if (conv.group) {
        // A group: the scheduler says who speaks, to whom, and what they mean to do.
        const plan = nextGroupPlan(world, conv);
        if (!plan) {
          this.endLiveChat(world, conv.id, l, false);
          continue;
        }
        const req = groupRequest(world, conv, plan, this.small);
        l.turn = { speaker: plan.speaker, d: plan.d, given: req.given, plan, req: { system: req.system, user: req.user, schema: req.schema, small: req.small }, attempts: 0 };
        l.waiting = true;
        this.send(world, { kind: "conversation", citizenId: plan.speaker, convId: conv.id, turn: { speaker: plan.speaker } }, req.system, req.user, req.schema, req.small);
        return true;
      }
      const speaker = whoseTurn(conv);
      // The dialogue engine decides what they mean to do, from what they know.
      const d = planTurn(world, conv, speaker);
      if (!d) {
        // Nothing more to say: it's over.
        this.endLiveChat(world, conv.id, l, false);
        continue;
      }
      const req = modelRequest(world, conv, speaker, d, this.small);
      l.turn = { speaker, d, given: req.given, req: { system: req.system, user: req.user, schema: req.schema, small: req.small }, attempts: 0 };
      l.waiting = true;
      this.send(world, { kind: "conversation", citizenId: speaker, convId: conv.id, turn: { speaker } }, req.system, req.user, req.schema, req.small);
      return true;
    }
    return false;
  }

  /** Only the AI speaks: take on any live conversation nobody's speaking for (as many as it can). */
  private adoptLiveChats(world: WorldState): void {
    if (!this.available || world.ai.mode !== "llm") return;
    for (const conv of world.conversations) {
      if (conv.status !== "live" || !conv.live || conv.live.done || this.live.has(conv.id)) continue;
      const watched = this.watching(conv);
      if (this.client?.slow?.() && !watched) continue;
      const lives = [...this.live.values()].filter((l) => l.world === world).length;
      if (!watched && lives >= this.liveLimit(conv)) continue;
      if (conv.group) conv.group.driver = "ai";
      this.live.set(conv.id, { world, convId: conv.id, waiting: false, turn: null, failures: 0, watched, byModel: 0, byBuiltIn: 0, at: Date.now() });
    }
  }

  /** A live chat is over (`wrap`: the built-in voices carry it to its end; never when only the AI speaks). */
  private endLiveChat(world: WorldState, convId: number, l: Live, wrap: boolean): void {
    endLive(world, convId, wrap);
    this.live.delete(convId);
    if (l.byModel > 0) this.tally.conversation++;
  }

  /** A line for a live chat came back: check it and say it (or say the built-in line instead). */
  private applyTurnResult(world: WorldState, d: Done): void {
    const l = this.live.get(d.pending.convId!);
    const conv = world.conversations.find((x) => x.id === d.pending.convId);
    if (!l || l.world !== world || !conv || conv.status !== "live" || conv.live?.done) {
      this.live.delete(d.pending.convId!);
      return;
    }
    l.waiting = false;
    const t = l.turn;
    l.turn = null;
    if (t?.plan && conv.group) {
      this.applyGroupTurn(world, d, conv, l, t);
      return;
    }
    if (!t || !t.d || whoseTurn(conv) !== t.speaker) return;
    const name = world.citizens[t.speaker]?.name ?? "someone";
    const res = d.json ? readModelTurn(world, conv, t.speaker, t.d, d.json, t.given) : { error: d.error ?? "no reply" };
    if ("error" in res && world.ai.aiOnly) {
      this.retryLine(world, d, conv, l, t, res.error, name);
      return;
    }
    if ("error" in res) {
      // Turned down (or no reply): this turn in their own built-in voice, so they don't stand there in silence.
      l.failures++;
      this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), `${d.error ? `error: ${d.error}` : `turned down (${res.error})`}: ${name}'s built-in line instead`);
      const b = builtInTurn(world, conv, t.speaker, t.d);
      sayLive(world, conv.id, t.speaker, t.d, b.text, b.meta, b.extras);
      l.byBuiltIn++;
      if (l.failures >= LIVE_FAILURES) this.endLiveChat(world, conv.id, l, true);
      return;
    }
    l.failures = 0;
    sayLive(world, conv.id, t.speaker, t.d, res.text, res.meta, res.extras);
    l.byModel++;
    this.log(world, d, "ok", JSON.stringify(d.json), `${name} said it (${t.d.move}${t.d.topic ? `: ${t.d.topic.label}` : ""})`);
  }

  /** A line for a group came back: check it and say it (or the built-in line instead). */
  private applyGroupTurn(world: WorldState, d: Done, conv: Conversation, l: Live, t: LiveTurn): void {
    const plan = t.plan!;
    // Things have moved on (the built-in voices took over, or someone else spoke): drop it.
    if (conv.group!.driver !== "ai" || conv.lines.length !== plan.at) return;
    const name = world.citizens[plan.speaker]?.name ?? "someone";
    const res = d.json ? readGroupTurn(world, conv, plan, d.json, t.given) : { error: d.error ?? "no reply" };
    if ("error" in res && world.ai.aiOnly) {
      this.retryLine(world, d, conv, l, t, res.error, name);
      return;
    }
    if ("error" in res) {
      l.failures++;
      this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), `${d.error ? `error: ${d.error}` : `turned down (${res.error})`}: ${name}'s built-in line instead`);
      const b = builtInGroupTurn(world, conv, plan);
      sayGroup(world, conv, plan, b.text, "built-in", b.meta ? { ...b.meta, by: "built-in" } : undefined, b.extras);
      l.byBuiltIn++;
      if (l.failures >= LIVE_FAILURES) this.endLiveChat(world, conv.id, l, true);
      return;
    }
    l.failures = 0;
    sayGroup(world, conv, plan, res.text, "llm", res.meta ? { ...res.meta, by: "llm" } : undefined, res.extras);
    l.byModel++;
    this.log(world, d, "ok", JSON.stringify(d.json), `${name} said it in the group (${plan.move}${plan.d?.topic ? `: ${plan.d.topic.label}` : ""}; ${plan.why})`);
  }

  /**
   * Only the AI speaks, and it got this line wrong (or no reply came): ask
   * again, telling it why, rather than putting words in their mouth. After a
   * few tries the conversation ends where it is.
   */
  private retryLine(world: WorldState, d: Done, conv: Conversation, l: Live, t: LiveTurn, why: string, name: string): void {
    // (No answer at all, because it was busy or slow, isn't a line it got wrong: it gets a few more goes at those.)
    const attempts = (t.attempts ?? 0) + (d.error ? 0 : 1);
    const missed = (t.missed ?? 0) + (d.error ? 1 : 0);
    l.failures++;
    const giveUp = attempts >= AI_ONLY_ATTEMPTS || missed >= AI_ONLY_NO_ANSWER;
    const next = d.error ? `asking for ${name}'s line again (no answer ${missed} of ${AI_ONLY_NO_ANSWER})` : `asking for ${name}'s line again (${attempts + 1} of ${AI_ONLY_ATTEMPTS})`;
    this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), `${d.error ? `error: ${d.error}` : `turned down (${why})`}: ${giveUp ? `${name} couldn't find the words, so the conversation ends there` : next}`);
    if (giveUp) {
      this.endLiveChat(world, conv.id, l, false);
      return;
    }
    l.turn = { ...t, attempts, missed, why: d.error ? (t.why ?? "") : why };
  }

  /**
   * Claude, or the AI's out of calls: live chats it can't carry on are
   * finished by the built-in voices. Only the AI speaks: they wait while it's
   * busy (and it says it's still on it), and end where they are if it's gone.
   */
  private tendLiveChats(world: WorldState): void {
    const aiOnly = !!world.ai.aiOnly;
    const out = aiOnly
      ? !this.available || world.ai.mode !== "llm" || (!!this.client?.ready && !this.client.ready()) || world.ai.callsToday >= world.ai.maxCallsPerDay || (!this.free && this.ledger.total() >= world.ai.budgetUsd)
      : !this.canCall(world, true) || (!this.free && this.ledger.total() >= world.ai.budgetUsd);
    for (const l of [...this.live.values()]) {
      if (l.world !== world) continue;
      const conv = world.conversations.find((x) => x.id === l.convId);
      if (!conv || conv.status !== "live" || conv.live?.done) {
        this.live.delete(l.convId);
        continue;
      }
      if (aiOnly && !out && conv.live) conv.live.heldT = world.time;
      if (l.waiting) continue;
      if (out) this.endLiveChat(world, conv.id, l, true);
    }
  }

  // ------------------------------------------------ agents' decisions

  /** An agent on the roster stops to think: queue it for the model (false: the model can't take it on). */
  private decisionHook(world: WorldState, c: Citizen, why: string): boolean {
    // (A slow model is left out of it, unless only the AI decides.)
    if (!this.available || world.ai.mode !== "llm" || (this.client?.slow?.() && !world.ai.aiOnly)) return false;
    if (!this.canCall(world, true)) return false;
    // Only the AI deciding, and it can't keep up: people standing there waiting to be told what to do come first,
    // so they think about people and plans a little later (it's put off, not decided for them).
    if (world.ai.aiOnly && c.id !== this.focus && this.behind(world)) return false;
    if ([...this.inFlight.values()].some((p) => p.kind === "decide" && p.citizenId === c.id)) return true;
    this.wantDecide.set(c.id, { world, why, at: world.time });
    return true;
  }

  /**
   * Decisions waiting too long (the model's busy): the built-in judgement
   * decides instead. Only the AI deciding: they keep waiting for it, and if
   * it's gone (or it's been hours) they think again a little later.
   */
  private tendDecisions(world: WorldState): void {
    for (const [id, w] of this.wantDecide) {
      if (w.world !== world) {
        this.wantDecide.delete(id);
        continue;
      }
      if (world.ai.aiOnly) {
        if (world.time - w.at > 240 || !this.canCall(world, true)) {
          this.wantDecide.delete(id);
          const c = world.citizens[id];
          if (c) thinkAgainSoon(world, c);
        }
        continue;
      }
      if (world.time - w.at > 90 || !this.canCall(world, true)) {
        this.wantDecide.delete(id);
        const c = world.citizens[id];
        if (c) rulesDecide(world, c, `${w.why}; the AI was busy, so the built-in judgement decided`);
      }
    }
  }

  /** Send the decision that most needs making (the watched agent's first). */
  private maybeDecide(world: WorldState, watchedOnly = false): boolean {
    const waiting = [...this.wantDecide.entries()].filter(([id, w]) => w.world === world && (!watchedOnly || id === this.focus));
    if (!waiting.length) return false;
    const [id, w] = waiting.find(([x]) => x === this.focus) ?? waiting.sort((x, y) => x[1].at - y[1].at)[0];
    this.wantDecide.delete(id);
    const c = world.citizens[id];
    if (!c || c.activity.kind === "talk") return false;
    if (this.small) {
      const { small, options } = smallDecisionPrompt(world, c);
      const reqId = this.send(world, { kind: "decide", citizenId: c.id, tries: w.tries }, small.system, small.user, {}, small);
      this.decideOptions.set(reqId, options);
      return true;
    }
    const p = decisionPrompt(world, c, w.why);
    this.send(world, { kind: "decide", citizenId: c.id, tries: w.tries }, p.system, p.user, p.schema);
    return true;
  }

  /**
   * Only the AI deciding, and its answer couldn't be used: ask it again,
   * telling it why (a couple of times), rather than deciding for them. After
   * that they think again later.
   */
  private decideAgain(world: WorldState, c: Citizen, d: Done, why: string): string {
    const tries = (d.pending.tries ?? 0) + 1;
    if (tries > 2) {
      thinkAgainSoon(world, c);
      return "they'll think again later";
    }
    this.wantDecide.set(c.id, { world, why, at: world.time, tries });
    return "asking the AI again";
  }

  /** A decision came back: the world checks it and carries it out (or the built-in judgement steps in). */
  private applyDecideResult(world: WorldState, d: Done): void {
    const c = world.citizens[d.pending.citizenId];
    const options = this.decideOptions.get(d.pending.id);
    this.decideOptions.delete(d.pending.id);
    if (!c) return;
    if (!d.json && world.ai.aiOnly) {
      this.log(world, d, "error", JSON.stringify(d.error ?? null), `error: ${d.error ?? "no reply"}; ${this.decideAgain(world, c, d, "time to take stock")}`);
      return;
    }
    if (!d.json) {
      const fb = rulesDecide(world, c, `the AI didn't answer (${d.error ?? "no reply"})`);
      this.log(world, d, "error", JSON.stringify(d.error ?? null), `error: ${d.error ?? "no reply"}; built-in judgement: ${fb.result ?? fb.action.type}`);
      return;
    }
    if (options) {
      // A small model chose one of the sensible options.
      const j = d.json as { choice?: unknown; thought?: unknown };
      const a = typeof j.choice === "string" ? options[Number(j.choice)] : undefined;
      if (!a && world.ai.aiOnly) {
        this.log(world, d, "rejected", JSON.stringify(d.json), `unreadable choice; ${this.decideAgain(world, c, d, "your last answer couldn't be read: pick one of the numbers")}`);
        return;
      }
      if (!a) {
        const fb = rulesDecide(world, c, "the AI's choice couldn't be read");
        this.log(world, d, "rejected", JSON.stringify(d.json), `unreadable choice; built-in judgement: ${fb.result ?? fb.action.type}`);
        return;
      }
      const thought = typeof j.thought === "string" && j.thought ? j.thought.slice(0, 200) : a.reason;
      const dec = decide(world, c, { ...a, reason: thought }, "llm", "chosen by the town's brain from the sensible options");
      if (dec.status !== "rejected") setThought(world, c, thought, 3, "llm");
      const again = dec.status === "rejected" && world.ai.aiOnly ? `; ${this.decideAgain(world, c, d, `what you chose last time wasn't possible (${dec.error})`)}` : "";
      this.log(world, d, dec.status === "rejected" ? "rejected" : "ok", JSON.stringify(d.json), `${c.name}: ${dec.result ?? dec.error ?? dec.action.type}${again}`);
      if (dec.status === "rejected" && !world.ai.aiOnly) rulesDecide(world, c, `the AI's choice wasn't possible (${dec.error})`);
      else if (dec.status !== "rejected") this.tally.decide++;
      return;
    }
    const { decision, fallback } = applyModelDecision(world, c, d.json);
    if (decision.status !== "rejected") {
      setThought(world, c, decision.action.reason, 3, "llm");
      this.tally.decide++;
    }
    // (Only the AI deciding: turned down, so it's asked again, told why.)
    const again = decision.status === "rejected" && world.ai.aiOnly ? ` (turned down; ${this.decideAgain(world, c, d, `the town turned down what you chose last time (${decision.action.type}: ${decision.error ?? "not possible"}); choose again`)})` : "";
    this.log(world, d, decision.status === "rejected" ? "rejected" : "ok", JSON.stringify(d.json), `${c.name}: ${decision.action.type}${decision.action.target ? ` → ${world.citizens[decision.action.target]?.name}` : ""}: ${decision.result ?? decision.error ?? ""}${fallback ? ` (turned down; built-in judgement: ${fallback.result ?? fallback.action.type})` : ""}${again}`);
  }

  // ------------------------------------------- big decisions (AI only)

  /** Only the AI deciding: big decisions it hasn't got to in hours, or can't now, come up again later. */
  private tendStrategy(world: WorldState): void {
    const gone = !this.canCall(world, true);
    for (const [id, w] of this.wantStrategy) {
      if (w.world !== world || (!gone && world.time - w.at <= 240)) continue;
      this.wantStrategy.delete(id);
      const c = world.citizens[id];
      if (c) askAgainLater(c, "the AI didn't get to it");
    }
  }

  /** Only the AI deciding: put the big decision that's waited longest (the watched person's first) to the AI. */
  private maybeStrategy(world: WorldState, watchedOnly = false): boolean {
    const waiting = [...this.wantStrategy.entries()].filter(([id, w]) => w.world === world && (!watchedOnly || id === this.focus));
    if (!waiting.length) return false;
    const [id] = waiting.find(([x]) => x === this.focus) ?? waiting.sort((x, y) => x[1].at - y[1].at)[0];
    this.wantStrategy.delete(id);
    const c = world.citizens[id];
    if (!c || c.awaitingAI) return false;
    const options = [...strategyOptions(world, c)].sort((a, b) => scoreOf(b) - scoreOf(a));
    // Nothing to decide any more (only carrying on is possible).
    if (options.length < 2) return false;
    const top = options.slice(0, 6);
    const stay = options.find((o) => o.id === "stay");
    if (stay && !top.includes(stay)) top.push(stay);
    const list = top.map((o) => ({ id: o.id, label: o.label }));
    const { user, schema } = strategyPrompt(world, c, list);
    c.cooldowns.llmStrategy = world.time;
    c.awaitingAI = true;
    this.send(world, { kind: "strategy", citizenId: c.id }, STRATEGY_SYSTEM, user, schema, this.small ? smallChoicePrompt(world, c, list) : undefined);
    return true;
  }

  // -------------------------------- something came up (AI only): choices

  /** Only the AI deciding: put the decision that's waited longest (the watched person's first) to the AI. */
  private maybeChoice(world: WorldState, watchedOnly = false): boolean {
    const list = waitingChoices(world).filter((r) => !this.choicesOut.has(r.id) && (!watchedOnly || r.who === this.focus));
    const req = list.find((r) => r.who === this.focus) ?? list[0];
    if (!req) return false;
    const c = world.citizens[req.who];
    const kind = choiceKind(req.kind);
    const options = c && kind ? kind.options(world, c, req) : null;
    if (!c || !kind || !options?.length) {
      // It no longer arises (the applicant found work, the business shut).
      lapseChoice(world, req);
      return false;
    }
    const title = kind.title(world, c, req);
    const menu = options.map((o) => ({ id: o.id, label: o.label }));
    const { user, schema } = strategyPrompt(world, c, menu);
    const note = req.why ? `\n(Your last answer was turned down: ${req.why}. Choose one of the options.)` : "";
    this.choicesOut.add(req.id);
    this.send(world, { kind: "choice", citizenId: c.id, choiceId: req.id }, STRATEGY_SYSTEM, `Something has come up that ${c.name} has to decide: ${title}.\n${user}${note}`, schema, this.small ? smallChoicePrompt(world, c, menu, title) : undefined);
    return true;
  }

  private applyChoiceResult(world: WorldState, d: Done): void {
    const id = d.pending.choiceId!;
    this.choicesOut.delete(id);
    const req = waitingChoices(world).find((r) => r.id === id);
    const c = world.citizens[d.pending.citizenId];
    if (!req || !c) {
      this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), "too late: it had already been settled");
      return;
    }
    const reply = d.json as { choice?: unknown; thought?: unknown } | null;
    const thought = reply && typeof reply.thought === "string" ? reply.thought.replace(/\s+/g, " ").trim().slice(0, 240) : "";
    const res = reply ? settleChoice(world, req, reply.choice, thought) : ({ ok: false, error: d.error ?? "no reply" } as const);
    if (res.ok) {
      this.tally.choice++;
      this.log(world, d, "ok", JSON.stringify(reply), `${c.name} decided: ${res.label}${thought ? ` ("${thought}")` : ""}`);
      return;
    }
    if ("gone" in res && res.gone) {
      this.log(world, d, "rejected", JSON.stringify(d.json ?? d.error), `${c.name}: ${res.error}`);
      return;
    }
    req.tries++;
    req.why = res.error;
    const giveUp = req.tries >= 3;
    if (giveUp) lapseChoice(world, req);
    this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), `${d.error ? `error: ${d.error}` : `turned down (${res.error})`}: ${giveUp ? "nobody decided, so it lapses" : `asking for ${c.name}'s decision again`}`);
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
    this.tendLiveChats(world);
    this.tendDecisions(world);
    this.tendStrategy(world);
    // Claude: live chats' next lines and agents' decisions are scheduled here (everything else is asked for as it comes up).
    // (Only the AI deciding: everything is the AI's, Claude or not.)
    if (!this.free && !world.ai.aiOnly) {
      for (let n = 0; n < 2 && this.canCall(world); n++) if (!this.maybeLiveTurn(world) && !this.maybeDecide(world)) break;
      return;
    }
    // As many as it can take at once (several for the town's brain on a graphics card).
    for (let n = 0; n < 8 && this.canCall(world); n++) if (!this.scheduleOne(world)) break;
  }

  /** Send the most useful request there is; false when there's nothing to ask. */
  private scheduleOne(world: WorldState): boolean {
    // Whoever the player is looking at comes first: what they say, what they decide, what they do next.
    if (this.maybeReact(world) || this.maybeLiveTurn(world, true) || this.maybeDecide(world, true) || this.maybeStrategy(world, true) || this.maybeChoice(world, true) || this.maybeNext(world, true) || this.maybeDayPlan(world, true) || this.maybeThink(world, true)) return true;
    if (world.ai.aiOnly) return this.scheduleAIOnly(world);
    // Speaking for the whole town: people standing in a conversation come before everything else.
    if ((this.opts.liveChats !== undefined || world.ai.aiOnly) && this.maybeLiveTurn(world)) return true;
    const turns: [Pending["kind"], () => boolean][] = [
      // Live chats (people are standing there waiting for the next line) take turns with everything else.
      ["conversation", () => this.maybeLiveTurn(world)],
      ["decide", () => this.maybeDecide(world)],
      ["plan", () => this.maybeNext(world, false)],
      ["dayplan", () => this.maybeDayPlan(world, false)],
    ];
    const after = turns.findIndex(([k]) => k === this.lastKind) + 1;
    if ([...turns.slice(after), ...turns.slice(0, after)].some(([, f]) => f())) return true;
    return this.maybeDiary(world) || this.maybeThink(world, false);
  }

  /**
   * Only the AI decides, so everything waits on it. People standing in a
   * conversation and people standing there waiting to be told what they do
   * take turns; then the next moves of people about to finish what they're
   * doing (so they don't have to wait); and every fourth request goes to the
   * agents' decisions, big decisions and things that came up, so those never
   * starve. Thoughts get what's left.
   */
  private scheduleAIOnly(world: WorldState): boolean {
    const live = () => this.maybeLiveTurn(world);
    const waiting = () => this.maybeNext(world, false, true);
    const ahead = () => this.maybeNext(world, false);
    const minds = () => this.maybeDecide(world) || this.maybeStrategy(world) || this.maybeChoice(world);
    const standing = this.lastKind === "conversation" ? [waiting, live] : [live, waiting];
    const order = this.turnNo++ % 4 === 3 ? [minds, ...standing, ahead] : [...standing, ahead, minds];
    return order.some((f) => f()) || this.maybeThink(world, false);
  }

  /**
   * Only the AI deciding: how far to slow the clock while people are standing
   * there waiting for it to decide what they do (1: not at all). Set
   * world.ai.waitForAI false to let the clock run regardless.
   */
  pace(world: WorldState): number {
    if (!world.ai.aiOnly || !this.available || world.ai.mode !== "llm") {
      this.crowdSince = 0;
      return 1;
    }
    const waiting = world.citizenOrder.filter((id) => waitingForAI(world.citizens[id])).length;
    if (waiting < 6) this.crowdSince = 0;
    else if (!this.crowdSince) this.crowdSince = Date.now();
    if (world.ai.waitForAI === false) return 1;
    return waiting <= 2 ? 1 : Math.max(0.1, Math.round((2 / waiting) * 100) / 100);
  }

  /** Only the AI deciding: it's behind (several people standing there waiting for it, or a queue of decisions). */
  private behind(world: WorldState): boolean {
    let waiting = 0;
    for (const id of world.citizenOrder) if (waitingForAI(world.citizens[id]) && ++waiting >= 3) return true;
    let queued = 0;
    for (const w of this.wantDecide.values()) if (w.world === world && ++queued >= 3) return true;
    return false;
  }

  /** Only the AI deciding: people standing waiting for it, and decisions queued for it. */
  backlog(world: WorldState): { people: number; decisions: number } {
    const people = world.citizenOrder.filter((id) => waitingForAI(world.citizens[id])).length;
    const mine = (w: { world: WorldState }) => w.world === world;
    const decisions = [...this.wantDecide.values()].filter(mine).length + [...this.wantStrategy.values()].filter(mine).length + waitingChoices(world).length;
    return { people, decisions };
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
    // (Only the AI deciding: a wider choice; the town's scores only put them in order.)
    const near = world.ai.aiOnly ? options.filter((o) => scoreOf(o) >= best - AI_ONLY_MARGIN).slice(0, 8) : options.filter((o) => scoreOf(o) >= best - SHOW_MARGIN).slice(0, 6);
    // Worn out or starving: no wandering off to see friends.
    const s = situation(world, c);
    return s.tired > 0.8 || s.hungry > 0.8 ? near : [...near, ...this.seeOptions(world, c)];
  }

  /**
   * Ask what someone (the person in focus, or anyone else) will do once
   * they've finished what they're doing. Only the AI deciding: everyone's
   * asked, whoever's standing there waiting first (`waitingOnly`: only them).
   */
  private maybeNext(world: WorldState, focusOnly: boolean, waitingOnly = false): boolean {
    for (const [id, p] of this.plans) if (world.time > p.until) this.plans.delete(id);
    const aiOnly = !!world.ai.aiOnly;
    const left = (c: Citizen) => c.activity.endsAt - world.time;
    const waits = (c: Citizen) => aiOnly && waitingForAI(c);
    const need = (c: Citizen) => Math.max(100 - c.needs.hunger, 100 - c.needs.energy);
    const ready = (c: Citizen) => (PLANNABLE.has(c.activity.kind) || waits(c)) && c.path.length === 0 && !c.awaitingAI && !this.plans.has(c.id) && world.time >= (c.cooldowns.planAgain ?? -1e9);
    const focus = this.focus ? world.citizens[this.focus] : undefined;
    let c: Citizen | undefined = focusOnly && focus && ready(focus) && (waits(focus) || (left(focus) > 2 && left(focus) < 12 * 60)) ? focus : undefined;
    // A free service has a rate limit to share with the conversations: only the person being watched.
    if (!focusOnly && (this.small || aiOnly)) {
      c = world.citizenOrder
        .map((cid) => world.citizens[cid])
        .filter((x) => ready(x) && (waits(x) || (!waitingOnly && left(x) > (aiOnly ? 0 : 8) && left(x) < (aiOnly ? 240 : 180) && !(aiOnly && this.planCovers(world, x)))))
        // (Of those waiting, the hungriest or most worn out first.)
        .sort((x, y) => Number(waits(y)) - Number(waits(x)) || (waits(x) ? need(y) - need(x) : 0) || left(x) - left(y))[0];
    }
    if (!c) return false;
    const options = this.sensible(world, c);
    // A chat on the way out can hold them up; the pick is still checked against how things are by then.
    const until = c.activity.endsAt + 120;
    // (Only the AI deciding, even one thing to do is the AI's to choose, with its reason.)
    if (options.length < (aiOnly ? 1 : 2)) {
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
    const aiOnly = !!world.ai.aiOnly;
    // (Only the AI deciding: a late answer still counts for someone who's still waiting for one.)
    const stillWaiting = aiOnly && waitingForAI(c) && !this.plans.has(c.id);
    if ((!plan || plan.reqId !== d.pending.id) && !stillWaiting) {
      this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), d.error ? `error: ${d.error}` : `too late: ${c.name} had already moved on`);
      return;
    }
    const reply = d.json as { choice?: unknown; thought?: unknown } | null;
    const option = reply ? matchOption(reply.choice, [...this.optionsAfter(world, c), ...this.seeOptions(world, c)]) : undefined;
    if (!option) {
      if (aiOnly) {
        // Only the AI deciding: asked again in a moment (nobody decides for them meanwhile).
        this.plans.delete(c.id);
        c.cooldowns.planAgain = world.time + 3;
        this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), `${d.error ? `error: ${d.error}` : "no usable choice"}: asking again for what ${c.name} does next`);
        return;
      }
      // Left unanswered (not asked again during this activity): the utility AI decides.
      this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), d.error ? `error: ${d.error}` : "no usable choice: the utility AI decides");
      return;
    }
    const raw = typeof reply!.thought === "string" ? reply!.thought.replace(/\s+/g, " ").trim() : "";
    const thought = raw.length >= 4 && raw.length <= 240 ? raw : null;
    if (!plan || plan.reqId !== d.pending.id) this.plans.set(c.id, { reqId: d.pending.id, until: world.time + 120, choice: option.id, thought });
    else {
      plan.choice = option.id;
      plan.thought = thought;
    }
    this.log(world, d, "ok", JSON.stringify(reply), `${c.name} will ${option.label.charAt(0).toLowerCase()}${option.label.slice(1)} next${thought ? `: "${thought}"` : ""}`);
    // Standing there waiting for this: off they go.
    if (aiOnly && waitingForAI(c)) c.activity.endsAt = world.time;
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
    const options = Object.entries(labels).map(([id, label]) => ({ id, label }));
    const raw = (d.json as { items?: unknown } | null)?.items;
    // (The town's brain writes {hour, id, why}; a bigger model {time, choice, why}.)
    const items: AgentPlanItem[] = [];
    for (const x of Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []) {
      if (!x || typeof x !== "object") continue;
      const read = readHour(x.hour ?? x.time);
      const o = matchOption(x.id ?? x.choice, options);
      if (read === null || !o) continue;
      // (Things after midnight are the end of this day: last thing at night.)
      const hour = read < 4 ? 23.75 : read;
      const why = typeof x.why === "string" ? x.why.replace(/\s+/g, " ").trim().slice(0, 160) : "";
      items.push({ hour, id: o.id, label: o.label, why, status: "todo" });
    }
    // In time order, each time once.
    items.sort((a, b) => a.hour - b.hour);
    const plan = items.filter((it, i) => i === 0 || it.hour !== items[i - 1].hour);
    if (plan.length < 2) {
      // Only the AI deciding: asked again before long (meanwhile it's asked what they do next, as it comes up).
      if (world.ai.aiOnly) c.cooldowns.agentPlan = world.time - 240 + 20;
      this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), d.error ? `error: ${d.error}` : world.ai.aiOnly ? "no usable plan: asking again soon" : "no usable plan: the utility AI runs their day");
      return;
    }
    c.agent ??= { plan: null, diary: [] };
    c.agent.plan = { day: d.pending.day ?? dayOf(world.time), items: plan };
    this.tally.dayplan++;
    this.log(world, d, "ok", JSON.stringify(d.json), `${c.name}'s plan for day ${c.agent.plan.day}: ${plan.map((i) => `${hourLabel(i.hour)} ${i.label.charAt(0).toLowerCase()}${i.label.slice(1)}`).join(", ")}`);
    // Standing there waiting to be told what to do: they get on with it.
    if (world.ai.aiOnly && waitingForAI(c)) c.activity.endsAt = world.time;
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
    // (Only the AI deciding: whatever it picked, if it's still possible.)
    const fits = (o: ActivityOption) => !!world.ai.aiOnly || (o.id.startsWith("see:") ? s.tired <= 0.8 && s.hungry <= 0.8 : scoreOf(o) >= best - ACCEPT_MARGIN);
    const find = (id: string) => options.find((o) => o.id === id) ?? (id.startsWith("see:") ? this.seeOptions(world, c).find((o) => o.id === id) : undefined);
    // Their plan for today: what's due now (things left more than three hours late didn't happen).
    const hour = (world.time % 1440) / 60;
    const plan = c.agent?.plan?.day === dayOf(world.time) ? c.agent.plan : null;
    if (plan) for (const it of plan.items) if (it.status === "todo" && hour > it.hour + 3) it.status = "skipped";

    const pick = this.plans.get(c.id);
    if (pick && pick.reqId >= 0 && world.time <= pick.until) {
      // Only the AI deciding, and it's still thinking: they wait for its answer.
      if (world.ai.aiOnly && pick.choice === null && this.inFlight.has(pick.reqId)) return null;
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
    // The next thing on the plan, once it's (nearly) time; one that can't be done now is let go once its time has come.
    for (const due of plan?.items ?? []) {
      if (due.status !== "todo") continue;
      if (hour < due.hour - PLAN_EARLY_H) break;
      const o = find(due.id);
      if (o && fits(o)) {
        due.status = "done";
        this.tally.followed++;
        const why = due.why ? due.why.charAt(0).toUpperCase() + due.why.slice(1) : "";
        // (Only the AI deciding: only its own words are shown, so no reason given means no thought.)
        const thought = why ? (/[.!?]$/.test(why) ? why : `${why}.`) : world.ai.aiOnly ? null : `${hourLabel(due.hour)} on my plan: ${due.label.charAt(0).toLowerCase()}${due.label.slice(1)}.`;
        return { option: o, thought };
      }
      if (hour >= due.hour) due.status = "skipped";
    }
    return null;
  }

  /**
   * Only the AI deciding: what they do once they've finished what they're
   * doing is already on their plan for the day (so it needn't be asked).
   */
  private planCovers(world: WorldState, c: Citizen): boolean {
    const end = c.activity.endsAt;
    const plan = c.agent?.plan;
    if (!plan || plan.day !== dayOf(end)) return false;
    const hour = (end % 1440) / 60;
    const next = plan.items.find((it) => it.status === "todo" && hour <= it.hour + 3);
    return !!next && hour >= next.hour - PLAN_EARLY_H;
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
    // Only the AI deciding: something new that's happened to them (and not put into words yet) comes first.
    const cued = (c: Citizen) => !!world.ai.aiOnly && !!c.thoughtCue && !c.thoughtCue.asked && c.thoughtCue.priority >= 2 && c.thoughtCue.t >= c.thoughtT;
    const focus = this.focus ? world.citizens[this.focus] : undefined;
    let c: Citizen | undefined;
    if (focusOnly) c = focus && awake(focus) && (since(focus) >= 30 || (cued(focus) && since(focus) >= 5)) && Date.now() >= this.nextFocusThoughtAt ? focus : undefined;
    else {
      const now = Date.now() >= this.nextThoughtAt;
      c = world.citizenOrder
        .map((id) => world.citizens[id])
        .filter((x) => awake(x) && ((now && since(x) >= 240) || (cued(x) && since(x) >= 20)))
        .sort((x, y) => Number(cued(y)) - Number(cued(x)) || (y.thoughtCue?.priority ?? 0) - (x.thoughtCue?.priority ?? 0) || since(y) - since(x))[0];
    }
    if (!c) return false;
    const fresh = cued(c);
    c.cooldowns.llmThought = world.time;
    if (c.thoughtCue) c.thoughtCue.asked = true;
    // Fast-forwarding mustn't turn into nothing but thoughts.
    if (focusOnly) this.nextFocusThoughtAt = Date.now() + (this.small ? 8_000 : 10_000);
    else if (!fresh) this.nextThoughtAt = Date.now() + (this.small ? 6_000 : 10_000);
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
      this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), d.error ? `error: ${d.error}` : world.ai.aiOnly ? "no usable thought" : "no usable thought — kept the built-in one");
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
      .complete({ system, user, schema, maxTokens: client.free ? REPLY_TOKENS[p.kind] : 3000, small })
      .then((res) => {
        const cost = client.free ? 0 : costUsd(res.model, res.inputTokens, res.outputTokens);
        if (cost) this.ledger.add(cost);
        this.failures = 0;
        if (this.inFlight.has(pending.id)) this.noteAnswer(true, Date.now() - pending.startedAt);
        this.finish({ pending, json: res.json, costUsd: cost, ms: Date.now() - pending.startedAt });
      })
      .catch((err: Error & { status?: number }) => {
        if (client.free) this.slowDown(err.status ?? 0);
        else if (err.status === 401 || err.status === 403) this.disabledReason = `Claude API rejected the key (${err.status})`;
        if (this.inFlight.has(pending.id)) this.noteAnswer(false, Date.now() - pending.startedAt, err.message ?? "error");
        this.finish({ pending, json: null, costUsd: 0, ms: Date.now() - pending.startedAt, error: err.message?.slice(0, 200) ?? "error" });
      });
    return pending.id;
  }

  private noteAnswer(ok: boolean, ms: number, error?: string): void {
    const now = Date.now();
    const h = this.health;
    if (ok) {
      h.okAt = now;
      h.streak = 0;
    } else {
      h.failAt = now;
      h.streak++;
      h.lastError = (error ?? "error").replace(/\s+/g, " ").slice(0, 160);
    }
    h.recent.push({ at: now, ok, ms });
    while (h.recent.length && (h.recent.length > 400 || now - h.recent[0].at > 5 * 60_000)) h.recent.shift();
  }

  /**
   * How the AI's been answering over the last `windowMs` (real time): answers,
   * failures, how long an answer took on average (s), the last failure, and
   * how long since the last answer (s; null: none yet).
   */
  answers(windowMs = 60_000): { answered: number; failed: number; avgSeconds: number | null; lastError: string | null; quietFor: number | null } {
    const now = Date.now();
    const recent = this.health.recent.filter((r) => now - r.at <= windowMs);
    const ok = recent.filter((r) => r.ok);
    return {
      answered: ok.length,
      failed: recent.length - ok.length,
      avgSeconds: ok.length ? Math.round(ok.reduce((a, r) => a + r.ms, 0) / ok.length / 100) / 10 : null,
      lastError: this.health.failAt && now - this.health.failAt <= windowMs ? this.health.lastError : null,
      quietFor: this.health.okAt ? Math.round((now - this.health.okAt) / 1000) : null,
    };
  }

  /**
   * Something's wrong that the player should know about (null: nothing):
   * the AI keeps failing (and why, and what to do about it), or it can't
   * keep up and a crowd is standing there waiting for it.
   */
  trouble(world: WorldState): { level: "error" | "slow"; text: string; hint: string } | null {
    if (!this.available || world.ai.mode !== "llm") return null;
    const now = Date.now();
    const h = this.health;
    const quiet = now - Math.max(h.okAt, this.startedAt);
    if (h.streak >= 3 && h.failAt > h.okAt && quiet > 20_000) {
      const e = h.lastError;
      const local = (this.client as FreeAIClient | null)?.local;
      const hint = /connect|ECONNREFUSED|fetch failed|unreach|ENOTFOUND/i.test(e)
        ? local
          ? "Is Ollama running? Start it from the Start menu (or run: ollama serve). The town carries on by itself as soon as it answers."
          : "Check your internet connection. The town carries on by itself as soon as it answers."
        : /no answer within|took longer|timed out|abort/i.test(e)
          ? local
            ? "The model is too slow on this computer. A smaller one answers much faster: close the game and start it with  npm run free -- --model qwen2.5:1.5b  (or close other programs that use the graphics card)."
            : "The AI is too slow right now. It carries on as soon as answers come back in time."
          : /answered 4\d\d|answered 5\d\d/.test(e)
            ? local
              ? "Ollama sent back an error. Try restarting Ollama (quit it from the tray icon and start it again)."
              : "The AI service sent back an error. It's tried again by itself."
            : "";
      return { level: "error", text: `The AI hasn't answered for ${Math.round(quiet / 1000)} s: ${e}`, hint };
    }
    const people = world.citizenOrder.filter((id) => waitingForAI(world.citizens[id])).length;
    if (world.ai.aiOnly && this.crowdSince && now - this.crowdSince > 60_000 && people >= 6) {
      const a = this.answers();
      return {
        level: "slow",
        text: `The AI can't keep up: ${people} people are waiting for it to decide what they do${a.avgSeconds !== null ? ` (an answer takes ${a.avgSeconds} s)` : ""}`,
        hint: (this.client as FreeAIClient | null)?.local
          ? "The clock slows down to wait for it. A smaller model (npm run free -- --model qwen2.5:1.5b) or a graphics card makes the town livelier."
          : "The clock slows down to wait for it.",
      };
    }
    return null;
  }

  /** The free AI is rate limited or unreachable: wait longer each time it happens, then try again. */
  private slowDown(status: number): void {
    this.failures++;
    if (this.small) {
      // The town's brain doesn't get busy, but it can stumble (e.g. the graphics card was reset): a short pause.
      this.backoffUntil = Date.now() + Math.min(30_000, 2_000 * this.failures);
      return;
    }
    if ((this.client as FreeAIClient | null)?.local) {
      // A model of your own (Ollama on this computer): nobody's rate limiting it, and a long pause would leave
      // the whole town standing there. It was busy, still loading, or slow once: try again in a moment.
      this.backoffUntil = Date.now() + Math.min(10_000, 1_000 * this.failures);
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
        this.noteAnswer(false, now - p.startedAt, `no answer within ${Math.round(this.opts.timeoutMs / 1000)} s`);
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
      else if (d.pending.kind === "decide") this.applyDecideResult(world, d);
      else if (d.pending.kind === "choice") this.applyChoiceResult(world, d);
      else if (d.pending.turn) this.applyTurnResult(world, d);
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
    const chosen = reply ? matchOption(reply.choice, options) : undefined;
    // A small model may pick well but explain badly: then they think the option's own thought.
    const thought = reply && typeof reply.thought === "string" && reply.thought ? reply.thought.slice(0, 240) : this.small && chosen ? chosen.thought : "";
    // (Only the AI deciding: a good choice with no reason given still stands; nothing's shown for the thought.)
    if (!chosen || (!thought && !world.ai.aiOnly)) {
      if (world.ai.aiOnly) {
        // Only the AI deciding: nobody decides for them; it comes up again later.
        askAgainLater(c, "the AI's answer couldn't be used");
        this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), `${d.error ? `error: ${d.error}` : "invalid or stale choice"}: ${c.name} will think it over again later`);
        return;
      }
      this.log(world, d, d.error ? "error" : "rejected", JSON.stringify(d.json ?? d.error), d.error ? `error: ${d.error}` : "invalid or stale choice — used utility AI");
      applyStrategy(world, c, options, fallback, d.error ? "utility" : "llm-rejected", fallback.thought);
      return;
    }
    const versus = d.pending.fallbackId && chosen.id !== fallback.id ? ` (utility AI would have picked "${fallback.label}")` : "";
    this.log(world, d, "ok", JSON.stringify(reply), `${c.name} chose "${chosen.label}"${versus}`);
    applyStrategy(world, c, options, chosen, "llm", thought);
    this.tally.plan++;
    if (thought && (versus || (world.ai.aiOnly && chosen.id !== "stay"))) logEvent(world, "ai", `🧠 ${c.name} thought it over: "${thought}"`, 2, [c.id]);
  }
}

/** A director that never calls an LLM (tests / headless / no API key). */
export function offlineDirector(): AIDirector {
  return new AIDirector(null, { total: () => 0, add: () => undefined });
}
