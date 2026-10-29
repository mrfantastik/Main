import { hashSeed, rand, type RngHolder } from "../rng";
import type { Citizen, WorldState } from "../types";
import type { RelView } from "./bonds";
import { TALK } from "./config";
import { cap, low, sentence } from "./grammar";
import { profileOf, talkOf } from "./profile";
import type { Move, TalkProfile } from "./types";

// How a particular person says things (for the built-in fallback lines).
//
// Two parts. Choosing a wording: every person leans towards a few favourite
// ways of saying each kind of thing (from a hash of who they are), avoids
// whatever they've said lately, and avoids what the town has been saying, so
// the same move comes out differently from different people and from the same
// person on different days. Then their voice: formal people don't contract,
// terse ones drop the "I'm", nervous ones hedge, warm and matey ones call you
// "love" or "mate" (when they know you), some swear (more when stressed or
// among friends; never in front of the boss), and everyone has their own
// words for good, bad, very, yes and surprise.

// What's been said in the conversation being worded right now (wordings and
// whole lines), so nobody says the same thing twice in one chat.
let saying: string[] | null = null;

/** Word the lines of one conversation: `said` is its running list of what's been said. */
export function sayingIn(said: string[] | null): void {
  saying = said;
}

/** Wouldn't sound odd at this hour ("all day" at nine in the morning, "lunch" at night). */
function timely(text: string, h: number): boolean {
  if (/\b(all day|long day)\b/i.test(text) && h < 13) return false;
  if (/\blunch\b/i.test(text) && (h < 11 || h >= 15)) return false;
  if (/\bbreakfast\b/i.test(text) && h >= 11) return false;
  if (/\b(tonight|this evening|later)\b/i.test(text) && h >= 23) return false;
  if (/\bthis afternoon\b/i.test(text) && (h < 11 || h >= 18)) return false;
  if (/^Morning\b/.test(text) && h >= 12) return false;
  if (/^Evening\b/.test(text) && h < 17) return false;
  return true;
}

/** A line reduced to its words, for spotting the same thing said twice. */
export const plain = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

/** One of `options`, by this person's own leanings, avoiding what they (and the town) have said lately. */
export function pickFor(world: WorldState, me: Citizen, r: RngHolder, key: string, options: string[]): string {
  if (options.length <= 1) {
    if (options[0] && saying) saying.push(`t:${plain(options[0])}`);
    return options[0] ?? "";
  }
  const t = talkOf(me);
  const mine = new Set(t.recent.phrases);
  const town = new Set(world.talkRecent ?? []);
  const here = new Set(saying ?? []);
  const now = Math.floor((world.time % 1440) / 60);
  const items = options.map((o, i) => {
    const k = `${key}#${i}`;
    const lean = ((hashSeed(`${me.id}:${k}`) % 1000) / 1000) ** 2;
    const repeat = o && (here.has(k) || here.has(`t:${plain(o)}`));
    const w = (0.25 + lean) * (mine.has(k) ? 0.02 : 1) * (town.has(k) || town.has(`t:${plain(o)}`) ? 0.15 : 1) * (repeat ? 0.0001 : 1) * (timely(o, now) ? 1 : 0.0001);
    return { o, k, w };
  });
  const total = items.reduce((a, x) => a + x.w, 0);
  let y = rand(r) * total;
  let ch = items[items.length - 1];
  for (const it of items) {
    y -= it.w;
    if (y <= 0) {
      ch = it;
      break;
    }
  }
  if (saying && ch.o) saying.push(ch.k, `t:${plain(ch.o)}`);
  t.recent.phrases.push(ch.k);
  if (t.recent.phrases.length > TALK.recentPhrases) t.recent.phrases.splice(0, t.recent.phrases.length - TALK.recentPhrases);
  const tr = (world.talkRecent ??= []);
  tr.push(ch.k, `t:${plain(ch.o)}`);
  if (tr.length > 1600) tr.splice(0, tr.length - 1600);
  return ch.o;
}

/** Fill {good} {bad} {very} {agree} {surprise} with their own words, and {you}/{me} with names. */
export function fillWords(text: string, p: TalkProfile, vars: Record<string, string>): string {
  return text
    .replace(/\{good\}/g, p.lexicon.good)
    .replace(/\{bad\}/g, p.lexicon.bad)
    .replace(/\{very\}/g, p.lexicon.very)
    .replace(/\{agree\}/g, cap(p.lexicon.agree))
    .replace(/\{surprise\}/g, cap(p.lexicon.surprise.replace(/\?$/, "")))
    .replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

const EXPAND: [RegExp, string][] = [
  [/\bI'm\b/g, "I am"],
  [/\bI've\b/g, "I have"],
  [/\bI'll\b/g, "I shall"],
  [/\bI'd\b/g, "I would"],
  [/\bdon't\b/g, "do not"],
  [/\bdoesn't\b/g, "does not"],
  [/\bdidn't\b/g, "did not"],
  [/\bcan't\b/g, "cannot"],
  [/\bwon't\b/g, "will not"],
  [/\bisn't it\b/g, "is it not"],
  [/\bwasn't it\b/g, "was it not"],
  [/\baren't you\b/g, "are you not"],
  [/\bdon't you\b/g, "do you not"],
  [/\bisn't\b/g, "is not"],
  [/\bwasn't\b/g, "was not"],
  [/\baren't\b/g, "are not"],
  [/\b([Tt]hat|[Ii]t)'s (been|got|gone|never|had|always)\b/g, "$1 has $2"],
  [/\bit's\b/g, "it is"],
  [/\bIt's\b/g, "It is"],
  [/\bthat's\b/g, "that is"],
  [/\bThat's\b/g, "That is"],
  [/\byou're\b/g, "you are"],
  [/\bYou're\b/g, "You are"],
  [/\bknackered\b/g, "exhausted"],
  [/\bstarving\b/g, "rather hungry"],
  [/\brammed\b/g, "very busy"],
  [/\bskint\b/g, "short of money"],
  [/\bmate\b/g, "my friend"],
  [/\bYeah\b/g, "Yes"],
  [/\byeah\b/g, "yes"],
];

const SWEAR_SOFT = ["bloody", "sodding"];
const SWEAR_HARD = ["fucking", "bloody"];

export interface VoiceCtx {
  move: Move;
  rel: RelView;
  /** 0..1: how stressed or upset they are right now. */
  stress: number;
  /** The line is about something bad. */
  negative: boolean;
}

/** How stressed or upset someone is right now (0..1). */
export function stressOf(c: Citizen): number {
  const e = c.emotions;
  return Math.min(1, Math.max(e.anger, e.fear, e.sadness, e.shame) / 70 + (c.rentArrears > 0 ? 0.2 : 0) + (c.needs.energy < 25 ? 0.15 : 0));
}

/**
 * Put a line in this person's voice. Light touches, never more than a couple
 * per line, so tendencies show without turning into a caricature.
 */
export function voiced(world: WorldState, me: Citizen, them: Citizen, raw: string, x: VoiceCtx, r: RngHolder): string {
  const p = profileOf(me);
  let t = raw.trim();
  if (!t) return t;
  const words = t.split(/\s+/).length;
  let touches = 0;
  const can = () => touches < 2;
  const formal = p.formality > 0.68;

  // Swearing: by temperament, more when stressed or among friends, never at the boss or a stranger.
  const company = x.rel.kind === "boss" || x.rel.kind === "staff" ? 0.05 : x.rel.kind === "stranger" ? 0.15 : 0.35 + x.rel.ease * 0.6;
  const swearP = TALK.swearing ? p.profanity * company * (0.35 + x.stress * 0.9 + (x.negative ? 0.3 : 0)) : 0;
  if (can() && rand(r) < swearP) {
    const hard = p.profanity > 0.5 && x.rel.ease > 0.3;
    const word = hard ? SWEAR_HARD[Math.floor(rand(r) * 2)] : SWEAR_SOFT[Math.floor(rand(r) * 2)];
    const adj = /\b(rough|awful|grim|dire|shocking|ridiculous|mental|stupid|useless|freezing|soaked|rammed|knackered|starving|joke|nightmare|madhouse|disgrace|cheek|liberty)\b/;
    if (adj.test(t)) {
      t = t.replace(adj, (m) => `${word} ${m}`);
      touches++;
    } else if (x.negative && /^(That's|It's|This is)\b/.test(t) && words <= 8) {
      t = t.replace(/^(That's|It's|This is)\b/, (m) => `${m} ${word}`);
      touches++;
    } else if (x.negative && x.stress > 0.45 && (x.move === "react" || x.move === "answer")) {
      t = `${hard ? (rand(r) < 0.5 ? "Fuck's sake." : "Christ.") : rand(r) < 0.5 ? "Bloody hell." : "God."} ${t}`;
      touches++;
    }
  }

  // What they call people they're easy with.
  if (can() && p.address && x.rel.ease > 0.35 && ["open", "react", "answer", "close", "byeback"].includes(x.move) && rand(r) < 0.18 + p.warmth * 0.1 && words <= 10 && !/\b(mate|love|pal|hun)\b/i.test(t) && !t.includes(them.name) && !/^Anyway/.test(t) && /[.!?]$/.test(t) && !/[.!?].+[.!?]$/.test(t.slice(0, -1))) {
    // On the end of a short line ("You alright, mate?"), never stacked on their name.
    t = t.replace(/([.!?])$/, `, ${p.address}$1`);
    touches++;
  }

  // Little words they lean on.
  if (can() && p.fillers.length && words >= 3 && !/\?/.test(t) && ["answer", "raise", "react", "elaborate"].includes(x.move) && rand(r) < (me.personality.style === "nervous" ? 0.3 : 0.11)) {
    const f = p.fillers[Math.floor(rand(r) * p.fillers.length)];
    const clause = /^(It|That|This|They|We|I|You|He|She)\b/.test(t);
    const led = /^(Oh|Here|Anyway|So|Right|Speaking|That reminds|While|Random|Funny|I tell you|Don't take|Someone said|Apparently|Word)\b/.test(t);
    if (!t.toLowerCase().startsWith(f.toLowerCase()) && !saying?.includes(`f:${me.id}:${f}`) && !led && (f !== "I think" || clause) && (f !== "sorry" || x.move === "raise")) {
      saying?.push(`f:${me.id}:${f}`);
      t = `${cap(f)}${f === "I think" ? "" : ","} ${low(t, world.citizenOrder.map((id) => world.citizens[id].name))}`;
      touches++;
    }
  }

  // Low confidence: hedge.
  if (can() && p.confidence < 0.38 && ["answer", "raise", "react", "elaborate"].includes(x.move) && rand(r) < 0.26 && words >= 4 && !/\?/.test(t) && /^(It|That|This|They|We|I|You)\b/.test(t) && !/^(This|That) (morning|afternoon|evening)\b/.test(t)) {
    const hs = ["I think", "I mean, I don't know,", "Maybe"].filter((h) => !saying?.includes(`f:${me.id}:${h}`));
    const h = hs[Math.floor(rand(r) * hs.length)] ?? "I think";
    saying?.push(`f:${me.id}:${h}`);
    t = `${h} ${low(t, world.citizenOrder.map((id) => world.citizens[id].name))}`;
    touches++;
  }

  // Terse: drop the "I'm" / "It's" when it's short.
  if (p.habits.includes("fragments") && words <= 7 && rand(r) < 0.6) t = t.replace(/^(I'm|It's|It was|That's|I've|I am)\s+/, "");

  // Trailing off, now and then.
  if (p.habits.includes("trails-off") && rand(r) < 0.12 && /\.$/.test(t) && words >= 4) t = t.replace(/\.$/, "...");

  // Formal people don't contract, and don't do slang.
  if (formal) for (const [re, s] of EXPAND) t = t.replace(re, s);

  // Exclamations from the excitable.
  if (me.personality.style === "chatty" && x.move !== "answer" && rand(r) < 0.25 && /\.$/.test(t) && !x.negative && words <= 12) t = t.replace(/\.$/, "!");

  return sentence(t.replace(/\s+/g, " ").replace(/,\s*,/g, ",").replace(/\.\.\.\./g, "..."));
}

/** Keep a line to the length this person would give it here. */
export function trimTo(text: string, length: "word" | "short" | "normal" | "long"): string {
  // Sentences end at . ! ? before a capital (so "£67.30" stays whole).
  const parts = text.split(/(?<=[.!?…]["”']?)\s+(?=[A-Z"'£])/).map((s) => s.trim()).filter(Boolean);
  const max = length === "word" ? 1 : length === "short" ? 2 : length === "normal" ? 3 : 4;
  return parts.slice(0, max).join(" ");
}
