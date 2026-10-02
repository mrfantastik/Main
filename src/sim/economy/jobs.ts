import { registerAction } from "../ai/actions";
import { logEvent } from "../events";
import { remember } from "../memory/memory";
import { chance } from "../rng";
import { addRole, adjustRel, removeRole } from "../social/relationships";
import type { Citizen, PlannedAction, WorldState } from "../types";
import { money, pushRing, round2 } from "../util";
import { businessAcc, citizenAcc, creditOccupation, externalAcc, transfer } from "./ledger";

// Employment: CityCorp (the big external employer with limited openings)
// and jobs at citizen-run businesses.

export const SHIFT_MINUTES = 480;

export function corpOpenings(world: WorldState): number {
  return Math.max(0, world.economy.corpOpenings - world.corpEmployees.length);
}

export function corpWageFor(world: WorldState, c: Citizen): number {
  const skill = (c.skills.tech + c.skills.management) / 2;
  return Math.round(world.economy.corpWage * (0.85 + skill / 220));
}

export function employerName(world: WorldState, employerId: string | null): string {
  if (!employerId) return "nobody";
  if (employerId === "corp") return "CityCorp";
  return world.businesses[employerId]?.name ?? "a closed business";
}

export function hireAtCorp(world: WorldState, c: Citizen): void {
  leaveJob(world, c, "switch");
  c.occupation = "employee";
  c.occupationSince = world.time;
  c.employerId = "corp";
  c.wage = corpWageFor(world, c);
  world.corpEmployees.push(c.id);
  logEvent(world, "job", `${c.name} got a job at CityCorp (${money(c.wage)}/day).`, 2, [c.id]);
  remember(world, c, { text: `CityCorp hired me at ${money(c.wage)} a day.`, kind: "job", importance: 6, valence: 0.6, people: [] });
  // Colleagues get to know each other.
  for (const id of world.corpEmployees) {
    if (id === c.id) continue;
    const o = world.citizens[id];
    adjustRel(world, c, id, { familiarity: 10 });
    adjustRel(world, o, c.id, { familiarity: 10 });
  }
}

/** Employ a citizen at a citizen-run business. */
export function hireAtBusiness(world: WorldState, c: Citizen, businessId: string, wage: number): void {
  const b = world.businesses[businessId];
  if (!b) return;
  leaveJob(world, c, "switch");
  c.occupation = "employee";
  c.occupationSince = world.time;
  c.employerId = b.id;
  c.wage = round2(wage);
  b.employees.push({ citizenId: c.id, wage: c.wage, since: world.time });
  b.hiringWage = 0;
  const owner = world.citizens[b.ownerId];
  if (owner) {
    addRole(c, owner.id, "employer");
    addRole(owner, c.id, "employee");
    adjustRel(world, c, owner.id, { affinity: 12, trust: 8, familiarity: 15 });
    adjustRel(world, owner, c.id, { affinity: 6, familiarity: 15 });
    logEvent(world, "job", `${owner.name} hired ${c.name} at ${b.name} (${money(wage)}/day).`, 3, [owner.id, c.id], b.id);
    remember(world, c, { text: `${owner.name} gave me a job at ${b.name} for ${money(wage)} a day.`, kind: "favor", importance: 7, valence: 0.7, people: [owner.id], key: `hired:${owner.id}` });
    remember(world, owner, { text: `I hired ${c.name} at ${b.name}.`, kind: "business", importance: 5, valence: 0.3, people: [c.id] });
  }
}

export type LeaveReason = "quit" | "fired" | "laid_off" | "business_closed" | "switch";

/** End a citizen's employment (if any). */
export function leaveJob(world: WorldState, c: Citizen, reason: LeaveReason): void {
  const emp = c.employerId;
  if (!emp) return;
  c.employerId = null;
  c.wage = 0;
  if (emp === "corp") {
    world.corpEmployees = world.corpEmployees.filter((id) => id !== c.id);
  } else {
    const b = world.businesses[emp];
    if (b) {
      b.employees = b.employees.filter((e) => e.citizenId !== c.id);
      const owner = world.citizens[b.ownerId];
      if (owner) {
        removeRole(c, owner.id, "employer");
        removeRole(owner, c.id, "employee");
      }
    }
  }
  if (reason !== "switch" && c.occupation === "employee") {
    c.occupation = "unemployed";
    c.occupationSince = world.time;
  }
  c.reviewRequested = c.reviewRequested ?? `left job (${reason})`;
}

export function registerJobActions(): void {
  registerAction("WORK", {
    kind: "work",
    validate(world, c, a) {
      const role = String(a.params.role ?? "");
      if (role === "corp") return c.employerId === "corp" ? null : "Not employed at CityCorp";
      if (role === "business") {
        const b = c.employerId ? world.businesses[c.employerId] : undefined;
        return b && b.open ? null : "No employer to work for";
      }
      if (role === "freelance") return c.occupation === "freelancer" ? null : "Not a freelancer";
      return "Unknown kind of work";
    },
    complete(world, c, a, minutes) {
      c.workedToday += minutes;
      const role = String(a.params.role);
      const hours = minutes / 60;
      if (role === "corp") {
        const pay = round2((c.wage * Math.min(minutes, SHIFT_MINUTES * 1.2)) / SHIFT_MINUTES);
        if (pay > 0) {
          transfer(world, externalAcc("citycorp"), citizenAcc(c.id), pay, "salary", `CityCorp pay (${hours.toFixed(1)}h)`);
          creditOccupation(world, c.id, pay);
        }
        c.skills.management = Math.min(100, c.skills.management + hours * 0.04);
        c.skills.tech = Math.min(100, c.skills.tech + hours * 0.05);
      } else if (role === "business") {
        payBusinessWage(world, c, minutes);
        c.skills.sales = Math.min(100, c.skills.sales + hours * 0.06);
      } else if (role === "freelance") {
        const earned = round2(Number(a.params.earned ?? 0));
        if (earned > 0) {
          transfer(world, externalAcc("clients"), citizenAcc(c.id), earned, "gig", `Freelance work (${hours.toFixed(1)}h)`);
          creditOccupation(world, c.id, earned);
          c.cooldowns.lastGigEarned = earned;
        }
        c.skills.tech = Math.min(100, c.skills.tech + hours * 0.08);
      }
    },
  });

  registerAction("APPLY_FOR_JOB", {
    kind: "job_hunt",
    complete(world, c, a: PlannedAction, minutes) {
      c.cooldowns.jobHunt = world.time;
      if (minutes < 20) return;
      const target = String(a.params.target ?? "corp");
      if (target === "corp") {
        if (corpOpenings(world) <= 0) {
          remember(world, c, { text: "CityCorp had no openings.", kind: "job", importance: 3, valence: -0.3, people: [], key: "corp-no-openings" });
          return;
        }
        const avgSkill = (c.skills.tech + c.skills.management + c.skills.sales) / 3;
        if (chance(world, 0.35 + avgSkill / 200 + c.traits.diligence * 0.2)) {
          hireAtCorp(world, c);
        } else {
          remember(world, c, { text: "CityCorp turned down my application.", kind: "job", importance: 4, valence: -0.5, people: [], key: "corp-rejected" });
        }
      }
    },
  });
}

/** Pay an employee of a citizen-run business for a shift. */
function payBusinessWage(world: WorldState, c: Citizen, minutes: number): void {
  const b = c.employerId ? world.businesses[c.employerId] : undefined;
  if (!b) return;
  const pay = round2((c.wage * Math.min(minutes, SHIFT_MINUTES * 1.2)) / SHIFT_MINUTES);
  if (pay <= 0) return;
  b.today.wages += pay;
  if (transfer(world, businessAcc(b.id), citizenAcc(c.id), pay, "wage", `Wages from ${b.name}`)) {
    creditOccupation(world, c.id, pay);
    return;
  }
  // The business can't pay. That hurts.
  b.unpaidWages = round2(b.unpaidWages + pay);
  c.unpaidWages = round2(c.unpaidWages + pay);
  const owner = world.citizens[b.ownerId];
  if (owner) {
    adjustRel(world, c, owner.id, { affinity: -10, trust: -14 });
    remember(world, c, { text: `${owner.name} couldn't pay my wages at ${b.name}.`, kind: "betrayal", importance: 6, valence: -0.7, people: [owner.id], key: `unpaid:${b.id}` });
  }
}

/** Daily: CityCorp reviews attendance and adjusts to the economy. */
export function corpDaily(world: WorldState): void {
  for (const id of world.citizenOrder) {
    const c = world.citizens[id];
    pushRing(c.workLog, c.workedToday, 5);
    c.workedToday = 0;
  }
  // Fire chronic no-shows (lazy citizens eventually pay for it).
  for (const id of [...world.corpEmployees]) {
    const c = world.citizens[id];
    const recent = c.workLog.slice(-3);
    if (recent.length === 3 && recent.reduce((s, v) => s + v, 0) / 3 < 180 && world.time - c.occupationSince > 3 * 1440) {
      leaveJob(world, c, "fired");
      logEvent(world, "job", `CityCorp fired ${c.name} for poor attendance.`, 3, [c.id]);
      remember(world, c, { text: "CityCorp fired me for not turning up.", kind: "job", importance: 7, valence: -0.8, people: [] });
    }
  }
  // Layoffs when the economy shrinks.
  while (world.corpEmployees.length > world.economy.corpOpenings) {
    const victims = world.corpEmployees.map((id) => world.citizens[id]).sort((a, b) => a.skills.tech + a.skills.management - (b.skills.tech + b.skills.management));
    const v = victims[0];
    leaveJob(world, v, "laid_off");
    logEvent(world, "job", `CityCorp laid off ${v.name} as the economy slows.`, 4, [v.id]);
    remember(world, v, { text: "I was laid off from CityCorp in the downturn.", kind: "job", importance: 7, valence: -0.8, people: [] });
  }
}
