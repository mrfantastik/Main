import type { SimEvent, Transaction, WorldState } from "../../sim/types";

/**
 * Storage for the persistent world. The simulation never touches storage
 * directly; the server saves snapshots and appends history through this.
 * Swap the implementation (e.g. Postgres) without touching the sim.
 */
export interface WorldStore {
  readonly kind: string;
  /** Latest saved world (raw JSON object), or null. */
  loadLatest(): unknown | null;
  saveSnapshot(world: WorldState): void;
  /** Append events/transactions newer than what was stored before. */
  appendHistory(worldId: string, events: SimEvent[], txs: Transaction[]): void;
  /** Older events beyond what the live world keeps in memory. */
  eventHistory(worldId: string, limit: number, beforeId?: number): SimEvent[];
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  close(): void;
}
