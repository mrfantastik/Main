import assert from "node:assert/strict";
import { test } from "node:test";
import { newWorld, advance } from "../src/sim";
import { decayMemories, LONG_LIMIT, recallAbout, remember, rememberBetrayal } from "../src/sim/memory/memory";
import { adjustRel, getRel, relLabel } from "../src/sim/social/relationships";

test("repeated similar memories merge and strengthen instead of piling up", () => {
  const w = newWorld(1);
  const [a, b] = w.citizenOrder.map((id) => w.citizens[id]);
  for (let i = 0; i < 3; i++) remember(w, a, { text: `${b.name} helped me out`, kind: "favor", importance: 6, valence: 0.8, people: [b.id], key: `help:${b.id}` });
  const m = a.memories.long.filter((x) => x.key === `help:${b.id}`);
  assert.equal(m.length, 1);
  assert.equal(m[0].count, 3);
  assert.ok(m[0].importance > 6);
});

test("trivial memories stay short-term; important ones go long-term", () => {
  const w = newWorld(2);
  const c = w.citizens[w.citizenOrder[0]];
  remember(w, c, { text: "Had a coffee", kind: "social", importance: 2, valence: 0.1, people: [] });
  remember(w, c, { text: "Got fired", kind: "job", importance: 8, valence: -0.9, people: [] });
  assert.ok(c.memories.short.some((m) => m.text === "Had a coffee"));
  assert.ok(!c.memories.long.some((m) => m.text === "Had a coffee"));
  assert.ok(c.memories.long.some((m) => m.text === "Got fired"));
});

test("long-term memory is capped and forgets the weakest first", () => {
  const w = newWorld(3);
  const c = w.citizens[w.citizenOrder[0]];
  remember(w, c, { text: "Life-changing", kind: "financial", importance: 10, valence: 1, people: [] });
  for (let i = 0; i < LONG_LIMIT + 10; i++) remember(w, c, { text: `event ${i}`, kind: "deal", importance: 5, valence: 0, people: [] });
  assert.equal(c.memories.long.length, LONG_LIMIT);
  assert.ok(c.memories.long.some((m) => m.text === "Life-changing"));
});

test("memories fade over time, important ones slower", () => {
  const w = newWorld(4);
  const c = w.citizens[w.citizenOrder[0]];
  const big = remember(w, c, { text: "Big", kind: "betrayal", importance: 9, valence: -1, people: [] });
  const small = remember(w, c, { text: "Small", kind: "deal", importance: 5, valence: 0, people: [] });
  for (let d = 0; d < 10; d++) decayMemories(c);
  assert.ok(big.strength > small.strength);
});

test("betrayals are remembered and recalled by person", () => {
  const w = newWorld(5);
  const [a, b] = w.citizenOrder.map((id) => w.citizens[id]);
  remember(w, a, { text: `${b.name} never paid me back`, kind: "betrayal", importance: 9, valence: -1, people: [b.id] });
  assert.ok(rememberBetrayal(a, b.id));
  assert.equal(recallAbout(a, b.id)[0].kind, "betrayal");
});

test("relationships clamp and get human labels", () => {
  const w = newWorld(6);
  const [a, b] = w.citizenOrder.map((id) => w.citizens[id]);
  adjustRel(w, a, b.id, { affinity: 500, trust: 500, familiarity: 500 });
  const r = getRel(a, b.id);
  assert.equal(r.affinity, 100);
  assert.equal(relLabel(r), r.roles.includes("family") ? "Family" : "Close friend");
  adjustRel(w, a, b.id, { affinity: -400 });
  assert.equal(r.affinity, -100);
});

test("friendships form on their own over time", () => {
  const w = newWorld(7);
  advance(w, 1440 * 10);
  let friends = 0;
  for (const id of w.citizenOrder) for (const r of Object.values(w.citizens[id].relationships)) if (r.affinity >= 35) friends++;
  assert.ok(friends > 5, `only ${friends} friendships`);
});
