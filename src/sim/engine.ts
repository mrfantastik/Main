import { beginAction, finishActivity, makeAction, startActivity, tickActivity } from "./ai/actions";
import { decideNext } from "./ai/brain";
import { chargeRent } from "./economy/housing";
import { corpDaily, registerJobActions } from "./economy/jobs";
import { netWorth } from "./economy/valuation";
import { homeOrShelter, payWelfare, registerLivingActions } from "./economy/living";
import { registerResearchActions } from "./economy/research";
import { servicesHourly } from "./economy/services";
import { decayMemories } from "./memory/memory";
import { decayRelationships } from "./social/relationships";
import { statsDaily, statsHourly } from "./stats";
import { moveStep } from "./systems/movement";
import { updateMood, updateNeeds } from "./systems/needs";
import { dayOf, MIN_PER_DAY } from "./time";
import type { Citizen, WorldState } from "./types";
import { pushRing, round2 } from "./util";

// The simulation engine. Advances the world one game minute at a time.
// Everything here is deterministic given the world's RNG state.

let registered = false;
export function initEngine(): void {
  if (registered) return;
  registered = true;
  registerLivingActions();
  registerJobActions();
  registerResearchActions();
}

/** Advance the world by one game minute. */
export function step(world: WorldState): void {
  initEngine();
  world.time += 1;
  const t = world.time;

  for (const id of world.citizenOrder) {
    const c = world.citizens[id];
    updateNeeds(c);
    if (c.path.length > 0) {
      if (moveStep(c)) arrive(world, c);
      continue;
    }
    if (c.activity.kind === "travel") {
      arrive(world, c);
      continue;
    }
    tickActivity(world, c);
    if (t >= c.activity.endsAt) {
      finishActivity(world, c);
      think(world, c);
    }
  }

  if (t % 60 === 0) hourly(world);
  if (t % MIN_PER_DAY === 0) daily(world);
}

/** Run many steps (headless / fast-forward). */
export function advance(world: WorldState, minutes: number): void {
  for (let i = 0; i < minutes; i++) step(world);
}

function arrive(world: WorldState, c: Citizen): void {
  const dest = c.activity.buildingId;
  c.insideId = dest;
  if (c.spot) c.pos = { ...c.spot };
  const a = c.pending;
  if (a) startActivity(world, c, a);
  else finishActivity(world, c);
}

/** Decide what to do next and start doing it. */
function think(world: WorldState, c: Citizen): void {
  const action = decideNext(world, c);
  const err = beginAction(world, c, action);
  if (err) {
    // The engine refused the plan (e.g. can't afford it): fall back to resting.
    const fallback = makeAction("REST", c.insideId ?? homeOrShelter(world, c), 30, "Taking a breather");
    if (beginAction(world, c, fallback)) {
      c.activity = { kind: "idle", label: "Thinking", buildingId: c.insideId, startedAt: world.time, endsAt: world.time + 15, action: null };
    }
  }
}

function hourly(world: WorldState): void {
  const svc = servicesHourly(world);
  world.economy.servicePool = round2(svc.pool);
  world.economy.serviceSupplied = round2(svc.supplied);
  for (const id of world.citizenOrder) updateMood(world, world.citizens[id]);
  statsHourly(world);
}

function daily(world: WorldState): void {
  const day = dayOf(world.time - 1);
  payWelfare(world);
  corpDaily(world);
  if (day % 7 === 0) chargeRent(world);

  for (const id of world.citizenOrder) {
    const c = world.citizens[id];
    const nw = netWorth(world, c);
    pushRing(c.finance.history, { day, income: c.finance.incomeToday, expenses: c.finance.expensesToday, netWorth: nw }, 60);
    pushRing(c.finance.occupationEarnings, c.finance.occToday, 7);
    c.finance.peakNetWorth = Math.max(c.finance.peakNetWorth, nw);
    c.finance.incomeToday = 0;
    c.finance.expensesToday = 0;
    c.finance.sourcesToday = {};
    c.finance.occToday = 0;
    decayMemories(c);
    decayRelationships(world, c);
  }
  statsDaily(world);
}
