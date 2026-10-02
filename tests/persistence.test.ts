import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { advance, newWorld } from "../src/sim";
import { prepareLoadedWorld } from "../src/sim/migrate";
import { openJsonStore } from "../src/server/persistence/jsonStore";
import { openSqliteStore } from "../src/server/persistence/sqliteStore";

test("a saved and reloaded world continues exactly as if it never stopped", () => {
  const a = newWorld(808);
  advance(a, 1440 * 2 + 333);
  const b = prepareLoadedWorld(JSON.parse(JSON.stringify(a)))!;
  advance(a, 1440);
  advance(b, 1440);
  assert.equal(JSON.stringify(b), JSON.stringify(a));
});

test("SQLite store round-trips snapshots, history and meta", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hustle-"));
  try {
    const store = (await openSqliteStore(path.join(dir, "t.db")))!;
    assert.ok(store, "node:sqlite should be available on Node 22.13+");
    const w = newWorld(9);
    advance(w, 1440);
    store.appendHistory(w.id, w.events, w.transactions);
    store.saveSnapshot(w);
    store.setMeta("aiSpendUsd", "0.42");
    const loaded = prepareLoadedWorld(store.loadLatest())!;
    assert.equal(loaded.time, w.time);
    assert.equal(loaded.seed, w.seed);
    assert.equal(store.getMeta("aiSpendUsd"), "0.42");
    assert.equal(store.eventHistory(w.id, 1000).length, w.events.length);
    // Snapshots rotate (only the last 5 kept).
    for (let i = 0; i < 8; i++) store.saveSnapshot(w);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("JSON fallback store round-trips snapshots and meta", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hustle-"));
  try {
    const store = openJsonStore(dir);
    const w = newWorld(10);
    advance(w, 500);
    store.saveSnapshot(w);
    store.saveSnapshot(w);
    store.setMeta("k", "v");
    const loaded = prepareLoadedWorld(store.loadLatest())!;
    assert.equal(loaded.time, 500 + w.time - 500);
    assert.equal(store.getMeta("k"), "v");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loading clears in-flight AI state so nobody is stuck waiting", () => {
  const w = newWorld(11);
  advance(w, 600);
  const c = w.citizens[w.citizenOrder[0]];
  c.awaitingAI = true;
  const loaded = prepareLoadedWorld(JSON.parse(JSON.stringify(w)))!;
  assert.equal(loaded.citizens[c.id].awaitingAI, false);
});

test("garbage saves are rejected", () => {
  assert.equal(prepareLoadedWorld(null), null);
  assert.equal(prepareLoadedWorld({ hello: 1 }), null);
});
