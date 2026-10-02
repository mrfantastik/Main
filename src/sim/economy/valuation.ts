import type { Business, Citizen, Inventory, WorldState } from "../types";
import { round2 } from "../util";

/** Value goods at a conservative resale price (between wholesale and retail). */
export function inventoryValue(world: WorldState, inv: Inventory): number {
  let v = 0;
  for (const [pid, item] of Object.entries(inv)) {
    const m = world.market[pid];
    if (!m || item.qty <= 0) continue;
    v += item.qty * (m.wholesale * 0.6 + m.retail * 0.4) * 0.85;
  }
  return round2(v);
}

export function businessValue(world: WorldState, b: Business): number {
  if (!b.open) return 0;
  const goodwill = b.history.length >= 3 ? Math.max(0, b.avgProfit) * 4 : 0;
  return round2(Math.max(0, b.cash + inventoryValue(world, b.inventory) + goodwill - b.unpaidWages));
}

/** Fraction of a business owned by its founder (partners hold the rest). */
export function ownerShare(b: Business): number {
  return Math.max(0, 1 - b.partners.reduce((s, p) => s + p.share, 0));
}

export function debtsOf(world: WorldState, c: Citizen): number {
  let d = c.rentArrears;
  for (const l of world.loans) if (l.borrower === c.id && l.status === "active") d += l.totalDue - l.paid;
  return round2(d);
}

export function receivablesOf(world: WorldState, c: Citizen): number {
  let r = 0;
  for (const l of world.loans) if (l.lender === c.id && l.status === "active") r += l.totalDue - l.paid;
  return round2(r);
}

export function equityOf(world: WorldState, c: Citizen): number {
  let e = 0;
  for (const bid of world.businessOrder) {
    const b = world.businesses[bid];
    if (!b.open) continue;
    if (b.ownerId === c.id) e += businessValue(world, b) * ownerShare(b);
    const p = b.partners.find((x) => x.citizenId === c.id);
    if (p) e += businessValue(world, b) * p.share;
  }
  return round2(e);
}

export function netWorth(world: WorldState, c: Citizen): number {
  return round2(c.money + c.savings + inventoryValue(world, c.inventory) + equityOf(world, c) + receivablesOf(world, c) - debtsOf(world, c));
}

/** Liquid money a citizen can actually spend. */
export function liquid(c: Citizen): number {
  return c.money + c.savings;
}
