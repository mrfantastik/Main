import { interruptActivity } from "../ai/actions";
import { setThought } from "../ai/decision";
import { logEvent } from "../events";
import { remember } from "../memory/memory";
import { adjustRel } from "../social/relationships";
import type { Citizen, Emotions, MemoryKind, WorldState } from "../types";
import { money } from "../util";

// Reacting to things that happen to someone out of the blue (God Mode): money
// appearing or vanishing, a job they never applied for, their business shut
// down. They feel it (in proportion to what it means to them), it's the first
// thing on their mind, they stop what they're doing and rethink, it goes in
// the feed, and they talk about it. A suspicious sort may blame someone they
// already dislike. With the town's brain awake, it hears about it first and
// writes their reaction and a new plan for the day (see the AI director).

export interface Shock {
  /** For their memory, in their words. */
  memory: string;
  kind: MemoryKind;
  importance: number;
  valence: number;
  feel: Partial<Emotions>;
  /** What goes through their head right now. */
  thought: string;
  /** For the feed; omitted: no entry. */
  feed?: string;
  /** Stop what they're doing and think again (not if asleep or mid-conversation). */
  rethink?: boolean;
}

export function react(world: WorldState, c: Citizen, s: Shock): void {
  remember(world, c, { text: s.memory, kind: s.kind, importance: s.importance, valence: s.valence, people: [], feel: s.feel });
  setThought(world, c, s.thought, 4);
  c.shock = { t: world.time, text: s.memory };
  // Whatever they'd planned for today is up in the air now.
  if (c.agent?.plan) c.agent.plan = null;
  if (s.rethink && c.activity.kind !== "sleep" && c.activity.kind !== "talk" && !c.awaitingAI) {
    // They stop what they're doing and take it in for a few minutes, then decide what to do about it.
    interruptActivity(world, c);
    c.activity = { kind: "rest", label: "Taking it all in", buildingId: c.insideId, startedAt: world.time, endsAt: world.time + 20, action: null };
  }
  if (s.feed) logEvent(world, "life", s.feed, 4, [c.id]);
}

/** Everything they have: cash and savings. */
const worth = (c: Citizen) => c.money + c.savings;

/** The person they like least, if they really don't like them (who they'd suspect). */
function suspect(world: WorldState, c: Citizen): Citizen | null {
  const b = c.personality.big5;
  // Trusting, easy-going people don't go looking for someone to blame.
  if (b.agreeableness > 0.45 && b.neuroticism < 0.6) return null;
  const [id, r] = Object.entries(c.relationships).sort((x, y) => x[1].affinity - y[1].affinity)[0] ?? [];
  return id && r && r.affinity < -15 && world.citizens[id] ? world.citizens[id] : null;
}

/** Money vanished. `before`: what they had beforehand. */
export function reactToLoss(world: WorldState, c: Citizen, amount: number, before: number): void {
  const f = Math.min(1, amount / Math.max(1, before));
  const left = worth(c);
  const pct = Math.round(f * 100);
  if (f < 0.08 && amount < 30) {
    react(world, c, { memory: `I was ${money(amount)} short and I can't work out why.`, kind: "financial", importance: 3, valence: -0.2, feel: { anger: 3, fear: 2 }, thought: `I'm sure I had ${money(amount)} more than this. Odd.` });
    return;
  }
  const who = suspect(world, c);
  const thought =
    left < 5
      ? `It's all gone. ${money(amount)}, just vanished. How am I going to manage now?`
      : f > 0.5
        ? `${money(amount)} just vanished from my account! That's ${pct}% of everything I had.`
        : `${money(amount)} missing from my account. Somebody's going to answer for this.`;
  react(world, c, {
    memory: `${money(amount)} vanished from my account. Nobody can tell me how.`,
    kind: "financial",
    importance: Math.round(5 + 4 * Math.min(1, f * 2)),
    valence: -(0.3 + 0.7 * Math.min(1, f * 2)),
    feel: { anger: 10 + 40 * f, fear: 8 + 45 * f + (left < 20 ? 15 : 0), sadness: 5 + 30 * f },
    thought: who ? `${thought} I bet ${who.name} had something to do with it.` : thought,
    feed: `${f > 0.5 ? "😱" : "😠"} ${c.name} found ${money(amount)} missing and is ${f > 0.5 ? "devastated" : "furious"}${who ? `, and blames ${who.name}` : ""}.`,
    rethink: true,
  });
  if (who) {
    adjustRel(world, c, who.id, { trust: -10 - 15 * f, affinity: -5 - 8 * f });
    remember(world, c, { text: `I think ${who.name} took my money.`, kind: "betrayal", importance: 6, valence: -0.6, people: [who.id], feel: { anger: 8 } });
  }
}

/** Money appeared out of nowhere. */
export function reactToWindfall(world: WorldState, c: Citizen, amount: number, before: number): void {
  const f = Math.min(3, amount / Math.max(50, before));
  const t = c.traits;
  if (amount < 20 && f < 0.1) {
    react(world, c, { memory: `I found ${money(amount)} I didn't know I had.`, kind: "financial", importance: 3, valence: 0.3, feel: { joy: 4 }, thought: `${money(amount)} more than I thought. Nice.` });
    return;
  }
  const then =
    t.frugality > 0.6
      ? "I'm not spending a penny until I know where it came from."
      : t.generosity > 0.65
        ? "I should help someone out with some of this."
        : t.ambition > 0.6 || t.entrepreneurship > 0.6
          ? "This could change everything. Time to think big."
          : "Drinks are on me!";
  react(world, c, {
    memory: `${money(amount)} appeared in my account out of nowhere!`,
    kind: "financial",
    importance: Math.round(5 + 4 * Math.min(1, f)),
    valence: 0.5 + 0.5 * Math.min(1, f),
    feel: { joy: 15 + 30 * Math.min(1, f), gratitude: 8 + 15 * Math.min(1, f), fear: c.personality.big5.neuroticism > 0.6 ? 8 : 0 },
    thought: `${money(amount)} just appeared in my account! ${then}`,
    feed: `🤩 ${c.name} found ${money(amount)} in their account and can't believe their luck.`,
    rethink: f > 0.2,
  });
}

/** A new line of work they never chose. */
export function reactToNewJob(world: WorldState, c: Citizen, was: string, now: string, better: boolean): void {
  react(world, c, {
    memory: `Out of nowhere I'm ${now} now, not ${was}.`,
    kind: "job",
    importance: 7,
    valence: better ? 0.5 : -0.2,
    feel: better ? { joy: 20, pride: 12, fear: 6 } : { fear: 15, anger: 10, sadness: 6 },
    thought: better ? `I'm ${now} now? I'll take it. Better than ${was}.` : `I'm ${now} now? I didn't ask for this. I was ${was}.`,
    feed: `${better ? "🙂" : "😕"} ${c.name} woke up ${now} and is ${better ? "making the best of it" : "not happy about it"}.`,
    rethink: true,
  });
}

/** Their business was shut down. */
export function reactToClosure(world: WorldState, owner: Citizen, name: string): void {
  react(world, owner, {
    memory: `${name} was shut down, just like that. Everything I put into it, gone.`,
    kind: "business",
    importance: 9,
    valence: -0.9,
    feel: { anger: 30, sadness: 30, shame: 12, fear: 20 },
    thought: `${name} is finished. Shut down, just like that. What do I do now?`,
    feed: `💔 ${owner.name} is reeling after ${name} was shut down.`,
    rethink: true,
  });
}

/** They've been handed a business of their own. */
export function reactToNewBusiness(world: WorldState, owner: Citizen, name: string): void {
  react(world, owner, {
    memory: `I've suddenly got my own business: ${name}.`,
    kind: "business",
    importance: 8,
    valence: 0.7,
    feel: { joy: 25, pride: 20, fear: 10 },
    thought: `I've got my own business now, ${name}! Better make it work.`,
    feed: `🎉 ${owner.name} can't believe they're running ${name}.`,
    rethink: true,
  });
}

/** A market shake-up in something they sell or hold: good or bad news for them. */
export function reactToMarket(world: WorldState, c: Citizen, product: string, good: boolean, why: string): void {
  react(world, c, {
    memory: `${why} That's ${good ? "good" : "bad"} news for me.`,
    kind: "financial",
    importance: 5,
    valence: good ? 0.5 : -0.5,
    feel: good ? { joy: 12, pride: 4 } : { fear: 14, anger: 6 },
    thought: good ? `${why} Time to cash in on ${product}.` : `${why} That's going to hurt.`,
  });
}
