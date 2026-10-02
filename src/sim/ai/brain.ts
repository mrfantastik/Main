import type { Citizen, PlannedAction, WorldState } from "../types";
import { activityOptions } from "./activity";
import { choose, recordDecision, setThought } from "./decision";
import { needsReview, strategicReview } from "./strategy";

// The citizen's brain. Called whenever a citizen finishes what they were
// doing. It may first reconsider its strategy (career, business, money),
// then chooses the next concrete action. All deterministic given the seed;
// Claude can be plugged in for the important strategic calls.

export function decideNext(world: WorldState, c: Citizen): PlannedAction {
  if (needsReview(world, c)) strategicReview(world, c);
  const options = activityOptions(world, c);
  const chosen = choose(world, options, 0.18);
  recordDecision(world, c, "activity", options, chosen, "utility", chosen.thought);
  setThought(world, c, chosen.thought, chosen.priority ?? 1);
  return chosen.payload;
}
