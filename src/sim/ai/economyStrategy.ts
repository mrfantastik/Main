import { CONFIG } from "../config";
import { activeLoans, deposit, maxBankLoan, outstanding, repay, takeBankLoan } from "../economy/bank";
import { addPartner, closeBusiness, createBusiness, KIND_INFO, openBusinesses, valuation } from "../economy/business";
import { leaveJob } from "../economy/jobs";
import { planBusiness, productOpportunity, type BusinessPlan } from "../economy/opportunity";
import { logEvent } from "../events";
import { remember, rememberBetrayal } from "../memory/memory";
import { adjustRel, peekRel } from "../social/relationships";
import type { Business, BusinessKind, Citizen, WorldState } from "../types";
import { money, pct, round2 } from "../util";
import { occupationBelief } from "./beliefs";
import { changeCareer, registerCareer } from "./careers";
import { recordDecision, setThought, type Option } from "./decision";
import { registerStrategyProvider, type StrategyOption } from "./strategy";
import type { Situation } from "./situation";

// Strategic options for the economy: becoming a reseller/trader, starting a
// business (borrowing if needed), running it (hire, fire, expand, close),
// and managing money (save, repay, invest).

function canFund(world: WorldState, c: Citizen, cost: number): { ok: boolean; loan: number } {
  const liquid = c.money + c.savings;
  const keep = 30;
  if (liquid - keep >= cost) return { ok: true, loan: 0 };
  const need = Math.ceil(cost - (liquid - keep));
  // Only those willing to take risks borrow to start up.
  if (c.traits.risk < 0.3 && c.traits.frugality > 0.7) return { ok: false, loan: 0 };
  return need <= maxBankLoan(world, c) ? { ok: true, loan: need } : { ok: false, loan: 0 };
}

/** Start a business per plan: borrow if needed, move in, stock up. */
export function launchBusiness(world: WorldState, c: Citizen, plan: BusinessPlan, occupation: "shopkeeper" | "entrepreneur"): Business | null {
  const fund = canFund(world, c, plan.startupCost);
  if (!fund.ok) return null;
  if (fund.loan > 0 && !takeBankLoan(world, c, fund.loan, `open a ${KIND_INFO[plan.kind].noun}`)) return null;
  if (c.money < plan.startupCost) {
    const need = Math.min(c.savings, plan.startupCost - c.money);
    c.savings = round2(c.savings - need);
    c.money = round2(c.money + need);
  }
  if (c.occupation !== occupation) {
    if (c.employerId) leaveJob(world, c, "quit");
    c.occupation = occupation;
    c.occupationSince = world.time;
    c.lastCareerChangeT = world.time;
    c.finance.occupationEarnings = [];
  }
  const b = createBusiness(world, c, plan.kind, plan.products, Math.min(c.money - 10, plan.startupCost));
  return b;
}

// ------------------------------------------------------------ careers

registerCareer({
  occupation: "reseller",
  risk: 0.45,
  feasible: (_w, c) => (c.money + c.savings >= 45 ? null : "need some cash to buy stock"),
  expected: (world, c) => {
    const bargains = world.listings.filter((l) => l.sellerId === "external").length;
    return occupationBelief(c, "reseller") * (0.55 + (c.skills.sales / 100) * 0.8) + bargains * 1.5;
  },
  startCost: () => 40,
  label: () => "Become a reseller",
  execute: (world, c) => changeCareer(world, c, "reseller", "There are bargains at the Marketplace if you know what things are worth."),
});

registerCareer({
  occupation: "trader",
  risk: 0.8,
  feasible: (_w, c) => (c.money + c.savings >= 150 ? null : "need capital to trade"),
  // Returns scale with capital; the confident expect more.
  expected: (_world, c) => occupationBelief(c, "trader") * 0.4 + (c.money + c.savings) * 0.05 * (0.5 + c.skills.trading / 100 + c.traits.risk * 0.5),
  startCost: () => 120,
  label: () => "Start trading on the Exchange",
  execute: (world, c) => changeCareer(world, c, "trader", "Prices go up and down. I can profit from that."),
});

function bestPlan(world: WorldState, c: Citizen, kinds: BusinessKind[]): BusinessPlan | null {
  let best: BusinessPlan | null = null;
  for (const k of kinds) {
    const p = planBusiness(world, c, k);
    if (!p || !canFund(world, c, p.startupCost).ok) continue;
    if (!best || p.expectedProfit - p.startupCost / 20 > best.expectedProfit - best.startupCost / 20) best = p;
  }
  return best;
}

registerCareer({
  occupation: "shopkeeper",
  risk: 0.5,
  feasible: (world, c) => (bestPlan(world, c, ["stall", "shop"]) ? null : "can't afford a shop or no premises"),
  expected: (world, c) => (bestPlan(world, c, ["stall", "shop"])?.expectedProfit ?? 0) * (0.55 + c.skills.sales / 200),
  startCost: (world, c) => bestPlan(world, c, ["stall", "shop"])?.startupCost ?? 999,
  label: (world, c) => {
    const p = bestPlan(world, c, ["stall", "shop"]);
    return p ? `Open a ${KIND_INFO[p.kind].noun} selling ${p.products.map((x) => world.products[x].name.toLowerCase()).join(" & ")}` : "Open a shop";
  },
  execute: (world, c) => {
    const p = bestPlan(world, c, ["stall", "shop"]);
    if (p) launchBusiness(world, c, p, "shopkeeper");
  },
  thought: (world, c) => businessIdeaThought(world, c, "shopkeeper"),
});

registerCareer({
  occupation: "entrepreneur",
  risk: 0.65,
  feasible: (world, c) => {
    if (c.traits.entrepreneurship < 0.35 && c.skills.management < 35) return "not the entrepreneurial type";
    return bestPlan(world, c, ["agency", "cafe", "shop"]) ? null : "can't fund a venture";
  },
  expected: (world, c) => (bestPlan(world, c, ["agency", "cafe", "shop"])?.expectedProfit ?? 0) * (0.5 + c.skills.management / 150),
  startCost: (world, c) => bestPlan(world, c, ["agency", "cafe", "shop"])?.startupCost ?? 999,
  label: (world, c) => {
    const p = bestPlan(world, c, ["agency", "cafe", "shop"]);
    return p ? `Start a ${KIND_INFO[p.kind].noun}${p.products.length ? ` (${p.products.map((x) => world.products[x].name.toLowerCase()).join(" & ")})` : ""}` : "Start a company";
  },
  execute: (world, c) => {
    const p = bestPlan(world, c, ["agency", "cafe", "shop"]);
    if (p) launchBusiness(world, c, p, "entrepreneur");
  },
  thought: (world, c) => businessIdeaThought(world, c, "entrepreneur"),
});

/** Business careers explain themselves with the plan's reasoning. */
export function businessIdeaThought(world: WorldState, c: Citizen, occ: "shopkeeper" | "entrepreneur"): string | null {
  const p = bestPlan(world, c, occ === "shopkeeper" ? ["stall", "shop"] : ["agency", "cafe", "shop"]);
  return p ? `${p.reason} Expected profit ~${money(p.expectedProfit)}/day.` : null;
}

// ---------------------------------------------- running a business

function businessOptions(world: WorldState, c: Citizen, s: Situation): StrategyOption[] {
  const out: StrategyOption[] = [];
  const mine = c.businessIds.map((id) => world.businesses[id]).filter((b): b is Business => !!b && b.open && b.ownerId === c.id);
  for (const b of mine) {
    const days = b.history.length;
    const wage = Math.round(world.economy.corpWage * (0.78 + c.traits.generosity * 0.3 - c.traits.greed * 0.15));
    // Hire.
    if (b.hiringWage === 0 && b.employees.length < 3) {
      const capacityLimited = b.kind !== "agency" && (b.missedYesterday > 3 || b.staffedHoursYesterday < 7);
      const agencyRoom = b.kind === "agency" && world.economy.servicePool > world.economy.serviceSupplied * 1.05;
      const wantsHelp = c.traits.diligence < 0.4 || c.traits.greed > 0.7 || c.age > 55;
      const stretched = mine.length > 1;
      const affordable = b.avgProfit > wage * (stretched ? 0.6 : 0.9) && b.cash > wage * 2;
      if (affordable && (capacityLimited || agencyRoom || wantsHelp || stretched) && days >= 2) {
        out.push({
          id: `hire:${b.id}`,
          label: `Hire staff for ${b.name} at ${money(wage)}/day`,
          factors: {
            profit: Math.min(0.8, b.avgProfit / 120),
            busy: capacityLimited || agencyRoom ? 0.35 : 0,
            stretched: stretched ? 0.5 : 0,
            delegate: wantsHelp ? 0.2 : 0,
            ambition: c.traits.ambition * 0.25,
            cost: -wage / 150,
          },
          payload: {
            stakes: wage * 7,
            execute: (w) => {
              b.hiringWage = wage;
              logEvent(w, "job", `📋 ${b.name} is hiring! ${money(wage)}/day.`, 3, [c.id], b.id);
            },
          },
          thought: stretched
            ? `I can't be in two places at once. ${b.name} needs someone running it.`
            : agencyRoom
            ? `Clients want more work than we can handle. ${b.name} needs another pair of hands.`
            : capacityLimited
              ? b.missedYesterday > 3
                ? `We turned away ${b.missedYesterday} customers yesterday. Time to hire someone for ${b.name}.`
                : `${b.name} was only open ${b.staffedHoursYesterday} hours yesterday. I need someone to mind the counter.`
              : `${b.name} makes enough that I can pay someone to run the counter.`,
        });
      }
    }
    // Fire.
    if (b.employees.length > 0 && b.avgProfit < -5 && days >= 2) {
      const e = b.employees[b.employees.length - 1];
      const emp = world.citizens[e.citizenId];
      if (emp) {
        const bondTo = peekRel(c, emp.id);
        out.push({
          id: `fire:${b.id}`,
          label: `Let ${emp.name} go`,
          factors: { losses: Math.min(1, -b.avgProfit / 40), wages: e.wage / 80, loyalty: -(bondTo ? bondTo.affinity / 120 : 0) - (c.family.includes(emp.id) ? 0.5 : 0), kindness: -c.traits.generosity * 0.3 },
          payload: {
            stakes: e.wage * 7,
            execute: (w) => {
              leaveJob(w, emp, "fired");
              logEvent(w, "job", `✂️ ${c.name} fired ${emp.name} from ${b.name}.`, 4, [c.id, emp.id], b.id);
              remember(w, emp, { text: `${c.name} fired me from ${b.name}.`, kind: "job", importance: 7, valence: -0.8, people: [c.id] });
              adjustRel(w, emp, c.id, { affinity: -20, trust: -15 });
            },
          },
          thought: `${b.name} is losing ${money(-b.avgProfit)} a day. I can't afford ${emp.name}'s wages any more.`,
        });
      }
    }
    // Close: losing money, or earning far less than an ordinary job would pay.
    const recent = b.history.slice(-5);
    const recentAvg = recent.reduce((a, h) => a + h.profit, 0) / Math.max(1, recent.length);
    const alternative = Math.max(world.economy.corpWage * 0.8, world.economy.streetIncome.freelancer ?? 30);
    if (days >= 5 && recentAvg < alternative * 0.45 && b.avgProfit < alternative * 0.5) {
      out.push({
        id: `close-move-on:${b.id}`,
        label: `Close ${b.name} and do something else`,
        factors: { underperforming: Math.min(1, (alternative * 0.5 - recentAvg) / 30), realism: (1 - c.traits.ambition) * 0.3, stubborn: -c.traits.entrepreneurship * 0.4 - c.traits.competitiveness * 0.15, sunkCost: -0.25 },
        payload: { stakes: b.ownerInvested, execute: (w) => closeBusiness(w, b, `it only made ${money(recentAvg)}/day — not worth it`, false) },
        thought: `${b.name} only makes ${money(recentAvg)} a day. I'd earn more working for someone else.`,
      });
    }
    if (b.avgProfit < -6 && days >= 4 && b.cash < CONFIG.rent[b.kind] * 4) {
      out.push({
        id: `close:${b.id}`,
        label: `Close ${b.name}`,
        factors: { losses: Math.min(1.2, -b.avgProfit / 30), cashGone: 0.3, stubborn: -c.traits.ambition * 0.35 - c.traits.risk * 0.2 },
        payload: { stakes: b.ownerInvested, execute: (w) => closeBusiness(w, b, "it kept losing money", false) },
        thought: `${b.name} has lost money ${days} days running. I have to cut my losses.`,
      });
    }
    // Add a product line.
    const info = KIND_INFO[b.kind];
    if (b.products.length < info.maxProducts && b.kind !== "agency" && days >= 2 && b.cash > 60) {
      const candidates = world.productOrder
        .filter((pid) => !b.products.includes(pid))
        .filter((pid) => b.kind !== "cafe" || ["essential", "consumable"].includes(world.products[pid].category))
        .map((pid) => productOpportunity(world, c, pid, b.kind))
        .sort((a, x) => x.profitPerDay - a.profitPerDay);
      const top = candidates[0];
      if (top && top.profitPerDay > 25) {
        const pname = world.products[top.pid].name;
        out.push({
          id: `addline:${b.id}:${top.pid}`,
          label: `Start selling ${pname.toLowerCase()} at ${b.name}`,
          factors: { opportunity: Math.min(0.8, top.profitPerDay / 100), ambition: c.traits.ambition * 0.25, risk: -(1 - c.traits.risk) * 0.15 },
          payload: {
            stakes: 60,
            execute: (w) => {
              b.products.push(top.pid);
              b.prices[top.pid] = round2(w.market[top.pid].retail * (0.95 + c.traits.greed * 0.1));
              logEvent(w, "business", `🆕 ${b.name} started selling ${w.products[top.pid].emoji} ${pname.toLowerCase()}.`, 3, [c.id], b.id);
            },
          },
          thought: top.story ? `${top.story}. I'll add it to ${b.name}.` : `${pname} have good margins (${money(top.margin)}/unit). Adding them to ${b.name}.`,
        });
      }
    }
  }
  // Expand: open another business when the first is thriving.
  const thriving = mine.find((b) => b.avgProfit > 45 && b.history.length >= 3);
  if (thriving && mine.length < 3 && c.traits.ambition > 0.45) {
    const plan = bestPlan(world, c, ["shop", "cafe", "agency", "stall"]);
    if (plan && plan.expectedProfit > 30) {
      out.push({
        id: "expand",
        label: `Expand: open a ${KIND_INFO[plan.kind].noun}${plan.products.length ? ` selling ${plan.products.map((x) => world.products[x].name.toLowerCase()).join(" & ")}` : ""}`,
        factors: { success: Math.min(0.8, thriving.avgProfit / 120), ambition: c.traits.ambition * 0.4 + c.traits.entrepreneurship * 0.3, risk: -(1 - c.traits.risk) * 0.3, cost: -plan.startupCost / (s.liquid + 100) },
        payload: { stakes: plan.startupCost, execute: (w, cc) => void launchBusiness(w, cc, plan, "entrepreneur") },
        thought: `${thriving.name} is making ${money(thriving.avgProfit)} a day. Time to build an empire. ${plan.reason}`,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------ money

function moneyOptions(world: WorldState, c: Citizen, s: Situation): StrategyOption[] {
  const out: StrategyOption[] = [];
  // Save surplus cash at the bank.
  const surplus = c.money - s.dailyCost * 4;
  if (surplus > 40) {
    const amount = round2(surplus * (0.4 + c.traits.frugality * 0.5));
    out.push({
      id: "deposit",
      label: `Put ${money(amount)} in savings`,
      factors: { prudence: c.traits.frugality * 0.5 + (1 - c.traits.risk) * 0.3, interest: 0.05 },
      payload: { stakes: 0, execute: (w, cc) => void deposit(w, cc, amount) },
      thought: `I've got ${money(c.money)} in my pocket. ${money(amount)} goes into savings.`,
    });
  }
  // Repay debts early.
  for (const l of activeLoans(world, c)) {
    const owed = outstanding(l);
    if (s.liquid < owed * 1.3 + s.dailyCost * 3) continue;
    const lender = l.lender === "bank" ? null : world.citizens[l.lender];
    out.push({
      id: `repay:${l.id}`,
      label: `Pay back ${lender ? lender.name : "the bank"} (${money(owed)}) early`,
      factors: { honour: 0.3 + c.traits.generosity * 0.3 - c.traits.greed * 0.2, relationship: lender ? (peekRel(c, lender.id)?.affinity ?? 0) / 200 : 0, interest: l.lender === "bank" ? 0.15 : 0 },
      payload: { stakes: owed, execute: (w) => void repay(w, l, owed) },
      thought: lender ? `I can afford to pay ${lender.name} back now. A debt is a debt.` : "I'll clear the bank loan early and save on interest.",
    });
  }
  // Invest in someone else's thriving business.
  const spare = s.liquid - s.dailyCost * 8 - 60;
  if (spare > 80 && world.time - (c.cooldowns.invested ?? -1e9) > 3 * 1440) {
    const targets = openBusinesses(world)
      .filter((b) => b.ownerId !== c.id && b.avgProfit > 20 && b.history.length >= 3 && !b.partners.some((p) => p.citizenId === c.id))
      .map((b) => ({ b, rel: peekRel(c, b.ownerId) }))
      .filter((x) => !rememberBetrayal(c, x.b.ownerId) && (x.rel?.trust ?? 0) > -10)
      .sort((a, x) => x.b.avgProfit - a.b.avgProfit);
    const t = targets[0];
    if (t) {
      const amount = Math.round(spare * (0.25 + c.traits.risk * 0.35));
      const val = valuation(world, t.b);
      const share = round2(Math.min(0.45, amount / (val + amount)));
      const owner = world.citizens[t.b.ownerId];
      out.push({
        id: `invest:${t.b.id}`,
        label: `Invest ${money(amount)} in ${t.b.name} for ${pct(share)}`,
        factors: { returns: Math.min(0.7, (t.b.avgProfit * share * 7) / amount), risk: c.traits.risk * 0.3 - (1 - c.traits.risk) * 0.25, trust: (t.rel?.trust ?? 0) / 150, ambition: c.traits.ambition * 0.2 },
        payload: {
          stakes: amount,
          execute: (w, cc) => {
            cc.cooldowns.invested = w.time;
            proposeInvestment(w, cc, t.b, amount, share);
          },
        },
        thought: `${t.b.name} makes ${money(t.b.avgProfit)} a day. A ${pct(share)} stake in ${owner?.name ?? "them"}'s business could pay off.`,
      });
    }
  }
  return out;
}

/** The owner decides whether to accept an investor's money for equity. */
export function proposeInvestment(world: WorldState, investor: Citizen, b: Business, amount: number, share: number): boolean {
  const owner = world.citizens[b.ownerId];
  if (!owner || !b.open) return false;
  const rel = peekRel(owner, investor.id);
  const factors: Record<string, number> = {
    needCash: b.cash < 150 ? 0.4 : 0,
    growth: owner.traits.ambition * 0.3,
    trust: (rel?.trust ?? 0) / 150 + (rel?.affinity ?? 0) / 200,
    control: -(owner.traits.greed * 0.4) - b.partners.reduce((s, p) => s + p.share, 0),
    betrayal: rememberBetrayal(owner, investor.id) ? -1 : 0,
  };
  const accept = Object.values(factors).reduce((a, x) => a + x, 0) > 0;
  const opts: Option<null>[] = [
    { id: "accept", label: `Sell ${investor.name} ${pct(share)} of ${b.name} for ${money(amount)}`, factors, payload: null, thought: `${investor.name} wants to invest ${money(amount)} in ${b.name}. Extra capital — deal.` },
    { id: "decline", label: "Keep full ownership", factors: { independence: 0 }, payload: null, thought: `${investor.name} wants ${pct(share)} of ${b.name}. No thanks — it's mine.` },
  ];
  const chosen = accept ? opts[0] : opts[1];
  recordDecision(world, owner, "reaction", opts, chosen, "utility", chosen.thought);
  setThought(world, owner, chosen.thought, 3);
  if (!accept) {
    remember(world, investor, { text: `${owner.name} turned down my investment in ${b.name}.`, kind: "deal", importance: 4, valence: -0.3, people: [owner.id] });
    return false;
  }
  if (!addPartner(world, b, investor, amount, share)) return false;
  logEvent(world, "finance", `🤝 ${investor.name} invested ${money(amount)} in ${b.name} for a ${pct(share)} stake. ${owner.name} and ${investor.name} are now business partners.`, 4, [investor.id, owner.id], b.id);
  remember(world, investor, { text: `I invested ${money(amount)} in ${owner.name}'s ${b.name} for ${pct(share)}.`, kind: "deal", importance: 7, valence: 0.5, people: [owner.id] });
  remember(world, owner, { text: `${investor.name} invested ${money(amount)} in ${b.name}.`, kind: "deal", importance: 7, valence: 0.7, people: [investor.id] });
  adjustRel(world, owner, investor.id, { affinity: 10, trust: 10, familiarity: 10 });
  adjustRel(world, investor, owner.id, { affinity: 6, trust: 6, familiarity: 10 });
  return true;
}

registerStrategyProvider(businessOptions);
registerStrategyProvider(moneyOptions);
