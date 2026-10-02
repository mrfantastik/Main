import type { Transaction, TxKind, WorldState } from "../types";
import { newId, pushRing, round2 } from "../util";

// Every movement of money in the simulation goes through transfer().
// Accounts are strings: "c:<citizenId>", "b:<businessId>", "x:<external>".
// External accounts (landlord, wholesaler, visitors, CityCorp...) represent
// the world outside town: money flowing in or out of the town economy.

export const TX_LIMIT = 5000;
const CITIZEN_TX_LIMIT = 40;

/** Kinds that count as a citizen's *living* costs (not business costs). */
export const LIVING_KINDS: TxKind[] = ["rent", "meal", "leisure", "purchase"];

export function citizenAcc(id: string): string {
  return `c:${id}`;
}
export function businessAcc(id: string): string {
  return `b:${id}`;
}
export function externalAcc(name: string): string {
  return `x:${name}`;
}

export function balanceOf(world: WorldState, acc: string): number {
  const id = acc.slice(2);
  if (acc.startsWith("c:")) return world.citizens[id]?.money ?? 0;
  if (acc.startsWith("b:")) return world.businesses[id]?.cash ?? 0;
  return Infinity;
}

function adjust(world: WorldState, acc: string, delta: number): void {
  const id = acc.slice(2);
  if (acc.startsWith("c:")) {
    const c = world.citizens[id];
    if (c) c.money = round2(c.money + delta);
  } else if (acc.startsWith("b:")) {
    const b = world.businesses[id];
    if (b) b.cash = round2(b.cash + delta);
  }
}

/**
 * Move money between accounts. Fails (returns null) if the payer cannot
 * afford it — money is never created or destroyed inside the town.
 */
export function transfer(world: WorldState, from: string, to: string, amount: number, kind: TxKind, memo: string): Transaction | null {
  amount = round2(amount);
  if (!(amount > 0) || from === to) return null;
  if (balanceOf(world, from) + 1e-9 < amount) return null;
  adjust(world, from, -amount);
  adjust(world, to, amount);

  const tx: Transaction = { id: newId(world), t: world.time, from, to, amount, kind, memo };
  pushRing(world.transactions, tx, TX_LIMIT);
  world.txCount++;
  world.stats.dayTx++;

  const fromExt = from.startsWith("x:");
  const toExt = to.startsWith("x:");
  if (fromExt && !toExt) {
    world.stats.hourInflow += amount;
    world.stats.dayInflow += amount;
  } else if (!fromExt && toExt) {
    world.stats.hourOutflow += amount;
    world.stats.dayOutflow += amount;
  }

  if (from.startsWith("c:")) {
    const c = world.citizens[from.slice(2)];
    if (c) {
      c.finance.expensesToday = round2(c.finance.expensesToday + amount);
      c.finance.lifetimeExpenses = round2(c.finance.lifetimeExpenses + amount);
      pushRing(c.txIds, tx.id, CITIZEN_TX_LIMIT);
    }
  }
  if (to.startsWith("c:")) {
    const c = world.citizens[to.slice(2)];
    if (c) {
      c.finance.incomeToday = round2(c.finance.incomeToday + amount);
      c.finance.lifetimeIncome = round2(c.finance.lifetimeIncome + amount);
      c.finance.sourcesToday[kind] = round2((c.finance.sourcesToday[kind] ?? 0) + amount);
      pushRing(c.txIds, tx.id, CITIZEN_TX_LIMIT);
    }
  }
  return tx;
}

/** Credit a citizen's occupational earnings (economic profit, not just cash). */
export function creditOccupation(world: WorldState, citizenId: string, amount: number): void {
  const c = world.citizens[citizenId];
  if (c) c.finance.occToday = round2(c.finance.occToday + amount);
}

export function findTx(world: WorldState, id: number): Transaction | undefined {
  // Transactions are appended in id order, so binary search.
  const arr = world.transactions;
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].id === id) return arr[mid];
    if (arr[mid].id < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}
