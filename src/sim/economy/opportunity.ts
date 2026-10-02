import { CONFIG } from "../config";
import type { BusinessKind, Citizen, ProductId, WorldState } from "../types";
import { money, round2 } from "../util";
import { findPremises, KIND_INFO, sellersOf } from "./business";
import { listingsFor, refPrice } from "./market";
import { providerCapacity } from "./services";
import { maxBankLoan } from "./bank";

// How a citizen sizes up a business idea, using what they can see (the
// market board: prices, trends, unmet demand, who's selling what) and what
// they've heard (success stories). Different people see different
// opportunities because of their beliefs and personalities.

export interface ProductOpportunity {
  pid: ProductId;
  profitPerDay: number;
  units: number;
  margin: number;
  competitors: number;
  unmet: number;
  story: string | null;
}

/** Internal (citizen) demand per day for everyday products. */
const INTERNAL_DEMAND: Record<string, number> = { food: 8, coffee: 6 };

export function productOpportunity(world: WorldState, c: Citizen, pid: ProductId, kind: BusinessKind): ProductOpportunity {
  const p = world.products[pid];
  const m = world.market[pid];
  const demand = p.externalDemand * m.trend * world.economy.multiplier + (INTERNAL_DEMAND[pid] ?? 0.5);
  const competitors = sellersOf(world, pid).length + (listingsFor(world, pid).some((l) => l.sellerId !== "external") ? 0.5 : 0);
  const unmet = m.unmetYesterday;
  const share = Math.min(1, 1 / (competitors + 1) + (unmet > 2 ? 0.25 : 0));
  const capacityPerDay = (CONFIG.capacityBase + CONFIG.capacityPerStaff) * KIND_INFO[kind].capacityMult * 8;
  const units = Math.min(demand * share * 0.75, capacityPerDay);
  // Expect to sell a bit under the reference price, more so with competition.
  const margin = refPrice(world, pid) * (0.95 - Math.min(0.15, competitors * 0.04)) - m.wholesale;
  let profit = units * margin;
  // What they've heard matters: a friend's success makes it look better.
  let story: string | null = null;
  const s = c.beliefs.stories.filter((x) => x.productId === pid).sort((a, b) => b.amount - a.amount)[0];
  if (s) {
    profit *= 1 + 0.15 + c.traits.competitiveness * 0.25;
    story = `${world.citizens[s.citizenId]?.name ?? "Someone"} is making ${money(s.amount)} a day selling ${p.name.toLowerCase()}`;
  }
  const insight = c.beliefs.insights.find((i) => i.productId === pid && i.startT > world.time - 1440);
  if (insight) profit *= insight.kind === "hype" ? 1.6 : 0.4;
  return { pid, profitPerDay: round2(profit), units: round2(units), margin: round2(margin), competitors, unmet, story };
}

/** Personal optimism about business plans (entrepreneurs see rosier futures). */
export function optimism(c: Citizen): number {
  return 0.5 + c.traits.entrepreneurship * 0.25 + c.traits.ambition * 0.15 + c.traits.risk * 0.1;
}

export interface BusinessPlan {
  kind: BusinessKind;
  products: ProductId[];
  expectedProfit: number;
  startupCost: number;
  reason: string;
}

function stockCostOne(world: WorldState, pid: ProductId, units: number): number {
  return Math.max(3, Math.ceil(units * 1.3)) * world.market[pid].wholesale;
}

/** How much a citizen could put into a venture (cash + savings + a bank loan if they'd take one). */
export function fundingCapacity(world: WorldState, c: Citizen): number {
  const own = c.money + c.savings - 30;
  const borrows = !(c.traits.risk < 0.3 && c.traits.frugality > 0.7);
  return Math.max(0, own + (borrows ? maxBankLoan(world, c) : 0));
}

export function planBusiness(world: WorldState, c: Citizen, kind: BusinessKind, budget = fundingCapacity(world, c)): BusinessPlan | null {
  if (!findPremises(world, kind)) return null;
  const rent = CONFIG.rent[kind];
  if (kind === "agency") {
    // The services pie is shared with every freelancer and agency in town.
    const pool = world.economy.serviceDemand * world.economy.multiplier;
    let rivals = 0;
    for (const id of world.citizenOrder) {
      const x = world.citizens[id];
      if (x.id === c.id) continue;
      if (x.occupation === "freelancer") rivals += providerCapacity(x) * 8;
      else if (x.employerId && world.businesses[x.employerId]?.kind === "agency") rivals += providerCapacity(x) * 8 * 1.2;
      else if (x.businessIds.some((bid) => world.businesses[bid]?.open && world.businesses[bid].kind === "agency")) rivals += providerCapacity(x) * 8 * 1.2;
    }
    const myCap = providerCapacity(c) * 1.3 * 9;
    const unmetPerDay = Math.max(0, world.economy.servicePool - world.economy.serviceSupplied) * 12;
    const revenue = Math.min(myCap, pool * (myCap / (rivals + myCap)));
    const expected = round2((revenue - rent) * optimism(c));
    return {
      kind,
      products: [],
      expectedProfit: expected,
      startupCost: rent * 4 + 40,
      reason: unmetPerDay > 20 ? `Clients want more work than freelancers can deliver (${money(unmetPerDay)}/day going begging). An agency could take it.` : `With a team I could take on bigger clients than a lone freelancer.`,
    };
  }
  const candidates = kind === "cafe" ? world.productOrder.filter((pid) => world.products[pid].category === "essential" || world.products[pid].category === "consumable") : world.productOrder;
  const opps = candidates.map((pid) => productOpportunity(world, c, pid, kind)).sort((a, b) => b.profitPerDay - a.profitPerDay);
  if (opps.length === 0) return null;
  // Greedily pick the most profitable products that fit the budget.
  const maxProducts = kind === "cafe" ? 2 : Math.min(KIND_INFO[kind].maxProducts, 2);
  let spend = rent * 3;
  const chosen: ProductOpportunity[] = [];
  const ordered = kind === "cafe" ? [...opps.filter((o) => o.pid === "food"), ...opps.filter((o) => o.pid !== "food")] : opps;
  for (const o of ordered) {
    if (chosen.length >= maxProducts || o.profitPerDay <= 0) continue;
    const cost = stockCostOne(world, o.pid, o.units);
    if (spend + cost > budget) continue;
    chosen.push(o);
    spend += cost;
  }
  if (chosen.length === 0) return null;
  const products = chosen.map((o) => o.pid);
  const internalMeals = kind === "cafe" ? 5 * 2.5 : 0;
  const expected = round2((chosen.reduce((s, o) => s + o.profitPerDay, 0) * 0.85 + internalMeals - rent) * optimism(c));
  const top = chosen[0];
  const pname = world.products[top.pid].name.toLowerCase();
  const reason = top.story
    ? `${top.story}. I should compete.`
    : top.unmet > 2
      ? `Nobody in town can sell enough ${pname} — customers are leaving empty-handed. That's my opening.`
      : top.competitors === 0
        ? `Nobody is selling ${pname}. Margins are ${money(top.margin)} a unit.`
        : `${world.products[top.pid].name} sell for ${money(refPrice(world, top.pid))} but cost ${money(world.market[top.pid].wholesale)} wholesale. There's money in that.`;
  return { kind, products, expectedProfit: expected, startupCost: round2(spend), reason };
}
