import type { Citizen, WorldState } from "../types";
import { clamp } from "../util";

// Needs drift every game minute according to what the citizen is doing.
// They feed the utility AI: a hungry citizen scores EAT highly, etc.

export function updateNeeds(c: Citizen): void {
  const n = c.needs;
  const kind = c.activity.kind;
  const sociable = 0.5 + c.traits.sociability;

  if (kind === "sleep") {
    n.energy += c.homeless ? 0.13 : 0.2;
    n.hunger -= 0.035;
    n.social -= 0.01;
    n.fun -= 0.005;
  } else {
    n.energy -= kind === "work" || kind === "research" || kind === "manage" ? 0.085 : kind === "rest" ? 0.02 : 0.07;
    n.hunger -= 0.1;
    n.social -= 0.045 * sociable;
    n.fun -= 0.04;
    if (kind === "talk" || kind === "socialize") {
      n.social += 0.45;
      n.fun += 0.25;
    } else if (kind === "rest") {
      n.fun += 0.22;
      n.social += 0.03;
    } else if (kind === "shop" || kind === "browse") {
      n.fun += 0.08;
    } else if (kind === "work" || kind === "manage") {
      n.social += 0.02 * sociable;
    }
  }
  n.energy = clamp(n.energy, 0, 100);
  n.hunger = clamp(n.hunger, 0, 100);
  n.social = clamp(n.social, 0, 100);
  n.fun = clamp(n.fun, 0, 100);
}

/** Hourly mood update from needs, money worries and job status. */
export function updateMood(world: WorldState, c: Citizen): void {
  const n = c.needs;
  const cash = c.money + c.savings;
  const comfort = clamp(cash / 150, 0, 1.4);
  let target = n.energy * 0.2 + n.hunger * 0.2 + n.social * 0.15 + n.fun * 0.15 + comfort * 25;
  if (c.occupation === "unemployed") target -= 8;
  if (c.rentArrears > 0) target -= 10;
  if (c.homeless) target -= 15;
  const debts = world.loans.filter((l) => l.borrower === c.id && l.status === "active");
  if (debts.length) target -= 4 * debts.length;
  c.mood = clamp(c.mood * 0.7 + target * 0.3, 0, 100);
}
