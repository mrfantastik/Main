import { CONFIG } from "../config";
import { registerAction } from "../ai/actions";
import { setThought } from "../ai/decision";
import { getBuildingIndexed } from "../city/lookup";
import type { Citizen, WorldState } from "../types";
import { clamp } from "../util";
import { citizenAcc, externalAcc, transfer } from "./ledger";
import { remember } from "../memory/memory";
import { buyFromBusiness } from "./business";

/** How much a meal fills someone up (hunger is 0 starving .. 100 full). */
export const MEAL_FILLS = 62;

// Everyday life: eating, sleeping, resting, going out.

function withdrawForSpending(c: Citizen, amount: number): void {
  const need = Math.min(c.savings, amount - c.money);
  if (need > 0) {
    c.savings = Math.round((c.savings - need) * 100) / 100;
    c.money = Math.round((c.money + need) * 100) / 100;
  }
}

export function homeOrShelter(world: WorldState, c: Citizen): string {
  if (c.homeId && !c.homeless) return c.homeId;
  return "park";
}

function eatAtHome(c: Citizen): boolean {
  const food = c.inventory.food;
  if (!food || food.qty < 1) return false;
  food.qty -= 1;
  if (food.qty <= 0) delete c.inventory.food;
  return true;
}

export function registerLivingActions(): void {
  registerAction("EAT", {
    kind: "eat",
    validate(world, c, a) {
      const venue = String(a.params.venue ?? "diner");
      if (venue === "home") return (c.inventory.food?.qty ?? 0) >= 1 ? null : "No food at home";
      if (venue === "diner") return c.money + c.savings >= CONFIG.dinerMealPrice ? null : "Can't afford the diner";
      const b = world.businesses[venue];
      if (!b || !b.open) return "That café has closed";
      return c.money + c.savings >= (b.prices.food ?? 999) ? null : "Can't afford it";
    },
    complete(world, c, a, minutes) {
      if (minutes < 10) return;
      const venue = String(a.params.venue ?? "diner");
      let ate = false;
      if (venue === "home") ate = eatAtHome(c);
      else if (venue === "diner") {
        if (c.money < CONFIG.dinerMealPrice) withdrawForSpending(c, CONFIG.dinerMealPrice);
        ate = !!transfer(world, citizenAcc(c.id), externalAcc("diner"), CONFIG.dinerMealPrice, "meal", "Meal at City Diner");
      } else {
        const b = world.businesses[venue];
        if (b) ate = buyFromBusiness(world, b, c, "food", 1, true) > 0;
        if (b && !ate) {
          b.missedToday++;
          setThought(world, c, `Nobody was serving at ${b.name}. Wasted trip.`, 2);
        }
      }
      if (!ate && eatAtHome(c)) ate = true;
      if (ate) {
        c.needs.hunger = clamp(c.needs.hunger + MEAL_FILLS, 0, 100);
        c.needs.fun = clamp(c.needs.fun + 4, 0, 100);
      }
    },
  });

  registerAction("SLEEP", {
    kind: "sleep",
    complete(world, c) {
      if (c.homeless) c.needs.fun = clamp(c.needs.fun - 10, 0, 100);
      void world;
    },
  });

  registerAction("GO_HOME", { kind: "rest" });

  registerAction("REST", {
    kind: "rest",
    complete(_world, c, _a, minutes) {
      c.needs.energy = clamp(c.needs.energy + minutes * 0.02, 0, 100);
    },
  });

  registerAction("SOCIALIZE", {
    kind: "socialize",
    start(world, c, a) {
      // A drink at the pub costs money; the park is free.
      const b = getBuildingIndexed(world.map, a.buildingId);
      if (b?.type === "pub" && c.money >= CONFIG.pubDrinkPrice) {
        transfer(world, citizenAcc(c.id), externalAcc("pub"), CONFIG.pubDrinkPrice, "leisure", "Drinks at The Gilded Pint");
        c.needs.fun = clamp(c.needs.fun + 8, 0, 100);
      }
    },
  });
}

/** Unemployment benefit, paid daily. */
export function payWelfare(world: WorldState): void {
  for (const id of world.citizenOrder) {
    const c = world.citizens[id];
    if (c.occupation === "unemployed") {
      transfer(world, externalAcc("welfare"), citizenAcc(c.id), world.economy.welfare, "welfare", "Unemployment benefit");
      c.daysUnemployed++;
      if (c.daysUnemployed === 4) {
        remember(world, c, { text: "I've been out of work for days. It's getting worrying.", kind: "job", importance: 5, valence: -0.6, people: [] });
      }
    } else {
      c.daysUnemployed = 0;
    }
  }
}
