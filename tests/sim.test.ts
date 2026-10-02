import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, newWorld } from "../src/sim";
import { findRoute } from "../src/sim/city/pathfinding";
import type { WorldState } from "../src/sim/types";

function internalMoney(w: WorldState): number {
  let total = 0;
  for (const id of w.citizenOrder) total += w.citizens[id].money + w.citizens[id].savings;
  for (const id of w.businessOrder) total += w.businesses[id].cash;
  return total;
}

test("same seed produces the identical world (deterministic, AI off)", () => {
  const a = newWorld(1234);
  const b = newWorld(1234);
  advance(a, 1440 * 3);
  advance(b, 1440 * 3);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("different seeds produce different worlds", () => {
  const a = newWorld(1);
  const b = newWorld(2);
  advance(a, 1440 * 2);
  advance(b, 1440 * 2);
  assert.notEqual(JSON.stringify(a.citizens), JSON.stringify(b.citizens));
});

test("money is conserved: it only enters/leaves through recorded external flows", () => {
  const w = newWorld(77);
  advance(w, 600);
  const before = internalMoney(w);
  const firstTx = w.transactions[w.transactions.length - 1].id;
  advance(w, 1440 * 2);
  let net = 0;
  for (const t of w.transactions) {
    if (t.id <= firstTx) continue;
    const fromExt = t.from.startsWith("x:");
    const toExt = t.to.startsWith("x:");
    if (fromExt && !toExt) net += t.amount;
    if (!fromExt && toExt) net -= t.amount;
  }
  const after = internalMoney(w);
  assert.ok(Math.abs(after - before - net) < 0.5, `drift ${after - before - net}`);
});

test("everyone starts with £100", () => {
  const w = newWorld(5);
  // Founders took start-up loans, so check that nobody was simply handed money.
  for (const id of w.citizenOrder) {
    const c = w.citizens[id];
    const borrowed = w.loans.filter((l) => l.borrower === c.id).reduce((s, l) => s + l.principal, 0);
    const invested = c.businessIds.reduce((s, bid) => s + w.businesses[bid].ownerInvested, 0);
    assert.ok(Math.abs(c.money + invested - borrowed - 100) < 1e-6, `${c.name} started with ${c.money + invested - borrowed}`);
  }
});

test("no NaN or negative balances after a long run", () => {
  const w = newWorld(99);
  advance(w, 1440 * 12);
  for (const id of w.citizenOrder) {
    const c = w.citizens[id];
    for (const v of [c.money, c.savings, c.needs.energy, c.needs.hunger, c.mood, c.pos.x, c.pos.y]) assert.ok(Number.isFinite(v), `${c.name} has a non-finite value`);
    assert.ok(c.money >= -0.001 && c.savings >= -0.001, `${c.name} has negative money`);
  }
  for (const id of w.businessOrder) assert.ok(w.businesses[id].cash >= -0.001);
});

test("every building is reachable by road", () => {
  const w = newWorld(3);
  const from = w.map.buildings[0].door;
  for (const b of w.map.buildings) {
    const route = findRoute(w.map, from, b.door);
    assert.ok(route.length >= 1, `no route to ${b.id}`);
  }
});

test("citizens make autonomous decisions and keep a decision log", () => {
  const w = newWorld(11);
  advance(w, 1440 * 2);
  for (const id of w.citizenOrder) assert.ok(w.citizens[id].decisions.length > 0);
  assert.ok(w.businessOrder.length >= 1, "a business should exist");
  assert.ok(w.txCount > 100, "money should be moving");
});
