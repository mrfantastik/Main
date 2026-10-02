import { hireAtCorp } from "./economy/jobs";
import type { WorldState } from "./types";
import { citizensList } from "./world";

/**
 * Give the starting citizens their starting situation: jobs at CityCorp for
 * employees. (Starting businesses are set up by the economy stage.)
 * Everyone still has exactly £100 in their pocket.
 */
export function setupStartingEconomy(world: WorldState): void {
  for (const c of citizensList(world)) {
    if (c.occupation === "employee") {
      hireAtCorp(world, c);
    }
  }
  // Starting hires shouldn't flood the event feed / memories.
  world.events = [];
  for (const c of citizensList(world)) {
    c.memories.short = [];
    c.memories.long = [];
    c.reviewRequested = null;
  }
}
