import { situation } from "../ai/situation";
import { smallChoicePrompt, type SmallPrompt } from "../ai/small";
import { outstanding } from "../economy/bank";
import { identityOf, stateInWords } from "../dialogue/context";
import { relView } from "../dialogue/bonds";
import { spokenDays } from "../dialogue/grammar";
import { feelingsToward } from "../mind/emotions";
import { happeningById } from "../town/happenings";
import type { Citizen, WorldState } from "../types";
import { money } from "../util";
import { ACTION_HELP, ACTION_TYPES, DEAL_KINDS } from "./actions";
import { nextStep, PROJECT_KINDS } from "./projects";
import { proposeByRules } from "./propose";
import { alliesOf, reputationOf, TAG_WORDS } from "./reputation";
import { activeGoals, GOAL_KINDS, societyOf } from "./state";
import type { AgentAction } from "./types";

// What a model is given to decide for one agent: only what that agent knows
// (their own life, their own beliefs about other people, with where they
// heard things and how sure they are), what they want, what they've tried
// lately and how it went, and the moves the town allows. The reply is a
// structured proposal the world then checks; nothing in it changes the world
// by itself.

export const DECISION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ACTION_TYPES },
    target: { type: ["string", "null"] },
    about: { type: ["string", "null"] },
    deal: { type: ["string", "null"], enum: [...DEAL_KINDS, null] },
    amount: { type: ["number", "null"] },
    text: { type: ["string", "null"] },
    goal: { type: ["string", "null"], enum: [...GOAL_KINDS, null] },
    project: { type: ["string", "null"], enum: [...PROJECT_KINDS, null] },
    reason: { type: "string" },
    intention: { type: "string" },
  },
  required: ["action", "reason", "intention"],
};

const FEEL: Record<string, string> = { anger: "angry with", envy: "jealous of", gratitude: "grateful to", love: "fond of", fear: "wary of", shame: "ashamed around" };

/** One line for each person who matters to them, as they see it. */
function people(world: WorldState, c: Citizen): string[] {
  const out: string[] = [];
  const others = world.citizenOrder
    .map((id) => world.citizens[id])
    .filter((o) => o.id !== c.id && ((c.relationships[o.id]?.familiarity ?? 0) > 6 || c.family.includes(o.id)))
    .sort((x, y) => Math.abs(c.relationships[y.id]?.affinity ?? 0) + (c.relationships[y.id]?.familiarity ?? 0) / 2 - (Math.abs(c.relationships[x.id]?.affinity ?? 0) + (c.relationships[x.id]?.familiarity ?? 0) / 2))
    .slice(0, 9);
  const allies = alliesOf(world, c);
  for (const o of others) {
    const v = relView(world, c, o);
    const side = allies.filter((x) => x.ally === o.id).map((x) => world.citizens[x.against]?.name).filter(Boolean);
    // What the town says about them (as far as this person would have picked up).
    const said = reputationOf(world, o).tags.filter((t) => t !== "well liked" || (c.relationships[o.id]?.affinity ?? 0) < 20);
    const f = feelingsToward(c, o.id);
    const strong = Object.entries(f).filter(([k, x]) => (x ?? 0) > 25 && FEEL[k]).map(([k]) => FEEL[k]);
    const facts = (c.talk?.facts ?? []).filter((x) => x.about === o.id).sort((a, b) => b.learnedAt - a.learnedAt).slice(0, 2);
    const heard = facts.map((x) => `${x.text}${x.source === "rumour" || x.certainty < 0.5 ? " (a rumour, not sure)" : x.from && x.from !== o.id ? ` (${world.citizens[x.from]?.name ?? "someone"} told you)` : ""}`);
    const biz = o.businessIds.map((id) => world.businesses[id]).find((b) => b?.open);
    const owe = v.owed ? (v.owed.amount > 0 ? `owes you ${money(v.owed.amount)}${v.owed.overdue ? " (overdue)" : ""}` : `you owe them ${money(-v.owed.amount)}`) : "";
    out.push(`${o.name}: ${v.kind}${strong.length ? `; you're ${strong.join(" and ")} them` : ""}${biz ? `; runs ${biz.name}${biz.hiringWage > 0 ? " (hiring)" : ""}` : ""}${owe ? `; ${owe}` : ""}${side.length ? `; on your side against ${side.join(" and ")}` : ""}${said.length ? `; people say they're ${said.map((t) => TAG_WORDS[t] ?? t).join(", ")}` : ""}${heard.length ? `. You've heard: ${heard.join("; ")}` : ""}.`);
  }
  return out;
}

/** Their money, job and business, in plain words. */
function circumstances(world: WorldState, c: Citizen): string[] {
  const s = situation(world, c);
  const out = [`You have ${money(c.money)} on you and ${money(c.savings)} saved. Rent is ${money(s.rent)} a week${c.rentArrears > 0 ? `, and you're ${money(c.rentArrears)} behind` : ""}.`];
  const debts = world.loans.filter((l) => l.borrower === c.id && l.status === "active");
  if (debts.length) out.push(`You owe: ${debts.map((l) => `${money(Math.round(outstanding(l)))} to ${l.lender === "bank" ? "the bank" : (world.citizens[l.lender]?.name ?? "someone")}`).join(", ")}.`);
  const biz = c.businessIds.map((id) => world.businesses[id]).find((b) => b?.open && b.ownerId === c.id);
  if (biz) out.push(`You run ${biz.name}: about ${money(Math.round(biz.avgProfit))} a day profit, ${money(Math.round(biz.cash))} in the till, ${biz.employees.length} staff.`);
  else out.push(c.occupation === "unemployed" ? "You're out of work." : c.occupation === "employee" ? `You work at ${c.employerId === "corp" ? "CityCorp" : (world.businesses[c.employerId ?? ""]?.name ?? "a local business")} for ${money(c.wage)} a day.` : `You work as a ${c.occupation}.`);
  return out;
}

/** What the town thinks of them, as they'd sense it. */
function reputationLine(world: WorldState, c: Citizen): string {
  const r = reputationOf(world, c);
  if (r.knownBy < 2) return "Not many people in town know you yet.";
  const mood = r.standing >= 35 ? "People round here like you." : r.standing >= 10 ? "People round here get on with you, mostly." : r.standing > -15 ? "People round here are lukewarm about you." : "A lot of people round here don't like you.";
  return `${mood}${r.tags.filter((t) => t !== "well liked" && t !== "not well liked").length ? ` You're known as someone who ${r.tags.filter((t) => t !== "well liked" && t !== "not well liked").map((t) => (t === "owes money" ? "owes money" : t === "generous" ? "helps people out" : t === "caught telling lies" ? "has been caught telling lies" : t === "stirs things up" ? "stirs things up" : t === "has a rival" ? "has a rival" : t === "doing well" ? "is doing well" : t)).join(", ")}.` : ""}`;
}

/** The prompt for a big model (JSON back). */
export function decisionPrompt(world: WorldState, c: Citizen, why: string): { system: string; user: string; schema: Record<string, unknown> } {
  const s = societyOf(world, c);
  const goals = activeGoals(c);
  const projects = s.projects.filter((p) => p.status === "active");
  const done = s.decisions.filter((d) => d.action.type !== "carry_on").slice(-5);
  const news = c.news.slice(-3).map((k) => happeningById(world, k.id)?.title).filter(Boolean);
  const system = [
    `You decide what ${c.name} does next about the people in their life and what they want from it, in a simulation of a small British town. Decide as ${c.name} would: by their personality, what they know, what they want and what they can afford. They don't have to be nice, or sensible. Pick one action. The town checks it's possible and tells them what happened.`,
    "",
    "WHO YOU ARE",
    ...identityOf(world, c).slice(0, 8),
    "",
    "RIGHT NOW",
    ...stateInWords(world, c).slice(0, 4),
    ...circumstances(world, c),
    reputationLine(world, c),
    "",
    "WHAT YOU WANT",
    ...(goals.length ? goals.map((g) => `- ${g.text}${g.who ? ` (${world.citizens[g.who]?.name ?? ""})` : ""}: ${g.why}`) : ["- Nothing in particular."]),
    ...projects.map((p) => `Your plan: ${p.title}${p.need ? ` (needs ${money(p.need)}; ${money(p.raised)} promised)` : ""}${p.partners.length ? `; in with you: ${p.partners.map((id) => world.citizens[id]?.name).join(", ")}` : ""}${p.refused.length ? `; said no: ${p.refused.map((id) => world.citizens[id]?.name).join(", ")}` : ""}. Latest: ${p.log[p.log.length - 1]?.text ?? ""} Next step, maybe: ${nextStep(world, c, p).text}`),
    s.intention ? `What you meant to do: ${s.intention.text}` : "",
    "",
    "WHAT YOU'VE DONE LATELY, AND HOW IT WENT",
    ...(done.length ? done.map((d) => `- ${d.action.type}${d.action.target ? ` (${world.citizens[d.action.target]?.name})` : ""}: ${d.result ?? d.status}`) : ["- Nothing much."]),
    "",
    "PEOPLE IN YOUR LIFE (as you see them)",
    ...people(world, c),
    news.length ? `\nIn town: ${news.join("; ")}.` : "",
  ]
    .filter((x) => x !== "")
    .map((x) => spokenDays(x, world.time))
    .join("\n");
  const user = [
    `Why you're thinking about it now: ${spokenDays(why, world.time)}.`,
    "What you can do:",
    ...ACTION_TYPES.map((t) => `- ${t}: ${ACTION_HELP[t]}`),
    `Use people's first names. Goals: ${GOAL_KINDS.join(", ")}. Plans: ${PROJECT_KINDS.join(", ")}.`,
    `Reply as JSON: {"action", "target", "about", "deal", "amount", "text", "goal", "project", "reason" (why, in ${c.name}'s own words), "intention" (what they mean to do next, in a sentence, first person)}. Leave out what you don't need.`,
  ].join("\n");
  return { system, user, schema: DECISION_SCHEMA };
}

/** A label for an action, as a short choice for a small model. */
export function actionLabel(world: WorldState, a: AgentAction): string {
  const t = a.target ? world.citizens[a.target]?.name : undefined;
  switch (a.type) {
    case "carry_on":
      return "Nothing new: get on with the day";
    case "talk":
      return `Go and find ${t} for a chat`;
    case "seek_work":
      return t ? `Ask ${t} for a job` : "Go and look for work";
    case "propose_deal":
      return a.deal === "loan" ? `Ask ${t} to lend you ${money(a.amount ?? 50)}` : a.deal === "investment" ? `Ask ${t} to invest in your business` : a.deal === "job_offer" ? `Offer ${t} a job` : a.deal === "partnership" ? `Ask ${t} to come in on your plan` : a.deal === "sale" ? `Sell ${t} some stock` : `Ask ${t} for a job`;
    case "lend":
      return `Offer to lend ${t} ${money(a.amount ?? 30)}`;
    case "help":
      return `Give ${t} ${money(a.amount ?? 20)}`;
    case "spread_rumour":
      return `Tell people "${a.text}"`;
    case "compete":
      return `Undercut ${t}'s prices`;
    case "confront":
      return `Have it out with ${t}`;
    case "make_up":
      return `Try to make up with ${t}`;
    case "ask_out":
      return `Ask ${t} out`;
    case "change_goal":
      return `Aim for something new: ${a.goal}`;
    case "start_project":
      return `Start a plan: ${a.project?.replace(/_/g, " ")}${t ? ` (${t})` : ""}`;
  }
}

/** For the small model in the page: a short list of the sensible things they could do (from the built-in judgement), to choose between. */
export function smallDecisionPrompt(world: WorldState, c: Citizen): { small: SmallPrompt; options: AgentAction[] } {
  const { options } = proposeByRules(world, c);
  const small = smallChoicePrompt(
    world,
    c,
    options.map((a, i) => ({ id: String(i), label: actionLabel(world, a) })),
  );
  return { small, options };
}
