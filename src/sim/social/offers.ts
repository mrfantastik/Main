import { situation } from "../ai/situation";
import { setThought } from "../ai/decision";
import { createPeerLoan, ensureCash } from "../economy/bank";
import { citizenAcc, transfer } from "../economy/ledger";
import { remember, rememberBetrayal } from "../memory/memory";
import { feel, stanceToward } from "../mind/emotions";
import { hashSeed } from "../rng";
import type { Citizen, ConvValue, EventCategory } from "../types";
import { clamp, money, pct } from "../util";
import type { TopicHandler } from "./conversation";
import { compatibility } from "./encounters";
import { loanTerms } from "./negotiation";
import { addRole, adjustRel, getRel } from "./relationships";

// The things people can come to each other with, unasked: offering a loan
// or money, saying sorry, asking someone out, asking them in on a plan.
// Whether the other one says yes is theirs to decide, in the conversation
// (see dialogue/deal.ts); these work out what each of them privately makes
// of it beforehand, and what happens afterwards.

const news = (text: string, cat: EventCategory, importance: number) => ({ text, cat, importance });
const num = (v: ConvValue | undefined, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const bool = (v: ConvValue | undefined): boolean => v === true;
const spare = (c: Citizen, keep = 15) => Math.max(0, Math.floor(c.money + c.savings - keep));

function inCouple(c: Citizen): string | null {
  return Object.entries(c.relationships).find(([, r]) => r.roles.includes("couple"))?.[0] ?? null;
}

/** The worst thing `me` holds against `them` (a memory), and how bad (0..10). */
function grievance(me: Citizen, them: Citizen): { text: string; weight: number } | null {
  const m = [...me.memories.long, ...me.memories.short].filter((x) => x.people.includes(them.id) && x.valence < -0.2).sort((a, b) => a.valence * a.importance - b.valence * b.importance)[0];
  return m ? { text: m.text.replace(/\.$/, ""), weight: -m.valence * m.importance } : null;
}

export const OFFER_HANDLERS: Record<"offer_loan" | "offer_help" | "make_peace" | "ask_out" | "recruit", TopicHandler> = {
  offer_loan: {
    schema: { agreed: { type: "boolean" }, amount: { type: "number" }, rate: { type: "number" }, days: { type: "integer" } },
    prepare(world, conv, a, b) {
      const amount = Math.floor(Math.min(num(conv.agenda.amount, 40), spare(a)));
      if (amount < 10) return null;
      const t = loanTerms(world, b, a, amount, "get by");
      const s = situation(world, b);
      const short = Math.round(s.rent + b.rentArrears + s.dailyCost * 2 - s.liquid);
      const trust = getRel(b, a.id).trust;
      const wants = (short > 0 || s.pressure > 0.45 || b.homeless) && trust > -20 && !rememberBetrayal(b, a.id);
      return {
        terms: { amount, minRate: t.minRate, maxRate: t.maxRate, days: t.days, wants, need: short > 0 ? `you're about ${money(short)} short` : "money's tight" },
        lines: [],
        outcome: {},
        stakes: amount,
        brief: `${a.name} offers to lend ${b.name} money.`,
      };
    },
    validate: (_c, raw) => raw,
    apply(world, conv, a, b) {
      const o = conv.outcome!;
      a.cooldowns[`offerloan:${b.id}`] = world.time;
      if (bool(o.agreed)) {
        const loan = createPeerLoan(world, a, b, num(o.amount), num(o.rate), num(o.days, 7), "get by");
        if (!loan) {
          conv.summary = `${a.name} offered ${b.name} a loan but didn't have the cash after all.`;
          return null;
        }
        remember(world, a, { text: `I lent ${b.name} ${money(loan.principal)} at ${pct(loan.rate)}.`, kind: "loan", importance: 5, valence: 0.2, people: [b.id] });
        conv.summary = `${a.name} lent ${b.name} ${money(loan.principal)} at ${pct(loan.rate)}.`;
        return news(`💸 ${a.name} offered ${b.name} a loan of ${money(loan.principal)} at ${pct(loan.rate)}, and ${b.name} took it.`, "finance", 3);
      }
      conv.summary = `${b.name} turned down ${a.name}'s offer of a loan.`;
      return news(`${a.name} offered ${b.name} a loan; ${b.name} said no thanks.`, "social", 2);
    },
  },

  offer_help: {
    schema: { agreed: { type: "boolean" }, gift: { type: "number" } },
    prepare(world, conv, a, b) {
      const amount = Math.floor(Math.min(num(conv.agenda.amount, 20), spare(a, 5)));
      if (amount < 1) return null;
      const s = situation(world, b);
      // Pride: the comfortable and the status-conscious don't take charity.
      const proud = b.personality.values.includes("status") || b.traits.greed < 0.3 && s.pressure < 0.3;
      const wants = s.pressure > 0.35 || b.money < 25 || b.homeless || (!proud && (b.relationships[a.id]?.affinity ?? 0) > 50);
      return { terms: { amount, wants }, lines: [], outcome: {}, stakes: amount, brief: `${a.name} offers ${b.name} money.` };
    },
    validate: (_c, raw) => raw,
    apply(world, conv, a, b) {
      const gift = num(conv.outcome!.gift);
      a.cooldowns[`gift:${b.id}`] = world.time;
      if (bool(conv.outcome!.agreed) && gift > 0 && ensureCash(a, gift) && transfer(world, citizenAcc(a.id), citizenAcc(b.id), gift, "gift", `Gift from ${a.name}`)) {
        remember(world, b, { text: `${a.name} gave me ${money(gift)}, out of nowhere.`, kind: "favor", importance: 6, valence: 0.8, people: [a.id], key: `help:${a.id}`, feel: { gratitude: 25, joy: 10 } });
        remember(world, a, { text: `I gave ${b.name} ${money(gift)}.`, kind: "favor", importance: 4, valence: 0.4, people: [b.id] });
        adjustRel(world, b, a.id, { affinity: 12, trust: 8 });
        conv.summary = `${a.name} gave ${b.name} ${money(gift)}.`;
        return news(`💝 ${a.name} gave ${b.name} ${money(gift)}, unasked.`, "social", 3);
      }
      conv.summary = `${b.name} wouldn't take ${a.name}'s money.`;
      return null;
    },
  },

  make_peace: {
    schema: { agreed: { type: "boolean" } },
    prepare(_world, _conv, a, b) {
      const g = grievance(b, a);
      const rel = getRel(b, a.id);
      const st = stanceToward(b, a.id);
      const forgiveness = clamp(b.personality.big5.agreeableness * 0.6 + (rel.affinity + 50) / 250 + rel.familiarity / 300 - (g ? g.weight / 14 : 0) - Math.max(0, st.toughness) * 0.3, 0, 1);
      return { terms: { forgiveness: Math.round(forgiveness * 100) / 100, what: g?.text ?? "you fell out" }, lines: [], outcome: {}, stakes: 0, brief: `${a.name} wants to make up with ${b.name}.` };
    },
    validate: (_c, raw) => raw,
    apply(world, conv, a, b) {
      a.cooldowns[`peace:${b.id}`] = world.time;
      if (bool(conv.outcome!.agreed)) {
        adjustRel(world, a, b.id, { affinity: 12, trust: 5 });
        adjustRel(world, b, a.id, { affinity: 14, trust: 6 });
        feel(a, { anger: -15, joy: 6 });
        feel(b, { anger: -20, joy: 4 });
        remember(world, a, { text: `${b.name} and I made up.`, kind: "social", importance: 5, valence: 0.6, people: [b.id], key: `peace:${b.id}` });
        remember(world, b, { text: `${a.name} said sorry, and we made up.`, kind: "social", importance: 5, valence: 0.6, people: [a.id], key: `peace:${a.id}` });
        // Whatever they meant to have out with each other, it's done.
        for (const [x, y] of [
          [a, b],
          [b, a],
        ] as const) {
          const bond = x.talk?.bonds[y.id];
          if (bond) bond.threads = bond.threads.filter((t) => t.kind !== "disagreement");
        }
        conv.summary = `${a.name} and ${b.name} made up.`;
        return news(`🤝 ${a.name} and ${b.name} patched things up.`, "social", 3);
      }
      adjustRel(world, a, b.id, { affinity: -3 });
      remember(world, a, { text: `I tried to make up with ${b.name}. They weren't having it.`, kind: "social", importance: 4, valence: -0.4, people: [b.id] });
      conv.summary = `${b.name} wouldn't make up with ${a.name}.`;
      return null;
    },
  },

  ask_out: {
    schema: { agreed: { type: "boolean" } },
    prepare(_world, _conv, a, b) {
      // Taken, too young or old for each other, not keen: or there's something there.
      const taken = inCouple(b);
      const r = getRel(b, a.id);
      const chemistry = (hashSeed(`${[a.id, b.id].sort().join(":")}:spark`) % 1000) / 1000;
      const spark = chemistry * 0.6 + compatibility(b, a) * 0.3 + r.affinity / 200;
      const ages = Math.abs(a.age - b.age) <= 14 && a.age >= 18 && b.age >= 18;
      const keen = !taken && ages && r.affinity >= 25 && spark > 0.45;
      const why = taken && taken !== a.id ? "You're with someone else." : !ages ? "They're not your type at all." : r.affinity < 25 ? "You hardly know them, and what you know you're not sure about." : "You like them, but not like that.";
      return { terms: { keen, why }, lines: [], outcome: {}, stakes: 0, brief: `${a.name} asks ${b.name} out.` };
    },
    validate: (_c, raw) => raw,
    apply(world, conv, a, b) {
      a.cooldowns[`askout:${b.id}`] = world.time;
      const sa = a.society;
      if (bool(conv.outcome!.agreed)) {
        addRole(a, b.id, "couple");
        addRole(b, a.id, "couple");
        adjustRel(world, a, b.id, { affinity: 15, trust: 8 });
        adjustRel(world, b, a.id, { affinity: 15, trust: 8 });
        feel(a, { joy: 30, love: 30, loneliness: -30 });
        feel(b, { joy: 20, love: 25, loneliness: -25 });
        remember(world, a, { text: `I asked ${b.name} out, and they said yes!`, kind: "social", importance: 8, valence: 0.95, people: [b.id], key: `couple:${b.id}` });
        remember(world, b, { text: `${a.name} asked me out. I said yes.`, kind: "social", importance: 8, valence: 0.9, people: [a.id], key: `couple:${a.id}` });
        if (sa) sa.crush = { who: b.id, since: world.time, stage: "together" };
        if (b.society) b.society.crush = { who: a.id, since: world.time, stage: "together" };
        conv.summary = `${b.name} said yes when ${a.name} asked them out.`;
        return news(`💕 ${a.name} and ${b.name} are seeing each other.`, "social", 4);
      }
      feel(a, { shame: 20, sadness: 15 });
      adjustRel(world, a, b.id, { affinity: -4 });
      remember(world, a, { text: `I asked ${b.name} out. They said no.`, kind: "social", importance: 6, valence: -0.6, people: [b.id], key: `turneddown:${b.id}` });
      remember(world, b, { text: `${a.name} asked me out. I said no.`, kind: "social", importance: 4, valence: -0.1, people: [a.id] });
      if (sa) sa.crush = { who: b.id, since: world.time, stage: "turned down" };
      setThought(world, a, `Well, that was embarrassing. ${b.name} said no.`, 3);
      conv.summary = `${b.name} turned ${a.name} down.`;
      return null;
    },
  },

  recruit: {
    schema: { agreed: { type: "boolean" }, amount: { type: "number" } },
    prepare(_world, conv, a, b) {
      const pr = a.society?.projects.find((p) => p.id === num(conv.agenda.projectId) && p.status === "active");
      if (!pr) return null;
      const need = Math.max(20, pr.need - pr.raised);
      const ask = Math.round(Math.min(need, num(conv.agenda.amount, need)));
      const r = getRel(b, a.id);
      const canPut = Math.floor(spare(b, 25) * (0.2 + b.traits.risk * 0.4 + b.traits.entrepreneurship * 0.15));
      const lean = (r.affinity + r.trust) / 200 + b.traits.risk * 0.35 + b.traits.entrepreneurship * 0.3 - b.traits.frugality * 0.2;
      const willing = canPut >= 15 && lean > 0.42 && !rememberBetrayal(b, a.id);
      return {
        terms: { projectId: pr.id, plan: pr.title.replace(/^./, (x) => x.toLowerCase()), need, ask, canPut, willing, why: canPut < 15 ? "you haven't got the money" : lean <= 0.42 ? "you don't trust it, or them, enough" : "" },
        lines: [],
        outcome: {},
        stakes: ask,
        brief: `${a.name} asks ${b.name} to come in on a plan.`,
      };
    },
    validate: (_c, raw) => raw,
    apply(world, conv, a, b) {
      const pr = a.society?.projects.find((p) => p.id === num(conv.terms.projectId));
      a.cooldowns[`recruit:${b.id}`] = world.time;
      const amount = num(conv.outcome!.amount);
      if (bool(conv.outcome!.agreed) && pr && amount > 0) {
        // A promise: they pay it in when the plan comes off (if they still have it then).
        pr.partners = [...new Set([...pr.partners, b.id])];
        pr.pledges = [...(pr.pledges ?? []).filter((x) => x.who !== b.id), { who: b.id, amount }];
        pr.raised = pr.pledges.reduce((s, x) => s + x.amount, 0);
        pr.log.push({ t: world.time, text: `${b.name} is in, with ${money(amount)}.`, good: true });
        remember(world, a, { text: `${b.name} is putting ${money(amount)} into my plan to ${String(conv.terms.plan)}.`, kind: "deal", importance: 7, valence: 0.8, people: [b.id] });
        remember(world, b, { text: `I put ${money(amount)} into ${a.name}'s plan to ${String(conv.terms.plan)}.`, kind: "deal", importance: 6, valence: 0.4, people: [a.id] });
        adjustRel(world, a, b.id, { affinity: 8, trust: 6 });
        adjustRel(world, b, a.id, { trust: 4 });
        conv.summary = `${b.name} promised ${money(amount)} for ${a.name}'s plan to ${String(conv.terms.plan)}.`;
        return news(`🤝 ${b.name} is backing ${a.name}'s plan to ${String(conv.terms.plan)} with ${money(amount)}.`, "business", 3);
      }
      if (pr) {
        pr.refused = [...new Set([...pr.refused, b.id])];
        pr.log.push({ t: world.time, text: `${b.name} said no.`, good: false });
      }
      remember(world, a, { text: `${b.name} wouldn't come in on my plan.`, kind: "social", importance: 4, valence: -0.4, people: [b.id] });
      conv.summary = `${b.name} passed on ${a.name}'s plan.`;
      return null;
    },
  },
};
