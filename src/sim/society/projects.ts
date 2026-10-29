import { situation } from "../ai/situation";
import { launchBusiness } from "../ai/economyStrategy";
import { outstanding } from "../economy/bank";
import { addPartner, KIND_INFO, MIN_OWNER_SHARE } from "../economy/business";
import { planBusiness, type BusinessPlan } from "../economy/opportunity";
import { ownerShare } from "../economy/valuation";
import { logEvent } from "../events";
import { remember } from "../memory/memory";
import { feel } from "../mind/emotions";
import type { BusinessKind, Citizen, CitizenId, WorldState } from "../types";
import { money, newId, round2 } from "../util";
import { SOCIETY } from "./config";
import { activeGoals, societyOf } from "./state";
import type { AgentAction, Project, ProjectKind } from "./types";

// Plans that take days: an idea, the people and the money it needs, the
// thing itself, and what goes wrong on the way. A plan is checked against
// the real town every day: did the business open, did the debt get paid,
// did the rival close? People who said no are remembered; when a plan stalls
// the agent scales it down, finds another way, or gives up, by temperament.

export const PROJECT_KINDS: ProjectKind[] = ["open_business", "find_partner", "raise_money", "get_job", "win_over", "beat_rival", "clear_debt"];

const DAY = 1440;

function openBizOf(world: WorldState, c: Citizen) {
  return c.businessIds.map((id) => world.businesses[id]).find((b) => b && b.open && b.ownerId === c.id) ?? null;
}

/** The cheapest sensible business they could open (the plan's starting point). */
function businessIdea(world: WorldState, c: Citizen, kinds: BusinessKind[] = ["stall", "shop", "cafe"]): BusinessPlan | null {
  let best: BusinessPlan | null = null;
  // Budget: what they have plus what they might get others to put in.
  const budget = c.money + c.savings + 250;
  for (const k of kinds) {
    const p = planBusiness(world, c, k, budget);
    if (!p) continue;
    if (!best || p.expectedProfit - p.startupCost / 15 > best.expectedProfit - best.startupCost / 15) best = p;
  }
  return best;
}

/** Could they start this plan now? (null: yes; otherwise why not) */
export function canStart(world: WorldState, c: Citizen, kind: ProjectKind, who?: CitizenId): string | null {
  const s = c.society;
  if (s?.projects.some((x) => x.kind === kind && x.status !== "active" && x.who === who && world.time - (x.log[x.log.length - 1]?.t ?? x.started) < 3 * DAY)) return "they only just finished a plan like that";
  const other = who ? world.citizens[who] : undefined;
  switch (kind) {
    case "open_business":
      return openBizOf(world, c) ? "they've already got a business" : businessIdea(world, c) ? null : "there's nowhere to open, or nothing worth selling";
    case "find_partner":
      return openBizOf(world, c) ? null : "they've no business to find a backer for";
    case "get_job":
      return c.occupation === "employee" && c.wage >= world.economy.corpWage ? "they've got a decent job" : null;
    case "win_over":
      if (!other) return "win over whom?";
      return (c.relationships[other.id]?.roles.includes("couple") || (other.relationships[c.id]?.affinity ?? 0) >= 50) ? `they're already close to ${other.name}` : null;
    case "beat_rival": {
      const rivalId = who ?? Object.entries(c.relationships).find(([, r]) => r.roles.includes("rival"))?.[0];
      return openBizOf(world, c) && rivalId && openBizOf(world, world.citizens[rivalId]) ? null : "there's no rival business to beat";
    }
    case "clear_debt":
      return world.loans.some((l) => l.borrower === c.id && l.status === "active") ? null : "they don't owe anything";
    case "raise_money":
      return null;
  }
}

/** Start a plan (null: there's no sensible way to). */
export function startProject(world: WorldState, c: Citizen, kind: ProjectKind, source: "llm" | "rules", who?: CitizenId, text?: string): Project | null {
  const s = societyOf(world, c);
  const other = who ? world.citizens[who] : undefined;
  const base = { id: newId(world), kind, started: world.time, partners: [], refused: [], raised: 0, pledges: [], status: "active" as const, log: [], source };
  let pr: Project | null = null;
  switch (kind) {
    case "open_business": {
      if (openBizOf(world, c)) return null;
      const idea = businessIdea(world, c);
      if (!idea) return null;
      const noun = KIND_INFO[idea.kind].noun;
      const what = idea.kind === "cafe" ? "a café" : `a ${noun} selling ${idea.products.map((p) => world.products[p].name.toLowerCase()).join(" & ")}`;
      pr = { ...base, title: text || `Open ${what}`, deadline: world.time + 7 * DAY, need: Math.round(idea.startupCost + 30), plan: { kind: idea.kind, products: idea.products }, steps: [{ text: `Decide on ${what}`, done: true }, { text: `Find ${money(Math.round(idea.startupCost + 30))}`, done: false }, { text: "Get someone to come in on it", done: false }, { text: "Open the doors", done: false }] };
      break;
    }
    case "find_partner": {
      const b = openBizOf(world, c);
      if (!b) return null;
      pr = { ...base, title: text || `Find a backer for ${b.name}`, deadline: world.time + 6 * DAY, need: 120, businessId: b.id, steps: [{ text: "Find someone who'd put money in", done: false }] };
      break;
    }
    case "raise_money": {
      const s0 = situation(world, c);
      const need = Math.round(Math.max(80, s0.rent * 2 + s0.dailyCost * 3, (c.money + c.savings) * 1.5));
      pr = { ...base, title: text || `Put ${money(need)} by`, deadline: world.time + 7 * DAY, need, steps: [{ text: `Get to ${money(need)}`, done: false }] };
      break;
    }
    case "get_job":
      if (c.occupation === "employee" && c.wage >= world.economy.corpWage) return null;
      pr = { ...base, title: text || "Find a job", deadline: world.time + 5 * DAY, need: 0, steps: [{ text: "Ask around", done: false }, { text: "Get taken on", done: false }] };
      break;
    case "win_over":
      if (!other) return null;
      pr = { ...base, title: text || `Get closer to ${other.name}`, deadline: world.time + 8 * DAY, need: 0, who: other.id, steps: [{ text: `Spend time with ${other.name}`, done: false }, { text: `Be someone ${other.name} counts on`, done: false }] };
      break;
    case "beat_rival": {
      const mine = openBizOf(world, c);
      const rivalId = who ?? Object.entries(c.relationships).find(([, r]) => r.roles.includes("rival"))?.[0];
      const rival = rivalId ? world.citizens[rivalId] : undefined;
      if (!mine || !rival || !openBizOf(world, rival)) return null;
      pr = { ...base, title: text || `Beat ${openBizOf(world, rival)!.name}`, deadline: world.time + 7 * DAY, need: 0, who: rival.id, businessId: mine.id, steps: [{ text: "Undercut them", done: false }, { text: "Outsell them", done: false }] };
      break;
    }
    case "clear_debt": {
      const owed = world.loans.filter((l) => l.borrower === c.id && l.status === "active").reduce((sum, l) => sum + outstanding(l), 0);
      if (owed <= 0) return null;
      pr = { ...base, title: text || `Pay off the ${money(round2(owed))} I owe`, deadline: world.time + 8 * DAY, need: Math.ceil(owed), steps: [{ text: "Pay back what I owe", done: false }] };
      break;
    }
  }
  if (!pr) return null;
  // Not the same plan again straight after the last one ended.
  if (s.projects.some((x) => x.kind === kind && x.status !== "active" && x.who === pr!.who && world.time - (x.log[x.log.length - 1]?.t ?? x.started) < 3 * DAY)) return null;
  pr.log.push({ t: world.time, text: "Started.", good: true });
  const goal = activeGoals(c).find((g) => ({ open_business: "start_business", get_job: "get_job", clear_debt: "pay_debts", raise_money: "save_money", beat_rival: "beat_rival", win_over: g.kind === "find_love" ? "find_love" : "make_friends", find_partner: "grow_business" })[kind] === g.kind);
  if (goal) pr.goalId = goal.id;
  s.projects.push(pr);
  if (s.projects.length > SOCIETY.projectsKept) s.projects.splice(0, s.projects.length - SOCIETY.projectsKept);
  remember(world, c, { text: `I've made up my mind: ${pr.title.replace(/^./, (x) => x.toLowerCase())}.`, kind: "insight", importance: 6, valence: 0.4, people: pr.who ? [pr.who] : [] });
  return pr;
}

/** What they'd do next about a plan (for the rules, and to show the model). */
export function nextStep(world: WorldState, c: Citizen, pr: Project): { text: string; action: AgentAction | null } {
  const spare = Math.max(0, c.money + c.savings - 30);
  const people = world.citizenOrder.map((id) => world.citizens[id]).filter((o) => o.id !== c.id && (c.relationships[o.id]?.familiarity ?? 0) > 5);
  const likely = people
    .filter((o) => !pr.refused.includes(o.id) && !pr.partners.includes(o.id) && o.money + o.savings > 80)
    .sort((x, y) => (c.relationships[y.id]?.affinity ?? 0) + (c.relationships[y.id]?.trust ?? 0) - ((c.relationships[x.id]?.affinity ?? 0) + (c.relationships[x.id]?.trust ?? 0)))[0];
  switch (pr.kind) {
    case "open_business": {
      const short = pr.need - spare - pr.raised;
      if (short <= 0) return { text: "I've got the money. Time to open.", action: null };
      if (likely) return { text: `Ask ${likely.name} to come in on it.`, action: { type: "propose_deal", deal: "partnership", target: likely.id, amount: Math.max(30, Math.min(200, short)), reason: `I need ${money(Math.max(0, short))} more for ${pr.title.toLowerCase()}.` } };
      return { text: `Save up: still ${money(Math.max(0, short))} short.`, action: null };
    }
    case "find_partner": {
      // A business that's already open takes investment for a share.
      if (likely && openBizOf(world, c)) return { text: `Pitch ${openBizOf(world, c)!.name} to ${likely.name}.`, action: { type: "propose_deal", deal: "investment", target: likely.id, amount: Math.max(50, Math.min(200, pr.need)), reason: `${openBizOf(world, c)!.name} could do with backing.` } };
      return { text: "Find someone with money who believes in it.", action: null };
    }
    case "raise_money": {
      if (c.occupation === "unemployed") return { text: "Find work.", action: { type: "seek_work", reason: "I can't save without an income." } };
      return { text: `Keep saving: ${money(Math.max(0, pr.need - (c.money + c.savings)))} to go.`, action: null };
    }
    case "get_job": {
      const owner = people.find((o) => {
        const b = openBizOf(world, o);
        return b && b.hiringWage > 0 && !pr.refused.includes(o.id);
      });
      return owner ? { text: `Ask ${owner.name} for work.`, action: { type: "seek_work", target: owner.id, reason: "They're hiring." } } : { text: "Try CityCorp.", action: { type: "seek_work", reason: "Somebody's got to be hiring." } };
    }
    case "win_over": {
      const o = world.citizens[pr.who!];
      if (!o) return { text: "", action: null };
      const theirs = situation(world, o);
      if (theirs.pressure > 0.6 && spare > 40) return { text: `Help ${o.name} out: they're struggling.`, action: { type: "help", target: o.id, amount: Math.min(40, Math.floor(spare * 0.3)), reason: `${o.name} is struggling, and I want them to know I'm there.` } };
      const romantic = activeGoals(c).some((g) => g.kind === "find_love" && (g.who === o.id || !g.who));
      if (romantic && (c.relationships[o.id]?.affinity ?? 0) > 40) return { text: `Ask ${o.name} out.`, action: { type: "ask_out", target: o.id, reason: `I think there's something there with ${o.name}.` } };
      return { text: `Spend time with ${o.name}.`, action: { type: "talk", target: o.id, reason: `I want to get to know ${o.name} better.` } };
    }
    case "beat_rival": {
      const o = world.citizens[pr.who!];
      return o ? { text: `Undercut ${o.name}.`, action: { type: "compete", target: o.id, reason: `${o.name} won't know what's hit them.` } } : { text: "", action: null };
    }
    case "clear_debt":
      return c.occupation === "unemployed" ? { text: "Find work to pay it off.", action: { type: "seek_work", reason: "I need money coming in." } } : { text: "Keep paying it down.", action: null };
  }
}

/** Every day: is it done, has it failed, and what's gone wrong? (Checked against the real town.) */
export function projectsDaily(world: WorldState, c: Citizen): void {
  const s = c.society;
  if (!s) return;
  for (const pr of s.projects) {
    if (pr.status !== "active") continue;
    const done = (text: string) => {
      pr.status = "done";
      for (const st of pr.steps) st.done = true;
      pr.log.push({ t: world.time, text, good: true });
      remember(world, c, { text: `I did it: ${pr.title.replace(/^./, (x) => x.toLowerCase())}.`, kind: "insight", importance: 7, valence: 0.8, people: pr.partners, feel: { pride: 25, joy: 15 } });
      const g = pr.goalId ? s.goals.find((x) => x.id === pr.goalId) : undefined;
      if (g && ["start_business", "get_job", "pay_debts", "save_money"].includes(g.kind)) g.status = "achieved";
    };
    const fail = (text: string) => {
      pr.status = "failed";
      pr.log.push({ t: world.time, text, good: false });
      remember(world, c, { text: `It didn't work out: ${pr.title.replace(/^./, (x) => x.toLowerCase())}. ${text}`, kind: "insight", importance: 6, valence: -0.6, people: pr.partners, feel: { sadness: 15, shame: 8 } });
    };
    switch (pr.kind) {
      case "open_business": {
        const b = openBizOf(world, c);
        if (b && b.foundedT >= pr.started - 60) {
          pr.businessId = b.id;
          done(`${b.name} is open.`);
          break;
        }
        const own = Math.max(0, c.money + c.savings - 30);
        if (pr.plan && own + pr.raised >= pr.need) {
          launch(world, c, pr);
          break;
        }
        if (world.time > pr.deadline) {
          // Patience and temperament: try something cheaper for a few more days, or give up.
          if (pr.plan?.kind !== "stall" && c.personality.big5.neuroticism < 0.7 && !pr.log.some((l) => l.text.startsWith("Scaled down"))) {
            const cheaper = businessIdea(world, c, ["stall"]);
            if (cheaper) {
              pr.plan = { kind: cheaper.kind, products: cheaper.products };
              pr.need = Math.round(cheaper.startupCost + 20);
              pr.deadline = world.time + 4 * DAY;
              pr.title = `Open a ${KIND_INFO[cheaper.kind].noun} selling ${cheaper.products.map((p) => world.products[p].name.toLowerCase()).join(" & ")}`;
              pr.log.push({ t: world.time, text: `Scaled down: a ${KIND_INFO[cheaper.kind].noun} instead (${money(pr.need)}).`, good: false });
              break;
            }
          }
          fail(`Couldn't find the money (${money(Math.round(own + pr.raised))} of ${money(pr.need)}).`);
        } else if (pr.refused.length >= 3 && !pr.log.some((l) => l.text.startsWith("Nobody wants in"))) pr.log.push({ t: world.time, text: "Nobody wants in. I'll have to do it on my own.", good: false });
        pr.steps[1].done = own + pr.raised >= pr.need;
        pr.steps[2].done = pr.partners.length > 0;
        break;
      }
      case "find_partner": {
        // Done when someone has actually bought into the business since the plan started.
        const b = openBizOf(world, c);
        const backers = b ? b.partners.filter((x) => (world.citizens[x.citizenId]?.memories.short ?? []).some((m) => m.t >= pr.started && m.kind === "deal" && m.people.includes(c.id))) : [];
        if (backers.length) {
          pr.partners = backers.map((x) => x.citizenId);
          done(`${pr.partners.map((id) => world.citizens[id]?.name).join(" and ")} bought in.`);
        } else if (!b) fail("There's no business to bring anyone into.");
        else if (world.time > pr.deadline) fail("Nobody wanted in.");
        break;
      }
      case "raise_money":
        if (c.money + c.savings >= pr.need) done(`I've got ${money(pr.need)} put by.`);
        else if (world.time > pr.deadline) fail(`I only managed ${money(Math.round(c.money + c.savings))}.`);
        break;
      case "get_job":
        if ((c.occupation === "employee" || c.employerId) && c.occupationSince >= pr.started - 60) done(`I'm working at ${c.employerId === "corp" ? "CityCorp" : (world.businesses[c.employerId ?? ""]?.name ?? "a new place")}.`);
        else if (world.time > pr.deadline) fail("Nobody would take me on.");
        break;
      case "win_over": {
        const o = world.citizens[pr.who!];
        const mine = c.relationships[pr.who!]?.affinity ?? 0;
        const theirs = o?.relationships[c.id]?.affinity ?? 0;
        pr.steps[0].done = (c.relationships[pr.who!]?.familiarity ?? 0) > 30;
        if (o && (theirs >= 50 || c.relationships[pr.who!]?.roles.includes("couple"))) done(`${o.name} and I are close now.`);
        else if (world.time > pr.deadline || theirs < -30) fail(`${o?.name ?? "They"} just isn't interested.`);
        void mine;
        break;
      }
      case "beat_rival": {
        const rival = world.citizens[pr.who!];
        const theirs = rival ? openBizOf(world, rival) : null;
        const mine = openBizOf(world, c);
        if (!mine) fail("My own place went under first.");
        else if (!theirs) done(`${rival?.name ?? "They"} closed down. I won.`);
        else if (mine.avgProfit > Math.max(10, theirs.avgProfit * 1.4)) done(`${mine.name} is doing far better than ${theirs.name} now.`);
        else if (world.time > pr.deadline) fail(`${theirs.name} is still going strong.`);
        break;
      }
      case "clear_debt": {
        const owed = world.loans.filter((l) => l.borrower === c.id && l.status === "active").reduce((sum, l) => sum + outstanding(l), 0);
        if (owed <= 0.5) done("I don't owe anyone a penny.");
        else if (world.time > pr.deadline) fail(`I still owe ${money(round2(owed))}.`);
        break;
      }
    }
  }
}

/** The plan comes off: the business opens, and those who promised money pay it in (if they still can). */
function launch(world: WorldState, c: Citizen, pr: Project): void {
  const plan = { kind: pr.plan!.kind as BusinessKind, products: pr.plan!.products, expectedProfit: 0, startupCost: Math.max(20, pr.need - 30 - pr.raised), reason: pr.title };
  const b = launchBusiness(world, c, plan, plan.kind === "agency" ? "entrepreneur" : "shopkeeper");
  if (!b) {
    pr.log.push({ t: world.time, text: "Couldn't get premises or the money together today.", good: false });
    return;
  }
  pr.businessId = b.id;
  const total = plan.startupCost + pr.raised;
  for (const p of pr.pledges) {
    const backer = world.citizens[p.who];
    if (!backer) continue;
    const share = round2(Math.min(ownerShare(b) - MIN_OWNER_SHARE, Math.max(0.05, (p.amount / total) * 0.85)));
    const ok = backer.money + backer.savings >= p.amount && addPartner(world, b, backer, p.amount, share);
    if (ok) {
      pr.log.push({ t: world.time, text: `${backer.name} paid in ${money(p.amount)} for ${Math.round(share * 100)}%.`, good: true });
      remember(world, backer, { text: `${c.name} opened ${b.name}. I put in ${money(p.amount)}: I own ${Math.round(share * 100)}% of it.`, kind: "deal", importance: 7, valence: 0.6, people: [c.id] });
    } else {
      // A promise they couldn't keep.
      pr.log.push({ t: world.time, text: `${backer.name} couldn't come up with the ${money(p.amount)} they promised.`, good: false });
      remember(world, c, { text: `${backer.name} let me down: they never paid in the ${money(p.amount)} they promised.`, kind: "betrayal", importance: 6, valence: -0.6, people: [backer.id], feel: { anger: 15 } });
    }
  }
  feel(c, { pride: 25, joy: 20 });
  logEvent(world, "business", `🎉 ${c.name}'s plan came off: ${b.name} is open${pr.partners.length ? `, backed by ${pr.partners.map((id) => world.citizens[id]?.name).filter(Boolean).join(" and ")}` : ""}.`, 4, [c.id, ...pr.partners]);
}
