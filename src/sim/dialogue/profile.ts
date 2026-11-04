import { hashSeed } from "../rng";
import type { Citizen, SpeakingStyle } from "../types";
import { clamp } from "../util";
import type { TalkDrift, TalkProfile, TalkState } from "./types";

// Each citizen's conversational identity, derived once from the personality
// they already have (Big Five, economic traits, speaking style, values,
// likes, dislikes, fear, age) so there's one personality, not two. The
// numbers are tendencies that change how they behave in a conversation
// (how long they talk, how often they ask, whether they tease, swear, hedge,
// gossip or keep a confidence); a few are turned into plain words for the
// model. Drift lets life slowly change them: betrayal makes them warier,
// success bolder, a long spell out of work gloomier.

const STYLE: Record<SpeakingStyle, Partial<Record<keyof TalkProfile, number>>> = {
  formal: { verbosity: 0.05, formality: 0.6, humour: -0.1, profanity: -0.4, bluntness: -0.05, gossip: -0.1, teasing: -0.15, discretion: 0.1 },
  blunt: { verbosity: -0.25, bluntness: 0.45, profanity: 0.2, confidence: 0.1, warmth: -0.1, storytelling: -0.15, questionRate: -0.05 },
  chatty: { verbosity: 0.3, gossip: 0.2, storytelling: 0.25, humour: 0.1, questionRate: 0.08, discretion: -0.15 },
  sarcastic: { sarcasm: 0.6, humour: 0.25, teasing: 0.2, profanity: 0.15, warmth: -0.05 },
  warm: { warmth: 0.25, empathy: 0.2, questionRate: 0.06, profanity: -0.05, teasing: 0.05 },
  nervous: { confidence: -0.3, awkwardness: 0.25, profanity: -0.15, teasing: -0.1, bluntness: -0.15 },
};

/** Little words each style leans on (used sparingly). */
const FILLERS: Record<SpeakingStyle, string[][]> = {
  formal: [["indeed"], ["quite"], ["I must say"]],
  blunt: [["look"], ["right"], []],
  chatty: [["honestly"], ["I mean"], ["literally"], ["like"]],
  sarcastic: [["obviously"], ["I mean"], ["look"]],
  warm: [["bless"], ["aw"], ["honestly"]],
  nervous: [["um"], ["er"], ["I think"]],
};

/** Their own words for good, bad, very, yes and surprise: one of each, picked by who they are. */
const LEX = {
  good: { young: ["class", "mint", "sound", "decent", "ace"], old: ["lovely", "smashing", "grand", "cracking", "champion"], formal: ["splendid", "very good", "excellent"] },
  bad: { young: ["grim", "rough", "dire", "a joke", "grim"], old: ["shocking", "dreadful", "awful", "a disgrace"], formal: ["regrettable", "unfortunate", "poor"] },
  very: { young: ["proper", "dead", "well", "seriously"], old: ["right", "terribly", "awfully", "really"], formal: ["rather", "most", "extremely"] },
  agree: { young: ["fair", "true", "fair enough", "yeah, true"], old: ["right you are", "fair enough", "that's true"], formal: ["quite right", "indeed", "I agree"] },
  surprise: { young: ["you're joking", "no way", "seriously?", "shut up"], old: ["get away", "blimey", "well I never", "good grief"], formal: ["good heavens", "really?", "goodness"] },
};

function pickFrom<T>(seed: number, items: readonly T[]): T {
  return items[seed % items.length];
}

const LIKE_TOPICS: Record<string, string> = {
  "a good bargain": "bargains",
  "the pub": "the pub",
  "the park": "the park",
  coffee: "coffee",
  "quiet evenings": "quiet nights in",
  gadgets: "gadgets",
  "a long lie-in": "lie-ins",
  "football on the radio": "the football",
  "people-watching": "people-watching",
  gossip: "gossip",
  cooking: "cooking",
  books: "books",
  "being busy": "keeping busy",
  "a fair deal": "a fair deal",
};

const VALUE_TOPICS: Record<string, string> = {
  family: "family",
  status: "being taken seriously",
  freedom: "being their own boss",
  security: "having something put by",
  fairness: "fairness",
  wealth: "money",
  community: "the town",
  knowledge: "how things work",
};

const FEAR_INSECURITY: Record<string, string> = {
  "ending up on the streets": "losing their home",
  "dying poor": "money",
  "ending up alone": "being on their own",
  "being a failure": "not amounting to much",
  "losing everything they've built": "the business going under",
  "letting their family down": "letting their family down",
};

/** Derive someone's talk profile from who they are (deterministic: the same person always talks the same way). */
export function deriveProfile(c: Citizen): TalkProfile {
  const p = c.personality;
  const b = p.big5;
  const t = c.traits;
  const s = STYLE[p.style];
  const h = hashSeed(`${c.id}:${c.name}:talk`);
  const jitter = (k: number) => (((h >>> (k * 3)) & 0xff) / 255 - 0.5) * 0.12;
  const young = c.age < 45;
  const old = c.age >= 58;
  const v = (k: keyof TalkProfile, base: number, i: number) => clamp(base + ((s[k] as number | undefined) ?? 0) + jitter(i), 0, 1);

  const verbosity = v("verbosity", 0.28 + b.extraversion * 0.35 + b.openness * 0.1, 1);
  const formality = v("formality", 0.15 + b.conscientiousness * 0.2 + (old ? 0.12 : 0) - (young ? 0.05 : 0), 2);
  const confidence = v("confidence", 0.42 + (1 - b.neuroticism) * 0.3 + b.extraversion * 0.15 + t.ambition * 0.1, 3);
  const sarcasm = v("sarcasm", 0.08 + (1 - b.agreeableness) * 0.22 + b.openness * 0.1, 4);
  const humour = v("humour", 0.18 + b.openness * 0.3 + b.extraversion * 0.2 - b.neuroticism * 0.1, 5);
  const warmth = v("warmth", 0.15 + b.agreeableness * 0.5 + t.generosity * 0.15, 6);
  const curiosity = v("curiosity", 0.18 + b.openness * 0.45 + b.extraversion * 0.12, 7);
  const bluntness = v("bluntness", 0.12 + (1 - b.agreeableness) * 0.35 + t.competitiveness * 0.15, 8);
  const gossip = v("gossip", 0.12 + b.extraversion * 0.3 + t.sociability * 0.2 + (1 - b.conscientiousness) * 0.15, 9);
  const openness = v("openness", 0.18 + b.extraversion * 0.25 + b.agreeableness * 0.15 + (1 - b.neuroticism) * 0.1, 10);
  const impulsiveness = v("impulsiveness", 0.12 + (1 - b.conscientiousness) * 0.35 + t.risk * 0.2 + b.extraversion * 0.1, 11);
  const patience = v("patience", 0.3 + b.agreeableness * 0.3 + b.conscientiousness * 0.2 - b.neuroticism * 0.15 - impulsiveness * 0.15, 12);
  const optimism = v("optimism", 0.28 + b.extraversion * 0.2 + (1 - b.neuroticism) * 0.35 + t.risk * 0.1, 13);
  const profanity = v("profanity", 0.12 + (1 - b.conscientiousness) * 0.2 + (1 - b.agreeableness) * 0.15 - (old ? 0.12 : 0) + (young ? 0.05 : 0), 14);
  const storytelling = v("storytelling", 0.12 + b.extraversion * 0.3 + b.openness * 0.2, 15);
  const selfFocus = v("selfFocus", 0.18 + t.ambition * 0.18 + t.greed * 0.15 + (1 - b.agreeableness) * 0.2 + t.competitiveness * 0.12 - warmth * 0.12, 16);
  const awkwardness = v("awkwardness", 0.08 + b.neuroticism * 0.3 + (1 - b.extraversion) * 0.3 - confidence * 0.12, 17);
  const empathy = v("empathy", 0.18 + b.agreeableness * 0.45 + t.generosity * 0.1 - selfFocus * 0.1, 18);
  const questionRate = v("questionRate", 0.12 + curiosity * 0.22 + warmth * 0.08 - selfFocus * 0.12, 19);
  const discretion = v("discretion", 0.3 + b.conscientiousness * 0.3 + b.agreeableness * 0.15 - gossip * 0.35, 20);
  const teasing = v("teasing", 0.08 + humour * 0.4 + b.extraversion * 0.15, 21);

  const confrontation: TalkProfile["confrontation"] =
    b.agreeableness < 0.35 && t.competitiveness > 0.55 ? "escalates" : p.style === "sarcastic" || (humour > 0.6 && confidence < 0.6) ? "deflects" : bluntness > 0.5 || confidence > 0.68 ? "direct" : "avoids";

  // Speech tendencies: a few, the most marked ones (tendencies, not catchphrases).
  const marks: [string, string, number][] = [
    ["fragments", "Talks in short sentences, often just fragments", 0.4 - verbosity + bluntness * 0.4],
    ["rambles", "Goes off on tangents and turns things into little stories", verbosity - 0.62 + storytelling * 0.2],
    ["no-contractions", "Speaks properly and rarely uses contractions", formality - 0.7],
    ["dry", "Dry, understated humour; rarely says what they mean straight out", sarcasm - 0.45],
    ["self-deprecating", "Makes fun of themselves", humour - 0.45 + (0.5 - confidence) * 0.6],
    ["teases", "Teases people they like", teasing - 0.45],
    ["rhetorical", "Asks rhetorical questions", (bluntness + sarcasm) / 2 - 0.38],
    ["trails-off", "Trails off or second-guesses themselves when unsure", awkwardness - 0.48],
    ["exaggerates", "Exaggerates for effect", storytelling - 0.5 + b.openness * 0.15],
    ["over-explains", "Over-explains when nervous", awkwardness * 0.6 + verbosity * 0.5 - 0.62],
    ["changes-subject", "Changes the subject when something gets uncomfortable", 0.42 - openness],
    ["anecdotes", "Answers with something that happened to them", storytelling + selfFocus * 0.3 - 0.62],
    ["direct", "Very direct: says exactly what they think", bluntness - 0.6],
    ["gentle", "Gentle and encouraging with people", empathy + warmth - 1.1],
    ["dismissive", "Can be dismissive of other people's problems", selfFocus - empathy - 0.05],
  ];
  const chosen = marks.filter((m) => m[2] > 0).sort((x, y) => y[2] - x[2]).slice(0, 4);
  const swears = !profanity ? "" : profanity >= 0.5 ? "Swears freely" : profanity >= 0.28 ? "Swears now and then, more when stressed or with friends" : profanity < 0.1 ? "Never swears" : "";
  const habits = chosen.map((m) => m[0]).concat(profanity >= 0.5 ? ["swears"] : profanity >= 0.28 ? ["swears-sometimes"] : profanity < 0.1 ? ["never-swears"] : []);
  const habitText = chosen.map((m) => m[1]).concat(swears ? [swears] : []);

  const address = p.style === "formal" || p.style === "nervous" ? null : p.style === "warm" ? (old ? "love" : pickFrom(h, ["love", "hun", "love"])) : young ? pickFrom(h >>> 5, ["mate", "mate", "pal", null]) : pickFrom(h >>> 5, ["mate", "pal", null]);
  const fillers = pickFrom(h >>> 7, FILLERS[p.style]);
  const age = p.style === "formal" ? "formal" : old ? "old" : young ? "young" : (h & 1 ? "young" : "old");
  const lex = (k: keyof typeof LEX, n: number) => pickFrom(h >>> n, LEX[k][age as "young" | "old" | "formal"]);

  const favourite = [...p.likes.map((l) => LIKE_TOPICS[l] ?? l), ...p.values.map((x) => VALUE_TOPICS[x]).filter(Boolean)].slice(0, 5);
  const avoid = [...p.dislikes];
  const insecurities = [FEAR_INSECURITY[p.fear] ?? p.fear, ...(b.neuroticism > 0.6 ? ["what people think of them"] : []), ...(c.age > 55 && p.values.includes("security") ? ["getting older without savings"] : [])];
  const strengths = [
    ...(empathy > 0.62 ? ["a good listener"] : []),
    ...(humour > 0.6 ? ["funny"] : []),
    ...(discretion > 0.62 ? ["keeps a secret"] : []),
    ...(bluntness > 0.62 ? ["tells it straight"] : []),
    ...(curiosity > 0.65 ? ["interested in people"] : []),
    ...(storytelling > 0.65 ? ["tells a good story"] : []),
  ].slice(0, 3);
  const weaknesses = [
    ...(impulsiveness > 0.6 && b.extraversion > 0.6 ? ["talks over people"] : []),
    ...(selfFocus > 0.6 ? ["makes things about themselves"] : []),
    ...(discretion < 0.3 ? ["can't keep a secret"] : []),
    ...(b.neuroticism > 0.6 && confidence < 0.45 ? ["gets defensive"] : []),
    ...(awkwardness > 0.55 ? ["awkward with people they don't know"] : []),
    ...(verbosity > 0.78 ? ["talks too much"] : []),
    ...(b.extraversion < 0.3 ? ["hopeless at small talk"] : []),
    ...(patience < 0.3 ? ["impatient"] : []),
  ].slice(0, 3);

  return {
    v: 1,
    verbosity,
    formality,
    confidence,
    humour,
    sarcasm,
    warmth,
    curiosity,
    bluntness,
    gossip,
    openness,
    patience,
    optimism,
    profanity,
    storytelling,
    questionRate,
    selfFocus,
    awkwardness,
    empathy,
    impulsiveness,
    discretion,
    teasing,
    confrontation,
    habits,
    habitText,
    address,
    fillers,
    lexicon: { good: lex("good", 2), bad: lex("bad", 4), very: lex("very", 6), agree: lex("agree", 8), surprise: lex("surprise", 10) },
    favourite,
    avoid,
    insecurities,
    strengths,
    weaknesses,
  };
}

const noDrift = (): TalkDrift => ({ confidence: 0, trust: 0, optimism: 0, openness: 0 });

/** Their conversational self, created the first time it's needed (old saves included). */
export function talkOf(c: Citizen): TalkState {
  if (!c.talk || !c.talk.profile || c.talk.profile.v !== 1) {
    c.talk = { profile: deriveProfile(c), drift: c.talk?.drift ?? noDrift(), facts: c.talk?.facts ?? [], bonds: c.talk?.bonds ?? {}, views: c.talk?.views ?? [], recent: c.talk?.recent ?? { openers: [], questions: [], phrases: [] }, nextFactId: c.talk?.nextFactId ?? 1 };
  }
  return c.talk;
}

/** Their profile as it is now: who they were, plus what life has done to them. */
export function profileOf(c: Citizen): TalkProfile {
  const t = talkOf(c);
  const d = t.drift;
  if (!d.confidence && !d.optimism && !d.openness) return t.profile;
  return { ...t.profile, confidence: clamp(t.profile.confidence + d.confidence, 0, 1), optimism: clamp(t.profile.optimism + d.optimism, 0, 1), openness: clamp(t.profile.openness + d.openness, 0, 1), awkwardness: clamp(t.profile.awkwardness - d.confidence * 0.5, 0, 1) };
}

/** Nudge who they are (each part stays within ±0.25 of where they started). */
export function drift(c: Citizen, d: Partial<TalkDrift>): void {
  const t = talkOf(c);
  for (const k of Object.keys(d) as (keyof TalkDrift)[]) t.drift[k] = clamp(t.drift[k] + (d[k] ?? 0), -0.25, 0.25);
}
