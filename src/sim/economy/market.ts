import { CONFIG } from "../config";
import { logEvent } from "../events";
import { chance, gauss, pick, randInt, randRange } from "../rng";
import { hourOf } from "../time";
import type { Citizen, Listing, ProductId, WorldState } from "../types";
import { clamp, money, newId, pushRing, round2 } from "../util";
import { citizenAcc, creditOccupation, externalAcc, transfer } from "./ledger";

// Markets.
//
// - Wholesale: the Wholesale Depot sells goods at a fluctuating price with a
//   limited daily supply (shortages raise prices). Traders' buying/selling
//   pushes prices around (so herds can create bubbles).
// - Demand trends: each product has a demand multiplier. Shocks (hype/slump)
//   are scheduled a few days ahead — researchers can discover them early.
// - Marketplace: a board of listings. Citizens list goods there; the outside
//   world dumps clearance lots there (bargains for resellers).

/** Share of daily visitor demand arriving in each hour (sums to 1). */
const HOUR_WEIGHTS = (() => {
  const raw = [0, 0, 0, 0, 0, 0, 0, 0.3, 0.6, 0.8, 0.9, 1.0, 1.3, 1.3, 1.0, 0.9, 0.9, 1.1, 1.2, 1.0, 0.7, 0.4, 0, 0];
  const total = raw.reduce((a, b) => a + b, 0);
  return raw.map((v) => v / total);
})();

export function hourWeight(h: number): number {
  return HOUR_WEIGHTS[h] ?? 0;
}

/**
 * Reference ("fair") retail price that shoppers have in mind. Driven by the
 * wholesale cost and current demand — NOT by recent sale prices, so a price
 * war doesn't drag what customers are willing to pay down with it.
 */
export function refPrice(world: WorldState, pid: ProductId): number {
  const p = world.products[pid];
  const m = world.market[pid];
  if (!p || !m) return 0;
  return round2(p.baseRetail * Math.pow(m.wholesale / p.baseCost, 0.6) * (0.85 + 0.15 * m.trend));
}

export function marketOpen(world: WorldState): boolean {
  const h = hourOf(world.time);
  return h >= 8 && h < 20;
}

/** Hourly: prices wander, trends settle, trader pressure moves prices. */
export function marketHourly(world: WorldState): void {
  for (const pid of world.productOrder) {
    const p = world.products[pid];
    const m = world.market[pid];
    // Trend relaxes toward the active shock (or 1).
    const shock = world.shocks.find((s) => s.started && s.productId === pid);
    const target = shock ? shock.magnitude : 1;
    m.trend = clamp(m.trend + (target - m.trend) * 0.08 + gauss(world) * 0.006, 0.25, 3);
    // Wholesale price: random walk around a fair value set by supply & demand.
    const fair = p.baseCost * Math.pow(1 / Math.max(0.2, m.supply), 0.6) * (0.6 + 0.4 * m.trend);
    const noise = gauss(world) * ((p.volatility * 1.6) / Math.sqrt(24));
    let w = m.wholesale * Math.exp(noise) + (fair - m.wholesale) * 0.05;
    w *= 1 + clamp(m.traderPressure, -1, 1) * 0.025;
    m.traderPressure *= 0.85;
    m.wholesale = round2(clamp(w, p.baseCost * 0.35, p.baseCost * 4));
    pushRing(m.tape, m.wholesale, 48);
  }
}

/** Daily: depot restocks, history is recorded, shocks start/end, lots arrive. */
export function marketDaily(world: WorldState): void {
  for (const pid of world.productOrder) {
    const p = world.products[pid];
    const m = world.market[pid];
    pushRing(m.history, { t: world.time, wholesale: m.wholesale, retail: m.retail, sold: m.soldToday }, 90);
    m.soldToday = 0;
    m.revenueToday = 0;
    m.unmetYesterday = m.unmetToday;
    m.unmetToday = 0;
    m.supply = clamp(m.supply + (1 - m.supply) * 0.25, 0.1, 3);
    m.depotStock = Math.round((p.externalDemand * 2.5 + 15) * m.supply);
    // With no sales, the reference price drifts toward a normal markup.
    const normal = m.wholesale * (p.baseRetail / p.baseCost) * (0.85 + 0.15 * m.trend);
    m.retail = round2(m.retail * 0.93 + normal * 0.07);
  }
  updateShocks(world);
  spawnClearanceLots(world);
  // Unsold clearance lots disappear after two days.
  world.listings = world.listings.filter((l) => l.sellerId !== "external" || world.time - l.listedT < 2 * 1440);
}

function updateShocks(world: WorldState): void {
  for (const s of world.shocks) {
    if (!s.started && world.time >= s.startT) {
      s.started = true;
      const p = world.products[s.productId];
      if (!p) continue;
      if (s.kind === "hype") logEvent(world, "market", `📈 ${p.emoji} ${p.name} are suddenly the hot thing in town! Demand is surging.`, 4);
      else logEvent(world, "market", `📉 Nobody wants ${p.emoji} ${p.name} any more. Demand is collapsing.`, 4);
    }
  }
  const ended = world.shocks.filter((s) => s.started && world.time >= s.startT + s.durationDays * 1440);
  for (const s of ended) {
    const p = world.products[s.productId];
    if (p) logEvent(world, "market", `${p.emoji} The ${s.kind === "hype" ? "craze" : "slump"} in ${p.name} is fading.`, 2);
  }
  world.shocks = world.shocks.filter((s) => !ended.includes(s));
  // Keep a couple of future shocks scheduled (researchers can foresee them).
  const pending = world.shocks.filter((s) => !s.started).length;
  if (pending < 2 && chance(world, 0.6)) {
    const pid = pick(world, world.productOrder);
    if (!world.shocks.some((s) => s.productId === pid)) {
      const hype = chance(world, 0.6);
      world.shocks.push({
        id: newId(world),
        productId: pid,
        kind: hype ? "hype" : "slump",
        startT: world.time + randInt(world, 2, 5) * 1440 + randInt(world, 6, 14) * 60,
        magnitude: hype ? round2(randRange(world, 1.6, 2.4)) : round2(randRange(world, 0.4, 0.65)),
        durationDays: randInt(world, 2, 4),
        started: false,
      });
    }
  }
}

function spawnClearanceLots(world: WorldState): void {
  const n = Math.round(CONFIG.externalLotsPerDay * randRange(world, 0.6, 1.4) * world.economy.multiplier);
  for (let i = 0; i < n; i++) {
    const pid = pick(world, world.productOrder);
    const m = world.market[pid];
    const p = world.products[pid];
    const qty = p.baseCost > 60 ? randInt(world, 1, 2) : randInt(world, 2, 5);
    addListing(world, "external", pid, qty, round2(refPrice(world, pid) * randRange(world, 0.42, 0.85)), 0);
    void m;
  }
}

// ----------------------------------------------------------- sales

export function recordRetailSale(world: WorldState, pid: ProductId, price: number, qty: number): void {
  const m = world.market[pid];
  if (!m) return;
  m.soldToday += qty;
  m.soldTotal += qty;
  m.revenueToday = round2(m.revenueToday + price * qty);
  const w = Math.min(0.3, 0.06 * qty);
  m.retail = round2(m.retail * (1 - w) + price * w);
  world.stats.hourRevenue += price * qty;
  world.stats.dayRevenue += price * qty;
}

/** Inventors earn a royalty on every retail sale of their invention. */
export function payRoyalty(world: WorldState, payerAcc: string, pid: ProductId, saleValue: number): void {
  const p = world.products[pid];
  if (!p?.inventorId || p.royalty <= 0) return;
  const amount = round2(saleValue * p.royalty);
  if (amount <= 0 || payerAcc === citizenAcc(p.inventorId)) return;
  if (transfer(world, payerAcc, citizenAcc(p.inventorId), amount, "royalty", `Royalty on ${p.name}`)) {
    creditOccupation(world, p.inventorId, amount);
  }
}

// ----------------------------------------------------------- depot

/** Buy goods at the Wholesale Depot. Returns units bought and total cost. */
export function buyFromDepot(world: WorldState, payerAcc: string, pid: ProductId, wantQty: number, budget: number): { qty: number; cost: number } {
  const m = world.market[pid];
  if (!m || wantQty <= 0) return { qty: 0, cost: 0 };
  const unit = m.wholesale;
  const qty = Math.min(wantQty, m.depotStock, Math.floor(budget / unit));
  if (qty <= 0) return { qty: 0, cost: 0 };
  const cost = round2(unit * qty);
  if (!transfer(world, payerAcc, externalAcc("depot"), cost, "wholesale", `${qty}× ${world.products[pid].name} from the depot`)) return { qty: 0, cost: 0 };
  m.depotStock -= qty;
  return { qty, cost };
}

// ------------------------------------------------------------ inventory

export function addStock(inv: Record<string, { qty: number; avgCost: number }>, pid: ProductId, qty: number, unitCost: number): void {
  const it = inv[pid] ?? { qty: 0, avgCost: 0 };
  const total = it.qty + qty;
  it.avgCost = total > 0 ? round2((it.avgCost * it.qty + unitCost * qty) / total) : unitCost;
  it.qty = total;
  inv[pid] = it;
}

export function removeStock(inv: Record<string, { qty: number; avgCost: number }>, pid: ProductId, qty: number): number {
  const it = inv[pid];
  if (!it || it.qty < qty) return 0;
  it.qty -= qty;
  const cost = it.avgCost;
  if (it.qty <= 0) delete inv[pid];
  return cost;
}

// ------------------------------------------------------------ listings

export function addListing(world: WorldState, sellerId: Citizen["id"] | "external", pid: ProductId, qty: number, price: number, unitCost: number): Listing {
  const l: Listing = { id: newId(world), sellerId, productId: pid, qty, price: round2(price), listedT: world.time, cost: unitCost };
  world.listings.push(l);
  return l;
}

export function listingCost(l: Listing): number {
  return l.cost ?? 0;
}

/** Remove a citizen's listing, returning unsold goods to their inventory. */
export function delist(world: WorldState, l: Listing): void {
  world.listings = world.listings.filter((x) => x.id !== l.id);
  if (l.sellerId !== "external" && l.qty > 0) {
    const c = world.citizens[l.sellerId];
    if (c) addStock(c.inventory, l.productId, l.qty, listingCost(l));
  }
}

/**
 * Buy from a marketplace listing. `buyer` is a citizen or the outside world.
 * Returns units bought.
 */
export function buyListing(world: WorldState, buyer: Citizen | "external", l: Listing, qty: number): number {
  qty = Math.min(qty, l.qty);
  if (qty <= 0) return 0;
  const total = round2(l.price * qty);
  const from = buyer === "external" ? externalAcc("market") : citizenAcc(buyer.id);
  const to = l.sellerId === "external" ? externalAcc("market") : citizenAcc(l.sellerId);
  const pname = world.products[l.productId]?.name ?? l.productId;
  if (from === to) return 0;
  if (!transfer(world, from, to, total, buyer === "external" ? "sale" : "trade", `${qty}× ${pname} on the Marketplace`)) return 0;
  l.qty -= qty;
  if (l.qty <= 0) world.listings = world.listings.filter((x) => x.id !== l.id);
  if (buyer !== "external") addStock(buyer.inventory, l.productId, qty, l.price);
  if (l.sellerId !== "external") {
    const profit = round2((l.price - listingCost(l)) * qty);
    creditOccupation(world, l.sellerId, profit);
    payRoyalty(world, to, l.productId, total);
  }
  if (buyer === "external") recordRetailSale(world, l.productId, l.price, qty);
  return qty;
}

export function listingsFor(world: WorldState, pid: ProductId): Listing[] {
  return world.listings.filter((l) => l.productId === pid && l.qty > 0);
}

export function describePrice(world: WorldState, pid: ProductId): string {
  const m = world.market[pid];
  return `${world.products[pid].name} sell for ~${money(refPrice(world, pid))} (wholesale ${money(m.wholesale)})`;
}
