// Seeded, serialisable pseudo-random numbers (mulberry32).
//
// All simulation randomness MUST come from here so that a world created from
// the same seed (with Claude switched off) replays identically. The PRNG
// state lives in WorldState.rng, so it is saved/loaded with the world.

export interface RngHolder {
  rng: number;
}

export function rand(h: RngHolder): number {
  h.rng = (h.rng + 0x6d2b79f5) >>> 0;
  let t = h.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randRange(h: RngHolder, min: number, max: number): number {
  return min + rand(h) * (max - min);
}

export function randInt(h: RngHolder, min: number, max: number): number {
  return Math.floor(randRange(h, min, max + 1));
}

export function chance(h: RngHolder, p: number): boolean {
  return rand(h) < p;
}

export function pick<T>(h: RngHolder, items: readonly T[]): T {
  return items[Math.floor(rand(h) * items.length)];
}

/** Standard normal via Box-Muller. */
export function gauss(h: RngHolder): number {
  const u = Math.max(1e-9, rand(h));
  const v = rand(h);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function poisson(h: RngHolder, lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss(h)));
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand(h);
  } while (p > l);
  return k - 1;
}

/** Pick an item with probability proportional to weight (weights <= 0 skipped). */
export function weightedPick<T>(h: RngHolder, items: readonly T[], weight: (t: T) => number): T | null {
  let total = 0;
  for (const it of items) total += Math.max(0, weight(it));
  if (total <= 0) return null;
  let r = rand(h) * total;
  for (const it of items) {
    const w = Math.max(0, weight(it));
    if (r < w) return it;
    r -= w;
  }
  return items[items.length - 1];
}

export function shuffle<T>(h: RngHolder, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand(h) * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
