// Game time is measured in minutes since Day 1, 00:00.

export const MIN_PER_HOUR = 60;
export const MIN_PER_DAY = 1440;

export function dayOf(t: number): number {
  return Math.floor(t / MIN_PER_DAY) + 1;
}

export function hourOf(t: number): number {
  return Math.floor((t % MIN_PER_DAY) / MIN_PER_HOUR);
}

/** Fractional hour of the day, 0..24. */
export function clockOf(t: number): number {
  return (t % MIN_PER_DAY) / MIN_PER_HOUR;
}

export function startOfDay(t: number): number {
  return Math.floor(t / MIN_PER_DAY) * MIN_PER_DAY;
}

export function formatClock(t: number): string {
  const m = Math.floor(t % MIN_PER_DAY);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function formatTime(t: number): string {
  return `Day ${dayOf(t)} ${formatClock(t)}`;
}

export function isNight(t: number): boolean {
  const h = clockOf(t);
  return h >= 22 || h < 6;
}

export function isWorkHours(t: number): boolean {
  const h = clockOf(t);
  return h >= 9 && h < 17;
}

/** Days until the next weekly rent day (rent is due at midnight every 7th day). */
export function daysUntilRent(t: number): number {
  const day = dayOf(t);
  const rem = 7 - ((day - 1) % 7);
  return rem;
}
