import { feel, impulsesFor, memoriesChanged, type FeelContext } from "../mind/emotions";
import type { Citizen, CitizenId, Emotions, Memory, MemoryKind, WorldState } from "../types";
import { clamp, newId } from "../util";

// Memory system.
//
// - Short-term memory: the last few minor things that happened.
// - Long-term memory: important things (importance >= 5), capped.
//   Each memory lives in exactly one list (important ones move to long-term),
//   so the state stays plain data that saves and reloads identically.
// - Memories fade every day unless reinforced; trivial ones fade fastest.
// - Repeated similar memories merge ("Sarah lent me money" x3) instead of
//   piling up, which keeps memory small while making patterns stronger.
// - When long-term memory is full, the weakest memory is forgotten:
//   retention = importance x strength x (1 + |emotion|).
// - Remembering something stirs feelings (see mind/emotions). The feelings
//   are stored on the memory, so recalling a person brings them back.

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
  /** The feelings it stirs (otherwise worked out from kind and valence). */
  feel?: Partial<Emotions>;
  feelCtx?: FeelContext;
}

/**
 * Store the feelings a memory stirred. When the same thing happens again the
 * feeling deepens, but with diminishing returns, so a run of small slights
 * becomes a grudge rather than an ever-growing fury.
 */
function addFeelings(m: Memory, applied: Partial<Emotions>): void {
  const keys = Object.keys(applied) as (keyof Emotions)[];
  if (!keys.length) return;
  m.emotions ??= {};
  for (const e of keys) {
    const old = m.emotions[e] ?? 0;
    const v = applied[e]!;
    const add = Math.sign(v) === Math.sign(old) ? v * Math.max(0.15, 1 - Math.abs(old) / 50) : v;
    m.emotions[e] = clamp(Math.round((old + add) * 10) / 10, -100, 100);
  }
}

function retention(m: Memory): number {
  return m.importance * m.strength * (1 + Math.abs(m.valence));
}

export function remember(world: WorldState, c: Citizen, input: MemoryInput): Memory {
  const key = input.key ?? `${input.kind}:${input.people.join(",")}:${input.text}`;
  const importance = clamp(input.importance, 1, 10);
  const existing = c.memories.long.find((m) => m.key === key) ?? c.memories.short.find((m) => m.key === key);
  const applied = feel(c, input.feel ?? impulsesFor(input.kind, importance, input.valence, input.people.length > 0), input.feelCtx);
  memoriesChanged(c);
  if (existing) {
    addFeelings(existing, applied);
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
  addFeelings(m, applied);
  c.memories.short.push(m);
  if (c.memories.short.length > SHORT_LIMIT) c.memories.short.shift();
  promote(c, m);
  return m;
}

function promote(c: Citizen, m: Memory): void {
  if (m.importance < LONG_TERM_THRESHOLD) return;
  c.memories.short = c.memories.short.filter((x) => x.id !== m.id);
  if (!c.memories.long.some((x) => x.id === m.id)) c.memories.long.push(m);
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
  memoriesChanged(c);
  for (const m of c.memories.long) {
    const rate = 0.06 / (m.importance * (1 + Math.abs(m.valence)));
    m.strength = clamp(m.strength - rate, 0, 1);
  }
  c.memories.long = c.memories.long.filter((m) => m.strength > 0.08 || m.importance >= 9);
  for (const m of c.memories.short) m.strength = clamp(m.strength - 0.25, 0, 1);
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
