import type { Citizen, CitizenId, Conversation, ConversationLine, WorldState } from "../types";
import { feelingsToward } from "../mind/emotions";
import { rand, type RngHolder } from "../rng";
import { knows, happeningById } from "../town/happenings";
import { relView } from "./bonds";
import { factById } from "./knowledge";
import { profileOf, talkOf } from "./profile";
import { rngFor } from "./topics";
import { asksSomething, checkLine, GOODBYE } from "./turn";
import { pickFor, sayingIn, stressOf, voiced } from "./voice";
import { beginDialogue, builtInTurn, modelRequest, planTurn, readModelTurn, recordLine, whoseTurn, type Directive, type ModelRequest } from "./index";
import type { GroupMove, GroupPair, GroupState, GroupTable, TopicKind, TurnMeta } from "./types";

// Conversations between three to five people.
//
// A group is run as a set of pairs: whoever's talking to whom has their
// exchange planned by the two-person engine, exactly as any chat would be
// (their own agendas, questions and answers, topics, how they take each
// other). On top of that a scheduler decides, line by line, who speaks:
//
//   1. someone's said goodbye: one of the others answers, and they go
//   2. someone's just come over: they say hello to everyone
//   3. someone needs to go (tired, hungry, been there long enough): they say so
//   4. something's just been said that a bystander has a stake in (news they
//      already knew, gossip about someone they love or can't stand, a brag
//      from someone they envy, a friend's troubles): they chip in, and the
//      impulsive ones don't wait for their turn
//   5. the pair with the floor carries on (a question always gets its answer)
//   6. their exchange has run its course, or gone on long enough: whoever
//      has most to say turns to someone and starts on something new
//   7. nobody has anything left to say: the group breaks up
//
// Everyone there hears everything: what's told to one is overheard by the
// rest, so news isn't told twice, and nobody gossips about someone standing
// next to them. Each person still speaks only from their own side: a model
// writing a line gets that person's context and the transcript, nothing else.

export const GROUP = {
  maxSize: 5,
  /** Lines before the scheduler starts winding it up (more people, longer). */
  baseLines: 14,
  perMember: 5,
  maxLines: 34,
  /** After this many lines in a row between the same two, someone else may take over. */
  floorRun: 6,
  /** How long people stay (game minutes), by temperament. */
  stay: [35, 140] as const,
};

/** Topics worth a bystander's comment. */
const TABLE_KINDS = new Set<TopicKind>(["news", "gossip", "brag", "complain", "problem", "plan", "disclose", "work", "shared", "disagreement"]);

/** What they mean to do with this line, as the group's scheduler planned it. */
export interface GroupPlan {
  speaker: CitizenId;
  to: CitizenId | null;
  move: GroupMove;
  pair?: string;
  /** For a line in a pair's exchange (and a newcomer's hello): the two-person engine's plan for it. */
  d?: Directive;
  chime?: Chime;
  /** The whole group's breaking up. */
  all?: boolean;
  /** Plain instruction for a model, from the speaker's side only. */
  hint: string;
  why: string;
  /** Lines said when it was planned (a reply for an older plan is dropped). */
  at: number;
}

interface Chime {
  kind: string;
  pool: string[];
  negative: boolean;
  note?: { about: CitizenId; affinity: number; trust: number; why: string };
  /** They believe it and pass it on later (false: they don't buy it). */
  believes: boolean;
}

/** The latest exchange between these two (a fresh one starts when they come back to each other later). */
export function pairOf(g: GroupState, x: CitizenId, y: CitizenId): GroupPair | undefined {
  for (let i = g.pairs.length - 1; i >= 0; i--) {
    const p = g.pairs[i];
    if ((p.a === x && p.b === y) || (p.a === y && p.b === x)) return p;
  }
  return undefined;
}

/** Whether these two have already had words in this group. */
function talked(g: GroupState, x: CitizenId, y: CitizenId): boolean {
  return g.pairs.some((p) => ((p.a === x && p.b === y) || (p.a === y && p.b === x)) && p.lines.length > 0);
}

/** The two-person engine's view of one pair in the group (`lines`: what it sees as the conversation so far). */
export function pairView(conv: Conversation, p: GroupPair, lines?: ConversationLine[]): Conversation {
  return { ...conv, a: p.a, b: p.b, topic: "chat", agenda: {}, terms: {}, notes: [], lines: lines ?? p.lines, dlg: p.dlg, pairKey: p.key };
}

const firstNames = (world: WorldState, ids: CitizenId[]) => {
  const ns = ids.map((id) => world.citizens[id]?.name).filter(Boolean) as string[];
  return ns.length <= 1 ? (ns[0] ?? "") : `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`;
};

/** A new group (two people to begin with; others may be on their way). */
export function newGroup(world: WorldState, conv: Conversation, a: Citizen, b: Citizen, arriving: { who: CitizenId; after: number }[], driver: GroupState["driver"]): GroupState {
  const g: GroupState = {
    v: 1,
    members: [a.id, b.id],
    present: [a.id, b.id],
    joinedT: { [a.id]: world.time, [b.id]: world.time },
    pairs: [],
    turns: [],
    floor: null,
    table: null,
    arriving,
    leaving: null,
    left: [],
    maxLines: Math.min(GROUP.maxLines, GROUP.baseLines + GROUP.perMember * (arriving.length + 2)),
    driver,
    covered: [],
    said: [],
    notes: [],
  };
  conv.group = g;
  const p = openPair(world, conv, g, a, b, false);
  g.floor = p.key;
  return g;
}

/** Two of them start talking to each other: the two-person engine plans it (from what each knows, with the others listening). */
function openPair(world: WorldState, conv: Conversation, g: GroupState, a: Citizen, b: Citizen, inGroup: boolean): GroupPair {
  const n = g.pairs.filter((x) => (x.a === a.id && x.b === b.id) || (x.a === b.id && x.b === a.id)).length;
  const p: GroupPair = { key: `${a.id}|${b.id}${n ? `#${n}` : ""}`, a: a.id, b: b.id, lines: [], dlg: null as never, done: false };
  const view = pairView(conv, p);
  p.dlg = beginDialogue(world, view, a, b);
  p.dlg.inGroup = inGroup;
  trimAgenda(g, p);
  g.pairs.push(p);
  return p;
}

/** Nothing already said in front of everyone, nothing about someone standing right there, nothing private. */
function trimAgenda(g: GroupState, p: GroupPair): void {
  const crowd = g.present.length + g.arriving.length > 2;
  for (const id of Object.keys(p.dlg.agenda)) {
    p.dlg.agenda[id] = (p.dlg.agenda[id] ?? []).filter((t) => {
      if (g.covered.includes(t.key)) return false;
      if ((t.kind === "gossip" || t.key.startsWith("nearby:")) && t.about && (g.present.includes(t.about) || g.arriving.some((x) => x.who === t.about))) return false;
      if (crowd && t.sensitive >= 0.65 && !["news", "shared"].includes(t.kind)) return false;
      return true;
    });
  }
}

// ------------------------------------------------------------ the scheduler

/** Who speaks next, to whom, and why (null: it's over). Assumes everyone in `present` and `arriving` can still talk. */
export function planGroupTurn(world: WorldState, conv: Conversation): GroupPlan | null {
  const g = conv.group;
  if (!g || g.ended) return null;
  const n = conv.lines.length;
  const here = g.present.map((id) => world.citizens[id]).filter(Boolean);
  const plan = (x: Omit<GroupPlan, "at">): GroupPlan => ({ ...x, at: n });

  // 1. Someone's going: one of the others answers.
  if (g.leaving) {
    const leaver = world.citizens[g.leaving.who];
    const others = here.filter((c) => c.id !== g.leaving!.who);
    if (!leaver || !others.length) return null;
    const by = [...others].sort((x, y) => (y.relationships[leaver.id]?.affinity ?? 0) - (x.relationships[leaver.id]?.affinity ?? 0))[0];
    return plan({ speaker: by.id, to: leaver.id, move: "farewell", all: g.leaving.all, hint: g.leaving.all ? `Everyone's going their separate ways. Say bye.` : `${leaver.name} is off. Say bye to them, your way.`, why: `${leaver.name} said goodbye` });
  }
  if (here.length < 2 && !g.arriving.length) return null;

  // 2. Someone's come over: hello, everyone (one at a time: the last one gets an answer first).
  let lastJoin = -9;
  for (let i = g.turns.length - 1; i >= 0; i--) if (g.turns[i].move === "join") {
    lastJoin = i;
    break;
  }
  const arr = n - lastJoin >= 3 && !(g.turns[n - 1]?.asks && n - (g.arriving[0]?.after ?? n) < 3) ? g.arriving.find((x) => x.after <= n) : undefined;
  if (arr) {
    const joiner = world.citizens[arr.who];
    g.arriving = g.arriving.filter((x) => x !== arr);
    if (joiner && here.length >= 1 && g.present.length < GROUP.maxSize) {
      const best = [...here].sort((x, y) => know(joiner, y) - know(joiner, x))[0];
      const p = pairOf(g, joiner.id, best.id) ?? openPair(world, conv, g, joiner, best, false);
      const d = p.dlg.turns.length === 0 ? planTurn(world, pairView(conv, p), joiner.id) : null;
      const names = firstNames(world, here.map((c) => c.id));
      return plan({ speaker: joiner.id, to: null, move: "join", pair: d ? p.key : undefined, d: d ?? undefined, hint: `You've just come over to ${names}, who are talking. Say hello to them${d ? `, then: ${d.hint}` : "."}`, why: `came over (knows ${best.name} best)` });
    }
  }
  if (here.length < 2) return null;

  const lastTurn = g.turns[n - 1];
  const lastPair = lastTurn?.pair ? g.pairs.find((x) => x.key === lastTurn.pair) : undefined;
  const saidBye = !!lastPair && lastTurn?.at !== undefined && !!lastPair.dlg.turns[lastTurn.at]?.bye;

  // Long enough: someone starts the goodbyes (once any question or goodbye has had its answer).
  if (n >= g.maxLines && !lastTurn?.asks && !saidBye) return wrapUp(world, conv, g, here, n, "it's gone on long enough");

  // 3. Someone has to be somewhere else.
  // (Nobody walks off while a question's waiting for its answer, or straight after someone else has.)
  let lastLeave = -9;
  for (let i = g.turns.length - 1; i >= 0; i--) if (g.turns[i].move === "farewell") {
    lastLeave = i;
    break;
  }
  // (Nor when someone's just said goodbye: that gets its answer first.)
  for (const c of lastTurn?.asks || saidBye || n < 4 || n - lastLeave < 4 ? [] : here) {
    const why = mustGo(world, g, c);
    if (why) return plan({ speaker: c.id, to: null, move: "leave", all: here.length <= 2, hint: `You need to get going (${why}). Say goodbye to everyone, your way.`, why });
  }

  // 4. A bystander has something to say about what's just been said.
  const ch = chimeIn(world, conv, g, here, n);
  if (ch) return plan(ch);

  // (Someone on their way over counts: nobody says goodbye just as a friend walks up.)
  const crowd = here.length + g.arriving.length > 2;

  // 5. The pair with the floor carries on.
  let fp = g.floor ? g.pairs.find((p) => p.key === g.floor && !p.done) : undefined;
  if (fp && (!g.present.includes(fp.a) || !g.present.includes(fp.b))) {
    fp.done = true;
    fp = undefined;
  }
  if (fp) {
    const view = pairView(conv, fp);
    const sp = whoseTurn(view);
    const other = sp === fp.a ? fp.b : fp.a;
    let run = 0;
    for (let i = g.turns.length - 1; i >= 0 && g.turns[i].pair === fp.key; i--) run++;
    const r = rngFor(world, conv, sp, `floor${n}`);
    const hanging = !!lastTurn?.asks;
    const others = here.filter((c) => c.id !== fp!.a && c.id !== fp!.b);
    const steal = !hanging && others.length > 0 && run >= GROUP.floorRun && rand(r) < 0.3 + (run - GROUP.floorRun) * 0.12;
    if (!steal) {
      const d = planTurn(world, view, sp);
      // A goodbye always gets its answer (and with just the two of them, that's the end: nobody else is coming now).
      if (d && d.move === "byeback") {
        if (here.length <= 2) g.arriving = [];
        return plan({ speaker: sp, to: other, move: "pair", pair: fp.key, d, hint: d.hint, why: "said bye back" });
      }
      if (d && !(d.bye && crowd)) return plan({ speaker: sp, to: other, move: "pair", pair: fp.key, d, hint: d.hint, why: lastTurn?.to === sp && lastTurn.asks ? "was asked something" : "their turn" });
      // Between the two of them, it's run its course (in a group nobody says goodbye just to one person).
      fp.done = true;
      if (!crowd && fp.dlg.turns.some((t) => t.bye)) return null;
      if (d?.bye && here.length > 2 && rand(r) < 0.35 && !hasMoreToSay(world, conv, g, world.citizens[sp], here)) return plan({ speaker: sp, to: null, move: "leave", hint: `You've said what you had to say. Say goodbye to everyone and go.`, why: "done talking" });
    }
  }

  // 6. Whoever has most to say turns to someone (someone new, if they've taken over).
  const next = newFloor(world, conv, g, here, n, fp && !fp.done ? fp.key : undefined);
  if (next) return plan(next);

  // 7. Nothing left to say.
  return wrapUp(world, conv, g, here, n, "nobody had anything more to say");
}

function know(c: Citizen, o: Citizen): number {
  const r = c.relationships[o.id];
  return (r?.affinity ?? 0) + (r?.familiarity ?? 0) + (c.family.includes(o.id) ? 50 : 0);
}

/** How long this person is happy to stand and talk (game minutes). */
function stayFor(c: Citizen): number {
  const p = profileOf(c);
  const [lo, hi] = GROUP.stay;
  return lo + (hi - lo) * Math.min(1, p.patience * 0.45 + c.personality.big5.extraversion * 0.4 + p.verbosity * 0.25);
}

function mustGo(world: WorldState, g: GroupState, c: Citizen): string | null {
  if (c.needs.energy < 10) return "you're shattered";
  if (c.needs.hunger < 10) return "you're starving";
  const since = world.time - (g.joinedT?.[c.id] ?? world.time);
  if (since > stayFor(c) && g.present.length > 2) return "you've been stood here long enough";
  return null;
}

/** Whether they'd still have something to say to someone else here. */
function hasMoreToSay(world: WorldState, conv: Conversation, g: GroupState, c: Citizen, here: Citizen[]): boolean {
  return here.some((o) => o.id !== c.id && !talked(g, c.id, o.id) && know(c, o) > 25);
}

function wrapUp(world: WorldState, conv: Conversation, g: GroupState, here: Citizen[], n: number, why: string): GroupPlan | null {
  if (!g.turns.length) return null;
  // Whoever's been there longest, or has least patience for standing about.
  const by = [...here].sort((x, y) => world.time - (g.joinedT?.[y.id] ?? 0) - stayFor(y) - (world.time - (g.joinedT?.[x.id] ?? 0) - stayFor(x)))[0];
  return { speaker: by.id, to: null, move: "leave", all: true, hint: "It's time to go. Say goodbye to everyone, your way.", why, at: n };
}

/** Someone takes the floor: whoever's keenest to speak, to whoever they most want to talk to (about something they haven't covered). */
function newFloor(world: WorldState, conv: Conversation, g: GroupState, here: Citizen[], n: number, avoid?: string): Omit<GroupPlan, "at"> | null {
  const lastSpoke = (id: CitizenId) => {
    for (let i = g.turns.length - 1; i >= 0; i--) if (g.turns[i].speaker === id) return i;
    return -4;
  };
  const drive = (c: Citizen) => {
    const r = rngFor(world, conv, c.id, `drive${n}`);
    const p = profileOf(c);
    return 0.2 + c.personality.big5.extraversion * 0.4 + p.verbosity * 0.2 + Math.min(1, (n - lastSpoke(c.id)) / 6) * 0.5 + rand(r) * 0.25;
  };
  const keen = [...here].map((c) => ({ c, v: drive(c) })).sort((x, y) => y.v - x.v);
  for (const { c } of keen.slice(0, 3)) {
    const r = rngFor(world, conv, c.id, `want${n}`);
    const targets = here
      .filter((o) => o.id !== c.id)
      .map((o) => ({ o, v: know(c, o) / 100 + (talked(g, c.id, o.id) ? 0 : 0.35) + rand(r) * 0.3 }))
      .sort((x, y) => y.v - x.v);
    for (const { o } of targets.slice(0, 2)) {
      let p = pairOf(g, c.id, o.id);
      if (p && p.key === avoid) continue;
      // An exchange they'd left off: picked up where it was if it's fresh (or a question's hanging), otherwise it's done with.
      if (p && !p.done) {
        let last = -1;
        for (let i = g.turns.length - 1; i >= 0; i--) if (g.turns[i].pair === p.key) {
          last = i;
          break;
        }
        const hanging = p.dlg.turns[p.dlg.turns.length - 1]?.asks;
        if (!hanging && n - last > 3) p.done = true;
      }
      if (!p || p.done) {
        // (Two goes each at most: then they've said what they had to say to each other.)
        if (g.pairs.filter((x) => (x.a === c.id && x.b === o.id) || (x.a === o.id && x.b === c.id)).length >= 2) continue;
        p = openPair(world, conv, g, c, o, true);
        if (p.dlg.mode === "fail" || !(p.dlg.agenda[c.id] ?? []).length) {
          p.done = true;
          continue;
        }
      } else trimAgenda(g, p);
      const view = pairView(conv, p);
      const sp = whoseTurn(view);
      const d = planTurn(world, view, sp);
      if (!d || d.bye) {
        p.done = true;
        continue;
      }
      return { speaker: sp, to: sp === p.a ? p.b : p.a, move: "pair", pair: p.key, d, hint: d.hint, why: sp === c.id ? `had something to say to ${o.name}` : `picked up with ${world.citizens[sp === p.a ? p.b : p.a]?.name}` };
    }
  }
  return null;
}

// ------------------------------------------------------------ chipping in

/** Something on the table that someone else here has a stake in. */
function chimeIn(world: WorldState, conv: Conversation, g: GroupState, here: Citizen[], n: number): Omit<GroupPlan, "at"> | null {
  const t = g.table;
  if (!t) return null;
  const since = n - 1 - t.line;
  if (since > 2 || !g.present.includes(t.by)) {
    g.table = null;
    return null;
  }
  const last = g.turns[n - 1];
  // A question waits for its answer (only the impulsive butt in, right away).
  if (since >= 1 && last?.asks) return null;
  const hot = (t.kind === "news" && (happeningById(world, t.happening ?? -1)?.scale ?? 0) >= 2) || t.kind === "gossip";
  if (t.chimed.length >= (hot ? 2 : 1)) return null;
  const teller = world.citizens[t.by];
  if (!teller) return null;
  const options: { c: Citizen; ch: Chime; score: number }[] = [];
  for (const c of here) {
    if (c.id === t.by || c.id === t.to || t.chimed.includes(c.id)) continue;
    const ch = stanceOn(world, c, teller, t);
    if (!ch) continue;
    const p = profileOf(c);
    // Straight in, before the other has answered: only the impulsive.
    if (since === 0 && p.impulsiveness < 0.6) continue;
    options.push({ c, ch: ch.chime, score: ch.score * (since === 0 ? p.impulsiveness * 0.6 : 1) });
  }
  options.sort((x, y) => y.score - x.score);
  const best = options[0];
  if (!best) return null;
  const r = rngFor(world, conv, best.c.id, `chime${n}`);
  if (rand(r) >= best.score) return null;
  const subject = t.about ? world.citizens[t.about]?.name : null;
  return {
    speaker: best.c.id,
    to: t.by,
    move: "chime",
    chime: best.ch,
    hint: chimeHint(world, best.c, teller, t, best.ch, subject ?? null),
    why: `${since === 0 ? "butted in" : "chipped in"}: ${best.ch.kind}`,
  };
}

/** How a bystander takes what's just been said, and how keen they are to say so. */
function stanceOn(world: WorldState, c: Citizen, teller: Citizen, t: GroupTable): { chime: Chime; score: number } | null {
  const p = profileOf(c);
  const b5 = c.personality.big5;
  const S = teller.name;
  const toTeller = c.relationships[teller.id]?.affinity ?? 0;
  if (t.kind === "news" || t.kind === "shared") {
    const h = t.happening !== undefined ? happeningById(world, t.happening) : undefined;
    if (!h) return null;
    if (h.subject === c.id) {
      return h.tone < 0
        ? { chime: { kind: "it was me", negative: true, believes: true, pool: ["Don't remind me.", "Yeah. That was me. Still not over it.", "I'd rather not talk about it, if that's alright.", "It's been a nightmare, honestly."] }, score: 0.75 }
        : { chime: { kind: "it was me", negative: false, believes: true, pool: ["That was me, actually!", "Can't quite believe it myself.", "Still pinching myself, to be honest.", "Yep. Me. Mad, isn't it."] }, score: 0.8 };
    }
    if (knows(c, h.id)) return { chime: { kind: "heard already", negative: h.tone < 0, believes: true, pool: ["I heard about that.", "It's all anyone's talking about.", "Yeah, I heard that earlier.", "Heard that too. Mad."] }, score: 0.25 + p.gossip * 0.35 };
    const pool = h.tone < -0.2 ? ["God, that's awful.", "That's terrible.", "No. Really?", "Oh, that's grim."] : h.tone > 0.2 ? ["No way!", "Good for them.", "Well, I never.", "That's brilliant, that."] : ["Really?", "First I've heard of it.", "Huh. News to me."];
    return { chime: { kind: "news to me", negative: h.tone < -0.2, believes: true, pool }, score: 0.2 + p.curiosity * 0.25 + p.gossip * 0.25 };
  }
  if (t.kind === "gossip" && t.about) {
    const Q = world.citizens[t.about];
    if (!Q) return null;
    const q = Q.name;
    const toQ = c.relationships[Q.id]?.affinity ?? 0;
    const family = c.family.includes(Q.id);
    const f = t.fact !== undefined ? factById(teller, t.fact) : undefined;
    const heard = !!f && talkOf(c).facts.some((x) => x.key === f.key);
    if (toQ > 40 || family) {
      return {
        chime: { kind: `stuck up for ${q}`, negative: true, believes: false, pool: [`Come off it, that doesn't sound like ${q}.`, `I'd want to hear ${q}'s side first.`, `Leave ${q} alone, ${S}.`, `${q}'s alright. Don't believe everything you hear.`, `That's not fair on ${q}.`], note: { about: teller.id, affinity: -4, trust: -3, why: `talking about ${q} behind their back` } },
        score: 0.3 + (Math.max(toQ, family ? 60 : 0) / 100) * 0.5 + p.bluntness * 0.2,
      };
    }
    if (toQ < -20) {
      return {
        chime: { kind: `piled in on ${q}`, negative: true, believes: true, pool: ["Doesn't surprise me one bit.", `Typical ${q}.`, `Sounds about right for ${q}.`, `I've always said ${q} was trouble.`, "Told you, didn't I?"], note: { about: teller.id, affinity: 3, trust: 1, why: `agreeing about ${q}` } },
        score: 0.25 + p.gossip * 0.35 + (1 - b5.agreeableness) * 0.2 + Math.min(0.3, -toQ / 200),
      };
    }
    if (heard) return { chime: { kind: "heard it too", negative: false, believes: true, pool: ["I heard that too.", "Yeah, I'd heard something like that.", "Same thing I heard."] }, score: 0.2 + p.gossip * 0.3 };
    return { chime: { kind: "surprised", negative: false, believes: true, pool: [`${q}? Never.`, `Not ${q}.`, `Well, you learn something new.`] }, score: 0.12 + p.gossip * 0.3 };
  }
  if (t.kind === "disagreement") return b5.agreeableness > 0.55 ? { chime: { kind: "peacemaker", negative: false, believes: true, pool: ["Alright, you two, leave it.", "Can we not do this here?", "Come on, it's not worth it."] }, score: 0.2 + b5.agreeableness * 0.3 } : null;
  // The teller's own life: good news, troubles, plans.
  if (t.about !== teller.id) return null;
  if (t.kind === "brag" || (t.kind === "work" && t.valence > 0.3)) {
    const envy = feelingsToward(c, teller.id).envy ?? 0;
    const rival = (c.relationships[teller.id]?.roles ?? []).includes("rival");
    if (envy > 25 || rival || toTeller < -15) return { chime: { kind: "sour", negative: true, believes: true, pool: ["Alright, no need to rub it in.", "Some of us have to work for a living.", "Here we go.", `Yes, we know, ${S}.`], note: { about: teller.id, affinity: -2, trust: 0, why: "a dig in front of everyone" } }, score: 0.2 + envy / 120 + p.sarcasm * 0.3 };
    if (toTeller > 25) return { chime: { kind: "pleased", negative: false, believes: true, pool: [`Good on you, ${S}!`, "Get you!", `About time something went right for you, ${S}.`, "That's brilliant."], note: { about: teller.id, affinity: 2, trust: 1, why: "pleased for them" } }, score: 0.15 + p.warmth * 0.35 };
    return null;
  }
  // A pet hate: anyone who shares it can't resist.
  if (t.key.startsWith("dislike:")) {
    const what = t.key.slice(8).split(":")[0];
    return c.personality.dislikes.includes(what as never) ? { chime: { kind: "same pet hate", negative: true, believes: true, pool: ["Don't get me started.", "Oh, don't. Same.", "God, yes.", `You and me both, ${S}.`] }, score: 0.35 + p.impulsiveness * 0.2 } : null;
  }
  if (t.kind === "complain" || t.kind === "problem" || (t.kind === "disclose" && t.valence < -0.2)) {
    if (toTeller > 20 && p.empathy > 0.45) return { chime: { kind: "sympathy", negative: true, believes: true, pool: [`That's rough, ${S}.`, "You'll be alright.", "Here if you need anything.", "That's not on, that.", "Poor you."], note: { about: teller.id, affinity: 2, trust: 2, why: "sympathy" } }, score: 0.15 + p.empathy * 0.35 + toTeller / 300 };
    if (p.teasing > 0.55 && toTeller > 30) return { chime: { kind: "teased", negative: false, believes: true, pool: ["Cheer up, it might never happen.", "Violins at the ready.", "Oh, the drama."] }, score: 0.1 + p.teasing * 0.25 };
    if (c.rentArrears > 0 || c.emotions.sadness > 40) return { chime: { kind: "same here", negative: true, believes: true, pool: ["Tell me about it.", "Same here.", "You're not the only one.", "Join the club."] }, score: 0.15 + p.selfFocus * 0.25 };
    return null;
  }
  if (t.kind === "plan") {
    if (toTeller > 15) return { chime: { kind: "encouraged", negative: false, believes: true, pool: ["Ooh, keep us posted.", "Go for it.", "Good luck with that, honestly.", "Let us know how it goes."] }, score: 0.1 + p.warmth * 0.3 };
    if (toTeller < -15 && p.sarcasm > 0.4) return { chime: { kind: "doubtful", negative: true, believes: true, pool: ["Good luck with that.", "I'll believe it when I see it.", "Rather you than me."], note: { about: teller.id, affinity: -2, trust: 0, why: "doubted them in front of everyone" } }, score: 0.1 + p.sarcasm * 0.3 };
  }
  return null;
}

function chimeHint(world: WorldState, c: Citizen, teller: Citizen, t: GroupTable, ch: Chime, subject: string | null): string {
  const what = `${teller.name} just said something about ${t.label}${t.to ? ` to ${world.citizens[t.to]?.name}` : ""}.`;
  const how: Record<string, string> = {
    "it was me": "It's about you, and you're standing right here.",
    "heard already": "You'd already heard.",
    "news to me": "It's news to you.",
    "heard it too": "You'd heard the same.",
    surprised: `You wouldn't have thought it of ${subject}.`,
    sour: `You're sick of hearing how well ${teller.name}'s doing.`,
    pleased: `You're pleased for ${teller.name}.`,
    sympathy: `You feel for ${teller.name}.`,
    teased: `You can't resist a dig at ${teller.name}.`,
    "same here": "You've got troubles of your own.",
    encouraged: `You're behind ${teller.name} on this.`,
    doubtful: "You don't think it'll come to much.",
    peacemaker: "You'd rather they didn't fall out.",
    "same pet hate": "It drives you mad too.",
  };
  const stance = ch.kind.startsWith("stuck up for") ? `You like ${subject} and don't believe it.` : ch.kind.startsWith("piled in") ? `You've no time for ${subject} and it doesn't surprise you.` : (how[ch.kind] ?? "");
  return `${what} ${stance} Chip in briefly, your way (a few words is fine).`;
}

// ------------------------------------------------------------ in words

const HELLO = {
  two: () => [`Alright, you two?`, `Hello, you two.`, `Mind if I join you?`, `What are you two plotting?`, `Room for one more?`],
  more: () => [`Alright, you lot?`, `Evening, all.`, `Mind if I join you?`, `Room for one more?`, `Hello, everyone.`, `What's all this, then?`],
};

/** A newcomer's hello to everyone. */
function helloAll(world: WorldState, me: Citizen, others: Citizen[], r: RngHolder): string {
  const pool = (others.length >= 3 ? HELLO.more : HELLO.two)().filter((x) => !/^Evening/.test(x) || (world.time % 1440) / 60 >= 17);
  return pickFor(world, me, r, `group:hello:${others.length >= 3 ? "more" : "two"}`, pool);
}

function leaveLine(world: WorldState, me: Citizen, others: Citizen[], all: boolean, r: RngHolder): string {
  const two = others.length === 1;
  const n = others[0]?.name ?? "";
  const pool = two
    ? [`Right, I'd better be off. See you, ${n}.`, `I'll leave you to it. Bye, ${n}.`, "Anyway, I'd better get going. See you.", `Must dash. Take care, ${n}.`]
    : all
      ? ["Right, I'd better be off. See you all.", "Anyway, I need to get going. Bye, all.", "I'll leave you lot to it. See you.", "Right, that's me. See you later, everyone."]
      : ["Right, I'd better be off. See you all.", "I'll leave you to it. Bye, all.", "That's me, I'm afraid. See you later.", "I need to get going. Don't do anything I wouldn't."];
  return pickFor(world, me, r, `group:leave:${two ? "two" : all ? "all" : "some"}`, pool);
}

function farewellLine(world: WorldState, me: Citizen, them: Citizen, all: boolean, r: RngHolder): string {
  const close = (me.relationships[them.id]?.affinity ?? 0) > 40;
  const pool = all ? ["See you.", "Bye, all.", "Take care.", "See you later."] : close ? [`See you, ${them.name}.`, "Take care, you.", `Bye, ${them.name}!`, "Don't be a stranger."] : [`See you, ${them.name}.`, "Bye.", "See you later.", "Take care."];
  return pickFor(world, me, r, `group:bye:${all ? "all" : close ? "close" : "plain"}`, pool);
}

/** The line in words, without a model. */
export function builtInGroupTurn(world: WorldState, conv: Conversation, plan: GroupPlan): { text: string; meta?: TurnMeta; extras?: Parameters<typeof recordLine>[6] } {
  const g = conv.group!;
  const me = world.citizens[plan.speaker];
  const them = plan.to ? world.citizens[plan.to] : null;
  const r = rngFor(world, conv, me.id, `g${plan.at}`);
  const p = plan.pair ? g.pairs.find((x) => x.key === plan.pair) : undefined;
  if (plan.move === "pair" && p && plan.d) return builtInTurn(world, pairView(conv, p), plan.speaker, plan.d);
  sayingIn(g.said);
  try {
    if (plan.move === "join") {
      const others = g.present.filter((id) => id !== me.id).map((id) => world.citizens[id]);
      const hello = helloAll(world, me, others, r);
      if (!p || !plan.d) return { text: hello };
      const t = builtInTurn(world, pairView(conv, p), plan.speaker, plan.d);
      // "Mind if I join you? Alright, Mei? How's things?" (not two hellos in a row).
      const text = /^(Hello|Hi|Hiya|Alright|Hey|Morning|Evening)\b[^?]*[.!]$/.test(t.text) ? `${hello} ${t.text.replace(/^(Hello|Hi|Hiya|Hey)[.!]\s*/, "")}`.trim() : `${hello} ${t.text}`;
      return { ...t, text };
    }
    if (plan.move === "chime" && plan.chime && them) {
      const raw = pickFor(world, me, r, `group:chime:${plan.chime.kind}`, plan.chime.pool);
      return { text: voiced(world, me, them, raw, { move: "react", rel: relView(world, me, them), stress: stressOf(me), negative: plan.chime.negative }, r) };
    }
    if (plan.move === "leave") {
      const others = g.present.filter((id) => id !== me.id).map((id) => world.citizens[id]);
      return { text: leaveLine(world, me, others, !!plan.all, r) };
    }
    if (plan.move === "farewell" && them) return { text: farewellLine(world, me, them, !!plan.all && g.present.length > 2, r) };
    return { text: "Right." };
  } finally {
    sayingIn(null);
  }
}

/**
 * Add a line to the group conversation and move it on. Returns who's just
 * joined (to lock into the conversation) and who's just gone (to release).
 */
export function recordGroupLine(world: WorldState, conv: Conversation, plan: GroupPlan, text: string, by: "llm" | "built-in", meta?: TurnMeta, extras?: Parameters<typeof recordLine>[6]): { joined: CitizenId | null; gone: CitizenId[]; over: boolean } {
  const g = conv.group!;
  const out = { joined: null as CitizenId | null, gone: [] as CitizenId[], over: false };
  if (plan.move === "join" && !g.present.includes(plan.speaker)) {
    g.present.push(plan.speaker);
    if (!g.members.includes(plan.speaker)) g.members.push(plan.speaker);
    (g.joinedT ??= {})[plan.speaker] = world.time;
    out.joined = plan.speaker;
  }
  const heard = [...g.present];
  conv.lines.push({ speaker: plan.speaker, text, to: plan.to });
  const p = plan.pair ? g.pairs.find((x) => x.key === plan.pair) : undefined;
  let at: number | undefined;
  let about: string | undefined;
  if (p && plan.d && meta) {
    const view = pairView(conv, p);
    const before = p.dlg.learned.length;
    recordLine(world, view, plan.speaker, plan.d, text, { ...meta, by }, extras);
    at = p.dlg.turns.length - 1;
    // Everyone else heard it too (what's said in front of a group isn't a confidence).
    for (const l of p.dlg.learned.slice(before)) {
      for (const id of heard) {
        if (id === l.who || id === l.about || id === plan.speaker || l.confidential) continue;
        p.dlg.learned.push({ ...l, who: id });
      }
    }
    g.floor = p.key;
    const t = plan.d.topic;
    if (t) {
      if (!g.covered.includes(t.key)) g.covered.push(t.key);
      about = t.label;
      if (plan.d.move === "raise" && TABLE_KINDS.has(t.kind)) g.table = { by: plan.speaker, to: plan.to, line: conv.lines.length - 1, kind: t.kind, key: t.key, about: t.about, valence: t.valence, label: t.label, happening: t.happening, fact: t.fact, chimed: [] };
      else if (plan.d.move === "raise") g.table = null;
    }
  }
  if (plan.move === "chime" && plan.chime) {
    about = plan.chime.kind;
    g.table?.chimed.push(plan.speaker);
    if (plan.chime.note) g.notes.push({ who: plan.speaker, ...plan.chime.note });
    // Someone who's sure it isn't true says so: the teller takes note.
    if (!plan.chime.believes && plan.to && g.table?.about) g.notes.push({ who: plan.to, about: plan.speaker, affinity: -1, trust: 0, why: `stuck up for ${world.citizens[g.table.about]?.name}` });
  }
  g.turns.push({ speaker: plan.speaker, to: plan.to, move: plan.move, pair: p?.key, at, by, asks: asksSomething(text), heard, about, why: plan.why });
  if (plan.move === "leave") g.leaving = { who: plan.speaker, all: !!plan.all || g.present.length <= 2 };
  if (plan.move === "farewell" && g.leaving) {
    const leaver = g.leaving.who;
    const gone = g.leaving.all ? [...g.present] : [leaver];
    for (const id of gone) {
      g.present = g.present.filter((x) => x !== id);
      g.left.push({ who: id, line: conv.lines.length - 1, why: g.leaving.all ? "broke up" : (g.turns.find((x, i) => i >= g.turns.length - 3 && x.speaker === leaver && x.move === "leave")?.why ?? "left") });
      for (const pp of g.pairs) if (pp.a === id || pp.b === id) pp.done = true;
    }
    out.gone = gone;
    g.leaving = null;
    if (g.present.length < 2 && !g.arriving.length) {
      g.ended = true;
      out.over = true;
      // Whoever's left on their own goes too.
      out.gone.push(...g.present);
      g.present = [];
    }
  }
  return out;
}

// ------------------------------------------------------------ with a model

/** The pair view a prompt is built from: that pair's state, with the whole group's transcript. */
function promptView(conv: Conversation, p: GroupPair): Conversation {
  return pairView(conv, p, conv.lines);
}

/** Someone they'd be talking to, for a group line (the one it's said to, or whoever they know best here). */
function companion(world: WorldState, g: GroupState, plan: GroupPlan): Citizen {
  const me = world.citizens[plan.speaker];
  if (plan.to && world.citizens[plan.to]) return world.citizens[plan.to];
  const others = g.present.filter((id) => id !== me.id).map((id) => world.citizens[id]);
  return [...others].sort((x, y) => know(me, y) - know(me, x))[0] ?? me;
}

/** The line as a prompt: the speaker's own context, the group's transcript, and what they mean to do. */
export function groupRequest(world: WorldState, conv: Conversation, plan: GroupPlan, small: boolean): ModelRequest {
  const g = conv.group!;
  const me = world.citizens[plan.speaker];
  const them = companion(world, g, plan);
  let p = plan.pair ? g.pairs.find((x) => x.key === plan.pair) : pairOf(g, me.id, them.id);
  if (!p) p = g.pairs.find((x) => x.a === me.id || x.b === me.id) ?? g.pairs[0];
  const d: Directive = plan.d && (plan.move === "pair" || plan.move === "join") ? { ...plan.d, hint: plan.move === "join" ? plan.hint : plan.d.hint } : groupDirective(world, me, them, plan);
  // A pair view with this person as one of the two (so their context, not someone else's, is used).
  const view = p.a === me.id || p.b === me.id ? promptView(conv, p) : { ...promptView(conv, p), a: me.id, b: them.id };
  return modelRequest(world, view, me.id, d, small);
}

function groupDirective(world: WorldState, me: Citizen, them: Citizen, plan: GroupPlan): Directive {
  return { move: plan.move === "chime" ? "react" : plan.move === "farewell" ? "byeback" : "close", topic: null, intent: plan.move === "chime" ? "pass time" : "get away", reply: null, askBack: null, length: "short", bye: plan.move !== "chime", rel: relView(world, me, them), hint: plan.hint };
}

/** Check a model's reply for a group line: the words (and, in a pair's exchange, what it did), or why it was turned down. */
export function readGroupTurn(world: WorldState, conv: Conversation, plan: GroupPlan, reply: unknown, given: string): { text: string; meta?: TurnMeta; extras?: Parameters<typeof recordLine>[6] } | { error: string } {
  const g = conv.group!;
  const me = world.citizens[plan.speaker];
  const them = companion(world, g, plan);
  const j = (reply ?? {}) as { spoken?: unknown; line?: unknown };
  let raw = typeof j.spoken === "string" ? j.spoken : typeof j.line === "string" ? j.line : "";
  // Cut where anyone else here starts talking.
  const names = g.members.map((id) => world.citizens[id]?.name).filter(Boolean).join("|");
  const cut = names ? raw.search(new RegExp(`\\b(${names})\\s*:`, "i")) : -1;
  if (cut > 0) raw = raw.slice(0, cut);
  const p = plan.pair ? g.pairs.find((x) => x.key === plan.pair) : undefined;
  if (p && plan.d) {
    const res = readModelTurn(world, promptView(conv, p), plan.speaker, plan.d, { ...(reply as object), spoken: raw, line: undefined }, given);
    if ("error" in res) return res;
    return res;
  }
  const c = checkLine(world, { ...conv, a: me.id, b: them.id }, me, them, raw, given);
  if (!c.ok) return { error: c.why ?? "rejected" };
  if ((plan.move === "leave" || plan.move === "farewell") && !GOODBYE.test(c.text) && c.text.split(/\s+/).length > 12) return { error: "that's not a goodbye" };
  return { text: c.text };
}
