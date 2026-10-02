import { chance, randRange } from "../rng";
import type { Citizen, Occupation, SuccessStory, WorldState } from "../types";
import { OCCUPATIONS } from "../types";
import { avg, pushRing, round2 } from "../util";

// Beliefs: what citizens *think* is true. They learn from their own results
// (reliable), word on the street (vague, lagging), and gossip (specific but
// second-hand). Decisions are made on beliefs, not on the true state —
// which is how bandwagons, bad bets and good hunches emerge.

export function occupationBelief(c: Citizen, occ: Occupation): number {
  return c.beliefs.occupationIncome[occ]?.value ?? 30;
}

/** Called daily: learn from own earnings; hear the word on the street. */
export function updateBeliefsDaily(world: WorldState): void {
  // 1. What each occupation actually earned recently (true average).
  const byOcc: Partial<Record<Occupation, number[]>> = {};
  for (const id of world.citizenOrder) {
    const c = world.citizens[id];
    const recent = c.finance.occupationEarnings.slice(-3);
    if (recent.length === 0 || world.time - c.occupationSince < 1440) continue;
    (byOcc[c.occupation] ??= []).push(avg(recent));
  }
  for (const occ of OCCUPATIONS) {
    const vals = byOcc[occ];
    if (vals && vals.length) {
      const prev = world.economy.streetIncome[occ] ?? avg(vals);
      world.economy.streetIncome[occ] = round2(prev * 0.5 + avg(vals) * 0.5);
    }
  }

  for (const id of world.citizenOrder) {
    const c = world.citizens[id];
    // 2. Own experience is the most reliable signal.
    const own = c.finance.occupationEarnings.slice(-3);
    if (own.length >= 1 && world.time - c.occupationSince >= 1440) {
      const prev = c.beliefs.occupationIncome[c.occupation];
      const v = avg(own);
      c.beliefs.occupationIncome[c.occupation] = {
        value: round2(prev ? prev.value * 0.35 + v * 0.65 : v),
        conf: 0.85,
        t: world.time,
        source: "my own experience",
      };
    }
    // 3. Everything else: confidence fades; vague beliefs drift toward street talk.
    for (const occ of OCCUPATIONS) {
      if (occ === c.occupation) continue;
      const b = c.beliefs.occupationIncome[occ];
      const street = world.economy.streetIncome[occ];
      if (!b || street === undefined) continue;
      b.conf *= 0.95;
      if (b.conf < 0.5 && chance(world, 0.35 + c.traits.sociability * 0.4)) {
        b.value = round2(b.value * 0.75 + street * randRange(world, 0.8, 1.2) * 0.25);
        b.source = "word on the street";
        b.t = world.time;
      }
    }
    // 4. Old stories fade.
    c.beliefs.stories = c.beliefs.stories.filter((s) => world.time - s.t < 6 * 1440);
    c.beliefs.insights = c.beliefs.insights.filter((i) => i.startT > world.time - 3 * 1440);
  }
}

/** A citizen hears about someone else's success (or failure). */
export function hearStory(world: WorldState, listener: Citizen, story: SuccessStory, sourceName: string): void {
  if (story.citizenId === listener.id) return;
  listener.beliefs.stories = listener.beliefs.stories.filter((s) => !(s.citizenId === story.citizenId && s.occupation === story.occupation));
  pushRing(listener.beliefs.stories, story, 8);
  // A concrete number from someone you know updates your beliefs a bit.
  const b = listener.beliefs.occupationIncome[story.occupation];
  if (b && story.amount > 0) {
    b.value = round2(b.value * 0.7 + story.amount * 0.3);
    b.conf = Math.min(0.7, b.conf + 0.1);
    b.source = `heard from ${sourceName}`;
    b.t = world.time;
  }
}

/** The best recent story about an occupation that beats `than`. */
export function inspiringStory(c: Citizen, occ: Occupation, than: number): SuccessStory | undefined {
  return c.beliefs.stories.filter((s) => s.occupation === occ && s.amount > than * 1.25).sort((a, b) => b.amount - a.amount)[0];
}
