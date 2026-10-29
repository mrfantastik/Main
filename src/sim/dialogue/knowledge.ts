import { remember } from "../memory/memory";
import { hashSeed } from "../rng";
import { adjustRel } from "../social/relationships";
import type { Citizen, CitizenId, WorldState } from "../types";
import { clamp } from "../util";
import { TALK } from "./config";
import { cuesOf, mentions } from "./grammar";
import { talkOf } from "./profile";
import type { Fact, FactPred, FactSource } from "./types";

// Private knowledge. The simulation knows everything; a citizen only knows
// what they could: what they lived through, saw, read in the paper, picked up
// at work, or were told. Each fact keeps where it came from, how sure they
// are and how private it is. Passed on, it changes a little each time:
// certainty drops, hedges fall away ("might be leaving" becomes "is
// leaving"), and amounts drift. Things told in confidence can still get out,
// and if the person they're about finds out who let it slip, it costs that
// friendship.

export interface FactInput {
  about: CitizenId | null;
  pred: FactPred;
  key: string;
  text: string;
  source: FactSource;
  from?: CitizenId | null;
  origin?: CitizenId | null;
  certainty?: number;
  sensitivity?: number;
  valence?: number;
  importance?: number;
  when?: number | null;
  confidential?: boolean;
  happening?: number;
  memory?: number;
  cues?: string[];
  hops?: number;
  chain?: CitizenId[];
  rumour?: number;
}

/** How much a fact is worth keeping (the least are forgotten first when there are too many). */
function keepScore(world: WorldState, f: Fact): number {
  const days = (world.time - f.learnedAt) / 1440;
  return f.importance * (0.4 + f.certainty) * (1 + f.sensitivity) / (1 + days * 0.15) + (f.when !== null && f.when > world.time ? 3 : 0);
}

/** Learn something (merged with what they already know about the same thing). */
export function learn(world: WorldState, c: Citizen, input: FactInput): Fact {
  const t = talkOf(c);
  const names = world.citizenOrder.map((id) => world.citizens[id]?.name ?? "");
  const existing = t.facts.find((f) => f.key === input.key);
  if (existing) {
    // Hearing it again firms it up; first-hand beats hearsay.
    const firmer = (input.certainty ?? 0.9) > existing.certainty || rank(input.source) > rank(existing.source);
    if (firmer) {
      existing.text = input.text;
      existing.source = input.source;
      existing.from = input.from ?? null;
      existing.hops = input.hops ?? 0;
      existing.chain = input.chain ?? existing.chain;
    }
    existing.certainty = clamp(Math.max(existing.certainty, input.certainty ?? 0.9) + 0.05, 0, 1);
    existing.learnedAt = world.time;
    if (input.when !== undefined && input.when !== null) existing.when = input.when;
    existing.confidential = existing.confidential || input.confidential;
    return existing;
  }
  const f: Fact = {
    id: t.nextFactId++,
    about: input.about,
    pred: input.pred,
    key: input.key,
    text: input.text,
    cues: input.cues ?? cuesOf(input.text, names),
    source: input.source,
    from: input.from ?? null,
    origin: input.origin ?? input.about,
    certainty: clamp(input.certainty ?? 0.9, 0.05, 1),
    sensitivity: clamp(input.sensitivity ?? 0.2, 0, 1),
    valence: clamp(input.valence ?? 0, -1, 1),
    importance: clamp(input.importance ?? 4, 1, 10),
    learnedAt: world.time,
    when: input.when ?? null,
    hops: input.hops ?? 0,
    told: [],
    ...(input.confidential ? { confidential: true } : {}),
    ...(input.happening !== undefined ? { happening: input.happening } : {}),
    ...(input.memory !== undefined ? { memory: input.memory } : {}),
    ...(input.chain?.length ? { chain: input.chain.slice(-4) } : {}),
    ...(input.rumour !== undefined ? { rumour: input.rumour } : {}),
  };
  t.facts.push(f);
  if (t.facts.length > TALK.maxFacts) {
    let worst = 0;
    for (let i = 1; i < t.facts.length; i++) if (keepScore(world, t.facts[i]) < keepScore(world, t.facts[worst])) worst = i;
    t.facts.splice(worst, 1);
  }
  return f;
}

function rank(s: FactSource): number {
  return { self: 6, saw: 5, work: 4, paper: 4, told: 3, inferred: 2, rumour: 1 }[s];
}

export function factByKey(c: Citizen, key: string): Fact | undefined {
  return talkOf(c).facts.find((f) => f.key === key);
}

export function factById(c: Citizen, id: number): Fact | undefined {
  return talkOf(c).facts.find((f) => f.id === id);
}

/** What they know about someone (most useful first). */
export function factsAbout(world: WorldState, c: Citizen, about: CitizenId, limit = 6): Fact[] {
  return talkOf(c)
    .facts.filter((f) => f.about === about)
    .sort((a, b) => keepScore(world, b) - keepScore(world, a))
    .slice(0, limit);
}

/** How a fact sounds after one more retelling: hedges drop away, "thinking of" becomes "going to", round numbers get rounder. */
export function retold(text: string, hops: number, seed: number): string {
  let t = text;
  if (hops >= 1) {
    t = t
      .replace(/\b(is|are) thinking (of|about) (\w+ing)\b/g, (_, v: string, _o: string, g: string) => `${v} ${g}`)
      .replace(/\bmight (be )?/g, "")
      .replace(/\bmaybe\b\s*/g, "")
      .replace(/\b(is|are) trying to\b/g, "$1 going to");
  }
  if (hops >= 2) {
    // Numbers drift upwards in the telling.
    t = t.replace(/£(\d+)/g, (_, n: string) => {
      const v = Number(n);
      const up = v * (1.2 + ((seed >>> 3) % 5) / 10);
      return `£${up >= 100 ? Math.round(up / 50) * 50 : Math.round(up / 10) * 10}`;
    });
  }
  return t.replace(/\s+/g, " ").trim();
}

/**
 * `teller` tells `listener` something they know. The listener's copy is a
 * little less certain and a little more simplified the further it's
 * travelled. Returns the listener's fact.
 */
/** Called when someone hears a rumour that was started on purpose (see society/). */
let rumourHook: ((world: WorldState, listener: Citizen, f: Fact) => void) | null = null;
export function setRumourHook(fn: typeof rumourHook): void {
  rumourHook = fn;
}

export function tell(world: WorldState, teller: Citizen, listener: Citizen, f: Fact): Fact {
  if (!f.told.includes(listener.id)) f.told.push(listener.id);
  const firstHand = f.about === teller.id;
  const hops = firstHand ? 0 : f.hops + 1;
  const trust = listener.relationships[teller.id]?.trust ?? 0;
  const seed = hashSeed(`${f.key}:${teller.id}:${listener.id}`);
  const certainty = firstHand ? 0.95 : clamp(f.certainty * (0.82 + trust / 1000) - (f.source === "rumour" ? 0.1 : 0), 0.15, 0.95);
  const heardBefore = talkOf(listener).facts.some((x) => x.key === f.key);
  const got = learn(world, listener, {
    about: f.about,
    pred: f.pred,
    key: f.key,
    text: retold(f.text, hops, seed),
    source: firstHand ? "told" : hops >= 2 || f.source === "rumour" ? "rumour" : "told",
    from: teller.id,
    origin: f.origin,
    certainty,
    sensitivity: f.sensitivity,
    valence: f.valence,
    importance: Math.max(1, f.importance - (firstHand ? 0 : 0.5)),
    when: f.when,
    confidential: firstHand ? f.confidential : undefined,
    happening: f.happening,
    memory: f.memory,
    cues: f.cues,
    hops,
    chain: [...(f.chain ?? []), teller.id],
    ...(f.rumour !== undefined ? { rumour: f.rumour } : {}),
  });
  if (f.rumour !== undefined && !heardBefore) rumourHook?.(world, listener, got);
  return got;
}

/** Would they pass this on to this listener? (Discreet people keep confidences; gossips often don't.) */
export function wouldTell(teller: Citizen, f: Fact, listener: Citizen, gossipiness: number, discretion: number): number {
  if (f.about === listener.id) return 0; // you don't gossip to someone about themselves
  const trustIn = (teller.relationships[listener.id]?.trust ?? 0) / 100;
  const close = (teller.relationships[listener.id]?.affinity ?? 0) / 100;
  let w = gossipiness * (0.5 + f.importance / 10) * (0.6 + Math.abs(f.valence) * 0.6) + close * 0.2 + trustIn * 0.15;
  if (f.confidential) w *= Math.max(0.03, 1 - discretion * 1.2) * (0.5 + trustIn);
  else if (f.sensitivity > 0.5) w *= 0.6 + (1 - discretion) * 0.6;
  if (f.told.includes(listener.id)) w = 0;
  return clamp(w, 0, 1);
}

/**
 * After a conversation between `subject` and `other`: if something told in
 * confidence about the subject came up and `other` didn't hear it from the
 * subject, the subject works out who let it slip. Returns the leaker's id.
 */
export function noticeLeak(world: WorldState, subject: Citizen, other: Citizen, said: string): CitizenId | null {
  const mine = talkOf(subject).facts;
  for (const f of talkOf(other).facts) {
    if (f.about !== subject.id || f.from === subject.id || !f.chain?.length) continue;
    // Only what was told in confidence by the subject to someone first.
    const told = mine.find((m) => m.key === f.key) ?? null;
    const confided = f.sensitivity >= 0.6 || told?.confidential;
    if (!confided || !mentions(said, f.cues, Math.min(2, f.cues.length))) continue;
    const leaker = f.chain[0];
    if (!leaker || leaker === subject.id || leaker === other.id && f.chain.length > 1) continue;
    const who = world.citizens[leaker];
    if (!who) continue;
    const key = `leak:${f.key}:${leaker}`;
    if ((subject.cooldowns[key] ?? -1) >= 0) return null;
    subject.cooldowns[key] = world.time;
    adjustRel(world, subject, leaker, { trust: -18, affinity: -10 });
    remember(world, subject, { text: `${who.name} told people what I told them in confidence.`, kind: "betrayal", importance: 7, valence: -0.8, people: [leaker], key: `leaked:${leaker}`, feel: { anger: 18, sadness: 6 } });
    return leaker;
  }
  return null;
}

/** Daily: rumours lose their grip, old trivia is forgotten, plans past their date settle. */
export function factsDaily(world: WorldState, c: Citizen): void {
  const t = talkOf(c);
  for (const f of t.facts) {
    const days = (world.time - f.learnedAt) / 1440;
    if (f.source === "rumour" || f.source === "inferred") f.certainty = clamp(f.certainty - 0.03, 0.05, 1);
    if (days > 12 && f.importance < 5) f.certainty = clamp(f.certainty - 0.05, 0.05, 1);
  }
  t.facts = t.facts.filter((f) => !(f.certainty <= 0.1 && f.importance < 6) && !((world.time - f.learnedAt) / 1440 > 45 && f.importance < 7));
}
