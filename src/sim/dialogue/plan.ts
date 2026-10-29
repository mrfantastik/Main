import { dominantEmotion, feelingsToward } from "../mind/emotions";
import { rand, type RngHolder } from "../rng";
import { hourOf } from "../time";
import type { Citizen, Conversation, WorldState } from "../types";
import { clamp } from "../util";
import { peekBond, relView, type RelView } from "./bonds";
import { TALK } from "./config";
import { factById } from "./knowledge";
import { howItWent, lifeItems } from "./life";
import { happeningById } from "../town/happenings";
import { profileOf } from "./profile";
import { candidates, drawAgenda, lifeTopic, rngFor } from "./topics";
import type { DialogueState, Intent, Move, Topic, TopicKind, TalkProfile, TurnMeta } from "./types";

// Planning a conversation, and each turn of it.
//
// Before they speak: how long this is likely to go (a brush-off, a quick
// "alright?", a proper catch-up, a long heart-to-heart) from how busy and
// tired they are, how they get on, how chatty they both are and how much each
// has to say; and each one's private list of things they might bring up.
//
// Each turn, from the speaker's side only: if they've been asked something,
// they answer it (or dodge it); if the other just told them something, they
// react, the way *they* would take it (a supportive friend, a jealous
// acquaintance, a practical sort, a suspicious one); if they started a topic
// they keep it going while there's interest; otherwise they move on to
// something on their mind, with a reason to (it reminded them, something
// caught their eye, or they're bored), or wind up. Interest, tension and how
// personal it's got are tracked as they go. The plan says what to do; the
// words come from the model (or the built-in fallback).

/** How someone takes what they've just heard. */
export type Take =
  | "supportive"
  | "impressed"
  | "jealous"
  | "competitive"
  | "practical"
  | "suspicious"
  | "dismissive"
  | "anxious"
  | "sympathetic"
  | "told-you-so"
  | "amused"
  | "indifferent"
  | "skeptical"
  | "protective"
  | "curious"
  | "awkward"
  | "sarcastic"
  | "teasing";

export interface Directive {
  move: Move;
  topic: Topic | null;
  intent: Intent;
  /** What they're answering or reacting to. */
  reply: TurnMeta | null;
  take?: Take;
  /** Their honest answer (when answering), and whether they let on. */
  answer?: { first: string; valence: number; honest: boolean };
  /** Then ask something (a follow-up question, or back). */
  askBack: string | null;
  /** How the move opens a conversation. */
  opener?: "followup" | "news" | "tease" | "observe" | "greet" | "continue" | "cold" | "excuse";
  /** How they get onto a new topic. */
  transition?: "association" | "remembered" | "environment" | "abrupt" | "boredom" | "callback" | null;
  length: "word" | "short" | "normal" | "long";
  /** Say goodbye in this line. */
  bye: boolean;
  /** The relationship, from the speaker's side. */
  rel: RelView;
  /** Plain instruction for the model, from this speaker's point of view only. */
  hint: string;
}

const LEISURE = new Set(["socialize", "eat", "rest", "idle", "talk", "browse", "shop"]);
const BUDGET: Partial<Record<TopicKind, [number, number]>> = {
  news: [2, 4],
  gossip: [2, 4],
  followup: [2, 4],
  concern: [2, 4],
  disclose: [3, 5],
  problem: [2, 5],
  plan: [2, 4],
  brag: [2, 3],
  complain: [2, 4],
  work: [2, 3],
  mundane: [1, 2],
  environment: [1, 1],
  hypothetical: [2, 3],
  evening: [1, 1],
  tease: [1, 1],
  joke: [1, 1],
  shared: [2, 3],
  ask: [2, 3],
  owed: [2, 4],
  disagreement: [2, 4],
};

/** Who's close enough to overhear (others in the same building). */
export function nearbyOf(world: WorldState, conv: Conversation): string[] {
  if (!conv.buildingId) return [];
  return world.citizenOrder.filter((id) => id !== conv.a && id !== conv.b && world.citizens[id].insideId === conv.buildingId).slice(0, 6);
}

/** Plan a chat: how it'll go, and what each of them has in mind. */
export function planChat(world: WorldState, conv: Conversation, a: Citizen, b: Citizen, mode?: DialogueState["mode"]): DialogueState {
  const r = rngFor(world, conv, "plan", "mode");
  const pa = profileOf(a);
  const pb = profileOf(b);
  const va = relView(world, a, b);
  const vb = relView(world, b, a);
  const nearby = nearbyOf(world, conv);
  const ca = candidates({ world, conv, me: a, them: b, rel: va, nearby });
  const cb = candidates({ world, conv, me: b, them: a, rel: vb, nearby });
  const agA = drawAgenda(ca, 4, rngFor(world, conv, a.id, "agenda"));
  const agB = drawAgenda(cb, 3, rngFor(world, conv, b.id, "agenda"));
  const want = Math.max(agA[0]?.score ?? 0, agB[0]?.score ?? 0);
  const talkative = (pa.verbosity + pb.verbosity) / 2;
  const free = LEISURE.has(a.activity.kind) && LEISURE.has(b.activity.kind) ? 1 : LEISURE.has(a.activity.kind) || LEISURE.has(b.activity.kind) ? 0.55 : 0.3;
  const energy = Math.min(a.needs.energy, b.needs.energy) / 100;
  const warm = (va.closeness + vb.closeness) / 2;
  const cold = ["enemy", "dislikes"].includes(va.kind) || ["enemy", "dislikes"].includes(vb.kind) ? 1 : 0;
  const lonely = (200 - a.needs.social - b.needs.social) / 200;
  const x = rand(r);
  let chosen: DialogueState["mode"] = mode ?? "normal";
  let reason = "";
  if (!mode) {
    const length = 0.12 + talkative * 0.35 + free * 0.22 + warm * 0.25 + want * 0.22 + lonely * 0.12 - (energy < 0.3 ? 0.18 : 0) - cold * 0.35 + (x - 0.5) * 0.4;
    const busyThem = !LEISURE.has(b.activity.kind) && pb.patience < 0.5;
    if ((cold && x < 0.45) || (busyThem && warm < 0.3 && x < 0.18) || (energy < 0.15 && x < 0.3) || (pb.awkwardness > 0.6 && pa.awkwardness > 0.5 && vb.kind === "stranger" && x < 0.4)) {
      chosen = "fail";
      reason = cold ? "they don't get on" : busyThem ? `${b.name} is busy` : energy < 0.15 ? "they're both shattered" : "no chemistry";
    } else if (length < 0.3) chosen = "brief";
    else if (length < 0.6) chosen = "normal";
    else if (length < 0.84 || (want < 0.6 && warm < 0.6)) chosen = "engaged";
    else chosen = "significant";
  }
  if (!reason) {
    const top = agA[0];
    reason = top ? `${a.name} had ${top.label} on their mind (${top.kind})` : `${a.name} and ${b.name} were in the same place`;
  }
  const [lo, hi] = TALK.lengths[chosen];
  const maxTurns = Math.round(lo + rand(r) * (hi - lo));
  const intentA: Intent = chosen === "fail" ? "pass time" : (agA[0]?.intent ?? "pass time");
  const intentB: Intent = chosen === "fail" ? (cold ? "get away" : "keep it short") : (agB[0]?.intent ?? "pass time");
  const show = (ts: Topic[]) => ts.map((t) => `${t.kind}: ${t.label} (${t.score.toFixed(2)})`);
  return {
    mode: chosen,
    maxTurns,
    initiator: a.id,
    reason,
    topic: null,
    topicKind: null,
    topicLabel: null,
    previous: [],
    tone: cold ? "tense" : warm > 0.6 ? "warm" : "light",
    engagement: clamp(0.45 + warm * 0.25 + want * 0.25 + talkative * 0.1, 0.2, 1),
    tension: cold ? 0.5 : Math.max(peekBond(a, b.id)?.tension ?? 0, peekBond(b, a.id)?.tension ?? 0) * 0.6,
    intimacy: warm,
    depth: 0,
    intents: { [a.id]: intentA, [b.id]: intentB },
    agenda: { [a.id]: agA, [b.id]: agB },
    pending: null,
    ending: null,
    topicOwner: null,
    budget: 0,
    nearby,
    turns: [],
    covered: [],
    resolved: [],
    learned: [],
    debug: { retrieved: {}, candidates: { [a.id]: show(ca.sort((x2, y) => y.score - x2.score).slice(0, 8)), [b.id]: show(cb.sort((x2, y) => y.score - x2.score).slice(0, 8)) } },
  };
}

// ------------------------------------------------------------ turns

/** How `me` takes something `them` just told them. */
export function takeOn(world: WorldState, me: Citizen, them: Citizen, rel: RelView, kind: TopicKind | null, valence: number, r: RngHolder): Take {
  const p = profileOf(me);
  const f = feelingsToward(me, them.id);
  const envy = (f.envy ?? 0) / 100 + (me.emotions.envy ?? 0) / 300;
  const x = rand(r);
  const w: [Take, number][] = [];
  if (kind === "brag" || (valence > 0.3 && (kind === "disclose" || kind === "plan" || kind === "followup" || kind === "news"))) {
    // Good news for them.
    w.push(["supportive", 0.2 + p.warmth * 0.6 + rel.closeness * 0.4]);
    w.push(["impressed", 0.15 + (1 - p.selfFocus) * 0.3]);
    w.push(["jealous", envy * 2 + (rel.kind === "rival" ? 0.6 : 0) + (rel.kind === "acquaintance" ? p.selfFocus * 0.3 : 0)]);
    w.push(["competitive", p.selfFocus * 0.4 + me.traits.competitiveness * 0.4 + (rel.kind === "rival" ? 0.4 : 0) - 0.2]);
    w.push(["practical", p.curiosity * 0.3 + me.personality.big5.conscientiousness * 0.3]);
    w.push(["suspicious", (rel.trust < -10 ? 0.5 : 0) + me.personality.big5.neuroticism * 0.2 + p.sarcasm * 0.25 - 0.1]);
    w.push(["teasing", rel.ease * p.teasing * 0.8]);
  } else if (valence < -0.25 || kind === "problem" || kind === "complain" || kind === "concern") {
    // Bad news, a moan, a worry.
    w.push(["sympathetic", 0.15 + p.empathy * 0.7 + rel.closeness * 0.4]);
    w.push(["practical", 0.1 + p.curiosity * 0.25 + me.personality.big5.conscientiousness * 0.25]);
    w.push(["dismissive", p.selfFocus * 0.4 + (1 - p.empathy) * 0.3 - rel.closeness * 0.4]);
    w.push(["anxious", me.personality.big5.neuroticism * 0.5 - 0.1]);
    w.push(["sarcastic", p.sarcasm * 0.4 * (rel.ease + 0.2)]);
    w.push(["told-you-so", (peekBond(me, them.id)?.episodes.length ?? 0) > 1 ? rel.closeness * p.bluntness * 0.8 : 0]);
  } else if (kind === "gossip") {
    w.push(["curious", 0.2 + p.gossip * 0.7]);
    w.push(["skeptical", 0.1 + me.personality.big5.conscientiousness * 0.25 + (1 - p.gossip) * 0.3]);
    w.push(["indifferent", (1 - p.gossip) * 0.4 - 0.05]);
    w.push(["amused", p.humour * 0.35]);
  } else if (kind === "tease" || kind === "joke" || kind === "hypothetical") {
    w.push(["amused", 0.2 + p.humour * 0.6]);
    w.push(["teasing", p.teasing * rel.ease]);
    w.push(["indifferent", (1 - p.humour) * 0.3]);
  } else {
    w.push(["curious", 0.15 + p.curiosity * 0.4]);
    w.push(["indifferent", 0.1 + (1 - p.curiosity) * 0.2 + (1 - p.verbosity) * 0.15]);
    w.push(["amused", p.humour * 0.25]);
    w.push(["supportive", p.warmth * 0.2]);
  }
  let total = 0;
  for (const [, v] of w) total += Math.max(0, v);
  let y = x * total;
  for (const [t, v] of w) {
    y -= Math.max(0, v);
    if (y <= 0) return t;
  }
  return w[0]?.[0] ?? "indifferent";
}

/** How long this person's line should be, from who they are, the move, and how they feel. */
function lengthFor(p: TalkProfile, move: Move, st: DialogueState, me: Citizen, r: RngHolder): Directive["length"] {
  const tired = me.needs.energy < 30 ? 0.25 : 0;
  const x = rand(r) + p.verbosity * 0.6 - tired - (st.engagement < 0.3 ? 0.2 : 0) + (st.mode === "significant" ? 0.15 : 0);
  if (move === "backchannel" || move === "byeback") return x > 1.2 ? "short" : "word";
  if (move === "close" || move === "clarify" || move === "excuse") return "short";
  if (x < 0.35) return "word";
  if (x < 0.85) return "short";
  if (x < 1.3) return "normal";
  return "long";
}

/** What they say first. */
function opener(world: WorldState, conv: Conversation, st: DialogueState, me: Citizen, them: Citizen, rel: RelView, r: RngHolder): Directive {
  const p = profileOf(me);
  const agenda = st.agenda[me.id] ?? [];
  const first = agenda[0] ?? null;
  const b = peekBond(me, them.id);
  const recently = b && b.lastT && world.time - b.lastT < 150;
  const x = rand(r);
  const base = { reply: null, askBack: null, bye: false, rel, length: lengthFor(p, "open", st, me, r) } as const;
  if (st.mode === "fail") {
    const cold = ["enemy", "dislikes"].includes(rel.kind);
    return { ...base, move: "open", topic: null, intent: cold ? "keep it short" : "pass time", opener: cold ? "cold" : "greet", length: "word", hint: cold ? `You've ended up next to ${them.name}, who you don't like. Acknowledge them, barely.` : `You see ${them.name}. Say hello, nothing more.` };
  }
  if (first && (first.kind === "followup" || first.kind === "concern" || first.kind === "owed") && rand(r) < 0.75) {
    st.agenda[me.id] = agenda.slice(1);
    return { ...base, move: "raise", topic: first, intent: first.intent, opener: "followup", hint: hintForRaise(world, me, them, first, rel, "opener") };
  }
  if (recently && first) {
    st.agenda[me.id] = agenda.slice(1);
    return { ...base, move: "raise", topic: first, intent: first.intent, opener: "continue", hint: `You were talking to ${them.name} not long ago. Skip the hello and pick up: ${hintForRaise(world, me, them, first, rel, "raise")}` };
  }
  if (first && first.kind === "news" && x < 0.35 + p.gossip * 0.4) {
    st.agenda[me.id] = agenda.slice(1);
    return { ...base, move: "raise", topic: first, intent: "share news", opener: "news", hint: hintForRaise(world, me, them, first, rel, "opener") };
  }
  if (first && first.kind === "environment" && x < 0.4) {
    st.agenda[me.id] = agenda.slice(1);
    return { ...base, move: "raise", topic: first, intent: "pass time", opener: "observe", hint: hintForRaise(world, me, them, first, rel, "opener") };
  }
  if (rel.ease > 0.45 && p.teasing > 0.4 && x < 0.25 + p.teasing * 0.3) {
    return { ...base, move: "open", topic: null, intent: "joke around", opener: "tease", hint: `You've just run into ${them.name}. Open with a bit of a dig or a joke, the way you do with them, not a polite hello.` };
  }
  const how = rel.kind === "stranger" ? "Say hello the way you would to someone you don't know." : rel.kind === "boss" ? `Say hello to ${them.name}, your boss.` : ["enemy", "dislikes", "rival"].includes(rel.kind) ? `Acknowledge ${them.name}. You're not going to pretend to be pleased.` : `Say hello the way you do with ${them.name}${rel.closeness > 0.5 ? ": no formalities" : ""}.`;
  const asks = rand(r) < 0.55 + p.warmth * 0.3;
  return { ...base, move: "open", topic: null, intent: st.intents[me.id], opener: "greet", askBack: asks ? "how" : null, hint: `${how}${asks ? " You might ask how they are, or not." : ""}` };
}

/** Their honest state, as an answer to "how are you?", and whether they'd let on to this person. */
export function howAnswer(world: WorldState, me: Citizen, them: Citizen, rel: RelView, r: RngHolder): NonNullable<Directive["answer"]> {
  const p = profileOf(me);
  const d = dominantEmotion(me, 35);
  const tired = me.needs.energy < 30;
  const hungry = me.needs.hunger < 30;
  const bad = d && ["sadness", "anger", "fear", "shame", "loneliness", "envy"].includes(d.emotion);
  const good = d && ["joy", "pride", "gratitude", "love"].includes(d.emotion);
  const honest = !bad || rand(r) < p.openness * 0.6 + rel.closeness * 0.6 - rel.guarded * 0.5;
  const feel = d ? d.emotion : "fine";
  const first = bad
    ? honest
      ? feel === "anger" ? "Fuming, actually." : feel === "fear" ? "Worried sick, if I'm honest." : feel === "loneliness" ? "Bit lonely, to be honest." : feel === "shame" ? "Not great. Don't ask." : feel === "envy" ? "Fed up." : "Not great."
      : "Fine."
    : tired
      ? "Knackered."
      : hungry
        ? "Starving."
        : good
          ? "Good, actually."
          : "Alright.";
  return { first, valence: bad ? -0.5 : good ? 0.5 : tired || hungry ? -0.1 : 0.1, honest };
}

/** The plain instruction for raising a topic (this speaker's knowledge only). */
export function hintForRaise(world: WorldState, me: Citizen, them: Citizen, t: Topic, rel: RelView, where: "opener" | "raise"): string {
  const f = t.fact !== undefined ? factById(me, t.fact) : undefined;
  const lead = where === "opener" ? `You've just run into ${them.name}. ` : "";
  switch (t.kind) {
    case "followup":
      return `${lead}You remember ${f ? f.text.replace(new RegExp(`^${them.name}\\b`), "they").replace(/^they is/, "they were") : t.label}. Ask how it went${rel.closeness > 0.5 ? ", no preamble" : ""}.`;
    case "concern":
      return `${lead}Last time ${them.name} seemed ${peekBond(me, them.id)?.seemed?.text ?? "off"}. Check they're alright, your way.`;
    case "owed":
      return `${lead}${them.name} owes you money${rel.owed?.overdue ? " and it's overdue" : ""}. Bring it up${profileOf(me).bluntness > 0.55 ? " straight out" : ", awkwardly"}.`;
    case "disagreement":
      return `${lead}You and ${them.name} fell out over ${t.label}. It's still bothering you.`;
    case "news":
      return `${lead}You've heard about ${t.label}. Ask if they've heard, or just tell them.`;
    case "shared":
      return `${lead}You were both at ${t.label}. Bring it up.`;
    case "gossip":
      return `${lead}You've heard that ${f?.text ?? t.label}${f && f.source === "rumour" ? " (only a rumour)" : f?.from ? ` (${world.citizens[f.from]?.name ?? "someone"} told you)` : ""}. Pass it on${f?.confidential ? ", even though you were told to keep it quiet" : ""}, your way.`;
    case "ask":
      if (t.key === "ask:work") return `${lead}Ask ${them.name} about their work, if you like.`;
      if (t.happening !== undefined) return `${lead}Something happened to ${them.name}: ${t.label}. Say something about it.`;
      return `${lead}You've heard that ${f?.text ?? t.label}. Ask ${them.name} if it's true${profileOf(me).bluntness > 0.55 ? ", straight out" : ", carefully"}.`;
    case "disclose":
    case "problem":
    case "plan":
    case "brag":
    case "complain":
      return `${lead}Tell ${them.name} what's going on with you: "${String(t.detail?.first ?? t.label)}"${t.sensitive > 0.5 ? " (it's private: only if you trust them)" : ""}.`;
    case "work":
      return `${lead}Talk about work.`;
    case "environment":
      return `${lead}Say something about what's around you (${t.label}${t.detail?.nearby ? `: ${t.detail.nearby} is right there` : ""}).`;
    case "mundane":
      return `${lead}Talk about something ordinary: ${t.label}.`;
    case "evening":
      return `${lead}Ask what they're up to later.`;
    case "hypothetical":
      return `${lead}Ask them a daft hypothetical question.`;
    case "joke":
      return `${lead}Bring back your running joke about ${t.label}.`;
    case "tease":
      return `${lead}Tease ${them.name} about something.`;
    default:
      return `${lead}Bring up ${t.label}.`;
  }
}

/**
 * The next thing `me` does, given the conversation so far (from `me`'s side
 * only). Null: they've nothing to add and it's over.
 */
export function nextDirective(world: WorldState, conv: Conversation, st: DialogueState, me: Citizen, them: Citizen): Directive | null {
  const i = st.turns.length;
  const r = rngFor(world, conv, me.id, `turn${i}`);
  const rel = relView(world, me, them);
  const p = profileOf(me);
  const last = st.turns[i - 1] ?? null;
  const saidBye = st.turns.some((t) => t.speaker === me.id && t.bye);
  const base = { reply: last, askBack: null, bye: false, rel } as const;
  const len = (m: Move) => lengthFor(p, m, st, me, r);
  if (i === 0) return opener(world, conv, st, me, them, rel, r);
  if (last?.bye) return saidBye ? null : { ...base, move: "byeback", topic: null, intent: st.intents[me.id], length: len("byeback"), bye: true, hint: `${them.name} is going. Say bye back, or just let them go.` };

  // A brush-off: one exchange and done.
  if (st.mode === "fail") {
    if (i >= st.maxTurns) return null;
    const cold = ["enemy", "dislikes"].includes(rel.kind);
    const busy = !LEISURE.has(me.activity.kind);
    return { ...base, move: cold || !busy ? "backchannel" : "excuse", topic: null, intent: cold ? "get away" : "keep it short", length: "word", bye: busy && !cold, hint: cold ? `${them.name} said something to you. You don't want to talk to them: answer as little as possible.` : busy ? `You're busy and can't stop to talk to ${them.name}. Say so, briefly.` : `${them.name} said hello. You've nothing much to say to them: keep it to a word or two.` };
  }

  const remaining = st.maxTurns - i;
  // A hello that didn't ask anything gets a hello back first.
  if (last && last.speaker === them.id && last.move === "open" && !last.asks && !st.turns.some((t) => t.speaker === me.id)) {
    const ask = rand(r) < p.warmth * 0.5 + p.questionRate * 0.5 && !["enemy", "dislikes", "rival"].includes(rel.kind);
    return { ...base, move: "greet", topic: null, intent: st.intents[me.id], askBack: ask ? "how" : null, length: "word", hint: `${them.name} said hello. Say hello back, your way.${ask ? " Maybe ask how they are." : ""}` };
  }
  const pendingForMe = st.pending && st.pending.by !== me.id ? st.pending : null;

  // Answer what they asked (or dodge it).
  if (pendingForMe && last?.speaker === them.id) {
    const q = last.q ?? "what";
    const topic = st.topic ? { key: st.topic, kind: st.topicKind ?? "ask", label: st.topicLabel ?? "", score: 1, intent: st.intents[me.id], sensitive: 0, valence: 0, about: me.id } : null;
    if (q === "how") {
      const ans = howAnswer(world, me, them, rel, r);
      // "Not great. How about you?" "Fine. But what's up with you?"
      const prevMine = st.turns[i - 2];
      const theyreBad = last.move === "answer" && last.valence <= -0.3 && prevMine?.speaker === me.id && prevMine.q === "how";
      const cares = p.empathy * 0.5 + rel.closeness * 0.6 + p.curiosity * 0.2 - (["enemy", "dislikes", "rival"].includes(rel.kind) ? 0.6 : 0);
      const askBack = theyreBad && rand(r) < cares + 0.2 ? "wrong" : rand(r) < p.questionRate * 1.2 + p.warmth * 0.2 && !st.turns.some((t) => t.speaker === me.id && t.q === "how") ? "how" : null;
      return { ...base, move: "answer", topic, intent: st.intents[me.id], answer: ans, askBack, length: len("answer"), hint: `${them.name} asked how you are. ${ans.honest ? `Truthfully: ${ans.first}` : `You're not really fine (${ans.first === "Fine." ? "you're having a bad time" : ans.first}), but you won't get into it with them.`}${askBack ? " You might ask them back." : ""}` };
    }
    if (q === "followup" && last.ref) {
      // Their copy of what you told them: how it actually went since.
      const f = factById(them, Number(last.ref)) ?? null;
      const went = f ? howItWent(world, me, f) : null;
      const sensitive = (f?.sensitivity ?? 0.3) > 0.55;
      const honest = !sensitive || rel.closeness > 0.45 || p.openness > 0.6;
      const ans = went ? { first: honest ? went.first : "It's fine. Getting there.", valence: went.valence, honest } : { first: "Alright, actually.", valence: 0.2, honest: true };
      return { ...base, move: "answer", topic, intent: st.intents[me.id], answer: ans, length: len("answer"), hint: `${them.name} is asking how it went${f ? ` (${f.text.replace(new RegExp(`^${me.name}\\b`), "you")})` : ""}. ${went ? `What actually happened: ${went.first}` : "Say how it went."}${honest ? "" : " You'd rather not go into it with them."}` };
    }
    if (q === "wrong") {
      // "What's up?" after they admitted they're not great: out with it, or not.
      // What's actually getting to them: their worst recent trouble (not a pet hate).
      const it = lifeItems(world, me).filter((x) => x.valence < -0.25 && !x.key.startsWith("dislike:") && !st.covered.includes(x.label) && !x.first.includes(them.name)).sort((a, b) => a.valence * a.importance - b.valence * b.importance)[0];
      const worry = it ? lifeTopic(me, it, 1, rel) : undefined;
      const tells = worry && rand(r) < 0.35 + p.openness * 0.4 + rel.closeness * 0.4 - worry.sensitive * 0.4;
      if (worry && tells) return { ...base, move: "raise", topic: worry, intent: rel.closeness > 0.5 ? "get advice" : "vent", opener: "continue", transition: null, length: len("raise"), hint: `${them.name} asked what's wrong. Tell them: ${hintForRaise(world, me, them, worry, rel, "raise").replace(/^Tell \S+ what's going on with you: /, "")}` };
      return { ...base, move: "deflect", topic, intent: "keep it short", length: "short", hint: `${them.name} asked what's wrong. You don't want to get into it: brush it off.` };
    }
    if (q === "agree") {
      const contrary = rand(r) < p.bluntness * 0.35 + (rel.kind === "rival" || rel.kind === "dislikes" ? 0.3 : 0);
      return { ...base, move: "answer", topic, intent: st.intents[me.id], take: contrary ? "skeptical" : "supportive", askBack: rand(r) < p.storytelling * 0.4 ? "relate" : null, length: len("answer"), hint: `${them.name} said something and wants you to agree. ${contrary ? "You don't, quite." : "You do, more or less."}` };
    }
    // A sensitive question from someone they don't trust: dodge it.
    const badNews = q === "theirs" && last.ref?.startsWith("news:") && (happeningById(world, Number(last.ref.slice(5)))?.tone ?? 0) < 0;
    const touchy = (q === "fact" || badNews) && rel.closeness < 0.4 && p.openness < 0.5;
    if (touchy && rand(r) < 0.6) {
      return { ...base, move: "deflect", topic, intent: "keep it short", length: len("deflect"), hint: `${them.name} asked you something personal. You don't want to get into it with them: dodge it or change the subject.` };
    }
    // "Doing anything tonight?" "Not sure. You?"; small talk doesn't get "How come?".
    const back = q === "evening" || q === "hypo" ? (rand(r) < p.questionRate * 0.9 + p.warmth * 0.2 ? "you" : null) : null;
    return { ...base, move: "answer", topic, intent: st.intents[me.id], length: len("answer"), askBack: back, hint: `Answer what ${them.name} just asked, as yourself.${back === "you" ? " Then ask them the same." : ""}` };
  }

  // "Worried sick, if I'm honest": anyone who cares asks what's up.
  const mine = st.turns[i - 2];
  const answeredMe = !!last && last.speaker === them.id && last.move === "answer" && mine?.speaker === me.id && mine.asks;
  if (answeredMe && mine.q === "how" && last.valence <= -0.3) {
    const cares = p.empathy * 0.5 + rel.closeness * 0.6 + p.curiosity * 0.2 - (["enemy", "dislikes", "rival"].includes(rel.kind) ? 0.6 : 0);
    if (rand(r) < cares + 0.2) return { ...base, move: "ask", topic: null, intent: "check on them", take: "sympathetic", askBack: "wrong", length: "short", hint: `${them.name} just told you they're not good. Ask what's up, your way.` };
  }

  // Not something already talked about under another name ("the festival" after "the festival in the park").
  const done = (t: Topic) => st.covered.some((c) => c === t.label || (c.length > 6 && t.label.length > 6 && (c.includes(t.label) || t.label.includes(c))));

  // They've had their say and you've got something big on your mind: you take the floor.
  const raisedBy = (who: string) => st.turns.filter((t) => t.speaker === who && t.move === "raise").length;
  const pressing = (st.agenda[me.id] ?? []).find((t) => !done(t) && t.score >= 0.65);
  if (pressing && last && last.speaker === them.id && last.move === "elaborate" && !last.asks && raisedBy(them.id) > raisedBy(me.id) && st.mode !== "brief" && rand(r) < 0.45 + p.impulsiveness * 0.3 + (pressing.score - 0.65)) {
    st.agenda[me.id] = (st.agenda[me.id] ?? []).filter((t) => t !== pressing);
    return { ...base, move: "raise", topic: pressing, intent: pressing.intent, transition: p.impulsiveness > 0.55 ? "abrupt" : "remembered", length: len("raise"), hint: `${them.name} has had their say. You've got something on your mind: ${hintForRaise(world, me, them, pressing, rel, "raise")}` };
  }

  // React to what they've just told you (something with substance: not a shrug or a "fine").
  const answeredHow = answeredMe && mine.q === "how";
  const substantial = !!last && last.speaker === them.id && !!last.kind && !answeredHow && (last.move === "raise" || last.move === "elaborate" || (last.move === "answer" && (Math.abs(last.valence) >= 0.3 || last.kind === "followup" || last.q === "followup")));
  if (last && substantial) {
    const take = takeOn(world, me, them, rel, last.kind, last.valence, r);
    const small = last.kind === "mundane" || last.kind === "environment" || !!last.topic?.startsWith("dislike:");
    const flatTake = ["sarcastic", "dismissive", "told-you-so", "awkward", "amused", "indifferent", "teasing"].includes(take);
    const curious = !small && !flatTake && rand(r) < p.questionRate * 0.8 + (take === "curious" || take === "practical" || take === "suspicious" ? 0.25 : 0) - (st.engagement < 0.3 ? 0.2 : 0);
    const own = !curious && rand(r) < p.storytelling * 0.45 + p.selfFocus * 0.2 + (small ? 0.25 : 0);
    return {
      ...base,
      move: "react",
      topic: st.topic ? ({ key: st.topic, kind: st.topicKind ?? "mundane", label: st.topicLabel ?? "", score: 1, intent: st.intents[me.id], sensitive: 0, valence: last.valence, about: them.id } as Topic) : null,
      intent: take === "sympathetic" ? "check on them" : take === "jealous" || take === "competitive" ? "brag" : st.intents[me.id],
      take,
      askBack: curious ? (take === "practical" ? "detail" : take === "suspicious" || last.kind === "gossip" ? "who" : "what") : own ? "relate" : null,
      length: own ? "normal" : len("react"),
      hint: `React to what ${them.name} just said, the way you'd take it: ${TAKE_HINT[take]}.${curious ? " Then ask about it." : own ? " You might say something from your own life it reminds you of." : ""}`,
    };
  }

  // They answered your question, nothing dramatic: acknowledge it (or give your own answer).
  const QUESTIONY = new Set<TopicKind>(["ask", "followup", "concern", "owed", "joke", "tease", "evening", "hypothetical"]);
  if (answeredMe && mine.q !== "how" && st.topicKind && QUESTIONY.has(st.topicKind) && st.topicOwner === me.id) {
    const own = (st.topicKind === "evening" || st.topicKind === "hypothetical") && rand(r) < 0.7;
    if (own || rand(r) < 0.7) return { ...base, move: own ? "elaborate" : "react", topic: currentTopic(st, me), intent: st.intents[me.id], take: "indifferent", length: "short", hint: own ? `${them.name} answered. Give your own answer to the same question.` : `${them.name} answered your question. Acknowledge it, briefly.` };
  }

  // Wind up when it's run its course.
  const bored = st.engagement < 0.18;
  if (remaining <= 1 || bored || (st.ending && st.ending !== me.id)) {
    if (st.ending === me.id && saidBye) return null;
    const why = closeReason(world, me);
    return { ...base, move: "close", topic: null, intent: "get away", length: "short", bye: true, hint: `Time to go${why ? ` (${why})` : ""}. Wind it up and say bye, the way you would${bored ? ": you've had enough of this one" : ""}.` };
  }

  // Keep their own topic going.
  const oldNews = st.topicKind === "news" && last?.speaker === them.id && last.tone === "flat";
  if (st.topic && st.topicOwner === me.id && st.depth < st.budget && !oldNews && !(st.topicKind && ["ask", "followup", "concern", "owed", "joke", "tease"].includes(st.topicKind))) {
    return { ...base, move: "elaborate", topic: currentTopic(st, me), intent: st.intents[me.id], length: len("elaborate"), hint: `Carry on about ${st.topicLabel}: a detail, how it's going, what you make of it. Don't spell out your feelings.` };
  }

  // Something new from their list (in a long chat, they'll think of something else when the list runs out).
  let agenda = (st.agenda[me.id] ?? []).filter((t) => !done(t));
  const [lo] = TALK.lengths[st.mode] ?? [4, 8];
  if (!agenda.length && i < lo && st.engagement > 0.3) {
    const more = candidates({ world, conv, me, them, rel, nearby: st.nearby }).filter((t) => !done(t) && !st.turns.some((x) => x.topic === t.key));
    agenda = drawAgenda(more, 2, rngFor(world, conv, me.id, `more${i}`));
  }
  const next = agenda[0];
  if (next && !(last && last.move === "raise" && last.speaker === me.id)) {
    st.agenda[me.id] = agenda.slice(1);
    const said = !!last && last.speaker === them.id && ["raise", "elaborate", "answer"].includes(last.move);
    const related = said && st.topicLabel && (next.about && st.turns.some((t) => t.ref === next.about) || (st.topicKind && next.kind === st.topicKind));
    const transition: Directive["transition"] = related ? "association" : next.kind === "environment" ? "environment" : st.engagement < 0.35 ? "boredom" : p.impulsiveness > 0.6 ? "abrupt" : "remembered";
    return { ...base, move: "raise", topic: next, intent: next.intent, transition, length: len("raise"), hint: hintForRaise(world, me, them, next, rel, "raise") };
  }

  // Nothing new: a follow-up question on their topic, a word, or wind up.
  if (st.topic && st.topicOwner === them.id && rand(r) < p.curiosity) {
    return { ...base, move: "ask", topic: currentTopic(st, me), intent: "find something out", askBack: "detail", length: "short", hint: `Ask ${them.name} more about ${st.topicLabel}.` };
  }
  if (remaining > 2 && rand(r) < 0.4) return { ...base, move: "backchannel", topic: currentTopic(st, me), intent: st.intents[me.id], length: "word", hint: "Say something brief, or nothing much." };
  const why = closeReason(world, me);
  return { ...base, move: "close", topic: null, intent: "get away", length: "short", bye: true, hint: `Wind it up and say bye${why ? ` (${why})` : ""}.` };
}

function currentTopic(st: DialogueState, me: Citizen): Topic | null {
  return st.topic ? { key: st.topic, kind: st.topicKind ?? "mundane", label: st.topicLabel ?? "", score: 1, intent: st.intents[me.id], sensitive: 0, valence: 0, about: null } : null;
}

/** Why they'd go now, in their own head. */
export function closeReason(world: WorldState, me: Citizen): string {
  const h = hourOf(world.time);
  if (me.activity.kind === "work" || me.activity.kind === "manage") return "you need to get back to work";
  if (me.needs.hunger < 30) return "you're starving";
  if (me.needs.energy < 25 || h >= 22) return "you're shattered";
  if (h < 9) return "you've got things to do";
  return "";
}

const TAKE_HINT: Record<Take, string> = {
  supportive: "you're pleased for them",
  impressed: "you're genuinely impressed",
  jealous: "a bit jealous, though you won't say so outright",
  competitive: "you can't help comparing it with yourself",
  practical: "you want the practical details",
  suspicious: "you're not sure it's all above board",
  dismissive: "you don't think it's such a big deal",
  anxious: "it makes you worried",
  sympathetic: "you feel for them",
  "told-you-so": "you saw this coming and can't resist saying so",
  amused: "you find it funny",
  indifferent: "you're not that bothered",
  skeptical: "you're not sure you believe it",
  protective: "you stick up for whoever it's about",
  curious: "you want to know more",
  awkward: "you don't know what to say",
  sarcastic: "you answer with sarcasm",
  teasing: "you take the mick a bit",
};

/** After a line: move the conversation's state on (topic, question waiting, interest, tension). */
export function recordTurn(st: DialogueState, meta: TurnMeta, d: Directive | null): void {
  st.turns.push(meta);
  const prof = d?.rel;
  // Topic: a raise starts one (owned by the speaker); anything else stays on it.
  if (meta.move === "raise" && meta.topic) {
    if (st.topicLabel) st.previous.push(st.topicLabel);
    st.topic = meta.topic;
    st.topicKind = meta.kind;
    st.topicLabel = d?.topic?.label ?? meta.topic;
    st.topicOwner = meta.speaker;
    st.depth = 0;
    const b = d?.topic ? BUDGET[d.topic.kind] : undefined;
    st.budget = b ? b[0] + Math.round(((meta.speaker.length + st.turns.length) % 3) / 2 * (b[1] - b[0])) : 2;
    if (st.topicLabel && !st.covered.includes(st.topicLabel)) st.covered.push(st.topicLabel);
    st.engagement = clamp(st.engagement + (d?.topic?.score ?? 0.3) * 0.25, 0, 1);
  } else st.depth++;
  // A question waits for its answer.
  st.pending = meta.asks ? { by: meta.speaker, topic: meta.topic, kind: meta.kind, text: meta.q ?? "" } : null;
  // Interest fades; short answers and dodges make it fade faster; warmth and jokes keep it up.
  st.engagement = clamp(st.engagement - 0.06 - (meta.move === "deflect" ? 0.15 : 0) - (meta.move === "backchannel" ? 0.05 : 0) + (meta.tone === "amused" || meta.tone === "warm" ? 0.05 : 0), 0, 1);
  if (meta.move === "disagree" || meta.tone === "sarcastic" && (prof?.ease ?? 0) < 0.3) st.tension = clamp(st.tension + 0.15, 0, 1);
  if (meta.move === "concede") st.tension = clamp(st.tension - 0.2, 0, 1);
  if (meta.tone === "sympathetic" || meta.kind === "disclose") st.intimacy = clamp(st.intimacy + 0.08, 0, 1);
  if (meta.bye && !st.ending) st.ending = meta.speaker;
  st.tone = st.tension > 0.55 ? "tense" : st.engagement < 0.25 ? "flat" : st.intimacy > 0.6 ? "warm" : st.tone === "tense" ? "awkward" : st.tone;
}
