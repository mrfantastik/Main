import { DISLIKES, DREAMS, FEARS, LIKES, ORIGINS, QUIRKS, TURNS, VALUE_WORDS, type FearKey } from "../data/personality";
import { hashSeed, rand, type RngHolder } from "../rng";
import type { BigFive, Citizen, CoreValue, Personality, SpeakingStyle } from "../types";
import { clamp } from "../util";

// Personality: who someone is beyond their economic traits. Generated once
// from the world seed and the citizen's id, using its own random stream so
// the city itself is laid out exactly as before, and an old save gets the
// very same personalities when it is upgraded.

function noise(r: RngHolder, size: number): number {
  return (rand(r) - 0.5) * 2 * size;
}

/** Pick `n` distinct items, each weighted. */
function weightedDistinct<T>(r: RngHolder, items: readonly T[], weight: (t: T) => number, n: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < n && pool.length) {
    const w = pool.map((x) => Math.max(0.01, weight(x)));
    let k = rand(r) * w.reduce((a, b) => a + b, 0);
    let i = 0;
    for (; i < pool.length - 1; i++) {
      if (k < w[i]) break;
      k -= w[i];
    }
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

export function neutralPersonality(): Personality {
  return {
    big5: { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.5 },
    values: ["security", "community"],
    quirks: [],
    style: "warm",
    likes: [],
    dislikes: [],
    fear: FEARS.poor,
    dream: "never worrying about rent again",
    backstory: "",
  };
}

export function generatePersonality(seed: number, c: Citizen): Personality {
  const r: RngHolder = { rng: hashSeed(`${seed}:${c.id}:personality`) };
  const t = c.traits;
  const curious = c.archetypes.includes("Curious");
  const big5: BigFive = {
    openness: clamp(0.3 + (curious ? 0.3 : 0) + t.risk * 0.25 + t.entrepreneurship * 0.15 - t.frugality * 0.1 + noise(r, 0.12), 0.05, 0.95),
    conscientiousness: clamp(0.1 + t.diligence * 0.6 + t.frugality * 0.25 + noise(r, 0.1), 0.05, 0.95),
    extraversion: clamp(0.08 + t.sociability * 0.8 + noise(r, 0.1), 0.05, 0.95),
    agreeableness: clamp(t.generosity * 0.5 + (1 - t.greed) * 0.25 + (1 - t.competitiveness) * 0.25 + noise(r, 0.1), 0.05, 0.95),
    neuroticism: clamp(0.6 - t.risk * 0.35 + (1 - t.diligence) * 0.1 + noise(r, 0.18), 0.05, 0.95),
  };

  const hasFamily = c.family.length > 0;
  const valueScore: Record<CoreValue, number> = {
    family: (hasFamily ? 0.55 : 0.1) + t.generosity * 0.3,
    status: t.ambition * 0.5 + t.competitiveness * 0.4,
    freedom: t.entrepreneurship * 0.6 + t.risk * 0.3,
    security: t.frugality * 0.5 + (1 - t.risk) * 0.4,
    fairness: t.generosity * 0.35 + big5.agreeableness * 0.4 + (1 - t.greed) * 0.2,
    wealth: t.greed * 0.7 + t.ambition * 0.2,
    community: t.sociability * 0.45 + t.generosity * 0.3,
    knowledge: big5.openness * 0.55 + (c.occupation === "researcher" ? 0.4 : 0),
  };
  const ranked = (Object.keys(valueScore) as CoreValue[]).map((v) => ({ v, s: valueScore[v] + rand(r) * 0.25 })).sort((a, b) => b.s - a.s);
  const values = ranked.slice(0, rand(r) < 0.5 ? 2 : 3).map((x) => x.v);

  const styleScore: Record<SpeakingStyle, number> = {
    formal: big5.conscientiousness * 0.6 + (1 - big5.extraversion) * 0.4,
    blunt: (1 - big5.agreeableness) * 0.6 + t.competitiveness * 0.4,
    chatty: big5.extraversion * 0.7 + big5.openness * 0.2,
    sarcastic: big5.openness * 0.35 + t.greed * 0.3 + (1 - big5.agreeableness) * 0.35,
    warm: big5.agreeableness * 0.6 + big5.extraversion * 0.3,
    nervous: big5.neuroticism * 0.8 + (1 - big5.extraversion) * 0.2,
  };
  const style = (Object.keys(styleScore) as SpeakingStyle[]).map((k) => ({ k, s: styleScore[k] + rand(r) * 0.3 })).sort((a, b) => b.s - a.s)[0].k;

  const quirks = weightedDistinct(r, QUIRKS, () => 1, 2) as string[];
  const likes = weightedDistinct(
    r,
    LIKES,
    (l) => ({ "the pub": t.sociability, gossip: t.sociability, "people-watching": big5.extraversion, "a good bargain": t.frugality, "a fair deal": big5.agreeableness, "being busy": t.diligence, "a long lie-in": 1 - t.diligence, books: big5.openness, gadgets: t.risk })[l as string] ?? 0.5,
    rand(r) < 0.5 ? 2 : 3,
  ) as string[];
  const dislikes = weightedDistinct(
    r,
    DISLIKES.filter((d) => !likes.includes(d)),
    (d) => ({ debt: t.frugality, waste: t.frugality, losing: t.competitiveness, crowds: 1 - big5.extraversion, "being lied to": big5.agreeableness, "being told what to do": t.entrepreneurship, "early mornings": 1 - t.diligence, haggling: big5.agreeableness })[d as string] ?? 0.4,
    2,
  ) as string[];

  const fearKeys = Object.keys(FEARS) as FearKey[];
  const owns = c.occupation === "shopkeeper" || c.occupation === "entrepreneur";
  const fearKey = weightedDistinct(
    r,
    fearKeys,
    (k) => ({ homeless: t.frugality * 0.6 + big5.neuroticism * 0.6, poor: t.greed * 0.5 + (1 - t.risk) * 0.4, alone: big5.extraversion * 0.8, failure: t.ambition * 0.8, business: owns ? 1.2 : 0.05, family: hasFamily ? 1 : 0.05 })[k],
    1,
  )[0];
  const dreams = DREAMS.filter((d) => d.fits(c.occupation));
  const dream = weightedDistinct(
    r,
    dreams,
    (d) => (d.text.includes("own boss") ? 0.4 + t.entrepreneurship : d.text.includes("family") ? (hasFamily ? 1.2 : 0.3) : d.text.includes("rent") ? 0.3 + t.frugality : 0.7),
    1,
  )[0].text;

  const origin = ORIGINS[Math.floor(rand(r) * ORIGINS.length)];
  const turns = TURNS[values[0]];
  const turn = turns[Math.floor(rand(r) * turns.length)];
  const backstory = `${c.name} ${origin[0].toLowerCase()}${origin.slice(1)}. ${turn} Dreams of ${dream}, and quietly afraid of ${FEARS[fearKey]}.`;

  return { big5, values, quirks, style, likes, dislikes, fear: FEARS[fearKey], dream, backstory };
}

export function fearKeyOf(p: Personality): FearKey | null {
  const entry = (Object.entries(FEARS) as [FearKey, string][]).find(([, text]) => text === p.fear);
  return entry ? entry[0] : null;
}

/** "Outgoing, easy-going, a worrier — values family and fairness. Speaks warmly." */
export function personalitySummary(p: Personality): string {
  const b = p.big5;
  const words: string[] = [];
  if (b.extraversion > 0.65) words.push("outgoing");
  else if (b.extraversion < 0.3) words.push("reserved");
  if (b.agreeableness > 0.65) words.push("kind-hearted");
  else if (b.agreeableness < 0.3) words.push("prickly");
  if (b.conscientiousness > 0.65) words.push("organised");
  else if (b.conscientiousness < 0.3) words.push("disorganised");
  if (b.openness > 0.65) words.push("curious");
  else if (b.openness < 0.3) words.push("set in their ways");
  if (b.neuroticism > 0.65) words.push("a worrier");
  else if (b.neuroticism < 0.3) words.push("unflappable");
  const head = words.length ? words.slice(0, 3).join(", ") : "even-tempered";
  const styleWord: Record<SpeakingStyle, string> = { formal: "formally", blunt: "bluntly", chatty: "a lot", sarcastic: "sarcastically", warm: "warmly", nervous: "nervously" };
  return `${head[0].toUpperCase()}${head.slice(1)}; values ${p.values.map((v) => VALUE_WORDS[v]).join(", ")}. Talks ${styleWord[p.style]}.`;
}
