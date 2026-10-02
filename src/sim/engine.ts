import { beginAction, finishActivity, makeAction, startActivity, tickActivity } from "./ai/actions";
import { updateBeliefsDaily } from "./ai/beliefs";
import { decideNext } from "./ai/brain";
import "./ai/economyActivities";
import "./ai/economyStrategy";
import { interestDaily, loansDaily, registerBankActions } from "./economy/bank";
import { agencyHourly, businessDaily, salesHourly } from "./economy/business";
import { marketDaily, marketHourly } from "./economy/market";
import { registerOperationsActions } from "./economy/operations";
import { registerResellerActions } from "./economy/reselling";
import { registerShoppingActions, updateWants } from "./economy/shopping";
import { registerTradingActions } from "./economy/trading";
import { setThought } from "./ai/decision";
import { chargeRent, settleArrears } from "./economy/housing";
import { corpDaily, registerJobActions } from "./economy/jobs";
import { netWorth } from "./economy/valuation";
import { homeOrShelter, payWelfare, registerLivingActions } from "./economy/living";
import { registerResearchActions } from "./economy/research";
import { servicesHourly } from "./economy/services";
import { decayMemories } from "./memory/memory";
import { conversationsTick, registerConversationActions, startOpportunisticConversations } from "./social/conversation";
import { encountersHourly } from "./social/encounters";
import "./ai/socialActivities";
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
  registerBankActions();
  registerTradingActions();
  registerResellerActions();
  registerOperationsActions();
  registerShoppingActions();
  registerConversationActions();
}

/** Advance the world by one game minute. */
export function step(world: WorldState): void {
  initEngine();
  world.time += 1;
  const t = world.time;
  conversationsTick(world);

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
      // Finishing can pull them into something new (e.g. a conversation).
      if (c.activity.kind === "idle") think(world, c);
    }
  }
  if (t % 10 === 0) startOpportunisticConversations(world);

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
    setThought(world, c, `I wanted to ${action.label.toLowerCase()}, but: ${err.toLowerCase()}.`, 2);
    // The engine refused the plan (e.g. can't afford it): fall back to resting.
    const fallback = makeAction("REST", c.insideId ?? homeOrShelter(world, c), 30, "Taking a breather");
    if (beginAction(world, c, fallback)) {
      c.activity = { kind: "idle", label: "Thinking", buildingId: c.insideId, startedAt: world.time, endsAt: world.time + 15, action: null };
    }
  }
}

function hourly(world: WorldState): void {
  marketHourly(world);
  salesHourly(world);
  const svc = servicesHourly(world);
  agencyHourly(world);
  encountersHourly(world);
  world.economy.servicePool = round2(svc.pool);
  world.economy.serviceSupplied = round2(svc.supplied);
  for (const id of world.citizenOrder) updateMood(world, world.citizens[id]);
  statsHourly(world);
}

function daily(world: WorldState): void {
  const day = dayOf(world.time - 1);
  payWelfare(world);
  corpDaily(world);
  businessDaily(world);
  loansDaily(world);
  interestDaily(world);
  if (day % 7 === 0) chargeRent(world);
  else settleArrears(world);
  marketDaily(world);
  updateWants(world);

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
  updateBeliefsDaily(world);
  world.ai.callsToday = 0;
  statsDaily(world);
}
