import { logEvent } from "../events";
import { adjustRel } from "../social/relationships";
import { dayOf, hourOf } from "../time";
import type { Citizen, Memory, Occupation, Reflection, WorldState } from "../types";
import { clamp, newId } from "../util";

// Nightly reflection: while asleep, each citizen sums up the day's strongest
// memories into one or two lasting lessons ("Marcus always lets me down",
// "Selling coffee works for me"). Lessons change how they see people (trust)
// and work (what they believe a job pays), and nudge later decisions.
// The built-in AI words them from templates; when Claude is on, one citizen
// a night may get their lessons rewritten in their own voice (same lessons,
// same effects — only the words change).

export const REFLECTION_LIMIT = 12;

export interface Draft {
  text: string;
  kind: Reflection["kind"];
  about: string | null;
  valence: number;
  key: string;
  weight: number;
}

const OCC_WORK: Record<Occupation, string> = {
  unemployed: "Looking for work",
  employee: "This job",
  freelancer: "Freelancing",
  shopkeeper: "Running the shop",
  reseller: "Reselling",
  trader: "Trading",
  entrepreneur: "The business",
  researcher: "Research",
};

function goodWork(world: WorldState, c: Citizen): string {
  const biz = c.businessIds.map((id) => world.businesses[id]).find((b) => b && b.open);
  const product = biz?.products[0] ? world.products[biz.products[0]]?.name.toLowerCase() : null;
  if (product) return `Selling ${product} works for me.`;
  switch (c.occupation) {
    case "freelancer":
      return "Freelancing is paying off. Clients like my work.";
    case "trader":
      return "I've got a feel for the markets now.";
    case "reseller":
      return "There's real money in buying low and selling on.";
    case "researcher":
      return "My research is going somewhere.";
    case "employee":
      return "A steady wage suits me.";
    default:
      return "I'm getting good at this.";
  }
}

/** The lessons a citizen could draw from the last day, strongest first. */
export function draftReflections(world: WorldState, c: Citizen): Draft[] {
  const since = world.time - 26 * 60;
  const recent: Memory[] = [];
  for (const list of [c.memories.long, c.memories.short]) for (const m of list) if (m.t >= since) recent.push(m);
  const drafts: Draft[] = [];

  // People: who made the day better or worse?
  const byPerson = new Map<string, { score: number; betrayal: boolean; favor: boolean; n: number }>();
  for (const m of recent) {
    const pid = m.people[0];
    if (!pid || !world.citizens[pid]) continue;
    const e = byPerson.get(pid) ?? { score: 0, betrayal: false, favor: false, n: 0 };
    e.score += m.valence * m.importance * Math.min(3, m.count);
    e.betrayal ||= m.kind === "betrayal";
    e.favor ||= m.kind === "favor" && m.valence > 0;
    e.n++;
    byPerson.set(pid, e);
  }
  let who: [string, { score: number; betrayal: boolean; favor: boolean; n: number }] | null = null;
  for (const entry of byPerson) if (Math.abs(entry[1].score) >= 5 && (!who || Math.abs(entry[1].score) > Math.abs(who[1].score))) who = entry;
  if (who) {
    const [pid, e] = who;
    const name = world.citizens[pid].name;
    const good = e.score > 0;
    const text = good
      ? e.favor
        ? `I owe ${name} one.`
        : e.n >= 2
          ? `${name} has my back.`
          : `${name} is good people.`
      : e.betrayal
        ? `${name} can't be trusted.`
        : e.n >= 2
          ? `${name} always lets me down.`
          : `I should watch myself around ${name}.`;
    drafts.push({ text, kind: "person", about: pid, valence: good ? 0.7 : -0.8, key: `person:${pid}:${good ? "+" : "-"}`, weight: Math.abs(e.score) });
  }

  // Work: did it pay better or worse than they thought it would?
  const earned = c.finance.occupationEarnings[c.finance.occupationEarnings.length - 1];
  const believed = c.beliefs.occupationIncome[c.occupation]?.value;
  if (earned !== undefined && believed && c.occupation !== "unemployed") {
    if (earned >= Math.max(20, believed * 1.25)) {
      drafts.push({ text: goodWork(world, c), kind: "work", about: c.occupation, valence: 0.6, key: `work:${c.occupation}:+`, weight: (earned - believed) / 8 });
    } else if (earned <= believed * 0.55) {
      drafts.push({ text: `${OCC_WORK[c.occupation]} isn't paying like I hoped.`, kind: "work", about: c.occupation, valence: -0.6, key: `work:${c.occupation}:-`, weight: (believed - earned) / 8 });
    }
  }

  // Feelings that need acting on.
  const e = c.emotions;
  if (e.fear >= 45 || c.rentArrears > 0) drafts.push({ text: "I need to keep more money aside for rent.", kind: "money", about: null, valence: -0.5, key: "money:save", weight: e.fear / 10 + (c.rentArrears > 0 ? 3 : 0) });
  if (e.loneliness >= 50) drafts.push({ text: "I need to get out and see people more.", kind: "social", about: null, valence: -0.4, key: "social:out", weight: e.loneliness / 10 });
  if (e.shame >= 40) drafts.push({ text: "I'm better than this. Tomorrow I sort it out.", kind: "self", about: null, valence: -0.3, key: "self:shame", weight: e.shame / 12 });
  else if (e.pride >= 50) drafts.push({ text: "I'm actually good at this.", kind: "self", about: null, valence: 0.6, key: "self:pride", weight: e.pride / 12 });

  return drafts.sort((a, b) => b.weight - a.weight).slice(0, 2);
}

/** Take a lesson to heart: store it (merging repeats) and let it change things. */
export function learn(world: WorldState, c: Citizen, d: Draft, source: Reflection["source"] = "template"): Reflection {
  let r = c.reflections.find((x) => x.key === d.key);
  if (r) {
    r.t = world.time;
    r.strength = 1;
    r.text = d.text;
    r.source = source;
  } else {
    // A lesson replaces its opposite ("X has my back" vs "X lets me down").
    const opposite = d.key.endsWith("+") ? d.key.slice(0, -1) + "-" : d.key.endsWith("-") ? d.key.slice(0, -1) + "+" : null;
    if (opposite) c.reflections = c.reflections.filter((x) => x.key !== opposite);
    r = { id: newId(world), t: world.time, text: d.text, kind: d.kind, about: d.about, valence: d.valence, strength: 1, key: d.key, source };
    c.reflections.push(r);
    if (c.reflections.length > REFLECTION_LIMIT) {
      let weakest = 0;
      for (let i = 1; i < c.reflections.length; i++) if (c.reflections[i].strength < c.reflections[weakest].strength) weakest = i;
      c.reflections.splice(weakest, 1);
    }
  }
  if (d.kind === "person" && d.about) {
    adjustRel(world, c, d.about, d.valence > 0 ? { trust: 6, affinity: 4 } : { trust: -8, affinity: -5 });
  } else if (d.kind === "work" && d.about) {
    const b = c.beliefs.occupationIncome[d.about as Occupation];
    if (b) {
      b.value = Math.round(b.value * (d.valence > 0 ? 1.06 : 0.94));
      b.conf = clamp(b.conf + 0.1, 0, 1);
      b.source = "my own experience";
      b.t = world.time;
    }
  }
  return r;
}

/** How strongly a lesson is held right now (0 = not learned). */
export function lesson(c: Citizen, key: string): number {
  return c.reflections.find((r) => r.key === key)?.strength ?? 0;
}

/** Lessons fade unless they're learned again. */
export function decayReflections(c: Citizen): void {
  for (const r of c.reflections) r.strength = clamp(r.strength - 0.05, 0, 1);
  c.reflections = c.reflections.filter((r) => r.strength > 0.1);
}

export type ReflectionHook = (world: WorldState, c: Citizen, learned: Reflection[]) => void;
let hook: ReflectionHook | null = null;
/** Lets the AI director reword a night's lessons with Claude. */
export function setReflectionHook(h: ReflectionHook | null): void {
  hook = h;
}

/** Hourly: anyone asleep between 2am and 6am who hasn't reflected tonight does so. */
export function nightlyReflection(world: WorldState): void {
  const h = hourOf(world.time);
  if (h < 2 || h >= 6) return;
  const day = dayOf(world.time);
  for (const id of world.citizenOrder) {
    const c = world.citizens[id];
    if (c.lastReflectionDay === day || c.activity.kind !== "sleep") continue;
    c.lastReflectionDay = day;
    const learned = draftReflections(world, c).map((d) => {
      const r = learn(world, c, d);
      if (d.kind === "person" && d.weight >= 10) logEvent(world, "social", `💭 ${c.name} slept on it: "${r.text}"`, 2, [c.id, ...(d.about ? [d.about] : [])]);
      return r;
    });
    if (learned.length) hook?.(world, c, learned);
  }
}
