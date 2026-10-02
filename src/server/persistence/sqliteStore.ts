import { mkdirSync } from "node:fs";
import path from "node:path";
import type { SimEvent, Transaction, WorldState } from "../../sim/types";
import type { WorldStore } from "./store";

// SQLite storage using Node's built-in `node:sqlite` (no native install).
// Snapshots: the full world as JSON (last few kept for safety).
// History: every event and transaction, append-only, queryable later.

type DB = {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
  close(): void;
};

export async function openSqliteStore(file: string): Promise<WorldStore | null> {
  let DatabaseSync: new (f: string) => DB;
  try {
    // Silence the "experimental" warning node prints for node:sqlite.
    const original = process.emitWarning;
    process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
      if (String(w).includes("SQLite")) return;
      return (original as (...a: unknown[]) => void).call(process, w, ...rest);
    }) as typeof process.emitWarning;
    ({ DatabaseSync } = (await import("node:sqlite")) as unknown as { DatabaseSync: new (f: string) => DB });
    process.emitWarning = original;
  } catch {
    return null;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, world_id TEXT, saved_at TEXT, game_time INTEGER, data TEXT);
    CREATE TABLE IF NOT EXISTS events (world_id TEXT, id INTEGER, t INTEGER, cat TEXT, importance INTEGER, text TEXT, citizens TEXT, business_id TEXT, conversation_id INTEGER, PRIMARY KEY (world_id, id));
    CREATE TABLE IF NOT EXISTS transactions (world_id TEXT, id INTEGER, t INTEGER, from_acc TEXT, to_acc TEXT, amount REAL, kind TEXT, memo TEXT, PRIMARY KEY (world_id, id));
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  const insertSnap = db.prepare("INSERT INTO snapshots (world_id, saved_at, game_time, data) VALUES (?, ?, ?, ?)");
  const pruneSnaps = db.prepare("DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT 5)");
  const latest = db.prepare("SELECT data FROM snapshots ORDER BY id DESC LIMIT 1");
  const insEvent = db.prepare("INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insTx = db.prepare("INSERT OR IGNORE INTO transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const getMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
  const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const history = db.prepare("SELECT * FROM events WHERE world_id = ? AND id < ? ORDER BY id DESC LIMIT ?");

  return {
    kind: `SQLite (${path.basename(file)})`,
    loadLatest() {
      const row = latest.get() as { data: string } | undefined;
      if (!row) return null;
      try {
        return JSON.parse(row.data);
      } catch {
        return null;
      }
    },
    saveSnapshot(world: WorldState) {
      db.exec("BEGIN");
      try {
        insertSnap.run(world.id, new Date().toISOString(), world.time, JSON.stringify(world));
        pruneSnaps.run();
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    appendHistory(worldId: string, events: SimEvent[], txs: Transaction[]) {
      if (events.length === 0 && txs.length === 0) return;
      db.exec("BEGIN");
      try {
        for (const e of events) insEvent.run(worldId, e.id, e.t, e.cat, e.importance, e.text, JSON.stringify(e.citizens), e.businessId, e.conversationId ?? null);
        for (const t of txs) insTx.run(worldId, t.id, t.t, t.from, t.to, t.amount, t.kind, t.memo);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    eventHistory(worldId: string, limit: number, beforeId = Number.MAX_SAFE_INTEGER) {
      return (history.all(worldId, beforeId, limit) as Record<string, unknown>[]).map((r) => ({
        id: Number(r.id),
        t: Number(r.t),
        cat: r.cat as SimEvent["cat"],
        importance: Number(r.importance),
        text: String(r.text),
        citizens: JSON.parse(String(r.citizens ?? "[]")),
        businessId: (r.business_id as string) ?? null,
        conversationId: r.conversation_id === null ? undefined : Number(r.conversation_id),
      }));
    },
    getMeta(key: string) {
      const row = getMeta.get(key) as { value: string } | undefined;
      return row ? row.value : null;
    },
    setMeta(key: string, value: string) {
      setMeta.run(key, value);
    },
    close() {
      db.close();
    },
  };
}
