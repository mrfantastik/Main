import { outstanding } from "../economy/bank";
import { relLabel } from "../social/relationships";
import type { Citizen, CitizenId, WorldState } from "../types";
import { clamp, money } from "../util";
import { TALK } from "./config";
import { talkOf } from "./profile";
import type { Bond, Episode, Thread } from "./types";

// What one person carries about another between conversations: what they've
// talked about lately (and roughly what was said), things they mean to ask
// next time, running jokes, what they make of the other person, recent
// friction, and how the other seemed. Each side keeps its own, so the two
// memories of the same chat needn't match.
//
// Also here: what a relationship *is*, in conversational terms. Not just an
// affinity number: a stranger, a coworker, a close friend, the boss, a rival
// or someone they can't stand, and what that means for how they talk.

export function bondOf(world: WorldState, c: Citizen, other: CitizenId): Bond {
  const t = talkOf(c);
  let b = t.bonds[other];
  if (!b) {
    b = { first: world.time, talks: 0, lastT: 0, episodes: [], history: "", threads: [], jokes: [], opinions: [], topics: [], openers: [], tension: 0, seemed: null };
    t.bonds[other] = b;
    const ids = Object.keys(t.bonds);
    if (ids.length > TALK.bondsKept) {
      ids.sort((x, y) => (t.bonds[x].lastT || t.bonds[x].first) - (t.bonds[y].lastT || t.bonds[y].first));
      for (const id of ids.slice(0, ids.length - TALK.bondsKept)) if (id !== other) delete t.bonds[id];
    }
  }
  return b;
}

export function peekBond(c: Citizen, other: CitizenId): Bond | undefined {
  return c.talk?.bonds[other];
}

/** Remember a conversation; older ones are boiled down into the running history. */
export function addEpisode(c: Citizen, b: Bond, ep: Episode): void {
  b.episodes.push(ep);
  while (b.episodes.length > TALK.episodesKept) {
    const old = b.episodes.shift()!;
    // Keep the gist of the more important ones; let trivial ones go.
    if (old.importance >= 3) b.history = `${b.history} ${old.summary}`.trim();
  }
  if (b.history.length > TALK.historyChars) {
    const parts = b.history.match(/[^.!?]+[.!?]+/g) ?? [b.history];
    while (parts.length > 1 && parts.join(" ").length > TALK.historyChars) parts.shift();
    b.history = parts.join(" ").trim().slice(-TALK.historyChars);
  }
}

/** Something to bring up with them next time (merged with one on the same topic). */
export function addThread(world: WorldState, b: Bond, th: Omit<Thread, "id" | "t">): Thread {
  const same = b.threads.find((x) => x.topic === th.topic || (th.fact !== undefined && x.fact === th.fact));
  if (same) {
    Object.assign(same, { ...th, importance: Math.max(same.importance, th.importance) });
    return same;
  }
  // Unique within the bond, and the same every time the town is replayed.
  let n = 0;
  while (b.threads.some((x) => x.id === world.time * 100 + n)) n++;
  const t: Thread = { ...th, id: world.time * 100 + n, t: world.time };
  b.threads.push(t);
  if (b.threads.length > TALK.threadsPerBond) {
    b.threads.sort((x, y) => y.importance - x.importance);
    b.threads.length = TALK.threadsPerBond;
  }
  return t;
}

/** Threads that are ripe now (it's after the time to ask, and not yet forgotten). */
export function dueThreads(world: WorldState, b: Bond | undefined): Thread[] {
  if (!b) return [];
  return b.threads.filter((t) => world.time >= t.after && world.time <= t.until).sort((x, y) => y.importance - x.importance);
}

export function resolveThread(b: Bond, id: number): void {
  b.threads = b.threads.filter((t) => t.id !== id);
}

/** They talked about this (topic key) just now. */
export function noteTopic(world: WorldState, b: Bond, key: string): void {
  b.topics = b.topics.filter((x) => x.k !== key);
  b.topics.push({ k: key, t: world.time });
  if (b.topics.length > TALK.topicsPerBond) b.topics.shift();
}

/** How recently they went over this topic together (days; Infinity if not lately). */
export function daysSinceTopic(world: WorldState, b: Bond | undefined, key: string): number {
  const x = b?.topics.find((y) => y.k === key);
  return x ? (world.time - x.t) / 1440 : Infinity;
}

export function setOpinion(world: WorldState, b: Bond, key: string, text: string, delta: number): void {
  const o = b.opinions.find((x) => x.key === key);
  if (o) {
    o.v = clamp(o.v + delta, -1, 1);
    o.t = world.time;
    return;
  }
  b.opinions.push({ key, text, v: clamp(delta, -1, 1), t: world.time });
  if (b.opinions.length > TALK.opinionsPerBond) {
    b.opinions.sort((x, y) => Math.abs(y.v) - Math.abs(x.v));
    b.opinions.length = TALK.opinionsPerBond;
  }
}

export function addJoke(world: WorldState, b: Bond, hook: string, line: string): void {
  if (b.jokes.some((j) => j.hook === hook)) return;
  b.jokes.push({ hook, line, t: world.time, uses: 0 });
  if (b.jokes.length > TALK.jokesPerBond) b.jokes.shift();
}

/** Daily: friction fades, stale threads are forgotten, impressions blur. */
export function bondsDaily(world: WorldState, c: Citizen): void {
  for (const b of Object.values(talkOf(c).bonds)) {
    b.tension = Math.round(b.tension * 0.8 * 100) / 100;
    b.threads = b.threads.filter((t) => t.until > world.time);
    for (const o of b.opinions) o.v = Math.round(o.v * 0.985 * 100) / 100;
    b.opinions = b.opinions.filter((o) => Math.abs(o.v) > 0.08);
    if (b.seemed && world.time - b.seemed.t > 5 * 1440) b.seemed = null;
    // Worn-out jokes retire.
    b.jokes = b.jokes.filter((j) => j.uses < 4 && world.time - j.t < 40 * 1440);
  }
}

// --------------------------------------------------------------- relationships

export type RelKind = "stranger" | "acquaintance" | "coworker" | "friendly coworker" | "friend" | "close friend" | "family" | "couple" | "boss" | "staff" | "partner" | "rival" | "dislikes" | "enemy";

export interface RelView {
  kind: RelKind;
  affinity: number;
  trust: number;
  familiarity: number;
  /** 0 strangers .. 1 as close as it gets. */
  closeness: number;
  /** Teasing, swearing, skipping pleasantries: how much they let their guard down. */
  ease: number;
  /** Careful what they say (a boss, a rival, someone they don't trust). */
  guarded: number;
  coworker: boolean;
  /** Money between them (from the speaker's side): what they owe me (+) or I owe them (-), and whether it's overdue. */
  owed: { amount: number; overdue: boolean } | null;
  /** Days since they last talked (Infinity if never). */
  sinceTalk: number;
}

/** Where they work, as a key (CityCorp, or the business that employs or belongs to them). */
export function workplaceKey(world: WorldState, c: Citizen): string | null {
  if (c.occupation === "employee" && c.employerId) return c.employerId;
  const own = c.businessIds.find((id) => world.businesses[id]?.open);
  return own ?? null;
}

/** What `me` and `them` are to each other, from `me`'s side. */
export function relView(world: WorldState, me: Citizen, them: Citizen): RelView {
  const r = me.relationships[them.id];
  const affinity = r?.affinity ?? 0;
  const trust = r?.trust ?? 0;
  const familiarity = r?.familiarity ?? 0;
  const roles = r?.roles ?? [];
  const mine = workplaceKey(world, me);
  const coworker = !!mine && mine === workplaceKey(world, them);
  let kind: RelKind;
  if (me.family.includes(them.id) || roles.includes("family")) kind = "family";
  else if (roles.includes("couple") && affinity > -20) kind = "couple";
  else if (roles.includes("employer")) kind = "boss";
  else if (roles.includes("employee")) kind = "staff";
  else if (roles.includes("partner") || roles.includes("investor") || roles.includes("investee")) kind = affinity >= 35 ? "friend" : "partner";
  else if (affinity <= -45) kind = "enemy";
  else if (roles.includes("rival") && affinity < 20) kind = "rival";
  else if (affinity <= -18) kind = "dislikes";
  else if (affinity >= 62) kind = "close friend";
  else if (affinity >= 30) kind = coworker ? "friendly coworker" : "friend";
  else if (coworker) kind = affinity >= 12 ? "friendly coworker" : "coworker";
  else if (familiarity >= 8) kind = "acquaintance";
  else kind = "stranger";
  const closeness = clamp((affinity + 10) / 90, 0, 1) * clamp(familiarity / 30 + 0.3, 0, 1) + (kind === "family" ? 0.3 : kind === "couple" ? 0.35 : 0);
  const ease = clamp(closeness * 1.1 - (kind === "boss" ? 0.5 : 0) - (kind === "stranger" ? 0.3 : 0), 0, 1);
  const guarded = clamp((kind === "boss" ? 0.6 : 0) + (kind === "rival" ? 0.6 : 0) + (trust < -20 ? 0.4 : 0) + (kind === "stranger" ? 0.3 : 0) + (kind === "enemy" || kind === "dislikes" ? 0.5 : 0) - closeness * 0.4, 0, 1);
  let owed: RelView["owed"] = null;
  for (const l of world.loans) {
    if (l.status !== "active") continue;
    if (l.lender === me.id && l.borrower === them.id) owed = { amount: outstanding(l), overdue: world.time > l.dueT };
    else if (l.lender === them.id && l.borrower === me.id) owed = { amount: -outstanding(l), overdue: world.time > l.dueT };
  }
  const b = me.talk?.bonds[them.id];
  const sinceTalk = b && b.lastT ? (world.time - b.lastT) / 1440 : Infinity;
  return { kind, affinity, trust, familiarity, closeness, ease, guarded, coworker, owed, sinceTalk };
}

/** The relationship in words, as the speaker's own sense of it (for the model): who they are to you and how you talk to them. */
export function relGuide(world: WorldState, me: Citizen, them: Citizen, v: RelView): string[] {
  const n = them.name;
  const work = v.coworker ? (them.employerId === "corp" ? "CityCorp" : world.businesses[workplaceKey(world, them) ?? ""]?.name ?? "work") : null;
  const lines: string[] = [];
  const kindLine: Record<RelKind, string> = {
    stranger: `You don't know ${n}. You're polite enough but brief, and you wouldn't tell a stranger anything personal.`,
    acquaintance: `You know ${n} to say hello to. Friendly small talk; nothing too personal.`,
    coworker: `${n} works with you${work ? ` at ${work}` : ""}. You talk about work and the people there, but you're a bit careful what you say.`,
    "friendly coworker": `${n} works with you${work ? ` at ${work}` : ""} and you get on: you joke about work, moan about it together, and swap gossip about the place.`,
    friend: `${n} is a friend. You're relaxed and informal with them: you tease a bit, say what you think, and tell them what's going on with you.`,
    "close friend": `${n} is one of your closest friends. No pleasantries needed: you take the mick, say exactly what you think, and can tell when they're hiding something.`,
    family: `${n} is family. You talk to them the way you talk to family: frankly, sometimes impatiently, with history behind it.`,
    couple: `You and ${n} are together. Affectionate, teasing, comfortable; you tell each other things you tell nobody else.`,
    boss: `${n} is your boss. You keep it polite and a bit careful, and you don't moan about work to their face.`,
    staff: `${n} works for you. Friendly, but you're the boss and you both know it.`,
    partner: `${n} is a business partner of yours: civil, practical, with money between you.`,
    rival: `${n} is a rival in business. Civil on the surface, competitive underneath; you don't give anything away.`,
    dislikes: `You don't like ${n}. You keep it short and cool and won't pretend to be friends.`,
    enemy: `You can't stand ${n}. You're curt and prickly and quick to take offence.`,
  };
  lines.push(kindLine[v.kind]);
  if (v.trust < -25 && !["enemy", "dislikes"].includes(v.kind)) lines.push(`You don't really trust ${n}.`);
  if (v.owed && v.owed.amount > 0) lines.push(`${n} owes you ${money(v.owed.amount)}${v.owed.overdue ? " and it's overdue" : ""}.`);
  if (v.owed && v.owed.amount < 0) lines.push(`You owe ${n} ${money(-v.owed.amount)}${v.owed.overdue ? ", and you're late paying it back" : ""}.`);
  const b = me.talk?.bonds[them.id];
  if (b && b.tension > 0.35) lines.push(`Things have been a bit tense between you lately.`);
  if (v.sinceTalk !== Infinity && v.sinceTalk > 14) lines.push(`You haven't really spoken in ${v.sinceTalk > 40 ? "months" : "weeks"}.`);
  const op = b?.opinions.filter((o) => Math.abs(o.v) > 0.25).map((o) => (o.v > 0 ? o.text : `not ${o.text}`));
  if (op?.length) lines.push(`What you make of ${n}: ${op.join(", ")}.`);
  return lines;
}

/** Short label for a relationship, for the debug view and summaries. */
export function relKindLabel(world: WorldState, me: Citizen, them: Citizen): string {
  const v = relView(world, me, them);
  return v.kind === "stranger" && me.relationships[them.id] ? relLabel(me.relationships[them.id]).toLowerCase() : v.kind;
}
