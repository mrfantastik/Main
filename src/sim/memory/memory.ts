import type { Citizen, CitizenId, Memory, MemoryKind, WorldState } from "../types";
import { clamp, newId } from "../util";

// Memory system.
//
// - Short-term memory: the last few things that happened (any importance).
// - Long-term memory: only important things (importance >= 5), capped.
// - Memories fade every day unless reinforced; trivial ones fade fastest.
// - Repeated similar memories merge ("Sarah lent me money" x3) instead of
//   piling up, which keeps memory small while making patterns stronger.
// - When long-term memory is full, the weakest memory is forgotten:
//   retention = importance x strength x (1 + |emotion|).

export const SHORT_LIMIT = 14;
export const LONG_LIMIT = 40;
export const LONG_TERM_THRESHOLD = 5;

export interface MemoryInput {
  text: string;
  kind: MemoryKind;
  importance: number;
  valence: number;
  people: CitizenId[];
  /** Memories with the same key are merged/reinforced. */
  key?: string;
}

function retention(m: Memory): number {
  return m.importance * m.strength * (1 + Math.abs(m.valence));
}

export function remember(world: WorldState, c: Citizen, input: MemoryInput): Memory {
  const key = input.key ?? `${input.kind}:${input.people.join(",")}:${input.text}`;
  const importance = clamp(input.importance, 1, 10);
  const existing = c.memories.long.find((m) => m.key === key) ?? c.memories.short.find((m) => m.key === key);
  if (existing) {
    existing.count++;
    existing.t = world.time;
    existing.strength = 1;
    existing.text = input.text;
    existing.importance = clamp(Math.max(existing.importance, importance) + 0.5, 1, 10);
    existing.valence = clamp((existing.valence + input.valence) / 2 + input.valence * 0.1, -1, 1);
    promote(c, existing);
    return existing;
  }
  const m: Memory = {
    id: newId(world),
    t: world.time,
    text: input.text,
    kind: input.kind,
    importance,
    valence: clamp(input.valence, -1, 1),
    people: input.people,
    strength: 1,
    count: 1,
    key,
  };
  c.memories.short.push(m);
  if (c.memories.short.length > SHORT_LIMIT) c.memories.short.shift();
  promote(c, m);
  return m;
}

function promote(c: Citizen, m: Memory): void {
  if (m.importance < LONG_TERM_THRESHOLD) return;
  if (!c.memories.long.includes(m)) c.memories.long.push(m);
  if (c.memories.long.length > LONG_LIMIT) {
    let weakest = 0;
    for (let i = 1; i < c.memories.long.length; i++) {
      if (retention(c.memories.long[i]) < retention(c.memories.long[weakest])) weakest = i;
    }
    c.memories.long.splice(weakest, 1);
  }
}

/** Daily fading. Important and emotional memories last much longer. */
export function decayMemories(c: Citizen): void {
  for (const m of c.memories.long) {
    const rate = 0.06 / (m.importance * (1 + Math.abs(m.valence)));
    m.strength = clamp(m.strength - rate, 0, 1);
  }
  c.memories.long = c.memories.long.filter((m) => m.strength > 0.08 || m.importance >= 9);
  const longIds = new Set(c.memories.long.map((m) => m.id));
  for (const m of c.memories.short) if (!longIds.has(m.id)) m.strength = clamp(m.strength - 0.25, 0, 1);
}

/** What do I remember about this person? Most significant first. */
export function recallAbout(c: Citizen, otherId: CitizenId, limit = 5): Memory[] {
  const seen = new Set<number>();
  const all = [...c.memories.long, ...c.memories.short].filter((m) => {
    if (seen.has(m.id) || !m.people.includes(otherId)) return false;
    seen.add(m.id);
    return true;
  });
  return all.sort((a, b) => retention(b) - retention(a)).slice(0, limit);
}

export function recallKind(c: Citizen, kind: MemoryKind, limit = 5): Memory[] {
  return c.memories.long.filter((m) => m.kind === kind).sort((a, b) => b.t - a.t).slice(0, limit);
}

/** Has this person ever betrayed me (in memories I still hold)? */
export function rememberBetrayal(c: Citizen, otherId: CitizenId): Memory | undefined {
  return c.memories.long.find((m) => m.kind === "betrayal" && m.people.includes(otherId));
}

/** Most recent memories, merged short + long, newest first. */
export function recentMemories(c: Citizen, limit = 10): Memory[] {
  const seen = new Set<number>();
  const all = [...c.memories.short, ...c.memories.long].filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  return all.sort((a, b) => b.t - a.t).slice(0, limit);
}
