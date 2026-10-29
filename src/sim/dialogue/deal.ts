import { MIN_OWNER_SHARE } from "../economy/business";
import { ownerShare } from "../economy/valuation";
import { rand } from "../rng";
import type { Citizen, Conversation, ConvValue, WorldState } from "../types";
import { money, pct, round2 } from "../util";
import { relView } from "./bonds";
import type { Directive } from "./plan";
import { profileOf } from "./profile";
import { rngFor } from "./topics";
import type { DealAction, DealState, DealTerms, DialogueState } from "./types";
import { pickFor } from "./voice";

// Deals, negotiated a turn at a time. Nothing is settled in advance: the one
// asking makes an offer, the other takes it, says no, or comes back with
// their own terms, and so on until one of them accepts or walks away. Each
// side goes by its own private limits (what it can afford, what it wants,
// how it feels about the other one), which only that side ever sees. A
// model speaking for someone may decide differently from those limits (be
// more generous, drive a harder bargain, say no to a friend); the world only
// holds it to what's actually possible: money they really have, stock that
// exists, a job that's really there.

type Side = "proposer" | "responder";

const n = (v: ConvValue | undefined, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const yes = (v: ConvValue | undefined): boolean => v === true;
const spare = (c: Citizen, keep = 15) => Math.max(0, Math.floor(c.money + c.savings - keep));

interface Spec {
  /** The fields this kind of deal haggles over. */
  fields: (keyof DealTerms)[];
  /** What the one asking opens with. */
  open(world: WorldState, conv: Conversation): DealTerms;
  /** Is the one being asked open to it at all? */
  willing(world: WorldState, conv: Conversation): boolean;
  /** Would this side take these terms (by its own private limits)? */
  ok(world: WorldState, conv: Conversation, side: Side, t: DealTerms): boolean;
  /** What this side would come back with (null: nothing they'd offer). */
  counter(world: WorldState, conv: Conversation, side: Side, t: DealTerms, own: DealTerms | null): DealTerms | null;
  /** The terms clamped to what can really happen (money, stock, room), or null if they can't. */
  possible(world: WorldState, conv: Conversation, t: DealTerms): DealTerms | null;
  /** What each side privately knows about its own position (for the model): never the other side's. */
  mine(world: WorldState, conv: Conversation, side: Side): string[];
  /** The deal in words, as the one asking would put it. */
  describe(world: WorldState, conv: Conversation, t: DealTerms): string;
}

const LOAN: Spec = {
  fields: ["amount", "rate", "days"],
  open: (world, conv) => ({ amount: n(conv.terms.requested, 30), days: n(conv.terms.days, 7) }),
  willing: (_w, conv) => yes(conv.terms.willing),
  ok(_w, conv, side, t) {
    const amount = t.amount ?? 0;
    if (side === "proposer") return (t.rate ?? 0) <= n(conv.terms.maxRate) + 1e-9 && amount >= Math.min(10, n(conv.terms.requested)) && amount >= n(conv.terms.requested) * 0.4;
    return yes(conv.terms.willing) && amount <= n(conv.terms.maxLend) + 1e-9 && (t.rate ?? 0) >= n(conv.terms.minRate) - 1e-9;
  },
  counter(_w, conv, side, t, own) {
    if (side === "responder") {
      if (!yes(conv.terms.willing)) return null;
      const amount = Math.floor(Math.min(t.amount ?? 0, n(conv.terms.maxLend)));
      if (amount < 10) return null;
      return { amount, rate: round2(Math.max(t.rate ?? 0, n(conv.terms.minRate))), days: Math.min(t.days ?? n(conv.terms.days, 7), n(conv.terms.days, 7)) };
    }
    // The borrower meets them halfway on the interest, up to what they can stand.
    const rate = round2(Math.min(n(conv.terms.maxRate), ((t.rate ?? 0) + (own?.rate ?? 0)) / 2));
    return rate < (t.rate ?? 0) - 0.004 ? { ...t, rate } : null;
  },
  possible(world, conv, t) {
    const lender = world.citizens[conv.b];
    const amount = Math.floor(Math.min(t.amount ?? 0, spare(lender)));
    if (amount < 10) return null;
    return { amount, rate: round2(Math.min(0.6, Math.max(0, t.rate ?? 0))), days: Math.round(Math.min(21, Math.max(2, t.days ?? 7))) };
  },
  mine(world, conv, side) {
    if (side === "proposer") return [`You need about ${money(n(conv.terms.requested))} to ${String(conv.terms.purpose ?? "get by")}.`, `You could stand up to ${pct(n(conv.terms.maxRate))} interest at a push, but you'd rather pay none.`];
    const lender = world.citizens[conv.b];
    return yes(conv.terms.willing)
      ? [`You could spare up to about ${money(n(conv.terms.maxLend))} (you have ${money(spare(lender))} you could lay hands on).`, `You'd want at least ${pct(n(conv.terms.minRate))} interest back, within ${n(conv.terms.days, 7)} days. Why you might: ${String(conv.terms.why ?? "")}.`]
      : [`You don't want to lend to them: ${String(conv.terms.why ?? "")}. (You have ${money(spare(lender))} you could lay hands on, if you changed your mind.)`];
  },
  describe: (_w, _c, t) => `a loan of ${money(t.amount ?? 0)}${t.rate ? ` at ${pct(t.rate)}` : ""}, paid back within ${t.days ?? 7} days`,
};

/** Offering a loan nobody asked for: the lender proposes, the borrower decides. */
const OFFER_LOAN: Spec = {
  fields: ["amount", "rate", "days"],
  open: (_w, conv) => ({ amount: n(conv.terms.amount, 30), rate: n(conv.terms.minRate), days: n(conv.terms.days, 7) }),
  willing: (_w, conv) => yes(conv.terms.wants),
  ok(_w, conv, side, t) {
    if (side === "proposer") return (t.rate ?? 0) >= n(conv.terms.minRate) * 0.7 - 1e-9;
    return yes(conv.terms.wants) && (t.rate ?? 0) <= n(conv.terms.maxRate) + 1e-9;
  },
  counter(_w, conv, side, t, own) {
    if (side === "responder") return yes(conv.terms.wants) ? { ...t, rate: round2(Math.min(t.rate ?? 0, n(conv.terms.maxRate) * 0.8)) } : null;
    const rate = round2(Math.max(n(conv.terms.minRate) * 0.7, ((t.rate ?? 0) + (own?.rate ?? 0)) / 2));
    return rate > (t.rate ?? 0) + 0.004 ? { ...t, rate } : null;
  },
  possible(world, conv, t) {
    const amount = Math.floor(Math.min(t.amount ?? 0, spare(world.citizens[conv.a])));
    if (amount < 10) return null;
    return { amount, rate: round2(Math.min(0.6, Math.max(0, t.rate ?? 0))), days: Math.round(Math.min(21, Math.max(2, t.days ?? 7))) };
  },
  mine(world, conv, side) {
    if (side === "proposer") return [`You're offering to lend about ${money(n(conv.terms.amount))}. You'd like at least ${pct(n(conv.terms.minRate))} back (you have ${money(spare(world.citizens[conv.a]))} to spare).`];
    return yes(conv.terms.wants) ? [`You could do with the money: ${String(conv.terms.need ?? "things are tight")}. You couldn't stand more than ${pct(n(conv.terms.maxRate))} interest.`] : [`You don't need their money, or don't want to owe them.`];
  },
  describe: (_w, _c, t) => `lending ${money(t.amount ?? 0)} at ${pct(t.rate ?? 0)}, back within ${t.days ?? 7} days`,
};

const INVEST: Spec = {
  fields: ["amount", "share"],
  open: (_w, conv) => ({ amount: n(conv.agenda.amount, 100), share: round2(Math.max(0.02, n(conv.terms.maxShare) * 0.6)) }),
  willing: (_w, conv) => yes(conv.terms.willing),
  ok(_w, conv, side, t) {
    if (side === "proposer") return (t.share ?? 0) <= n(conv.terms.maxShare) + 1e-9 && (t.amount ?? 0) >= 20;
    return yes(conv.terms.willing) && (t.amount ?? 0) <= n(conv.terms.amount) + 1e-9 && (t.share ?? 0) >= n(conv.terms.minShare) - 1e-9;
  },
  counter(_w, conv, side, t, own) {
    if (side === "responder") {
      if (!yes(conv.terms.willing)) return null;
      const amount = Math.floor(Math.min(t.amount ?? 0, n(conv.terms.amount)));
      return amount >= 20 ? { amount, share: round2(Math.max(t.share ?? 0, n(conv.terms.minShare))) } : null;
    }
    const share = round2(Math.min(n(conv.terms.maxShare), ((t.share ?? 0) + (own?.share ?? 0)) / 2));
    return share < (t.share ?? 0) - 0.004 ? { ...t, share } : null;
  },
  possible(world, conv, t) {
    const biz = world.businesses[String(conv.terms.businessId)];
    if (!biz || !biz.open) return null;
    const amount = Math.floor(Math.min(t.amount ?? 0, spare(world.citizens[conv.b], 30)));
    const share = round2(Math.min(t.share ?? 0, ownerShare(biz) - MIN_OWNER_SHARE));
    return amount >= 20 && share >= 0.01 ? { amount, share } : null;
  },
  mine(world, conv, side) {
    const biz = world.businesses[String(conv.terms.businessId)];
    if (side === "proposer") return [`You want about ${money(n(conv.agenda.amount))} for ${biz?.name ?? "the business"}. You'd give away at most ${pct(n(conv.terms.maxShare))} of the profits for it.`];
    return yes(conv.terms.willing)
      ? [`You could put in up to ${money(n(conv.terms.amount))}. You'd want at least ${pct(n(conv.terms.minShare))} of the profits for it. (${String(conv.terms.why ?? "")}.)`]
      : [`You don't want to invest: ${String(conv.terms.why ?? "")}.`];
  },
  describe: (world, conv, t) => `${money(t.amount ?? 0)} into ${String(conv.terms.business ?? "the business")} for ${pct(t.share ?? 0)} of the profits`,
};

/** A job: the worker asks (ask_job) or the owner offers (offer_job); the one who owns the business is `owner`. */
function jobSpec(owner: "a" | "b"): Spec {
  const ownerSide: Side = owner === "a" ? "proposer" : "responder";
  return {
    fields: ["wage"],
    open: (_w, conv) => ({ wage: Math.round(ownerSide === "proposer" ? Math.max(15, n(conv.terms.maxWage) * 0.85) : n(conv.terms.minWage) * 1.1) }),
    willing: (_w, conv) => (ownerSide === "responder" ? yes(conv.terms.willing) : true),
    ok(_w, conv, side, t) {
      const w = t.wage ?? 0;
      return side === ownerSide ? yes(conv.terms.willing) && w <= n(conv.terms.maxWage) + 0.5 : w >= n(conv.terms.minWage) - 0.5;
    },
    counter(_w, conv, side, t, own) {
      const w = t.wage ?? 0;
      if (side === ownerSide) {
        if (!yes(conv.terms.willing)) return null;
        const offer = Math.round(own ? Math.min(n(conv.terms.maxWage), (w + (own.wage ?? 0)) / 2) : Math.min(n(conv.terms.maxWage), Math.max(w * 0.85, n(conv.terms.maxWage) * 0.75)));
        return offer < w - 0.5 ? { wage: offer } : null;
      }
      const ask = Math.round(own ? Math.max(n(conv.terms.minWage), (w + (own.wage ?? 0)) / 2) : n(conv.terms.minWage) * 1.05);
      return ask > w + 0.5 ? { wage: ask } : null;
    },
    possible(world, conv, t) {
      const biz = world.businesses[String(conv.terms.businessId)];
      if (!biz || !biz.open) return null;
      const w = Math.round(t.wage ?? 0);
      return w >= 10 && w <= 150 ? { wage: w } : null;
    },
    mine(_w, conv, side) {
      const biz = String(conv.terms.business ?? "the business");
      return side === ownerSide
        ? yes(conv.terms.willing)
          ? [`${biz} could pay up to about ${money(n(conv.terms.maxWage))} a day. (${String(conv.terms.why ?? "")}.)`]
          : [`You don't want to take them on: ${String(conv.terms.why ?? "")}.`]
        : [`You wouldn't work for less than about ${money(n(conv.terms.minWage))} a day.`];
    },
    describe: (_w, conv, t) => `a job at ${String(conv.terms.business ?? "the business")} for ${money(t.wage ?? 0)} a day`,
  };
}

const SALE: Spec = {
  fields: ["qty", "price"],
  open: (_w, conv) => ({ qty: n(conv.terms.qty, 1), price: round2(Math.min(n(conv.terms.depot) * 0.95, Math.max(n(conv.terms.minPrice) * 1.12, n(conv.terms.depot) * 0.85))) }),
  willing: () => true,
  ok: (_w, conv, side, t) => (side === "proposer" ? (t.price ?? 0) >= n(conv.terms.minPrice) - 0.001 : (t.price ?? 0) <= n(conv.terms.maxPrice) + 0.001),
  counter(_w, conv, side, t, own) {
    const p = t.price ?? 0;
    if (side === "responder") {
      const offer = round2(own ? Math.min(n(conv.terms.maxPrice), (p + (own.price ?? 0)) / 2) : n(conv.terms.maxPrice) * 0.92);
      return offer < p - 0.005 ? { ...t, price: offer } : null;
    }
    const ask = round2(Math.max(n(conv.terms.minPrice), (p + (own?.price ?? p)) / 2));
    return ask > p + 0.005 ? { ...t, price: ask } : null;
  },
  possible(world, conv, t) {
    const biz = world.businesses[String(conv.terms.businessId)];
    const it = world.citizens[conv.a]?.inventory[String(conv.terms.productId)];
    const price = round2(t.price ?? 0);
    if (!biz || !biz.open || !it || price <= 0) return null;
    const qty = Math.floor(Math.min(t.qty ?? 0, it.qty, biz.cash / price));
    return qty >= 1 ? { qty, price } : null;
  },
  mine(world, conv, side) {
    const name = world.products[String(conv.terms.productId)]?.name.toLowerCase() ?? "stock";
    return side === "proposer"
      ? [`You've got ${n(conv.terms.qty)} ${name}. You won't let them go for less than ${money(n(conv.terms.minPrice))} each. The depot charges ${money(n(conv.terms.depot))}.`]
      : [`The depot charges ${money(n(conv.terms.depot))} each for ${name}. You'd pay at most ${money(n(conv.terms.maxPrice))} each.`];
  },
  describe: (world, conv, t) => `${t.qty ?? 0} ${world.products[String(conv.terms.productId)]?.name.toLowerCase() ?? "items"} at ${money(t.price ?? 0)} each`,
};

/** Help: they ask, and the helper says how much (if anything). */
const ASK_HELP: Spec = {
  fields: ["amount"],
  open: () => ({}),
  willing: (_w, conv) => yes(conv.terms.willing),
  ok: (_w, _c, side, t) => (side === "proposer" ? (t.amount ?? 0) > 0 : false),
  counter: (_w, conv, side) => (side === "responder" && yes(conv.terms.willing) ? { amount: Math.max(1, n(conv.terms.maxGift)) } : null),
  possible(world, conv, t) {
    const amount = Math.floor(Math.min(t.amount ?? 0, spare(world.citizens[conv.b], 5)));
    return amount >= 1 ? { amount } : null;
  },
  mine(world, conv, side) {
    if (side === "proposer") return ["You're broke and hungry. Any help at all would do."];
    return yes(conv.terms.willing) ? [`You could give them about ${money(n(conv.terms.maxGift))} (you have ${money(spare(world.citizens[conv.b], 5))}).`] : [`You don't want to give them money (you have ${money(spare(world.citizens[conv.b], 5))}).`];
  },
  describe: (_w, _c, t) => (t.amount ? `${money(t.amount)} to tide them over` : "some help"),
};

/** Offering money, unasked: they can take it or (out of pride) not. */
const OFFER_HELP: Spec = {
  fields: ["amount"],
  open: (_w, conv) => ({ amount: n(conv.terms.amount, 20) }),
  willing: (_w, conv) => yes(conv.terms.wants),
  ok: (_w, conv, side) => side === "proposer" || yes(conv.terms.wants),
  counter: () => null,
  possible(world, conv, t) {
    const amount = Math.floor(Math.min(t.amount ?? 0, spare(world.citizens[conv.a], 5)));
    return amount >= 1 ? { amount } : null;
  },
  mine: (_w, conv, side) => (side === "proposer" ? [`You want to give them ${money(n(conv.terms.amount))}.`] : yes(conv.terms.wants) ? ["You could really use it."] : ["You don't want charity."]),
  describe: (_w, _c, t) => `${money(t.amount ?? 0)}, no strings`,
};

/** Chasing a debt: they choose to pay, pay some, ask for time, or refuse. */
const REPAY: Spec = {
  fields: ["choice"],
  open: (_w, conv) => ({ amount: n(conv.terms.owed) }),
  willing: (_w, conv) => yes(conv.terms.honest),
  ok: (_w, _c, side, t) => side === "proposer" && !!t.choice,
  counter(_w, conv, side) {
    if (side !== "responder") return null;
    if (!yes(conv.terms.honest)) return null;
    return { choice: yes(conv.terms.canPay) ? "paid" : yes(conv.terms.canPartial) ? "partial" : "promise" };
  },
  possible(world, conv, t) {
    const b = world.citizens[conv.b];
    const liquid = b.money + b.savings;
    const owed = n(conv.terms.owed);
    const c = t.choice ?? "promise";
    if (c === "paid") return liquid >= owed + 5 ? { choice: "paid" } : liquid > 25 ? { choice: "partial" } : { choice: "promise" };
    if (c === "partial") return liquid > 25 ? { choice: "partial" } : { choice: "promise" };
    return { choice: c === "refuse" ? "refuse" : "promise" };
  },
  mine(world, conv, side) {
    const b = world.citizens[conv.b];
    return side === "proposer" ? [`They owe you ${money(n(conv.terms.owed))} and it's overdue.`] : [`You owe them ${money(n(conv.terms.owed))}. You have ${money(Math.floor(b.money + b.savings))}. You could pay it all, pay some, ask for more time, or refuse.`];
  },
  describe: (_w, conv) => `the ${money(n(conv.terms.owed))} they owe`,
};

/** A tip for sale (or free). */
const TIP: Spec = {
  fields: ["price"],
  open: (_w, conv) => ({ price: n(conv.terms.price) }),
  willing: (world, conv) => n(conv.terms.price) === 0 || spare(world.citizens[conv.b]) > n(conv.terms.price) * 3,
  ok: (world, conv, side, t) => (side === "proposer" ? (t.price ?? 0) >= n(conv.terms.price) * 0.5 : (t.price ?? 0) === 0 || ((world.citizens[conv.b].relationships[conv.a]?.trust ?? 0) > -10 && spare(world.citizens[conv.b]) > (t.price ?? 0) * 3)),
  counter: (_w, conv, side, t) => (side === "responder" && (t.price ?? 0) > 0 ? { price: Math.round((t.price ?? 0) * 0.6) } : null),
  possible: (world, conv, t) => ((t.price ?? 0) <= spare(world.citizens[conv.b]) ? { price: Math.round(t.price ?? 0) } : null),
  mine: (_w, conv, side) => (side === "proposer" ? [n(conv.terms.price) ? `You want ${money(n(conv.terms.price))} for what you know.` : "You'll tell them for free: they're a friend."] : ["They say they know where a price is heading."]),
  describe: (_w, _c, t) => (t.price ? `the tip for ${money(t.price)}` : "the tip"),
};

/** Patching things up: one says sorry, the other forgives or doesn't. */
const MAKE_PEACE: Spec = {
  fields: [],
  open: () => ({}),
  willing: (_w, conv) => n(conv.terms.forgiveness) > 0.5,
  ok: (_w, conv, side) => side === "proposer" || n(conv.terms.forgiveness) > 0.5,
  counter: () => null,
  possible: (_w, _c, t) => t,
  mine: (_w, conv, side) => (side === "proposer" ? [`You want to patch things up: ${String(conv.terms.what ?? "you fell out")}.`] : [`They hurt you: ${String(conv.terms.what ?? "you fell out")}. ${n(conv.terms.forgiveness) > 0.5 ? "You're ready to let it go." : "You're not ready to forgive them."}`]),
  describe: () => "making up",
};

/** Asking someone out. */
const ASK_OUT: Spec = {
  fields: [],
  open: () => ({}),
  willing: (_w, conv) => yes(conv.terms.keen),
  ok: (_w, conv, side) => side === "proposer" || yes(conv.terms.keen),
  counter: () => null,
  possible: (_w, _c, t) => t,
  mine: (_w, conv, side) => (side === "proposer" ? ["You fancy them. You're going to ask them out."] : [yes(conv.terms.keen) ? "You like them. A lot, actually." : String(conv.terms.why ?? "You don't see them that way.")]),
  describe: () => "going out together",
};

/** Bringing someone into a plan: money in, a share of what comes of it. */
const RECRUIT: Spec = {
  fields: ["amount"],
  open: (_w, conv) => ({ amount: n(conv.terms.ask, 50) }),
  willing: (_w, conv) => yes(conv.terms.willing),
  ok: (_w, conv, side, t) => (side === "proposer" ? (t.amount ?? 0) >= Math.min(20, n(conv.terms.ask)) : yes(conv.terms.willing) && (t.amount ?? 0) <= n(conv.terms.canPut) + 1e-9),
  counter(_w, conv, side, t) {
    if (side !== "responder" || !yes(conv.terms.willing)) return null;
    const amount = Math.floor(Math.min(t.amount ?? 0, n(conv.terms.canPut)));
    return amount >= 15 && amount < (t.amount ?? 0) ? { amount } : null;
  },
  possible(world, conv, t) {
    const amount = Math.floor(Math.min(t.amount ?? 0, spare(world.citizens[conv.b], 25)));
    return amount >= 15 ? { amount } : null;
  },
  mine: (world, conv, side) =>
    side === "proposer"
      ? [`You're trying to ${String(conv.terms.plan ?? "get something started")}. You need ${money(n(conv.terms.need))} all told; you're asking them for about ${money(n(conv.terms.ask))}.`]
      : yes(conv.terms.willing)
        ? [`You could put in up to ${money(n(conv.terms.canPut))} (you have ${money(spare(world.citizens[conv.b], 25))}).`]
        : [`You don't fancy it: ${String(conv.terms.why ?? "it's too risky")}.`],
  describe: (_w, conv, t) => `${money(t.amount ?? 0)} into the plan to ${String(conv.terms.plan ?? "start something")}`,
};

export const DEALS: Record<string, Spec> = {
  ask_loan: LOAN,
  offer_loan: OFFER_LOAN,
  pitch_investment: INVEST,
  ask_job: jobSpec("b"),
  offer_job: jobSpec("a"),
  sell_stock: SALE,
  ask_help: ASK_HELP,
  offer_help: OFFER_HELP,
  demand_repayment: REPAY,
  share_tip: TIP,
  make_peace: MAKE_PEACE,
  ask_out: ASK_OUT,
  recruit: RECRUIT,
};

/** Is this a topic that's negotiated? */
export function isDeal(topic: string): boolean {
  return topic in DEALS;
}

/** Start the negotiation (nothing on the table yet). */
export function startDeal(conv: Conversation): DealState {
  return { topic: conv.topic, proposer: conv.a, responder: conv.b, status: "open", offers: [], agreed: null };
}

/** The latest offer, and the latest one from `by` (if any). */
function lastOffer(d: DealState, by?: string) {
  for (let i = d.offers.length - 1; i >= 0; i--) if (!by || d.offers[i].by === by) return d.offers[i];
  return null;
}

/** Only the fields this kind of deal uses. */
function pick(spec: Spec, t: DealTerms): DealTerms {
  const out: DealTerms = {};
  for (const f of [...spec.fields, "amount"] as (keyof DealTerms)[]) if (t[f] !== undefined && t[f] !== null) (out as Record<string, unknown>)[f] = t[f];
  return out;
}

/**
 * Check a move (from a model or the rules) against the state of the deal and
 * what's possible. Returns the move as it will stand, or why it can't.
 */
export function checkDealMove(world: WorldState, conv: Conversation, d: DealState, by: string, action: DealAction, raw: DealTerms): { ok: true; action: DealAction; terms: DealTerms } | { ok: false; why: string } {
  const spec = DEALS[d.topic];
  if (!spec) return { ok: false, why: "not a deal" };
  if (d.status !== "open") return { ok: false, why: "the deal's already settled" };
  const other = lastOffer(d);
  if (action === "decline") return { ok: true, action, terms: {} };
  if (action === "accept") {
    // You can only accept what the other one put on the table.
    if (!other || other.by === by) return { ok: false, why: "nothing to accept" };
    const t = spec.possible(world, conv, other.terms);
    return t ? { ok: true, action, terms: t } : { ok: false, why: "it can't be done (the money or the goods aren't there)" };
  }
  if (action === "propose" && d.offers.length && by === d.proposer) action = "counter";
  const merged = pick(spec, { ...(other?.terms ?? {}), ...raw });
  const t = spec.possible(world, conv, merged);
  if (!t) return { ok: false, why: "it can't be done (the money or the goods aren't there)" };
  return { ok: true, action, terms: t };
}

/** Put a move on the record. */
export function applyDealMove(world: WorldState, d: DealState, by: string, action: DealAction, terms: DealTerms, source: "llm" | "built-in"): void {
  d.offers.push({ by, action, terms, t: world.time, source });
  if (action === "accept") {
    d.status = "agreed";
    d.agreed = terms;
  } else if (action === "decline") {
    d.status = "declined";
    d.declinedBy = by;
  }
}

/** What the conversation decided, for the topic's handler. */
export function dealOutcome(conv: Conversation): Record<string, ConvValue> {
  const d = conv.dlg?.deal;
  const t = d?.status === "agreed" ? (d.agreed ?? {}) : null;
  switch (conv.topic) {
    case "ask_loan":
    case "offer_loan":
      return t ? { agreed: true, amount: t.amount ?? 0, rate: t.rate ?? 0, days: t.days ?? 7 } : { agreed: false, amount: 0, rate: 0, days: 7 };
    case "pitch_investment":
      return t ? { agreed: true, amount: t.amount ?? 0, share: t.share ?? 0 } : { agreed: false, amount: 0, share: 0 };
    case "ask_job":
    case "offer_job":
      return t ? { agreed: true, wage: t.wage ?? 0 } : { agreed: false, wage: 0 };
    case "sell_stock":
      return t ? { agreed: true, qty: t.qty ?? 0, price: t.price ?? 0 } : { agreed: false, qty: 0, price: 0 };
    case "ask_help":
    case "offer_help":
      return t ? { agreed: true, gift: t.amount ?? 0 } : { agreed: false, gift: 0 };
    case "demand_repayment":
      // What they chose; walking away without a word is as good as refusing.
      return { result: t ? (t.choice ?? "promise") : "refuse" };
    case "share_tip":
      return t ? { agreed: true, price: t.price ?? 0 } : { agreed: false, price: 0 };
    case "recruit":
      return t ? { agreed: true, amount: t.amount ?? 0 } : { agreed: false, amount: 0 };
    default:
      return { agreed: d?.status === "agreed" };
  }
}

/** The rules' own next move in the deal, for `me` (what a sensible person like them would do, by their own limits). */
function ruleMove(world: WorldState, conv: Conversation, d: DealState, me: Citizen): { action: DealAction; terms: DealTerms } {
  const spec = DEALS[d.topic];
  const side: Side = me.id === d.proposer ? "proposer" : "responder";
  const r = rngFor(world, conv, me.id, `deal${d.offers.length}`);
  if (!d.offers.length) return { action: "propose", terms: spec.open(world, conv) };
  const on = lastOffer(d)!;
  const mineLast = lastOffer(d, me.id)?.terms ?? null;
  const rounds = d.offers.filter((o) => o.action === "counter").length;
  const p = profileOf(me);
  if (side === "responder" && !spec.willing(world, conv) && rounds === 0) return { action: "decline", terms: {} };
  if (spec.ok(world, conv, side, on.terms)) {
    // Acceptable, but the greedy and the bold push their luck once.
    const haggle = rounds === 0 && side === "responder" && (me.traits.greed > 0.62 || p.bluntness > 0.75) && rand(r) < 0.55;
    const c = haggle ? spec.counter(world, conv, side, on.terms, mineLast) : null;
    return c ? { action: "counter", terms: c } : { action: "accept", terms: on.terms };
  }
  // Too many rounds: the impatient walk sooner.
  if (rounds >= (p.patience > 0.6 ? 4 : 3)) return { action: "decline", terms: {} };
  const c = spec.counter(world, conv, side, on.terms, mineLast);
  return c ? { action: "counter", terms: c } : { action: "decline", terms: {} };
}

/** The next turn in a negotiation, from `me`'s side. Null: it's over. */
export function negotiationDirective(world: WorldState, conv: Conversation, st: DialogueState, me: Citizen, them: Citizen): Directive | null {
  const d = (st.deal ??= startDeal(conv));
  const rel = relView(world, me, them);
  const turns = st.turns;
  const last = turns[turns.length - 1] ?? null;
  const base = { reply: last, askBack: null, bye: false, rel, topic: null, length: "short" as const };
  const spec = DEALS[d.topic];
  if (d.status === "open") {
    if (turns.length >= 12) {
      // Going round in circles: someone calls it a day.
      return { ...base, move: "answer", intent: "get away", deal: { action: "decline", terms: {} }, hint: `This is going nowhere. Call it off.` };
    }
    const m = ruleMove(world, conv, d, me);
    const side = me.id === d.proposer ? "proposer" : "responder";
    const on = d.offers.length ? d.offers[d.offers.length - 1] : null;
    const what = on ? spec.describe(world, conv, on.terms) : "";
    const hint =
      m.action === "propose"
        ? `You've come to ${them.name} about ${spec.describe(world, conv, m.terms)}. Ask, your way.`
        : m.action === "accept"
          ? `${them.name} has put this on the table: ${what}. You'll take it.`
          : m.action === "counter"
            ? `${them.name} has put this on the table: ${what}. You want ${spec.describe(world, conv, m.terms)} instead. Say so, your way.`
            : `${side === "responder" ? `${them.name} wants ${what || spec.describe(world, conv, spec.open(world, conv))}.` : `${them.name} came back with ${what}.`} You're saying no.`;
    return { ...base, move: m.action === "propose" ? "raise" : on && on.by === them.id && side === "proposer" ? "react" : "answer", intent: "close the deal", deal: m, hint: `${hint} (You decide: take it, say no, or name your own terms.)` };
  }
  // Settled: a word on how it went, and goodbye.
  if (last?.bye) return turns.some((t) => t.speaker === me.id && t.bye) ? null : { ...base, move: "byeback", intent: "pass time", bye: true, hint: `${them.name} is going. Say bye back.` };
  const agreed = d.status === "agreed";
  return { ...base, move: "close", intent: "close the deal", bye: true, hint: agreed ? `You've agreed: ${spec.describe(world, conv, d.agreed ?? {})}. Wrap it up and go.` : `It's a no. Wrap it up and go, the way you would.` };
}

/** What each side privately knows about the deal, for the model (their own limits only, and what's on the table). */
export function dealContext(world: WorldState, conv: Conversation, me: Citizen): string[] {
  const d = conv.dlg?.deal;
  const spec = d ? DEALS[d.topic] : undefined;
  if (!d || !spec) return [];
  const side: Side = me.id === d.proposer ? "proposer" : "responder";
  const on = d.offers.length ? d.offers[d.offers.length - 1] : null;
  const name = (id: string) => world.citizens[id]?.name ?? "they";
  return [
    ...spec.mine(world, conv, side),
    on ? `On the table: ${on.by === me.id ? "your" : `${name(on.by)}'s`} ${on.action === "propose" ? "ask" : on.action === "counter" ? "offer" : on.action}: ${spec.describe(world, conv, on.terms)}.` : "Nothing's been asked yet.",
    d.status === "open" ? "Nothing is agreed until one of you accepts. You can accept what's on the table, say no, or name different terms." : d.status === "agreed" ? `Agreed: ${spec.describe(world, conv, d.agreed ?? {})}.` : "It's a no.",
  ];
}

// ------------------------------------------------------------ in words

const R = (x: number) => money(x);

/** A negotiating line in the speaker's own words (the built-in voice). */
export function dealLine(world: WorldState, conv: Conversation, st: DialogueState, me: Citizen, them: Citizen, dir: Directive): string {
  const d = st.deal!;
  const r = rngFor(world, conv, me.id, `dealsay${st.turns.length}`);
  const say = (key: string, opts: string[]) => pickFor(world, me, r, `deal:${d.topic}:${key}`, opts.filter(Boolean));
  const nm = them.name;
  const t = dir.deal?.terms ?? {};
  const biz = String(conv.terms.business ?? world.businesses[String(conv.terms.businessId)]?.name ?? "the business");
  const product = world.products[String(conv.terms.productId)]?.name.toLowerCase() ?? "stock";
  if (dir.move === "byeback") return say("bye", ["See you.", "Bye.", "Take care.", "Right. See you around."]);
  if (dir.move === "close") {
    const agreed = d.status === "agreed";
    const mine = d.proposer === me.id;
    if (agreed) {
      const k = d.topic;
      if (k === "ask_loan") return mine ? say("thanks", [`Thank you. Honestly. You'll get it back.`, `You're a lifesaver. I'll pay you back, I promise.`, `Cheers, ${nm}. I won't forget this.`]) : say("done", ["Don't make me regret it.", "Right. Don't be late with it.", "Go on then. Sort yourself out."]);
      if (k === "offer_loan") return mine ? say("done", ["That's settled, then.", "Pay me back when you said, mind."]) : say("thanks", ["Thanks. I mean it.", "You didn't have to. Thank you."]);
      if (k === "ask_job" || k === "offer_job") return d.proposer === me.id === (k === "offer_job") ? say("boss", ["Start tomorrow, then.", "Welcome aboard.", "Don't be late."]) : say("worker", ["Brilliant. I won't let you down.", "Thanks. See you tomorrow.", "Cheers. You won't regret it."]);
      if (k === "pitch_investment" || k === "recruit") return mine ? say("partner", ["Partners, then.", "You won't regret this.", "Shake on it?"]) : say("investor", ["Don't lose my money.", "Right. Let's see what you can do.", "Go on then. Partners."]);
      if (k === "ask_help" || k === "offer_help") return k === "ask_help" === mine ? say("thanks", ["Thank you. Really.", "I'll pay you back, I swear.", "You're a star."]) : say("welcome", ["Don't mention it.", "Look after yourself.", "Any time."]);
      if (k === "make_peace") return say("peace", ["Good. I'm glad.", "Right. Pint sometime?", "Friends, then."]);
      if (k === "ask_out") return mine ? say("date", ["Brilliant. It's a date.", "Really? Great! Tomorrow, then?", "I'll hold you to that."]) : say("date2", ["Go on, then. Don't be late.", "See you then."]);
      if (k === "demand_repayment") return mine ? say("paid", ["Right. That's that.", "Thank you. Was that so hard?"]) : say("paid2", ["There. We're square.", "Happy now?"]);
      return say("deal", ["Deal.", "Pleasure doing business.", "Right, that's settled."]);
    }
    const iSaidNo = d.declinedBy === me.id;
    // Asking for something and refused: no hard feelings (out loud). Offering something and refused: their loss.
    const asked = ["ask_loan", "ask_job", "ask_help", "demand_repayment"].includes(d.topic) === mine;
    return iSaidNo ? say("no:me", ["Sorry. That's just how it is.", "No hard feelings.", "Anyway. I'd best be off."]) : asked ? say("no:asked", ["Right. Fair enough.", "Forget I asked.", "Right. Thanks anyway.", "No worries. I'll sort something."]) : say("no:offered", ["Your loss.", "Suit yourself.", "Fair enough. Offer's there.", "Right. Well, think about it."]);
  }
  const a = dir.deal?.action ?? "propose";
  switch (d.topic) {
    case "ask_loan":
      if (a === "propose") return say("ask", [`${nm}, can I ask you something? Could you lend me ${R(t.amount ?? 0)}? It's to ${String(conv.terms.purpose ?? "get by")}.`, `I hate asking, but could you lend me ${R(t.amount ?? 0)}? I'll pay you back within ${t.days ?? 7} days.`, `I'm in a bit of a hole. ${R(t.amount ?? 0)} would get me out of it. Could you?`]);
      if (a === "accept" && me.id === d.responder) return say("yes", [`Go on then. ${R(t.amount ?? 0)}${t.rate ? `, at ${pct(t.rate)}` : ""}.`, `Alright. ${R(t.amount ?? 0)}. Back within ${t.days ?? 7} days, mind.`]);
      if (a === "accept") return say("fine", [`${pct(t.rate ?? 0)}? Fine. Deal.`, `Alright. I'll take it.`, `Done. Thank you.`]);
      if (a === "counter" && me.id === d.responder) return say("counter", [`I can do ${R(t.amount ?? 0)}${t.rate ? `, but I'll want ${pct(t.rate)} on top` : ""}.`, `${R(t.amount ?? 0)}, and ${pct(t.rate ?? 0)} interest. Back within ${t.days ?? 7} days.`, `Not ${R(conv.terms.requested as number)}. ${R(t.amount ?? 0)}${t.rate ? ` at ${pct(t.rate)}` : ""}, take it or leave it.`]);
      if (a === "counter") return say("haggle", [`That's steep. ${pct(t.rate ?? 0)} and you've got a deal.`, `Could you do ${pct(t.rate ?? 0)}? I'm not made of money.`, `Meet me halfway? ${pct(t.rate ?? 0)}.`]);
      if (me.id === d.proposer) return say("walk", ["I can't do it at that. Forget it.", "That's too steep for me. I'll look elsewhere.", "No. I'll manage somehow."]);
      return say("refuse", ["Sorry. I can't.", `I can't, ${nm}. Not this time.`, "No. Sorry. I just can't spare it.", "I'd rather not, to be honest."]);
    case "offer_loan":
      if (a === "propose") return say("offer", [`Look, I heard things are tight. I could lend you ${R(t.amount ?? 0)} if it helps. ${t.rate ? `${pct(t.rate)}, back in ${t.days ?? 7} days.` : "No interest."}`, `If you need it, I can lend you ${R(t.amount ?? 0)}. Pay me back in ${t.days ?? 7} days.`]);
      if (a === "accept") return say("yes", ["You'd do that? Yes. Please.", "Honestly? That would help. Thank you.", "I'll take it. Thanks."]);
      if (a === "counter") return say("haggle", [`Could you do ${pct(t.rate ?? 0)}?`, `I'd take it at ${pct(t.rate ?? 0)}.`]);
      return say("no", ["I'm alright, thanks.", "Thanks, but I'd rather not owe anyone.", "No, I'll manage."]);
    case "pitch_investment":
    case "recruit": {
      const pitch = d.topic === "recruit" ? `my plan to ${String(conv.terms.plan ?? "start something")}` : biz;
      if (a === "propose") return say("pitch", [`I'll be straight with you. I'm looking for someone to put ${R(t.amount ?? 0)} into ${pitch}${t.share ? ` for ${pct(t.share)} of the profits` : ""}.`, `Want in on ${pitch}? ${R(t.amount ?? 0)}${t.share ? ` gets you ${pct(t.share)} of the profits` : ""}.`, `${nm}, how would you like to make some money? ${R(t.amount ?? 0)} into ${pitch}.`]);
      if (a === "accept" && me.id === d.responder) return say("in", ["Go on. I'm in.", `Alright. ${R(t.amount ?? 0)}${t.share ? ` for ${pct(t.share)}` : ""}. Deal.`, "You've talked me into it."]);
      if (a === "accept") return say("fine", ["Done. Partners.", "Fine. Deal.", "You drive a hard bargain. Deal."]);
      if (a === "counter" && me.id === d.responder) return say("counter", [`I'd go ${R(t.amount ?? 0)}${t.share ? `, for ${pct(t.share)}` : ""}.`, `${R(t.amount ?? 0)}${t.share ? ` and ${pct(t.share)} of the profits` : ""}. That's my offer.`]);
      if (a === "counter") return say("haggle", [`${pct(t.share ?? 0)}, and it's a deal.`, `I can't give away that much. ${pct(t.share ?? 0)}?`]);
      return say("no", ["I'll pass, thanks.", "Not for me.", "I don't think so. Sorry.", "I like you, but no."]);
    }
    case "ask_job":
    case "offer_job": {
      const owner = (d.topic === "offer_job") === (me.id === d.proposer);
      if (a === "propose") return owner ? say("offer", [`I could use someone at ${biz}. ${R(t.wage ?? 0)} a day. Interested?`, `How do you fancy working for me? ${R(t.wage ?? 0)} a day at ${biz}.`]) : say("ask", [`Any chance of a job at ${biz}? I'm a hard worker.`, `I don't suppose you need anyone at ${biz}? I'd want about ${R(t.wage ?? 0)} a day.`, `${nm}, I need work. Anything going at ${biz}?`]);
      if (a === "accept") return owner ? say("yes:boss", [`${R(t.wage ?? 0)} a day? Alright. You're hired.`, "Fine. You can start tomorrow."]) : say("yes:worker", [`${R(t.wage ?? 0)}? I'll take it.`, "Yes. When do I start?", "Deal. Thank you."]);
      if (a === "counter") return owner ? say("counter:boss", [`I can do ${R(t.wage ?? 0)} a day. That's my limit.`, `${R(t.wage ?? 0)} a day. Take it or leave it.`]) : say("counter:worker", [`I'd need ${R(t.wage ?? 0)} a day, really.`, `Could you do ${R(t.wage ?? 0)}?`]);
      return owner ? say("no:boss", ["Sorry, I can't take anyone on.", "Not right now. Sorry.", "I don't think it'd work out."]) : say("no:worker", ["I'll have to say no.", "Not for that money, sorry.", "Thanks, but no."]);
    }
    case "sell_stock":
      if (a === "propose") return say("offer", [`${nm}, I've got ${t.qty} ${product} going cheap. ${R(t.price ?? 0)} each, cheaper than the depot.`, `Want ${t.qty} ${product}? ${R(t.price ?? 0)} each.`]);
      if (a === "accept") return say("yes", [`${R(t.price ?? 0)}? Go on.`, "Deal. Bring them round.", "Done."]);
      if (a === "counter") return say("counter", [`I'd do ${R(t.price ?? 0)} each.`, `${R(t.price ?? 0)} each, and you've got a deal.`, `Meet me at ${R(t.price ?? 0)}?`]);
      return say("no", ["No, ta.", "Not at that price.", "I'll get them from the depot."]);
    case "ask_help":
      if (a === "propose") return say("ask", [`${nm}... I hate asking. I'm broke. I haven't eaten.`, `I'm in a real state, ${nm}. Could you help me out?`, "I'm skint. Properly skint. Is there anything you could spare?"]);
      if (a === "counter") return say("give", [`Here. Take ${R(t.amount ?? 0)}. Don't argue.`, `I can give you ${R(t.amount ?? 0)}. Get yourself something to eat.`]);
      if (a === "accept") return say("thanks", ["Thank you. You've no idea.", "I'll pay you back. I swear."]);
      return say("no", ["I'm sorry. I've got nothing to spare.", "I can't. Things are tight for me too.", "Sorry. No."]);
    case "offer_help":
      if (a === "propose") return say("offer", [`Here. ${R(t.amount ?? 0)}. I want you to have it.`, `Take this. ${R(t.amount ?? 0)}. Don't argue.`]);
      if (a === "accept") return say("yes", ["You're sure? Thank you.", "I don't know what to say. Thanks."]);
      return say("no", ["I can't take that. I'm fine, honestly.", "Keep it. I don't need charity."]);
    case "demand_repayment":
      if (a === "propose") return say("ask", [`${nm}. The ${R(t.amount ?? n(conv.terms.owed))}. It's overdue.`, `I need my money back. ${R(t.amount ?? n(conv.terms.owed))}.`, `About that loan. You're late.`]);
      if (a === "counter" || a === "accept") return t.choice === "paid" ? say("paid", ["Here. All of it. We're square.", "I've got it. Here you go."]) : t.choice === "partial" ? say("partial", ["I can give you some now. The rest soon, I promise.", "Here's part of it. That's all I've got."]) : say("promise", ["Give me a few more days. Please.", "I haven't got it. Next week, I swear."]);
      return say("refuse", ["I'm not paying that.", "You'll get nothing. Not after what you charged.", "Whistle for it."]);
    case "share_tip":
      if (a === "propose") return t.price ? say("sell", [`I know something about where a price is going. ${R(t.price)} and it's yours.`, `Want a tip worth a lot more than ${R(t.price)}? That's the price.`]) : say("free", ["Can I tell you something? Keep it to yourself.", "Here's a tip for you, between us."]);
      if (a === "accept") return say("yes", ["Go on. Tell me.", "Alright. Deal.", "I'm listening."]);
      if (a === "counter") return say("counter", [`${R(t.price ?? 0)}. Not a penny more.`, `I'd give you ${R(t.price ?? 0)} for it.`]);
      return say("no", ["I'll take my chances.", "Not for that money.", "No thanks."]);
    case "make_peace":
      if (a === "propose") return say("sorry", [`Look, ${nm}. About before. I'm sorry.`, "I've been thinking. I was out of order. Sorry.", "Can we put it behind us? I'm sorry."]);
      if (a === "accept") return say("yes", ["Alright. Water under the bridge.", "Fine. Thank you for saying it.", "Yeah. Me too."]);
      return say("no", ["Bit late for that.", "Sorry doesn't cut it.", "I'm not ready to let it go."]);
    case "ask_out":
      if (a === "propose") return say("ask", [`I was wondering... would you fancy a drink sometime? Just us?`, `${nm}, would you go out with me?`, "This is going to sound daft, but... dinner, one night?"]);
      if (a === "accept") return say("yes", ["I'd love that.", "Yes. Yes, I would.", "Took you long enough. Yes."]);
      return say("no", [`Oh. ${nm}, I'm flattered, but no.`, "I don't think of you like that. Sorry.", "I'd rather we stayed friends."]);
    default:
      return a === "accept" ? "Deal." : a === "decline" ? "No." : "What do you say?";
  }
}
