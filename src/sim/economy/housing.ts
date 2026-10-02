import { CONFIG } from "../config";
import { getBuildingIndexed } from "../city/lookup";
import { logEvent } from "../events";
import { remember } from "../memory/memory";
import type { Building, Citizen, WorldState } from "../types";
import { money, round2 } from "../util";
import { citizenAcc, externalAcc, transfer } from "./ledger";

// Housing: everyone rents. Rent is charged weekly. Missed rent becomes
// arrears; too much arrears gets you evicted and you sleep in the park.

export function residentsOf(world: WorldState, buildingId: string): Citizen[] {
  return world.citizenOrder.map((id) => world.citizens[id]).filter((c) => c.homeId === buildingId && !c.homeless);
}

export function rentOf(world: WorldState, c: Citizen): number {
  const h = getBuildingIndexed(world.map, c.homeId);
  return h && !c.homeless ? round2(h.rent * world.economy.rentIndex) : 0;
}

/**
 * Weekly: landlords move rents toward a share of what people actually earn.
 * A prosperous town gets pricier — which squeezes the people left behind.
 */
export function reviewRents(world: WorldState): void {
  // Landlords price to what the typical tenant can afford: as the median
  // citizen's cash cushion grows, rents creep up and eat into it (and fall
  // back when people are struggling). Moves at most ~12% a week.
  const liquid = world.citizenOrder.map((id) => world.citizens[id].money + world.citizens[id].savings).sort((a, b) => a - b);
  if (liquid.length === 0) return;
  const median = liquid[Math.floor(liquid.length / 2)];
  const target = Math.min(2.5, Math.max(0.85, 0.85 + median / 1500));
  const before = world.economy.rentIndex;
  const next = round2(Math.min(before * 1.12, Math.max(before * 0.93, before * 0.6 + target * 0.4)));
  world.economy.rentIndex = next;
  const change = next / before - 1;
  if (change > 0.02) logEvent(world, "life", `🏠 Landlords are raising rents by ${Math.round(change * 100)}% — the town is getting pricier.`, 4);
  else if (change < -0.02) logEvent(world, "life", `🏠 Rents are coming down ${Math.round(-change * 100)}% as people struggle to pay.`, 3);
}

/** Pay from cash first, then savings. Returns amount actually paid. */
function payExternal(world: WorldState, c: Citizen, amount: number, to: string, memo: string): number {
  let paid = 0;
  const fromCash = Math.min(c.money, amount);
  if (fromCash > 0 && transfer(world, citizenAcc(c.id), externalAcc(to), fromCash, "rent", memo)) paid += fromCash;
  const rest = round2(amount - paid);
  if (rest > 0 && c.savings > 0) {
    const fromSavings = Math.min(c.savings, rest);
    c.savings = round2(c.savings - fromSavings);
    c.money = round2(c.money + fromSavings);
    if (transfer(world, citizenAcc(c.id), externalAcc(to), fromSavings, "rent", memo)) paid += fromSavings;
  }
  return round2(paid);
}

export function chargeRent(world: WorldState): void {
  for (const id of world.citizenOrder) {
    const c = world.citizens[id];
    if (!c.homeId || c.homeless) continue;
    const rent = rentOf(world, c);
    const due = round2(rent + c.rentArrears);
    const paid = payExternal(world, c, due, "landlord", "Weekly rent");
    c.rentArrears = round2(due - paid);
    if (c.rentArrears <= 0.01) {
      c.rentArrears = 0;
      continue;
    }
    if (c.rentArrears >= rent * CONFIG.evictAfterArrears) {
      evict(world, c);
    } else {
      logEvent(world, "life", `${c.name} couldn't pay the full rent and owes ${money(c.rentArrears)}.`, 3, [c.id]);
      remember(world, c, { text: `I couldn't pay my rent. I owe the landlord ${money(c.rentArrears)}.`, kind: "financial", importance: 7, valence: -0.8, people: [], key: "rent-arrears" });
      c.creditScore = Math.max(0, c.creditScore - 6);
      c.reviewRequested = "rent arrears";
    }
  }
}

/** Daily: anyone in arrears pays the landlord back as soon as they can. */
export function settleArrears(world: WorldState): void {
  for (const id of world.citizenOrder) {
    const c = world.citizens[id];
    if (c.rentArrears <= 0 || c.homeless) continue;
    const pay = Math.min(c.rentArrears, Math.max(0, c.money + c.savings - 10));
    if (pay <= 0) continue;
    const paid = payExternal(world, c, round2(pay), "landlord", "Paid off rent arrears");
    c.rentArrears = round2(c.rentArrears - paid);
    if (c.rentArrears <= 0.01) {
      c.rentArrears = 0;
      remember(world, c, { text: "I finally paid off my rent arrears.", kind: "financial", importance: 5, valence: 0.6, people: [], key: "rent-arrears" });
    }
  }
}

export function evict(world: WorldState, c: Citizen): void {
  c.homeless = true;
  c.homeId = null;
  c.rentArrears = 0;
  c.creditScore = Math.max(0, c.creditScore - 15);
  logEvent(world, "life", `🏚️ ${c.name} was evicted and is now sleeping in the park.`, 5, [c.id]);
  remember(world, c, { text: "I was evicted. I'm sleeping in the park now.", kind: "financial", importance: 9, valence: -1, people: [] });
  c.reviewRequested = "evicted";
}

export function vacantHomes(world: WorldState): Building[] {
  return world.map.buildings.filter((b) => (b.type === "house" || b.type === "apartments") && residentsOf(world, b.id).length < b.capacity);
}

/** A homeless citizen with enough cash rents the cheapest vacant place. */
export function tryRehouse(world: WorldState, c: Citizen): boolean {
  if (!c.homeless) return false;
  const options = vacantHomes(world).sort((a, b) => a.rent - b.rent);
  const home = options[0];
  if (!home) return false;
  const deposit = round2(home.rent * world.economy.rentIndex);
  if (c.money < deposit + 15) return false;
  if (!transfer(world, citizenAcc(c.id), externalAcc("landlord"), deposit, "rent", `First week's rent at ${home.name}`)) return false;
  c.homeless = false;
  c.homeId = home.id;
  logEvent(world, "life", `🏠 ${c.name} found a new home at ${home.name}.`, 3, [c.id]);
  remember(world, c, { text: `I got back on my feet and rented ${home.name}.`, kind: "financial", importance: 7, valence: 0.8, people: [] });
  return true;
}
