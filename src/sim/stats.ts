import { netWorth } from "./economy/valuation";
import type { StatPoint, WorldState } from "./types";
import { pushRing, round2 } from "./util";

// Economy-wide statistics, sampled every game hour and every game day.

export const HOURLY_LIMIT = 24 * 10;
export const DAILY_LIMIT = 365;

export function gini(values: number[]): number {
  const v = values.map((x) => Math.max(0, x)).sort((a, b) => a - b);
  const n = v.length;
  const total = v.reduce((s, x) => s + x, 0);
  if (n === 0 || total === 0) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * v[i];
  return round2((2 * cum) / (n * total) - (n + 1) / n);
}

export function computeStats(world: WorldState, revenue: number, inflow: number, outflow: number): StatPoint {
  const cs = world.citizenOrder.map((id) => world.citizens[id]);
  const worths = cs.map((c) => netWorth(world, c));
  const sorted = [...worths].sort((a, b) => a - b);
  let totalMoney = 0;
  for (const c of cs) totalMoney += c.money + c.savings;
  for (const id of world.businessOrder) {
    const b = world.businesses[id];
    if (b.open) totalMoney += b.cash;
  }
  const unemployed = cs.filter((c) => c.occupation === "unemployed").length;
  return {
    t: world.time,
    totalMoney: round2(totalMoney),
    avgWealth: round2(worths.reduce((s, x) => s + x, 0) / Math.max(1, cs.length)),
    medianWealth: round2(sorted[Math.floor(sorted.length / 2)] ?? 0),
    gini: gini(worths),
    unemployment: round2(unemployed / Math.max(1, cs.length)),
    businesses: world.businessOrder.filter((id) => world.businesses[id].open).length,
    txCount: world.txCount,
    revenue: round2(revenue),
    inflow: round2(inflow),
    outflow: round2(outflow),
  };
}

export function statsHourly(world: WorldState): void {
  const s = world.stats;
  pushRing(s.hourly, computeStats(world, s.hourRevenue, s.hourInflow, s.hourOutflow), HOURLY_LIMIT);
  s.hourRevenue = 0;
  s.hourInflow = 0;
  s.hourOutflow = 0;
}

export function statsDaily(world: WorldState): void {
  const s = world.stats;
  pushRing(s.daily, computeStats(world, s.dayRevenue, s.dayInflow, s.dayOutflow), DAILY_LIMIT);
  s.dayRevenue = 0;
  s.dayInflow = 0;
  s.dayOutflow = 0;
  s.dayTx = 0;
}
