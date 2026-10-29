import { dominantEmotion } from "../mind/emotions";
import { hashSeed, rand, type RngHolder } from "../rng";
import { happeningById } from "../town/happenings";
import { dayOf, hourOf } from "../time";
import type { Citizen, Conversation, WorldState } from "../types";
import { clamp } from "../util";
import { daysSinceTopic, dueThreads, peekBond, type RelView } from "./bonds";
import { wouldTell } from "./knowledge";
import { lifeItems, type LifeItem } from "./life";
import { profileOf, talkOf } from "./profile";
import type { Topic, TopicKind } from "./types";

// What someone might bring up, from their own point of view. Everything here
// comes from what *they* know: their threads with this person, news they've
// heard, gossip they hold, their own life, where they are and what's going
// on around them, what they like, and plain nonsense. Each candidate gets a
// score from who they are (a gossip loves gossip, a guarded person keeps
// their troubles to themselves, a friend asks how the interview went) and
// the relationship. Then a few are drawn at random by score, so they don't
// always pick the weightiest thing: people talk rubbish while their life
// falls apart.

/** Topics about money and work get damped unless something's urgent: they're there because the game tracks them, not because people talk about nothing else. */
const SYSTEMY = new Set<TopicKind>(["work", "brag", "plan", "problem"]);

const MUNDANE: Record<string, { label: string; lines: string[] }> = {
  "the football": { label: "the football", lines: ["football"] },
  cooking: { label: "cooking", lines: ["cooking"] },
  books: { label: "a book", lines: ["book"] },
  gadgets: { label: "gadgets", lines: ["gadget"] },
  coffee: { label: "coffee", lines: ["coffee"] },
  "lie-ins": { label: "lie-ins", lines: ["lie-in"] },
  bargains: { label: "a bargain", lines: ["bargain"] },
  "people-watching": { label: "people-watching", lines: ["people"] },
  "the pub": { label: "the pub", lines: ["pub"] },
  "the park": { label: "the park", lines: ["park"] },
  "quiet nights in": { label: "a quiet night in", lines: ["night in"] },
  "keeping busy": { label: "keeping busy", lines: ["busy"] },
};

const QUIRK_TOPIC: Record<string, string> = {
  "names every pigeon in the park": "the pigeons",
  "talks to their plants": "the plants",
  "never finishes a cup of tea": "tea",
  "keeps receipts for everything": "receipts",
  "re-reads the same paperback": "that paperback",
  "whistles off-key": "whistling",
  "remembers everyone's birthday": "birthdays",
  "can't walk past a bargain": "bargains",
  "always has a mint to offer": "mints",
  "is always ten minutes early": "being early",
};

export interface TopicContext {
  world: WorldState;
  conv: Conversation;
  me: Citizen;
  them: Citizen;
  rel: RelView;
  /** People close enough to overhear (ids). */
  nearby: string[];
}

/** Something from their own life, as a topic to bring up. */
export function lifeTopic(me: Citizen, it: LifeItem, score: number, rel: RelView): Topic {
  const kind = it.kind;
  return { key: it.key, kind, score, label: it.label, intent: kind === "brag" ? "brag" : kind === "complain" ? "vent" : kind === "problem" ? (rel.closeness > 0.5 ? "get advice" : "vent") : kind === "plan" ? "share news" : "pass time", sensitive: it.sensitivity, valence: it.valence, about: me.id, memory: it.memory, detail: { first: it.first, gist: it.gist, ...(it.when !== null ? { when: it.when } : {}), ...(it.follow ? { follow: it.follow } : {}) } };
}

/** Every candidate topic for `me`, scored. */
export function candidates(x: TopicContext): Topic[] {
  const { world, conv, me, them, rel } = x;
  const p = profileOf(me);
  const t = talkOf(me);
  const b = peekBond(me, them.id);
  const out: Topic[] = [];
  const add = (tp: Topic) => out.push(tp);
  const leisure = ["socialize", "eat", "rest", "idle", "talk", "browse", "shop"].includes(me.activity.kind);
  const urgent = (me.rentArrears > 0 ? 0.4 : 0) + (me.homeless ? 0.5 : 0);
  const others = x.nearby.length > 0;

  // ---- things they meant to bring up with this person
  for (const th of dueThreads(world, b)) {
    const kind: TopicKind = th.kind === "owed" ? "owed" : th.kind === "concern" ? "concern" : th.kind === "disagreement" ? "disagreement" : th.kind === "promise" ? "joke" : "followup";
    let score = 0.55 + th.importance / 12;
    if (kind === "owed") score *= 0.4 + p.bluntness * 0.8 + (rel.owed?.overdue ? 0.3 : 0);
    if (kind === "concern") score *= 0.5 + p.empathy * 0.8;
    if (kind === "disagreement") score *= p.confrontation === "avoids" ? 0.2 : p.confrontation === "escalates" ? 0.9 : 0.5;
    add({ key: `thread:${th.topic}`, kind, score, label: th.topic, intent: kind === "owed" ? "confront" : kind === "concern" ? "check on them" : kind === "disagreement" ? "confront" : "find something out", sensitive: kind === "owed" ? 0.6 : 0.3, valence: 0, about: them.id, thread: th.id, fact: th.fact });
  }

  // ---- town news they've heard
  for (const k of me.news) {
    const h = happeningById(world, k.id);
    if (!h || h.subject === me.id) continue;
    const age = (world.time - Math.max(k.t, h.t)) / 60;
    if (age > 60) continue;
    // Not back to the person who told them, or someone they've told already.
    if (k.told.includes(them.id) || k.via === them.id) continue;
    const theirs = h.subject === them.id;
    const both = h.crowd?.includes(me.id) && h.crowd?.includes(them.id);
    // Big news a day old: everyone's heard by now, and they'd assume so.
    // (Or most of the town's already talking about it.)
    const known = world.citizenOrder.reduce((n, id) => n + (world.citizens[id].news.some((kk) => kk.id === h.id) ? 1 : 0), 0) / Math.max(1, world.citizenOrder.length);
    const stale = (h.scale >= 2 && age > 14 ? 0.35 : 1) * (known > 0.6 && age > 3 ? 0.5 : 1);
    const heat = (h.scale / 3) * (1 - age / 60) * (0.6 + Math.abs(k.stance) * 0.5) * (k.told.length >= 4 ? 0.4 : 1) * stale;
    const kind: TopicKind = both ? "shared" : theirs ? "ask" : "news";
    // Hot off the press: the first thing on their lips.
    const score = (theirs ? 0.5 + p.empathy * 0.5 : both ? 0.45 : 0.25 + p.gossip * 0.6) * (0.4 + heat) * (age < 3 && h.scale >= 2 ? 1.4 : 1);
    add({ key: `news:${h.id}`, kind, score, label: h.about, intent: theirs ? "check on them" : both ? "pass time" : "share news", sensitive: 0.05, valence: h.tone, about: h.subject, happening: h.id });
  }

  // ---- gossip they hold (about someone else)
  for (const f of t.facts) {
    if (f.about === me.id || f.about === null) continue;
    if (f.about === them.id) {
      // Something they've heard about the person in front of them: ask, carefully or not.
      if (f.source === "told" && f.from === them.id) continue;
      if (daysSinceTopic(world, b, `fact:${f.key}`) < 4) continue;
      const nerve = p.curiosity * 0.4 + p.bluntness * 0.4 + rel.ease * 0.4 - (f.confidential ? 0.5 : 0);
      if (nerve > 0.3) add({ key: `fact:${f.key}`, kind: "ask", score: nerve * (0.3 + f.importance / 15) * f.certainty, label: `${f.source === "rumour" ? "a rumour" : "what they'd heard"} about ${them.name}`, intent: "find something out", sensitive: f.sensitivity, valence: f.valence, about: them.id, fact: f.id });
      continue;
    }
    if (f.when !== null && f.pred === "plan" && f.when < world.time - 3 * 1440) continue;
    // Not back to whoever it came from.
    if (f.from === them.id || f.chain?.includes(them.id)) continue;
    // News that involves the listener ("Kwame paid Ruby back") isn't gossip to tell Kwame.
    // (Nor something they're in themselves: that's their own news, not gossip.)
    if (new RegExp(`\\b(${them.name}|${me.name})\\b`).test(f.text)) continue;
    const w = wouldTell(me, f, them, p.gossip, p.discretion);
    if (w < 0.08) continue;
    if (daysSinceTopic(world, b, `fact:${f.key}`) < 6) continue;
    const present = x.nearby.includes(f.about);
    add({ key: `fact:${f.key}`, kind: "gossip", score: w * (present ? 0.15 : 1) * (others ? 0.7 : 1), label: `${world.citizens[f.about]?.name ?? "someone"}`, intent: "gossip", sensitive: f.sensitivity, valence: f.valence, about: f.about, fact: f.id });
  }

  // ---- their own life
  for (const it of lifeItems(world, me).slice(0, 8)) {
    if (daysSinceTopic(world, b, it.key) < (it.kind === "disclose" ? 30 : 5)) continue;
    // Not "Ethan and I have become friends" said to Ethan.
    if (it.first.includes(them.name)) continue;
    // Opening up depends on how open they are, how close they are, and how private it is.
    let willing = clamp(p.openness * 0.6 + rel.closeness * 0.7 + (rel.trust / 100) * 0.3 - it.sensitivity * (1.1 - p.openness * 0.4) - rel.guarded * 0.4 - (others ? it.sensitivity * 0.5 : 0), 0, 1);
    // Big good news: they'd tell anyone who'll listen.
    if (it.kind === "brag" && it.importance >= 7 && it.valence > 0.6) willing = Math.max(willing, 0.35 + p.selfFocus * 0.3);
    if (willing < 0.06) continue;
    const kind = it.kind;
    let score = willing * (0.35 + Math.min(10, Math.max(1, it.importance)) / 14);
    if (kind === "brag") score *= 0.4 + p.selfFocus * 0.9 + (rel.kind === "rival" ? 0.4 : 0);
    if (kind === "complain" || kind === "problem") score *= 0.6 + (1 - p.optimism) * 0.5;
    if (kind === "disclose" && it.sensitivity > 0.5) score *= rel.kind === "close friend" || rel.kind === "family" ? 1 : 0.15;
    if (SYSTEMY.has(kind)) score *= clamp(0.5 + urgent + it.importance / 20, 0.4, 1.2);
    // Something big that happened today is on their mind; so is whatever's behind how they feel.
    if (it.memory !== undefined && it.importance >= 7 && world.time - it.t < 1440) score *= 1.7;
    const feeling = dominantEmotion(me, 30);
    const behind = feeling && it.memory !== undefined ? [...me.memories.short, ...me.memories.long].find((m) => m.id === it.memory && (m.emotions?.[feeling.emotion] ?? 0) >= 8) : undefined;
    if (behind) score *= 1.4;
    add(lifeTopic(me, it, score, rel));
  }

  // ---- work
  if (rel.coworker && rel.kind !== "boss" && rel.kind !== "staff") {
    const view = t.views.find((v) => v.key === `employer:${me.employerId}`);
    const moan = view && view.v < -0.2;
    const boss = me.employerId && me.employerId !== "corp" ? world.businesses[me.employerId]?.ownerId : null;
    const bossNearby = !!boss && x.nearby.includes(boss);
    add({ key: `work:${dayOf(world.time)}`, kind: moan ? "complain" : "work", score: (moan ? 0.45 : 0.25) * (bossNearby ? 0.1 : 1) * (0.6 + rel.ease * 0.6), label: "work", intent: moan ? "complain" : "pass time", sensitive: moan ? 0.4 : 0.1, valence: moan ? -0.5 : 0, about: null });
  } else if (daysSinceTopic(world, b, "ask:work") > 4 && them.occupation !== "unemployed") {
    add({ key: "ask:work", kind: "ask", score: 0.12 + p.curiosity * 0.2 + (rel.familiarity < 15 ? 0.15 : 0), label: "work", intent: "pass time", sensitive: 0.1, valence: 0, about: them.id });
  }

  // ---- where they are and what's going on around them
  const place = conv.buildingId ? world.map.buildings.find((x2) => x2.id === conv.buildingId) : undefined;
  const storm = world.happenings.find((h) => h.kind === "storm" && !h.ended && world.time >= h.t && world.time < h.until);
  const powerCut = world.happenings.find((h) => h.kind === "power_cut" && !h.ended && world.time >= h.t && world.time < h.until);
  if (place) {
    const here = world.citizenOrder.filter((id) => world.citizens[id].insideId === place.id).length;
    add({ key: `env:${place.type}:${here > 5 ? "busy" : here <= 2 ? "dead" : "ok"}`, kind: "environment", score: 0.18 + p.impulsiveness * 0.15 + (here > 5 || here <= 2 ? 0.1 : 0), label: place.type === "house" || place.type === "apartments" ? "the place" : place.name, intent: "pass time", sensitive: 0, valence: 0, about: null, detail: { place: place.type, crowd: here } });
  }
  if (storm) add({ key: `env:storm:${storm.id}`, kind: "environment", score: 0.4, label: "the weather", intent: "pass time", sensitive: 0, valence: -0.3, about: null, detail: { weather: "storm" } });
  if (powerCut) add({ key: `env:power:${powerCut.id}`, kind: "environment", score: 0.4, label: "the power cut", intent: "complain", sensitive: 0, valence: -0.3, about: null, detail: { weather: "power" } });
  for (const id of x.nearby) {
    const o = world.citizens[id];
    const r = me.relationships[id];
    if (!o || !r || id === them.id) continue;
    if (r.affinity < -25 || t.facts.some((f) => f.about === id && f.sensitivity > 0.3)) add({ key: `nearby:${id}:${dayOf(world.time)}`, kind: "environment", score: 0.2 + p.gossip * 0.3, label: `${o.name} being there`, intent: "gossip", sensitive: 0.4, valence: -0.2, about: id, detail: { nearby: o.name } });
  }

  // ---- what they like, small annoyances, body, nonsense
  for (const fav of p.favourite) {
    const m = MUNDANE[fav];
    if (!m || daysSinceTopic(world, b, `like:${fav}`) < 3) continue;
    add({ key: `like:${fav}`, kind: "mundane", score: 0.16 + p.verbosity * 0.1 + (leisure ? 0.08 : 0), label: m.label, intent: "pass time", sensitive: 0, valence: 0.3, about: null, detail: { like: fav } });
  }
  for (const q of me.personality.quirks) {
    const topic = QUIRK_TOPIC[q];
    if (!topic || daysSinceTopic(world, b, `quirk:${q}`) < 6) continue;
    add({ key: `quirk:${q}`, kind: "mundane", score: 0.1 + p.storytelling * 0.15 + rel.ease * 0.1, label: topic, intent: "pass time", sensitive: 0, valence: 0.2, about: null, detail: { quirk: q } });
  }
  for (const d of me.personality.dislikes) {
    if (daysSinceTopic(world, b, `dislike:${d}`) < 4) continue;
    const triggered = (d === "crowds" && place && world.citizenOrder.filter((id) => world.citizens[id].insideId === place.id).length > 5) || (d === "early mornings" && hourOf(world.time) < 9) || (d === "waiting around" && me.activity.kind === "shop");
    add({ key: `dislike:${d}`, kind: "complain", score: (triggered ? 0.4 : 0.07) * (0.5 + (1 - p.patience) * 0.6), label: d, intent: "complain", sensitive: 0, valence: -0.3, about: null, detail: { dislike: d } });
  }
  if (me.needs.hunger < 35) add({ key: `body:hungry:${dayOf(world.time)}`, kind: "mundane", score: 0.22, label: "food", intent: "pass time", sensitive: 0, valence: -0.1, about: null, detail: { body: "hungry" } });
  if (me.needs.energy < 30) add({ key: `body:tired:${dayOf(world.time)}`, kind: "mundane", score: 0.22, label: "being tired", intent: "complain", sensitive: 0, valence: -0.2, about: null, detail: { body: "tired" } });
  if (rel.ease > 0.3 && hourOf(world.time) >= 15 && hourOf(world.time) < 21 && daysSinceTopic(world, b, "evening") > 0.6)
    add({ key: "evening", kind: "evening", score: 0.12 + rel.closeness * 0.25 + (me.needs.social < 50 ? 0.1 : 0), label: "tonight", intent: "pass time", sensitive: 0, valence: 0.2, about: them.id });
  if (p.curiosity + p.humour > 1.0 && rel.ease > 0.2 && daysSinceTopic(world, b, "hypo") > 5)
    add({ key: "hypo", kind: "hypothetical", score: 0.06 + (p.curiosity + p.humour - 1) * 0.3, label: "a daft question", intent: "joke around", sensitive: 0, valence: 0.2, about: null });

  // ---- between the two of them: running jokes, teasing, something from last time
  if (b) {
    for (const j of b.jokes) if (rel.ease > 0.3 && j.uses < 3 && daysSinceTopic(world, b, `joke:${j.hook}`) > 3) add({ key: `joke:${j.hook}`, kind: "joke", score: 0.2 + p.humour * 0.35, label: j.hook, intent: "joke around", sensitive: 0, valence: 0.4, about: them.id });
    const last = b.episodes[b.episodes.length - 1];
    // (Something of theirs from last time, not their own business.)
    const theirs = last?.topics.find((tp) => !tp.includes(me.name) && !/^(tonight|a daft question|a bit of teasing)$/.test(tp));
    if (last && theirs && last.importance >= 5 && daysSinceTopic(world, b, `ep:${last.t}`) > 2 && world.time - last.t < 10 * 1440)
      add({ key: `ep:${last.t}`, kind: "shared", score: 0.15 + rel.closeness * 0.2, label: theirs, intent: "check on them", sensitive: 0.2, valence: 0, about: them.id, detail: { summary: last.summary } });
  }
  if (rel.ease > 0.45 && p.teasing > 0.4) add({ key: `tease:${dayOf(world.time)}`, kind: "tease", score: 0.1 + p.teasing * 0.3, label: "a bit of teasing", intent: "joke around", sensitive: 0, valence: 0.2, about: them.id });

  return out.map((tp) => ({ ...tp, score: Math.round(clamp(tp.score, 0, 2) * 1000) / 1000 }));
}

/**
 * Draw the few things they'll have in mind to bring up, by score but with
 * chance: not always the weightiest. (`n` at most; the first is what they'd
 * open with, if they open.)
 */
export function drawAgenda(cands: Topic[], n: number, r: RngHolder): Topic[] {
  const pool = cands.filter((c) => c.score > 0.02);
  const out: Topic[] = [];
  while (out.length < n && pool.length) {
    // Soften the scores so a high one is likely but not certain.
    const weights = pool.map((c) => Math.pow(c.score, 1.3) + 0.03);
    const total = weights.reduce((a, b) => a + b, 0);
    let x = rand(r) * total;
    let i = 0;
    for (; i < pool.length - 1; i++) {
      x -= weights[i];
      if (x <= 0) break;
    }
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

/** A seeded RNG for one person's choices in one conversation. */
export function rngFor(world: WorldState, conv: Conversation, who: string, salt: string): RngHolder {
  return { rng: hashSeed(`${world.seed}:${conv.id}:${who}:${salt}`) };
}
