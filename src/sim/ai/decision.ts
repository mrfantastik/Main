import { rand } from "../rng";
import type { Citizen, DecisionOption, DecisionRecord, WorldState } from "../types";
import { pushRing, round2 } from "../util";

// Utility-based decision making.
//
// Every decision is a list of options. Each option's score is the sum of
// named factors (hunger, money pressure, ambition, rival's success...). The
// factors are kept so the UI can show *why* an agent chose what it did.
// Selection is a softmax over scores using the world's seeded RNG: agents
// usually pick the best option, but not always — like people.

export interface Option<P = unknown> {
  id: string;
  label: string;
  factors: Record<string, number>;
  payload: P;
  /** What the citizen thinks if they choose this. */
  thought: string;
  /** Thought priority (see setThought). */
  priority?: number;
}

export function scoreOf(o: Option): number {
  let s = 0;
  for (const v of Object.values(o.factors)) s += v;
  return s;
}

export function choose<P>(world: WorldState, options: Option<P>[], temperature: number): Option<P> {
  if (options.length === 1) return options[0];
  const scores = options.map(scoreOf);
  const max = Math.max(...scores);
  if (temperature <= 0) return options[scores.indexOf(max)];
  const weights = scores.map((s) => Math.exp((s - max) / temperature));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand(world) * total;
  for (let i = 0; i < options.length; i++) {
    if (r < weights[i]) return options[i];
    r -= weights[i];
  }
  return options[options.length - 1];
}

export function bestOf<P>(options: Option<P>[]): Option<P> {
  let best = options[0];
  for (const o of options) if (scoreOf(o) > scoreOf(best)) best = o;
  return best;
}

export const DECISION_LOG_LIMIT = 25;

export function recordDecision(
  world: WorldState,
  c: Citizen,
  kind: DecisionRecord["kind"],
  options: Option[],
  chosen: Option,
  source: DecisionRecord["source"],
  thought: string,
): void {
  const sorted = [...options].sort((a, b) => scoreOf(b) - scoreOf(a));
  const top = sorted.slice(0, 6);
  if (!top.includes(chosen)) top.push(chosen);
  const opts: DecisionOption[] = top.map((o) => ({
    id: o.id,
    label: o.label,
    score: round2(scoreOf(o)),
    factors: Object.fromEntries(Object.entries(o.factors).map(([k, v]) => [k, round2(v)])),
  }));
  const rec = { t: world.time, kind, options: opts, chosen: chosen.id, source, thought };
  if (kind === "activity") pushRing(c.decisions, rec, DECISION_LOG_LIMIT);
  else pushRing(c.strategyLog, rec, 15);
}

/**
 * Update what the citizen is "thinking". Important thoughts (strategy,
 * conversations, life events) aren't immediately overwritten by mundane ones.
 */
export function setThought(world: WorldState, c: Citizen, text: string, priority: number, source: "utility" | "llm" = "utility"): void {
  const age = world.time - c.thoughtT;
  const holdFor = c.thoughtPriority >= 3 ? 150 : 45;
  if (priority >= c.thoughtPriority || age > holdFor) {
    c.thought = text;
    c.thoughtPriority = priority;
    c.thoughtT = world.time;
    c.thoughtSource = source;
  }
}
