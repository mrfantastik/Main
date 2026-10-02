import { rentOf } from "../economy/housing";
import { clockOf, dayOf, daysUntilRent } from "../time";
import type { Citizen, WorldState } from "../types";
import { avg, clamp, money } from "../util";

// A citizen's view of their own situation, computed fresh at each decision.
// These numbers are the raw material for utility factors and thoughts.

export interface Situation {
  t: number;
  hour: number;
  day: number;
  cash: number;
  liquid: number;
  rent: number;
  rentDueIn: number;
  /** Money worries 0 (relaxed) .. ~1.5 (panic). */
  pressure: number;
  /** Estimated £ needed per day to live. */
  dailyCost: number;
  runwayDays: number;
  incomeAvg: number;
  occEarnAvg: number;
  /** Minutes they intend to work per day. */
  workTarget: number;
  hungry: number;
  tired: number;
  lonely: number;
  bored: number;
  /** Short human description of money worries, for thoughts. */
  worry: string | null;
}

export function situation(world: WorldState, c: Citizen): Situation {
  const t = world.time;
  const rent = rentOf(world, c);
  const rentDueIn = daysUntilRent(t);
  const liquid = c.money + c.savings;
  const dailyCost = rent / 7 + 16;
  const runwayDays = liquid / dailyCost;
  const hist = c.finance.history.slice(-3);
  const incomeAvg = hist.length ? avg(hist.map((h) => h.income)) : 0;
  const occ = c.finance.occupationEarnings.slice(-3);
  const occEarnAvg = occ.length ? avg(occ) : 0;

  let pressure = clamp(1 - runwayDays / 8, 0, 1);
  let worry: string | null = null;
  if (rent > 0 && rentDueIn <= 2 && liquid < rent * 1.15) {
    pressure += 0.5;
    worry = `I only have ${money(liquid)} and my rent (${money(rent)}) is due ${rentDueIn === 1 ? "tonight" : "in 2 days"}. I need income.`;
  } else if (c.rentArrears > 0) {
    pressure += 0.5;
    worry = `I owe the landlord ${money(c.rentArrears)}. If I don't pay I'll be evicted.`;
  } else if (runwayDays < 3) {
    worry = `I'm down to ${money(liquid)}. That won't last long.`;
  }
  const debts = world.loans.filter((l) => l.borrower === c.id && l.status === "active");
  if (debts.length) pressure += 0.15 * debts.length;
  if (c.homeless) pressure += 0.3;

  return {
    t,
    hour: clockOf(t),
    day: dayOf(t),
    cash: c.money,
    liquid,
    rent,
    rentDueIn,
    pressure: clamp(pressure, 0, 1.6),
    dailyCost,
    runwayDays,
    incomeAvg,
    occEarnAvg,
    workTarget: 480 * (0.55 + c.traits.diligence * 0.6 + c.traits.ambition * 0.15),
    hungry: (100 - c.needs.hunger) / 100,
    tired: (100 - c.needs.energy) / 100,
    lonely: (100 - c.needs.social) / 100,
    bored: (100 - c.needs.fun) / 100,
    worry,
  };
}

/** Penalty for spending `cost` given how tight money is and how frugal they are. */
export function costPenalty(c: Citizen, s: Situation, cost: number): number {
  if (cost <= 0) return 0;
  return (cost / Math.max(8, s.liquid)) * (2 + c.traits.frugality * 3) + s.pressure * 0.4 * (cost / 10);
}
