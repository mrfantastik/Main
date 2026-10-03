// Bugs found by the soak test and playtesting. Each test pins one fix.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, newWorld } from "../src/sim";
import { MIN_OWNER_SHARE, addPartner, createBusiness } from "../src/sim/economy/business";
import { addStock } from "../src/sim/economy/market";
import { sellPossessions } from "../src/sim/economy/reselling";
import { runTradingSession, maxPosition } from "../src/sim/economy/trading";
import { netWorth, ownerShare } from "../src/sim/economy/valuation";
import { applyGodCommand, GodError } from "../src/sim/god";
import { prepareLoadedWorld } from "../src/sim/migrate";
import { SimRunner } from "../src/sim/runner";

test("time skip plays out exactly like watching it", () => {
  const a = newWorld(31);
  const b = newWorld(31);
  new SimRunner(a).skip(1440 * 2);
  advance(b, 1440 * 2);
  assert.equal(JSON.stringify(a.citizens), JSON.stringify(b.citizens));
  assert.equal(a.time, b.time);
});

test("time skip pauses Claude and switches it back on afterwards", () => {
  const w = newWorld(32);
  w.ai.mode = "llm";
  let seen = "";
  const r = new SimRunner(w);
  r.afterSteps = (x) => (seen = x.ai.mode);
  r.skip(60);
  assert.equal(w.ai.mode, "llm");
  assert.equal(seen, "llm");
});

test("traders can't pump prices: positions are capped and a city can't mint billions", () => {
  // Seed 7 used to produce a trader worth £13bn within 120 days.
  const w = newWorld(7);
  advance(w, 1440 * 80);
  const richest = Math.max(...w.citizenOrder.map((id) => netWorth(w, w.citizens[id])));
  assert.ok(richest < 50_000, `richest citizen is worth £${Math.round(richest)}`);
  for (const id of w.citizenOrder) {
    const c = w.citizens[id];
    if (c.occupation !== "trader") continue;
    for (const pid of w.productOrder) assert.ok((c.inventory[pid]?.qty ?? 0) <= maxPosition(w, c, pid) + 50);
  }
});

test("a big buy order moves the price against the trader", () => {
  const w = newWorld(33);
  const c = w.citizens[w.citizenOrder[0]];
  c.occupation = "trader";
  c.money = 100_000;
  c.traits.risk = 1;
  const before = Object.fromEntries(w.productOrder.map((p) => [p, w.market[p].wholesale]));
  runTradingSession(w, c);
  for (const pid of w.productOrder) {
    const held = c.inventory[pid]?.qty ?? 0;
    assert.ok(held <= maxPosition(w, c, pid), `${pid}: holds ${held}`);
    if (held > 0) assert.ok(w.market[pid].wholesale > before[pid], `${pid} price didn't move`);
  }
});

test("partners can never own more than the founder sells", () => {
  const w = newWorld(34);
  const owner = w.citizens[w.citizenOrder[0]];
  owner.money += 500;
  const b = createBusiness(w, owner, "stall", ["food"], 200);
  assert.ok(b);
  for (const id of w.citizenOrder.slice(1, 8)) {
    const inv = w.citizens[id];
    inv.money += 500;
    addPartner(w, b!, inv, 50, 0.3);
  }
  assert.ok(ownerShare(b!) >= MIN_OWNER_SHARE - 1e-9, `founder keeps ${ownerShare(b!)}`);
});

test("selling belongings lists them instead of making them vanish", () => {
  const w = newWorld(35);
  const c = w.citizens[w.citizenOrder[0]];
  addStock(c.inventory, "phones", 2, 100);
  sellPossessions(w, c);
  const listing = w.listings.find((l) => l.sellerId === c.id && l.productId === "phones");
  assert.ok(listing, "no listing");
  assert.equal(listing!.qty, 2);
  assert.equal(listing!.cost, 100);
});

test("God Mode rejects nonsense amounts and prices instead of spreading NaN", () => {
  const w = newWorld(36);
  const c = w.citizens[w.citizenOrder[0]];
  const money = c.money;
  assert.throws(() => applyGodCommand(w, { cmd: "give_money", citizenId: c.id, amount: Number.NaN }), GodError);
  assert.throws(() => applyGodCommand(w, { cmd: "take_money", citizenId: c.id, amount: -5 }), GodError);
  assert.throws(() => applyGodCommand(w, { cmd: "set_price", productId: "food", price: Number.NaN }), GodError);
  assert.equal(c.money, money);
  assert.ok(Number.isFinite(w.market.food.wholesale));
});

test("after a boom or crash, demand returns fully to normal", () => {
  const w = newWorld(37);
  applyGodCommand(w, { cmd: "crash" });
  advance(w, 1440 * 9);
  assert.equal(w.economy.mode, "normal");
  assert.equal(w.economy.multiplier, 1);
});

test("loading junk instead of a save fails safely", () => {
  assert.equal(prepareLoadedWorld(null), null);
  assert.equal(prepareLoadedWorld({ citizens: {}, map: {}, time: 5 }), null);
  assert.equal(prepareLoadedWorld("hello"), null);
  const w = newWorld(38);
  assert.ok(prepareLoadedWorld(JSON.parse(JSON.stringify(w))));
});

test("old settled loans are forgotten so long games don't slow down", () => {
  const w = newWorld(39);
  advance(w, 1440 * 60);
  const stale = w.loans.filter((l) => l.status !== "active" && w.time - Math.max(l.dueT, l.startT) > 15 * 1440);
  assert.equal(stale.length, 0);
});
