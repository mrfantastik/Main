import type { Citizen, CitizenId, Relationship, RelRole, WorldState } from "../types";
import { clamp } from "../util";

// Relationships are asymmetric: each citizen holds their own view of others.

export function getRel(c: Citizen, otherId: CitizenId): Relationship {
  let r = c.relationships[otherId];
  if (!r) {
    r = { affinity: 0, trust: 0, familiarity: 0, roles: [], interactions: 0, lastT: 0 };
    c.relationships[otherId] = r;
  }
  return r;
}

export function peekRel(c: Citizen, otherId: CitizenId): Relationship | undefined {
  return c.relationships[otherId];
}

export interface RelDelta {
  affinity?: number;
  trust?: number;
  familiarity?: number;
}

/** Change how `c` feels about `otherId`. */
export function adjustRel(world: WorldState, c: Citizen, otherId: CitizenId, d: RelDelta): Relationship {
  const r = getRel(c, otherId);
  if (d.affinity) r.affinity = clamp(r.affinity + d.affinity, -100, 100);
  if (d.trust) r.trust = clamp(r.trust + d.trust, -100, 100);
  if (d.familiarity) r.familiarity = clamp(r.familiarity + d.familiarity, 0, 100);
  r.interactions++;
  r.lastT = world.time;
  return r;
}

/** Symmetric-ish interaction: both sides update (possibly by different amounts). */
export function interact(world: WorldState, a: Citizen, b: Citizen, dA: RelDelta, dB: RelDelta = dA): void {
  adjustRel(world, a, b.id, dA);
  adjustRel(world, b, a.id, dB);
}

export function addRole(c: Citizen, otherId: CitizenId, role: RelRole): void {
  const r = getRel(c, otherId);
  if (!r.roles.includes(role)) r.roles.push(role);
}

export function removeRole(c: Citizen, otherId: CitizenId, role: RelRole): void {
  const r = c.relationships[otherId];
  if (r) r.roles = r.roles.filter((x) => x !== role);
}

export function hasRole(c: Citizen, otherId: CitizenId, role: RelRole): boolean {
  return c.relationships[otherId]?.roles.includes(role) ?? false;
}

/** Human-readable label for a relationship, most significant first. */
export function relLabel(r: Relationship | undefined): string {
  if (!r) return "Stranger";
  const roles = r.roles;
  if (roles.includes("family")) return r.affinity < -40 ? "Estranged family" : "Family";
  if (roles.includes("partner") || roles.includes("investor") || roles.includes("investee")) return "Business partner";
  if (roles.includes("employer")) return "Employer";
  if (roles.includes("employee")) return "Employee";
  if (r.affinity <= -45) return "Enemy";
  if (roles.includes("rival")) return "Rival";
  if (roles.includes("creditor")) return "Creditor";
  if (roles.includes("debtor")) return "Debtor";
  if (r.affinity >= 65) return "Close friend";
  if (r.affinity >= 35) return "Friend";
  if (r.affinity <= -20) return "Dislikes";
  if (r.familiarity >= 8) return "Acquaintance";
  return "Stranger";
}

/** A single number for "how much do I value this person" used in utilities. */
export function bond(c: Citizen, otherId: CitizenId): number {
  const r = c.relationships[otherId];
  if (!r) return 0;
  return (r.affinity * 0.6 + r.trust * 0.4) / 100;
}

/** Daily drift: unattended relationships slowly cool, grudges slowly fade. */
export function decayRelationships(world: WorldState, c: Citizen): void {
  for (const id of Object.keys(c.relationships)) {
    const r = c.relationships[id];
    const idleDays = (world.time - r.lastT) / 1440;
    if (idleDays > 2) {
      r.affinity *= r.roles.includes("family") ? 0.995 : 0.985;
      r.familiarity = Math.max(0, r.familiarity - 0.3);
    }
    if (r.trust < 0) r.trust *= 0.995;
  }
}
