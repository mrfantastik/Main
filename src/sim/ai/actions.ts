import { getBuildingIndexed } from "../city/lookup";
import { startTravel, travelMinutes } from "../systems/movement";
import type { ActionType, ActivityKind, Citizen, PlannedAction, WorldState } from "../types";

// The action vocabulary. Decisions (from the utility AI or from Claude) are
// expressed as PlannedActions. The engine then:
//   1. validates them (an AI can't spend money it doesn't have),
//   2. walks the citizen to the action's building,
//   3. runs the activity for its duration,
//   4. applies the effects (money, goods, skills, memories...).
// Domain modules register handlers for the action types they own.

export interface ActionDef {
  /** What the citizen looks like they're doing while performing it. */
  kind: ActivityKind;
  /** Return an error string if the action can't be done right now. */
  validate?(world: WorldState, c: Citizen, a: PlannedAction): string | null;
  /** Called on arrival when the activity begins. */
  start?(world: WorldState, c: Citizen, a: PlannedAction): void;
  /** Called every game minute while performing. */
  tick?(world: WorldState, c: Citizen, a: PlannedAction): void;
  /** Apply effects. `minutes` = how long they actually did it. */
  complete?(world: WorldState, c: Citizen, a: PlannedAction, minutes: number): void;
}

const registry = new Map<ActionType, ActionDef>();

export function registerAction(type: ActionType, def: ActionDef): void {
  registry.set(type, def);
}

export function actionDef(type: ActionType): ActionDef | undefined {
  return registry.get(type);
}

export function makeAction(
  type: ActionType,
  buildingId: string | null,
  minutes: number,
  label: string,
  params: PlannedAction["params"] = {},
): PlannedAction {
  return { type, buildingId, minutes: Math.max(1, Math.round(minutes)), label, params };
}

export function validateAction(world: WorldState, c: Citizen, a: PlannedAction): string | null {
  const def = registry.get(a.type);
  if (!def) return `Unknown action ${a.type}`;
  if (a.buildingId && !getBuildingIndexed(world.map, a.buildingId)) return `No such place ${a.buildingId}`;
  return def.validate ? def.validate(world, c, a) : null;
}

/**
 * Start carrying out an action: walk there first if needed.
 * Returns an error string if the action was rejected.
 */
export function beginAction(world: WorldState, c: Citizen, a: PlannedAction): string | null {
  const err = validateAction(world, c, a);
  if (err) return err;
  const dest = a.buildingId ? getBuildingIndexed(world.map, a.buildingId) : undefined;
  if (dest && c.insideId !== dest.id) {
    c.pending = a;
    startTravel(world, c, dest);
    c.activity = {
      kind: "travel",
      label: `Walking to ${dest.name}`,
      buildingId: dest.id,
      startedAt: world.time,
      endsAt: world.time + travelMinutes(c, dest),
      action: null,
    };
    return null;
  }
  startActivity(world, c, a);
  return null;
}

/** Begin performing the action at the current location. */
export function startActivity(world: WorldState, c: Citizen, a: PlannedAction): void {
  const def = registry.get(a.type)!;
  c.pending = null;
  // Actions can carry a fixed end time ("work until 17:00"), so walking there
  // doesn't make the shift run late.
  const until = typeof a.params.untilT === "number" ? a.params.untilT : null;
  const endsAt = until !== null ? Math.max(world.time + 10, until) : world.time + a.minutes;
  c.activity = {
    kind: def.kind,
    label: a.label,
    buildingId: c.insideId,
    startedAt: world.time,
    endsAt,
    action: a,
  };
  def.start?.(world, c, a);
}

/** Apply the effects of the current activity and leave the citizen idle. */
export function finishActivity(world: WorldState, c: Citizen): void {
  const act = c.activity;
  const a = act.action;
  c.activity = { kind: "idle", label: "Thinking", buildingId: c.insideId, startedAt: world.time, endsAt: world.time, action: null };
  if (!a) return;
  const def = registry.get(a.type);
  def?.complete?.(world, c, a, Math.max(0, world.time - act.startedAt));
}

/** Stop whatever the citizen is doing (partial effects apply), e.g. to talk. */
export function interruptActivity(world: WorldState, c: Citizen): void {
  if (c.activity.kind === "travel" || c.path.length > 0) {
    // Mid-walk: just drop the plan, stay where they are.
    c.pending = null;
    c.path = [];
    c.activity = { kind: "idle", label: "Thinking", buildingId: null, startedAt: world.time, endsAt: world.time, action: null };
    return;
  }
  finishActivity(world, c);
}

export function tickActivity(world: WorldState, c: Citizen): void {
  const a = c.activity.action;
  if (!a) return;
  registry.get(a.type)?.tick?.(world, c, a);
}
