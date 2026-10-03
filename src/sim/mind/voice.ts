import { FIRST_NAMES, SURNAMES } from "../data/people";
import { hashSeed } from "../rng";
import { dayOf } from "../time";
import type { Citizen, ConversationLine, Memory, SpeakingStyle, WorldState } from "../types";
import { dominantEmotion, feelingsToward, strongestFeelingAboutSomeone } from "./emotions";

// The built-in AI's voice. Template lines and thoughts are rewritten in each
// citizen's speaking style and current mood, and conversations call back to
// real memories ("After what you did on Day 12? No chance.").
// Choices use a hash of the context instead of the world's random numbers,
// so flavour never changes what happens in the simulation.

function roll(seed: string): number {
  return (hashSeed(seed) % 10000) / 10000;
}

function pickBy<T>(seed: string, items: readonly T[]): T {
  return items[hashSeed(seed) % items.length];
}

const SOFT_START = /^(I hate to ask, |Honestly, |Sorry, |Well, |Hmm\. |Ha\. )/;
const NAMES = new Set([...FIRST_NAMES, ...SURNAMES]);
/** Words that keep their capital mid-sentence (places, the calendar, "I"). */
const PROPER = new Set(["I", "Day", "CityCorp", "City", "Central", "Hustle", "Marketplace", "Skyline", "Cowork", "Wholesale", "Research", "Town", "Gilded", "Claude"]);

function lowerFirst(t: string): string {
  const word = t.match(/^[A-Za-z']+/)?.[0] ?? "";
  const bare = word.replace(/'s$/, "");
  if (!word || /^I('|$)/.test(word) || NAMES.has(bare) || PROPER.has(bare) || /^[A-Z]{2,}/.test(word) || /[a-z][A-Z]/.test(word)) return t;
  return t[0].toLowerCase() + t.slice(1);
}

/** Put a lead-in before a line ("Um, ", "Look, "); a lead-in that ends a sentence keeps the capital. */
function prefix(p: string, t: string): string {
  return /[.!?]\s*$/.test(p) ? p + t : p + lowerFirst(t);
}

/** Tag something on the end of a statement (not a question). */
function suffix(t: string, tag: string): string {
  return /[.!]$/.test(t) ? `${t}${tag}` : t;
}

const FORMAL: [RegExp, string][] = [
  [/\bI'm\b/g, "I am"],
  [/\bcan't\b/g, "cannot"],
  [/\bdon't\b/g, "do not"],
  [/\bwon't\b/g, "will not"],
  [/\bI'll\b/g, "I shall"],
  [/\bit's\b/g, "it is"],
  [/\bIt's\b/g, "It is"],
  [/\byou're\b/g, "you are"],
  [/\bI've\b/g, "I have"],
  [/\bthat's\b/g, "that is"],
  [/\bisn't\b/g, "is not"],
  [/\bdidn't\b/g, "did not"],
  [/\bAlright\b/g, "Good day"],
  [/\bYeah\b/g, "Yes"],
];

const NEGATIVE_WORDS = /\b(no|not|sorry|can't|cannot|broke|skint|never|pass|won't|too steep|desperate|struggling)\b/i;

const SAD = /\b(terrible|awful|sorry|poor|worried|worry|horrible|low|lonely|angry|struggling|grim|mess|evicted|owe|broke|skint|hurt|lost|bad|shame|fire|stolen|robbed|disgusting)\b/i;
/** Lines that tell the news or ask something: no sarcastic lead-in in front of these. */
const NEWSY = /^(So|Still|What|Did|Have|Everyone|Big news|You'll|Can I|Is|Are|How|Any|Who|Where|Why)\b/;

/**
 * How many flourishes a speaker gets in one conversation. Without a budget
 * (one-off lines), every line may carry them; in a long improvised chat a
 * couple of "Um,"s and one show of mood is plenty.
 */
export interface VoiceBudget {
  flair: number;
  mood: number;
}

function spend(budget: VoiceBudget | undefined, key: keyof VoiceBudget): boolean {
  if (!budget) return true;
  if (budget[key] <= 0) return false;
  budget[key]--;
  return true;
}

function styled(style: SpeakingStyle, text: string, seed: string, listener: Citizen | undefined, budget?: VoiceBudget): string {
  const r = roll(`${seed}:style`);
  const negative = NEGATIVE_WORDS.test(text);
  switch (style) {
    case "formal": {
      let t = text;
      for (const [re, rep] of FORMAL) t = t.replace(re, rep);
      return r < 0.25 && !negative && !t.includes("?") && spend(budget, "flair") ? prefix("I must say, ", t) : t;
    }
    case "blunt": {
      let t = text.replace(SOFT_START, "");
      t = t[0].toUpperCase() + t.slice(1);
      // Clipped speech, but never at the cost of what they came to say.
      const sentences = t.split(/(?<=[.!?])\s+/);
      if (!budget && sentences.length > 1 && sentences[0].length > 12 && r < 0.6 && !/\d/.test(t)) t = sentences[0];
      return t;
    }
    case "chatty":
      if (r < 0.45 && !/^(Anyway|Right|Well|So)\b/.test(text) && spend(budget, "flair")) return prefix(pickBy(seed, ["Oh! ", "Honestly, ", "You know what? ", "Right, so: "]), text);
      if (r < 0.75 && !SAD.test(text) && spend(budget, "flair")) return suffix(text, pickBy(seed, [" Anyway!", " Honestly."]));
      return text;
    case "sarcastic": {
      // Sarcasm needs something to bite on: a gripe about their own lot, or
      // a bit of good news about themselves they pretend is a surprise.
      if (r >= 0.4 || /\?$/.test(text)) return text;
      const aboutOthers = text.split(/\W+/).some((w) => NAMES.has(w) && w !== listener?.name);
      if ((negative || SAD.test(text)) && !aboutOthers && !NEWSY.test(text) && spend(budget, "flair")) return prefix(pickBy(seed, ["Oh, wonderful. ", "Great. ", "Fantastic. "]), text);
      if (!negative && /^(I|I'm|I've|Really|Great|Brilliant|Not bad|Pretty good|Never better)\b/.test(text) && spend(budget, "flair")) return suffix(text, pickBy(seed, [" Shocking, I know.", " Who'd have thought."]));
      return text;
    }
    case "warm":
      if (r < 0.3 && listener && !text.includes(listener.name) && spend(budget, "flair")) return prefix(`${listener.name}, `, text);
      if (r < 0.5 && /[.!]$/.test(text) && !/\?/.test(text) && spend(budget, "flair")) return `${text.slice(0, -1)}${pickBy(seed, [", love.", ", pet.", ", mate."])}`;
      return text;
    case "nervous":
      if (r < 0.45 && spend(budget, "flair")) return prefix(pickBy(seed, ["Um, ", "Sorry, ", "I just... ", "Er, "]), text);
      return text;
  }
}

/** Rewrite a line the way this person would say it right now. */
export function inVoice(c: Citizen, text: string, seed: string, listener?: Citizen, budget?: VoiceBudget): string {
  let t = styled(c.personality.style, text, seed, listener, budget);
  const d = dominantEmotion(c);
  if (!d || d.level < 45) return t;
  const r = roll(`${seed}:emotion`);
  const sad = SAD.test(t);
  // Lead-ins like "Look, " only go in front of plain statements.
  const leadOk = !NEWSY.test(t) && !/\?$/.test(t);
  switch (d.emotion) {
    case "anger":
      if (!/\?$/.test(t) && spend(budget, "mood")) t = r < 0.35 && leadOk ? prefix("Look, ", t.replace(/\.$/, "!")) : t.replace(/\.$/, "!");
      break;
    case "sadness":
      if (r < 0.4 && spend(budget, "mood")) t = t.replace(/[.!]$/, "...");
      break;
    case "joy":
      if (r < 0.3 && !sad && !/^(Ha|Oh)\b/.test(t) && /!|\b(good|great|brilliant|love|nice|pleased|lucky|best|glad)\b/i.test(t) && spend(budget, "mood")) t = prefix("Ha! ", t);
      break;
    case "fear":
      if (r < 0.35 && leadOk && !/worr/i.test(t) && spend(budget, "mood")) t = prefix("I'm worried, ", t);
      break;
    case "shame":
      if (r < 0.3 && leadOk && spend(budget, "mood")) t = prefix("This is embarrassing, but ", t);
      break;
    case "envy":
      if (r < 0.3 && listener && listener.money + listener.savings > c.money + c.savings && !sad && spend(budget, "mood")) t = suffix(t, " Must be nice.");
      break;
    case "loneliness":
      if (r < 0.3 && spend(budget, "mood")) t = `It's good to talk to someone. ${t}`;
      break;
    case "pride":
      if (r < 0.25 && !NEGATIVE_WORDS.test(t) && !sad && spend(budget, "mood")) t = suffix(t, " Not bad, eh?");
      break;
  }
  return t.length > 220 ? text : t;
}

/** The memory about this person that matters most right now. */
function keyMemory(c: Citizen, otherId: string): Memory | null {
  let best: Memory | null = null;
  let bestScore = 2.5;
  for (const list of [c.memories.long, c.memories.short]) {
    for (const m of list) {
      if (!m.people.includes(otherId) || Math.abs(m.valence) < 0.4) continue;
      if (m.kind !== "betrayal" && m.kind !== "favor" && m.kind !== "loan" && m.kind !== "deal" && m.kind !== "social") continue;
      const score = Math.abs(m.valence) * m.importance * m.strength;
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
  }
  return best;
}

/** A line that refers back to something that really happened between them. `today` turns "Day 12" into "today"/"yesterday". */
export function memoryCallback(c: Citizen, other: Citizen, moment: "refuse" | "agree" | "greet" | "argue", seed: string, today = -1): string | null {
  const m = keyMemory(c, other.id);
  if (!m) return null;
  const d = dayOf(m.t);
  // "on Day 12" / "yesterday" / "today", and the bare noun ("Day 12", "yesterday", "earlier").
  const on = d === today ? "today" : d === today - 1 ? "yesterday" : `on Day ${d}`;
  const then = d === today ? "earlier" : d === today - 1 ? "yesterday" : `Day ${d}`;
  const amount = m.text.match(/£[\d,.]+/)?.[0];
  const bad = m.valence < 0;
  if (moment === "refuse" && bad) {
    if (amount && (m.kind === "betrayal" || m.kind === "loan")) {
      return d >= today - 1 ? `You still owe me that ${amount}. Why would I help you now?` : `You never paid back that ${amount} from Day ${d}. Why would I help you now?`;
    }
    return pickBy(seed, [`After what you did ${on}? No chance.`, `I haven't forgotten what happened ${on}. The answer's no.`, `Not after ${d === today ? "today" : then}, ${other.name}.`]);
  }
  if (moment === "agree" && !bad && (m.emotions?.gratitude ?? 0) > 5) {
    return pickBy(seed, [`You helped me out ${on} — of course I will.`, `I haven't forgotten what you did for me ${on}. Happy to return the favour.`]);
  }
  if (moment === "greet") {
    if (bad) return pickBy(seed, [`Didn't think you'd show your face after what you did ${on}.`, d === today ? "Oh. You. Back already?" : `Oh. You. After ${then}, really?`]);
    const f = feelingsToward(c, other.id);
    if ((f.gratitude ?? 0) > 10) return `${other.name}! I still owe you for ${then}, you know.`;
    if ((f.love ?? 0) > 15) return pickBy(seed, [`Always good to see you, ${other.name}.`, `There you are, ${other.name}! Made my day.`]);
    return null;
  }
  if (moment === "argue" && bad) {
    if (d === today) return pickBy(seed, ["And after what you pulled earlier, too.", "And after today? Unbelievable."]);
    return pickBy(seed, [`And don't think I've forgotten what you did ${on}.`, `${then[0].toUpperCase()}${then.slice(1)}. Remember that?`]);
  }
  return null;
}

const REQUESTS = new Set(["ask_loan", "ask_help", "ask_job", "pitch_investment"]);

/**
 * Give a template conversation the speakers' voices: style and mood on every
 * line, and a memory callback where one fits.
 */
export function voiceConversation(convId: number, topic: string, a: Citizen, b: Citizen, lines: ConversationLine[], agreed: boolean | null, today = -1): ConversationLine[] {
  const budgets = topic === "improv" ? new Map([a.id, b.id].map((id) => [id, { flair: 2, mood: 1 }])) : null;
  const out = lines.map((l, i) => {
    const speaker = l.speaker === a.id ? a : b;
    const listener = speaker === a ? b : a;
    // Hellos, goodbyes, quick replies and hard facts (numbers) stay plain;
    // the personality shows in the rest.
    const plain = i < 2 || l.text.split(/\s+/).length <= 3 || /[£%\d]/.test(l.text);
    const budget = budgets ? (plain ? { flair: 0, mood: 0 } : budgets.get(speaker.id)) : undefined;
    return { ...l, text: inVoice(speaker, l.text, `${convId}:${i}`, listener, budget) };
  });
  const firstB = out.findIndex((l) => l.speaker === b.id);
  if (topic === "chat") {
    const ga = memoryCallback(a, b, "greet", `${convId}:ga`, today);
    if (ga && out[0]) out[0].text = ga;
    const gb = memoryCallback(b, a, "greet", `${convId}:gb`, today);
    if (gb && firstB >= 0) out[firstB].text = gb;
  } else if (REQUESTS.has(topic) && firstB >= 0) {
    if (agreed === false) {
      const no = memoryCallback(b, a, "refuse", `${convId}:no`, today);
      if (no) out[firstB].text = no;
    } else if (agreed) {
      const yes = memoryCallback(b, a, "agree", `${convId}:yes`, today);
      if (yes) out[firstB].text = `${yes} ${out[firstB].text}`;
    }
  } else if (topic === "argue" && out[0]) {
    const cb = memoryCallback(a, b, "argue", `${convId}:arg`, today);
    if (cb) out[0].text = `${out[0].text} ${cb}`;
  }
  return out;
}

const EMOTION_OPENERS: Record<string, string[]> = {
  anger: ["Grr. ", "Honestly, I'm fuming. "],
  sadness: ["Sigh. ", "Not my week. "],
  joy: ["Good day, this. ", "Feeling good. "],
  fear: ["Deep breath. ", "Stay calm. "],
  pride: ["Not bad at all. "],
  shame: ["Ugh, embarrassing. "],
  envy: ["Some people have all the luck. "],
  loneliness: ["Feeling a bit alone lately. "],
  gratitude: ["Lucky to have good people around. "],
  love: ["Life's good. "],
};

const UPBEAT = new Set(["joy", "pride", "gratitude", "love"]);
const GLOOMY = /\b(no|not|isn't|can't|cannot|won't|overpriced|tight|broke|skint|wasted|worried|behind|closed|sold out|nothing|lost|losing|owe|debt|struggling|nobody|wanted to)\b/i;

/** Colour a thought with personality, mood, grudges and lessons. */
export function flavourThought(world: WorldState, c: Citizen, text: string, priority: number): string {
  const seed = `${c.id}:${text}:${Math.floor(world.time / 60)}`;
  let t = text;
  const style = c.personality.style;
  if (style === "formal") for (const [re, rep] of FORMAL) t = t.replace(re, rep);
  else if (style === "nervous" && roll(`${seed}:n`) < 0.25) t = `Okay. Okay. ${t}`;
  else if (style === "sarcastic" && NEGATIVE_WORDS.test(t) && roll(`${seed}:s`) < 0.35) t = `${t} Fantastic.`;
  const d = dominantEmotion(c);
  if (d && d.level >= 45) {
    // A good mood doesn't open a gloomy thought ("What a day. No bargains...").
    const upbeat = UPBEAT.has(d.emotion);
    if (!(upbeat && GLOOMY.test(t)) && roll(`${seed}:e`) < (upbeat ? 0.3 : 0.45)) t = pickBy(seed, EMOTION_OPENERS[d.emotion]) + t;
  }
  if (priority <= 1 && t.length < 90) {
    const r = roll(`${seed}:aside`);
    if (r < 0.15) {
      const f = strongestFeelingAboutSomeone(world, c);
      const name = f ? world.citizens[f.id]?.name : null;
      if (f && name) {
        const aside = { anger: `Still fuming about ${name}.`, gratitude: `I must do something nice for ${name}.`, envy: `${name} makes it look so easy.`, love: `Can't wait to see ${name}.` }[f.emotion as "anger" | "gratitude" | "envy" | "love"];
        if (aside) t = `${t} ${aside}`;
      }
    } else if (r < 0.25) {
      const lessonText = [...c.reflections].sort((x, y) => y.strength - x.strength)[0]?.text;
      if (lessonText) t = `${t} (${lessonText})`;
    }
  }
  return t;
}
