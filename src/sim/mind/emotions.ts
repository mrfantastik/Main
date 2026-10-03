import type { FearKey } from "../data/personality";
import { EMOTIONS, type Citizen, type CitizenId, type Emotion, type Emotions, type MemoryKind, type WorldState } from "../types";
import { clamp } from "../util";
import { fearKeyOf } from "./personality";

// Emotions: ten feelings (0..100) that rise with events, drift back towards
// a target set by personality and circumstances, and colour behaviour.
//
// - Events push feelings directly (feel). Most events already create a
//   memory, and remembering something stirs the matching feelings, which are
//   stored on the memory so they come back when that person is met again.
// - Every hour each feeling moves part of the way towards its target
//   (lonely people get lonelier, broke people more afraid).
// - Personality scales everything: neuroticism amplifies negative feelings,
//   extraversion boosts the joy of company, agreeableness tempers anger.
// - mood (0..100) is derived from the feelings, so older code keeps working.

export const EMOTION_EMOJI: Record<Emotion, string> = {
  joy: "😄",
  sadness: "😢",
  anger: "😠",
  fear: "😰",
  pride: "😎",
  shame: "😳",
  envy: "😒",
  gratitude: "🙏",
  loneliness: "😔",
  love: "🥰",
};

const NEGATIVE: ReadonlySet<Emotion> = new Set(["sadness", "anger", "fear", "shame", "envy", "loneliness"]);

/** Share of the gap to the target closed each hour (how long a feeling lingers). */
const RATE: Record<Emotion, number> = {
  joy: 0.1,
  sadness: 0.035,
  anger: 0.12,
  fear: 0.07,
  pride: 0.05,
  shame: 0.06,
  envy: 0.05,
  gratitude: 0.03,
  loneliness: 0.08,
  love: 0.02,
};

export function neutralEmotions(): Emotions {
  return { joy: 25, sadness: 5, anger: 2, fear: 8, pride: 10, shame: 2, envy: 4, gratitude: 5, loneliness: 10, love: 10 };
}

/** How strongly this person feels a given emotion (personality-scaled). */
export function sensitivity(c: Citizen, e: Emotion): number {
  const b = c.personality.big5;
  let s = 1;
  if (NEGATIVE.has(e)) s *= 0.6 + b.neuroticism * 0.9;
  if (e === "anger") s *= 1.25 - b.agreeableness * 0.5;
  if (e === "gratitude" || e === "love") s *= 0.6 + b.agreeableness * 0.8;
  if (e === "envy") s *= 0.6 + c.traits.competitiveness * 0.8;
  if (e === "pride") s *= c.personality.values.includes("status") ? 1.3 : 1;
  return s;
}

export interface FeelContext {
  /** Joy from company is boosted by extraversion. */
  social?: boolean;
  /** Touches the fear they carry around (stronger reaction). */
  fearOf?: FearKey;
}

/** Push feelings up (or down). Returns the change actually applied. */
export function feel(c: Citizen, impulses: Partial<Emotions>, ctx?: FeelContext): Partial<Emotions> {
  const applied: Partial<Emotions> = {};
  const fearKey = ctx?.fearOf ? fearKeyOf(c.personality) : null;
  for (const e of EMOTIONS) {
    const v = impulses[e];
    if (!v) continue;
    let k = v > 0 ? sensitivity(c, e) : 1;
    if (ctx?.social && e === "joy") k *= 0.7 + c.personality.big5.extraversion * 0.9;
    if (fearKey && fearKey === ctx?.fearOf && (e === "fear" || e === "sadness" || e === "shame")) k *= 1.4;
    const before = c.emotions[e];
    c.emotions[e] = clamp(before + v * k, 0, 100);
    const d = Math.round((c.emotions[e] - before) * 10) / 10;
    if (d) applied[e] = d;
  }
  return applied;
}

/**
 * Default feelings for a memory, from its kind and how good or bad it was.
 * Callers can pass their own when they know better.
 */
export function impulsesFor(kind: MemoryKind, importance: number, valence: number, withPeople: boolean): Partial<Emotions> {
  const mag = Math.min(10, Math.max(1, importance)) * Math.abs(valence) * 3.2;
  const good = valence > 0;
  switch (kind) {
    case "betrayal":
      return { anger: mag * 1.2, sadness: mag * 0.4, gratitude: -mag * 0.3 };
    case "favor":
      return good ? { gratitude: mag * 1.1, joy: mag * 0.5 } : { anger: mag * 0.4, sadness: mag * 0.3 };
    case "deal":
      return good ? { pride: mag * 0.8, joy: mag * 0.6 } : { anger: mag * 0.5, shame: mag * 0.3 };
    case "loan":
      return good ? { gratitude: mag * 0.6, joy: mag * 0.3 } : { fear: mag * 0.5, shame: mag * 0.5 };
    case "financial":
      return good ? { joy: mag * 0.8, pride: mag * 0.3, fear: -mag * 0.3 } : { fear: mag * 0.7, sadness: mag * 0.5 };
    case "job":
      return good ? { pride: mag * 0.7, joy: mag * 0.5, fear: -mag * 0.3 } : { sadness: mag * 0.7, shame: mag * 0.4, fear: mag * 0.3 };
    case "business":
      return good ? { pride: mag * 0.9, joy: mag * 0.4 } : { sadness: mag * 0.6, fear: mag * 0.5 };
    case "social":
      return good ? { joy: mag * 0.6, love: withPeople ? mag * 0.4 : 0, loneliness: -mag * 0.5 } : { anger: mag * 0.6, sadness: mag * 0.4 };
    case "conversation":
      return good ? { joy: mag * 0.4, loneliness: -mag * 0.4 } : { anger: mag * 0.5, sadness: mag * 0.2 };
    case "insight":
      return good ? { joy: mag * 0.5, pride: mag * 0.5 } : { fear: mag * 0.4 };
    case "world":
      return good ? { joy: mag * 0.5 } : { fear: mag * 0.8 };
  }
}

type FeelingsCache = { long: unknown[]; short: unknown[]; longN: number; shortN: number; byPerson: Map<CitizenId, Partial<Emotions>> };

// feelingsToward runs for every pair of people many times an hour, so the
// per-person totals are built in one pass over the memories and kept until
// the memories change (remember/decay call memoriesChanged; a replaced or
// resized list is also noticed here).
const feelingsCache = new WeakMap<Citizen, FeelingsCache>();
const NO_FEELINGS: Readonly<Partial<Emotions>> = Object.freeze({});

export function memoriesChanged(c: Citizen): void {
  feelingsCache.delete(c);
}

function feelingsByPerson(c: Citizen): Map<CitizenId, Partial<Emotions>> {
  const { long, short } = c.memories;
  const hit = feelingsCache.get(c);
  if (hit && hit.long === long && hit.short === short && hit.longN === long.length && hit.shortN === short.length) return hit.byPerson;
  const byPerson = new Map<CitizenId, Partial<Emotions>>();
  for (const list of [long, short]) {
    for (const m of list) {
      if (!m.emotions) continue;
      for (let i = 0; i < m.people.length; i++) {
        const id = m.people[i];
        if (m.people.indexOf(id) !== i) continue;
        let out = byPerson.get(id);
        if (!out) byPerson.set(id, (out = {}));
        for (const e of EMOTIONS) {
          const v = m.emotions[e];
          if (v) out[e] = (out[e] ?? 0) + v * m.strength;
        }
      }
    }
  }
  for (const out of byPerson.values()) for (const e of EMOTIONS) if (out[e] !== undefined) out[e] = clamp(out[e]!, 0, 100);
  feelingsCache.set(c, { long, short, longN: long.length, shortN: short.length, byPerson });
  return byPerson;
}

/** Feelings this person attaches to someone, from the memories they hold about them. Read-only. */
export function feelingsToward(c: Citizen, otherId: CitizenId): Readonly<Partial<Emotions>> {
  return feelingsByPerson(c).get(otherId) ?? NO_FEELINGS;
}

/**
 * Seeing someone brings back how they made you feel (grudges, loyalty).
 * Rate-limited per person so a long day together doesn't snowball.
 */
export function recallPerson(world: WorldState, c: Citizen, otherId: CitizenId): Partial<Emotions> {
  const key = `recall:${otherId}`;
  if (world.time - (c.cooldowns[key] ?? -1e9) < 180) return {};
  c.cooldowns[key] = world.time;
  const f = feelingsToward(c, otherId);
  return feel(c, {
    anger: (f.anger ?? 0) * 0.18,
    gratitude: (f.gratitude ?? 0) * 0.15,
    love: (f.love ?? 0) * 0.12,
    envy: (f.envy ?? 0) * 0.15,
    fear: (f.fear ?? 0) * 0.1,
  });
}

/** How someone approaches a negotiation with this person. All 0..1 (warmth -1..1). */
export function stanceToward(c: Citizen, otherId: CitizenId): { warmth: number; toughness: number; caution: number } {
  const f = feelingsToward(c, otherId);
  const e = c.emotions;
  return {
    warmth: clamp(((f.gratitude ?? 0) + (f.love ?? 0) * 0.6 - (f.anger ?? 0) - (f.envy ?? 0) * 0.5) / 100, -1, 1),
    toughness: clamp((e.anger * 0.5 + (f.anger ?? 0) * 0.6 + (f.envy ?? 0) * 0.4) / 100, 0, 1),
    caution: clamp(e.fear / 100, 0, 1),
  };
}

/** Productivity multiplier: sad people get less done (bounded 0.75..1.08). */
export function workMood(c: Citizen): number {
  const e = c.emotions;
  return clamp(1 - (e.sadness / 100) * 0.3 + (e.joy / 100) * 0.06 + (e.pride / 100) * 0.03, 0.75, 1.08);
}

/** The feeling that stands out right now (null if nothing does). */
export function dominantEmotion(c: Citizen, threshold = 40): { emotion: Emotion; level: number } | null {
  let best: Emotion | null = null;
  let bestScore = threshold;
  for (const e of EMOTIONS) {
    // Everyday contentment shouldn't drown out everything else.
    const score = e === "joy" ? c.emotions[e] * 0.8 : e === "love" ? c.emotions[e] * 0.7 : c.emotions[e];
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best ? { emotion: best, level: Math.round(c.emotions[best]) } : null;
}

export function moodFromEmotions(e: Emotions): number {
  const m =
    50 +
    e.joy * 0.45 +
    e.pride * 0.2 +
    e.gratitude * 0.12 +
    e.love * 0.18 -
    e.sadness * 0.45 -
    e.anger * 0.22 -
    e.fear * 0.3 -
    e.shame * 0.25 -
    e.envy * 0.12 -
    e.loneliness * 0.3;
  return clamp(m, 0, 100);
}

export interface Circumstances {
  /** 0..100: needs met, money comfort, job, home (the old mood formula). */
  wellbeing: number;
  /** Money pressure 0..1.6 (from the situation). */
  pressure: number;
  /** People they feel close to. */
  closeBonds: number;
  /** Earning more than they expected from their work. */
  doingWell: boolean;
}

/** Where each feeling settles if nothing happens, given personality and circumstances. */
export function emotionTargets(c: Citizen, k: Circumstances): Emotions {
  const b = c.personality.big5;
  const wb = k.wellbeing;
  const owns = c.businessIds.length > 0;
  return {
    joy: clamp(8 + (wb - 40) * 0.9, 0, 70) * (0.75 + b.extraversion * 0.3 + (1 - b.neuroticism) * 0.15),
    sadness: clamp((45 - wb) * 1.2, 0, 70) * (0.6 + b.neuroticism * 0.8) + (c.homeless ? 10 : 0),
    anger: 2 + (1 - b.agreeableness) * 6,
    fear: clamp(k.pressure * 50, 0, 80) * (0.5 + b.neuroticism * 0.9) + b.neuroticism * 6,
    pride: 6 + (owns ? 5 : 0) + (k.doingWell ? 10 : 0) + (c.personality.values.includes("status") ? 3 : 0),
    shame: (c.homeless ? 22 : 0) + (c.rentArrears > 0 ? 10 : 0) + (c.occupation === "unemployed" ? 6 : 0),
    envy: 3 + c.traits.competitiveness * 5,
    gratitude: 4,
    loneliness: clamp((62 - c.needs.social) * 0.9, 0, 70) * (0.5 + b.extraversion * 0.8) + (k.closeBonds === 0 ? 8 : 0),
    love: Math.min(55, 6 + k.closeBonds * 12) * (0.6 + b.agreeableness * 0.5),
  };
}

/** Hourly: feelings drift towards their targets; mood follows. */
export function settleEmotions(c: Citizen, targets: Emotions): void {
  for (const e of EMOTIONS) {
    const cur = c.emotions[e];
    c.emotions[e] = clamp(cur + (targets[e] - cur) * RATE[e], 0, 100);
  }
  c.mood = moodFromEmotions(c.emotions);
}

/** The person they currently feel most strongly about, and how (for thoughts). */
export function strongestFeelingAboutSomeone(world: WorldState, c: Citizen): { id: CitizenId; emotion: Emotion; level: number } | null {
  let best: { id: CitizenId; emotion: Emotion; level: number } | null = null;
  for (const id of Object.keys(c.relationships)) {
    if (!world.citizens[id]) continue;
    const f = feelingsToward(c, id);
    for (const e of ["anger", "gratitude", "envy", "love"] as const) {
      const v = f[e] ?? 0;
      if (v > 15 && (!best || v > best.level)) best = { id, emotion: e, level: v };
    }
  }
  return best;
}

/** End of day: a good or bad day for money registers. */
export function dailyMoneyFeelings(c: Citizen, net: number, typicalIncome: number): void {
  const big = Math.max(25, typicalIncome * 0.4);
  if (net > big) feel(c, { joy: 6, pride: 4, fear: -4 });
  else if (net < -big) feel(c, { sadness: 5, fear: 6 }, { fearOf: "poor" });
}
