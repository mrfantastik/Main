import { leaveJob } from "../economy/jobs";
import { logEvent } from "../events";
import { remember } from "../memory/memory";
import type { Citizen, Occupation, WorldState } from "../types";
import { money } from "../util";
import { occupationFit } from "../world";
import { inspiringStory, occupationBelief } from "./beliefs";
import type { Situation } from "./situation";

// Career moves. Each reachable occupation is a "career target" with its own
// feasibility rules, expected income and risk. The strategy layer scores
// them against the citizen's current career.

export interface CareerTarget {
  occupation: Occupation;
  risk: number;
  /** Null if possible, otherwise the reason it isn't. */
  feasible(world: WorldState, c: Citizen, s: Situation): string | null;
  /** Expected £/day for this citizen specifically. */
  expected(world: WorldState, c: Citizen): number;
  startCost(world: WorldState, c: Citizen): number;
  label(world: WorldState, c: Citizen): string;
  /** Perform the switch. */
  execute(world: WorldState, c: Citizen): void;
}

const targets = new Map<Occupation, CareerTarget>();

export function registerCareer(t: CareerTarget): void {
  targets.set(t.occupation, t);
}

export function careerTargets(): CareerTarget[] {
  return [...targets.values()];
}

export const OCC_NOUN: Record<Occupation, string> = {
  unemployed: "unemployed",
  employee: "an employee",
  freelancer: "a freelancer",
  shopkeeper: "a shopkeeper",
  reseller: "a reseller",
  trader: "a trader",
  entrepreneur: "an entrepreneur",
  researcher: "a researcher",
};

/** Switch occupation, with event + memory. */
export function changeCareer(world: WorldState, c: Citizen, occ: Occupation, why: string): void {
  const before = c.occupation;
  if (c.employerId) leaveJob(world, c, "quit");
  c.occupation = occ;
  c.occupationSince = world.time;
  c.lastCareerChangeT = world.time;
  c.finance.occupationEarnings = [];
  const verb = before === "employee" ? "quit their job" : before === "unemployed" ? "stopped job-hunting" : `gave up being ${OCC_NOUN[before]}`;
  logEvent(world, "job", `${c.name} ${verb} and became ${OCC_NOUN[occ]}. ${why}`, 3, [c.id]);
  remember(world, c, { text: `I became ${OCC_NOUN[occ]}. ${why}`, kind: "job", importance: 6, valence: 0.3, people: [] });
}

/** What the citizen expects to earn per day if they carry on as they are. */
export function currentExpected(world: WorldState, c: Citizen): number {
  if (c.occupation === "employee" && c.wage > 0) return c.wage;
  const own = c.finance.occupationEarnings.slice(-4);
  const belief = occupationBelief(c, c.occupation);
  if (own.length >= 2) return (own.reduce((a, b) => a + b, 0) / own.length) * 0.7 + belief * 0.3;
  if (c.occupation === "unemployed") return world.economy.welfare;
  return belief;
}

export function fitScore(c: Citizen, occ: Occupation): number {
  return (occupationFit(c.traits, occ) - 1.1) * 0.45;
}

// ---------------------------------------------------- built-in careers

registerCareer({
  occupation: "freelancer",
  risk: 0.35,
  feasible: (_w, c) => (c.skills.tech >= 15 ? null : "not enough tech skills"),
  expected: (world, c) => occupationBelief(c, "freelancer") * (0.6 + (c.skills.tech / 100) * 0.8),
  startCost: () => 0,
  label: () => "Go freelance",
  execute: (world, c) => changeCareer(world, c, "freelancer", "Freelance clients pay well if you have the skills."),
});

registerCareer({
  occupation: "researcher",
  risk: 0.2,
  feasible: (world, c) => {
    if (c.skills.research < 30) return "not enough research skill";
    const researchers = world.citizenOrder.filter((id) => world.citizens[id].occupation === "researcher").length;
    return researchers < world.economy.labPlaces ? null : "the Lab has no places";
  },
  expected: (world) => world.economy.grant * 1.05,
  startCost: () => 0,
  label: () => "Join the Research Lab",
  execute: (world, c) => changeCareer(world, c, "researcher", "The Lab had a place and I want to invent something."),
});

/** Explain a career idea in the citizen's own words. */
export function careerThought(world: WorldState, c: Citizen, occ: Occupation, expected: number, current: number): string {
  const story = inspiringStory(c, occ, current);
  if (story) {
    const who = world.citizens[story.citizenId]?.name ?? "Someone";
    const what = story.productId ? ` selling ${world.products[story.productId]?.name.toLowerCase() ?? story.productId}` : "";
    return `${who} is making ${money(story.amount)} a day as ${OCC_NOUN[occ].replace(/^an? /, "a ")}${what}. I should do that too.`;
  }
  if (c.occupation === "unemployed") return `I need income. Being ${OCC_NOUN[occ]} could bring in about ${money(expected)} a day.`;
  return `I make about ${money(current)} a day. As ${OCC_NOUN[occ]} I think I could make ${money(expected)}. Time for a change.`;
}
