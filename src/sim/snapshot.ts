import { HAPPENING_ICON, isActive } from "./town/happenings";
import type {
  AIStatusDTO,
  ConversationDTO,
  HappeningDTO,
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
import { placeName } from "./places";
import { employerName } from "./economy/jobs";
import { findTx } from "./economy/ledger";
import { debtsOf, netWorth } from "./economy/valuation";
import { breakthroughThreshold } from "./economy/research";
import { recentMemories } from "./memory/memory";
import { dominantEmotion, EMOTION_EMOJI } from "./mind/emotions";
import { botCard } from "./mind/bot";
import { personalitySummary } from "./mind/personality";
import { relLabel } from "./social/relationships";
import { dayOf, formatTime } from "./time";
import type { Business, Citizen, Conversation, Emotions, Loan, Transaction, WorldState } from "./types";
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
    market: "Marketplace (outside traders)",
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
    emotion: emotionDTO(c),
  };
}

/** How they feel, as the panels show it: the strongest feeling once it's noticeable (lower than the bar for it to change what they do). */
function emotionDTO(c: Citizen): CitizenSummary["emotion"] {
  const d = dominantEmotion(c, 28);
  return d ? { kind: d.emotion, level: d.level, emoji: EMOTION_EMOJI[d.emotion] } : null;
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

/** Where money landed on the map, for floating "+£" effects. */
export function moneyFx(world: WorldState, sinceTxId: number): StateMsg["fx"] {
  const out: StateMsg["fx"] = [];
  for (let i = world.transactions.length - 1; i >= 0 && out.length < 24; i--) {
    const tx = world.transactions[i];
    if (tx.id <= sinceTxId) break;
    if (!["sale", "purchase", "meal", "trade", "salary", "wage", "gig", "grant", "dividend", "royalty", "gift", "god", "loan"].includes(tx.kind)) continue;
    let pos: { x: number; y: number } | null = null;
    if (tx.to.startsWith("b:")) {
      const b = world.businesses[tx.to.slice(2)];
      const bld = b ? getBuildingIndexed(world.map, b.buildingId) : undefined;
      if (bld) pos = { x: bld.x + bld.w / 2, y: bld.y + bld.h / 2 };
    } else if (tx.to.startsWith("c:")) {
      const c = world.citizens[tx.to.slice(2)];
      if (c) pos = { x: c.pos.x, y: c.pos.y };
    }
    if (pos) out.push({ x: round2(pos.x), y: round2(pos.y), amount: tx.amount });
  }
  return out;
}

export function state(
  world: WorldState,
  opts: { speed: number; paused: boolean; events: StateMsg["events"]; ai: AIStatusDTO; savedAt: number | null; fx: StateMsg["fx"] },
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
    conversations: world.conversationLog.slice(-12).map((x) => conversationDTO(world, x)),
    happenings: happeningsDTO(world),
    fx: opts.fx,
  };
}

/** What's going on now, then the most recent others (newest first). */
export function happeningsDTO(world: WorldState): HappeningDTO[] {
  const known = (id: number) => world.citizenOrder.reduce((n, cid) => n + (world.citizens[cid].news.some((k) => k.id === id) ? 1 : 0), 0);
  const list = [...world.happenings].reverse();
  const active = list.filter((h) => isActive(world, h));
  const recent = list.filter((h) => !isActive(world, h)).slice(0, Math.max(0, 8 - active.length));
  return [...active, ...recent].map((h) => ({
    id: h.id,
    kind: h.kind,
    icon: HAPPENING_ICON[h.kind],
    title: h.title,
    text: h.text,
    t: h.t,
    until: h.until,
    active: isActive(world, h),
    buildingId: h.buildingId,
    subject: h.subject,
    businessId: h.businessId,
    source: h.source,
    known: known(h.id),
  }));
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
    topics: c.topics ?? [],
    live: c.status !== "done",
    spoken: !!c.live,
    writing: c.status === "live" && !c.live?.done,
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
    agent: c.agent ? { plan: c.agent.plan && c.agent.plan.day === dayOf(world.time) ? c.agent.plan.items : null, diary: [...c.agent.diary].reverse() } : null,
    bot: botCard(c),
    playerChat: (c.playerChat ?? []).slice(-30),
    chatWaiting: !!c.chatWaiting,
    financeHistory: c.finance.history.slice(-30),
    loans: world.loans.filter((l) => (l.borrower === c.id || l.lender === c.id) && (l.status === "active" || world.time - l.dueT < 3 * 1440)).map((l) => loanDTO(world, l)),
    research: { points: Math.round(c.research.points), threshold: breakthroughThreshold(c), breakthroughs: c.research.breakthroughs, patents: c.research.patents },
    insights: c.beliefs.insights.map((i) => `${world.products[i.productId]?.name ?? i.productId} ${i.kind === "hype" ? "boom" : "slump"} around Day ${dayOf(i.startT)}`),
    beliefs: Object.entries(c.beliefs.occupationIncome).map(([occ, b]) => ({ occupation: occ, value: Math.round(b!.value), source: b!.source })),
    personality: { ...c.personality, summary: personalitySummary(c.personality) },
    emotions: Object.fromEntries(Object.entries(c.emotions).map(([k, v]) => [k, Math.round(v)])) as Emotions,
    emotion: emotionDTO(c),
    lessons: [...c.reflections].sort((a, b) => b.strength - a.strength),
    news: [...c.news].reverse().flatMap((k) => {
      const h = world.happenings.find((x) => x.id === k.id);
      if (!h) return [];
      const via = k.via === "saw" ? "saw it" : k.via === "paper" ? "the paper" : k.via === "self" ? "it happened to them" : `heard from ${world.citizens[k.via]?.name ?? "someone"}`;
      return [{ id: h.id, icon: HAPPENING_ICON[h.kind], title: h.title, t: k.t, via, stance: k.stance }];
    }),
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
    tapes: Object.fromEntries(world.productOrder.map((pid) => [pid, world.market[pid].tape])),
    econEvents: world.events.filter((e) => (e.cat === "market" || e.cat === "god" || (e.cat === "business" && e.importance >= 4)) && e.importance >= 3).slice(-30).reverse(),
    market: marketRows(world),
    products: world.productOrder.map((pid) => {
      const p = world.products[pid];
      return { id: p.id, name: p.name, emoji: p.emoji, category: p.category, baseCost: p.baseCost, baseRetail: p.baseRetail, inventorId: p.inventorId };
    }),
  };
}

export function describeTime(t: number): string {
  return formatTime(t);
}
