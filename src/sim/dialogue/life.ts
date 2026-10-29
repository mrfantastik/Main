import { situation } from "../ai/situation";
import { outstanding } from "../economy/bank";
import { placeName } from "../places";
import { dayOf } from "../time";
import type { Citizen, Memory, WorldState } from "../types";
import { money } from "../util";
import { workplaceKey } from "./bonds";
import { cuesOf, toThird } from "./grammar";
import { learn } from "./knowledge";
import type { Fact, FactPred, TopicKind } from "./types";

// What each person has going on in their own life, as things they could
// bring up: what's happened to them lately (their memories), what they're
// trying to do (their goal and money situation), what's worrying them, and,
// for the people closest to them, their hopes and fears. Each comes in their
// own words ("I lost my job at Mike's stall") and as the gist others would
// pass on ("Ben lost their job at Mike's stall").
//
// Plans come with a way to find out later how they went, from what actually
// happened in the town (did they get the job? open the stall? pay Sarah
// back?), so a follow-up a few days on has a true answer.
//
// And knowledge that comes with a job: when something big happens to someone
// at work, the people they work with hear about it.

export interface LifeItem {
  key: string;
  pred: FactPred;
  kind: TopicKind;
  /** As they'd say it. */
  first: string;
  /** As others would pass it on. */
  gist: string;
  /** Short topic label ("losing the job at Mike's stall"). */
  label: string;
  sensitivity: number;
  valence: number;
  importance: number;
  /** For a plan: when they'll know how it went. */
  when: number | null;
  /** What a listener would mean to ask next time ("Ask how Ben's job hunt went"). */
  follow?: string;
  memory?: number;
  t: number;
}

const DREAM_LINE: Record<string, string> = {
  "owning the busiest shop in town": "One day I want the busiest shop in town.",
  "being their own boss": "I want to be my own boss. Answer to nobody.",
  "retiring by the sea": "All I want is to retire by the sea.",
  "inventing something everyone uses": "I want to invent something everyone uses. Daft, maybe.",
  "buying a proper house for their family": "I want to buy a proper house for my family.",
  "being the richest person in Hustle City": "I'm going to be the richest person in this town. You watch.",
  "never worrying about rent again": "I just want to never worry about rent again.",
  "being respected at CityCorp": "I want to be someone at CityCorp. Actually respected.",
  "travelling the world on their own money": "I want to see the world. On my own money.",
};

const FEAR_LINE: Record<string, string> = {
  "ending up on the streets": "I'm scared of ending up on the streets. Properly scared.",
  "dying poor": "I'm scared I'll die skint.",
  "ending up alone": "I'm scared of ending up on my own.",
  "being a failure": "I think I'm scared of being a failure, if I'm honest.",
  "losing everything they've built": "I'm scared of losing everything I've built.",
  "letting their family down": "I'm scared of letting my family down.",
};

/** Memories not worth bringing up in conversation. */
const DULL = /^(Met |A visitor|Talked with |I bought |Read about |Heard about |Saw |CityCorp had no openings)/;

function sensitivityOf(m: Memory): number {
  // Bad luck (a theft, a break-in) isn't a secret; money trouble is.
  if (/\b(stole|stolen|broke into|burgled|robbed)\b/i.test(m.text)) return 0.25;
  if (m.valence < -0.4 && (m.kind === "financial" || m.kind === "loan")) return 0.7;
  if (m.kind === "betrayal") return 0.5;
  if (m.valence < -0.3 && m.kind === "job") return 0.45;
  if (m.kind === "social" && m.valence < 0) return 0.55;
  if (m.valence > 0.4) return 0.12;
  return 0.3;
}

function labelOf(m: Memory): string {
  const t = m.text.replace(/[.!?].*$/, "");
  if (/evicted/.test(t)) return "being evicted";
  if (/rent/.test(t) && m.valence < 0) return "the rent";
  if (/hired me|gave me a job|took me on/.test(t)) return "the new job";
  if (/fired|laid off|lost my job/.test(t)) return "losing the job";
  if (/opened /.test(t) && m.kind === "business") return "the new business";
  if (/closed|bankrupt/.test(t) && m.kind === "business") return "the business closing";
  if (/defaulted/.test(t)) return "the loan";
  if (/lent me|borrowed/.test(t)) return "the money they borrowed";
  if (/trading/.test(t)) return "trading";
  if (/invented/.test(t)) return "the invention";
  if (/turned (me )?down/.test(t)) return "getting turned down";
  const friend = t.match(/^(\w+) and I have become friends/);
  if (friend) return `getting to know ${friend[1]}`;
  if (/festival/.test(t)) return "the festival";
  // A short label: the first "the ..." in it ("the break-in"), or just "their news".
  const stolen = t.match(/\bstole (?:my|the|a) ([a-z-]+)/);
  if (stolen) return `the stolen ${stolen[1]}`;
  const thing = t.match(/\b(?:the|a|my) ([a-z-]+(?: [a-z-]+)?)(?= (?:at|in|on|with|for|from)\b|$)/);
  return thing ? `the ${thing[1]}` : t.length < 32 && !/^I\b/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : "their news";
}

/** Things they could bring up about their own life (most significant first). */
export function lifeItems(world: WorldState, c: Citizen): LifeItem[] {
  const out: LifeItem[] = [];
  const today = dayOf(world.time);
  const seen = new Set<number>();
  // What's happened to them lately (and the big things from a bit longer ago).
  for (const m of [...c.memories.short, ...c.memories.long]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const age = today - dayOf(m.t);
    // Town news is talked about as news (it has its own topic), not as their life.
    if (m.kind === "conversation" || m.kind === "world" || DULL.test(m.text)) continue;
    if (!(age <= 3 && m.importance >= 4) && !(age <= 10 && m.importance >= 7)) continue;
    // Borrowing to make the rent is a worry, however relieved they were at the time.
    const debt = m.kind === "loan" || /\b(lent me|borrowed)\b/.test(m.text);
    const good = m.valence > 0.35 && !debt;
    const bad = m.valence < -0.3 || debt;
    out.push({
      key: `mem:${c.id}:${m.id}`,
      pred: "event",
      kind: bad ? (m.kind === "job" || m.kind === "betrayal" ? "complain" : "problem") : good && ["financial", "business", "job", "deal"].includes(m.kind) ? "brag" : "disclose",
      // "I opened Ruby's Coffee Stall" -> "I opened my own coffee stall".
      first: m.text.replace(new RegExp(`\\b${c.name}'s ([A-Z][\\w.]*(?: [A-Z][\\w.]*)*)`, "g"), (_, b: string) => `my ${b.toLowerCase()}`),
      gist: toThird(m.text, c.name),
      label: labelOf(m),
      sensitivity: sensitivityOf(m),
      valence: debt ? Math.min(m.valence, -0.3) : m.valence,
      importance: m.importance - age * 0.4,
      when: null,
      memory: m.id,
      t: m.t,
    });
  }
  // What they're trying to do, with a way to tell later how it went.
  const s = situation(world, c);
  const weekEnd = world.time + Math.max(1, s.rentDueIn) * 1440;
  const plan = (key: string, first: string, gist: string, label: string, days: number, follow: string, sens = 0.3, imp = 5) =>
    out.push({ key: `plan:${key}:${c.id}:${Math.floor(world.time / 1440 / 3)}`, pred: "plan", kind: "plan", first, gist, label, sensitivity: sens, valence: 0, importance: imp, when: world.time + days * 1440, follow, t: world.time });
  switch (c.goal.kind) {
    case "find_job":
      plan("job", "I'm trying to get taken on somewhere. CityCorp, if they'll have me.", `${c.name} is looking for work, trying CityCorp`, "the job hunt", 1.5, `Ask ${c.name} if they found work`, 0.35, 6);
      break;
    case "save_for_business":
      plan("biz", "I'm saving up to start something of my own.", `${c.name} is saving up to start their own business`, "starting a business", 5, `Ask ${c.name} if they ever started that business`, 0.3, 5);
      break;
    case "repay_debt": {
      const l = world.loans.find((x) => x.borrower === c.id && x.status === "active");
      const lender = l ? world.citizens[l.lender] : undefined;
      if (l)
        plan(
          "debt",
          lender ? `I've got to pay ${lender.name} back. ${money(outstanding(l))}.` : `I've got a loan to pay off. ${money(outstanding(l))}.`,
          lender ? `${c.name} owes ${lender.name} ${money(outstanding(l))}` : `${c.name} has a loan to pay off`,
          "paying the loan back",
          Math.max(1, (l.dueT - world.time) / 1440),
          `Ask ${c.name} if they paid ${lender?.name ?? "the loan"} back`,
          0.6,
          5,
        );
      break;
    }
    case "pay_rent":
      plan("rent", `Rent's due ${s.rentDueIn <= 1 ? "tomorrow" : "in a couple of days"} and I'm short.`, `${c.name} is short for the rent`, "the rent", Math.max(1, (weekEnd - world.time) / 1440), `Ask ${c.name} if they made the rent`, 0.65, 6);
      break;
    case "grow_business":
    case "save_business": {
      const b = c.businessIds.map((id) => world.businesses[id]).find((x) => x && x.open);
      if (b) plan("shop", c.goal.kind === "save_business" ? `${b.name}'s struggling. I'm trying to keep it going.` : `I'm trying to get ${b.name} busier.`, c.goal.kind === "save_business" ? `${b.name} is struggling` : `${c.name} is trying to grow ${b.name}`, "the business", 4, `Ask ${c.name} how ${b.name} is doing`, c.goal.kind === "save_business" ? 0.55 : 0.15, 5);
      break;
    }
  }
  if (s.worry && !out.some((x) => x.kind === "problem"))
    out.push({ key: `worry:${c.id}:${dayOf(world.time)}`, pred: "problem", kind: "problem", first: s.worry, gist: toThird(s.worry, c.name), label: "money worries", sensitivity: 0.7, valence: -0.6, importance: 6, when: null, t: world.time });
  // The deep stuff (only ever told to someone close).
  const dream = DREAM_LINE[c.personality.dream] ?? `One day I want ${c.personality.dream.replace(/\btheir\b/g, "my")}.`;
  const fear = FEAR_LINE[c.personality.fear] ?? `I'm scared of ${c.personality.fear.replace(/\btheir\b/g, "my")}.`;
  out.push({ key: `dream:${c.id}`, pred: "plan", kind: "disclose", first: dream, gist: `${c.name} dreams of ${c.personality.dream}`, label: "what they want out of life", sensitivity: 0.55, valence: 0.3, importance: 3, when: null, t: 0 });
  out.push({ key: `fear:${c.id}`, pred: "problem", kind: "disclose", first: fear, gist: `${c.name} is scared of ${c.personality.fear}`, label: "what scares them", sensitivity: 0.75, valence: -0.4, importance: 3, when: null, t: 0 });
  return out.sort((a, b) => b.importance - a.importance);
}

/** How a plan someone mentioned actually went, from what happened since (null: no way to tell yet). */
export function howItWent(world: WorldState, c: Citizen, f: Fact): { first: string; valence: number; settled: boolean } | null {
  // A plan's kind is in its key; a trouble's, in what was said.
  const k0 = f.key.split(":")[1];
  const kind = ["job", "biz", "debt", "rent", "shop"].includes(k0) ? k0 : /evict|rent/.test(f.text) ? "rent" : /fired|laid off|lost (their|my) job|unemployed/.test(f.text) ? "job" : /lent|borrow|owe/.test(f.text) ? "debt" : /business|stall|shop|café/i.test(f.text) && f.valence < 0 ? "shop" : f.pred === "problem" || f.valence < -0.25 ? "trouble" : k0;
  const since = (m: Memory) => m.t >= f.learnedAt - 60;
  const mems = [...c.memories.short, ...c.memories.long].filter(since);
  switch (kind) {
    case "job": {
      if (c.occupation !== "unemployed" && c.occupationSince >= f.learnedAt - 60) {
        const where = c.employerId === "corp" ? "CityCorp" : (world.businesses[c.employerId ?? ""]?.name ?? null);
        return { first: where ? `Got it. I'm at ${where} now.` : `I'm working again. ${c.occupation === "employee" ? "Got taken on." : `Doing ${c.occupation} stuff.`}`, valence: 0.7, settled: true };
      }
      if (mems.some((m) => /turned down my application|turned me down/.test(m.text))) return { first: "They turned me down.", valence: -0.6, settled: false };
      if (mems.some((m) => /no openings/.test(m.text))) return { first: "No openings. Same as always.", valence: -0.4, settled: false };
      return { first: "Nothing yet.", valence: -0.2, settled: false };
    }
    case "biz": {
      const opened = c.businessIds.map((id) => world.businesses[id]).find((b) => b && b.open && b.foundedT >= f.learnedAt - 60);
      if (opened) return { first: `I did it. ${opened.name}. It's open.`, valence: 0.8, settled: true };
      return { first: "Still saving. Slowly.", valence: -0.1, settled: false };
    }
    case "debt": {
      const owing = world.loans.some((l) => l.borrower === c.id && l.status === "active");
      if (!owing) return { first: "All paid off. Finally.", valence: 0.6, settled: true };
      const late = world.loans.some((l) => l.borrower === c.id && l.status === "active" && world.time > l.dueT);
      return late ? { first: "Not yet. I'm late with it, if I'm honest.", valence: -0.6, settled: false } : { first: "Getting there.", valence: 0, settled: false };
    }
    case "rent":
      return c.rentArrears > 0 ? { first: `No. I'm behind. I owe the landlord ${money(c.rentArrears)}.`, valence: -0.7, settled: false } : c.homeless ? { first: "No. I'm out on my ear.", valence: -1, settled: true } : { first: "Just about. Scraped it together.", valence: 0.4, settled: true };
    case "shop": {
      const b = c.businessIds.map((id) => world.businesses[id]).find((x) => x && x.open);
      if (!b) return c.businessIds.length ? { first: "It's gone. I had to shut it.", valence: -0.9, settled: true } : null;
      return b.avgProfit > 25 ? { first: "Better, actually. Picking up.", valence: 0.5, settled: false } : { first: "Still quiet. Too quiet.", valence: -0.4, settled: false };
    }
    case "trouble": {
      // However they're doing now.
      const e = c.emotions;
      const low = Math.max(e.sadness, e.fear, e.anger, e.shame) > 45 || c.rentArrears > 0;
      return low ? { first: "Not really, no. Still getting to me.", valence: -0.4, settled: false } : { first: "Better, thanks. Getting there.", valence: 0.3, settled: true };
    }
  }
  return null;
}

/** Where they are, as people say it ("the pub", "work"). */
export function placeFor(world: WorldState, c: Citizen): string {
  return placeName(world, c.insideId);
}

/**
 * Something big happened to someone (a memory just made): the people they
 * work with hear about it at work. Only work-related, significant things.
 */
export function workGrapevine(world: WorldState, c: Citizen, m: Memory): void {
  if (m.importance < 6 || !["job", "business", "betrayal", "financial"].includes(m.kind)) return;
  if (m.kind === "financial" && !/evicted|defaulted|closed|bankrupt/.test(m.text)) return;
  const wk = workplaceKey(world, c) ?? (m.kind === "job" ? c.employerId : null);
  if (!wk) return;
  const names = world.citizenOrder.map((id) => world.citizens[id].name);
  const gist = toThird(m.text, c.name);
  for (const id of world.citizenOrder) {
    const o = world.citizens[id];
    if (o.id === c.id || workplaceKey(world, o) !== wk) continue;
    learn(world, o, { about: c.id, pred: "event", key: `mem:${c.id}:${m.id}`, text: gist, cues: cuesOf(gist, names), source: "work", certainty: 0.7, sensitivity: Math.min(0.5, sensitivityOf(m)), valence: m.valence, importance: m.importance - 1, memory: m.id });
  }
}
