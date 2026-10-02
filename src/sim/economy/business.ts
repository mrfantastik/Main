import { CONFIG } from "../config";
import { getBuildingIndexed } from "../city/lookup";
import { logEvent } from "../events";
import { remember } from "../memory/memory";
import { chance, gauss, poisson, weightedPick } from "../rng";
import { addRole, adjustRel } from "../social/relationships";
import { hourOf } from "../time";
import type { Building, Business, BusinessKind, Citizen, ProductId, WorldState } from "../types";
import { clamp, money, newId, pushRing, round2 } from "../util";
import { hearStory } from "../ai/beliefs";
import { leaveJob } from "./jobs";
import { businessAcc, citizenAcc, creditOccupation, externalAcc, transfer } from "./ledger";
import { addStock, buyFromDepot, buyListing, hourWeight, listingsFor, marketOpen, payRoyalty, recordRetailSale, refPrice, removeStock } from "./market";
import { ownerShare } from "./valuation";

// Citizen-run businesses: shops, market stalls, cafés and agencies.
// They compete for customers (visitors + citizens) on price, reputation and
// whether anyone is actually there to serve. They pay rent and wages, and go
// bankrupt if they can't.

export interface KindInfo {
  noun: string;
  building: "shop_unit" | "market" | "cowork";
  maxProducts: number;
  capacityMult: number;
  /** How attractive this channel is to shoppers. */
  appeal: number;
  maxPerBuilding: number;
}

export const KIND_INFO: Record<BusinessKind, KindInfo> = {
  shop: { noun: "shop", building: "shop_unit", maxProducts: 3, capacityMult: 1, appeal: 1, maxPerBuilding: 1 },
  stall: { noun: "market stall", building: "market", maxProducts: 2, capacityMult: 0.8, appeal: 0.85, maxPerBuilding: 10 },
  cafe: { noun: "café", building: "shop_unit", maxProducts: 3, capacityMult: 1.3, appeal: 1.05, maxPerBuilding: 1 },
  agency: { noun: "agency", building: "cowork", maxProducts: 0, capacityMult: 1, appeal: 1, maxPerBuilding: 4 },
};

const PRODUCT_NOUN: Record<string, string> = {
  food: "Grocer",
  coffee: "Coffee Co.",
  clothes: "Threads",
  trainers: "Kicks",
  phones: "Mobiles",
  books: "Books",
  gadgets: "Gadgets",
};

export function openBusinesses(world: WorldState): Business[] {
  return world.businessOrder.map((id) => world.businesses[id]).filter((b) => b.open);
}

export function sellersOf(world: WorldState, pid: ProductId, except?: string): Business[] {
  return openBusinesses(world).filter((b) => b.id !== except && b.products.includes(pid) && b.kind !== "agency");
}

/** Find a building where this kind of business can open. */
export function findPremises(world: WorldState, kind: BusinessKind): Building | undefined {
  const info = KIND_INFO[kind];
  if (info.building === "shop_unit") return world.map.buildings.find((b) => b.type === "shop_unit" && !b.businessId);
  const b = world.map.buildings.find((x) => x.type === info.building);
  if (!b) return undefined;
  const count = openBusinesses(world).filter((x) => x.buildingId === b.id).length;
  return count < info.maxPerBuilding ? b : undefined;
}

function businessName(world: WorldState, owner: Citizen, kind: BusinessKind, products: ProductId[]): string {
  if (kind === "cafe") return `${owner.name}'s Café`;
  if (kind === "agency") return `${owner.surname} Digital`;
  const main = products[0];
  const noun = PRODUCT_NOUN[main] ?? world.products[main]?.name ?? "Goods";
  const base = `${owner.name}'s ${noun}`;
  const name = kind === "stall" ? `${base} Stall` : base;
  return world.businessOrder.some((id) => world.businesses[id].name === name) ? `${name} II` : name;
}

export function defaultPrice(world: WorldState, owner: Citizen, pid: ProductId): number {
  const m = world.market[pid];
  return round2(Math.max(m.wholesale * 1.25, refPrice(world, pid) * (0.94 + owner.traits.greed * 0.14 - owner.traits.competitiveness * 0.05)));
}

/** Lowest price an owner will go to: cost plus a minimum margin. */
export function priceFloor(world: WorldState, b: Business, owner: Citizen | undefined, pid: ProductId): number {
  const cost = Math.max(b.inventory[pid]?.avgCost ?? 0, world.market[pid].wholesale);
  return round2(cost * (1.18 + (owner?.traits.greed ?? 0.5) * 0.12));
}

/** Open a new business. Capital moves from the owner's pocket into the business. */
export function createBusiness(world: WorldState, owner: Citizen, kind: BusinessKind, products: ProductId[], capital: number): Business | null {
  const premises = findPremises(world, kind);
  if (!premises) return null;
  capital = Math.min(capital, owner.money);
  const id = `b${newId(world)}`;
  const b: Business = {
    id,
    name: businessName(world, owner, kind, products),
    kind,
    ownerId: owner.id,
    partners: [],
    buildingId: premises.id,
    products,
    inventory: {},
    prices: Object.fromEntries(products.map((p) => [p, defaultPrice(world, owner, p)])),
    cash: 0,
    employees: [],
    open: true,
    foundedT: world.time,
    closedT: null,
    closedReason: null,
    reputation: 50,
    today: { revenue: 0, cogs: 0, wages: 0, rent: 0, other: 0, customers: 0, units: {} },
    history: [],
    totalRevenue: 0,
    totalProfit: 0,
    daysInRed: 0,
    unpaidWages: 0,
    hiringWage: 0,
    lastPriceChangeT: world.time,
    avgProfit: 0,
    ownerInvested: 0,
    agencyEarned: 0,
    salesAvg: {},
    missedToday: 0,
    missedYesterday: 0,
    staffedHoursToday: 0,
    staffedHoursYesterday: 0,
  };
  world.businesses[id] = b;
  world.businessOrder.push(id);
  if (premises.type === "shop_unit") premises.businessId = id;
  owner.businessIds.push(id);
  if (capital > 0 && transfer(world, citizenAcc(owner.id), businessAcc(id), capital, "capital", `Start-up capital for ${b.name}`)) {
    b.ownerInvested = capital;
  }
  const what = kind === "agency" ? "a digital agency" : kind === "cafe" ? "a café" : `a ${KIND_INFO[kind].noun} selling ${products.map((p) => world.products[p].name.toLowerCase()).join(" & ")}`;
  logEvent(world, "business", `🏪 ${owner.name} opened ${b.name} — ${what}.`, 4, [owner.id], id);
  remember(world, owner, { text: `I opened ${b.name} with ${money(capital)}.`, kind: "business", importance: 8, valence: 0.8, people: [] });
  return b;
}

/** Everyone working at the business right now (owner or staff, on shift). */
export function staffOnDuty(world: WorldState, b: Business): Citizen[] {
  const out: Citizen[] = [];
  for (const id of world.citizenOrder) {
    const c = world.citizens[id];
    if (c.insideId !== b.buildingId) continue;
    const a = c.activity.action;
    if (!a) continue;
    if (a.type === "MANAGE" && a.params.businessId === b.id) out.push(c);
    else if (a.type === "WORK" && a.params.role === "business" && c.employerId === b.id) out.push(c);
  }
  return out;
}

export function capacityPerHour(b: Business, staff: number): number {
  if (staff <= 0) return 0;
  return (CONFIG.capacityBase + CONFIG.capacityPerStaff * staff) * KIND_INFO[b.kind].capacityMult;
}

function recordBusinessSale(world: WorldState, b: Business, pid: ProductId, price: number, qty: number, unitCost: number): void {
  b.today.revenue = round2(b.today.revenue + price * qty);
  b.today.cogs = round2(b.today.cogs + unitCost * qty);
  b.today.customers += 1;
  b.today.units[pid] = (b.today.units[pid] ?? 0) + qty;
  b.reputation = clamp(b.reputation + 0.15, 5, 98);
  recordRetailSale(world, pid, price, qty);
  payRoyalty(world, businessAcc(b.id), pid, price * qty);
}

/**
 * A citizen buys from a business (must be staffed). Returns units bought.
 * Money goes to the business; goods to the buyer (unless eaten on the spot).
 */
export function buyFromBusiness(world: WorldState, b: Business, buyer: Citizen, pid: ProductId, qty: number, consumeNow = false): number {
  if (!b.open || staffOnDuty(world, b).length === 0) return 0;
  const stock = b.inventory[pid]?.qty ?? 0;
  qty = Math.min(qty, stock);
  const price = b.prices[pid];
  if (qty <= 0 || !price) return 0;
  const total = round2(price * qty);
  if (buyer.money < total && buyer.savings > 0) {
    const need = Math.min(buyer.savings, total - buyer.money);
    buyer.savings = round2(buyer.savings - need);
    buyer.money = round2(buyer.money + need);
  }
  if (!transfer(world, citizenAcc(buyer.id), businessAcc(b.id), total, consumeNow ? "meal" : "purchase", `${qty}× ${world.products[pid].name} at ${b.name}`)) return 0;
  const unitCost = removeStock(b.inventory, pid, qty);
  recordBusinessSale(world, b, pid, price, qty, unitCost);
  if (!consumeNow) addStock(buyer.inventory, pid, qty, price);
  // Customers and owners get to know each other.
  const owner = world.citizens[b.ownerId];
  if (owner && owner.id !== buyer.id) {
    adjustRel(world, buyer, owner.id, { familiarity: 2, affinity: 0.5 });
    adjustRel(world, owner, buyer.id, { familiarity: 2, affinity: 1 });
  }
  return qty;
}

// ---------------------------------------------------------- hourly sales

/** Visitors (and online buyers) shop across town every hour. */
export function salesHourly(world: WorldState): void {
  const h = hourOf(world.time);
  const weight = hourWeight(h);
  if (weight <= 0) return;

  const staffCount = new Map<string, number>();
  const capLeft = new Map<string, number>();
  for (const b of openBusinesses(world)) {
    if (b.kind === "agency") continue;
    const n = staffOnDuty(world, b).length;
    staffCount.set(b.id, n);
    capLeft.set(b.id, capacityPerHour(b, n));
  }
  const marketIsOpen = marketOpen(world);

  for (const b of openBusinesses(world)) if ((staffCount.get(b.id) ?? 0) > 0) b.staffedHoursToday++;

  for (const pid of world.productOrder) {
    const p = world.products[pid];
    const m = world.market[pid];
    const ref = refPrice(world, pid);
    const lambda = p.externalDemand * m.trend * world.economy.multiplier * weight;
    const customers = poisson(world, lambda);
    if (customers === 0) continue;
    const shops = sellersOf(world, pid);
    const listings = marketIsOpen ? listingsFor(world, pid).filter((l) => l.sellerId !== "external") : [];

    for (let i = 0; i < customers; i++) {
      const wtp = ref * 1.15 * Math.exp(gauss(world) * 0.22);
      type Cand = { kind: "biz"; b: Business; price: number } | { kind: "list"; l: (typeof listings)[number]; price: number };
      const cands: Cand[] = [];
      for (const b of shops) {
        const price = b.prices[pid];
        if (!price || price > wtp) continue;
        if ((b.inventory[pid]?.qty ?? 0) < 1) {
          if ((staffCount.get(b.id) ?? 0) > 0) b.missedToday++;
          continue;
        }
        if ((capLeft.get(b.id) ?? 0) < 1) {
          if ((staffCount.get(b.id) ?? 0) > 0) b.missedToday++;
          continue;
        }
        cands.push({ kind: "biz", b, price });
      }
      for (const l of listings) if (l.qty > 0 && l.price <= wtp) cands.push({ kind: "list", l, price: l.price });
      if (cands.length === 0) {
        m.unmetToday++;
        continue;
      }
      const pickC = weightedPick(world, cands, (c) => {
        const priceTerm = Math.exp(-3.2 * (c.price / ref - 1));
        if (c.kind === "list") return priceTerm * 0.55;
        return priceTerm * KIND_INFO[c.b.kind].appeal * (0.55 + c.b.reputation / 110);
      })!;
      if (pickC.kind === "list") {
        buyListing(world, "external", pickC.l, 1);
      } else {
        const b = pickC.b;
        const qty = p.baseRetail < 6 && chance(world, 0.35) ? Math.min(2, b.inventory[pid]?.qty ?? 0) : 1;
        if (qty <= 0) continue;
        const total = round2(pickC.price * qty);
        if (!transfer(world, externalAcc("visitors"), businessAcc(b.id), total, "sale", `${qty}× ${p.name}`)) continue;
        const unitCost = removeStock(b.inventory, pid, qty);
        recordBusinessSale(world, b, pid, pickC.price, qty, unitCost);
        capLeft.set(b.id, (capLeft.get(b.id) ?? 0) - 1);
      }
    }
  }
}

/** Agencies bill the work their staff did this hour. */
export function agencyHourly(world: WorldState): void {
  for (const b of openBusinesses(world)) {
    if (b.kind !== "agency" || b.agencyEarned <= 0) continue;
    const amount = round2(b.agencyEarned);
    b.agencyEarned = 0;
    if (transfer(world, externalAcc("clients"), businessAcc(b.id), amount, "sale", "Client work")) {
      b.today.revenue = round2(b.today.revenue + amount);
      b.today.customers += 1;
      world.stats.hourRevenue += amount;
      world.stats.dayRevenue += amount;
    }
  }
}

// ---------------------------------------------------------- operations

export function expectedDailySales(world: WorldState, b: Business, pid: ProductId): number {
  const known = b.salesAvg[pid];
  if (known !== undefined) return known;
  const p = world.products[pid];
  const m = world.market[pid];
  const sellers = sellersOf(world, pid).length;
  return Math.max(2, (p.externalDemand * m.trend * 0.6) / Math.max(1, sellers));
}

/** Owner (or staff) restocks at the depot. Returns a description. */
export function restockBusiness(world: WorldState, b: Business, buyer: Citizen): string {
  const owner = world.citizens[b.ownerId];
  const parts: string[] = [];
  const plan = b.products.map((pid) => {
    const target = Math.ceil(expectedDailySales(world, b, pid) * (1.6 + (owner?.traits.risk ?? 0.5)) + 1);
    return { pid, need: Math.max(0, target - (b.inventory[pid]?.qty ?? 0)) };
  });
  const totalCost = plan.reduce((s, x) => s + x.need * world.market[x.pid].wholesale, 0);
  const keep = CONFIG.rent[b.kind] * 2;
  // Owner tops up the business if it can't afford the stock.
  if (owner && b.cash - keep < totalCost) {
    const short = totalCost - (b.cash - keep);
    const willing = Math.max(0, (owner.money - 25) * (0.4 + owner.traits.risk * 0.5));
    const inject = round2(Math.min(short, willing));
    if (inject >= 5 && transfer(world, citizenAcc(owner.id), businessAcc(b.id), inject, "capital", `Topped up ${b.name}`)) {
      b.ownerInvested = round2(b.ownerInvested + inject);
      parts.push(`put in ${money(inject)} of my own money`);
    }
  }
  let budget = Math.max(0, b.cash - keep);
  for (const { pid, need } of plan) {
    if (need <= 0 || budget <= 0) continue;
    const share = budget / Math.max(1, plan.filter((x) => x.need > 0).length);
    const { qty, cost } = buyFromDepot(world, businessAcc(b.id), pid, need, Math.max(share, Math.min(budget, world.market[pid].wholesale * 1.01)));
    if (qty > 0) {
      addStock(b.inventory, pid, qty, cost / qty);
      budget -= cost;
      parts.push(`${qty}× ${world.products[pid].name}`);
    }
  }
  if (buyer.id !== b.ownerId) buyer.skills.management = Math.min(100, buyer.skills.management + 0.1);
  return parts.length ? `Restocked ${b.name}: ${parts.join(", ")}.` : `Couldn't restock ${b.name} — no money or no stock at the depot.`;
}

/** Daily closing: rent, profit, owner's draw, reputation, bankruptcy. */
export function businessDaily(world: WorldState): void {
  const day = Math.floor((world.time - 1) / 1440) + 1;
  const weekly = day % 7 === 0;
  for (const b of openBusinesses(world)) {
    const owner = world.citizens[b.ownerId];
    // Rent.
    const rent = CONFIG.rent[b.kind];
    let paidRent = true;
    if (b.cash < rent && owner) {
      const need = round2(rent - b.cash);
      if (owner.money >= need + 5 && transfer(world, citizenAcc(owner.id), businessAcc(b.id), need, "capital", `Covered rent for ${b.name}`)) {
        b.ownerInvested = round2(b.ownerInvested + need);
      }
    }
    if (transfer(world, businessAcc(b.id), externalAcc("landlord"), rent, "rent", `Rent for ${b.name}`)) b.today.rent = rent;
    else paidRent = false;
    // Try to settle unpaid wages.
    if (b.unpaidWages > 0 && b.cash > b.unpaidWages) {
      for (const e of b.employees) {
        const c = world.citizens[e.citizenId];
        if (c && c.unpaidWages > 0) {
          const amt = Math.min(c.unpaidWages, b.cash);
          if (transfer(world, businessAcc(b.id), citizenAcc(c.id), amt, "wage", `Back pay from ${b.name}`)) c.unpaidWages = round2(c.unpaidWages - amt);
        }
      }
      b.unpaidWages = 0;
    }

    const t = b.today;
    const profit = round2(t.revenue - t.cogs - t.wages - t.rent - t.other);
    pushRing(b.history, { day, revenue: round2(t.revenue), profit, customers: t.customers }, 60);
    b.totalRevenue = round2(b.totalRevenue + t.revenue);
    b.totalProfit = round2(b.totalProfit + profit);
    b.avgProfit = round2(b.history.length === 1 ? profit : b.avgProfit * 0.6 + profit * 0.4);
    for (const pid of b.products) {
      const sold = t.units[pid] ?? 0;
      b.salesAvg[pid] = round2(b.salesAvg[pid] === undefined ? sold : b.salesAvg[pid] * 0.55 + sold * 0.45);
    }
    if (owner) creditOccupation(world, owner.id, profit * ownerShare(b));
    for (const p of b.partners) {
      const pc = world.citizens[p.citizenId];
      if (pc && pc.occupation === "entrepreneur") creditOccupation(world, pc.id, profit * p.share);
    }

    // Reputation: being unstaffed or out of stock hurts.
    if (t.customers === 0) b.reputation = clamp(b.reputation - 3, 5, 98);
    const outOfStock = b.products.filter((pid) => (b.inventory[pid]?.qty ?? 0) === 0).length;
    if (b.kind !== "agency" && outOfStock === b.products.length) b.reputation = clamp(b.reputation - 2, 5, 98);
    if (b.missedToday > 3) b.reputation = clamp(b.reputation - 1, 5, 98);

    // Health check.
    if (!paidRent || b.unpaidWages > 0) b.daysInRed++;
    else b.daysInRed = 0;

    // News travels: big days get noticed.
    if (profit >= 90 && owner) {
      logEvent(world, "business", `💰 ${b.name} made ${money(profit)} profit today.`, 3, [owner.id], b.id);
      spreadSuccess(world, owner, b, profit);
    } else if (profit <= -40 && owner && b.history.length > 1) {
      logEvent(world, "business", `📉 ${b.name} lost ${money(-profit)} today.`, 2, [owner.id], b.id);
    }

    if (b.daysInRed >= CONFIG.bankruptAfterDaysInRed) {
      closeBusiness(world, b, "went bankrupt — couldn't pay rent or wages", true);
      continue;
    }

    // Partners get dividends weekly.
    if (weekly && b.partners.length) payDividends(world, b);
    // Owner pays themselves from surplus cash.
    if (owner) ownerDraw(world, b, owner);
    b.today = { revenue: 0, cogs: 0, wages: 0, rent: 0, other: 0, customers: 0, units: {} };
    b.missedYesterday = b.missedToday;
    b.missedToday = 0;
    b.staffedHoursYesterday = b.staffedHoursToday;
    b.staffedHoursToday = 0;
  }
}

function spreadSuccess(world: WorldState, owner: Citizen, b: Business, profit: number): void {
  const story = { citizenId: owner.id, occupation: owner.occupation, productId: b.products[0] ?? null, amount: Math.round(profit), t: world.time };
  for (const id of world.citizenOrder) {
    if (id === owner.id) continue;
    const c = world.citizens[id];
    const fam = c.relationships[owner.id]?.familiarity ?? 0;
    if (chance(world, clamp(0.15 + fam / 100 + c.traits.sociability * 0.2, 0, 0.9))) hearStory(world, c, story, owner.name);
  }
}

function payDividends(world: WorldState, b: Business): void {
  const weekProfit = b.history.slice(-7).reduce((s, h) => s + h.profit, 0);
  if (weekProfit <= 0) return;
  const pot = Math.min(weekProfit * 0.6, b.cash - CONFIG.rent[b.kind] * 3);
  if (pot <= 5) return;
  for (const p of b.partners) {
    const amt = round2(pot * p.share);
    if (amt > 0.5 && transfer(world, businessAcc(b.id), citizenAcc(p.citizenId), amt, "dividend", `Dividend from ${b.name}`)) {
      const pc = world.citizens[p.citizenId];
      if (pc) {
        remember(world, pc, { text: `${b.name} paid me a ${money(amt)} dividend.`, kind: "financial", importance: 5, valence: 0.6, people: [b.ownerId], key: `div:${b.id}` });
        adjustRel(world, pc, b.ownerId, { affinity: 4, trust: 5 });
      }
    }
  }
}

function ownerDraw(world: WorldState, b: Business, owner: Citizen): void {
  const reserve = CONFIG.rent[b.kind] * 3 + b.employees.reduce((s, e) => s + e.wage, 0) * 2 + b.products.reduce((s, pid) => s + expectedDailySales(world, b, pid) * world.market[pid].wholesale * 1.5, 0);
  const surplus = b.cash - reserve;
  if (surplus <= 10) return;
  const draw = round2(surplus * (0.3 + owner.traits.greed * 0.4 - owner.traits.ambition * 0.15));
  if (draw > 2) transfer(world, businessAcc(b.id), citizenAcc(owner.id), draw, "owner_draw", `Paid myself from ${b.name}`);
}

/** Shut a business down: liquidate, lay off staff, return what's left. */
export function closeBusiness(world: WorldState, b: Business, reason: string, forced: boolean): void {
  if (!b.open) return;
  const owner = world.citizens[b.ownerId];
  // Sell remaining stock back to the depot at a loss.
  for (const [pid, it] of Object.entries(b.inventory)) {
    const m = world.market[pid];
    if (!m || it.qty <= 0) continue;
    transfer(world, externalAcc("depot"), businessAcc(b.id), round2(m.wholesale * 0.5 * it.qty), "liquidation", `Liquidated ${it.qty}× ${world.products[pid].name}`);
  }
  b.inventory = {};
  for (const e of [...b.employees]) {
    const c = world.citizens[e.citizenId];
    if (!c) continue;
    leaveJob(world, c, "business_closed");
    remember(world, c, { text: `${b.name} closed and I lost my job.`, kind: "job", importance: 7, valence: -0.7, people: owner ? [owner.id] : [] });
  }
  b.employees = [];
  // Whatever cash is left goes to partners (by share) and the owner.
  if (b.cash > 0) {
    for (const p of b.partners) {
      const amt = round2(b.cash * p.share);
      if (amt > 0) transfer(world, businessAcc(b.id), citizenAcc(p.citizenId), amt, "liquidation", `Final payout from ${b.name}`);
    }
    if (owner && b.cash > 0) transfer(world, businessAcc(b.id), citizenAcc(owner.id), b.cash, "liquidation", `Closed ${b.name}`);
  }
  for (const p of b.partners) {
    const pc = world.citizens[p.citizenId];
    if (!pc) continue;
    remember(world, pc, { text: `${b.name} closed. I lost most of the ${money(p.invested)} I invested.`, kind: "financial", importance: 7, valence: -0.8, people: [b.ownerId] });
    adjustRel(world, pc, b.ownerId, { affinity: -10, trust: -15 });
  }
  b.open = false;
  b.closedT = world.time;
  b.closedReason = reason;
  b.hiringWage = 0;
  const unit = getBuildingIndexed(world.map, b.buildingId);
  if (unit && unit.businessId === b.id) unit.businessId = null;
  if (owner) {
    if (forced) {
      owner.finance.bankruptcies++;
      owner.creditScore = Math.max(0, owner.creditScore - 20);
      logEvent(world, "business", `💥 ${b.name} ${reason}. ${owner.name} is bankrupt.`, 5, [owner.id], b.id);
      remember(world, owner, { text: `${b.name} went bankrupt. Everything I built is gone.`, kind: "business", importance: 9, valence: -1, people: [] });
    } else {
      logEvent(world, "business", `🔒 ${owner.name} closed ${b.name} (${reason}).`, 4, [owner.id], b.id);
      remember(world, owner, { text: `I closed ${b.name}: ${reason}.`, kind: "business", importance: 8, valence: -0.6, people: [] });
    }
    if (!owner.businessIds.some((id) => world.businesses[id]?.open)) {
      if (owner.occupation === "shopkeeper" || owner.occupation === "entrepreneur") {
        owner.occupation = "unemployed";
        owner.occupationSince = world.time;
      }
    }
    owner.reviewRequested = "business closed";
  }
}

/** Bring an investor into a business. */
export function addPartner(world: WorldState, b: Business, investor: Citizen, amount: number, share: number): boolean {
  if (!transfer(world, citizenAcc(investor.id), businessAcc(b.id), amount, "investment", `Investment in ${b.name}`)) return false;
  const existing = b.partners.find((p) => p.citizenId === investor.id);
  if (existing) {
    existing.share = round2(existing.share + share);
    existing.invested = round2(existing.invested + amount);
  } else {
    b.partners.push({ citizenId: investor.id, share: round2(share), invested: round2(amount) });
  }
  addRole(investor, b.ownerId, "investor");
  const owner = world.citizens[b.ownerId];
  if (owner) {
    addRole(owner, investor.id, "investee");
    addRole(investor, owner.id, "partner");
    addRole(owner, investor.id, "partner");
  }
  return true;
}

/** Valuation used for equity deals. */
export function valuation(world: WorldState, b: Business): number {
  let inv = 0;
  for (const [pid, it] of Object.entries(b.inventory)) inv += it.qty * (world.market[pid]?.wholesale ?? 0);
  return round2(Math.max(120, b.cash + inv + Math.max(0, b.avgProfit) * 15));
}

export { rentFor };
function rentFor(kind: BusinessKind): number {
  return CONFIG.rent[kind];
}
