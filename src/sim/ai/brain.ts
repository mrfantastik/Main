import type { Citizen, PlannedAction, WorldState } from "../types";
import { activityOptions, type ActivityOption } from "./activity";
import { choose, recordDecision, setThought } from "./decision";
import { needsReview, strategicReview } from "./strategy";

// The citizen's brain. Called whenever a citizen finishes what they were
// doing. It may first reconsider its strategy (career, business, money),
// then chooses the next concrete action. All deterministic given the seed;
// a language model can be plugged in to make the choice (see setActivityHook).

/**
 * Optional hook used by the AI director: a language model's pick of what to
 * do next (asked ahead of time, while the citizen was still busy), or null
 * to leave it to the utility AI. `utility` is what the utility AI chose.
 */
export type ActivityHook = (world: WorldState, c: Citizen, options: ActivityOption[], utility: ActivityOption) => { option: ActivityOption; thought: string | null } | null;
let activityHook: ActivityHook | null = null;
export function setActivityHook(h: ActivityHook | null): void {
  activityHook = h;
}

export function decideNext(world: WorldState, c: Citizen): PlannedAction {
  if (needsReview(world, c)) strategicReview(world, c);
  const options = activityOptions(world, c);
  const chosen = choose(world, options, 0.18);
  const ai = activityHook?.(world, c, options, chosen);
  if (ai) {
    // Their reason, in their own words; or, if the model only picked, the option's own thought.
    recordDecision(world, c, "activity", options, ai.option, "llm", ai.thought ?? ai.option.thought);
    if (ai.thought) setThought(world, c, ai.thought, Math.max(2, ai.option.priority ?? 1), "llm");
    else setThought(world, c, ai.option.thought, ai.option.priority ?? 1);
    return ai.option.payload;
  }
  recordDecision(world, c, "activity", options, chosen, "utility", chosen.thought);
  setThought(world, c, chosen.thought, chosen.priority ?? 1);
  return chosen.payload;
}
