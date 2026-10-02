import { CONFIG } from "../config";
import { homeOrShelter } from "../economy/living";
import { clockOf, MIN_PER_DAY, startOfDay } from "../time";
import type { Citizen, PlannedAction, WorldState } from "../types";
import { makeAction } from "./actions";

// STAGE 1 brain: a simple daily routine. (Replaced by the utility AI.)

function minutesUntilHour(t: number, hour: number): number {
  const target = startOfDay(t) + hour * 60;
  const m = target - t;
  return m > 0 ? m : m + MIN_PER_DAY;
}

export function decideNext(world: WorldState, c: Citizen): PlannedAction {
  const t = world.time;
  const h = clockOf(t);
  const home = homeOrShelter(world, c);
  if (h >= 22.5 || h < 5.5 || c.needs.energy < 10) {
    return makeAction("SLEEP", home, minutesUntilHour(t, 6.5 + (1 - c.traits.diligence) * 1.5), "Sleeping");
  }
  if (c.needs.hunger < 40 && c.money >= CONFIG.dinerMealPrice) {
    return makeAction("EAT", "diner", 40, "Eating at City Diner", { venue: "diner" });
  }
  if (h >= 9 && h < 17 && c.workedToday < 400) {
    const until = minutesUntilHour(t, 17);
    const untilT = t + until;
    if (c.occupation === "employee" && c.employerId === "corp") return makeAction("WORK", "office", until, "Working at CityCorp", { role: "corp", untilT });
    if (c.occupation === "freelancer") return makeAction("WORK", "cowork", until, "Freelancing at the Coworking Hub", { role: "freelance", earned: 0, untilT });
    if (c.occupation === "researcher") return makeAction("RESEARCH", "lab", until, "Researching at the Lab", { untilT });
    if (c.occupation === "unemployed") return makeAction("APPLY_FOR_JOB", "office", 60, "Applying for jobs at CityCorp", { target: "corp" });
  }
  if (h >= 18) return makeAction("SOCIALIZE", "pub", 90, "Having a drink at the pub");
  return makeAction("REST", "park", 60, "Relaxing in the park");
}
