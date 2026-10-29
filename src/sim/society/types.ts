import type { CitizenId, ConvValue } from "../types";

// The agent layer: what each citizen is trying to do with their life and
// with other people, what they decided and what came of it.

/** What an agent can propose to do (the world checks it and carries it out). */
export type AgentActionType =
  | "talk" // go and find someone to talk to (about something in particular)
  | "seek_work" // ask an owner for a job, or apply at CityCorp
  | "propose_deal" // ask for a loan, pitch an investment, offer a job, sell stock
  | "lend" // offer someone a loan they haven't asked for
  | "help" // give someone money
  | "spread_rumour" // tell people something about someone (true or not)
  | "compete" // undercut a rival's prices
  | "confront" // have it out with someone
  | "make_up" // try to patch things up
  | "ask_out" // romantic interest
  | "change_goal" // aim for something else
  | "start_project" // begin a plan that takes days
  | "carry_on"; // nothing new: get on with the day

export type DealKind = "loan" | "investment" | "job_offer" | "job_ask" | "sale" | "partnership";

export interface AgentAction {
  type: AgentActionType;
  /** Who it's with. */
  target?: CitizenId;
  /** Who it's about (a rumour). */
  about?: CitizenId;
  deal?: DealKind;
  amount?: number;
  /** What they'll say or claim (a rumour, what to talk about, what the row is about). */
  text?: string;
  goal?: AgentGoalKind;
  project?: ProjectKind;
  /** Why, in their own words. */
  reason: string;
}

export type AgentGoalKind =
  | "get_job"
  | "earn_more"
  | "start_business"
  | "grow_business"
  | "pay_debts"
  | "save_money"
  | "get_rich"
  | "make_friends"
  | "find_love"
  | "be_respected"
  | "beat_rival"
  | "get_even"
  | "help_family"
  | "invent";

export interface AgentGoal {
  id: number;
  kind: AgentGoalKind;
  /** In their words ("Open my own café"). */
  text: string;
  why: string;
  /** 0..1: how much it matters right now. */
  priority: number;
  since: number;
  status: "active" | "achieved" | "dropped";
  /** Who it's about, for social goals (the rival, the one they fancy). */
  who?: CitizenId;
  source: "llm" | "rules";
}

export type ProjectKind = "open_business" | "find_partner" | "raise_money" | "get_job" | "win_over" | "beat_rival" | "clear_debt";

export interface ProjectStep {
  /** What to do ("Find someone to go in with me"). */
  text: string;
  done: boolean;
}

/** A plan that takes days: an idea, people to bring in, money to find, the thing itself, and what goes wrong. */
export interface Project {
  id: number;
  kind: ProjectKind;
  title: string;
  goalId?: number;
  started: number;
  /** Give up after this (game time) if it isn't done. */
  deadline: number;
  steps: ProjectStep[];
  /** People brought in, and people who said no. */
  partners: CitizenId[];
  refused: CitizenId[];
  /** Money it needs, and money found so far. */
  need: number;
  raised: number;
  /** Who it's about (the rival, the friend to win over). */
  who?: CitizenId;
  /** Business it's for, once there is one. */
  businessId?: string;
  status: "active" | "done" | "failed" | "abandoned";
  /** What's happened (progress and setbacks), newest last. */
  log: { t: number; text: string; good: boolean }[];
  source: "llm" | "rules";
}

/** Something the agent has decided to do with someone, waiting for the chance. */
export interface Intent {
  /** The decision it came from. */
  decision: number;
  topic: string;
  target: CitizenId;
  params: Record<string, ConvValue>;
  urgency: number;
  reason: string;
  /** Forget it after this (game time). */
  until: number;
}

/** One decision: what they proposed, who proposed it (the model or the rules), whether the world allowed it, and what came of it. */
export interface AgentDecision {
  id: number;
  t: number;
  action: AgentAction;
  source: "llm" | "rules";
  /** "pending": accepted and waiting to happen (they're going to find someone); "done": it happened; "rejected": the world said no. */
  status: "pending" | "done" | "rejected" | "failed" | "expired";
  /** Why the world refused it. */
  error?: string;
  /** What happened, in plain words. */
  result?: string;
  /** What was asked (for the AI decision log). */
  why?: string;
}

/** A citizen's agent state (kept on the citizen, saved with the world). */
export interface SocietyState {
  v: 1;
  goals: AgentGoal[];
  projects: Project[];
  /** What they mean to do next, in their words. */
  intention: { text: string; t: number; source: "llm" | "rules" } | null;
  intents: Intent[];
  decisions: AgentDecision[];
  /** A few lines about each recent day, from their side (newest last). */
  days: { day: number; text: string }[];
  /** When they last stopped to think about what to do (game time). */
  lastThought: number;
  /** Romantic interest, if any (who, and how it's going). */
  crush?: { who: CitizenId; since: number; stage: "interested" | "asked" | "together" | "turned down" };
}

/** A claim going round town: who started it, about whom, and whether it's true (the world knows; the people repeating it don't). */
export interface Rumour {
  id: number;
  t: number;
  origin: CitizenId;
  about: CitizenId;
  text: string;
  /** true: it happened; false: made up; null: nobody could say (an opinion, a guess). */
  truth: boolean | null;
  /** How many people have heard it. */
  heard: number;
}

/** World-level agent state. */
export interface SocietyWorld {
  /** The citizens a language model may think and speak for (the rest use the built-in AI). */
  roster: CitizenId[];
  /** How many agents the model runs (the roster is topped up or trimmed to this). */
  size: number;
  rumours: Rumour[];
}
