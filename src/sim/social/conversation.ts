import { interruptActivity, makeAction, registerAction } from "../ai/actions";
import { hearStory } from "../ai/beliefs";
import { setThought } from "../ai/decision";
import { situation } from "../ai/situation";
import { getBuildingIndexed } from "../city/lookup";
import { createPeerLoan, ensureCash, outstanding, repay } from "../economy/bank";
import { addPartner, openBusinesses } from "../economy/business";
import { hireAtBusiness } from "../economy/jobs";
import { citizenAcc, creditOccupation, transfer } from "../economy/ledger";
import { addStock, removeStock } from "../economy/market";
import { logEvent } from "../events";
import { placeName } from "../places";
import { remember, rememberBetrayal } from "../memory/memory";
import { feel, feelingsToward, recallPerson } from "../mind/emotions";
import { voiceConversation } from "../mind/voice";
import { chance, rand, type RngHolder } from "../rng";
import { dayOf } from "../time";
import type { Citizen, Conversation, ConversationTopic, ConvValue, EventCategory, Loan, WorldState } from "../types";
import { clamp, money, newId, pct, pushRing, round2 } from "../util";
import { argueDialogue, chatDialogue, helpDialogue, investDialogue, jobDialogue, loanDialogue, repaymentDialogue, tipDialogue } from "./dialogue";
import { compatibility } from "./encounters";
import { helpTerms, investmentTerms, jobTerms, loanTerms, lookWealthy as lookWealthyRaw, MAX_STAFF, settleLoan } from "./negotiation";
import { adjustRel, getRel, peekRel } from "./relationships";

// Conversations. Citizens have agendas (need a loan, want a job, want their
// money back...). When they meet the right person — by chance, or by going
// to find them — they talk. The engine works out the real limits of the
// deal; the words come from templates or, when enabled, from Claude. The
// outcome is then validated and applied: money moves, jobs change hands,
// memories and relationships update.

export const LINE_MINUTES = 6;
const CONVERSATION_LOG_LIMIT = 80;

export interface Agenda {
  topic: ConversationTopic;
  targetId: string;
  urgency: number;
  params: Record<string, ConvValue>;
  reason: string;
}

// -------------------------------------------------------------- helpers

export function canTalk(world: WorldState, c: Citizen): boolean {
  if (!c.insideId || c.path.length > 0) return false;
  const k = c.activity.kind;
  if (k === "sleep" || k === "talk" || k === "travel") return false;
  return !world.conversations.some((x) => x.a === c.id || x.b === c.id);
}

function isPublic(world: WorldState, buildingId: string | null): boolean {
  const b = getBuildingIndexed(world.map, buildingId);
  return !!b && b.type !== "house" && b.type !== "apartments";
}

function asked(world: WorldState, c: Citizen, key: string, days = 2): boolean {
  return world.time - (c.cooldowns[key] ?? -1e9) < days * 1440;
}

function known(c: Citizen, o: Citizen): boolean {
  const r = c.relationships[o.id];
  return c.family.includes(o.id) || (!!r && r.familiarity >= 12);
}

// -------------------------------------------------------------- agendas

/** What does this citizen want from other people right now? Most urgent first. */
export function agendasFor(world: WorldState, c: Citizen): Agenda[] {
  const s = situation(world, c);
  const out: Agenda[] = [];
  const others = world.citizenOrder.filter((id) => id !== c.id).map((id) => world.citizens[id]);
  // Net worth is costly; nothing changes while we plan, so work it out once per person.
  const worthCache = new Map<string, number>();
  const lookWealthy = (_w: WorldState, o: Citizen): number => {
    let v = worthCache.get(o.id);
    if (v === undefined) worthCache.set(o.id, (v = lookWealthyRaw(world, o)));
    return v;
  };

  // Money trouble: ask someone for a loan.
  const short = Math.max(s.rent + c.rentArrears + s.dailyCost * 2 - s.liquid, 0);
  if ((s.pressure >= 0.7 && short > 10) || (c.homeless && s.liquid < 60)) {
    const amount = Math.max(30, Math.ceil(short / 10) * 10);
    let best: { o: Citizen; score: number } | null = null;
    for (const o of others) {
      if (!known(c, o) || asked(world, c, `ask:${o.id}`)) continue;
      if (world.loans.some((l) => l.lender === o.id && l.borrower === c.id && l.status === "active")) continue;
      const r = getRel(c, o.id);
      const score = (r.affinity + r.trust) / 200 + (c.family.includes(o.id) ? 0.5 : 0) + Math.min(1, lookWealthy(world, o) / (amount * 4));
      if (!best || score > best.score) best = { o, score };
    }
    if (best) out.push({ topic: "ask_loan", targetId: best.o.id, urgency: 0.55 + s.pressure * 0.35, params: { amount, purpose: c.homeless ? "find somewhere to live" : "cover the rent" }, reason: s.worry ?? "I need money" });
  }

  // Desperate: ask family or a close friend for help.
  if (s.liquid < 12 && (c.needs.hunger < 45 || c.homeless)) {
    const helper = others.filter((o) => (c.family.includes(o.id) || (c.relationships[o.id]?.affinity ?? 0) > 40) && !asked(world, c, `help:${o.id}`, 1)).sort((a, b) => lookWealthy(world, b) - lookWealthy(world, a))[0];
    if (helper) out.push({ topic: "ask_help", targetId: helper.id, urgency: 0.9, params: {}, reason: "I'm broke and hungry" });
  }

  // Business owners low on cash: pitch an investor.
  for (const bid of c.businessIds) {
    const b = world.businesses[bid];
    if (!b || !b.open || b.ownerId !== c.id || b.cash > 70 || b.avgProfit < 5 || b.history.length < 2) continue;
    const investor = others
      .filter((o) => known(c, o) && !asked(world, c, `pitch:${o.id}`, 3) && !b.partners.some((p) => p.citizenId === o.id) && o.money + o.savings > 200)
      .sort((x, y) => lookWealthy(world, y) - lookWealthy(world, x))[0];
    if (investor) out.push({ topic: "pitch_investment", targetId: investor.id, urgency: 0.45 + c.traits.ambition * 0.25, params: { businessId: b.id, amount: Math.round(80 + c.traits.ambition * 120) }, reason: `${b.name} needs capital` });
  }

  // Looking for work: ask business owners you know.
  const ownsBusiness = c.businessIds.some((id) => world.businesses[id]?.open);
  if (!ownsBusiness && (c.occupation === "unemployed" || (s.pressure > 0.6 && s.occEarnAvg < 25 && c.occupation !== "employee"))) {
    for (const b of openBusinesses(world)) {
      const owner = world.citizens[b.ownerId];
      if (!owner || owner.id === c.id || !known(c, owner) || asked(world, c, `askjob:${b.id}`, 2)) continue;
      if (b.hiringWage <= 0 && b.avgProfit < 40) continue;
      if (b.employees.length >= (MAX_STAFF[b.kind] ?? 1)) continue;
      out.push({ topic: "ask_job", targetId: owner.id, urgency: 0.45 + s.pressure * 0.35, params: { businessId: b.id }, reason: "I need a job" });
    }
  }

  // Hiring: offer a job to someone suitable you know.
  for (const bid of c.businessIds) {
    const b = world.businesses[bid];
    if (!b || !b.open || b.ownerId !== c.id || b.hiringWage <= 0) continue;
    for (const o of others) {
      if (!known(c, o) || asked(world, c, `offer:${o.id}`, 2) || o.businessIds.some((x) => world.businesses[x]?.open)) continue;
      const theirPay = o.occupation === "employee" ? o.wage : o.occupation === "unemployed" ? 0 : situation(world, o).occEarnAvg;
      if (theirPay > b.hiringWage * 0.95) continue;
      out.push({ topic: "offer_job", targetId: o.id, urgency: 0.5, params: { businessId: b.id }, reason: `${b.name} needs staff` });
    }
  }

  // Overdue debts: chase them.
  for (const l of world.loans) {
    if (l.lender !== c.id || l.status !== "active" || world.time < l.dueT || asked(world, c, `chase:${l.borrower}`, 1)) continue;
    out.push({ topic: "demand_repayment", targetId: l.borrower, urgency: 0.6 + c.traits.greed * 0.2, params: { loanId: l.id }, reason: "they owe me money" });
  }

  // Resellers: sell stock straight to shops that carry it.
  if (c.occupation === "reseller") {
    for (const [pid, it] of Object.entries(c.inventory)) {
      if (it.qty <= 0 || pid === "food") continue;
      const biz = openBusinesses(world).find((b) => b.products.includes(pid) && b.cash > it.avgCost * 2 && b.ownerId !== c.id && !asked(world, c, `sell:${b.ownerId}`, 1));
      if (biz && it.avgCost < world.market[pid].wholesale * 0.85) {
        out.push({ topic: "sell_stock", targetId: biz.ownerId, urgency: 0.4 + c.traits.sociability * 0.15, params: { businessId: biz.id, productId: pid }, reason: `I could sell my ${world.products[pid].name.toLowerCase()} to ${biz.name}` });
        break;
      }
    }
  }

  // Research tips: share (or sell) them with friends in business.
  for (const ins of c.beliefs.insights) {
    if (ins.source !== "own" || ins.startT < world.time) continue;
    const friend = others.find(
      (o) =>
        (c.relationships[o.id]?.affinity ?? 0) > 25 &&
        ["trader", "shopkeeper", "entrepreneur", "reseller"].includes(o.occupation) &&
        !o.beliefs.insights.some((x) => x.productId === ins.productId && x.startT === ins.startT) &&
        !asked(world, c, `tip:${o.id}:${ins.productId}`, 5),
    );
    if (friend) out.push({ topic: "share_tip", targetId: friend.id, urgency: 0.35 + c.traits.sociability * 0.2, params: { productId: ins.productId, startT: ins.startT }, reason: "I know something valuable" });
  }

  return out.sort((a, b) => b.urgency - a.urgency);
}

// ------------------------------------------------------- topic handlers

interface Prepared {
  terms: Record<string, ConvValue>;
  lines: Conversation["lines"];
  outcome: Record<string, ConvValue>;
  /** £ at stake, for deciding whether Claude should voice it. */
  stakes: number;
  /** Constraint text for the LLM. */
  brief: string;
}

interface News {
  text: string;
  cat: EventCategory;
  importance: number;
}
const news = (text: string, cat: EventCategory, importance: number): News => ({ text, cat, importance });

interface TopicHandler {
  prepare(world: WorldState, conv: Conversation, a: Citizen, b: Citizen, r: RngHolder): Prepared | null;
  /** Validate an outcome (from AI or template) against the engine's terms. Returns the safe version. */
  validate(conv: Conversation, raw: Record<string, ConvValue>): Record<string, ConvValue>;
  /** Apply the outcome; return the news item for the event feed (or null). */
  apply(world: WorldState, conv: Conversation, a: Citizen, b: Citizen): News | null;
  /** JSON schema of the outcome object for the LLM. */
  schema: Record<string, unknown>;
}

const num = (v: ConvValue | undefined, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const bool = (v: ConvValue | undefined): boolean => v === true;

const OUTCOME_AGREED = { agreed: { type: "boolean" } };

const handlers: Record<ConversationTopic, TopicHandler> = {
  ask_loan: {
    schema: { ...OUTCOME_AGREED, amount: { type: "number" }, rate: { type: "number" }, days: { type: "integer" } },
    prepare(world, conv, a, b, r) {
      const t = loanTerms(world, a, b, num(conv.agenda.amount, 50), String(conv.agenda.purpose ?? "get by"));
      const o = settleLoan(t);
      return {
        terms: { requested: t.requested, purpose: t.purpose, willing: t.willing, maxLend: t.maxLend, minRate: t.minRate, maxRate: t.maxRate, days: t.days, why: t.why },
        lines: loanDialogue(r, world, a, b, t, o),
        outcome: { agreed: o.agreed, amount: o.amount, rate: o.rate, days: o.days },
        stakes: t.requested,
        brief:
          `A asks B to lend £${t.requested} to ${t.purpose}. ` +
          (t.willing
            ? `B is open to it because ${t.why}. If B lends: amount between £10 and £${t.maxLend}; B wants at least ${pct(t.minRate)} interest; A will accept at most ${pct(t.maxRate)}; repay within ${t.days} days. They may also fail to agree.`
            : `B will NOT lend (because ${t.why}). Outcome must be agreed=false.`) +
          ` rate is a fraction (0.15 = 15%).`,
      };
    },
    validate(conv, raw) {
      const t = conv.terms;
      if (!bool(raw.agreed) || !bool(t.willing)) return { agreed: false, amount: 0, rate: 0, days: num(t.days, 7) };
      const minRate = num(t.minRate);
      const maxRate = num(t.maxRate);
      if (minRate > maxRate + 1e-9) return { agreed: false, amount: 0, rate: 0, days: num(t.days, 7) };
      const amount = Math.floor(clamp(num(raw.amount, num(t.maxLend)), 10, num(t.maxLend)));
      const rate = round2(clamp(num(raw.rate, minRate), minRate, maxRate));
      const days = Math.round(clamp(num(raw.days, num(t.days, 7)), 3, 14));
      return amount >= 10 ? { agreed: true, amount, rate, days } : { agreed: false, amount: 0, rate: 0, days };
    },
    apply(world, conv, a, b) {
      const o = conv.outcome!;
      a.cooldowns[`ask:${b.id}`] = world.time;
      const llm = conv.source === "llm" ? "llm" : "utility";
      if (bool(o.agreed)) {
        if (!ensureCash(b, num(o.amount))) {
          conv.summary = `${b.name} agreed to lend ${a.name} money but couldn't find the cash.`;
          return null;
        }
        const loan = createPeerLoan(world, b, a, num(o.amount), num(o.rate), num(o.days, 7), String(conv.terms.purpose ?? "get by"));
        if (!loan) return null;
        conv.summary = `${b.name} lent ${a.name} ${money(loan.principal)} at ${pct(loan.rate)} to ${loan.purpose}.`;
        setThought(world, a, `${b.name} came through with ${money(loan.principal)}. I owe ${money(loan.totalDue)} by Day ${dayOf(loan.dueT)}.`, 3, llm);
        return news(`💸 ${a.name} borrowed ${money(loan.principal)} from ${b.name} at ${pct(loan.rate)} interest (to ${loan.purpose}).`, "finance", 4);
      }
      conv.summary = `${b.name} turned down ${a.name}'s request for ${money(num(conv.terms.requested))}.`;
      remember(world, a, { text: `${b.name} wouldn't lend me money when I needed it.`, kind: "social", importance: 5, valence: -0.5, people: [b.id], key: `refused:${b.id}` });
      adjustRel(world, a, b.id, { affinity: -3 });
      setThought(world, a, `${b.name} said no. Who else can I ask?`, 3, llm);
      return news(`🙅 ${a.name} asked ${b.name} for ${money(num(conv.terms.requested))} — ${b.name} said no.`, "social", 3);
    },
  },

  pitch_investment: {
    schema: { ...OUTCOME_AGREED, amount: { type: "number" }, share: { type: "number" } },
    prepare(world, conv, a, b, r) {
      const biz = world.businesses[String(conv.agenda.businessId)];
      if (!biz || !biz.open) return null;
      const t = investmentTerms(world, a, b, biz, num(conv.agenda.amount, 100));
      const agreed = t.willing && t.minShare <= t.maxShare;
      const share = agreed ? round2((t.minShare + t.maxShare) / 2) : 0;
      return {
        terms: { businessId: biz.id, business: biz.name, willing: t.willing, amount: t.amount, minShare: t.minShare, maxShare: t.maxShare, why: t.why },
        lines: investDialogue(r, a, b, biz.name, t, { agreed, amount: t.amount, share }),
        outcome: { agreed, amount: agreed ? t.amount : 0, share },
        stakes: t.amount,
        brief: t.willing
          ? `A pitches B to invest in A's business "${biz.name}" (profit ~£${Math.round(biz.avgProfit)}/day). B could invest up to £${t.amount}. B wants at least ${pct(t.minShare)} of profits; A will give at most ${pct(t.maxShare)}. share is a fraction. They may also not agree.`
          : `A pitches B to invest in "${biz.name}". B will NOT invest (${t.why}). Outcome must be agreed=false.`,
      };
    },
    validate(conv, raw) {
      const t = conv.terms;
      if (!bool(raw.agreed) || !bool(t.willing) || num(t.minShare) > num(t.maxShare)) return { agreed: false, amount: 0, share: 0 };
      const amount = Math.floor(clamp(num(raw.amount, num(t.amount)), 20, num(t.amount)));
      const share = round2(clamp(num(raw.share, num(t.minShare)), num(t.minShare), num(t.maxShare)));
      return { agreed: true, amount, share };
    },
    apply(world, conv, a, b) {
      const o = conv.outcome!;
      a.cooldowns[`pitch:${b.id}`] = world.time;
      const biz = world.businesses[String(conv.terms.businessId)];
      if (bool(o.agreed) && biz && biz.open && ensureCash(b, num(o.amount)) && addPartner(world, biz, b, num(o.amount), num(o.share))) {
        conv.summary = `${b.name} invested ${money(num(o.amount))} in ${biz.name} for ${pct(num(o.share))}.`;
        remember(world, b, { text: `I invested ${money(num(o.amount))} in ${biz.name} (${a.name}'s business).`, kind: "deal", importance: 7, valence: 0.5, people: [a.id] });
        remember(world, a, { text: `${b.name} invested ${money(num(o.amount))} in ${biz.name}.`, kind: "deal", importance: 7, valence: 0.8, people: [b.id] });
        adjustRel(world, a, b.id, { affinity: 10, trust: 8 });
        return news(`🤝 ${b.name} invested ${money(num(o.amount))} in ${biz.name} for ${pct(num(o.share))} of the profits. ${a.name} and ${b.name} are now business partners.`, "finance", 4);
      }
      conv.summary = `${b.name} passed on investing in ${String(conv.terms.business)}.`;
      return news(`${a.name} pitched ${String(conv.terms.business)} to ${b.name}, who passed.`, "business", 2);
    },
  },

  ask_job: {
    schema: { ...OUTCOME_AGREED, wage: { type: "number" } },
    prepare(world, conv, a, b, r) {
      const biz = world.businesses[String(conv.agenda.businessId)];
      if (!biz || !biz.open || biz.ownerId !== b.id) return null;
      const t = jobTerms(world, b, a, biz);
      const agreed = t.willing && t.minWage <= t.maxWage;
      const wage = Math.round(agreed ? (t.minWage + t.maxWage) / 2 : t.maxWage);
      return {
        terms: { businessId: biz.id, business: biz.name, willing: t.willing, minWage: t.minWage, maxWage: t.maxWage, why: t.why },
        lines: jobDialogue(r, a, b, biz.name, true, t, { agreed, wage }),
        outcome: { agreed, wage },
        stakes: wage * 7,
        brief: t.willing
          ? `A asks B (owner of "${biz.name}") for a job. B can pay at most £${t.maxWage}/day; A wants at least £${t.minWage}/day. They may agree on a daily wage in between, or not.`
          : `A asks B (owner of "${biz.name}") for a job. B will NOT hire A (${t.why}). Outcome must be agreed=false.`,
      };
    },
    validate(conv, raw) {
      const t = conv.terms;
      if (!bool(raw.agreed) || !bool(t.willing) || num(t.minWage) > num(t.maxWage)) return { agreed: false, wage: 0 };
      return { agreed: true, wage: Math.round(clamp(num(raw.wage, num(t.minWage)), num(t.minWage), num(t.maxWage))) };
    },
    apply(world, conv, a, b) {
      a.cooldowns[`askjob:${String(conv.terms.businessId)}`] = world.time;
      const biz = world.businesses[String(conv.terms.businessId)];
      if (bool(conv.outcome!.agreed) && biz && biz.open) {
        hireAtBusiness(world, a, biz.id, num(conv.outcome!.wage));
        conv.summary = `${b.name} hired ${a.name} at ${biz.name} for ${money(num(conv.outcome!.wage))}/day.`;
        return null; // hireAtBusiness reports the hire
      }
      conv.summary = `${b.name} couldn't offer ${a.name} a job.`;
      return news(`${a.name} asked ${b.name} for a job at ${String(conv.terms.business)} — no luck.`, "job", 2);
    },
  },

  offer_job: {
    schema: { ...OUTCOME_AGREED, wage: { type: "number" } },
    prepare(world, conv, a, b, r) {
      const biz = world.businesses[String(conv.agenda.businessId)];
      if (!biz || !biz.open || biz.ownerId !== a.id) return null;
      const t = jobTerms(world, a, b, biz);
      const max = Math.max(t.maxWage, biz.hiringWage);
      const agreed = t.willing && t.minWage <= max;
      const wage = Math.round(agreed ? Math.max(biz.hiringWage, t.minWage) : biz.hiringWage);
      return {
        terms: { businessId: biz.id, business: biz.name, willing: t.willing, minWage: t.minWage, maxWage: max, why: t.why },
        lines: jobDialogue(r, b, a, biz.name, false, t, { agreed, wage }),
        outcome: { agreed, wage },
        stakes: wage * 7,
        brief: `A (owner of "${biz.name}") offers B a job. A can pay at most £${max}/day; B wants at least £${t.minWage}/day. B accepts only if the wage is at least that.`,
      };
    },
    validate(conv, raw) {
      const t = conv.terms;
      if (!bool(raw.agreed) || !bool(t.willing) || num(t.minWage) > num(t.maxWage)) return { agreed: false, wage: 0 };
      return { agreed: true, wage: Math.round(clamp(num(raw.wage, num(t.minWage)), num(t.minWage), num(t.maxWage))) };
    },
    apply(world, conv, a, b) {
      a.cooldowns[`offer:${b.id}`] = world.time;
      const biz = world.businesses[String(conv.terms.businessId)];
      if (bool(conv.outcome!.agreed) && biz && biz.open) {
        hireAtBusiness(world, b, biz.id, num(conv.outcome!.wage));
        conv.summary = `${b.name} accepted ${a.name}'s job offer at ${biz.name} (${money(num(conv.outcome!.wage))}/day).`;
        return null;
      }
      conv.summary = `${b.name} turned down a job at ${String(conv.terms.business)}.`;
      return news(`${b.name} turned down ${a.name}'s job offer at ${String(conv.terms.business)}.`, "job", 2);
    },
  },

  demand_repayment: {
    schema: { result: { type: "string", enum: ["paid", "partial", "promise", "refuse"] } },
    prepare(world, conv, a, b, r) {
      const l = world.loans.find((x) => x.id === num(conv.agenda.loanId));
      if (!l || l.status !== "active") return null;
      const owed = outstanding(l);
      const liquid = b.money + b.savings;
      const rel = getRel(b, a.id);
      const honesty = 0.55 + b.traits.generosity * 0.25 - b.traits.greed * 0.35 + (rel.affinity + rel.trust) / 400 + (b.family.includes(a.id) ? 0.3 : 0);
      const result = liquid >= owed + 5 && honesty > 0.3 ? "paid" : liquid > 25 && honesty > 0.3 ? "partial" : honesty > 0.3 ? "promise" : "refuse";
      const paid = result === "paid" ? owed : result === "partial" ? round2((liquid - 15) * 0.6) : 0;
      return {
        terms: { loanId: l.id, owed, canPay: liquid >= owed + 5, canPartial: liquid > 25, honest: honesty > 0.3 },
        lines: repaymentDialogue(r, a, b, owed, result, paid),
        outcome: { result },
        stakes: owed,
        brief: `A lent B money; B still owes £${owed} and it's overdue. B ${liquid >= owed + 5 ? "can afford to pay" : liquid > 25 ? "can pay part" : "is broke"}. B is ${honesty > 0.3 ? "basically honest" : "not inclined to pay"}. result must be one of paid/partial/promise/refuse${liquid >= owed + 5 ? "" : liquid > 25 ? " (not paid)" : " (not paid or partial)"}${honesty > 0.3 ? " (not refuse)" : ""}.`,
      };
    },
    validate(conv, raw) {
      const t = conv.terms;
      let result = typeof raw.result === "string" ? raw.result : "promise";
      if (!["paid", "partial", "promise", "refuse"].includes(result)) result = "promise";
      if (result === "paid" && !bool(t.canPay)) result = bool(t.canPartial) ? "partial" : "promise";
      if (result === "partial" && !bool(t.canPartial)) result = "promise";
      if (result === "refuse" && bool(t.honest)) result = bool(t.canPay) ? "paid" : "promise";
      return { result };
    },
    apply(world, conv, a, b) {
      a.cooldowns[`chase:${b.id}`] = world.time;
      const l = world.loans.find((x) => x.id === num(conv.terms.loanId)) as Loan | undefined;
      if (!l || l.status !== "active") return null;
      const res = String(conv.outcome!.result);
      if (res === "paid") {
        repay(world, l, outstanding(l));
        conv.summary = `${b.name} paid ${a.name} back.`;
        return null; // repay() reports it
      }
      if (res === "partial") {
        const paid = repay(world, l, round2(Math.max(0, (b.money + b.savings - 15) * 0.6)));
        l.dueT = world.time + 2 * 1440;
        conv.summary = `${b.name} paid ${a.name} ${money(paid)} and promised the rest.`;
        return news(`${a.name} chased ${b.name} for money — got ${money(paid)} and a promise.`, "finance", 2);
      }
      if (res === "promise") {
        l.dueT = world.time + 2 * 1440;
        adjustRel(world, a, b.id, { trust: -6 });
        conv.summary = `${b.name} asked ${a.name} for more time to repay.`;
        return news(`${a.name} chased ${b.name} for money; ${b.name} begged for more time.`, "finance", 2);
      }
      adjustRel(world, a, b.id, { affinity: -18, trust: -30 });
      adjustRel(world, b, a.id, { affinity: -8 });
      remember(world, a, { text: `${b.name} refused to pay back what they owe me.`, kind: "betrayal", importance: 8, valence: -0.9, people: [b.id], key: `betrayal:${b.id}` });
      conv.summary = `${b.name} refused to repay ${a.name}.`;
      return news(`😡 ${b.name} refused to repay ${a.name}.`, "social", 4);
    },
  },

  ask_help: {
    schema: { ...OUTCOME_AGREED, gift: { type: "number" } },
    prepare(world, conv, a, b, r) {
      const t = helpTerms(world, b, a);
      return {
        terms: { willing: t.willing, maxGift: t.gift },
        lines: helpDialogue(r, a, b, t.gift, t.willing),
        outcome: { agreed: t.willing, gift: t.willing ? t.gift : 0 },
        stakes: t.gift,
        brief: t.willing ? `A is broke and hungry and asks B for help. B is willing to give up to £${t.gift} as a gift.` : `A is broke and asks B for help. B will NOT give money. Outcome must be agreed=false.`,
      };
    },
    validate(conv, raw) {
      if (!bool(raw.agreed) || !bool(conv.terms.willing)) return { agreed: false, gift: 0 };
      return { agreed: true, gift: Math.round(clamp(num(raw.gift, num(conv.terms.maxGift)), 5, num(conv.terms.maxGift))) };
    },
    apply(world, conv, a, b) {
      a.cooldowns[`help:${b.id}`] = world.time;
      const gift = num(conv.outcome!.gift);
      if (bool(conv.outcome!.agreed) && gift > 0 && ensureCash(b, gift) && transfer(world, citizenAcc(b.id), citizenAcc(a.id), gift, "gift", `Help from ${b.name}`)) {
        remember(world, a, { text: `${b.name} gave me ${money(gift)} when I was broke.`, kind: "favor", importance: 7, valence: 0.9, people: [b.id], key: `help:${b.id}` });
        remember(world, b, { text: `I helped ${a.name} out with ${money(gift)}.`, kind: "favor", importance: 4, valence: 0.4, people: [a.id] });
        adjustRel(world, a, b.id, { affinity: 15, trust: 10 });
        adjustRel(world, b, a.id, { affinity: 4 });
        conv.summary = `${b.name} gave ${a.name} ${money(gift)}.`;
        return news(`💝 ${b.name} gave ${a.name} ${money(gift)} to help them out.`, "social", 3);
      }
      conv.summary = `${b.name} couldn't help ${a.name}.`;
      return news(`${a.name} asked ${b.name} for help, but ${b.name} couldn't spare anything.`, "social", 2);
    },
  },

  share_tip: {
    schema: { ...OUTCOME_AGREED, price: { type: "number" } },
    prepare(world, conv, a, b, r) {
      const pid = String(conv.agenda.productId);
      const ins = a.beliefs.insights.find((i) => i.productId === pid && i.startT === num(conv.agenda.startT));
      const p = world.products[pid];
      if (!ins || !p) return null;
      const rel = getRel(a, b.id);
      const price = a.traits.greed > 0.6 && rel.affinity < 60 ? Math.round(10 + a.traits.greed * 30) : 0;
      const bRel = getRel(b, a.id);
      const agreed = price === 0 || (b.money + b.savings > price * 3 && bRel.trust > -10 && chance(world, 0.5 + bRel.trust / 200));
      return {
        terms: { productId: pid, kind: ins.kind, startT: ins.startT, magnitude: ins.magnitude, price },
        lines: tipDialogue(r, a, b, p.name.toLowerCase(), ins.kind, price, agreed),
        outcome: { agreed, price },
        stakes: price,
        brief: `A has research showing ${p.name} demand will ${ins.kind === "hype" ? "boom" : "slump"} around Day ${dayOf(ins.startT)}. ${price ? `A wants £${price} for the tip; B decides whether to pay.` : "A shares it freely as a friend."}`,
      };
    },
    validate(conv, raw) {
      const price = num(conv.terms.price);
      return { agreed: price === 0 ? true : bool(raw.agreed), price };
    },
    apply(world, conv, a, b) {
      const t = conv.terms;
      a.cooldowns[`tip:${b.id}:${String(t.productId)}`] = world.time;
      const price = num(t.price);
      const p = world.products[String(t.productId)];
      if (!bool(conv.outcome!.agreed)) {
        conv.summary = `${b.name} wouldn't pay for ${a.name}'s tip.`;
        return null;
      }
      if (price > 0 && !(ensureCash(b, price) && transfer(world, citizenAcc(b.id), citizenAcc(a.id), price, "trade", `Tip about ${p?.name}`))) return null;
      b.beliefs.insights.push({ productId: String(t.productId), kind: t.kind === "slump" ? "slump" : "hype", startT: num(t.startT), magnitude: num(t.magnitude, 1.5), source: a.id });
      remember(world, b, { text: `${a.name} tipped me off: ${p?.name} will ${t.kind === "hype" ? "boom" : "slump"} soon.`, kind: "insight", importance: 6, valence: 0.6, people: [a.id] });
      adjustRel(world, b, a.id, { affinity: price ? 3 : 8, trust: 6 });
      conv.summary = price ? `${a.name} sold ${b.name} a tip about ${p?.name} for ${money(price)}.` : `${a.name} tipped ${b.name} off about ${p?.name}.`;
      return news(`🤫 ${a.name} ${price ? `sold ${b.name} a market tip for ${money(price)}` : `gave ${b.name} an inside tip`} about ${p?.emoji} ${p?.name}.`, "market", 3);
    },
  },

  sell_stock: {
    schema: { ...OUTCOME_AGREED, qty: { type: "integer" }, price: { type: "number" } },
    prepare(world, conv, a, b, r) {
      const biz = world.businesses[String(conv.agenda.businessId)];
      const pid = String(conv.agenda.productId);
      const it = a.inventory[pid];
      const p = world.products[pid];
      if (!biz || !biz.open || biz.ownerId !== b.id || !it || it.qty <= 0 || !p) return null;
      const depot = world.market[pid].wholesale;
      const maxPrice = round2(depot * (0.97 - b.traits.greed * 0.08));
      const minPrice = round2(Math.max(it.avgCost * (1.05 + a.traits.greed * 0.1), depot * 0.6));
      const qty = Math.min(it.qty, Math.max(1, Math.floor((biz.cash * 0.6) / Math.max(0.01, maxPrice))));
      const agreed = minPrice <= maxPrice && qty >= 1 && biz.cash >= minPrice;
      const price = round2((minPrice + maxPrice) / 2);
      const name = p.name.toLowerCase();
      const lines = [
        { speaker: a.id, text: `${b.name}, I've got ${qty} ${name} going cheap. Cheaper than the depot.` },
        { speaker: b.id, text: agreed ? `How cheap? The depot wants ${money(depot)} each.` : `I'm only interested below ${money(maxPrice)} each.` },
        { speaker: a.id, text: agreed ? `${money(price)} each. You save a trip and a few quid.` : `I can't go below ${money(minPrice)}.` },
        { speaker: b.id, text: agreed ? "Deal. Bring them round." : "Then no deal." },
      ];
      return {
        terms: { businessId: biz.id, productId: pid, qty, minPrice, maxPrice, depot },
        lines,
        outcome: { agreed, qty, price },
        stakes: qty * price,
        brief: `A (a reseller) offers B (owner of "${biz.name}") ${qty} ${name}. The depot charges £${depot} each. B will pay at most £${maxPrice} each; A wants at least £${minPrice} each. They may agree on a unit price in between, or not.`,
      };
    },
    validate(conv, raw) {
      const t = conv.terms;
      if (!bool(raw.agreed) || num(t.minPrice) > num(t.maxPrice)) return { agreed: false, qty: 0, price: 0 };
      return { agreed: true, qty: Math.round(clamp(num(raw.qty, num(t.qty)), 1, num(t.qty))), price: round2(clamp(num(raw.price, num(t.minPrice)), num(t.minPrice), num(t.maxPrice))) };
    },
    apply(world, conv, a, b) {
      const t = conv.terms;
      a.cooldowns[`sell:${b.id}`] = world.time;
      const biz = world.businesses[String(t.businessId)];
      const pid = String(t.productId);
      const o = conv.outcome!;
      if (!bool(o.agreed) || !biz || !biz.open) {
        conv.summary = `${b.name} didn't buy ${a.name}'s stock.`;
        return null;
      }
      const qty = Math.min(num(o.qty), a.inventory[pid]?.qty ?? 0, Math.floor(biz.cash / num(o.price)));
      if (qty <= 0) return null;
      const total = round2(qty * num(o.price));
      if (!transfer(world, `b:${biz.id}`, citizenAcc(a.id), total, "trade", `${qty}× ${world.products[pid].name} from ${a.name}`)) return null;
      const cost = removeStock(a.inventory, pid, qty);
      addStock(biz.inventory, pid, qty, num(o.price));
      creditOccupation(world, a.id, round2((num(o.price) - cost) * qty));
      adjustRel(world, b, a.id, { affinity: 3, trust: 3, familiarity: 3 });
      conv.summary = `${a.name} sold ${qty}× ${world.products[pid].name} to ${biz.name} at ${money(num(o.price))} each.`;
      return news(`📦 ${a.name} sold ${qty}× ${world.products[pid].emoji} ${world.products[pid].name.toLowerCase()} to ${b.name}'s ${biz.name} (cheaper than the depot).`, "business", 2);
    },
  },

  argue: {
    schema: {},
    prepare(world, conv, a, b, r) {
      const reason = String(conv.agenda.reason ?? "You know what you did.");
      return { terms: { reason }, lines: argueDialogue(r, a, b, reason), outcome: {}, stakes: 0, brief: `A confronts B: "${reason}". It's an argument; nobody backs down.` };
    },
    validate: () => ({}),
    apply(world, conv, a, b) {
      adjustRel(world, a, b.id, { affinity: -7 });
      adjustRel(world, b, a.id, { affinity: -9 });
      remember(world, b, { text: `${a.name} picked a fight with me.`, kind: "social", importance: 4, valence: -0.6, people: [a.id], key: `argue:${a.id}` });
      conv.summary = `${a.name} and ${b.name} had a row.`;
      return news(`💢 ${a.name} and ${b.name} had a heated argument at ${placeLabel(world, conv)}.`, "social", 3);
    },
  },

  chat: {
    schema: {},
    prepare(world, conv, a, b, r) {
      const news = (c: Citizen) => {
        const earn = c.finance.occupationEarnings.slice(-3);
        const avgEarn = earn.length ? earn.reduce((x, y) => x + y, 0) / earn.length : 0;
        const biz = c.businessIds.map((id) => world.businesses[id]).find((x) => x && x.open);
        if (biz && biz.avgProfit > 30) return `${biz.name} is doing great — about ${money(biz.avgProfit)} a day!`;
        if (biz && biz.avgProfit < 0) return `Honestly? ${biz.name} is struggling.`;
        if (avgEarn > 45) return `Really well actually. ${c.occupation === "reseller" ? "Flipping stuff" : c.occupation === "trader" ? "Trading" : "Work"} is bringing in ${money(avgEarn)} a day.`;
        if (c.occupation === "unemployed") return "Still looking for work. It's grim.";
        return null;
      };
      return { terms: {}, lines: chatDialogue(r, world, a, b, news(b), news(a)), outcome: {}, stakes: 0, brief: "A and B chat and swap news." };
    },
    validate: () => ({}),
    apply(world, conv, a, b) {
      // Gossip: they learn how each other are doing (fuel for imitation).
      for (const [teller, listener] of [
        [a, b],
        [b, a],
      ] as const) {
        const earn = teller.finance.occupationEarnings.slice(-3);
        const avgEarn = earn.length ? earn.reduce((x, y) => x + y, 0) / earn.length : 0;
        const biz = teller.businessIds.map((id) => world.businesses[id]).find((x) => x && x.open);
        const amount = biz ? biz.avgProfit : avgEarn;
        if (Math.abs(amount) > 5) hearStory(world, listener, { citizenId: teller.id, occupation: teller.occupation, productId: biz?.products[0] ?? null, amount: Math.round(amount), t: world.time }, teller.name);
        const compat = compatibility(listener, teller);
        adjustRel(world, listener, teller.id, { affinity: 1.5 + compat * 3, familiarity: 4, trust: 1 });
        listener.needs.social = clamp(listener.needs.social + 15, 0, 100);
      }
      conv.summary = `${a.name} and ${b.name} caught up.`;
      // Notable gossip is news: it's how success spreads (and gets copied).
      for (const [teller, listener] of [
        [a, b],
        [b, a],
      ] as const) {
        if (world.time - (teller.cooldowns.brag ?? -1e9) < 12 * 60) continue;
        const biz = teller.businessIds.map((id) => world.businesses[id]).find((x) => x && x.open);
        const earn0 = teller.finance.occupationEarnings.slice(-3);
        if ((biz && biz.avgProfit >= 40) || (earn0.length && earn0.reduce((x, y) => x + y, 0) / earn0.length >= 50)) teller.cooldowns.brag = world.time;
        if (biz && biz.avgProfit >= 40) return news(`💬 ${teller.name} told ${listener.name} that ${biz.name} makes about ${money(biz.avgProfit)} a day.`, "conversation", 1);
        const earn = teller.finance.occupationEarnings.slice(-3);
        const avgEarn = earn.length ? earn.reduce((x, y) => x + y, 0) / earn.length : 0;
        if (avgEarn >= 50) return news(`💬 ${teller.name} bragged to ${listener.name} about making ${money(avgEarn)} a day as a ${teller.occupation}.`, "conversation", 1);
      }
      return null;
    },
  },
};

function placeLabel(world: WorldState, conv: Conversation): string {
  return placeName(world, conv.buildingId);
}

// ------------------------------------------------------- lifecycle

export type ConversationAIHook = (world: WorldState, conv: Conversation, brief: string, schema: Record<string, unknown>, stakes: number) => boolean;
let aiHook: ConversationAIHook | null = null;
export function setConversationAIHook(h: ConversationAIHook | null): void {
  aiHook = h;
}

function lockIntoTalk(world: WorldState, c: Citizen, other: Citizen, convId: number): void {
  interruptActivity(world, c);
  c.pending = null;
  c.activity = {
    kind: "talk",
    label: `Talking with ${other.name}`,
    buildingId: c.insideId,
    startedAt: world.time,
    endsAt: world.time + 24 * 60,
    action: makeAction("TALK", c.insideId, 60, `Talking with ${other.name}`, { conversationId: convId, with: other.id }),
  };
}

export function startConversation(world: WorldState, a: Citizen, b: Citizen, topic: ConversationTopic, agenda: Record<string, ConvValue>): Conversation | null {
  if (!canTalk(world, a) || !canTalk(world, b) || a.insideId !== b.insideId) return null;
  const conv: Conversation = {
    id: newId(world),
    a: a.id,
    b: b.id,
    topic,
    buildingId: a.insideId,
    startedT: world.time,
    lines: [],
    revealed: 0,
    nextRevealT: world.time + 1,
    status: "talking",
    agenda,
    terms: {},
    outcome: null,
    fallback: null,
    summary: "",
    source: "template",
    endT: 0,
  };
  // Seeing each other brings back how they feel about each other.
  recallPerson(world, a, b.id);
  recallPerson(world, b, a.id);
  const prepared = handlers[topic].prepare(world, conv, a, b, world);
  if (!prepared) return null;
  prepared.lines = voiceConversation(conv.id, topic, a, b, prepared.lines, typeof prepared.outcome.agreed === "boolean" ? prepared.outcome.agreed : null, dayOf(world.time));
  conv.terms = prepared.terms;
  conv.fallback = { lines: prepared.lines, outcome: handlers[topic].validate(conv, prepared.outcome) };
  // Register first: interrupting their current activities must not start
  // another conversation (e.g. finishing a "go and find X" errand).
  world.conversations.push(conv);
  lockIntoTalk(world, a, b, conv.id);
  lockIntoTalk(world, b, a, conv.id);
  a.cooldowns.lastTalk = world.time;
  b.cooldowns.lastTalk = world.time;
  if (aiHook && aiHook(world, conv, prepared.brief, handlers[topic].schema, prepared.stakes)) {
    conv.status = "awaiting_ai";
    a.awaitingAI = true;
    return conv;
  }
  conv.lines = conv.fallback.lines;
  conv.outcome = conv.fallback.outcome;
  return conv;
}

/** Called by the AI director with Claude's reply (or null to use the template). */
export function resolveConversationAI(world: WorldState, convId: number, ai: { lines: Conversation["lines"]; outcome: Record<string, ConvValue> } | null): "ok" | "fallback" | "gone" {
  const conv = world.conversations.find((c) => c.id === convId);
  if (!conv || conv.status !== "awaiting_ai") return "gone";
  const a = world.citizens[conv.a];
  if (a) a.awaitingAI = false;
  conv.status = "talking";
  conv.nextRevealT = world.time + 1;
  if (!ai || ai.lines.length < 2) {
    conv.lines = conv.fallback!.lines;
    conv.outcome = conv.fallback!.outcome;
    return "fallback";
  }
  conv.lines = ai.lines.filter((l) => l.speaker === conv.a || l.speaker === conv.b).slice(0, 8);
  conv.outcome = handlers[conv.topic].validate(conv, ai.outcome);
  conv.source = "llm";
  return "ok";
}

function finish(world: WorldState, conv: Conversation): void {
  const a = world.citizens[conv.a];
  const b = world.citizens[conv.b];
  conv.status = "done";
  conv.endT = world.time;
  if (a && b && conv.outcome) {
    const item = handlers[conv.topic].apply(world, conv, a, b);
    if (item) logEvent(world, item.cat, item.text, item.importance, [a.id, b.id]).conversationId = conv.id;
    const agreed = conv.outcome.agreed;
    if (conv.topic !== "chat" && conv.summary) {
      const mem = conv.topic === "argue" ? -0.5 : agreed === false ? -0.2 : 0.3;
      // A "no" stings (and can rankle); a "yes" brings relief and gratitude.
      const felt = conv.topic === "argue" ? { anger: 5 } : agreed === false ? { sadness: 5, anger: 6, shame: 3 } : agreed ? { joy: 8, gratitude: 10, fear: -5 } : { joy: 3 };
      remember(world, a, { text: `Talked with ${b.name}: ${conv.summary}`, kind: "conversation", importance: 3, valence: mem, people: [b.id], feel: felt });
      if (conv.topic === "argue") {
        // Getting it off their chest takes the edge off; the other one is left fuming.
        feel(a, { anger: -12 });
        remember(world, b, { text: `${a.name} had a go at me.`, kind: "conversation", importance: 3, valence: -0.5, people: [a.id], key: `argued:${a.id}`, feel: { anger: 10 } });
      }
      else if (agreed) feel(b, { joy: 4, pride: 3 });
    } else if (conv.topic === "chat") {
      feel(a, { joy: 3, loneliness: -6 }, { social: true });
      feel(b, { joy: 3, loneliness: -6 }, { social: true });
    }
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      adjustRel(world, x, y.id, { familiarity: 3 });
      x.needs.social = clamp(x.needs.social + 10, 0, 100);
    }
  }
  for (const c of [a, b]) {
    if (!c) continue;
    if (c.activity.kind === "talk") c.activity.endsAt = world.time;
    c.awaitingAI = false;
  }
  world.conversations = world.conversations.filter((x) => x.id !== conv.id);
  pushRing(world.conversationLog, conv, CONVERSATION_LOG_LIMIT);
}

/** Every minute: reveal lines, end finished conversations. */
export function conversationsTick(world: WorldState): void {
  for (const conv of [...world.conversations]) {
    if (conv.status === "awaiting_ai") {
      // Safety net: never leave people frozen if the AI never answers.
      if (world.time - conv.startedT > 180) resolveConversationAI(world, conv.id, null);
      continue;
    }
    if (world.time < conv.nextRevealT) continue;
    if (conv.revealed < conv.lines.length) {
      conv.revealed++;
      conv.nextRevealT = world.time + LINE_MINUTES;
    } else {
      finish(world, conv);
    }
  }
}

// --------------------------------------------- who talks to whom, when

const ARGUE_COOLDOWN = 2 * 1440;
const TALKATIVE: Partial<Record<string, number>> = { socialize: 2, eat: 1.2, rest: 1, work: 0.5, manage: 0.6, browse: 0.8, shop: 0.6, trade: 0.5, research: 0.4 };

/** Every 10 minutes: people in the same place may strike up a conversation. */
export function startOpportunisticConversations(world: WorldState): void {
  const byPlace = new Map<string, Citizen[]>();
  for (const id of world.citizenOrder) {
    const c = world.citizens[id];
    if (!canTalk(world, c) || !isPublic(world, c.insideId)) continue;
    const list = byPlace.get(c.insideId!) ?? [];
    list.push(c);
    byPlace.set(c.insideId!, list);
  }
  for (const people of byPlace.values()) {
    if (people.length < 2) continue;
    for (const c of people) {
      if (!canTalk(world, c) || world.time - (c.cooldowns.lastTalk ?? -1e9) < 75) continue;
      const present = people.filter((o) => o.id !== c.id && canTalk(world, o));
      if (present.length === 0) continue;
      const presentIds = new Set(present.map((o) => o.id));
      const agenda = agendasFor(world, c).find((a) => presentIds.has(a.targetId));
      if (agenda && chance(world, Math.min(0.9, agenda.urgency))) {
        startConversation(world, c, world.citizens[agenda.targetId], agenda.topic, agenda.params);
        continue;
      }
      // Rivals, enemies and anyone nursing a grudge sometimes have it out
      // (the same two at most once every couple of days).
      const feuding = (o: Citizen) => {
        const r = peekRel(c, o.id);
        return !!r && (r.affinity < -40 || (r.roles.includes("rival") && r.affinity < 0)) && c.traits.competitiveness > 0.55;
      };
      const foe = present.find((o) => {
        if (!peekRel(c, o.id) || world.time - (c.cooldowns[`argue:${o.id}`] ?? -1e9) < ARGUE_COOLDOWN) return false;
        const f = feelingsToward(c, o.id);
        return feuding(o) || (f.anger ?? 0) > 35 || (f.envy ?? 0) > 40;
      });
      const feud = !!foe && feuding(foe);
      if (foe && chance(world, (feud ? 0.12 : 0.06) + (1 - c.mood / 100) * 0.1 + (c.emotions.anger / 100) * 0.15)) {
        const r = peekRel(c, foe.id)!;
        const g = feelingsToward(c, foe.id);
        c.cooldowns[`argue:${foe.id}`] = foe.cooldowns[`argue:${c.id}`] = world.time;
        const reason = rememberBetrayal(c, foe.id)
          ? "You still owe me money!"
          : r.roles.includes("rival")
            ? "You're stealing my customers with those cut-price deals."
            : (g.envy ?? 0) > (g.anger ?? 0)
              ? "Must be nice, raking it in while the rest of us scrape by."
              : "I haven't forgotten what you did.";
        startConversation(world, c, foe, "argue", { reason });
        continue;
      }
      // Small talk, mostly with people they know or like.
      const ctx = TALKATIVE[c.activity.kind] ?? 0.3;
      const lonely = (100 - c.needs.social) / 100;
      if (!chance(world, Math.min(0.6, 0.07 * ctx * (0.5 + c.traits.sociability + lonely)))) continue;
      const partner = [...present].sort((x, y) => (c.relationships[y.id]?.affinity ?? 0) + (c.relationships[y.id]?.familiarity ?? 0) - ((c.relationships[x.id]?.affinity ?? 0) + (c.relationships[x.id]?.familiarity ?? 0)))[rand(world) < 0.7 ? 0 : present.length - 1];
      startConversation(world, c, partner, "chat", {});
    }
  }
}

// ----------------------------------------------- going to find someone

export function registerConversationActions(): void {
  registerAction("TALK", { kind: "talk" });
  registerAction("MEET", {
    kind: "meet",
    complete(world, c, a) {
      const target = world.citizens[String(a.params.targetId)];
      if (!target) return;
      if (target.insideId === c.insideId && canTalk(world, target)) {
        const params = { ...a.params };
        delete params.targetId;
        delete params.topic;
        // The seeker is idle at this point, so they can start talking straight away.
        if (startConversation(world, c, target, String(a.params.topic) as ConversationTopic, params)) return;
      }
      setThought(world, c, `${target.name} wasn't there. I'll catch them later.`, 2);
      c.cooldowns[`miss:${target.id}`] = world.time;
    },
  });
}

/** Activity option: go and find the person you need to talk to. */
export function meetOptions(world: WorldState, c: Citizen): { target: Citizen; agenda: Agenda } | null {
  const h = (world.time % 1440) / 60;
  if (h < 8 || h >= 22) return null;
  for (const ag of agendasFor(world, c)) {
    if (ag.urgency < 0.5) break;
    const t = world.citizens[ag.targetId];
    if (!t || !t.insideId || !isPublic(world, t.insideId) || t.insideId === c.insideId) continue;
    if (t.activity.kind === "sleep" || world.time - (c.cooldowns[`miss:${t.id}`] ?? -1e9) < 180) continue;
    return { target: t, agenda: ag };
  }
  return null;
}

