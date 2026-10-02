import type {
  AIStatusDTO,
  ConversationDTO,
  BubbleDTO,
  BusinessDetail,
  BusinessSummary,
  CitizenDetail,
  CitizenSummary,
  DashboardMsg,
  FrameMsg,
  LoanDTO,
  MarketRow,
  StateMsg,
} from "../shared/protocol";
import { getBuildingIndexed } from "./city/lookup";
import { employerName } from "./economy/jobs";
import { findTx } from "./economy/ledger";
import { debtsOf, netWorth } from "./economy/valuation";
import { breakthroughThreshold } from "./economy/research";
import { recentMemories } from "./memory/memory";
import { relLabel } from "./social/relationships";
import { dayOf, formatTime } from "./time";
import type { Business, Citizen, Conversation, Loan, Transaction, WorldState } from "./types";
import { avg, round2 } from "./util";

// Converts the internal world state into compact messages for the UI.
// The UI never sees (or mutates) the live world directly.

export function accountName(world: WorldState, acc: string): string {
  const id = acc.slice(2);
  if (acc.startsWith("c:")) return world.citizens[id]?.name ?? id;
  if (acc.startsWith("b:")) return world.businesses[id]?.name ?? id;
  const names: Record<string, string> = {
    landlord: "Landlord",
    diner: "City Diner",
    pub: "The Gilded Pint",
    citycorp: "CityCorp",
    clients: "Outside clients",
    institute: "Research Institute",
    welfare: "Welfare office",
    depot: "Wholesale Depot",
    visitors: "Visitors",
    bank: "Hustle Bank",
    exchange: "Exchange",
    god: "⚡ God",
    market: "Marketplace buyers",
  };
  return names[id] ?? id;
}

function txDTO(world: WorldState, tx: Transaction) {
  return { ...tx, fromName: accountName(world, tx.from), toName: accountName(world, tx.to) };
}

export function frame(world: WorldState, speed: number, paused: boolean): FrameMsg {
  return {
    type: "frame",
    t: world.time,
    speed,
    paused,
    c: world.citizenOrder.map((id) => {
      const c = world.citizens[id];
      return [c.id, round2(c.pos.x), round2(c.pos.y), c.activity.kind, c.insideId];
    }),
  };
}

export function citizenSummary(world: WorldState, c: Citizen): CitizenSummary {
  return {
    id: c.id,
    name: c.name,
    color: c.color,
    occupation: c.occupation,
    employer: c.employerId ? employerName(world, c.employerId) : null,
    money: round2(c.money + c.savings),
    netWorth: netWorth(world, c),
    activity: c.activity.label,
    activityKind: c.activity.kind,
    goal: c.goal.label,
    thought: c.thought,
    thoughtSource: c.thoughtSource,
    mood: Math.round(c.mood),
    homeless: c.homeless,
    archetypes: c.archetypes,
    businessIds: c.businessIds,
    awaitingAI: c.awaitingAI,
  };
}

export function businessSummary(world: WorldState, b: Business): BusinessSummary {
  const stock: Record<string, number> = {};
  for (const p of b.products) stock[p] = b.inventory[p]?.qty ?? 0;
  return {
    id: b.id,
    name: b.name,
    kind: b.kind,
    ownerId: b.ownerId,
    ownerName: world.citizens[b.ownerId]?.name ?? "?",
    buildingId: b.buildingId,
    products: b.products,
    prices: b.prices,
    stock,
    cash: round2(b.cash),
    open: b.open,
    employees: b.employees.length,
    revenueToday: round2(b.today.revenue),
    customersToday: b.today.customers,
    avgProfit: round2(b.avgProfit),
    lastProfit: round2(b.history[b.history.length - 1]?.profit ?? 0),
    reputation: Math.round(b.reputation),
    hiringWage: b.hiringWage,
    foundedT: b.foundedT,
    closedT: b.closedT,
  };
}

export function marketRows(world: WorldState): MarketRow[] {
  return world.productOrder.map((pid) => {
    const p = world.products[pid];
    const m = world.market[pid];
    const sellers = world.businessOrder.filter((id) => {
      const b = world.businesses[id];
      return b.open && b.products.includes(pid);
    }).length;
    return {
      id: pid,
      name: p.name,
      emoji: p.emoji,
      wholesale: round2(m.wholesale),
      retail: round2(m.retail),
      trend: round2(m.trend),
      supply: round2(m.supply),
      soldToday: m.soldToday,
      unmetToday: m.unmetToday,
      sellers,
      listings: world.listings.filter((l) => l.productId === pid).reduce((s, l) => s + l.qty, 0),
      inventorId: p.inventorId,
    };
  });
}

export function bubbles(world: WorldState): BubbleDTO[] {
  const out: BubbleDTO[] = [];
  for (const conv of world.conversations) {
    if (conv.revealed <= 0) continue;
    const line = conv.lines[conv.revealed - 1];
    if (!line) continue;
    out.push({ id: conv.id, a: conv.a, b: conv.b, topic: conv.topic, speaker: line.speaker, text: line.text, source: conv.source });
  }
  return out;
}

export function state(
  world: WorldState,
  opts: { speed: number; paused: boolean; events: StateMsg["events"]; ai: AIStatusDTO; savedAt: number | null },
): StateMsg {
  const e = world.economy;
  return {
    type: "state",
    t: world.time,
    speed: opts.speed,
    paused: opts.paused,
    citizens: world.citizenOrder.map((id) => citizenSummary(world, world.citizens[id])),
    businesses: world.businessOrder.map((id) => businessSummary(world, world.businesses[id])),
    market: marketRows(world),
    events: opts.events,
    bubbles: bubbles(world),
    stats: world.stats.hourly[world.stats.hourly.length - 1] ?? null,
    economy: { mode: e.mode, multiplier: round2(e.multiplier), modeUntil: e.modeUntil, corpOpenings: e.corpOpenings, corpEmployees: world.corpEmployees.length },
    ai: opts.ai,
    savedAt: opts.savedAt,
    txCount: world.txCount,
  };
}

export function conversationDTO(world: WorldState, c: Conversation): ConversationDTO {
  const name = (id: string) => world.citizens[id]?.name ?? id;
  return {
    id: c.id,
    t: c.startedT,
    topic: c.topic,
    a: c.a,
    b: c.b,
    aName: name(c.a),
    bName: name(c.b),
    place: c.buildingId ? placeName(world, c.buildingId) : "town",
    lines: c.lines.map((l) => ({ speaker: l.speaker, name: name(l.speaker), text: l.text })),
    summary: c.summary,
    source: c.source,
  };
}

function loanDTO(world: WorldState, l: Loan): LoanDTO {
  return {
    id: l.id,
    lender: l.lender === "bank" ? "Hustle Bank" : world.citizens[l.lender]?.name ?? l.lender,
    borrower: world.citizens[l.borrower]?.name ?? l.borrower,
    principal: l.principal,
    totalDue: round2(l.totalDue),
    paid: round2(l.paid),
    dueT: l.dueT,
    status: l.status,
    purpose: l.purpose,
  };
}

/** Building name, or the business occupying it (e.g. "Mike's Café" instead of "Unit 2"). */
export function placeName(world: WorldState, buildingId: string): string {
  const b = getBuildingIndexed(world.map, buildingId);
  if (!b) return buildingId;
  if (b.businessId && world.businesses[b.businessId]?.open) return world.businesses[b.businessId].name;
  return b.name;
}

export function citizenDetail(world: WorldState, id: string): CitizenDetail | null {
  const c = world.citizens[id];
  if (!c) return null;
  const inside = getBuildingIndexed(world.map, c.insideId);
  const dest = getBuildingIndexed(world.map, c.activity.buildingId);
  const longIds = new Set(c.memories.long.map((m) => m.id));
  const hist = c.finance.history.slice(-7);
  return {
    kind: "citizen",
    id: c.id,
    name: c.name,
    surname: c.surname,
    age: c.age,
    color: c.color,
    occupation: c.occupation,
    employer: c.employerId ? employerName(world, c.employerId) : null,
    wage: c.wage,
    money: round2(c.money),
    savings: round2(c.savings),
    netWorth: netWorth(world, c),
    debts: debtsOf(world, c),
    creditScore: Math.round(c.creditScore),
    incomeToday: c.finance.incomeToday,
    expensesToday: c.finance.expensesToday,
    avgIncome: round2(avg(hist.map((h) => h.income))),
    avgExpenses: round2(avg(hist.map((h) => h.expenses))),
    home: c.homeId ? getBuildingIndexed(world.map, c.homeId)?.name ?? null : null,
    homeless: c.homeless,
    rentArrears: c.rentArrears,
    location: inside ? placeName(world, inside.id) : dest ? `On the way to ${placeName(world, dest.id)}` : "Out and about",
    activity: c.activity.label,
    goal: c.goal,
    thought: c.thought,
    thoughtSource: c.thoughtSource,
    archetypes: c.archetypes,
    traits: c.traits,
    skills: {
      sales: Math.round(c.skills.sales),
      tech: Math.round(c.skills.tech),
      trading: Math.round(c.skills.trading),
      research: Math.round(c.skills.research),
      management: Math.round(c.skills.management),
    },
    needs: {
      energy: Math.round(c.needs.energy),
      hunger: Math.round(c.needs.hunger),
      social: Math.round(c.needs.social),
      fun: Math.round(c.needs.fun),
    },
    mood: Math.round(c.mood),
    inventory: Object.entries(c.inventory)
      .filter(([, it]) => it.qty > 0)
      .map(([pid, it]) => ({ id: pid, name: world.products[pid]?.name ?? pid, emoji: world.products[pid]?.emoji ?? "📦", qty: it.qty, avgCost: round2(it.avgCost) })),
    businesses: c.businessIds.map((bid) => world.businesses[bid]).filter(Boolean).map((b) => businessSummary(world, b)),
    relationships: Object.entries(c.relationships)
      .filter(([, r]) => r.familiarity > 2 || r.roles.length > 0)
      .map(([oid, r]) => ({
        id: oid,
        name: world.citizens[oid]?.name ?? oid,
        label: relLabel(r),
        affinity: Math.round(r.affinity),
        trust: Math.round(r.trust),
        familiarity: Math.round(r.familiarity),
        roles: r.roles,
      }))
      .sort((a, b) => Math.abs(b.affinity) + b.roles.length * 30 - (Math.abs(a.affinity) + a.roles.length * 30))
      .slice(0, 12),
    memories: recentMemories(c, 14).map((m) => ({ ...m, long: longIds.has(m.id) })),
    transactions: [...c.txIds]
      .reverse()
      .map((tid) => findTx(world, tid))
      .filter((t): t is Transaction => !!t)
      .slice(0, 20)
      .map((t) => txDTO(world, t)),
    decisions: [...c.strategyLog.slice(-8), ...c.decisions.slice(-10)].sort((a, b) => b.t - a.t),
    financeHistory: c.finance.history.slice(-30),
    loans: world.loans.filter((l) => (l.borrower === c.id || l.lender === c.id) && (l.status === "active" || world.time - l.dueT < 3 * 1440)).map((l) => loanDTO(world, l)),
    research: { points: Math.round(c.research.points), threshold: breakthroughThreshold(c), breakthroughs: c.research.breakthroughs, patents: c.research.patents },
    insights: c.beliefs.insights.map((i) => `${world.products[i.productId]?.name ?? i.productId} ${i.kind === "hype" ? "boom" : "slump"} around Day ${dayOf(i.startT)}`),
    beliefs: Object.entries(c.beliefs.occupationIncome).map(([occ, b]) => ({ occupation: occ, value: Math.round(b!.value), source: b!.source })),
    conversations: [...world.conversations, ...world.conversationLog]
      .filter((x) => (x.a === c.id || x.b === c.id) && x.lines.length > 0)
      .sort((x, y) => y.startedT - x.startedT)
      .slice(0, 8)
      .map((x) => conversationDTO(world, x)),
  };
}

export function businessDetail(world: WorldState, id: string): BusinessDetail | null {
  const b = world.businesses[id];
  if (!b) return null;
  const acc = `b:${b.id}`;
  const txs = world.transactions.filter((t) => t.from === acc || t.to === acc).slice(-25).reverse();
  return {
    kind: "business",
    summary: businessSummary(world, b),
    employees: b.employees.map((e) => ({ id: e.citizenId, name: world.citizens[e.citizenId]?.name ?? "?", wage: e.wage, since: e.since })),
    partners: b.partners.map((p) => ({ id: p.citizenId, name: world.citizens[p.citizenId]?.name ?? "?", share: p.share, invested: p.invested })),
    inventory: b.products.map((pid) => ({
      id: pid,
      name: world.products[pid]?.name ?? pid,
      emoji: world.products[pid]?.emoji ?? "📦",
      qty: b.inventory[pid]?.qty ?? 0,
      avgCost: round2(b.inventory[pid]?.avgCost ?? 0),
      price: round2(b.prices[pid] ?? 0),
    })),
    history: b.history.slice(-30),
    totalRevenue: round2(b.totalRevenue),
    totalProfit: round2(b.totalProfit),
    unpaidWages: b.unpaidWages,
    daysInRed: b.daysInRed,
    closedReason: b.closedReason,
    transactions: txs.map((t) => txDTO(world, t)),
  };
}

export function dashboard(world: WorldState): DashboardMsg {
  const cs = world.citizenOrder.map((id) => world.citizens[id]);
  const worth = cs.map((c) => ({ id: c.id, name: c.name, netWorth: netWorth(world, c), occupation: c.occupation })).sort((a, b) => b.netWorth - a.netWorth);
  const occupations: Record<string, number> = {};
  for (const c of cs) occupations[c.occupation] = (occupations[c.occupation] ?? 0) + 1;
  const priceHistory: DashboardMsg["priceHistory"] = {};
  for (const pid of world.productOrder) priceHistory[pid] = world.market[pid].history.slice(-60);
  return {
    type: "dashboard",
    hourly: world.stats.hourly,
    daily: world.stats.daily,
    richest: worth.slice(0, 5),
    poorest: worth.slice(-5).reverse(),
    topBusinesses: world.businessOrder
      .map((id) => world.businesses[id])
      .map((b) => ({ id: b.id, name: b.name, ownerName: world.citizens[b.ownerId]?.name ?? "?", avgProfit: round2(b.avgProfit), totalProfit: round2(b.totalProfit), open: b.open }))
      .sort((a, b) => b.avgProfit - a.avgProfit)
      .slice(0, 8),
    priceHistory,
    popular: world.productOrder
      .map((pid) => ({ id: pid, name: world.products[pid].name, emoji: world.products[pid].emoji, sold: world.market[pid].soldTotal }))
      .sort((a, b) => b.sold - a.sold),
    occupations,
    recentTx: world.transactions.slice(-30).reverse().map((t) => txDTO(world, t)),
    loans: world.loans.filter((l) => l.status === "active").map((l) => loanDTO(world, l)),
    service: { pool: world.economy.servicePool, supplied: world.economy.serviceSupplied },
    aiLog: [...world.ai.log].reverse().map((l) => ({ ...l, citizenName: l.citizenId ? world.citizens[l.citizenId]?.name ?? "?" : "—" })),
    conversations: [...world.conversationLog]
      .filter((x) => x.topic !== "chat" || x.source === "llm")
      .reverse()
      .slice(0, 20)
      .map((x) => conversationDTO(world, x)),
    products: world.productOrder.map((pid) => {
      const p = world.products[pid];
      return { id: p.id, name: p.name, emoji: p.emoji, category: p.category, baseCost: p.baseCost, baseRetail: p.baseRetail, inventorId: p.inventorId };
    }),
  };
}

export function describeTime(t: number): string {
  return formatTime(t);
}
