import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SimEvent, Transaction, WorldState } from "../../sim/types";
import type { WorldStore } from "./store";

/** Fallback storage: a JSON file (used if node:sqlite isn't available). */
export function openJsonStore(dir: string): WorldStore {
  mkdirSync(dir, { recursive: true });
  const worldFile = path.join(dir, "world.json");
  const metaFile = path.join(dir, "meta.json");
  const readMeta = (): Record<string, string> => {
    try {
      return existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : {};
    } catch {
      return {};
    }
  };
  return {
    kind: "JSON file (world.json)",
    loadLatest() {
      for (const f of [worldFile, `${worldFile}.bak`]) {
        try {
          if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
        } catch {
          /* try the backup */
        }
      }
      return null;
    },
    saveSnapshot(world: WorldState) {
      const tmp = `${worldFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(world));
      if (existsSync(worldFile)) renameSync(worldFile, `${worldFile}.bak`);
      renameSync(tmp, worldFile);
    },
    appendHistory(_worldId: string, _events: SimEvent[], _txs: Transaction[]) {
      /* JSON fallback keeps only what the live world holds */
    },
    eventHistory() {
      return [];
    },
    getMeta(key: string) {
      return readMeta()[key] ?? null;
    },
    setMeta(key: string, value: string) {
      const m = readMeta();
      m[key] = value;
      writeFileSync(metaFile, JSON.stringify(m, null, 2));
    },
    close() {},
  };
}
