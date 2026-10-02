import { CONFIG } from "../config";
import { getBuildingIndexed } from "../city/lookup";
import { corpOpenings } from "../economy/jobs";
import { homeOrShelter } from "../economy/living";
import { travelMinutes } from "../systems/movement";
import { MIN_PER_DAY, startOfDay } from "../time";
import type { Citizen, Occupation, PlannedAction, WorldState } from "../types";
import { money } from "../util";
import { makeAction } from "./actions";
import type { Option } from "./decision";
import { costPenalty, situation, type Situation } from "./situation";

// Tactical decisions: "what should I do next?" Generates scored options from
// needs, schedule, money worries and personality. Occupation-specific work
// options come from pluggable providers so new professions can be added.

export type ActivityOption = Option<PlannedAction>;
export type ActivityProvider = (world: WorldState, c: Citizen, s: Situation) => ActivityOption[];

const workProviders = new Map<Occupation, ActivityProvider[]>();
const extraProviders: ActivityProvider[] = [];

export function registerWorkProvider(occ: Occupation, fn: ActivityProvider): void {
  const list = workProviders.get(occ) ?? [];
  list.push(fn);
  workProviders.set(occ, list);
}

export function registerActivityProvider(fn: ActivityProvider): void {
  extraProviders.push(fn);
}

export function untilHour(t: number, hour: number): number {
  const target = startOfDay(t) + hour * 60;
  const m = target - t;
  return m > 0 ? m : m + MIN_PER_DAY;
}

export function travelPenalty(world: WorldState, c: Citizen, buildingId: string): number {
  const b = getBuildingIndexed(world.map, buildingId);
  return b ? -travelMinutes(c, b) / 140 : 0;
}

function opt(id: string, label: string, factors: Record<string, number>, payload: PlannedAction, thought: string, priority = 1): ActivityOption {
  return { id, label, factors, payload, thought, priority };
}

/** Work-hour suitability: 1 inside core hours, partial at the edges. */
export function hoursFactor(h: number, start: number, end: number, edge = 1): number {
  if (h >= start && h < end) return 1;
  if (h >= start - edge && h < start) return 0.4;
  if (h >= end && h < end + edge) return 0.3;
  return 0;
}

function needsOptions(world: WorldState, c: Citizen, s: Situation): ActivityOption[] {
  const out: ActivityOption[] = [];
  const h = s.hour;
  const home = homeOrShelter(world, c);
  const t = world.time;

  // --- sleep
  {
    const wakeH = 6 + (1 - c.traits.diligence) * 1.8 + (c.id.charCodeAt(1) % 5) * 0.12;
    const evening = h >= 20;
    const beforeWake = h < wakeH;
    const night = h >= 22 || h < 5 ? 1.7 : h >= 21 ? 0.55 : beforeWake ? 0.25 : -1.3;
    const f: Record<string, number> = { night, tiredness: s.tired ** 2 * 2.6 };
    if (c.needs.energy < 12) f.exhausted = 2.2;
    let minutes: number;
    let thought: string;
    if (evening || beforeWake) {
      minutes = Math.max(evening ? 300 : 30, untilHour(t, wakeH));
      thought = c.homeless
        ? "Another night on a park bench. I have to turn this around."
        : s.worry
          ? "Can't stop worrying about money... but I need sleep."
          : evening
            ? "Long day. Time for bed."
            : "Too early. Five more minutes...";
    } else {
      minutes = 60 + Math.round(s.tired * 60);
      thought = "I'm exhausted. I need a nap.";
    }
    out.push(opt("sleep", c.homeless ? "Sleep in the park" : "Go home and sleep", f, makeAction("SLEEP", home, minutes, c.homeless ? "Sleeping rough in the park" : "Sleeping"), thought));
  }

  // --- eat
  if (s.hungry > 0.22) {
    const hunger = s.hungry ** 1.6 * 2.7;
    const mealtime = (h >= 7 && h < 9.5) || (h >= 12 && h < 14) || (h >= 18 && h < 20.5) ? 0.35 : 0;
    if (h >= 7 && h < 22) {
      out.push(
        opt(
          "eat_diner",
          `Eat at City Diner (${money(CONFIG.dinerMealPrice)})`,
          { hunger, mealtime, cost: -costPenalty(c, s, CONFIG.dinerMealPrice), travel: travelPenalty(world, c, "diner") },
          makeAction("EAT", "diner", 40, "Eating at City Diner", { venue: "diner" }),
          s.hungry > 0.7 ? "I'm starving. Diner, now." : `${h < 11 ? "Breakfast" : h < 16 ? "Lunch" : "Dinner"} at the diner sounds good.`,
          s.hungry > 0.7 ? 2 : 1,
        ),
      );
    }
    if ((c.inventory.food?.qty ?? 0) > 0) {
      out.push(
        opt(
          "eat_home",
          "Cook at home",
          { hunger, mealtime, thrifty: 0.25 + c.traits.frugality * 0.3, travel: travelPenalty(world, c, home) },
          makeAction("EAT", home, 35, "Cooking at home", { venue: "home" }),
          "I've got groceries at home — no point paying the diner.",
        ),
      );
    }
  }

  // --- go out
  const hasDuty = c.occupation === "employee" && h >= 9 && h < 17 && c.workedToday < 300;
  if (h >= 11 || h < 1) {
    out.push(
      opt(
        "pub",
        "Have a drink at the pub",
        {
          lonely: s.lonely * (0.5 + c.traits.sociability) * 1.3,
          bored: s.bored * 0.5,
          evening: h >= 18 || h < 1 ? 0.5 : h >= 12 && h < 14 ? 0.1 : -0.1,
          cost: -costPenalty(c, s, CONFIG.pubDrinkPrice),
          duty: hasDuty ? -0.6 : 0,
          travel: travelPenalty(world, c, "pub"),
        },
        makeAction("SOCIALIZE", "pub", 75 + Math.round(c.traits.sociability * 60), "At the pub"),
        s.lonely > 0.6 ? "I need to see some people. Pub?" : "A pint and a chat would be nice.",
      ),
    );
  }
  if (h >= 6 && h < 21) {
    out.push(
      opt(
        "park_social",
        "Hang out in the park",
        { lonely: s.lonely * (0.4 + c.traits.sociability) * 0.9, bored: s.bored * 0.35, daytime: 0.12, duty: hasDuty ? -0.6 : 0, travel: travelPenalty(world, c, "park") },
        makeAction("SOCIALIZE", "park", 60, "Hanging out in the park"),
        "It's a nice day for the park. Maybe I'll bump into someone.",
      ),
    );
    out.push(
      opt(
        "rest_park",
        "Relax in the park",
        { bored: s.bored * 0.6, tired: s.tired * 0.25, lazy: (1 - c.traits.diligence) * 0.3, duty: hasDuty ? -0.6 : 0, travel: travelPenalty(world, c, "park") },
        makeAction("REST", "park", 50, "Relaxing in the park"),
        c.traits.diligence < 0.3 ? "Work can wait. The park can't." : "I'll clear my head with a walk in the park.",
      ),
    );
  }
  if (!c.homeless) {
    out.push(
      opt(
        "rest_home",
        "Chill at home",
        {
          tired: s.tired * 0.5,
          evening: h >= 20 || h < 6 ? 0.45 : 0,
          homebody: (1 - c.traits.sociability) * 0.35,
          duty: hasDuty ? -0.6 : 0,
          travel: travelPenalty(world, c, home),
        },
        makeAction("GO_HOME", home, 60, "Chilling at home"),
        "I'll put my feet up at home for a bit.",
      ),
    );
  }
  return out;
}

// ------------------------------------------------- built-in work providers

registerWorkProvider("employee", (world, c, s) => {
  if (c.employerId !== "corp") return [];
  const h = s.hour;
  if (h < 8.5 || h >= 16.5 || c.workedToday >= 400) return [];
  const untilT = world.time + untilHour(world.time, 17);
  return [
    opt(
      "work_corp",
      "Go to work at CityCorp",
      {
        duty: 1.05 * (0.35 + c.traits.diligence),
        pressure: s.pressure * 0.6,
        ambition: c.traits.ambition * 0.25,
        late: h > 10 ? -0.25 : 0,
        fatigue: s.tired > 0.75 ? -0.7 : 0,
      },
      makeAction("WORK", "office", untilT - world.time, "Working at CityCorp", { role: "corp", untilT }),
      s.worry ?? (c.traits.diligence > 0.6 ? "Time to clock in at CityCorp." : c.traits.diligence < 0.3 ? "Ugh, work. At least it pays." : "Off to CityCorp."),
      s.worry ? 2 : 1,
    ),
  ];
});

registerWorkProvider("freelancer", (world, c, s) => {
  const h = s.hour;
  const remaining = s.workTarget - c.workedToday;
  const inHours = hoursFactor(h, 9, 18, 2);
  if (inHours <= 0 || remaining < 30) return [];
  const belief = c.beliefs.occupationIncome.freelancer?.value ?? 35;
  const minutes = Math.min(remaining, 150 + Math.round(c.traits.diligence * 120));
  return [
    opt(
      "freelance",
      "Freelance at the Cowork Hub",
      {
        hours: inHours * 0.4,
        drive: 0.25 + c.traits.diligence * 0.7,
        pressure: s.pressure * 0.9,
        pay: belief / 100,
        ambition: c.traits.ambition * 0.3,
        fatigue: s.tired > 0.75 ? -0.7 : 0,
      },
      makeAction("WORK", "cowork", minutes, "Freelancing at the Cowork Hub", { role: "freelance", earned: 0 }),
      s.worry ?? (c.cooldowns.lastGigEarned ? `Last session paid ${money(c.cooldowns.lastGigEarned)}. Let's find more clients.` : "Time to find some clients."),
      s.worry ? 2 : 1,
    ),
  ];
});

registerWorkProvider("researcher", (world, c, s) => {
  const h = s.hour;
  const remaining = s.workTarget - c.workedToday;
  const inHours = hoursFactor(h, 9, 17, 1.5);
  if (inHours <= 0 || remaining < 30) return [];
  const minutes = Math.min(remaining, 240);
  const close = c.research.points > 60;
  return [
    opt(
      "research",
      "Research at the Lab",
      {
        hours: inHours * 0.4,
        drive: 0.3 + c.traits.diligence * 0.7,
        curiosity: c.traits.ambition * 0.3,
        pressure: s.pressure * 0.5,
        breakthrough: close ? 0.25 : 0,
        fatigue: s.tired > 0.75 ? -0.7 : 0,
      },
      makeAction("RESEARCH", "lab", minutes, "Researching at the Lab"),
      close ? "I'm close to something big. Back to the lab." : s.worry ?? "Back to the experiments.",
    ),
  ];
});

registerWorkProvider("unemployed", (world, c, s) => {
  const h = s.hour;
  if (h < 9 || h >= 17) return [];
  const triedRecently = world.time - (c.cooldowns.jobHunt ?? -9999) < 240;
  const openings = corpOpenings(world);
  return [
    opt(
      "job_hunt_corp",
      "Apply for jobs at CityCorp",
      {
        need: 0.55 + s.pressure * 0.8,
        ambition: c.traits.ambition * 0.4,
        openings: openings > 0 ? 0.45 : -0.35,
        lazy: -(1 - c.traits.diligence) * 0.45,
        tried: triedRecently ? -0.9 : 0,
      },
      makeAction("APPLY_FOR_JOB", "office", 60, "Applying for jobs at CityCorp", { target: "corp" }),
      openings > 0 ? `CityCorp has ${openings} opening${openings > 1 ? "s" : ""}. I'm applying.` : "CityCorp isn't hiring, but it's worth asking.",
      2,
    ),
  ];
});

export function activityOptions(world: WorldState, c: Citizen): ActivityOption[] {
  const s = situation(world, c);
  const out = needsOptions(world, c, s);
  for (const p of workProviders.get(c.occupation) ?? []) out.push(...p(world, c, s));
  for (const p of extraProviders) out.push(...p(world, c, s));
  return out;
}
