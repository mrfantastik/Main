import { CONFIG } from "./config";
import { generateCity } from "./city/map";
import { ARCHETYPES, BASE_TRAITS, CITIZEN_COLORS, FIRST_NAMES, SURNAMES } from "./data/people";
import { STARTING_PRODUCTS, INVENTIONS } from "./data/products";
import { neutralEmotions } from "./mind/emotions";
import { neutralPersonality } from "./mind/personality";
import { rand, randInt, randRange, shuffle, type RngHolder } from "./rng";
import { adjustRel, addRole } from "./social/relationships";
import type {
  Building,
  Citizen,
  Goal,
  Occupation,
  Product,
  ProductMarket,
  Skills,
  Traits,
  WorldState,
} from "./types";
import { clamp } from "./util";

export const WORLD_VERSION = 1;
export const START_TIME = 6 * 60; // Day 1, 06:00

/** Occupations handed out at the start. They change freely afterwards. */
const STARTING_OCCUPATIONS: Occupation[] = [
  "entrepreneur", "entrepreneur",
  "shopkeeper", "shopkeeper",
  "trader", "trader",
  "researcher", "researcher",
  "reseller", "reseller", "reseller",
  "freelancer", "freelancer", "freelancer",
  "employee", "employee", "employee", "employee",
  "unemployed", "unemployed",
];

/** How naturally a personality fits an occupation (used for starting jobs). */
export function occupationFit(t: Traits, occ: Occupation): number {
  switch (occ) {
    case "entrepreneur":
      return t.entrepreneurship * 2 + t.ambition + t.risk * 0.5;
    case "shopkeeper":
      return t.sociability + t.diligence + t.entrepreneurship * 0.6;
    case "trader":
      return t.risk * 1.5 + t.greed + t.competitiveness * 0.5;
    case "researcher":
      return t.diligence + (1 - t.greed) * 0.5 + t.ambition * 0.5;
    case "reseller":
      return t.greed + t.competitiveness + t.risk * 0.5;
    case "freelancer":
      return (1 - t.sociability) * 0.5 + t.risk * 0.3 + t.diligence * 0.5 + 0.3;
    case "employee":
      return 1 - t.risk + t.diligence * 0.5;
    case "unemployed":
      return 1 - t.diligence + (1 - t.ambition) * 0.5;
  }
}

const SKILL_BOOST: Record<Occupation, Partial<Skills>> = {
  employee: { management: 10, tech: 15 },
  freelancer: { tech: 32 },
  shopkeeper: { sales: 30, management: 12 },
  reseller: { sales: 22, trading: 15 },
  trader: { trading: 35 },
  entrepreneur: { management: 25, sales: 15 },
  researcher: { research: 40, tech: 15 },
  unemployed: {},
};

function makeTraits(rng: RngHolder, primary: string, secondary: string): Traits {
  const t: Traits = { ...BASE_TRAITS };
  const keys = Object.keys(t) as (keyof Traits)[];
  for (const k of keys) {
    const p = ARCHETYPES[primary][k];
    const s = ARCHETYPES[secondary][k];
    let v = t[k];
    if (p !== undefined) v = v * 0.25 + p * 0.75;
    if (s !== undefined) v = v * 0.6 + s * 0.4;
    v += (rand(rng) - 0.5) * 0.2;
    t[k] = clamp(v, 0.03, 0.97);
  }
  return t;
}

function initialGoal(occ: Occupation, t: number): Goal {
  switch (occ) {
    case "unemployed":
      return { kind: "find_job", label: "Find a job", target: null, since: t };
    case "entrepreneur":
      return { kind: "grow_business", label: "Build a successful business", target: null, since: t };
    case "shopkeeper":
      return { kind: "grow_business", label: "Make the shop profitable", target: null, since: t };
    case "researcher":
      return { kind: "make_breakthrough", label: "Make a research breakthrough", target: null, since: t };
    case "trader":
    case "reseller":
      return { kind: "get_rich", label: "Turn £100 into £500", target: 500, since: t };
    default:
      return { kind: "build_savings", label: "Build up some savings", target: 300, since: t };
  }
}

/** Rough "common knowledge" about what each occupation earns per day. */
export const PUBLIC_INCOME: Record<Occupation, number> = {
  unemployed: 8,
  employee: 42,
  freelancer: 36,
  shopkeeper: 45,
  reseller: 34,
  trader: 38,
  entrepreneur: 50,
  researcher: 32,
};

function makeCitizen(world: WorldState, i: number, name: string, surname: string, occ: Occupation, traits: Traits, archetypes: string[]): Citizen {
  const rng = world;
  const skills: Skills = {
    sales: randInt(rng, 8, 35),
    tech: randInt(rng, 8, 35),
    trading: randInt(rng, 8, 35),
    research: randInt(rng, 8, 30),
    management: randInt(rng, 8, 35),
  };
  for (const [k, v] of Object.entries(SKILL_BOOST[occ])) skills[k as keyof Skills] = Math.min(95, skills[k as keyof Skills] + (v ?? 0));
  const age = randInt(rng, 20, 62);
  const t = world.time;

  const occupationIncome: Citizen["beliefs"]["occupationIncome"] = {};
  for (const [o, v] of Object.entries(PUBLIC_INCOME)) {
    occupationIncome[o as Occupation] = { value: Math.round(v * randRange(rng, 0.75, 1.25)), conf: 0.25, t, source: "word on the street" };
  }

  return {
    id: `c${i + 1}`,
    name,
    surname,
    age,
    color: CITIZEN_COLORS[i % CITIZEN_COLORS.length],
    archetypes,
    traits,
    skills,
    occupation: occ,
    occupationSince: t,
    employerId: null,
    wage: 0,
    money: CONFIG.startingMoney,
    savings: 0,
    creditScore: 50,
    inventory: {},
    homeId: null,
    rentArrears: 0,
    homeless: false,
    pos: { x: 0, y: 0 },
    path: [],
    speed: CONFIG.walkSpeed * (1.12 - age / 250),
    insideId: null,
    spot: null,
    needs: { energy: randRange(rng, 55, 80), hunger: randRange(rng, 45, 70), social: randRange(rng, 40, 80), fun: randRange(rng, 40, 80) },
    // The real personality is filled in by setup once families are known.
    personality: neutralPersonality(),
    emotions: neutralEmotions(),
    reflections: [],
    lastReflectionDay: 0,
    wants: {},
    mood: 60,
    activity: { kind: "idle", label: "Idle", buildingId: null, startedAt: t, endsAt: t, action: null },
    pending: null,
    goal: initialGoal(occ, t),
    thought: "A new day in Hustle City.",
    thoughtSource: "utility",
    thoughtT: 0,
    thoughtPriority: 0,
    memories: { short: [], long: [] },
    relationships: {},
    family: [],
    businessIds: [],
    beliefs: { occupationIncome, products: {}, stories: [], insights: [] },
    finance: {
      incomeToday: 0,
      expensesToday: 0,
      sourcesToday: {},
      occToday: 0,
      history: [],
      lifetimeIncome: 0,
      lifetimeExpenses: 0,
      peakNetWorth: CONFIG.startingMoney,
      bankruptcies: 0,
      occupationEarnings: [],
    },
    txIds: [],
    decisions: [],
    strategyLog: [],
    research: { points: 0, breakthroughs: 0, patents: [] },
    lastReviewT: -99999,
    lastCareerChangeT: -99999,
    reviewRequested: null,
    awaitingAI: false,
    cooldowns: {},
    daysUnemployed: 0,
    unpaidWages: 0,
    workedToday: 0,
    workLog: [],
  };
}

export function initProductMarket(p: Product, trend = 1): ProductMarket {
  return {
    wholesale: p.baseCost,
    retail: p.baseRetail,
    trend,
    supply: 1,
    depotStock: Math.round(p.externalDemand * 3 + 20),
    soldToday: 0,
    revenueToday: 0,
    soldTotal: 0,
    unmetToday: 0,
    unmetYesterday: 0,
    history: [],
    tape: [p.baseCost],
    traderPressure: 0,
  };
}

export function createWorld(seed: number, name = "Hustle City"): WorldState {
  const world: WorldState = {
    version: WORLD_VERSION,
    id: `w${seed.toString(36)}-${Math.floor(rand({ rng: seed ^ 0x5bd1e995 }) * 1e9).toString(36)}`,
    seed,
    rng: seed >>> 0,
    time: START_TIME,
    nextId: 1,
    name,
    map: { width: 0, height: 0, tiles: [], buildings: [] },
    citizens: {},
    citizenOrder: [],
    businesses: {},
    businessOrder: [],
    products: {},
    productOrder: [],
    market: {},
    listings: [],
    loans: [],
    corpEmployees: [],
    economy: {
      multiplier: 1,
      mode: "normal",
      modeUntil: 0,
      corpOpenings: CONFIG.corpOpenings,
      corpWage: CONFIG.corpBaseWage,
      grant: CONFIG.grant,
      labPlaces: CONFIG.labPlaces,
      serviceDemand: CONFIG.serviceDemand,
      welfare: CONFIG.welfare,
      bankRate: CONFIG.bankLoanRate,
      depositRate: CONFIG.depositRatePerDay,
      servicePool: 0,
      serviceSupplied: 0,
      streetIncome: { ...PUBLIC_INCOME },
      rentIndex: 1,
    },
    shocks: [],
    conversations: [],
    conversationLog: [],
    events: [],
    transactions: [],
    txCount: 0,
    stats: { hourly: [], daily: [], hourRevenue: 0, dayRevenue: 0, hourInflow: 0, hourOutflow: 0, dayInflow: 0, dayOutflow: 0, dayTx: 0 },
    ai: { mode: "off", model: "claude-opus-5-5", budgetUsd: 2, spentUsd: 0, calls: 0, callsToday: 0, maxCallsPerDay: 12, log: [] },
    inventionPool: INVENTIONS.map((p) => p.id),
  };
  // Warm up the generator so nearby seeds diverge quickly.
  for (let i = 0; i < 10; i++) rand(world);

  world.map = generateCity(world);

  for (const seedP of STARTING_PRODUCTS) {
    const p: Product = { ...seedP, inventorId: null, royalty: 0, inventedT: null };
    world.products[p.id] = p;
    world.productOrder.push(p.id);
    world.market[p.id] = initProductMarket(p);
  }

  createCitizens(world);
  return world;
}

function createCitizens(world: WorldState): void {
  const rng = world;
  const n = CONFIG.citizenCount;
  const names = FIRST_NAMES.slice(0, n);
  const surnames = shuffle(rng, [...SURNAMES]);

  // Personalities: cycle primary archetypes so every type is represented.
  const core = shuffle(rng, ["Ambitious", "Risk-taking", "Conservative", "Lazy", "Friendly", "Competitive", "Entrepreneurial", "Greedy", "Generous", "Frugal", "Curious"]);
  const all = Object.keys(ARCHETYPES);
  const people = names.map((name, i) => {
    const primary = core[i % core.length];
    let secondary = all[randInt(rng, 0, all.length - 1)];
    while (secondary === primary) secondary = all[randInt(rng, 0, all.length - 1)];
    return { name, primary, secondary, traits: makeTraits(rng, primary, secondary) };
  });

  // Hand out starting occupations to whoever fits them best (plus luck).
  const assigned = new Map<number, Occupation>();
  for (const occ of STARTING_OCCUPATIONS) {
    let best = -1;
    let bestScore = -Infinity;
    people.forEach((p, idx) => {
      if (assigned.has(idx)) return;
      const s = occupationFit(p.traits, occ) + rand(rng) * 0.6;
      if (s > bestScore) {
        bestScore = s;
        best = idx;
      }
    });
    assigned.set(best, occ);
  }

  // Three family pairs share a surname.
  const familyPairs: [number, number][] = [];
  const pool = shuffle(rng, people.map((_, i) => i));
  for (let k = 0; k < 3; k++) familyPairs.push([pool[k * 2], pool[k * 2 + 1]]);
  const surnameOf: string[] = people.map((_, i) => surnames[i % surnames.length]);
  for (const [a, b] of familyPairs) surnameOf[b] = surnameOf[a];

  people.forEach((p, i) => {
    const c = makeCitizen(world, i, p.name, surnameOf[i], assigned.get(i)!, p.traits, [p.primary, p.secondary]);
    world.citizens[c.id] = c;
    world.citizenOrder.push(c.id);
  });
  const cs = world.citizenOrder.map((id) => world.citizens[id]);

  // Family ties.
  for (const [a, b] of familyPairs) {
    const A = cs[a];
    const B = cs[b];
    A.family.push(B.id);
    B.family.push(A.id);
    for (const [x, y] of [[A, B], [B, A]] as const) {
      addRole(x, y.id, "family");
      adjustRel(world, x, y.id, { affinity: randInt(rng, 45, 80), trust: randInt(rng, 50, 85), familiarity: 90 });
    }
  }

  // Homes: family pairs share a 2-person house where possible.
  const houses = world.map.buildings.filter((b) => b.type === "house");
  const apts = world.map.buildings.find((b) => b.type === "apartments");
  const residents = new Map<string, number>();
  const moveIn = (c: Citizen, h: Building) => {
    c.homeId = h.id;
    residents.set(h.id, (residents.get(h.id) ?? 0) + 1);
  };
  const free = (h: Building) => h.capacity - (residents.get(h.id) ?? 0);
  for (const [a, b] of familyPairs) {
    const h = houses.find((x) => x.capacity >= 2 && free(x) >= 2);
    if (h) {
      moveIn(cs[a], h);
      moveIn(cs[b], h);
    }
  }
  // The frugal/unemployed rent cheap apartments; everyone else a house.
  const order = shuffle(rng, cs.filter((c) => !c.homeId));
  for (const c of order) {
    const wantsApt = c.occupation === "unemployed" || c.traits.frugality > 0.75;
    if (wantsApt && apts && free(apts) > 0) {
      moveIn(c, apts);
      continue;
    }
    const h = shuffle(rng, houses.filter((x) => free(x) > 0 && (residents.get(x.id) ?? 0) === 0))[0] ?? houses.find((x) => free(x) > 0);
    if (h) moveIn(c, h);
    else if (apts) moveIn(c, apts);
  }

  // Everyone starts at home, asleep.
  for (const c of cs) {
    const home = world.map.buildings.find((b) => b.id === c.homeId)!;
    c.insideId = home.id;
    c.spot = { x: home.x + 0.6 + rand(rng) * (home.w - 1.2), y: home.y + 0.6 + rand(rng) * (home.h - 1.2) };
    c.pos = { ...c.spot };
    const wake = START_TIME + Math.round((1 - c.traits.diligence) * 100 + rand(rng) * 40);
    c.activity = { kind: "sleep", label: "Sleeping", buildingId: home.id, startedAt: world.time, endsAt: wake, action: null };
    c.needs.energy = 85;
  }

  // A few acquaintances each: neighbours, old classmates, regulars at the pub.
  for (const c of cs) {
    const k = randInt(rng, 2, 4);
    for (let j = 0; j < k; j++) {
      const o = cs[randInt(rng, 0, cs.length - 1)];
      if (o.id === c.id || c.relationships[o.id]) continue;
      const aff = randInt(rng, -5, 25);
      adjustRel(world, c, o.id, { affinity: aff, trust: randInt(rng, 0, 20), familiarity: randInt(rng, 10, 30) });
      adjustRel(world, o, c.id, { affinity: aff + randInt(rng, -5, 5), trust: randInt(rng, 0, 20), familiarity: randInt(rng, 10, 30) });
    }
  }
}

export function citizensList(world: WorldState): Citizen[] {
  return world.citizenOrder.map((id) => world.citizens[id]).filter(Boolean);
}
