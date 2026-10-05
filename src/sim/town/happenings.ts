import { firstOfType } from "../city/lookup";
import { openBusinesses } from "../economy/business";
import { citizenAcc, externalAcc, transfer } from "../economy/ledger";
import { removeStock } from "../economy/market";
import { logEvent } from "../events";
import { remember } from "../memory/memory";
import { feel, feelingsToward } from "../mind/emotions";
import { placeName } from "../places";
import { chance, pick, randInt, randRange, weightedPick } from "../rng";
import { adjustRel, peekRel } from "../social/relationships";
import { dayOf, hourOf } from "../time";
import type { Business, Citizen, CitizenId, Emotions, Happening, HappeningKind, KnownNews, WorldState } from "../types";
import { clamp, money, newId, pushRing, round2 } from "../util";

// Town happenings: fires, break-ins, festivals, storms, lottery wins... They
// change the economy for a while (a burnt-out shop can't trade, a storm keeps
// shoppers at home) and, above all, they are news. People who were there know
// at once; everyone else hears it from the morning paper or, mostly, from each
// other. Each person takes it their own way (sorry for a friend, quietly glad
// about a rival, envious of a winner), and that's what they talk about.

export const HAPPENING_LIMIT = 40;
export const NEWS_LIMIT = 16;

export const HAPPENING_ICON: Record<HappeningKind, string> = {
  fire: "🔥",
  burglary: "🚨",
  festival: "🎪",
  storm: "⛈️",
  power_cut: "🔌",
  lottery: "🎟️",
  celebrity: "🌟",
  food_poisoning: "🤢",
  rent_rise: "🏠",
  sculpture: "🏛️",
  party: "🎉",
};

export const HAPPENING_LABEL: Record<HappeningKind, string> = {
  fire: "Fire at a business",
  burglary: "Break-in",
  festival: "Festival in the park",
  storm: "Storm",
  power_cut: "Power cut",
  lottery: "Lottery win",
  celebrity: "Celebrity visit",
  food_poisoning: "Food poisoning",
  rent_rise: "Rent rise",
  sculpture: "Mysterious column",
  party: "Party at the pub",
};

export const HAPPENING_KINDS = Object.keys(HAPPENING_ICON) as HappeningKind[];

/** How often each kind may happen (days between) and how likely it is. */
const RULES: Record<HappeningKind, { gapDays: number; weight: number; hours?: [number, number] }> = {
  fire: { gapDays: 5, weight: 0.6 },
  burglary: { gapDays: 3, weight: 0.6 },
  festival: { gapDays: 5, weight: 2.2, hours: [9, 15] },
  storm: { gapDays: 4, weight: 0.5 },
  power_cut: { gapDays: 4, weight: 0.4, hours: [8, 19] },
  lottery: { gapDays: 6, weight: 0.5 },
  celebrity: { gapDays: 4, weight: 0.5, hours: [9, 18] },
  food_poisoning: { gapDays: 5, weight: 0.35, hours: [7, 22] },
  rent_rise: { gapDays: 14, weight: 0.15, hours: [8, 18] },
  sculpture: { gapDays: 8, weight: 0.3 },
  party: { gapDays: 2, weight: 2.4, hours: [17, 20] },
};

// ---------------------------------------------------------------- lookups

export function happeningById(world: WorldState, id: number): Happening | undefined {
  return world.happenings.find((h) => h.id === id);
}

export function isActive(world: WorldState, h: Happening): boolean {
  return world.time >= h.t && world.time < h.until;
}

export function activeHappenings(world: WorldState): Happening[] {
  return world.happenings.filter((h) => isActive(world, h));
}

export function knows(c: Citizen, id: number): KnownNews | undefined {
  return c.news.find((n) => n.id === id);
}

function partOfDay(t: number): string {
  const h = hourOf(t);
  if (h < 5) return "in the middle of the night";
  if (h < 12) return "this morning";
  if (h < 17) return "this afternoon";
  if (h < 22) return "this evening";
  return "tonight";
}

// ----------------------------------------------------- effects on trade

/** Town-wide shopper numbers right now (storms and power cuts keep people in; festivals bring them out). */
export function townDemand(world: WorldState): number {
  let m = 1;
  for (const h of world.happenings) {
    if (h.ended || !isActive(world, h)) continue;
    if (h.kind === "storm") m *= 0.6;
    else if (h.kind === "power_cut") m *= 0.75;
    else if (h.kind === "festival") m *= 1.15;
  }
  return m;
}

/** Can this business trade, and how much do customers want it right now? */
export function businessFactor(world: WorldState, b: Business): { capacity: number; appeal: number } {
  if (b.closedUntil && world.time < b.closedUntil) return { capacity: 0, appeal: 1 };
  let capacity = 1;
  let appeal = 1;
  for (const h of world.happenings) {
    if (h.ended || !isActive(world, h)) continue;
    if (h.kind === "power_cut" && b.kind !== "stall") capacity = 0;
    if (h.kind === "celebrity" && h.businessId === b.id) appeal *= 1.7;
    if (h.kind === "festival" && (b.kind === "cafe" || b.kind === "stall")) appeal *= 1.2;
  }
  return { capacity, appeal };
}

export function isClosedByHappening(world: WorldState, b: Business): boolean {
  return businessFactor(world, b).capacity === 0;
}

// ------------------------------------------------- how people take it

/** -1..1: how this person takes the news. */
export function stanceOn(world: WorldState, c: Citizen, h: Happening): number {
  const p = c.personality.big5;
  let s = h.tone;
  if (h.subject && h.subject !== c.id) {
    const r = peekRel(c, h.subject);
    const f = feelingsToward(c, h.subject);
    const like = clamp(((r?.affinity ?? 0) + (f.gratitude ?? 0) + (f.love ?? 0) - (f.anger ?? 0) - (f.envy ?? 0) * 0.6) / 70, -1, 1);
    const family = c.family.includes(h.subject);
    if (h.tone < 0) {
      // Bad luck for them: sorry for a friend; a grudge-holder may be quietly glad.
      s = like < -0.35 && p.agreeableness < 0.45 ? 0.25 + -like * 0.3 : h.tone * (0.55 + Math.max(0, like) * 0.45 + (family ? 0.3 : 0));
    } else if (h.kind === "lottery" || h.kind === "celebrity") {
      // Good luck for them: glad for a friend; envious otherwise.
      const envious = c.emotions.envy / 100 + (1 - p.agreeableness) * 0.4 + c.traits.competitiveness * 0.3;
      s = family || like > 0.35 ? 0.6 + like * 0.3 : clamp(0.35 - envious, -0.7, 0.5);
    } else if (h.kind === "party") {
      s = like > 0.2 ? 0.7 : like < -0.3 ? -0.3 : 0.15 + p.extraversion * 0.3;
    }
  }
  if (h.subject === c.id) s = h.tone;
  switch (h.kind) {
    case "festival":
      s = 0.15 + p.extraversion * 0.7 - (c.personality.dislikes.includes("crowds") ? 0.5 : 0);
      break;
    case "sculpture":
      s = -0.2 + p.openness * 0.9;
      break;
    case "storm":
      s = -0.15 - p.neuroticism * 0.5;
      break;
    case "power_cut":
      s = -0.2 - (c.businessIds.length ? 0.4 : 0) - p.neuroticism * 0.2;
      break;
    case "rent_rise":
      s = -0.4 - Math.min(0.5, c.rentArrears / 100) - p.neuroticism * 0.2;
      break;
  }
  return round2(clamp(s, -1, 1));
}

function closeness(c: Citizen, other: CitizenId | null): number {
  if (!other || other === c.id) return 0;
  if (c.family.includes(other)) return 1;
  return clamp((peekRel(c, other)?.affinity ?? 0) / 60, 0, 1);
}

function reactionTo(world: WorldState, c: Citizen, h: Happening, stance: number): Partial<Emotions> {
  const p = c.personality.big5;
  const close = closeness(c, h.subject);
  const size = 0.6 + h.scale * 0.25;
  const e: Partial<Emotions> = {};
  const add = (k: keyof Emotions, v: number) => {
    if (Math.abs(v) >= 0.5) e[k] = (e[k] ?? 0) + v * size;
  };
  switch (h.kind) {
    case "storm":
      add("fear", 3 + p.neuroticism * 6);
      add("sadness", 2);
      break;
    case "power_cut":
      add("anger", 3 + (c.businessIds.length ? 4 : 0));
      break;
    case "festival":
      add("joy", Math.max(0, stance) * 10);
      add("loneliness", -3);
      break;
    case "sculpture":
      add("joy", Math.max(0, stance) * 6);
      break;
    case "rent_rise":
      add("fear", 6 + Math.max(0, -stance) * 10);
      add("anger", 4);
      break;
    default:
      if (stance < 0) {
        add("sadness", 3 + close * 10);
        if (h.kind === "burglary" || h.kind === "fire") add("fear", 2 + p.neuroticism * 6);
        if (h.kind === "food_poisoning") add("anger", 3);
        if ((h.kind === "lottery" || h.kind === "celebrity") && h.subject !== c.id) add("envy", 6 + -stance * 14);
      } else {
        add("joy", 3 + stance * 6 + close * 6);
        if (h.kind === "party" && close > 0.3) add("love", 4);
      }
  }
  return e;
}

/** They hear about it (or see it). Returns what they now know, or null if they already knew. */
export function learnNews(world: WorldState, c: Citizen, h: Happening, via: string): KnownNews | null {
  if (knows(c, h.id)) return null;
  const stance = stanceOn(world, c, h);
  const k: KnownNews = { id: h.id, t: world.time, via, stance, told: [] };
  c.news.push(k);
  if (c.news.length > NEWS_LIMIT) c.news.shift();
  if (via === "self") return k;
  const impulses = reactionTo(world, c, h, stance);
  const close = closeness(c, h.subject);
  const teller = world.citizens[via];
  if (h.scale >= 2 || close > 0.4) {
    remember(world, c, {
      text: teller
        ? `${teller.name} told me about ${teller.id === h.subject ? h.about.replace(new RegExp(`^${teller.name}'s `), "their ") : h.about}.`
        : via === "saw"
          ? `I saw ${h.about} with my own eyes.`
          : `Read about ${h.about} in the paper.`,
      kind: "world",
      importance: Math.min(9, 2 + h.scale + close * 2),
      valence: stance * 0.8,
      people: h.subject && h.subject !== c.id ? [h.subject] : [],
      key: `news:${h.id}`,
      feel: impulses,
    });
  } else {
    feel(c, impulses);
  }
  maybeHelp(world, c, h);
  return k;
}

/** A generous friend of the victim chips in. */
function maybeHelp(world: WorldState, c: Citizen, h: Happening): void {
  if (!h.subject || h.subject === c.id || h.tone >= 0) return;
  if (h.kind !== "fire" && h.kind !== "burglary" && h.kind !== "food_poisoning") return;
  if ((h.gifts ?? 0) >= 2 || world.time - h.t > 3 * 1440) return;
  const victim = world.citizens[h.subject];
  if (!victim) return;
  const close = closeness(c, victim.id);
  if (close < 0.75 || c.traits.generosity < 0.55 || c.money < 150) return;
  const amount = Math.min(60, Math.round((20 + c.traits.generosity * 30 + close * 10) / 5) * 5);
  if (!transfer(world, citizenAcc(c.id), citizenAcc(victim.id), amount, "gift", `Helping ${victim.name} after ${h.about}`)) return;
  h.gifts = (h.gifts ?? 0) + 1;
  remember(world, victim, { text: `${c.name} gave me ${money(amount)} to help after ${h.about}.`, kind: "favor", importance: 7, valence: 0.9, people: [c.id] });
  remember(world, c, { text: `I gave ${victim.name} ${money(amount)} after ${h.about}.`, kind: "social", importance: 4, valence: 0.5, people: [victim.id], feel: { joy: 4, pride: 3 } });
  adjustRel(world, victim, c.id, { affinity: 8, trust: 6 });
  logEvent(world, "town", `🎁 ${c.name} gave ${victim.name} ${money(amount)} to help after ${h.about}.`, 3, [c.id, victim.id]);
}

/** The freshest news they haven't passed on to everyone yet, and how keen they are to share it. */
export function hotNews(world: WorldState, c: Citizen): { h: Happening; k: KnownNews; heat: number } | null {
  let best: { h: Happening; k: KnownNews; heat: number } | null = null;
  for (const k of c.news) {
    const h = happeningById(world, k.id);
    if (!h) continue;
    const age = (world.time - k.t) / 60;
    if (age > 48) continue;
    const heat = (h.scale / 3) * (1 - age / 48) * (0.6 + Math.abs(k.stance) * 0.6) * (k.told.length >= 4 ? 0.3 : 1);
    if (!best || heat > best.heat) best = { h, k, heat };
  }
  return best;
}

// ------------------------------------------------------------- creation

export interface HappeningOptions {
  subject?: CitizenId | null;
  businessId?: string | null;
  source?: Happening["source"];
  /** Claude-written wording (kept if it fits). */
  title?: string;
  text?: string;
  about?: string;
}

function emptyHappening(world: WorldState, kind: HappeningKind, source: Happening["source"]): Happening {
  return { id: newId(world), kind, t: world.time, until: world.time, title: "", about: "", text: "", buildingId: null, subject: null, businessId: null, amount: 0, scale: 1, tone: 0, source };
}

function lastOf(world: WorldState, kind: HappeningKind): number {
  for (let i = world.happenings.length - 1; i >= 0; i--) if (world.happenings[i].kind === kind) return world.happenings[i].t;
  return -1e9;
}

/** Can this kind happen right now (time of day, spacing, someone or something to happen to)? */
export function canHappen(world: WorldState, kind: HappeningKind, forced = false): boolean {
  const rule = RULES[kind];
  const h = hourOf(world.time);
  if (rule.hours && (h < rule.hours[0] || h > rule.hours[1])) return false;
  if (!forced && world.time - lastOf(world, kind) < rule.gapDays * 1440) return false;
  if (activeHappenings(world).some((x) => x.kind === kind && kind !== "sculpture")) return false;
  if (kind === "rent_rise" && world.economy.rentIndex > 2.2) return false;
  return true;
}

/**
 * Make something happen. Picks who or what it happens to unless told.
 * Returns the happening, or a reason it can't happen right now.
 */
export function createHappening(world: WorldState, kind: HappeningKind, opts: HappeningOptions = {}): Happening | string {
  const source = opts.source ?? "world";
  const forced = source !== "world";
  if (!canHappen(world, kind, forced)) {
    const rule = RULES[kind];
    return rule.hours ? `That can only happen between ${rule.hours[0]}:00 and ${rule.hours[1] + 1}:00 (or one is already going on).` : "One is already going on.";
  }
  const h = emptyHappening(world, kind, source);
  const when = partOfDay(world.time);
  const people = world.citizenOrder.map((id) => world.citizens[id]);
  const witnesses = new Set<CitizenId>();
  const everyone = () => people.forEach((c) => witnesses.add(c.id));
  const inside = (bid: string | null) => people.filter((c) => bid && c.insideId === bid).forEach((c) => witnesses.add(c.id));
  const familyOf = (id: CitizenId) => world.citizens[id]?.family.forEach((f) => witnesses.add(f));
  // A named target is used when it fits; otherwise the town picks one.
  const pickBusiness = (ok: (b: Business) => boolean) => {
    const named = opts.businessId ? world.businesses[opts.businessId] : null;
    if (named && named.open && ok(named)) return named;
    const list = openBusinesses(world).filter(ok);
    return list.length ? pick(world, list) : null;
  };
  const pickCitizen = (ok: (c: Citizen) => boolean, weight: (c: Citizen) => number = () => 1) => {
    const named = opts.subject ? world.citizens[opts.subject] : null;
    if (named && ok(named)) return named;
    return weightedPick(world, people.filter(ok), weight);
  };

  switch (kind) {
    case "fire": {
      const b = pickBusiness((x) => x.kind !== "agency" && !(x.closedUntil && x.closedUntil > world.time));
      if (!b) return "There's no business that could catch fire.";
      const owner = world.citizens[b.ownerId];
      let lost = 0;
      for (const [pid, it] of Object.entries(b.inventory)) {
        const n = Math.floor(it.qty * randRange(world, 0.3, 0.65));
        if (n > 0) lost += removeStock(b.inventory, pid, n) * n;
      }
      b.closedUntil = world.time + Math.round(randRange(world, 16, 30)) * 60;
      b.reputation = clamp(b.reputation - 4, 0, 100);
      Object.assign(h, {
        until: b.closedUntil,
        title: `Fire at ${b.name}`,
        about: `the fire at ${b.name}`,
        text: `A fire broke out at ${b.name} ${when}. Nobody was hurt, but about ${money(lost)} of stock went up in smoke, and it's shut while ${owner?.name ?? "the owner"} cleans up.`,
        buildingId: b.buildingId,
        subject: b.ownerId,
        businessId: b.id,
        amount: round2(lost),
        scale: 3,
        tone: -0.7,
      });
      if (owner) {
        remember(world, owner, { text: `${b.name} caught fire. I lost ${money(lost)} of stock.`, kind: "business", importance: 9, valence: -0.9, people: [], feel: { fear: 25, sadness: 25 }, feelCtx: { fearOf: "business" } });
        familyOf(owner.id);
      }
      inside(b.buildingId);
      b.employees.forEach((e) => witnesses.add(e.citizenId));
      break;
    }
    case "burglary": {
      const v = pickCitizen((c) => c.money >= 40 && !!c.homeId && !c.homeless, (c) => Math.sqrt(c.money));
      if (!v) return "Nobody has anything worth stealing.";
      const amount = Math.max(15, Math.min(250, Math.round((v.money * randRange(world, 0.2, 0.4)) / 5) * 5));
      if (!transfer(world, citizenAcc(v.id), externalAcc("burglar"), amount, "theft", "Stolen in a break-in")) return "The burglar found nothing.";
      const home = placeName(world, v.homeId);
      Object.assign(h, {
        title: `Break-in at ${v.name}'s place`,
        about: `the break-in at ${v.name}'s place`,
        text: `Someone broke into ${v.name}'s home at ${home} ${when} and took ${money(amount)}.`,
        buildingId: v.homeId,
        subject: v.id,
        amount,
        scale: 2,
        tone: -0.6,
      });
      remember(world, v, { text: `Someone broke into my home and took ${money(amount)}.`, kind: "financial", importance: 8, valence: -0.9, people: [], feel: { fear: 28, anger: 20, sadness: 12 }, feelCtx: { fearOf: "poor" } });
      familyOf(v.id);
      people.filter((c) => c.homeId === v.homeId).forEach((c) => witnesses.add(c.id));
      break;
    }
    case "festival": {
      const park = firstOfType(world.map, "park");
      Object.assign(h, {
        until: Math.floor(world.time / 1440) * 1440 + 21 * 60,
        title: "Summer festival in the park",
        about: "the festival in the park",
        text: "There's a festival on in the park today: food stalls, music and a crowd. The cafés and stalls are busier than usual.",
        buildingId: park.id,
        scale: 2,
        tone: 0.6,
        crowd: [],
      });
      everyone();
      break;
    }
    case "storm": {
      Object.assign(h, {
        until: world.time + Math.round(randRange(world, 5, 10)) * 60,
        title: "Storm over Hustle City",
        about: "the storm",
        text: "A storm has rolled in. Rain is lashing down and most people are staying indoors.",
        scale: 1,
        tone: -0.4,
      });
      everyone();
      break;
    }
    case "power_cut": {
      Object.assign(h, {
        until: world.time + Math.round(randRange(world, 2, 4)) * 60,
        title: "Power cut across town",
        about: "the power cut",
        text: "The power's gone off across town. Shops, cafés and offices can't trade until it's back; only the market stalls carry on.",
        scale: 1,
        tone: -0.4,
      });
      everyone();
      break;
    }
    case "lottery": {
      const w = pickCitizen(() => true, (c) => 1 / (1 + Math.max(0, c.money + c.savings) / 400));
      if (!w) return "Nobody bought a ticket.";
      const amount = randInt(world, 25, 120) * 10;
      if (!transfer(world, externalAcc("lottery"), citizenAcc(w.id), amount, "prize", "Lottery win")) return "The lottery didn't pay out.";
      Object.assign(h, {
        title: `${w.name} won the lottery`,
        about: `${w.name}'s lottery win`,
        text: `${w.name} won ${money(amount)} on the lottery! Drinks are on them, apparently.`,
        subject: w.id,
        amount,
        scale: amount >= 700 ? 3 : 2,
        tone: 0.4,
      });
      remember(world, w, { text: `I won ${money(amount)} on the lottery!`, kind: "financial", importance: 8, valence: 1, people: [], feel: { joy: 40, pride: 8, fear: -15 } });
      familyOf(w.id);
      inside(w.insideId);
      break;
    }
    case "celebrity": {
      const b = pickBusiness((x) => x.kind !== "agency" && x.reputation >= 25 && !(x.closedUntil && x.closedUntil > world.time));
      if (!b) return "There's nowhere a celebrity would visit.";
      const owner = world.citizens[b.ownerId];
      b.reputation = clamp(b.reputation + 12, 0, 100);
      const who = pick(world, ["a famous food blogger", "a TV chef", "a pop star", "an influencer with a million followers", "a footballer"]);
      Object.assign(h, {
        until: world.time + 48 * 60,
        title: `A celebrity visited ${b.name}`,
        about: `the celebrity visit to ${b.name}`,
        text: `${who[0].toUpperCase()}${who.slice(1)} turned up at ${b.name} and raved about it online. People are queuing to get in.`,
        buildingId: b.buildingId,
        subject: b.ownerId,
        businessId: b.id,
        scale: 2,
        tone: 0.5,
      });
      if (owner) remember(world, owner, { text: `${who[0].toUpperCase()}${who.slice(1)} came to ${b.name} and loved it!`, kind: "business", importance: 8, valence: 0.9, people: [], feel: { pride: 25, joy: 20 } });
      inside(b.buildingId);
      if (owner) witnesses.add(owner.id);
      break;
    }
    case "food_poisoning": {
      const b = pickBusiness((x) => x.kind === "cafe" && !(x.closedUntil && x.closedUntil > world.time));
      if (!b) return "There's no café open.";
      const staff = new Set([b.ownerId, ...b.employees.map((e) => e.citizenId)]);
      const v = pickCitizen((c) => !staff.has(c.id));
      if (!v) return "Nobody ate there.";
      const owner = world.citizens[b.ownerId];
      b.reputation = clamp(b.reputation - 15, 0, 100);
      b.closedUntil = world.time + 12 * 60;
      v.needs.energy = clamp(v.needs.energy - 35, 0, 100);
      Object.assign(h, {
        until: b.closedUntil,
        title: `Food poisoning at ${b.name}`,
        about: `the food poisoning at ${b.name}`,
        text: `${v.name} was up all night after eating at ${b.name}. The café has shut for a deep clean and its reputation has taken a knock.`,
        buildingId: b.buildingId,
        subject: b.ownerId,
        businessId: b.id,
        scale: 2,
        tone: -0.5,
      });
      remember(world, v, { text: `I got food poisoning from ${b.name}. Never again.`, kind: "world", importance: 7, valence: -0.8, people: owner ? [owner.id] : [], feel: { anger: 18, sadness: 10 } });
      if (owner) {
        remember(world, owner, { text: `${v.name} got food poisoning from ${b.name}. We had to shut for a deep clean.`, kind: "business", importance: 8, valence: -0.8, people: [v.id], feel: { shame: 25, fear: 15 } });
        witnesses.add(owner.id);
      }
      witnesses.add(v.id);
      familyOf(v.id);
      break;
    }
    case "rent_rise": {
      const before = world.economy.rentIndex;
      world.economy.rentIndex = round2(before * 1.05);
      Object.assign(h, {
        title: "Landlords hike rents",
        about: "the rent rise",
        text: "Letters went out today: landlords are putting rents up another 5%. Everyone's grumbling about the cost of living.",
        scale: 2,
        tone: -0.6,
      });
      everyone();
      break;
    }
    case "sculpture": {
      const park = firstOfType(world.map, "park");
      Object.assign(h, {
        until: world.time + 1e7,
        title: "A mysterious column appeared in the park",
        about: "the mysterious column in the park",
        text: "A marble column appeared in the middle of the park overnight. Nobody knows who put it there, or why.",
        buildingId: park.id,
        scale: 1,
        tone: 0.2,
      });
      inside(park.id);
      break;
    }
    case "party": {
      const host = pickCitizen(
        (c) => c.traits.sociability > 0.4 && Object.values(c.relationships).filter((r) => r.affinity > 30).length >= 2,
        (c) => c.traits.sociability,
      );
      if (!host) return "Nobody has enough friends to throw a party.";
      const pub = firstOfType(world.map, "pub");
      Object.assign(h, {
        until: Math.floor(world.time / 1440) * 1440 + 23 * 60 + 59,
        title: `${host.name}'s birthday party at ${placeName(world, pub.id)}`,
        about: `${host.name}'s birthday party`,
        text: `${host.name} is throwing a birthday party at ${placeName(world, pub.id)} tonight, and all their friends are invited.`,
        buildingId: pub.id,
        subject: host.id,
        scale: 1,
        tone: 0.5,
        crowd: [],
      });
      witnesses.add(host.id);
      for (const [id, r] of Object.entries(host.relationships)) if (r.affinity > 30 && world.citizens[id]) witnesses.add(id);
      break;
    }
  }
  if (opts.title && opts.title.length <= 80) h.title = opts.title;
  if (opts.text && opts.text.length <= 300) h.text = opts.text;
  if (opts.about && opts.about.length <= 80) h.about = opts.about;
  pushRing(world.happenings, h, HAPPENING_LIMIT);
  logEvent(world, "town", `${HAPPENING_ICON[kind]} ${h.title}. ${h.text}`, h.scale + 1, h.subject ? [h.subject] : [], h.businessId);
  // Those who were there, or are told straight away, know already.
  if (h.subject) learnNews(world, world.citizens[h.subject], h, "self");
  for (const id of witnesses) {
    const c = world.citizens[id];
    if (c) learnNews(world, c, h, h.kind === "party" && id !== h.subject && h.subject ? h.subject : "saw");
  }
  return h;
}

// -------------------------------------------------------------- hourly

function wrapUp(world: WorldState, h: Happening): void {
  h.ended = true;
  const crowd = (h.crowd ?? []).map((id) => world.citizens[id]).filter(Boolean);
  switch (h.kind) {
    case "fire": {
      const b = h.businessId ? world.businesses[h.businessId] : null;
      if (b?.open) logEvent(world, "town", `🧯 ${b.name} reopened after the fire.`, 2, [b.ownerId], b.id);
      break;
    }
    case "food_poisoning": {
      const b = h.businessId ? world.businesses[h.businessId] : null;
      if (b?.open) logEvent(world, "town", `🧽 ${b.name} reopened after a deep clean.`, 1, [b.ownerId], b.id);
      break;
    }
    case "festival":
      logEvent(world, "town", `🎆 The festival wound down. ${crowd.length ? `${crowd.length} locals went along.` : "Hardly anyone went."}`, 2, crowd.map((c) => c.id).slice(0, 6));
      for (const c of crowd) remember(world, c, { text: "Had a lovely time at the festival in the park.", kind: "social", importance: 4, valence: 0.7, people: [], key: `fest:${h.id}`, feel: { joy: 6 } });
      break;
    case "party": {
      const host = h.subject ? world.citizens[h.subject] : null;
      if (!host) break;
      const guests = crowd.filter((c) => c.id !== host.id);
      logEvent(world, "town", `🎉 ${host.name}'s party: ${guests.length ? `${guests.length} ${guests.length === 1 ? "friend" : "friends"} came` : "nobody turned up"}.`, 2, [host.id, ...guests.map((g) => g.id)].slice(0, 6));
      if (guests.length === 0) remember(world, host, { text: "Nobody came to my party.", kind: "social", importance: 6, valence: -0.8, people: [], feel: { sadness: 20, loneliness: 15, shame: 8 } });
      else remember(world, host, { text: `Great party — ${guests.map((g) => g.name).join(", ")} came.`, kind: "social", importance: 5, valence: 0.8, people: guests.map((g) => g.id), feel: { joy: 12, love: 8 } });
      for (const g of guests) {
        remember(world, g, { text: `Had a great time at ${host.name}'s party.`, kind: "social", importance: 4, valence: 0.7, people: [host.id], feel: { joy: 6 } });
        adjustRel(world, g, host.id, { affinity: 4, familiarity: 3 });
        adjustRel(world, host, g.id, { affinity: 5, familiarity: 3 });
      }
      break;
    }
    case "storm":
      logEvent(world, "town", "🌤️ The storm has passed.", 1);
      break;
    case "power_cut":
      logEvent(world, "town", "💡 The power's back on.", 1);
      break;
  }
}

/** The morning paper: some people read about yesterday's bigger news. */
function morningPaper(world: WorldState): void {
  const recent = world.happenings.filter((h) => h.scale >= 2 && world.time - h.t < 30 * 60);
  if (recent.length === 0) return;
  for (const id of world.citizenOrder) {
    const c = world.citizens[id];
    for (const h of recent) {
      if (knows(c, h.id)) continue;
      if (chance(world, 0.2 + c.personality.big5.openness * 0.25)) learnNews(world, c, h, "paper");
    }
  }
}

function pickKind(world: WorldState): HappeningKind | null {
  const options = (Object.keys(RULES) as HappeningKind[]).filter((k) => canHappen(world, k));
  return weightedPick(world, options, (k) => RULES[k].weight);
}

/** Hourly: start something new now and then, run the ongoing ones, wrap up the finished. */
export function happeningsHourly(world: WorldState): void {
  const hour = hourOf(world.time);
  for (const h of world.happenings) {
    if (h.ended) continue;
    if (world.time >= h.until) {
      wrapUp(world, h);
      continue;
    }
    if (h.kind === "festival" || h.kind === "party") {
      for (const id of world.citizenOrder) {
        const c = world.citizens[id];
        if (c.insideId !== h.buildingId || c.activity.kind === "sleep") continue;
        if (h.crowd && !h.crowd.includes(c.id)) h.crowd.push(c.id);
        if (!knows(c, h.id)) learnNews(world, c, h, "saw");
        feel(c, h.kind === "festival" ? { joy: 3, loneliness: -4 } : { joy: 4, loneliness: -5 }, { social: true });
      }
    }
  }
  if (hour === 7) morningPaper(world);
  if (world.time >= world.nextHappeningT) {
    const kind = pickKind(world);
    if (kind) {
      createHappening(world, kind);
      let next = world.time + Math.round(randRange(world, 14, 34)) * 60;
      if (hourOf(next) < 7 && chance(world, 0.7)) next += (8 - hourOf(next)) * 60;
      world.nextHappeningT = next;
    } else {
      world.nextHappeningT = world.time + 60;
    }
  }
}

/** Old saves and fresh worlds: nothing has happened yet. */
export function firstHappeningT(world: WorldState): number {
  return (dayOf(world.time) + 1) * 1440 + 10 * 60;
}
