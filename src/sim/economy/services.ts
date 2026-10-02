import { CONFIG } from "../config";
import { randRange } from "../rng";
import { hourOf } from "../time";
import type { Citizen, WorldState } from "../types";
import { round2 } from "../util";

// The services market: outside clients want design/dev/marketing work done.
// A fixed pot of work per hour is shared between everyone currently working
// on it (freelancers and agency staff). More providers = smaller slices, so
// a crowded freelance scene pushes people into other careers.

export function providerCapacity(c: Citizen): number {
  return CONFIG.serviceRateCap * (0.35 + c.skills.tech / 100) * (0.7 + c.traits.diligence * 0.6);
}

export interface ServiceHour {
  pool: number;
  supplied: number;
}

export function servicesHourly(world: WorldState): ServiceHour {
  const h = hourOf(world.time);
  if (h < 8 || h >= 20) return { pool: 0, supplied: 0 };
  const pool = (world.economy.serviceDemand * world.economy.multiplier * randRange(world, 0.75, 1.25)) / 12;

  interface Slot {
    cap: number;
    pay: (amount: number) => void;
  }
  const slots: Slot[] = [];
  for (const id of world.citizenOrder) {
    const c = world.citizens[id];
    const a = c.activity.action;
    if (!a || c.activity.kind !== "work") continue;
    if (a.type === "WORK" && a.params.role === "freelance") {
      slots.push({ cap: providerCapacity(c), pay: (x) => (a.params.earned = round2(Number(a.params.earned ?? 0) + x)) });
    }
  }
  // Agencies: their staff work as a team (more productive, revenue to the firm).
  for (const bid of world.businessOrder) {
    const b = world.businesses[bid];
    if (!b.open || b.kind !== "agency") continue;
    const staff = world.citizenOrder
      .map((id) => world.citizens[id])
      .filter((c) => c.insideId === b.buildingId && (c.activity.kind === "work" || c.activity.kind === "manage") && (c.id === b.ownerId || c.employerId === b.id));
    if (staff.length === 0) continue;
    const owner = world.citizens[b.ownerId];
    const synergy = 1.15 + (owner ? owner.skills.management / 400 : 0) + Math.min(0.3, staff.length * 0.05);
    const cap = staff.reduce((s, c) => s + providerCapacity(c), 0) * synergy * (0.6 + b.reputation / 125);
    slots.push({
      cap,
      pay: (x) => {
        b.agencyEarned = round2((b.agencyEarned ?? 0) + x);
      },
    });
  }
  const totalCap = slots.reduce((s, x) => s + x.cap, 0);
  if (totalCap <= 0) return { pool, supplied: 0 };
  const ratio = Math.min(1, pool / totalCap);
  for (const s of slots) s.pay(s.cap * ratio);
  return { pool, supplied: Math.min(pool, totalCap) };
}
