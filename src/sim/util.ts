import type { WorldState } from "./types";

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function money(v: number): string {
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  return `${sign}£${a >= 1000 ? Math.round(a).toLocaleString("en-GB") : a >= 100 ? Math.round(a) : a.toFixed(a % 1 === 0 ? 0 : 2)}`;
}

/** "the Marketplace" -> "The Marketplace" at the start of a sentence. */
export function capitalise(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

export function newId(world: WorldState): number {
  return world.nextId++;
}

export function pushRing<T>(arr: T[], item: T, limit: number): void {
  arr.push(item);
  // Big logs (events, transactions) trim in batches: dropping one item from
  // the front of a 5,000-item array on every push is surprisingly slow.
  if (arr.length > limit && (limit < 500 || arr.length > limit + (limit >> 4))) arr.splice(0, arr.length - limit);
}

export function sum(values: number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

export function avg(values: number[]): number {
  return values.length ? sum(values) / values.length : 0;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** How people say a number of days from now: "tomorrow", "in 3 days", "in a week", "in a fortnight". */
export function inDays(n: number): string {
  const d = Math.max(1, Math.round(n));
  if (d === 1) return "tomorrow";
  if (d === 7) return "in a week";
  if (d === 14) return "in a fortnight";
  return `in ${d} days`;
}
