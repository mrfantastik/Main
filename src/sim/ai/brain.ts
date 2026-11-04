import type { Citizen, PlannedAction, WorldState } from "../types";
import { activityOptions, type ActivityOption } from "./activity";
import { makeAction, registerAction } from "./actions";
import { choose, cueThought, recordDecision, setThought } from "./decision";
import { needsReview, strategicReview } from "./strategy";

// The citizen's brain. Called whenever a citizen finishes what they were
// doing. It may first reconsider its strategy (career, business, money),
// then chooses the next concrete action. All deterministic given the seed;
// a language model can be plugged in to make the choice (see setActivityHook).
// With only the AI deciding (AI-only mode), the language model's pick is the
// only one there is: until it's made, they wait where they are.

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

/** How long someone waits before looking again for the AI's decision (game minutes). */
export const WAIT_MINUTES = 10;

/** Waiting where they are for the AI to decide what they do next (only the AI decides). */
export function waitForAI(c: Citizen): PlannedAction {
  return makeAction("WAIT", c.insideId, WAIT_MINUTES, "Making up their mind", { waiting: true });
}

/** They're standing there waiting for the AI to decide what they do. */
export function waitingForAI(c: Citizen): boolean {
  return c.activity.action?.type === "WAIT";
}

registerAction("WAIT", { kind: "idle" });

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
  // Only the AI decides: nothing's decided until it has.
  if (world.ai.aiOnly) return waitForAI(c);
  recordDecision(world, c, "activity", options, chosen, "utility", chosen.thought);
  setThought(world, c, chosen.thought, chosen.priority ?? 1);
  return chosen.payload;
}

/** The engine turned down what was decided (they can't afford it, it's shut): they think again. */
export function couldNotDo(world: WorldState, c: Citizen, label: string, err: string): void {
  const text = `I wanted to ${label.toLowerCase()}, but: ${err.toLowerCase()}.`;
  if (world.ai.aiOnly) cueThought(world, c, text, 2);
  else setThought(world, c, text, 2);
}
