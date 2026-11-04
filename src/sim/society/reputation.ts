import { logEvent } from "../events";
import { remember } from "../memory/memory";
import { feel } from "../mind/emotions";
import { hashSeed, rand } from "../rng";
import { adjustRel, removeRole } from "../social/relationships";
import type { Citizen, CitizenId, WorldState } from "../types";
import { societyWorld } from "./state";

// What the town makes of people, worked out from the town itself (never
// stored, so it can't drift from what actually happened): how the people
// who know someone feel about them, what they're known for, who's on whose
// side. Also the slow consequences: lies found out, couples splitting up.

export interface Reputation {
  /** How the people who know them feel about them, on average (-100..100). */
  standing: number;
  trust: number;
  /** How many people know them well enough to have a view. */
  knownBy: number;
  /** What they're known for ("generous", "owes money", "stirs things up"). */
  tags: string[];
}

export function reputationOf(world: WorldState, c: Citizen): Reputation {
  let sum = 0;
  let trust = 0;
  let n = 0;
  for (const id of world.citizenOrder) {
    if (id === c.id) continue;
    const r = world.citizens[id].relationships[c.id];
    if (!r || r.familiarity < 10) continue;
    const w = Math.min(1, r.familiarity / 50);
    sum += r.affinity * w;
    trust += r.trust * w;
    n += w;
  }
  const standing = n ? Math.round(sum / n) : 0;
  const tags: string[] = [];
  if (n >= 3 && standing >= 35) tags.push("well liked");
  if (n >= 3 && standing <= -15) tags.push("not well liked");
  const overdue = world.loans.some((l) => l.borrower === c.id && (l.status === "defaulted" || (l.status === "active" && world.time > l.dueT)));
  if (overdue) tags.push("owes money");
  const recent = (c.society?.decisions ?? []).filter((d) => world.time - d.t < 7 * 1440 && d.status === "done");
  if (recent.filter((d) => d.action.type === "help" || d.action.type === "lend").length >= 2) tags.push("generous");
  const sw = world.society;
  const lies = (sw?.rumours ?? []).filter((r) => r.origin === c.id);
  if (lies.some((r) => !r.truth && (r.exposed?.length ?? 0) > 0)) tags.push("caught telling lies");
  else if (lies.length >= 2) tags.push("stirs things up");
  if (Object.values(c.relationships).some((r) => r.roles.includes("rival"))) tags.push("has a rival");
  const biz = c.businessIds.map((id) => world.businesses[id]).find((b) => b?.open && b.ownerId === c.id);
  if (biz && biz.avgProfit > 40) tags.push("doing well");
  return { standing, trust: n ? Math.round(trust / n) : 0, knownBy: Math.round(n), tags };
}

/** A tag as words after "they're" ("people say they're in debt"). */
export const TAG_WORDS: Record<string, string> = {
  "well liked": "well liked",
  "not well liked": "not well liked",
  "owes money": "in debt",
  generous: "generous",
  "caught telling lies": "a liar",
  "stirs things up": "a stirrer",
  "has a rival": "in a feud",
  "doing well": "doing well",
};

/** Friends who can't stand the same person: on each other's side against them. */
export function alliesOf(world: WorldState, c: Citizen): { ally: CitizenId; against: CitizenId }[] {
  const out: { ally: CitizenId; against: CitizenId }[] = [];
  const foes = Object.entries(c.relationships).filter(([, r]) => r.affinity < -20).map(([id]) => id);
  if (!foes.length) return out;
  for (const [id, r] of Object.entries(c.relationships)) {
    const o = world.citizens[id];
    if (!o || r.affinity < 35 || (o.relationships[c.id]?.affinity ?? 0) < 35) continue;
    for (const f of foes) if (f !== id && (o.relationships[f]?.affinity ?? 0) < -20) out.push({ ally: id, against: f });
  }
  return out;
}

/**
 * Every night: some of the people who believed a made-up story see through
 * it (the better they know the person it was about, the likelier), and
 * think less of whoever told them; couples who've fallen out split up.
 */
export function reputationDaily(world: WorldState): void {
  const sw = societyWorld(world);
  for (const rm of sw.rumours) {
    if (rm.truth || world.time - rm.t > 10 * 1440) continue;
    const about = world.citizens[rm.about];
    const origin = world.citizens[rm.origin];
    if (!about) continue;
    for (const id of world.citizenOrder) {
      if (id === rm.origin || id === rm.about || rm.exposed?.includes(id)) continue;
      const c = world.citizens[id];
      const f = (c.talk?.facts ?? []).find((x) => x.rumour === rm.id && x.certainty > 0.2);
      if (!f) continue;
      const r = { rng: hashSeed(`${world.seed}:${rm.id}:${id}:${Math.floor(world.time / 1440)}:exposed`) };
      const knowThem = (c.relationships[about.id]?.familiarity ?? 0) / 150 + (world.time - (c.relationships[about.id]?.lastT ?? -1e9) < 2 * 1440 ? 0.15 : 0);
      if (rand(r) >= 0.06 + knowThem + c.personality.big5.conscientiousness * 0.1) continue;
      // They see through it.
      f.certainty = 0.05;
      f.valence = 0;
      (rm.exposed ??= []).push(id);
      adjustRel(world, c, about.id, { affinity: 4, trust: 5 });
      const teller = f.from ? world.citizens[f.from] : undefined;
      if (teller && teller.id !== about.id) adjustRel(world, c, teller.id, { trust: -6 });
      // Whoever made it up, if they know who that was.
      if (origin && (f.from === origin.id || f.origin === origin.id || f.chain?.includes(origin.id))) {
        adjustRel(world, c, origin.id, { affinity: -8, trust: -15 });
        remember(world, c, { text: `Turns out what ${origin.name} said about ${about.name} was a lie.`, kind: "social", importance: 5, valence: -0.4, people: [origin.id, about.id], key: `lie:${rm.id}`, feel: { anger: 6 } });
      } else remember(world, c, { text: `That story about ${about.name} turned out to be rubbish.`, kind: "social", importance: 3, valence: 0, people: [about.id], key: `lie:${rm.id}` });
    }
    if ((rm.exposed?.length ?? 0) >= 2 && !rm.outed && origin) {
      rm.outed = true;
      logEvent(world, "social", `🤥 People are starting to realise ${origin.name} made up that story about ${about.name}.`, 3, [origin.id, about.id]);
      remember(world, origin, { text: `People have worked out I made up that story about ${about.name}.`, kind: "social", importance: 5, valence: -0.5, people: [about.id], feel: { shame: 10, fear: 5 } });
    }
  }
  // Couples who can't stand each other any more.
  for (const id of world.citizenOrder) {
    const c = world.citizens[id];
    for (const [oid, r] of Object.entries(c.relationships)) {
      if (oid < id || !r.roles.includes("couple")) continue;
      const o = world.citizens[oid];
      const back = o?.relationships[id];
      if (!o || !back) continue;
      if (r.affinity > -5 && back.affinity > -5) continue;
      removeRole(c, oid, "couple");
      removeRole(o, id, "couple");
      for (const [x, y] of [
        [c, o],
        [o, c],
      ] as const) {
        remember(world, x, { text: `${y.name} and I have split up.`, kind: "social", importance: 8, valence: -0.7, people: [y.id], feel: { sadness: 25, anger: 10 } });
        feel(x, { sadness: 10 });
      }
      logEvent(world, "social", `💔 ${c.name} and ${o.name} have split up.`, 4, [c.id, o.id]);
    }
  }
}

/** Someone hears a story about themselves: they're hurt, and angry with whoever's saying it. */
export function heardAboutMe(world: WorldState, c: Citizen, from: CitizenId | undefined): void {
  const who = from ? world.citizens[from] : undefined;
  remember(world, c, { text: who ? `${who.name} has been telling stories about me.` : "Someone's been telling stories about me.", kind: "social", importance: 6, valence: -0.6, people: from ? [from] : [], key: `stories:${from ?? "?"}`, feel: { anger: 12, shame: 6 } });
  if (from) adjustRel(world, c, from, { affinity: -6, trust: -8 });
}
