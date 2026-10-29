import { situation } from "../ai/situation";
import { priceFloor } from "../economy/business";
import { corpOpenings } from "../economy/jobs";
import { netWorth } from "../economy/valuation";
import { learn } from "../dialogue/knowledge";
import { cuesOf } from "../dialogue/grammar";
import { logEvent } from "../events";
import { remember } from "../memory/memory";
import { needsStaff, MAX_STAFF } from "../social/negotiation";
import { addRole, adjustRel } from "../social/relationships";
import type { Citizen, CitizenId, WorldState } from "../types";
import { money, newId, pushRing, round2 } from "../util";
import { SOCIETY } from "./config";
import { canStart, startProject, PROJECT_KINDS } from "./projects";
import { addGoal, GOAL_KINDS, goalText, settleDecision, societyOf, societyWorld } from "./state";
import type { AgentAction, AgentActionType, AgentDecision, DealKind, Intent } from "./types";

// What an agent can do about the people in their life and their ambitions,
// and the world's side of it: is it possible (money, ownership, who's who,
// time, cooldowns), and if so, carry it out. Most things are done by going to
// find someone and having it out in conversation (where the other one has
// their say); a few are done directly (a price cut, a new goal, a plan, a
// rumour started). Either way the agent is told what actually happened.

export const ACTION_TYPES: AgentActionType[] = ["talk", "seek_work", "propose_deal", "lend", "help", "spread_rumour", "compete", "confront", "make_up", "ask_out", "change_goal", "start_project", "carry_on"];
export const DEAL_KINDS: DealKind[] = ["loan", "investment", "job_offer", "job_ask", "sale", "partnership"];

/** The action menu, as a model sees it. */
export const ACTION_HELP: Record<AgentActionType, string> = {
  talk: "go and find someone to talk to (target; text: what about)",
  seek_work: "look for a job (target: a business owner to ask, or none for CityCorp)",
  propose_deal: "propose a deal (target; deal: loan = ask them to lend you money (amount), investment = ask them to invest in your business (amount), job_offer = offer them a job at your business, job_ask = ask them for a job, sale = sell them your stock, partnership = ask them to put money into your plan (amount))",
  lend: "offer to lend someone money (target, amount)",
  help: "give someone money, no strings (target, amount)",
  spread_rumour: "tell people something about someone (about; text: what you'll say; it doesn't have to be true)",
  compete: "undercut a rival business's prices (target: the rival)",
  confront: "have it out with someone (target; text: what's bothering you)",
  make_up: "try to patch things up with someone you've fallen out with (target)",
  ask_out: "ask someone out (target)",
  change_goal: "aim for something different in life (goal)",
  start_project: "start a plan that will take days (project; target: someone to bring in, if any)",
  carry_on: "nothing new: get on with your day",
};

const clean = (s: unknown, max = SOCIETY.maxClaim): string =>
  typeof s === "string"
    ? s
        .replace(/[\r\n]+/g, " ")
        .replace(/[<>{}[\]`]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

/** A person by name (first name, or full name, any case), or id. */
export function personNamed(world: WorldState, name: unknown): Citizen | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const s = name.trim().toLowerCase();
  if (world.citizens[name.trim()]) return world.citizens[name.trim()];
  return world.citizenOrder.map((id) => world.citizens[id]).find((c) => c.name.toLowerCase() === s || `${c.name} ${c.surname}`.toLowerCase() === s || s.split(/\s+/)[0] === c.name.toLowerCase()) ?? null;
}

const spareOf = (world: WorldState, c: Citizen) => {
  const s = situation(world, c);
  return Math.max(0, Math.floor(s.liquid - s.dailyCost * 3 - s.rent));
};

function openBizOf(world: WorldState, c: Citizen) {
  return c.businessIds.map((id) => world.businesses[id]).find((b) => b && b.open && b.ownerId === c.id) ?? null;
}

function inCouple(c: Citizen): CitizenId | null {
  return Object.entries(c.relationships).find(([, r]) => r.roles.includes("couple"))?.[0] ?? null;
}

/** Read a model's proposal (names for people), or say what's wrong with it. */
export function readAction(world: WorldState, c: Citizen, raw: unknown): { ok: true; action: AgentAction } | { ok: false; error: string } {
  const j = (raw ?? {}) as Record<string, unknown>;
  const type = typeof j.action === "string" ? (j.action.trim().toLowerCase() as AgentActionType) : null;
  if (!type || !ACTION_TYPES.includes(type)) return { ok: false, error: `unknown action "${String(j.action)}"` };
  const a: AgentAction = { type, reason: clean(j.reason, 200) || "No reason given." };
  if (j.target !== undefined && j.target !== null && j.target !== "") {
    const t = personNamed(world, j.target);
    if (!t) return { ok: false, error: `nobody called "${String(j.target)}" lives here` };
    a.target = t.id;
  }
  if (j.about !== undefined && j.about !== null && j.about !== "") {
    const t = personNamed(world, j.about);
    if (!t) return { ok: false, error: `nobody called "${String(j.about)}" lives here` };
    a.about = t.id;
  }
  if (typeof j.deal === "string" && j.deal) {
    if (!DEAL_KINDS.includes(j.deal as DealKind)) return { ok: false, error: `unknown deal "${j.deal}"` };
    a.deal = j.deal as DealKind;
  }
  if (typeof j.amount === "number" && Number.isFinite(j.amount) && j.amount > 0) a.amount = Math.round(j.amount);
  const text = clean(j.text);
  if (text) a.text = text;
  if (typeof j.goal === "string" && j.goal) {
    if (!GOAL_KINDS.includes(j.goal as never)) return { ok: false, error: `unknown goal "${j.goal}"` };
    a.goal = j.goal as AgentAction["goal"];
  }
  if (typeof j.project === "string" && j.project) {
    if (!PROJECT_KINDS.includes(j.project as never)) return { ok: false, error: `unknown project "${j.project}"` };
    a.project = j.project as AgentAction["project"];
  }
  return { ok: true, action: a };
}

/** The world's verdict: null if it can be done, or why not. */
export function checkAction(world: WorldState, c: Citizen, a: AgentAction): string | null {
  const t = a.target ? world.citizens[a.target] : null;
  if (a.target && !t) return "no such person";
  if (t && t.id === c.id) return "that's themselves";
  const known = (o: Citizen) => (c.relationships[o.id]?.familiarity ?? 0) > 0 || c.family.includes(o.id) || o.insideId === c.insideId;
  const needsTarget = ["talk", "propose_deal", "lend", "help", "compete", "confront", "make_up", "ask_out"];
  if (needsTarget.includes(a.type) && !t) return `${a.type} needs someone to do it with`;
  if (t && needsTarget.includes(a.type) && a.type !== "compete" && !known(t)) return `they don't know ${t.name}`;
  const spare = spareOf(world, c);
  const busy = (topic: string) => (c.society?.intents ?? []).some((i) => i.topic === topic && i.target === a.target);
  // Already on their way to see this person about something.
  if (t && (c.society?.intents ?? []).some((i) => i.target === t.id) && a.type !== "compete") return `they're already going to see ${t.name}`;
  switch (a.type) {
    case "carry_on":
      return null;
    case "talk":
      return busy("chat") ? "they already mean to talk to them" : null;
    case "seek_work": {
      if (t) {
        const biz = openBizOf(world, t);
        if (!biz) return `${t.name} hasn't got a business to work at`;
        if (biz.employees.some((e) => e.citizenId === c.id)) return "they already work there";
        if (biz.employees.length >= (MAX_STAFF[biz.kind] ?? 1)) return `${biz.name} is fully staffed`;
        return null;
      }
      if (c.occupation === "employee" && c.wage >= world.economy.corpWage) return "they've already got a decent job";
      return null;
    }
    case "propose_deal": {
      if (!a.deal) return "which deal?";
      const tw = netWorth(world, t!);
      switch (a.deal) {
        case "loan":
          if (world.loans.some((l) => l.lender === t!.id && l.borrower === c.id && l.status === "active")) return `they already owe ${t!.name} money`;
          if (tw < 40) return `${t!.name} hasn't got money to lend`;
          return null;
        case "investment": {
          const biz = openBizOf(world, c);
          if (!biz) return "they haven't got a business to invest in";
          if (biz.partners.some((p) => p.citizenId === t!.id)) return `${t!.name} is already a partner`;
          return tw < 100 ? `${t!.name} hasn't got money to invest` : null;
        }
        case "job_offer": {
          const biz = openBizOf(world, c);
          if (!biz) return "they haven't got a business to hire for";
          if (biz.employees.length >= (MAX_STAFF[biz.kind] ?? 1)) return `${biz.name} is fully staffed`;
          if (openBizOf(world, t!)) return `${t!.name} runs their own business`;
          if (biz.employees.some((e) => e.citizenId === t!.id)) return `${t!.name} already works there`;
          return null;
        }
        case "job_ask": {
          const biz = openBizOf(world, t!);
          if (!biz) return `${t!.name} hasn't got a business`;
          if (biz.employees.length >= (MAX_STAFF[biz.kind] ?? 1)) return `${biz.name} is fully staffed`;
          return null;
        }
        case "sale": {
          const biz = openBizOf(world, t!);
          if (!biz) return `${t!.name} hasn't got a shop to sell to`;
          const has = Object.entries(c.inventory).some(([pid, it]) => it.qty > 0 && biz.products.includes(pid));
          return has ? null : `they've nothing ${biz.name} sells`;
        }
        case "partnership": {
          const pr = (c.society?.projects ?? []).find((p) => p.status === "active" && p.need > p.raised);
          if (!pr) return "they've no plan that needs money";
          if (pr.partners.includes(t!.id)) return `${t!.name} is already in`;
          return null;
        }
      }
      return null;
    }
    case "lend":
    case "help": {
      const amount = a.amount ?? 0;
      if (amount < (a.type === "lend" ? 10 : 1)) return "how much?";
      if (amount > spare * SOCIETY.maxGiveShare + 1) return `they can't spare ${money(amount)} (about ${money(Math.floor(spare * SOCIETY.maxGiveShare))} at most)`;
      return busy(a.type === "lend" ? "offer_loan" : "offer_help") ? "they already mean to" : null;
    }
    case "spread_rumour": {
      const about = a.about ? world.citizens[a.about] : null;
      if (!about) return "about whom?";
      if (about.id === c.id) return "a rumour about themselves?";
      if (!a.text) return "what will they say?";
      // Only people they've heard of.
      for (const id of world.citizenOrder) {
        const o = world.citizens[id];
        if (o.id !== c.id && new RegExp(`\\b${o.name}\\b`).test(a.text) && !known(o) && o.id !== about.id) return `they don't know any ${o.name}`;
      }
      return null;
    }
    case "compete": {
      const mine = openBizOf(world, c);
      if (!mine) return "they haven't got a business";
      const theirs = openBizOf(world, t!);
      if (!theirs) return `${t!.name} hasn't got a business`;
      if (!mine.products.some((p) => theirs.products.includes(p))) return `${theirs.name} doesn't sell what they sell`;
      if (world.time - (mine.lastPriceChangeT ?? -1e9) < 12 * 60) return "they changed their prices only just now";
      // Only if there's room to go cheaper than them without selling at a loss.
      const shared = mine.products.filter((p) => theirs.products.includes(p));
      if (shared.every((p) => (mine.prices[p] ?? 0) <= (theirs.prices[p] ?? 0) * 0.93 + 0.01)) return `they're already cheaper than ${theirs.name}`;
      const room = shared.some((p) => Math.max(priceFloor(world, mine, c, p), Math.min(mine.prices[p] ?? 0, (theirs.prices[p] ?? 0) * 0.93)) < (mine.prices[p] ?? 0) - 0.01);
      return room ? null : "they can't go any cheaper without losing money";
    }
    case "confront":
      return world.time - (c.cooldowns[`argue:${t!.id}`] ?? -1e9) < 1440 ? "they had a row only yesterday" : null;
    case "make_up": {
      const r = c.relationships[t!.id];
      const sore = (r?.affinity ?? 0) < 15 || [...c.memories.short, ...c.memories.long].some((m) => m.people.includes(t!.id) && m.valence < -0.3);
      return sore ? null : "there's nothing to make up for";
    }
    case "ask_out": {
      if (c.age < 18 || t!.age < 18) return "not appropriate";
      if (c.family.includes(t!.id)) return "they're family";
      const mine = inCouple(c);
      if (mine) return mine === t!.id ? "they're already together" : "they're with someone else";
      if (world.time - (c.cooldowns[`askout:${t!.id}`] ?? -1e9) < 5 * 1440) return "they asked only the other day";
      return null;
    }
    case "change_goal":
      if (!a.goal) return "which goal?";
      return (c.society?.goals ?? []).some((g) => g.status === "active" && g.kind === a.goal && g.who === a.target) ? "that's already what they're aiming for" : null;
    case "start_project":
      if (!a.project) return "which plan?";
      if ((c.society?.projects ?? []).some((p) => p.status === "active" && p.kind === a.project)) return "they've already got a plan like that going";
      return canStart(world, c, a.project, a.target);
  }
}

/** Something to go and have out with someone in conversation. */
function addIntent(world: WorldState, c: Citizen, d: AgentDecision, it: Omit<Intent, "decision" | "until">): void {
  const s = societyOf(world, c);
  s.intents = s.intents.filter((x) => !(x.topic === it.topic && x.target === it.target));
  s.intents.push({ ...it, decision: d.id, until: world.time + SOCIETY.intentMinutes });
  if (s.intents.length > SOCIETY.intentsKept) {
    const dropped = s.intents.shift()!;
    settleDecision(c, dropped.decision, "expired", "Something else came up first.");
  }
}

/**
 * Carry out a checked action. Things done in conversation become an
 * intention (they'll go and find the person; the decision is settled when
 * the conversation ends); things done directly happen now. Returns what
 * happened, in words, for the decision log and the agent's memory.
 */
export function carryOut(world: WorldState, c: Citizen, a: AgentAction, d: AgentDecision): string {
  const t = a.target ? world.citizens[a.target] : null;
  const s = societyOf(world, c);
  const later = (topic: string, params: Intent["params"], urgency: number, what: string) => {
    addIntent(world, c, d, { topic, target: t!.id, params, urgency, reason: a.reason });
    d.status = "pending";
    d.result = what;
    return what;
  };
  switch (a.type) {
    case "carry_on":
      settleDecision(c, d.id, "done", "Carried on with the day.");
      return "Carried on with the day.";
    case "talk":
      return later("chat", { purpose: a.text ?? "", about: a.about ?? null }, 0.62, `Going to find ${t!.name} to talk${a.text ? ` about ${a.text}` : ""}.`);
    case "seek_work": {
      if (t) {
        const biz = openBizOf(world, t)!;
        return later("ask_job", { businessId: biz.id }, 0.7, `Going to ask ${t.name} for a job at ${biz.name}.`);
      }
      // No one to ask: CityCorp, next chance they get (the utility AI's job hunt, weighted up).
      c.cooldowns.jobHunt = -1e9;
      s.intents.push({ decision: d.id, topic: "activity:job_hunt", target: c.id, params: {}, urgency: 0.8, reason: a.reason, until: world.time + SOCIETY.intentMinutes });
      d.status = "pending";
      d.result = corpOpenings(world) > 0 ? "Going to apply at CityCorp (they're hiring)." : "Going to try CityCorp (they say they're not hiring).";
      return d.result;
    }
    case "propose_deal": {
      switch (a.deal) {
        case "loan":
          return later("ask_loan", { amount: Math.max(20, Math.min(300, a.amount ?? 50)), purpose: a.text || "get by" }, 0.75, `Going to ask ${t!.name} for a loan of ${money(Math.max(20, Math.min(300, a.amount ?? 50)))}.`);
        case "investment": {
          const biz = openBizOf(world, c)!;
          return later("pitch_investment", { businessId: biz.id, amount: Math.max(30, Math.min(400, a.amount ?? 120)) }, 0.65, `Going to pitch ${biz.name} to ${t!.name}.`);
        }
        case "job_offer": {
          const biz = openBizOf(world, c)!;
          if (biz.hiringWage <= 0 && !needsStaff(world, biz)) biz.hiringWage = Math.round(world.economy.corpWage * 0.8);
          return later("offer_job", { businessId: biz.id }, 0.65, `Going to offer ${t!.name} a job at ${biz.name}.`);
        }
        case "job_ask": {
          const biz = openBizOf(world, t!)!;
          return later("ask_job", { businessId: biz.id }, 0.7, `Going to ask ${t!.name} for a job at ${biz.name}.`);
        }
        case "sale": {
          const biz = openBizOf(world, t!)!;
          const pid = Object.entries(c.inventory).find(([p, it]) => it.qty > 0 && biz.products.includes(p))![0];
          return later("sell_stock", { businessId: biz.id, productId: pid }, 0.6, `Going to offer ${t!.name} some ${world.products[pid]?.name.toLowerCase() ?? "stock"}.`);
        }
        case "partnership": {
          const pr = s.projects.find((p) => p.status === "active" && p.need > p.raised)!;
          return later("recruit", { projectId: pr.id, amount: Math.max(20, Math.min(pr.need - pr.raised, a.amount ?? pr.need - pr.raised)) }, 0.7, `Going to ask ${t!.name} to come in on the plan to ${pr.title.toLowerCase()}.`);
        }
      }
      return "Nothing came of it.";
    }
    case "lend":
      return later("offer_loan", { amount: a.amount ?? 30 }, 0.6, `Going to offer ${t!.name} a loan of ${money(a.amount ?? 30)}.`);
    case "help":
      return later("offer_help", { amount: a.amount ?? 20 }, 0.6, `Going to give ${t!.name} ${money(a.amount ?? 20)}.`);
    case "confront":
      return later("argue", { reason: a.text || "I haven't forgotten what you did." }, 0.6, `Going to have it out with ${t!.name}.`);
    case "make_up":
      return later("make_peace", {}, 0.6, `Going to try and make up with ${t!.name}.`);
    case "ask_out":
      s.crush = { who: t!.id, since: world.time, stage: "interested" };
      return later("ask_out", {}, 0.55, `Working up the nerve to ask ${t!.name} out.`);
    case "spread_rumour":
      return startRumour(world, c, a, d);
    case "compete":
      return undercut(world, c, t!, d);
    case "change_goal": {
      const g = addGoal(world, c, { kind: a.goal!, text: a.text || goalText(a.goal!), why: a.reason, priority: 0.85, source: d.source, ...(t ? { who: t.id } : {}) });
      remember(world, c, { text: `I've decided: ${g.text.replace(/^./, (x) => x.toLowerCase())}.`, kind: "insight", importance: 5, valence: 0.3, people: t ? [t.id] : [] });
      settleDecision(c, d.id, "done", `New aim: ${g.text}.`);
      return `New aim: ${g.text}.`;
    }
    case "start_project": {
      const pr = startProject(world, c, a.project!, d.source, t?.id, a.text);
      if (!pr) {
        settleDecision(c, d.id, "failed", "Couldn't see how to start it.");
        return "Couldn't see how to start it.";
      }
      settleDecision(c, d.id, "done", `Started a plan: ${pr.title}.`);
      return `Started a plan: ${pr.title}.`;
    }
  }
}

/**
 * A rumour, started on purpose. The world keeps a note of whether it's true
 * (the people who hear it don't know); it goes round by ordinary gossip, and
 * people who believe it think less of whoever it's about.
 */
function startRumour(world: WorldState, c: Citizen, a: AgentAction, d: AgentDecision): string {
  const about = world.citizens[a.about!];
  const sw = societyWorld(world);
  // True if they already knew it as fact (from someone who'd know); a made-up story otherwise.
  const known = (c.talk?.facts ?? []).find((f) => f.about === about.id && f.certainty >= 0.7 && cuesOf(a.text!, [about.name]).some((w) => f.cues.includes(w)));
  const id = newId(world);
  const text = new RegExp(`^${about.name}\\b`).test(a.text!) ? a.text! : `${about.name}: ${a.text!}`;
  pushRing(sw.rumours, { id, t: world.time, origin: c.id, about: about.id, text, truth: known ? true : false, heard: 0 }, SOCIETY.rumoursKept);
  learn(world, c, { about: about.id, pred: "said", key: `rumour:${id}`, text: text.replace(new RegExp(`^${about.name}: `), `${about.name} `), source: "inferred", origin: c.id, certainty: 0.95, sensitivity: 0.35, valence: -0.6, importance: 7, rumour: id });
  remember(world, c, { text: `I've started telling people that ${text.replace(new RegExp(`^${about.name}: `), `${about.name} `).replace(/\.$/, "")}.`, kind: "social", importance: 4, valence: 0, people: [about.id] });
  settleDecision(c, d.id, "done", `Started telling people about ${about.name}${known ? "" : " (it isn't true)"}.`);
  return `Started telling people about ${about.name}.`;
}

/** A price war: their own prices on what both sell, cut below the rival's (never below cost). */
function undercut(world: WorldState, c: Citizen, rival: Citizen, d: AgentDecision): string {
  const mine = openBizOf(world, c)!;
  const theirs = openBizOf(world, rival)!;
  const cut: string[] = [];
  for (const pid of mine.products.filter((p) => theirs.products.includes(p))) {
    const target = Math.min(mine.prices[pid] ?? 0, (theirs.prices[pid] ?? mine.prices[pid] ?? 0) * 0.93);
    const floor = priceFloor(world, mine, c, pid);
    const price = round2(Math.max(floor, target));
    if (price < (mine.prices[pid] ?? 0) - 0.01) {
      mine.prices[pid] = price;
      cut.push(`${world.products[pid]?.name.toLowerCase() ?? pid} to ${money(price)}`);
    }
  }
  mine.lastPriceChangeT = world.time;
  if (!cut.length) {
    settleDecision(c, d.id, "failed", "Couldn't go any cheaper without losing money.");
    return "Couldn't go any cheaper without losing money.";
  }
  addRole(c, rival.id, "rival");
  addRole(rival, c.id, "rival");
  adjustRel(world, rival, c.id, { affinity: -6 });
  remember(world, rival, { text: `${c.name} has started undercutting ${theirs.name}.`, kind: "business", importance: 6, valence: -0.5, people: [c.id], feel: { anger: 15 } });
  logEvent(world, "business", `⚔️ ${c.name} cut prices at ${mine.name} to undercut ${rival.name}'s ${theirs.name} (${cut.join(", ")}).`, 3, [c.id, rival.id]);
  settleDecision(c, d.id, "done", `Cut prices at ${mine.name}: ${cut.join(", ")}.`);
  return `Cut prices at ${mine.name}: ${cut.join(", ")}.`;
}
