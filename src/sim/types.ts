// Core data model for AI Hustle City.
//
// RULE: everything in WorldState is plain JSON-serialisable data (no classes,
// Maps, Sets or functions). Logic lives in the systems that operate on it.
// That makes saving/loading trivial and lets the same world run in the
// browser, on a server, or in a headless test.

export type CitizenId = string;
export type BusinessId = string;
export type BuildingId = string;
export type ProductId = string;

export interface Vec {
  x: number;
  y: number;
}

// ---------------------------------------------------------------- city map

export type BuildingType =
  | "house"
  | "apartments"
  | "shop_unit"
  | "market"
  | "office"
  | "cowork"
  | "bank"
  | "pub"
  | "diner"
  | "park"
  | "lab"
  | "depot"
  | "townhall"
  | "green";

export interface Building {
  id: BuildingId;
  type: BuildingType;
  name: string;
  /** Footprint in tiles. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Road tile directly outside the entrance. */
  door: Vec;
  /** Residents for housing, 1 business for shop units, people for venues. */
  capacity: number;
  /** Weekly rent per resident (housing) or daily rent (commercial). */
  rent: number;
  /** Business occupying this unit (shop units, market stalls are virtual). */
  businessId: BusinessId | null;
}

export const TILE_GRASS = 0;
export const TILE_ROAD = 1;
export const TILE_BUILDING = 2;

export interface CityMap {
  width: number;
  height: number;
  /** Row-major tile types (TILE_*). */
  tiles: number[];
  buildings: Building[];
}

// ----------------------------------------------------------------- people

export type Occupation =
  | "unemployed"
  | "employee"
  | "freelancer"
  | "shopkeeper"
  | "reseller"
  | "trader"
  | "entrepreneur"
  | "researcher";

export const OCCUPATIONS: Occupation[] = [
  "unemployed",
  "employee",
  "freelancer",
  "shopkeeper",
  "reseller",
  "trader",
  "entrepreneur",
  "researcher",
];

/** Personality traits, each 0..1. They weight every decision a citizen makes. */
export interface Traits {
  ambition: number;
  risk: number;
  sociability: number;
  generosity: number;
  greed: number;
  diligence: number;
  competitiveness: number;
  entrepreneurship: number;
  frugality: number;
}

/** Skills 0..100. They improve with practice. */
export interface Skills {
  sales: number;
  tech: number;
  trading: number;
  research: number;
  management: number;
}

export interface InventoryItem {
  qty: number;
  avgCost: number;
}
export type Inventory = Record<ProductId, InventoryItem>;

/** 100 = fully satisfied. */
export interface Needs {
  energy: number;
  hunger: number;
  social: number;
  fun: number;
}

export type ActivityKind =
  | "idle"
  | "travel"
  | "sleep"
  | "work"
  | "eat"
  | "shop"
  | "socialize"
  | "talk"
  | "rest"
  | "bank"
  | "browse"
  | "trade"
  | "research"
  | "restock"
  | "job_hunt"
  | "manage"
  | "meet";

/**
 * A planned action: the structured output of a decision. The engine walks the
 * citizen to `buildingId` (if any), runs it for `minutes`, then applies its
 * effects. See ai/actions.ts for the vocabulary.
 */
export interface PlannedAction {
  type: ActionType;
  buildingId: BuildingId | null;
  minutes: number;
  params: Record<string, string | number | boolean | null>;
  label: string;
}

export type ActionType =
  | "MOVE"
  | "WORK"
  | "BUY"
  | "SELL"
  | "TALK"
  | "NEGOTIATE"
  | "START_BUSINESS"
  | "APPLY_FOR_JOB"
  | "HIRE"
  | "FIRE"
  | "INVEST"
  | "REST"
  | "EAT"
  | "GO_HOME"
  | "SLEEP"
  | "SOCIALIZE"
  | "SHOP"
  | "BROWSE_MARKET"
  | "TRADE"
  | "RESEARCH"
  | "RESTOCK"
  | "MANAGE"
  | "BANK"
  | "BORROW"
  | "REPAY"
  | "SET_PRICE"
  | "CHANGE_CAREER"
  | "QUIT_JOB"
  | "CLOSE_BUSINESS"
  | "SELL_POSSESSIONS"
  | "DEPOSIT"
  | "MEET";

export interface Activity {
  kind: ActivityKind;
  label: string;
  buildingId: BuildingId | null;
  startedAt: number;
  endsAt: number;
  action: PlannedAction | null;
}

export type GoalKind =
  | "survive"
  | "pay_rent"
  | "find_job"
  | "earn_income"
  | "save_for_business"
  | "grow_business"
  | "save_business"
  | "repay_debt"
  | "build_savings"
  | "get_rich"
  | "make_breakthrough"
  | "beat_rival";

export interface Goal {
  kind: GoalKind;
  label: string;
  target: number | null;
  since: number;
}

export type MemoryKind =
  | "deal"
  | "loan"
  | "betrayal"
  | "favor"
  | "conversation"
  | "financial"
  | "job"
  | "business"
  | "social"
  | "insight"
  | "world";

export interface Memory {
  id: number;
  t: number;
  text: string;
  kind: MemoryKind;
  /** 1 (trivial) .. 10 (life-changing). */
  importance: number;
  /** -1 (very bad) .. 1 (very good). */
  valence: number;
  people: CitizenId[];
  /** Fades over time; reinforced when similar things happen again. */
  strength: number;
  /** How many times this memory has been reinforced. */
  count: number;
  /** Used to merge repeated memories ("Sarah lent me money" x3). */
  key: string;
}

export type RelRole =
  | "family"
  | "employer"
  | "employee"
  | "partner"
  | "investor"
  | "investee"
  | "creditor"
  | "debtor"
  | "rival";

export interface Relationship {
  /** -100 (hate) .. 100 (love). */
  affinity: number;
  /** -100 (would never trust) .. 100 (complete trust). */
  trust: number;
  /** 0 (strangers) .. 100 (know each other well). */
  familiarity: number;
  roles: RelRole[];
  interactions: number;
  lastT: number;
}

export interface OccupationBelief {
  /** Estimated daily income in £. */
  value: number;
  /** 0..1 how sure they are. */
  conf: number;
  t: number;
  source: string;
}

export interface ProductBelief {
  /** Estimated profit per unit sold. */
  margin: number;
  /** Perceived demand 0..2 (1 = normal). */
  demand: number;
  /** Number of competing sellers they know about. */
  sellers: number;
  t: number;
  source: string;
}

export interface SuccessStory {
  citizenId: CitizenId;
  occupation: Occupation;
  productId: ProductId | null;
  amount: number;
  t: number;
}

export interface Insight {
  productId: ProductId;
  kind: "hype" | "slump";
  startT: number;
  magnitude: number;
  source: CitizenId | "own";
}

/** What a citizen believes about the world. Imperfect, second-hand, ageing. */
export interface Beliefs {
  occupationIncome: Partial<Record<Occupation, OccupationBelief>>;
  products: Record<ProductId, ProductBelief>;
  stories: SuccessStory[];
  insights: Insight[];
}

export interface DayFinance {
  day: number;
  income: number;
  expenses: number;
  netWorth: number;
}

export interface CitizenFinance {
  incomeToday: number;
  expensesToday: number;
  /** Income by source today (wage, sales, gig, grant...). */
  sourcesToday: Record<string, number>;
  /** Economic profit from the current occupation today (wages, realised trading profit, business profit share). */
  occToday: number;
  history: DayFinance[];
  lifetimeIncome: number;
  lifetimeExpenses: number;
  peakNetWorth: number;
  bankruptcies: number;
  /** Earnings attributed to the current occupation over recent days. */
  occupationEarnings: number[];
}

export interface DecisionOption {
  id: string;
  label: string;
  score: number;
  /** Named contributions to the score — the "why". */
  factors: Record<string, number>;
}

export interface DecisionRecord {
  t: number;
  kind: "activity" | "strategy" | "reaction" | "social";
  options: DecisionOption[];
  chosen: string;
  source: "utility" | "llm" | "llm-rejected";
  thought: string;
}

export interface Citizen {
  id: CitizenId;
  name: string;
  surname: string;
  age: number;
  color: string;
  archetypes: string[];
  traits: Traits;
  skills: Skills;
  occupation: Occupation;
  occupationSince: number;
  /** "corp" for CityCorp, a BusinessId for citizen-run firms, or null. */
  employerId: string | null;
  /** Daily wage when employed. */
  wage: number;
  money: number;
  savings: number;
  creditScore: number;
  inventory: Inventory;
  homeId: BuildingId | null;
  rentArrears: number;
  homeless: boolean;

  // physical state
  pos: Vec;
  path: Vec[];
  speed: number;
  /** Building the citizen is currently inside (null while walking). */
  insideId: BuildingId | null;
  /** Where inside the building they are standing. */
  spot: Vec | null;

  needs: Needs;
  /** Daily "wants" for durable goods: 0..100. */
  wants: Record<ProductId, number>;
  mood: number;

  activity: Activity;
  /** Action that will start once the citizen arrives at its building. */
  pending: PlannedAction | null;
  goal: Goal;
  thought: string;
  thoughtSource: "utility" | "llm";
  thoughtT: number;
  /** 1 mundane, 2 urgent need, 3 strategic/social, 4 major life event. */
  thoughtPriority: number;

  memories: { short: Memory[]; long: Memory[] };
  relationships: Record<CitizenId, Relationship>;
  family: CitizenId[];
  businessIds: BusinessId[];
  beliefs: Beliefs;
  finance: CitizenFinance;
  /** Ids of recent transactions involving this citizen. */
  txIds: number[];
  /** Recent tactical decisions (what to do next). */
  decisions: DecisionRecord[];
  /** Recent strategic decisions (career, business, money) — kept longer. */
  strategyLog: DecisionRecord[];

  research: { points: number; breakthroughs: number; patents: ProductId[] };
  lastReviewT: number;
  lastCareerChangeT: number;
  /** Set by events that should trigger a strategic re-think. */
  reviewRequested: string | null;
  /** True while waiting for an LLM decision. */
  awaitingAI: boolean;
  /** Cooldowns keyed by topic -> time when allowed again. */
  cooldowns: Record<string, number>;
  daysUnemployed: number;
  unpaidWages: number;
  /** Minutes worked today, and per day for the last few days (attendance). */
  workedToday: number;
  workLog: number[];
}

// --------------------------------------------------------------- economy

export type ProductCategory = "essential" | "consumable" | "durable" | "luxury";

export interface Product {
  id: ProductId;
  name: string;
  emoji: string;
  category: ProductCategory;
  /** Typical wholesale price. */
  baseCost: number;
  /** Typical retail price. */
  baseRetail: number;
  /** Units per day bought by visitors / online buyers at normal demand. */
  externalDemand: number;
  /** Daily price volatility of the wholesale market. */
  volatility: number;
  /** For inventions: who holds the patent and the royalty rate. */
  inventorId: CitizenId | null;
  royalty: number;
  inventedT: number | null;
}

export interface PricePoint {
  t: number;
  wholesale: number;
  retail: number;
  sold: number;
}

export interface ProductMarket {
  wholesale: number;
  /** Reference retail price (smoothed from actual sales). */
  retail: number;
  /** Demand multiplier: 1 normal, >1 hot, <1 cold. */
  trend: number;
  /** Supply multiplier: <1 shortage, >1 surplus. */
  supply: number;
  /** Units the depot can still sell today. */
  depotStock: number;
  soldToday: number;
  revenueToday: number;
  soldTotal: number;
  /** Units visitors wanted but nobody in town could sell. */
  unmetToday: number;
  history: PricePoint[];
  /** Net units bought by traders recently (moves prices). */
  traderPressure: number;
}

export interface Listing {
  id: number;
  sellerId: CitizenId | "external";
  productId: ProductId;
  qty: number;
  price: number;
  listedT: number;
}

export type BusinessKind = "shop" | "stall" | "cafe" | "agency";

export interface Employee {
  citizenId: CitizenId;
  wage: number;
  since: number;
}

export interface Partner {
  citizenId: CitizenId;
  /** Fraction of profits (0..1). */
  share: number;
  invested: number;
}

export interface BusinessDay {
  day: number;
  revenue: number;
  profit: number;
  customers: number;
}

export interface BusinessToday {
  revenue: number;
  cogs: number;
  wages: number;
  rent: number;
  other: number;
  customers: number;
  units: Record<ProductId, number>;
}

export interface Business {
  id: BusinessId;
  name: string;
  kind: BusinessKind;
  ownerId: CitizenId;
  partners: Partner[];
  buildingId: BuildingId;
  products: ProductId[];
  inventory: Inventory;
  prices: Record<ProductId, number>;
  cash: number;
  employees: Employee[];
  open: boolean;
  foundedT: number;
  closedT: number | null;
  closedReason: string | null;
  reputation: number;
  today: BusinessToday;
  history: BusinessDay[];
  totalRevenue: number;
  totalProfit: number;
  /** Consecutive days the business could not pay its bills. */
  daysInRed: number;
  unpaidWages: number;
  /** Wants to hire at this wage (0 = not hiring). */
  hiringWage: number;
  lastPriceChangeT: number;
  /** Rolling profit average used for valuations and decisions. */
  avgProfit: number;
  /** Money the owner put in personally. */
  ownerInvested: number;
  /** Agency service revenue accrued this hour (booked hourly). */
  agencyEarned: number;
}

export interface Loan {
  id: number;
  lender: CitizenId | "bank";
  borrower: CitizenId;
  principal: number;
  /** Flat interest over the term (0.15 = 15%). */
  rate: number;
  totalDue: number;
  paid: number;
  startT: number;
  dueT: number;
  /** Bank loans are repaid in daily instalments. */
  installment: number;
  missed: number;
  status: "active" | "repaid" | "defaulted";
  purpose: string;
}

export type TxKind =
  | "wage"
  | "salary"
  | "sale"
  | "purchase"
  | "wholesale"
  | "rent"
  | "meal"
  | "gig"
  | "grant"
  | "welfare"
  | "loan"
  | "repayment"
  | "interest"
  | "investment"
  | "dividend"
  | "royalty"
  | "trade"
  | "gift"
  | "god"
  | "owner_draw"
  | "capital"
  | "leisure"
  | "fee"
  | "liquidation";

export interface Transaction {
  id: number;
  t: number;
  /** Account refs: "c:<id>" citizen, "b:<id>" business, "x:<name>" external. */
  from: string;
  to: string;
  amount: number;
  kind: TxKind;
  memo: string;
}

export type EventCategory =
  | "business"
  | "job"
  | "finance"
  | "social"
  | "market"
  | "god"
  | "life"
  | "ai"
  | "conversation";

export interface SimEvent {
  id: number;
  t: number;
  cat: EventCategory;
  text: string;
  /** 1..5 */
  importance: number;
  citizens: CitizenId[];
  businessId: BusinessId | null;
}

// ---------------------------------------------------------- conversations

export type ConversationTopic =
  | "chat"
  | "ask_loan"
  | "pitch_investment"
  | "ask_job"
  | "offer_job"
  | "demand_repayment"
  | "sell_stock"
  | "argue"
  | "ask_help"
  | "share_tip";

export interface ConversationLine {
  speaker: CitizenId;
  text: string;
}

export interface Conversation {
  id: number;
  a: CitizenId;
  b: CitizenId;
  topic: ConversationTopic;
  buildingId: BuildingId | null;
  startedT: number;
  /** Lines are revealed one by one for speech bubbles. */
  lines: ConversationLine[];
  revealed: number;
  status: "talking" | "awaiting_ai" | "done";
  /** Engine-computed negotiation terms and limits (validated against AI output). */
  terms: Record<string, number | string | boolean>;
  outcome: string | null;
  source: "template" | "llm";
  endT: number;
}

// --------------------------------------------------------------- world

export interface ScheduledShock {
  id: number;
  productId: ProductId;
  kind: "hype" | "slump";
  startT: number;
  magnitude: number;
  durationDays: number;
  started: boolean;
}

export interface EconomyState {
  /** Overall demand multiplier (boom > 1 > crash). */
  multiplier: number;
  mode: "normal" | "boom" | "crash";
  modeUntil: number;
  /** CityCorp (the big external employer). */
  corpOpenings: number;
  corpWage: number;
  /** Research Institute grant per day and number of lab places. */
  grant: number;
  labPlaces: number;
  /** Total value per day of freelance/agency work available. */
  serviceDemand: number;
  welfare: number;
  bankRate: number;
  depositRate: number;
  /** Last hour of the services market: work on offer vs. work delivered. */
  servicePool: number;
  serviceSupplied: number;
  /** "Word on the street": what each occupation actually earns per day lately. */
  streetIncome: Record<string, number>;
}

export interface StatPoint {
  t: number;
  totalMoney: number;
  avgWealth: number;
  medianWealth: number;
  gini: number;
  unemployment: number;
  businesses: number;
  txCount: number;
  revenue: number;
  inflow: number;
  outflow: number;
}

export interface StatsState {
  hourly: StatPoint[];
  daily: StatPoint[];
  /** Counters reset every hour/day. */
  hourRevenue: number;
  dayRevenue: number;
  /** Money entering / leaving the town economy (external accounts). */
  hourInflow: number;
  hourOutflow: number;
  dayInflow: number;
  dayOutflow: number;
  dayTx: number;
}

export interface AILogEntry {
  id: number;
  t: number;
  citizenId: CitizenId | null;
  kind: "strategy" | "conversation";
  prompt: string;
  response: string;
  costUsd: number;
  ms: number;
  status: "ok" | "rejected" | "error" | "fallback";
  note: string;
}

export interface AIState {
  /** "off" = deterministic utility AI only (reproducible). */
  mode: "off" | "llm";
  model: string;
  budgetUsd: number;
  spentUsd: number;
  calls: number;
  callsToday: number;
  maxCallsPerDay: number;
  log: AILogEntry[];
}

export interface WorldState {
  version: number;
  seed: number;
  /** PRNG state (mulberry32). */
  rng: number;
  /** Game minutes since Day 1 00:00. */
  time: number;
  nextId: number;
  name: string;
  map: CityMap;
  citizens: Record<CitizenId, Citizen>;
  citizenOrder: CitizenId[];
  businesses: Record<BusinessId, Business>;
  businessOrder: BusinessId[];
  products: Record<ProductId, Product>;
  productOrder: ProductId[];
  market: Record<ProductId, ProductMarket>;
  listings: Listing[];
  loans: Loan[];
  corpEmployees: CitizenId[];
  economy: EconomyState;
  shocks: ScheduledShock[];
  conversations: Conversation[];
  events: SimEvent[];
  transactions: Transaction[];
  txCount: number;
  stats: StatsState;
  ai: AIState;
  /** Inventions not yet discovered. */
  inventionPool: string[];
}
