import { situation } from "../ai/situation";
import { feelingsToward } from "../mind/emotions";
import { profileOf } from "../dialogue/profile";
import { compatibility } from "../social/encounters";
import { hashSeed, rand, type RngHolder } from "../rng";
import type { Citizen, CitizenId, WorldState } from "../types";
import { checkAction } from "./actions";
import { nextStep } from "./projects";
import { activeGoals, societyOf } from "./state";
import type { AgentAction, ProjectKind } from "./types";

// The built-in judgement: what a person like this would do next about the
// people in their life and their ambitions. It runs every built-in agent,
// and stands in for the model when it can't answer. Everything it considers
// comes from their own situation and personality: their goals and plans,
// money worries, who they like and who they can't stand, who's struggling,
// who they fancy. Several things are weighed and one is picked (usually the
// most pressing, not always), and the world still checks it.

interface Candidate {
  action: AgentAction;
  score: number;
}

function rng(world: WorldState, c: Citizen): RngHolder {
  return { rng: hashSeed(`${world.seed}:${c.id}:${world.time}:decide`) };
}

const people = (world: WorldState, c: Citizen) => world.citizenOrder.map((id) => world.citizens[id]).filter((o) => o.id !== c.id);

function openBizOf(world: WorldState, c: Citizen) {
  return c.businessIds.map((id) => world.businesses[id]).find((b) => b && b.open && b.ownerId === c.id) ?? null;
}

function inCouple(c: Citizen): CitizenId | null {
  return Object.entries(c.relationships).find(([, r]) => r.roles.includes("couple"))?.[0] ?? null;
}

/** Made-up stories the spiteful tell (never checked; the world knows they're false). */
const SMEARS = [
  (n: string) => `${n} has been fiddling the books`,
  (n: string) => `${n} owes money all over town`,
  (n: string) => `${n} is about to go bust`,
  (n: string) => `${n} was seen nicking from the market`,
  (n: string) => `${n} only got where they are by stabbing people in the back`,
];

/** The best thing to do next, by their own lights. */
export function proposeByRules(world: WorldState, c: Citizen): { action: AgentAction; why: string; options: AgentAction[] } {
  const s = societyOf(world, c);
  const p = profileOf(c);
  const b5 = c.personality.big5;
  const sit = situation(world, c);
  const r = rng(world, c);
  const out: Candidate[] = [{ action: { type: "carry_on", reason: "Nothing needs doing about anyone right now." }, score: 0.32 }];
  const add = (action: AgentAction, score: number) => {
    if (score <= 0.05 || checkAction(world, c, action)) return;
    out.push({ action, score });
  };
  const goals = activeGoals(c);
  const others = people(world, c);
  const rel = (o: Citizen) => c.relationships[o.id];
  const spare = Math.max(0, Math.floor(sit.liquid - sit.dailyCost * 3 - sit.rent));

  // Their plans, and the next step in each.
  for (const pr of s.projects.filter((x) => x.status === "active")) {
    const step = nextStep(world, c, pr);
    if (step.action) add(step.action, 0.55 + (pr.goalId ? (goals.find((g) => g.id === pr.goalId)?.priority ?? 0.3) * 0.4 : 0.1));
  }

  // A goal without a plan: start one.
  const planFor: Partial<Record<string, ProjectKind>> = { start_business: "open_business", get_job: "get_job", pay_debts: "clear_debt", save_money: "raise_money", beat_rival: "beat_rival", grow_business: "find_partner" };
  const recently = (kind: ProjectKind) => s.projects.some((x) => x.kind === kind && (x.status === "active" || world.time - (x.log[x.log.length - 1]?.t ?? x.started) < 3 * 1440));
  for (const g of goals) {
    const kind = planFor[g.kind];
    // (A business only looks for backers when it's short of cash.)
    const needed = kind !== "find_partner" || (openBizOf(world, c)?.cash ?? 999) < 90;
    if (kind && needed && !recently(kind)) add({ type: "start_project", project: kind, ...(g.who ? { target: g.who } : {}), reason: g.why || g.text }, 0.3 + g.priority * 0.45 + c.traits.ambition * 0.15);
    // Someone they'd like to be close to (a friend, or more).
    if ((g.kind === "find_love" || g.kind === "make_friends") && !s.projects.some((x) => x.status === "active" && x.kind === "win_over")) {
      const romantic = g.kind === "find_love";
      const pick = others
        .filter((o) => (rel(o)?.familiarity ?? 0) >= 8 && !c.family.includes(o.id) && (!romantic || (!inCouple(o) && !inCouple(c) && Math.abs(o.age - c.age) <= 14 && o.age >= 18 && c.age >= 18)))
        .sort((x, y) => (rel(y)?.affinity ?? 0) + compatibility(c, y) * 30 - ((rel(x)?.affinity ?? 0) + compatibility(c, x) * 30))[0];
      if (pick && (rel(pick)?.affinity ?? 0) > 10) add({ type: "start_project", project: "win_over", target: pick.id, reason: romantic ? `I keep thinking about ${pick.name}.` : `I'd like ${pick.name} as a proper friend.` }, 0.25 + g.priority * 0.4 + b5.extraversion * 0.15);
    }
  }

  // Someone they care about is struggling, and they can help.
  if (spare > 40) {
    for (const o of others) {
      const a = rel(o)?.affinity ?? 0;
      if (a < 35 && !c.family.includes(o.id)) continue;
      const knowsTrouble = (c.talk?.facts ?? []).some((f) => f.about === o.id && f.valence < -0.3 && f.pred !== "said" && world.time - f.learnedAt < 3 * 1440);
      const looks = situation(world, o).pressure > 0.6 && (rel(o)?.familiarity ?? 0) > 40;
      if (!knowsTrouble && !looks) continue;
      const kind = c.traits.generosity > 0.6 || c.family.includes(o.id) ? "help" : "lend";
      const amount = Math.round(Math.min(kind === "help" ? 40 : 80, spare * 0.4));
      add({ type: kind, target: o.id, amount, reason: `${o.name} is having a hard time.` }, 0.25 + c.traits.generosity * 0.45 + a / 200 - c.traits.greed * 0.25);
    }
  }

  // Grudges: have it out, or let it go.
  for (const o of others) {
    const f = feelingsToward(c, o.id);
    const a = rel(o)?.affinity ?? 0;
    const sore = (f.anger ?? 0) > 35 || a < -25;
    if (!sore) continue;
    const worst = [...c.memories.long, ...c.memories.short].filter((m) => m.people.includes(o.id) && m.valence < -0.3).sort((x, y) => x.valence * x.importance - y.valence * y.importance)[0];
    const grudge = worst ? worst.text.replace(new RegExp(`\\b${o.name}\\b`, "g"), "you").replace(/\bme\b/g, "me").replace(/\.$/, "") : "";
    if (p.confrontation === "escalates" || p.confrontation === "direct") add({ type: "confront", target: o.id, text: grudge ? `${grudge.charAt(0).toUpperCase()}${grudge.slice(1)}.` : undefined, reason: grudge || `${o.name} has it coming.` }, 0.15 + (f.anger ?? 0) / 150 + (1 - b5.agreeableness) * 0.25);
    if ((rel(o)?.familiarity ?? 0) > 20 && b5.agreeableness > 0.5) add({ type: "make_up", target: o.id, reason: `I don't want to fall out with ${o.name} for good.` }, 0.15 + b5.agreeableness * 0.35 + (rel(o)?.familiarity ?? 0) / 200);
    // The spiteful talk about them behind their back: what they know, or what they make up.
    if (b5.agreeableness < 0.4 && p.gossip > 0.45) {
      const dirt = (c.talk?.facts ?? []).find((x) => x.about === o.id && x.valence < -0.2 && x.certainty > 0.5);
      const honest = c.traits.greed < 0.55 || b5.conscientiousness > 0.6;
      const text = dirt ? dirt.text : honest ? null : SMEARS[Math.floor(rand(r) * SMEARS.length)](o.name);
      if (text) add({ type: "spread_rumour", about: o.id, text, reason: `People should know what ${o.name} is really like.` }, 0.12 + p.gossip * 0.25 + (1 - b5.agreeableness) * 0.2 + (f.envy ?? 0) / 200);
    }
  }

  // Business: rivals.
  const mine = openBizOf(world, c);
  if (mine && c.traits.competitiveness > 0.5) {
    for (const o of others) {
      const theirs = openBizOf(world, o);
      if (!theirs || !theirs.products.some((x) => mine.products.includes(x))) continue;
      add({ type: "compete", target: o.id, reason: `${theirs.name} is taking my customers.` }, 0.1 + c.traits.competitiveness * 0.35 + (theirs.avgProfit > mine.avgProfit ? 0.15 : 0));
    }
  }

  // Someone they fancy (and the nerve to ask).
  if (s.crush && s.crush.stage === "interested") {
    const o = world.citizens[s.crush.who];
    if (o && (rel(o)?.affinity ?? 0) > 40) add({ type: "ask_out", target: o.id, reason: `It's now or never with ${o.name}.` }, 0.2 + b5.extraversion * 0.3 + p.impulsiveness * 0.2);
  }

  // Lonely: go and find a friend.
  if (c.emotions.loneliness > 40 || c.needs.social < 30) {
    const friend = others.filter((o) => (rel(o)?.affinity ?? 0) > 25).sort((x, y) => (rel(x)?.lastT ?? 0) - (rel(y)?.lastT ?? 0))[0];
    if (friend) add({ type: "talk", target: friend.id, reason: `I haven't seen ${friend.name} in a while.` }, 0.2 + c.emotions.loneliness / 150);
  }

  // Out of work and no plan for it.
  if (c.occupation === "unemployed" && !s.projects.some((x) => x.status === "active" && x.kind === "get_job")) add({ type: "seek_work", reason: "I need a job." }, 0.4 + sit.pressure * 0.4);

  // Usually the most pressing; sometimes not.
  out.sort((x, y) => y.score - x.score);
  const pool = out.slice(0, 4);
  const weights = pool.map((x) => Math.exp((x.score - pool[0].score) / 0.12));
  let y = rand(r) * weights.reduce((a, b) => a + b, 0);
  let chosen = pool[0];
  for (let i = 0; i < pool.length; i++) {
    y -= weights[i];
    if (y <= 0) {
      chosen = pool[i];
      break;
    }
  }
  // (The few best, for a small model to choose between.)
  const options = out.slice(0, 6).map((x) => x.action);
  if (!options.some((x) => x.type === "carry_on")) options.push({ type: "carry_on", reason: "Nothing needs doing about anyone right now." });
  return { action: chosen.action, why: pool.map((x) => `${x.action.type}${x.action.target ? `→${world.citizens[x.action.target]?.name}` : ""} ${x.score.toFixed(2)}`).join(", "), options };
}
