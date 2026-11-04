import { VALUE_WORDS } from "../data/personality";
import { hashSeed } from "../rng";
import type { BotCard, Citizen, CitizenId, Conversation, SpeakingStyle, WorldState } from "../types";

// Every citizen is a chatbot with its own character card: who they are, how
// they talk (with example lines, which is what keeps a small model in
// character), what they care about, a secret, and how adventurous and
// talkative their replies are. The card is generated from their personality
// and story, so all twenty are different; the player can rewrite any of it
// (then it's stored on the citizen). The AI speaks from the card, plus how
// they are right now and what they remember of the person in front of them.

const VOICE: Record<SpeakingStyle, string> = {
  formal: "You speak formally and politely: full sentences, no slang, 'I shall', 'indeed', 'good afternoon'.",
  blunt: "You're blunt and brief. Short sentences. You say exactly what you think and can't stand small talk.",
  chatty: "You're chatty: you go off on tangents, ask lots of questions, and say 'honestly' and 'oh my goodness'.",
  sarcastic: "You're dry and sarcastic. You tease people, understate everything and rarely say what you mean straight out.",
  warm: "You're warm and kind. You call people 'love' or 'pet', ask how they really are, and try to cheer them up.",
  nervous: "You're nervous and hesitant. You say 'um', 'sorry' and 'I think', trail off, and second-guess yourself.",
};

const EXAMPLES: Record<SpeakingStyle, string[]> = {
  formal: [
    "Good afternoon. I trust business is treating you well?",
    "I'm afraid I must disagree with you there.",
    "That is very kind of you. Thank you.",
    "I shall have to give it some thought.",
    "Quite right. One must be sensible with money.",
  ],
  blunt: ["What do you want?", "No. Too dear.", "Fine. Whatever.", "That's rubbish and you know it.", "Busy. Make it quick."],
  chatty: [
    "Oh my goodness, you will not believe the morning I've had!",
    "Honestly, I could talk about this all day. Anyway! How are you?",
    "Wait, did you hear about the festival? It's going to be amazing!",
    "Ooh, go on, tell me everything.",
    "Sorry, I'm going on again, aren't I? Ha!",
  ],
  sarcastic: [
    "Oh, brilliant. Another rent rise. Just what I needed.",
    "Living the dream, obviously.",
    "A whole pound? I'll try not to spend it all at once.",
    "Sure, because that always works.",
    "Don't look so pleased with yourself.",
  ],
  warm: [
    "Aw, hello love! You look like you could use a cuppa.",
    "Don't you worry, pet. It'll all work out.",
    "Come here, tell me what's wrong.",
    "You're a good one, you know that?",
    "Have you eaten today? Look after yourself.",
  ],
  nervous: [
    "Oh! Um, hi. Sorry, I didn't see you there.",
    "I... I think so? Yeah. Probably.",
    "Sorry, I'm rambling again, aren't I?",
    "Um, is that... is that alright?",
    "I don't want to be a bother, but, um...",
  ],
};

/** Something each quirk makes them say. */
const QUIRK_LINES: Record<string, string> = {
  "hums when counting money": "Hang on, I'm counting. Hmm hmm hmm... right, done.",
  "counts their change twice": "Let me just count this again. Always twice.",
  "is always ten minutes early": "I've been here ten minutes already. I'm always early.",
  "names every pigeon in the park": "See that pigeon? That's Gerald. He's a menace.",
  "keeps a notebook of every price they see": "Hold on, let me write that price down.",
  "can't walk past a bargain": "Two for one? I can't say no to that.",
  "quotes their gran's sayings": "As my gran used to say, look after the pennies.",
  "taps the table when nervous": "Sorry, I tap things when I'm nervous.",
  "remembers everyone's birthday": "Isn't your birthday coming up? I never forget.",
  "never finishes a cup of tea": "I've made three cups of tea today and finished none of them.",
  "talks to their plants": "My ferns are doing well. I tell them all my problems.",
  "drums on anything when bored": "Sorry, I drum when I'm bored. Is it that obvious?",
  "keeps receipts for everything": "I've got the receipt for that somewhere. I keep them all.",
  "always has a mint to offer": "Mint? I always carry some.",
  "re-reads the same paperback": "I'm reading my favourite book again. Fifth time.",
  "whistles off-key": "Sorry, was I whistling? I do that.",
};

function pick<T>(seed: string, items: readonly T[], n: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  let h = hashSeed(seed);
  while (out.length < n && pool.length) {
    h = (h * 1103515245 + 12345) >>> 0;
    out.push(pool.splice(h % pool.length, 1)[0]);
  }
  return out;
}

/** "their" -> "your", for things said to the citizen about themselves. */
function yours(t: string): string {
  return t
    .replace(/\btheir\b/g, "your")
    .replace(/\bthey're\b/g, "you're")
    .replace(/\bthey've\b/g, "you've")
    .replace(/\bthey\b/g, "you")
    .replace(/\bthemselves\b/g, "yourself");
}

const IRREGULAR: Record<string, string> = { has: "have", is: "are", was: "were", does: "do" };
const ADVERBS = new Set(["never", "still", "always", "often", "quietly", "secretly", "really"]);

/** A third-person verb phrase about them ("never finishes a cup of tea") said to them ("never finish a cup of tea"). */
export function toYou(phrase: string): string {
  const words = phrase.split(" ");
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const lower = w.toLowerCase();
    if (ADVERBS.has(lower)) continue;
    let v = IRREGULAR[lower];
    if (!v) {
      if (/(ch|sh|ss|x|z|o)es$/.test(lower)) v = lower.slice(0, -2);
      else if (/[^aeiou]ies$/.test(lower)) v = lower.slice(0, -3) + "y";
      else if (/[^s']s$/.test(lower)) v = lower.slice(0, -1);
      else v = lower; // past tense or a modal: "grew", "can't"
    }
    words[i] = w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase() ? v[0].toUpperCase() + v.slice(1) : v;
    break;
  }
  return yours(words.join(" "));
}

/** Their story, told to them: "You grew up above a chip shop. You still ring home every Sunday." */
function bioFor(c: Citizen): string {
  const story = c.personality.backstory;
  const m = new RegExp(`^${c.name} (.+?)\\. (.+?) Dreams of (.+), and quietly afraid of (.+)\\.$`).exec(story);
  if (m) {
    const turn = m[2].replace(/\.$/, "");
    return `You ${toYou(m[1])}. You ${toYou(turn[0].toLowerCase() + turn.slice(1))}.`;
  }
  // Someone else's wording: just point it at them.
  return yours(story.replace(new RegExp(`\\b${c.name}\\b`, "g"), "You").replace(/\bYou (has|is|was)\b/g, (_, v: string) => `You ${IRREGULAR[v]}`));
}

/** Something they keep to themselves, from who they are. */
function secretFor(c: Citizen): string {
  const p = c.personality;
  const options: string[] = [
    ...(p.fear.includes("streets") ? ["You're closer to losing your home than anyone knows."] : []),
    ...(p.values.includes("wealth") ? ["You've got a little stash of cash hidden away that nobody knows about."] : []),
    ...(p.big5.neuroticism > 0.6 ? ["You lie awake most nights worrying, and you hide it well."] : []),
    ...(p.big5.extraversion < 0.4 ? ["You've been lonely since you came here, though you'd never say so."] : []),
    ...(p.values.includes("status") ? ["You think you're cleverer than most people here, but you'd never say it."] : []),
    ...(p.values.includes("family") ? ["You send more money home than you can really afford."] : []),
    ...(p.values.includes("freedom") ? ["You've been quietly thinking about leaving Hustle City for good."] : []),
    "You once short-changed a customer and still feel bad about it.",
    "You're secretly scared you've made all the wrong choices.",
  ];
  return pick(`${c.id}:secret`, options, 1)[0];
}

/** The card generated from their personality (what they're like before the player changes anything). */
export function defaultCard(c: Citizen): BotCard {
  const p = c.personality;
  const quirkLine = p.quirks.map((q) => QUIRK_LINES[q]).find(Boolean);
  const examples = [...pick(`${c.id}:examples`, EXAMPLES[p.style], 3), ...(quirkLine ? [quirkLine] : [])];
  const values = p.values.map((v) => yours(VALUE_WORDS[v]));
  const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs.join(""));
  const cares = [
    `You care about ${list(values)}.`,
    p.likes.length ? `You love ${list(p.likes)}.` : "",
    p.dislikes.length ? `You can't stand ${list(p.dislikes)}.` : "",
    `You dream of ${yours(p.dream)}, and deep down you're afraid of ${yours(p.fear)}.`,
    p.quirks.length ? `You ${list(p.quirks.map(toYou))}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const b = p.big5;
  return {
    custom: false,
    bio: bioFor(c),
    voice: VOICE[p.style],
    examples,
    cares,
    secret: secretFor(c),
    instructions: "",
    creativity: Math.round((0.35 + b.openness * 0.45) * 100) / 100,
    chattiness: Math.round((0.2 + b.extraversion * 0.7) * 100) / 100,
  };
}

/** The card the AI speaks from: the player's version if they've written one, otherwise the generated one. */
export function botCard(c: Citizen): BotCard {
  return c.bot?.custom ? c.bot : defaultCard(c);
}

/** Keep the player's version of someone's card (a reset goes back to the generated one). */
export function saveCard(c: Citizen, card: Partial<BotCard> | null): void {
  if (!card) {
    delete c.bot;
    return;
  }
  const base = botCard(c);
  const text = (v: unknown, fallback: string, max: number) => (typeof v === "string" ? v.slice(0, max) : fallback);
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback);
  c.bot = {
    custom: true,
    bio: text(card.bio, base.bio, 600),
    voice: text(card.voice, base.voice, 300),
    examples: Array.isArray(card.examples) ? card.examples.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim().slice(0, 160)).slice(0, 6) : base.examples,
    cares: text(card.cares, base.cares, 600),
    secret: text(card.secret, base.secret, 300),
    instructions: text(card.instructions, base.instructions, 500),
    creativity: num(card.creativity, base.creativity),
    chattiness: num(card.chattiness, base.chattiness),
  };
}

const KEEP_LINES = 6;
const KEEP_PEOPLE = 14;

/** When a conversation ends, each of them remembers how it went (the last few lines), for next time. */
export function rememberChat(world: WorldState, conv: Conversation): void {
  const lines = conv.lines.slice(0, Math.max(conv.revealed, conv.lines.length)).slice(-KEEP_LINES);
  if (lines.length < 2) return;
  for (const [me, them] of [
    [conv.a, conv.b],
    [conv.b, conv.a],
  ] as [CitizenId, CitizenId][]) {
    const c = world.citizens[me];
    if (!c) continue;
    const chats = (c.chats ??= {});
    chats[them] = { t: world.time, lines: lines.map((l) => ({ me: l.speaker === me, text: l.text })) };
    const ids = Object.keys(chats);
    if (ids.length > KEEP_PEOPLE) {
      ids.sort((x, y) => chats[x].t - chats[y].t);
      for (const id of ids.slice(0, ids.length - KEEP_PEOPLE)) delete chats[id];
    }
  }
}

/** Keep the chat with the player short enough to fit in a prompt and a save. */
export function addPlayerLine(world: WorldState, c: Citizen, me: boolean, text: string): void {
  const chat = (c.playerChat ??= []);
  chat.push({ t: world.time, me, text: text.slice(0, 300) });
  if (chat.length > 40) chat.splice(0, chat.length - 40);
}
