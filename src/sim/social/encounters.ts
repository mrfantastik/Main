import { getBuildingIndexed } from "../city/lookup";
import { logEvent } from "../events";
import { placeName } from "../places";
import { remember } from "../memory/memory";
import { feelingsToward, recallPerson } from "../mind/emotions";
import { chance, randRange } from "../rng";
import type { ActivityKind, Citizen, WorldState } from "../types";
import { clamp } from "../util";
import { adjustRel, getRel, relLabel } from "./relationships";

// Passive social life. Every hour, people who are in the same place may
// interact a little: familiarity grows, and how much they like each other
// drifts according to personality compatibility and mood. Friendships and
// grudges form on their own; milestones become memories and news.

const CONTEXT: Partial<Record<ActivityKind, number>> = {
  socialize: 2.2,
  talk: 1.5,
  eat: 1.2,
  rest: 0.8,
  work: 1,
  manage: 0.9,
  research: 1,
  shop: 0.7,
  browse: 0.7,
  trade: 0.8,
  restock: 0.5,
  job_hunt: 0.5,
};

const TRAITS = ["sociability", "generosity", "greed", "competitiveness", "ambition", "diligence"] as const;

/** How well two personalities get on, -1..1. */
export function compatibility(a: Citizen, b: Citizen): number {
  let diff = 0;
  for (const k of TRAITS) diff += Math.abs(a.traits[k] - b.traits[k]);
  diff /= TRAITS.length;
  let v = 0.45 - diff * 1.6;
  if (a.traits.generosity > 0.6 && b.traits.generosity > 0.6) v += 0.2;
  if (a.traits.greed > 0.7 && b.traits.generosity > 0.7) v -= 0.15;
  if (a.traits.competitiveness > 0.7 && b.traits.competitiveness > 0.7) v -= 0.15;
  if (a.occupation === b.occupation && a.occupation !== "unemployed") v += 0.1;
  if (getRel(a, b.id).roles.includes("rival")) v -= 0.5;
  // Kindred spirits: shared values and two agreeable people get on.
  const shared = a.personality.values.filter((x) => b.personality.values.includes(x)).length;
  v += shared * 0.08;
  if (a.personality.big5.agreeableness > 0.6 && b.personality.big5.agreeableness > 0.6) v += 0.08;
  if (a.personality.big5.agreeableness < 0.3 && b.personality.big5.agreeableness < 0.3) v -= 0.1;
  return clamp(v, -1, 1);
}

function milestone(world: WorldState, a: Citizen, b: Citizen, before: string, after: string, place: string): void {
  if (before === after) return;
  if (after === "Friend" && (before === "Acquaintance" || before === "Stranger")) {
    remember(world, a, { text: `${b.name} and I have become friends.`, kind: "social", importance: 6, valence: 0.7, people: [b.id], key: `friend:${b.id}` });
    if (a.id < b.id) logEvent(world, "social", `🤝 ${a.name} and ${b.name} have become friends (they keep running into each other at ${place}).`, 2, [a.id, b.id]);
  } else if (after === "Close friend") {
    remember(world, a, { text: `${b.name} is one of my closest friends.`, kind: "social", importance: 7, valence: 0.9, people: [b.id], key: `friend:${b.id}` });
    if (a.id < b.id) logEvent(world, "social", `💛 ${a.name} and ${b.name} are now close friends.`, 3, [a.id, b.id]);
  } else if (after === "Enemy") {
    remember(world, a, { text: `I can't stand ${b.name}.`, kind: "social", importance: 6, valence: -0.8, people: [b.id], key: `enemy:${b.id}` });
    logEvent(world, "social", `😠 ${a.name} has fallen out with ${b.name}.`, 3, [a.id, b.id]);
  }
}

export function encountersHourly(world: WorldState): void {
  // Group people by the place they're in.
  const byPlace = new Map<string, Citizen[]>();
  for (const id of world.citizenOrder) {
    const c = world.citizens[id];
    if (!c.insideId || c.activity.kind === "sleep") continue;
    const b = getBuildingIndexed(world.map, c.insideId);
    if (!b || b.type === "house" || b.type === "apartments") continue;
    const list = byPlace.get(c.insideId) ?? [];
    list.push(c);
    byPlace.set(c.insideId, list);
  }
  for (const [placeId, people] of byPlace) {
    if (people.length < 2) continue;
    const place = placeName(world, placeId);
    for (let i = 0; i < people.length; i++) {
      for (let j = i + 1; j < people.length; j++) {
        const a = people[i];
        const b = people[j];
        const ctx = Math.max(CONTEXT[a.activity.kind] ?? 0.4, CONTEXT[b.activity.kind] ?? 0.4);
        const p = 0.22 * ((a.traits.sociability + b.traits.sociability) / 2 + 0.3) * ctx;
        if (!chance(world, Math.min(0.9, p))) continue;
        for (const [x, y] of [
          [a, b],
          [b, a],
        ] as const) {
          const r = getRel(x, y.id);
          const before = relLabel(r);
          const firstMeeting = r.familiarity < 3;
          // Old feelings come back on seeing them, and colour how it goes.
          recallPerson(world, x, y.id);
          const f = feelingsToward(x, y.id);
          const feelings = ((f.gratitude ?? 0) + (f.love ?? 0) - (f.anger ?? 0) - (f.envy ?? 0) * 0.5) / 100;
          adjustRel(world, x, y.id, {
            familiarity: randRange(world, 2, 5),
            affinity: compatibility(x, y) * 3.2 + (x.mood - 50) / 60 + randRange(world, -1.2, 1.2) + clamp(feelings, -1, 1) * 1.5,
            trust: 0.4,
          });
          if (firstMeeting) remember(world, x, { text: `Met ${y.name} at ${place}.`, kind: "social", importance: 2, valence: 0.2, people: [y.id], key: `met:${y.id}` });
          milestone(world, x, y, before, relLabel(r), place);
        }
      }
    }
  }
}

/** Friends present at a place (for "go where my friends are" decisions). */
export function friendsAt(world: WorldState, c: Citizen, buildingId: string): Citizen[] {
  const out: Citizen[] = [];
  for (const id of world.citizenOrder) {
    if (id === c.id) continue;
    const o = world.citizens[id];
    if (o.insideId !== buildingId || o.activity.kind === "sleep") continue;
    if ((c.relationships[id]?.affinity ?? 0) > 30) out.push(o);
  }
  return out;
}
