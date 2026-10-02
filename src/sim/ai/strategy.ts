import { CONFIG } from "../config";
import { logEvent } from "../events";
import { tryRehouse } from "../economy/housing";
import { netWorth } from "../economy/valuation";
import type { Citizen, Goal, WorldState } from "../types";
import { money } from "../util";
import { inspiringStory } from "./beliefs";
import { careerTargets, careerThought, currentExpected, fitScore, OCC_NOUN } from "./careers";
import { choose, recordDecision, setThought, type Option } from "./decision";
import { situation, type Situation } from "./situation";

// Strategic decisions: the big, slow choices (career, business, money).
// Reviewed every morning and whenever something important happens.
// Domain modules contribute options through providers.

export interface StrategyPayload {
  /** Carry out the decision. */
  execute?: (world: WorldState, c: Citizen) => void;
  /** Rough £ at stake — used to decide whether to ask Claude. */
  stakes: number;
}
export type StrategyOption = Option<StrategyPayload>;
export type StrategyProvider = (world: WorldState, c: Citizen, s: Situation) => StrategyOption[];

const providers: StrategyProvider[] = [];

export function registerStrategyProvider(p: StrategyProvider): void {
  providers.push(p);
}

/**
 * Optional hook used by the AI director to route important decisions to an
 * LLM. Returns true if it took over (the decision will complete later).
 */
export type StrategyHook = (world: WorldState, c: Citizen, options: StrategyOption[], fallback: StrategyOption) => boolean;
let strategyHook: StrategyHook | null = null;
export function setStrategyHook(h: StrategyHook | null): void {
  strategyHook = h;
}

export function needsReview(world: WorldState, c: Citizen): boolean {
  if (c.awaitingAI) return false;
  const since = world.time - c.lastReviewT;
  if (c.reviewRequested && since > 90) return true;
  const h = (world.time % 1440) / 60;
  return since > 18 * 60 && h >= 6 && h < 12;
}

// ------------------------------------------------------------- goals

export function pickGoal(world: WorldState, c: Citizen, s: Situation): Goal {
  const t = world.time;
  const g = (kind: Goal["kind"], label: string, target: number | null = null): Goal => ({
    kind,
    label,
    target,
    since: c.goal.kind === kind ? c.goal.since : t,
  });
  if (c.homeless) return g("survive", "Get off the streets: save for a deposit", s.rent || 40);
  if (c.rentArrears > 0 || (s.rentDueIn <= 2 && s.liquid < s.rent)) return g("pay_rent", `Find ${money(Math.max(s.rent, c.rentArrears) - s.liquid)} for rent`, s.rent);
  const debt = world.loans.filter((l) => l.borrower === c.id && l.status === "active").reduce((a, l) => a + l.totalDue - l.paid, 0);
  if (debt > s.liquid * 0.8 && debt > 30) return g("repay_debt", `Pay back ${money(debt)} of debt`, debt);
  if (c.occupation === "unemployed") return g("find_job", "Find a job or a way to earn", null);
  const biz = c.businessIds.map((id) => world.businesses[id]).filter((b) => b && b.open);
  if (biz.length) {
    const losing = biz.find((b) => b.avgProfit < 0 && b.history.length >= 2);
    if (losing) return g("save_business", `Turn ${losing.name} around`, null);
    return g("grow_business", `Grow ${biz[0].name}`, null);
  }
  if (c.traits.entrepreneurship > 0.6 && c.traits.ambition > 0.5) {
    const target = CONFIG.startupCost.shop + 60;
    return g("save_for_business", `Save ${money(target)} to start a business`, target);
  }
  if (c.traits.competitiveness > 0.65) {
    const rivals = Object.entries(c.relationships).filter(([, r]) => r.roles.includes("rival"));
    if (rivals.length) return g("beat_rival", `Beat ${world.citizens[rivals[0][0]]?.name ?? "my rival"}`, null);
  }
  const nw = netWorth(world, c);
  if (c.traits.ambition > 0.6 || nw > 400) return g("get_rich", `Grow my net worth to ${money(Math.ceil((nw * 2) / 100) * 100)}`, Math.ceil((nw * 2) / 100) * 100);
  if (c.occupation === "researcher") return g("make_breakthrough", "Make a research breakthrough", null);
  return g("build_savings", "Build up £300 of savings", 300);
}

// --------------------------------------------------- built-in options

function stayOption(world: WorldState, c: Citizen, s: Situation): StrategyOption {
  const cur = currentExpected(world, c);
  const comfortable = cur >= s.dailyCost * 1.4;
  const thought =
    c.occupation === "unemployed"
      ? s.worry ?? "Nothing better out there right now. I'll keep looking."
      : comfortable
        ? `Being ${OCC_NOUN[c.occupation]} brings in about ${money(cur)} a day. No reason to change.`
        : s.worry ?? `Money's tight as ${OCC_NOUN[c.occupation]} (${money(cur)}/day), but I'll stick with it for now.`;
  return {
    id: "stay",
    label: `Carry on as ${OCC_NOUN[c.occupation]}`,
    factors: {
      inertia: 0.35 + c.traits.frugality * 0.1 + (1 - c.traits.risk) * 0.15,
      satisfaction: Math.min(0.6, (cur - s.dailyCost) / 60),
      fit: fitScore(c, c.occupation),
    },
    payload: { stakes: 0 },
    thought,
  };
}

function careerOptions(world: WorldState, c: Citizen, s: Situation): StrategyOption[] {
  const t = world.time;
  if (t - c.lastCareerChangeT < CONFIG.careerChangeCooldownDays * 1440) return [];
  if (c.occupation !== "unemployed" && t - c.occupationSince < 2 * 1440) return [];
  // Business owners decide about their businesses elsewhere.
  if (c.businessIds.some((id) => world.businesses[id]?.open)) return [];
  const cur = currentExpected(world, c);
  const out: StrategyOption[] = [];
  for (const target of careerTargets()) {
    if (target.occupation === c.occupation) continue;
    const why = target.feasible(world, c, s);
    if (why) continue;
    const expected = target.expected(world, c);
    const cost = target.startCost(world, c);
    const gain = (expected - cur) / Math.max(25, cur);
    const story = inspiringStory(c, target.occupation, cur);
    const factors: Record<string, number> = {
      gain: gain * (0.5 + c.traits.ambition * 0.8 + s.pressure * 0.4),
      fit: fitScore(c, target.occupation),
      risk: -target.risk * (1 - c.traits.risk) * 0.7,
      switching: -(0.3 + c.traits.frugality * 0.1),
      cost: -cost / (s.liquid + 60),
    };
    if (story) factors.inspired = 0.15 + c.traits.competitiveness * 0.25;
    if (c.occupation === "unemployed") factors.desperate = 0.25 + s.pressure * 0.3;
    out.push({
      id: `career:${target.occupation}`,
      label: `${target.label(world, c)} (expect ~${money(expected)}/day)`,
      factors,
      payload: { stakes: Math.max(cost, expected * 7), execute: (w, cc) => target.execute(w, cc) },
      thought: careerThought(world, c, target.occupation, expected, cur),
    });
  }
  return out;
}

function housingOptions(world: WorldState, c: Citizen): StrategyOption[] {
  if (!c.homeless) return [];
  return [
    {
      id: "rehouse",
      label: "Rent a place again",
      factors: { shelter: 1.2 },
      payload: {
        stakes: 60,
        execute: (w, cc) => {
          tryRehouse(w, cc);
        },
      },
      thought: "I've scraped together enough for a deposit. Time to get a roof over my head.",
    },
  ];
}

registerStrategyProvider(careerOptions);
registerStrategyProvider(housingOptions);

// ------------------------------------------------------------- review

/** Build all strategic options for a citizen right now (also used to re-validate AI picks). */
export function strategyOptions(world: WorldState, c: Citizen): StrategyOption[] {
  const s = situation(world, c);
  const options: StrategyOption[] = [stayOption(world, c, s)];
  for (const p of providers) options.push(...p(world, c, s));
  return options;
}

export function applyStrategy(world: WorldState, c: Citizen, options: StrategyOption[], chosen: StrategyOption, source: "utility" | "llm" | "llm-rejected", thought: string): void {
  recordDecision(world, c, "strategy", options, chosen, source, thought);
  setThought(world, c, thought, chosen.id === "stay" ? 2 : 3, source === "llm" ? "llm" : "utility");
  chosen.payload.execute?.(world, c);
}

export function strategicReview(world: WorldState, c: Citizen): void {
  const s = situation(world, c);
  const prevGoal = c.goal.kind;
  c.goal = pickGoal(world, c, s);
  if (c.goal.kind !== prevGoal && (c.goal.kind === "pay_rent" || c.goal.kind === "survive" || c.goal.kind === "save_business")) {
    logEvent(world, "life", `${c.name}'s new goal: ${c.goal.label.toLowerCase()}.`, 2, [c.id]);
  }
  c.lastReviewT = world.time;
  c.reviewRequested = null;

  const options = strategyOptions(world, c);
  if (options.length === 1) {
    // Only "carry on" is possible: just refresh the thought.
    setThought(world, c, options[0].thought, 1);
    return;
  }
  const chosen = choose(world, options, 0.12);
  if (strategyHook && strategyHook(world, c, options, chosen)) return;
  applyStrategy(world, c, options, chosen, "utility", chosen.thought);
}
