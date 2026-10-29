import type { Citizen, CitizenId, WorldState } from "../types";
import { newId, pushRing } from "../util";
import { SOCIETY } from "./config";
import type { AgentAction, AgentDecision, AgentGoal, AgentGoalKind, SocietyState, SocietyWorld } from "./types";

// Each citizen's agent state (goals, projects, intentions, decisions), made
// on first use from who they already are, so old saves get it too. And the
// town's roster: which citizens a language model thinks and speaks for.

/** The world's agent state (made on first use). */
export function societyWorld(world: WorldState): SocietyWorld {
  world.society ??= { roster: [], size: SOCIETY.rosterSize, rumours: [] };
  return world.society;
}

/** A citizen's agent state (made on first use, from their personality, goal and situation). */
export function societyOf(world: WorldState, c: Citizen): SocietyState {
  if (c.society?.v === 1) return c.society;
  c.society = { v: 1, goals: [], projects: [], intention: null, intents: [], decisions: [], days: [], lastThought: -1e9 };
  for (const g of startingGoals(world, c)) c.society.goals.push(g);
  return c.society;
}

/** The citizen is one of the agents a language model runs. */
export function onRoster(world: WorldState, id: CitizenId): boolean {
  return societyWorld(world).roster.includes(id);
}

/**
 * Pick (or re-pick) the roster: as different from each other as possible
 * (personality, line of work), so the town's AI agents aren't ten of a kind.
 * Keeps whoever is on it already.
 */
export function fillRoster(world: WorldState, size = societyWorld(world).size): CitizenId[] {
  const sw = societyWorld(world);
  sw.size = Math.max(0, Math.min(world.citizenOrder.length, Math.round(size)));
  const all = world.citizenOrder.map((id) => world.citizens[id]);
  sw.roster = sw.roster.filter((id) => world.citizens[id]).slice(0, sw.size);
  const vec = (c: Citizen) => {
    const b = c.personality.big5;
    return [b.openness, b.conscientiousness, b.extraversion, b.agreeableness, b.neuroticism, c.traits.ambition, c.traits.greed, c.traits.generosity];
  };
  const dist = (x: Citizen, y: Citizen) => {
    const a = vec(x);
    const b = vec(y);
    return a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0) + (x.occupation === y.occupation ? 0 : 0.25) + (x.personality.style === y.personality.style ? 0 : 0.2);
  };
  while (sw.roster.length < sw.size) {
    const chosen = sw.roster.map((id) => world.citizens[id]);
    const rest = all.filter((c) => !sw.roster.includes(c.id));
    if (!rest.length) break;
    const next = chosen.length ? rest.sort((x, y) => Math.min(...chosen.map((c) => dist(y, c))) - Math.min(...chosen.map((c) => dist(x, c))))[0] : rest[0];
    sw.roster.push(next.id);
  }
  return sw.roster;
}

/** The player's change to the agents (how many the AI runs, or one person on or off): what happened, in words. */
export function applyAgentsCommand(world: WorldState, msg: { size?: number; id?: string; on?: boolean }): string {
  if (msg.id && typeof msg.on === "boolean") {
    const c = world.citizens[msg.id];
    if (!c) return "Nobody by that name.";
    setOnRoster(world, msg.id, msg.on);
    return msg.on ? `🧠 The AI now decides for ${c.name}.` : `⚙️ ${c.name} goes back to the built-in judgement.`;
  }
  if (typeof msg.size === "number" && Number.isFinite(msg.size)) {
    const n = fillRoster(world, msg.size).length;
    return `🧠 The AI runs ${n} of the town's people as agents${n ? "" : " (none: everyone uses the built-in judgement)"}.`;
  }
  return "Nothing changed.";
}

/** Put someone on the roster or take them off (the player's choice in the agent inspector). */
export function setOnRoster(world: WorldState, id: CitizenId, on: boolean): void {
  const sw = societyWorld(world);
  if (!world.citizens[id]) return;
  sw.roster = on ? [...new Set([...sw.roster, id])] : sw.roster.filter((x) => x !== id);
  sw.size = sw.roster.length;
}

const GOAL_TEXT: Record<AgentGoalKind, string> = {
  get_job: "Find steady work",
  earn_more: "Earn more than I do now",
  start_business: "Start a business of my own",
  grow_business: "Make my business the best in town",
  pay_debts: "Get out of debt",
  save_money: "Put some money by",
  get_rich: "Get properly rich",
  make_friends: "Have people around me I can count on",
  find_love: "Meet someone special",
  be_respected: "Be someone people look up to",
  beat_rival: "Beat my rival",
  get_even: "Get even with someone who wronged me",
  help_family: "Look after my family",
  invent: "Make a breakthrough",
};

export function goalText(kind: AgentGoalKind): string {
  return GOAL_TEXT[kind];
}

export const GOAL_KINDS = Object.keys(GOAL_TEXT) as AgentGoalKind[];

/** A new goal (at most a few active; the least important active one gives way). */
export function addGoal(world: WorldState, c: Citizen, g: Omit<AgentGoal, "id" | "since" | "status">): AgentGoal {
  const s = c.society ?? societyOf(world, c);
  const same = s.goals.find((x) => x.status === "active" && x.kind === g.kind && x.who === g.who);
  if (same) {
    same.priority = Math.max(same.priority, g.priority);
    same.why = g.why || same.why;
    return same;
  }
  const goal: AgentGoal = { ...g, id: newId(world), since: world.time, status: "active" };
  s.goals.push(goal);
  const active = s.goals.filter((x) => x.status === "active").sort((a, b) => b.priority - a.priority);
  for (const x of active.slice(4)) x.status = "dropped";
  if (s.goals.length > SOCIETY.goalsKept) s.goals.splice(0, s.goals.length - SOCIETY.goalsKept);
  return goal;
}

/** What they want out of life to begin with: from their economic goal, their values, their dream and the people around them. */
function startingGoals(world: WorldState, c: Citizen): AgentGoal[] {
  const out: AgentGoal[] = [];
  const add = (kind: AgentGoalKind, priority: number, why: string, who?: CitizenId) => out.push({ id: newId(world), kind, text: GOAL_TEXT[kind], why, priority: Math.round(priority * 100) / 100, since: world.time, status: "active", source: "rules", ...(who ? { who } : {}) });
  const g = c.goal.kind;
  const econ: Partial<Record<string, AgentGoalKind>> = { find_job: "get_job", earn_income: "earn_more", save_for_business: "start_business", grow_business: "grow_business", save_business: "grow_business", repay_debt: "pay_debts", build_savings: "save_money", get_rich: "get_rich", make_breakthrough: "invent", pay_rent: "earn_more", survive: "earn_more", beat_rival: "beat_rival" };
  const main = econ[g];
  if (main) add(main, 0.7, c.goal.label);
  const p = c.personality;
  if (p.values.includes("family") && c.family.length) add("help_family", 0.45, "Family comes first.");
  if (p.values.includes("status")) add("be_respected", 0.4, "I want people to take me seriously.");
  if (c.traits.entrepreneurship > 0.6 && !c.businessIds.length && main !== "start_business") add("start_business", 0.4 + c.traits.entrepreneurship * 0.2, `I've always wanted ${p.dream.replace(/^being /, "to be ").replace(/\btheir\b/g, "my")}.`);
  if (c.traits.sociability > 0.55 || p.big5.extraversion > 0.6) add("make_friends", 0.3, "Life's better with people around.");
  // Some are looking for someone (adults, nobody in their family counted).
  if (c.age >= 20 && c.age <= 60 && p.big5.openness + p.big5.extraversion > 1.05) add("find_love", 0.25 + p.big5.extraversion * 0.15, "It'd be nice to have someone.");
  const rival = Object.entries(c.relationships).find(([, r]) => r.roles.includes("rival"));
  if (rival && c.traits.competitiveness > 0.5) add("beat_rival", 0.35 + c.traits.competitiveness * 0.3, "They think they're better than me.", rival[0]);
  return out.slice(0, 4);
}

/** Record a decision (and keep the log to a sensible size). */
export function logDecision(world: WorldState, c: Citizen, action: AgentAction, source: "llm" | "rules", why?: string): AgentDecision {
  const s = societyOf(world, c);
  const d: AgentDecision = { id: newId(world), t: world.time, action, source, status: "pending", ...(why ? { why } : {}) };
  pushRing(s.decisions, d, SOCIETY.decisionsKept);
  return d;
}

/** Find a decision by id (it may have dropped off the log). */
export function decisionById(c: Citizen, id: number): AgentDecision | undefined {
  return c.society?.decisions.find((d) => d.id === id);
}

/** What came of a decision: the world refused it, it failed, or it happened (and how). */
export function settleDecision(c: Citizen, id: number, status: AgentDecision["status"], result: string, error?: string): void {
  const d = decisionById(c, id);
  if (!d) return;
  d.status = status;
  d.result = result;
  if (error) d.error = error;
}

/** Their active goals, most important first. */
export function activeGoals(c: Citizen): AgentGoal[] {
  return (c.society?.goals ?? []).filter((g) => g.status === "active").sort((a, b) => b.priority - a.priority);
}
