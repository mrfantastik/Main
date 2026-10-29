import type { SmallPrompt } from "../ai/small";
import { setMemoryObserver } from "../memory/memory";
import type { Citizen, Conversation, ConversationLine, WorldState } from "../types";
import { argueDirective, argueLine } from "./argue";
import { sayingIn } from "./voice";
import { bondOf, bondsDaily, relView } from "./bonds";
import { TALK } from "./config";
import { contextFor } from "./context";
import { lifeShapesThem, takeAway } from "./extract";
import { cuesOf, mentions, toThird } from "./grammar";
import { factsDaily } from "./knowledge";
import { workGrapevine } from "./life";
import { nextDirective, planChat, recordTurn, type Directive } from "./plan";
import { profileOf, talkOf } from "./profile";
import { bigPrompt, smallTurn } from "./prompt";
import { realize } from "./realize";
import { asksSomething, checkLine, GOODBYE } from "./turn";
import type { DialogueState, Intent, TurnMeta } from "./types";

// The conversation system, end to end.
//
//   beginDialogue   plan it: how it'll likely go, each one's private agenda
//   planTurn        whose turn, and what they mean to do (from their side only)
//   builtInTurn     the turn in words, without a model (the fallback)
//   modelRequest    the turn as a layered prompt for a model (big or small)
//   readModelTurn   check a model's line and work out what it did
//   recordLine      add a line and move the conversation's state on
//   scriptConversation   a whole conversation without a model (offscreen, or no AI)
//   endDialogue     what each takes away (memories, knowledge, threads, jokes)
//   dialogueDaily   knowledge fades, bonds settle, life changes who they are
//
// Who says what is planned the same way whether a model writes the words or
// not, so the continuity (follow-ups, gossip, jokes, grudges) is the same
// either way; a model just says it better.

export { talkOf, profileOf } from "./profile";
export type { Directive } from "./plan";

// Work news travels round the workplace as it happens.
setMemoryObserver((world, c, m) => workGrapevine(world, c, m));

/** Plan a conversation and attach its state. `decided`: for a deal, what happens (in words). */
export function beginDialogue(world: WorldState, conv: Conversation, a: Citizen, b: Citizen, mode?: "argument" | "deal", decided?: string): DialogueState {
  const st = planChat(world, conv, a, b, mode);
  if (mode === "deal" && decided) st.reason = decided;
  if (mode === "argument") st.reason = String(conv.agenda.reason ?? conv.terms.reason ?? "a row");
  conv.dlg = st;
  return st;
}

/** Whose turn it is (they alternate; the one who started goes first). */
export function whoseTurn(conv: Conversation): string {
  const last = conv.lines[conv.lines.length - 1];
  return !last ? conv.a : last.speaker === conv.a ? conv.b : conv.a;
}

/** A deal (a loan, a job...) the town has already settled: the turn's plan is to say it, your way. */
function dealDirective(world: WorldState, conv: Conversation, st: DialogueState, me: Citizen, them: Citizen): Directive | null {
  const i = st.turns.length;
  const last = st.turns[i - 1] ?? null;
  const rel = relView(world, me, them);
  const base = { reply: last, askBack: null, bye: false, rel, topic: null, length: "short" as const };
  if (last?.bye) return st.turns.some((t) => t.speaker === me.id && t.bye) ? null : { ...base, move: "byeback", intent: "pass time", bye: true, hint: `${them.name} is going. Say bye back, or not.` };
  if (i >= st.maxTurns) return null;
  const decided = st.reason;
  if (i === 0) return { ...base, move: "raise", intent: "ask a favour", hint: `You've come to ${them.name} about this: ${decided.split(". ")[0]}. Bring it up, your way.` };
  if (i >= st.maxTurns - 2) return { ...base, move: "close", intent: "close the deal", bye: true, hint: `Wrap it up and go. (What happened: ${decided})` };
  return { ...base, move: i === 1 ? "answer" : "react", intent: "close the deal", hint: `Answer what ${them.name} said. What happens is already settled, so stick to it: ${decided}` };
}

/** What `speaker` means to do next (null: they've nothing more to say). */
export function planTurn(world: WorldState, conv: Conversation, speaker: string): Directive | null {
  const st = conv.dlg;
  const me = world.citizens[speaker];
  const them = world.citizens[speaker === conv.a ? conv.b : conv.a];
  if (!st || !me || !them) return null;
  if (st.mode === "argument") return argueDirective(world, conv, st, me, them);
  if (st.mode === "deal") return dealDirective(world, conv, st, me, them);
  return nextDirective(world, conv, st, me, them);
}

function meta(speaker: string, d: Directive, m: Partial<TurnMeta>, by: TurnMeta["by"]): TurnMeta {
  return {
    speaker,
    move: d.move,
    topic: d.topic?.key ?? null,
    kind: d.topic?.kind ?? null,
    intent: d.intent,
    tone: d.take ?? "light",
    asks: false,
    bye: d.bye,
    valence: d.topic?.valence ?? 0,
    told: [],
    by,
    ...m,
  };
}

/** The turn in words, without a model. */
export function builtInTurn(world: WorldState, conv: Conversation, speaker: string, d: Directive): { text: string; meta: TurnMeta; extras: Extras } {
  const st = conv.dlg!;
  const me = world.citizens[speaker];
  const them = world.citizens[speaker === conv.a ? conv.b : conv.a];
  if (st.mode === "argument") {
    sayingIn((st.said ??= []));
    const text = argueLine(world, conv, st, me, them, d);
    sayingIn(null);
    return { text, meta: meta(speaker, d, { kind: "argument" as never, tone: d.move === "concede" ? "warm" : "heated", bye: d.bye, asks: asksSomething(text) }, "built-in"), extras: {} };
  }
  if (st.mode === "deal") {
    const t = conv.fallback?.lines[st.turns.length]?.text ?? (d.bye ? "Right. See you." : "Right.");
    return { text: t, meta: meta(speaker, d, { kind: "deal", asks: asksSomething(t), bye: d.bye || GOODBYE.test(t) }, "built-in"), extras: {} };
  }
  const r = realize(world, conv, st, me, them, d);
  return { text: r.text, meta: { ...r.meta, speaker, by: "built-in" }, extras: { disclosed: r.disclosed, gift: r.gift } };
}

interface Extras {
  disclosed?: { key: string; gist: string; sensitivity: number; valence: number; confidential: boolean };
  gift?: number;
  learned?: { about: string; text: string; when: string | null; private: boolean }[];
  perceived?: string | null;
}

function whenOf(world: WorldState, w: string | null | undefined): number | null {
  if (!w) return null;
  const s = w.toLowerCase();
  const day = 1440;
  if (/today|tonight|later/.test(s)) return world.time + 6 * 60;
  if (/tomorrow/.test(s)) return world.time + day;
  if (/few days|couple of days|this week/.test(s)) return world.time + 3 * day;
  if (/next week|week/.test(s)) return world.time + 7 * day;
  return null;
}

/** Add a line to the conversation and move its state on (and note what it did: things told, money offered, how they came across). */
export function recordLine(world: WorldState, conv: Conversation, speaker: string, d: Directive, text: string, m: TurnMeta, extras: Extras = {}): void {
  const st = conv.dlg!;
  const me = world.citizens[speaker];
  const them = world.citizens[speaker === conv.a ? conv.b : conv.a];
  conv.lines.push({ speaker, text });
  recordTurn(st, m, d);
  const t = talkOf(me);
  if (m.asks) {
    t.recent.questions.push(text.toLowerCase().replace(/[^a-z ]/g, "").slice(0, 60));
    if (t.recent.questions.length > TALK.recentQuestions) t.recent.questions.shift();
  }
  if (st.turns.filter((x) => x.speaker === speaker).length === 1) {
    const b = bondOf(world, me, them.id);
    b.openers.push(`${d.opener ?? d.move}:${m.q ?? ""}`);
    if (b.openers.length > 6) b.openers.shift();
    t.recent.openers.push(text.split(/\s+/).slice(0, 3).join(" ").toLowerCase());
    if (t.recent.openers.length > TALK.recentOpeners) t.recent.openers.shift();
  }
  // They told the other something about their own life.
  const topic = d.topic;
  if (topic && ["disclose", "problem", "plan", "brag", "complain"].includes(topic.kind) && !topic.detail?.dislike) {
    const first = String(topic.detail?.first ?? "");
    const said = m.by === "built-in" || mentions(text, cuesOf(first, [me.name, them.name]), 1);
    if (said && first) {
      const gist = String(topic.detail?.gist ?? toThird(first, me.name));
      const conf = extras.disclosed?.confidential ?? (topic.sensitive > 0.6 && /keep|between us|don't tell/i.test(text));
      st.learned.push({ who: them.id, about: me.id, text: gist.replace(/\.$/, ""), when: typeof topic.detail?.when === "number" ? topic.detail.when : null, sensitive: topic.sensitive, key: topic.key, valence: topic.valence, confidential: conf, follow: topic.detail?.follow ? String(topic.detail.follow) : undefined, label: topic.label });
    }
  }
  // A model said what's new with them, or passed something on about someone.
  for (const l of extras.learned ?? []) {
    const aboutMe = /^(me|i|myself|you)$/i.test(l.about.trim()) || l.about.trim().toLowerCase() === me.name.toLowerCase();
    const about = aboutMe ? me : world.citizenOrder.map((id) => world.citizens[id]).find((c) => c.name.toLowerCase() === l.about.trim().toLowerCase());
    if (!about || about.id === them.id) continue;
    const txt = /^I\b|^I'/.test(l.text) ? toThird(l.text, about.name) : new RegExp(`^${about.name}\\b`).test(l.text) ? l.text : `${about.name} ${l.text.replace(/^(they|he|she)\s+/i, "")}`;
    const key = `said:${about.id}:${cuesOf(txt, [about.name]).slice(0, 3).join("-")}`;
    st.learned.push({ who: them.id, about: about.id, from: me.id, text: txt.replace(/\.$/, ""), when: whenOf(world, l.when), sensitive: l.private ? 0.7 : 0.3, key, valence: 0, confidential: !!l.private, follow: whenOf(world, l.when) !== null ? `Ask ${about.name} how that went` : undefined, label: txt.replace(new RegExp(`^${about.name}\\s*`), "").slice(0, 50) });
  }
  if (extras.perceived && extras.perceived.length < 60) {
    const b = bondOf(world, me, them.id);
    b.seemed = { text: extras.perceived.replace(/^(seemed|seems|came across as)\s+/i, "").replace(/\.$/, ""), t: world.time };
  }
  if (extras.gift) (st.gifts ??= []).push({ from: speaker, to: them.id, amount: extras.gift });
  if (d.answer && !d.answer.honest) (st.hid ??= []).push(speaker);
}

/** A whole conversation without a model: plan each turn and say it, until they're done. */
export function scriptConversation(world: WorldState, conv: Conversation, maxLines = 24): ConversationLine[] {
  conv.lines = [];
  for (let n = 0; n < maxLines; n++) {
    const speaker = whoseTurn(conv);
    const d = planTurn(world, conv, speaker);
    if (!d) break;
    const t = builtInTurn(world, conv, speaker, d);
    recordLine(world, conv, speaker, d, t.text, t.meta, t.extras);
  }
  return conv.lines;
}

/** Line metadata for lines that came from elsewhere (a deal's template, an old save), so the takeaway still works. */
export function adoptLines(world: WorldState, conv: Conversation, lines: ConversationLine[]): void {
  const st = conv.dlg;
  if (!st) return;
  st.turns = lines.map((l, i) => ({ speaker: l.speaker, move: i === 0 ? "raise" : i === lines.length - 1 ? "close" : "answer", topic: null, kind: st.mode === "deal" ? "deal" : st.mode === "argument" ? "argument" : null, intent: st.intents[l.speaker] ?? "pass time", tone: st.mode === "argument" ? "heated" : "light", asks: asksSomething(l.text), bye: GOODBYE.test(l.text), valence: 0, told: [], by: "built-in" }));
}

// ---------------------------------------------------------- with a model

export interface ModelRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  small?: SmallPrompt;
  /** Everything the speaker was given, as text (for the knowledge check on the reply). */
  given: string;
}

/** The turn as a prompt: layered, from the speaker's side only. */
export function modelRequest(world: WorldState, conv: Conversation, speaker: string, d: Directive, small: boolean): ModelRequest {
  const st = conv.dlg!;
  const me = world.citizens[speaker];
  const them = world.citizens[speaker === conv.a ? conv.b : conv.a];
  const ctx = contextFor(world, conv, st, me, them, d);
  st.debug.retrieved[speaker] = ctx.retrieved;
  const big = bigPrompt(world, conv, st, me, them, ctx);
  const sm = small ? smallTurn(world, conv, st, me, them, ctx) : undefined;
  return { ...big, small: sm, given: `${big.system}\n${big.user}` };
}

/** Check a model's reply for this turn: the line and what it did, or why it was turned down. */
export function readModelTurn(world: WorldState, conv: Conversation, speaker: string, d: Directive, reply: unknown, given: string): { text: string; meta: TurnMeta; extras: Extras } | { error: string } {
  const me = world.citizens[speaker];
  const them = world.citizens[speaker === conv.a ? conv.b : conv.a];
  const j = (reply ?? {}) as { spoken?: unknown; line?: unknown; intent?: unknown; topic?: unknown; tone?: unknown; endConversation?: unknown; learned?: unknown; perceived?: unknown };
  const raw = typeof j.spoken === "string" ? j.spoken : typeof j.line === "string" ? j.line : "";
  const c = checkLine(world, conv, me, them, raw, given);
  if (!c.ok) return { error: c.why ?? "rejected" };
  const text = c.text;
  const asks = asksSomething(text);
  const bye = d.bye || GOODBYE.test(text) || j.endConversation === true;
  const q = asks ? (d.askBack ?? (d.move === "raise" ? qFor(d) : d.move === "open" ? "how" : "what")) : undefined;
  const intents = new Set(["pass time", "check on them", "complain", "brag", "ask a favour", "find something out", "make peace", "vent", "gossip", "confront", "get advice", "joke around", "share news", "keep it short", "get away", "close the deal"]);
  const m: TurnMeta = {
    speaker,
    move: d.move,
    topic: d.topic?.key ?? (d.move === "react" || d.move === "answer" ? (d.reply?.topic ?? null) : null),
    kind: d.topic?.kind ?? (d.move === "react" || d.move === "answer" ? (d.reply?.kind ?? null) : null),
    intent: typeof j.intent === "string" && intents.has(j.intent) ? (j.intent as Intent) : d.intent,
    tone: typeof j.tone === "string" ? j.tone.toLowerCase().slice(0, 20) : (d.take ?? "light"),
    asks,
    q,
    ref: d.topic?.kind === "followup" ? String(d.topic.fact ?? "") : d.topic?.happening !== undefined ? `news:${d.topic.happening}` : d.topic?.fact !== undefined ? String(d.topic.fact) : undefined,
    gist: text,
    bye,
    valence: d.topic?.valence ?? 0,
    told: d.topic?.kind === "gossip" && d.topic.fact !== undefined ? [d.topic.fact] : [],
    by: "llm",
  };
  const learned = Array.isArray(j.learned)
    ? (j.learned as unknown[])
        .filter((x): x is { about: string; text: string; when?: string | null; private?: boolean } => !!x && typeof (x as { about?: unknown }).about === "string" && typeof (x as { text?: unknown }).text === "string")
        .slice(0, 2)
        .map((x) => ({ about: x.about, text: x.text.slice(0, 140), when: typeof x.when === "string" ? x.when : null, private: x.private === true }))
    : [];
  return { text, meta: m, extras: { learned, perceived: typeof j.perceived === "string" ? j.perceived.slice(0, 50) : null } };
}

function qFor(d: Directive): string {
  switch (d.topic?.kind) {
    case "followup":
      return "followup";
    case "concern":
      return "how";
    case "owed":
      return "favour";
    case "news":
      return "news";
    case "evening":
      return "evening";
    case "hypothetical":
      return "hypo";
    case "ask":
      return d.topic.key === "ask:work" ? "work" : d.topic.happening !== undefined ? "how" : "fact";
    default:
      return "what";
  }
}

/** The conversation's over: what each of them takes away. */
export function endDialogue(world: WorldState, conv: Conversation): void {
  const a = world.citizens[conv.a];
  const b = world.citizens[conv.b];
  if (!a || !b || !conv.dlg) return;
  if (conv.dlg.turns.length < conv.lines.length) adoptLines(world, conv, conv.lines);
  takeAway(world, conv, a, b);
  // Keep the finished record light: the agendas were only for planning.
  conv.dlg.agenda = {};
}

/** Daily upkeep: knowledge fades, bonds settle, life slowly shapes who they are. */
export function dialogueDaily(world: WorldState): void {
  for (const id of world.citizenOrder) {
    const c = world.citizens[id];
    if (!c.talk) continue;
    factsDaily(world, c);
    bondsDaily(world, c);
    lifeShapesThem(world, c);
  }
}

/** How long a line stays up before the next (game minutes), by how long it is. */
export function revealMinutes(text: string): number {
  const w = text.trim().split(/\s+/).length;
  return Math.max(TALK.revealBase, Math.min(TALK.revealMax, Math.round(TALK.revealBase + w * TALK.revealPerWord)));
}

/** Seed each citizen's talk profile (new worlds and old saves alike). */
export function ensureTalk(world: WorldState): void {
  for (const id of world.citizenOrder) {
    const c = world.citizens[id];
    talkOf(c);
    profileOf(c);
  }
}
