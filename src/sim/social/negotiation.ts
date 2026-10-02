import { situation } from "../ai/situation";
import { maxBankLoan } from "../economy/bank";
import { valuation } from "../economy/business";
import { netWorth } from "../economy/valuation";
import { recallAbout, rememberBetrayal } from "../memory/memory";
import type { Business, Citizen, WorldState } from "../types";
import { clamp, round2 } from "../util";
import { getRel } from "./relationships";

// The engine's side of every negotiation: what each party is actually
// willing to do, given their money, personality, relationship and memories.
// Dialogue (templates or Claude) must stay inside these limits; the engine
// validates the outcome against them before any money moves.

export interface LoanTerms {
  requested: number;
  purpose: string;
  willing: boolean;
  /** Most the lender will lend. */
  maxLend: number;
  /** Lowest interest the lender accepts (0.1 = 10%). */
  minRate: number;
  /** Highest interest the borrower accepts. */
  maxRate: number;
  days: number;
  /** Why the lender is (un)willing — fed to dialogue. */
  why: string;
}

function goodHistory(lender: Citizen, borrowerId: string): number {
  const mems = recallAbout(lender, borrowerId, 8);
  let score = 0;
  for (const m of mems) {
    if (m.kind === "favor" && m.valence > 0) score += 0.25 * m.count;
    if (m.kind === "betrayal") score -= 1;
    if (m.kind === "loan" && m.valence < 0) score -= 0.3;
  }
  return clamp(score, -1.5, 0.75);
}

export function loanTerms(world: WorldState, borrower: Citizen, lender: Citizen, requested: number, purpose: string): LoanTerms {
  const ls = situation(world, lender);
  const bs = situation(world, borrower);
  const rel = getRel(lender, borrower.id);
  const family = lender.family.includes(borrower.id);
  const betrayed = !!rememberBetrayal(lender, borrower.id);
  const history = goodHistory(lender, borrower.id);
  const surplus = Math.max(0, ls.liquid - ls.dailyCost * 5);
  const maxLend = round2(surplus * (0.25 + lender.traits.generosity * 0.35 + lender.traits.risk * 0.15 + (family ? 0.2 : 0)));
  const willingness =
    0.15 + (rel.trust + rel.affinity) / 220 + lender.traits.generosity * 0.4 - lender.traits.greed * 0.2 + (family ? 0.45 : 0) + history - (betrayed ? 1.5 : 0) + (bs.incomeAvg > 25 ? 0.1 : -0.1);
  const minRate = clamp(round2(0.04 + lender.traits.greed * 0.22 + (1 - (rel.trust + 100) / 200) * 0.12 - (family ? 0.15 : 0) - rel.affinity / 1000), 0, 0.45);
  const maxRate = clamp(round2(0.08 + bs.pressure * 0.2 + (1 - borrower.traits.frugality) * 0.08 + borrower.traits.risk * 0.06), 0.03, 0.5);
  const willing = willingness >= 0.3 && maxLend >= Math.min(15, requested * 0.4);
  const why = betrayed
    ? "the borrower betrayed them before"
    : !willing && maxLend < 15
      ? "they can't spare the money"
      : !willing
        ? "they don't trust the borrower enough"
        : family
          ? "they're family"
          : history > 0
            ? "the borrower has paid them back before"
            : rel.affinity > 35
              ? "they're friends"
              : "it could earn some interest";
  return { requested: Math.round(requested), purpose, willing, maxLend: Math.floor(Math.min(maxLend, requested * 1.2)), minRate, maxRate, days: family ? 10 : 6 + Math.round(lender.traits.generosity * 4), why };
}

/** Deterministic haggle: settle between both limits, or no deal. */
export function settleLoan(t: LoanTerms): { agreed: boolean; amount: number; rate: number; days: number } {
  if (!t.willing || t.minRate > t.maxRate + 1e-9) return { agreed: false, amount: 0, rate: 0, days: t.days };
  const amount = Math.floor(Math.min(t.requested, t.maxLend));
  if (amount < 10) return { agreed: false, amount: 0, rate: 0, days: t.days };
  return { agreed: true, amount, rate: round2((t.minRate + Math.min(t.maxRate, t.minRate + 0.15)) / 2), days: t.days };
}

export interface InvestmentTerms {
  amount: number;
  willing: boolean;
  /** Investor wants at least this share. */
  minShare: number;
  /** Owner will give at most this share. */
  maxShare: number;
  why: string;
}

export function investmentTerms(world: WorldState, owner: Citizen, investor: Citizen, b: Business, ask: number): InvestmentTerms {
  const is = situation(world, investor);
  const rel = getRel(investor, owner.id);
  const val = valuation(world, b);
  const spare = Math.max(0, is.liquid - is.dailyCost * 6 - 40);
  const amount = Math.floor(Math.min(ask, spare * (0.3 + investor.traits.risk * 0.4)));
  const returns = (Math.max(0, b.avgProfit) * 30) / Math.max(1, val);
  const willing = amount >= 30 && !rememberBetrayal(investor, owner.id) && returns * (0.5 + investor.traits.risk) + rel.trust / 150 + rel.affinity / 250 + investor.traits.ambition * 0.2 > 0.35;
  const fair = amount / (val + amount);
  const minShare = round2(clamp(fair * (1 + investor.traits.greed * 0.4), 0.02, 0.6));
  const maxShare = round2(clamp(fair * (1.5 - owner.traits.greed * 0.5) + (b.cash < 60 ? 0.05 : 0), 0.02, 0.49));
  return {
    amount,
    willing,
    minShare,
    maxShare,
    why: willing ? `the business makes about £${Math.round(b.avgProfit)} a day` : amount < 30 ? "they don't have spare cash" : "they don't believe in the business",
  };
}

export interface JobTerms {
  businessId: string;
  /** Most the employer will pay per day. */
  maxWage: number;
  /** Least the worker will accept. */
  minWage: number;
  willing: boolean;
  why: string;
}

/** How many staff each kind of business can use. */
export const MAX_STAFF: Record<string, number> = { stall: 1, shop: 2, cafe: 2, agency: 4 };

/** Does the business actually need another pair of hands? */
export function needsStaff(world: WorldState, b: Business): boolean {
  if (b.employees.length >= (MAX_STAFF[b.kind] ?? 1)) return false;
  if (b.hiringWage > 0) return true;
  const owner = world.citizens[b.ownerId];
  const stretched = owner ? owner.businessIds.filter((id) => world.businesses[id]?.open).length > 1 : false;
  if (b.kind === "agency") return world.economy.servicePool > world.economy.serviceSupplied * 1.05;
  return stretched || b.missedYesterday > 3 || (b.staffedHoursYesterday < 7 && b.employees.length === 0);
}

export function jobTerms(world: WorldState, owner: Citizen, worker: Citizen, b: Business): JobTerms {
  const rel = getRel(owner, worker.id);
  const ws = situation(world, worker);
  const skill = b.kind === "agency" ? worker.skills.tech : (worker.skills.sales + worker.skills.management) / 2;
  const payroll = b.employees.reduce((s, e) => s + e.wage, 0);
  const budget = Math.max(0, b.avgProfit * 0.7 + b.cash / 12 - payroll * 0.5);
  const maxWage = Math.round(Math.min(budget, world.economy.corpWage * (0.75 + skill / 200 + owner.traits.generosity * 0.2)));
  const current = worker.occupation === "employee" ? worker.wage : worker.occupation === "unemployed" ? world.economy.welfare * 2 : Math.max(15, ws.occEarnAvg);
  const minWage = Math.round(Math.max(18, current * (1.02 + worker.traits.greed * 0.15) - ws.pressure * 8));
  const betrayed = !!rememberBetrayal(owner, worker.id);
  const need = needsStaff(world, b);
  const willing = !betrayed && rel.affinity > -25 && maxWage >= 18 && need;
  return {
    businessId: b.id,
    maxWage,
    minWage,
    willing,
    why: betrayed ? "the worker betrayed them before" : !need ? "they don't need more staff" : !willing ? "the business can't afford staff" : rel.affinity > 30 ? "they're friends" : "they need help",
  };
}

export interface HelpTerms {
  gift: number;
  willing: boolean;
}

export function helpTerms(world: WorldState, helper: Citizen, needy: Citizen): HelpTerms {
  const hs = situation(world, helper);
  const rel = getRel(helper, needy.id);
  const family = helper.family.includes(needy.id);
  const spare = Math.max(0, hs.liquid - hs.dailyCost * 4);
  const gift = Math.floor(Math.min(35, spare * (0.05 + helper.traits.generosity * 0.2 + (family ? 0.15 : 0))));
  const willing = gift >= 5 && !rememberBetrayal(helper, needy.id) && helper.traits.generosity * 0.6 + (rel.affinity + rel.trust) / 200 + (family ? 0.5 : 0) - helper.traits.greed * 0.3 > 0.35;
  return { gift, willing };
}

/** A rough "who can afford to lend" guess, as a citizen sees it. */
export function lookWealthy(world: WorldState, c: Citizen): number {
  return netWorth(world, c);
}

export function bankWouldLend(world: WorldState, c: Citizen, amount: number): boolean {
  return maxBankLoan(world, c) >= amount;
}
