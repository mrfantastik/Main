import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, newWorld } from "../src/sim";
import { applyGodCommand } from "../src/sim/god";

test("give and take money move real money and are remembered", () => {
  const w = newWorld(21);
  const c = w.citizens[w.citizenOrder[0]];
  const before = c.money;
  applyGodCommand(w, { cmd: "give_money", citizenId: c.id, amount: 1000 });
  assert.equal(Math.round(c.money - before), 1000);
  assert.ok(c.memories.long.some((m) => m.text.includes("out of nowhere")));
  applyGodCommand(w, { cmd: "take_money", citizenId: c.id, amount: 400 });
  assert.equal(Math.round(c.money - before), 600);
  assert.ok(w.events.some((e) => e.cat === "god"));
});

test("a windfall makes citizens reconsider their lives", () => {
  const w = newWorld(22);
  advance(w, 600);
  const c = w.citizenOrder.map((id) => w.citizens[id]).find((x) => x.occupation === "employee")!;
  applyGodCommand(w, { cmd: "give_money", citizenId: c.id, amount: 1000 });
  advance(w, 1440);
  assert.ok(c.strategyLog.length > 0, "a strategic review should have happened");
});

test("shortage raises wholesale prices; surplus floods the market", () => {
  const w = newWorld(23);
  const before = w.market.phones.wholesale;
  applyGodCommand(w, { cmd: "shortage", productId: "phones" });
  advance(w, 60 * 12);
  assert.ok(w.market.phones.wholesale > before * 1.1);
  const lots = w.listings.length;
  applyGodCommand(w, { cmd: "surplus", productId: "books" });
  assert.ok(w.listings.length > lots);
  assert.ok(w.market.books.supply > 2);
});

test("set price, hype, jobs, spawning and closing businesses", () => {
  const w = newWorld(24);
  applyGodCommand(w, { cmd: "set_price", productId: "coffee", price: 2.5 });
  assert.equal(w.market.coffee.wholesale, 2.5);
  applyGodCommand(w, { cmd: "hype", productId: "books" });
  advance(w, 60 * 10);
  assert.ok(w.market.books.trend > 1.3);
  const c = w.citizenOrder.map((id) => w.citizens[id]).find((x) => x.occupation === "freelancer")!;
  applyGodCommand(w, { cmd: "set_job", citizenId: c.id, occupation: "employee" });
  assert.equal(c.occupation, "employee");
  assert.equal(c.employerId, "corp");
  const d = w.citizenOrder.map((id) => w.citizens[id]).find((x) => x.businessIds.length === 0 && x.id !== c.id)!;
  applyGodCommand(w, { cmd: "spawn_business", citizenId: d.id, kind: "shop", productId: "trainers" });
  const b = w.businesses[d.businessIds[0]];
  assert.ok(b && b.open && b.products.includes("trainers"));
  assert.equal(d.occupation, "shopkeeper");
  applyGodCommand(w, { cmd: "close_business", businessId: b.id });
  assert.equal(b.open, false);
});

test("a crash shrinks demand and causes layoffs; a boom expands it", () => {
  const w = newWorld(25);
  advance(w, 300);
  applyGodCommand(w, { cmd: "crash" });
  advance(w, 1440 + 60);
  assert.ok(w.economy.multiplier < 0.7, `multiplier ${w.economy.multiplier}`);
  assert.ok(w.corpEmployees.length <= 3, "CityCorp should have laid people off");
  applyGodCommand(w, { cmd: "boom" });
  advance(w, 1440);
  assert.ok(w.economy.multiplier > 1.4);
  advance(w, 1440 * 4);
  assert.equal(w.economy.mode, "normal");
});
