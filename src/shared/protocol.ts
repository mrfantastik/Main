// Messages between the simulation server and browser clients.
// The server is authoritative; clients render and send commands.

import type {
  ActivityKind,
  AILogEntry,
  CityMap,
  ConversationLine,
  ConversationTopic,
  DecisionRecord,
  Emotion,
  Emotions,
  Goal,
  HappeningKind,
  Memory,
  Needs,
  Occupation,
  Personality,
  Reflection,
  SimEvent,
  Skills,
  StatPoint,
  Traits,
  Transaction,
} from "../sim/types";

export const SPEEDS = [1, 5, 20, 50] as const;
/** Real milliseconds per game minute at 1x speed (1 game hour = 15 s). */
export const MS_PER_GAME_MINUTE = 250;
/** Time-skip buttons (game minutes). */
export const SKIPS = [
  { minutes: 60, label: "+1h", title: "an hour" },
  { minutes: 1440, label: "+1d", title: "a day" },
  { minutes: 7 * 1440, label: "+1w", title: "a week" },
] as const;
export const MAX_SKIP_MINUTES = 30 * 1440;
export function describeSkip(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? "a day" : minutes === 7 * 1440 ? "a week" : `${minutes / 1440} days`;
  return minutes === 60 ? "an hour" : `${Math.round(minutes / 60)} hours`;
}

export interface ProductDTO {
  id: string;
  name: string;
  emoji: string;
  category: string;
  baseCost: number;
  baseRetail: number;
  inventorId: string | null;
}

/** Sent once on connect (and after a reset). */
export interface HelloMsg {
  type: "hello";
  worldName: string;
  seed: number;
  map: CityMap;
  persistence: string;
}

/** Positions, ~10x per second. Arrays keep it small: [id, x, y, activityKind, insideId]. */
export interface FrameMsg {
  type: "frame";
  t: number;
  speed: number;
  paused: boolean;
  c: [string, number, number, ActivityKind, string | null][];
}

export interface CitizenSummary {
  id: string;
  name: string;
  color: string;
  occupation: Occupation;
  employer: string | null;
  money: number;
  netWorth: number;
  activity: string;
  activityKind: ActivityKind;
  goal: string;
  thought: string;
  thoughtSource: "utility" | "llm";
  mood: number;
  homeless: boolean;
  archetypes: string[];
  businessIds: string[];
  awaitingAI: boolean;
  /** Their standout feeling right now (null when nothing stands out). */
  emotion: { kind: Emotion; level: number; emoji: string } | null;
}

export interface BusinessSummary {
  id: string;
  name: string;
  kind: string;
  ownerId: string;
  ownerName: string;
  buildingId: string;
  products: string[];
  prices: Record<string, number>;
  stock: Record<string, number>;
  cash: number;
  open: boolean;
  employees: number;
  revenueToday: number;
  customersToday: number;
  avgProfit: number;
  lastProfit: number;
  reputation: number;
  hiringWage: number;
  foundedT: number;
  closedT: number | null;
}

export interface MarketRow {
  id: string;
  name: string;
  emoji: string;
  wholesale: number;
  retail: number;
  trend: number;
  supply: number;
  soldToday: number;
  unmetToday: number;
  sellers: number;
  listings: number;
  inventorId: string | null;
}

export interface BubbleDTO {
  id: number;
  a: string;
  b: string;
  topic: ConversationTopic;
  speaker: string;
  text: string;
  source: "template" | "llm";
}

export interface AIStatusDTO {
  mode: "off" | "llm";
  available: boolean;
  model: string;
  spentUsd: number;
  budgetUsd: number;
  calls: number;
  callsToday: number;
  maxCallsPerDay: number;
  pending: number;
  reason: string | null;
  /** Who does the AI thinking and talking (null: nobody). */
  writer: string | null;
  /** What the AI is working on right now, in words ("Deciding what Mike does next"). */
  doing?: string | null;
  /** What it has done so far (free AI): choices people acted on, conversations written, thoughts. */
  done?: { plan: number; conversation: number; thought: number };
  /** The writer is a free public AI (no budget; rate limited). */
  free?: boolean;
  /** Free AI: which services answer, and whether this page can reach the internet at all. */
  connection?: {
    connected: boolean;
    active: string | null;
    blocked: boolean;
    providers: { name: string; state: "untried" | "ok" | "busy" | "unreachable" | "error"; note: string }[];
  } | null;
  /** Free AI: the player's own endpoint, if set (no key shown). */
  endpoint?: { url: string; model?: string } | null;
  /** The town's brain: an open-source model running on the player's own computer. */
  brain?: BrainDTO | null;
}

export interface BrainDTO {
  state: "off" | "loading" | "ready" | "error";
  name: string;
  from: "page" | "huggingface" | null;
  device: "webgpu" | "wasm" | null;
  stage: "download" | "compile" | null;
  loaded: number;
  total: number;
  error: string | null;
  speed: number;
  replies: number;
}

/** A town happening, for the top bar, the map and the feed. */
export interface HappeningDTO {
  id: number;
  kind: HappeningKind;
  icon: string;
  title: string;
  text: string;
  t: number;
  until: number;
  active: boolean;
  buildingId: string | null;
  subject: string | null;
  businessId: string | null;
  source: "world" | "god" | "llm";
  /** How many residents have heard about it. */
  known: number;
}

/** A piece of news a citizen knows. */
export interface NewsDTO {
  id: number;
  icon: string;
  title: string;
  t: number;
  via: string;
  stance: number;
}

/** Overall state for UI panels, ~2x per second. */
export interface StateMsg {
  type: "state";
  t: number;
  speed: number;
  paused: boolean;
  citizens: CitizenSummary[];
  businesses: BusinessSummary[];
  market: MarketRow[];
  events: SimEvent[];
  bubbles: BubbleDTO[];
  stats: StatPoint | null;
  economy: { mode: string; multiplier: number; modeUntil: number; corpOpenings: number; corpEmployees: number };
  ai: AIStatusDTO;
  savedAt: number | null;
  txCount: number;
  /** Recently finished conversations (for expanding events in the feed). */
  conversations: ConversationDTO[];
  /** Town happenings: the ones going on now, then the latest few. */
  happenings: HappeningDTO[];
  /** Money moving around the map since the last update (floating "+£5"). */
  fx: { x: number; y: number; amount: number }[];
}

export interface RelationshipDTO {
  id: string;
  name: string;
  label: string;
  affinity: number;
  trust: number;
  familiarity: number;
  roles: string[];
}

export interface LoanDTO {
  id: number;
  lender: string;
  borrower: string;
  principal: number;
  totalDue: number;
  paid: number;
  dueT: number;
  status: string;
  purpose: string;
}

export interface ConversationDTO {
  id: number;
  t: number;
  topic: ConversationTopic;
  a: string;
  b: string;
  aName: string;
  bName: string;
  place: string;
  lines: { speaker: string; name: string; text: string }[];
  summary: string;
  source: "template" | "llm";
  topics: string[];
  /** Still being spoken (lines reveal over time). */
  live: boolean;
}

export interface CitizenDetail {
  kind: "citizen";
  id: string;
  name: string;
  surname: string;
  age: number;
  color: string;
  occupation: Occupation;
  employer: string | null;
  wage: number;
  money: number;
  savings: number;
  netWorth: number;
  debts: number;
  creditScore: number;
  incomeToday: number;
  expensesToday: number;
  avgIncome: number;
  avgExpenses: number;
  home: string | null;
  homeless: boolean;
  rentArrears: number;
  location: string;
  activity: string;
  goal: Goal;
  thought: string;
  thoughtSource: "utility" | "llm";
  archetypes: string[];
  traits: Traits;
  skills: Skills;
  needs: Needs;
  mood: number;
  inventory: { id: string; name: string; emoji: string; qty: number; avgCost: number }[];
  businesses: BusinessSummary[];
  relationships: RelationshipDTO[];
  memories: (Memory & { long: boolean })[];
  transactions: (Transaction & { fromName: string; toName: string })[];
  decisions: DecisionRecord[];
  financeHistory: { day: number; income: number; expenses: number; netWorth: number }[];
  loans: LoanDTO[];
  research: { points: number; threshold: number; breakthroughs: number; patents: string[] };
  insights: string[];
  beliefs: { occupation: string; value: number; source: string }[];
  personality: Personality & { summary: string };
  emotions: Emotions;
  emotion: CitizenSummary["emotion"];
  /** Lessons from nightly reflection, strongest first. */
  lessons: Reflection[];
  conversations: ConversationDTO[];
  /** What they've heard about (most recent first). */
  news: NewsDTO[];
}

export interface BusinessDetail {
  kind: "business";
  summary: BusinessSummary;
  employees: { id: string; name: string; wage: number; since: number }[];
  partners: { id: string; name: string; share: number; invested: number }[];
  inventory: { id: string; name: string; emoji: string; qty: number; avgCost: number; price: number }[];
  history: { day: number; revenue: number; profit: number; customers: number }[];
  totalRevenue: number;
  totalProfit: number;
  unpaidWages: number;
  daysInRed: number;
  closedReason: string | null;
  transactions: (Transaction & { fromName: string; toName: string })[];
}

export interface DetailMsg {
  type: "detail";
  detail: CitizenDetail | BusinessDetail | null;
}

export interface DashboardMsg {
  type: "dashboard";
  hourly: StatPoint[];
  daily: StatPoint[];
  richest: { id: string; name: string; netWorth: number; occupation: string }[];
  poorest: { id: string; name: string; netWorth: number; occupation: string }[];
  topBusinesses: { id: string; name: string; ownerName: string; avgProfit: number; totalProfit: number; open: boolean }[];
  priceHistory: Record<string, { t: number; wholesale: number; retail: number; sold: number }[]>;
  popular: { id: string; name: string; emoji: string; sold: number }[];
  occupations: Record<string, number>;
  recentTx: (Transaction & { fromName: string; toName: string })[];
  loans: LoanDTO[];
  service: { pool: number; supplied: number };
  aiLog: (AILogEntry & { citizenName: string })[];
  products: ProductDTO[];
  conversations: ConversationDTO[];
  /** Hourly wholesale price tape per product (last 48h). */
  tapes: Record<string, number[]>;
  /** Major economic news. */
  econEvents: SimEvent[];
  market: MarketRow[];
}

export interface ToastMsg {
  type: "toast";
  text: string;
  level: "info" | "error";
}

export type ServerMsg = HelloMsg | FrameMsg | StateMsg | DetailMsg | DashboardMsg | ToastMsg;

// ---------------------------------------------------------------- commands

export type GodCommand =
  | { cmd: "give_money"; citizenId: string; amount: number }
  | { cmd: "take_money"; citizenId: string; amount: number }
  | { cmd: "shortage"; productId: string }
  | { cmd: "surplus"; productId: string }
  | { cmd: "set_price"; productId: string; price: number }
  | { cmd: "set_job"; citizenId: string; occupation: Occupation }
  | { cmd: "spawn_business"; citizenId: string; kind: string; productId: string }
  | { cmd: "close_business"; businessId: string }
  | { cmd: "boom" }
  | { cmd: "crash" }
  | { cmd: "hype"; productId: string }
  | { cmd: "happening"; kind: HappeningKind; citizenId?: string; businessId?: string };

export type ClientMsg =
  | { type: "speed"; speed: number }
  | { type: "pause"; paused: boolean }
  | { type: "select"; kind: "citizen" | "business" | null; id: string | null }
  | { type: "dashboard"; open: boolean }
  | { type: "god"; command: GodCommand }
  | { type: "reset"; seed?: number }
  | {
      type: "ai";
      mode?: "off" | "llm";
      budgetUsd?: number;
      maxCallsPerDay?: number;
      /** Free AI: test every service now. */
      probe?: boolean;
      /** Free AI: the player's own OpenAI-style endpoint (null clears it). */
      endpoint?: { url: string; model?: string; key?: string } | null;
      /** The town's brain (a model running in the page): wake it up or switch it off. */
      brain?: "load" | "unload";
    }
  | { type: "save" }
  | { type: "skip"; minutes: number }
  /** Replace the city with a saved one (the JSON from "Download world" / "Copy save"). */
  | { type: "import"; world: unknown }
  /** Ask Claude to invent something that happens in town. */
  | { type: "invent"; idea?: string };

export type { ConversationLine };
