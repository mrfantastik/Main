import type { CitizenId } from "../types";

// Data for the conversation system: who each citizen is as a talker, what
// they privately know, what they remember about each person they talk to,
// and the state of a conversation in progress. All plain data, so it saves
// and reloads with the world.

/**
 * How someone talks, derived once from their personality (Big Five, traits,
 * speaking style, values, likes, fear) and kept on them. Numbers are 0..1
 * tendencies: they change how a person behaves in conversation, they aren't
 * read out to the model as numbers.
 */
export interface TalkProfile {
  v: 1;
  verbosity: number;
  formality: number;
  confidence: number;
  humour: number;
  sarcasm: number;
  warmth: number;
  curiosity: number;
  bluntness: number;
  gossip: number;
  /** Emotional openness: how readily they say what's really going on with them. */
  openness: number;
  patience: number;
  optimism: number;
  profanity: number;
  storytelling: number;
  /** How often their lines are questions. */
  questionRate: number;
  selfFocus: number;
  awkwardness: number;
  empathy: number;
  impulsiveness: number;
  /** Keeps a confidence (the opposite of a blabbermouth). */
  discretion: number;
  teasing: number;
  confrontation: "avoids" | "deflects" | "direct" | "escalates";
  /** Speech tendencies, as keys (the realizer uses these) ... */
  habits: string[];
  /** ... and as words for the model. */
  habitText: string[];
  /** What they call people they're easy with ("mate", "love"), or null. */
  address: string | null;
  /** Little words they lean on now and then. */
  fillers: string[];
  /** Their own words for good, bad, very, yes and surprise ("class", "grim", "proper", "fair enough", "you're joking"). */
  lexicon: { good: string; bad: string; very: string; agree: string; surprise: string };
  favourite: string[];
  avoid: string[];
  insecurities: string[];
  strengths: string[];
  weaknesses: string[];
}

/** Slow changes to who they are, from what life throws at them (each within ±0.25). */
export interface TalkDrift {
  confidence: number;
  trust: number;
  optimism: number;
  openness: number;
}

/** Where a piece of knowledge came from. */
export type FactSource = "self" | "saw" | "told" | "rumour" | "paper" | "work" | "inferred";

/** What a piece of knowledge is about (for retelling it, and for following it up). */
export type FactPred =
  | "plan" // they mean to do something (find work, open a business, pay someone back)
  | "event" // something happened to them
  | "problem" // a worry they have (money, rent, debt, loneliness)
  | "opinion" // what they think of someone or something
  | "said" // something they said (free text, from an AI conversation)
  | "news"; // town news (a happening)

/**
 * Something a citizen knows. Only what they could plausibly know: they lived
 * it, saw it, were told it, heard it as a rumour, read it in the paper, or
 * picked it up at work. Told on, it degrades: certainty drops and the
 * wording simplifies with each retelling.
 */
export interface Fact {
  id: number;
  /** Who it's about (null: the town). */
  about: CitizenId | null;
  pred: FactPred;
  /** Stable key for "the same thing" (merging, follow-ups, matching what was said). */
  key: string;
  /** The gist, about `about`, in the third person ("Ben is thinking of leaving CityCorp"). */
  text: string;
  /** Words that show it came up when someone says them. */
  cues: string[];
  source: FactSource;
  /** Who told them (null if they saw it, lived it, or read it). */
  from: CitizenId | null;
  /** Where it started (the person it's about, usually). */
  origin: CitizenId | null;
  certainty: number;
  /** 0 public .. 1 a secret. */
  sensitivity: number;
  /** -1 bad for the person it's about .. 1 good. */
  valence: number;
  importance: number;
  learnedAt: number;
  /** When the thing itself happens or happened (for plans: when they'll know how it went). */
  when: number | null;
  /** Retellings it's been through to reach them. */
  hops: number;
  /** Who they've told. */
  told: CitizenId[];
  /** They were asked to keep it to themselves. */
  confidential?: boolean;
  /** For "news": the happening. */
  happening?: number;
  /** For "event"/"plan" drawn from a memory: which one (on the person it's about). */
  memory?: number;
  /** Who passed it along, in order (the first is who the person it's about told). */
  chain?: CitizenId[];
}

/** Something a person means to bring up with someone next time. */
export interface Thread {
  id: number;
  kind: "followup" | "owed" | "promise" | "disagreement" | "concern" | "favour";
  /** Short label ("Ben's interview"). */
  topic: string;
  /** What they mean to do, in their own head ("Ask how Ben's job hunt went"). */
  text: string;
  /** The fact it follows up, if any. */
  fact?: number;
  /** Not before this (game time) ... */
  after: number;
  /** ... and forgotten after this. */
  until: number;
  importance: number;
  t: number;
}

/** One conversation, as one of them remembers it. */
export interface Episode {
  t: number;
  /** From their side ("Ben told me he's thinking of leaving CityCorp. I told him to go for it."). */
  summary: string;
  topics: string[];
  tone: string;
  place: string;
  importance: number;
}

/** What one person remembers about talking to another. Asymmetric: each keeps their own. */
export interface Bond {
  first: number;
  talks: number;
  lastT: number;
  /** Recent conversations in some detail, newest last. */
  episodes: Episode[];
  /** Older ones, boiled down. */
  history: string;
  threads: Thread[];
  /** Running jokes between them: the hook and how worn out it is. */
  jokes: { hook: string; line: string; t: number; uses: number }[];
  /** What they make of the other person ("funny", "talks too much"), strength -1..1. */
  opinions: { key: string; text: string; v: number; t: number }[];
  /** Topics they've been over lately (keys), newest last. */
  topics: { k: string; t: number }[];
  /** How they opened their last few conversations with this person. */
  openers: string[];
  /** Recent friction between them (0..1, fades). */
  tension: number;
  /** How the other seemed last time (an impression, not a fact). */
  seemed: { text: string; t: number } | null;
}

/** A citizen's conversational self: profile, slow drift, private knowledge, and social memory. */
export interface TalkState {
  profile: TalkProfile;
  drift: TalkDrift;
  facts: Fact[];
  bonds: Record<CitizenId, Bond>;
  /** Their opinions of things (a business, their employer, going it alone), -1..1. */
  views: { key: string; text: string; v: number; t: number }[];
  /** Their own recent openers, questions and phrasings (for not repeating themselves). */
  recent: { openers: string[]; questions: string[]; phrases: string[] };
  nextFactId: number;
}

/** What someone's after in a conversation (hidden; guides but doesn't script). */
export type Intent =
  | "pass time"
  | "check on them"
  | "complain"
  | "brag"
  | "ask a favour"
  | "find something out"
  | "make peace"
  | "vent"
  | "gossip"
  | "confront"
  | "get advice"
  | "joke around"
  | "share news"
  | "keep it short"
  | "get away"
  | "close the deal";

export type TopicKind =
  | "followup"
  | "concern"
  | "owed"
  | "disagreement"
  | "news"
  | "gossip"
  | "disclose"
  | "problem"
  | "plan"
  | "work"
  | "complain"
  | "brag"
  | "environment"
  | "mundane"
  | "hypothetical"
  | "shared"
  | "joke"
  | "tease"
  | "ask"
  | "opinion"
  | "evening"
  | "deal"
  | "argument";

/** Something a person might bring up, with how much they want to. */
export interface Topic {
  key: string;
  kind: TopicKind;
  score: number;
  label: string;
  intent: Intent;
  /** 0 fine anywhere .. 1 private. */
  sensitive: number;
  valence: number;
  about: CitizenId | null;
  fact?: number;
  thread?: number;
  memory?: number;
  happening?: number;
  /** Free details for saying it (amount, place, thing). */
  detail?: Record<string, string | number>;
}

/** What a line does in the conversation. */
export type Move =
  | "open"
  | "greet"
  | "answer"
  | "deflect"
  | "react"
  | "ask"
  | "elaborate"
  | "raise"
  | "tease"
  | "disagree"
  | "concede"
  | "defend"
  | "clarify"
  | "backchannel"
  | "excuse"
  | "close"
  | "byeback";

/** One line's meaning, kept beside its words (never shown in speech bubbles). */
export interface TurnMeta {
  speaker: CitizenId;
  move: Move;
  topic: string | null;
  kind: TopicKind | null;
  intent: Intent;
  tone: string;
  /** It asks something the other is expected to answer ... */
  asks: boolean;
  /** ... and what sort of question ("how", "followup", "news", "work", "fact", "evening", "hypo", "detail", "who", "what", "favour"). */
  q?: string;
  /** What it refers to (a fact key, thread id, happening id). */
  ref?: string;
  /** A short gist of what was said, for reacting to it (built-in lines; the model's are read as they are). */
  gist?: string;
  /** They said goodbye. */
  bye: boolean;
  valence: number;
  /** Facts this line passed on (the listener now knows them). */
  told: number[];
  /** Who wrote it: the model, or the built-in fallback. */
  by: "llm" | "built-in";
  /** In a deal: what this turn did about what's on the table. */
  deal?: { action: DealAction; terms: DealTerms };
}

/** The state of a conversation in progress (kept on it, and on the finished record for the debug view). */
export interface DialogueState {
  mode: "fail" | "brief" | "normal" | "engaged" | "significant" | "argument" | "deal";
  maxTurns: number;
  initiator: CitizenId;
  /** Why it started (debug). */
  reason: string;
  topic: string | null;
  topicKind: TopicKind | null;
  topicLabel: string | null;
  previous: string[];
  tone: "light" | "warm" | "flat" | "awkward" | "tense" | "heated" | "low";
  engagement: number;
  tension: number;
  intimacy: number;
  /** Lines spent on the current topic, how many it's worth, and whose it is. */
  depth: number;
  budget: number;
  topicOwner: CitizenId | null;
  intents: Record<CitizenId, Intent>;
  /** Each one's private list of things they might bring up (never shown to the other). */
  agenda: Record<CitizenId, Topic[]>;
  /** A question waiting for an answer. */
  pending: { by: CitizenId; topic: string | null; kind: TopicKind | null; text: string } | null;
  /** Someone's started to wrap it up. */
  ending: CitizenId | null;
  /** Others close enough to overhear. */
  nearby: CitizenId[];
  turns: TurnMeta[];
  /** Topic labels that came up (for the summary and the UI). */
  covered: string[];
  /** Threads that got dealt with (by the person who held them). */
  resolved: { who: CitizenId; thread: number }[];
  /** Things one of them told the other about themselves (the listener takes them on board when it ends). */
  learned: { who: CitizenId; about: CitizenId; from?: CitizenId; text: string; when: number | null; sensitive: number; key: string; valence: number; confidential: boolean; follow?: string; label: string }[];
  /** Money handed over to help (applied when it ends). */
  gifts?: { from: CitizenId; to: CitizenId; amount: number }[];
  /** How each answered "how are you?" when they weren't really fine (an impression for the other). */
  hid?: CitizenId[];
  /** Wordings already used in this conversation (built-in lines), so nothing's said twice. */
  said?: string[];
  /** A deal being negotiated, turn by turn. */
  deal?: DealState;
  /** What each was given to work from (debug view only). */
  debug: { retrieved: Record<CitizenId, string[]>; candidates: Record<CitizenId, string[]> };
}

// ------------------------------------------------------------- negotiation

/** What's on the table in a deal (only the fields that kind of deal uses). */
export interface DealTerms {
  amount?: number;
  /** Interest, as a fraction (0.1 = 10%). */
  rate?: number;
  days?: number;
  wage?: number;
  /** Share of profits, as a fraction. */
  share?: number;
  price?: number;
  qty?: number;
  /** For a choice rather than a number ("paid", "partial", "promise", "refuse"). */
  choice?: string;
}

export type DealAction = "propose" | "counter" | "accept" | "decline";

/** A negotiation in progress: who's asking, what's been offered, and how it stands. Nothing is decided until one of them accepts. */
export interface DealState {
  topic: string;
  proposer: CitizenId;
  responder: CitizenId;
  status: "open" | "agreed" | "declined";
  offers: { by: CitizenId; action: DealAction; terms: DealTerms; t: number; source: "llm" | "built-in" }[];
  /** The terms they shook on. */
  agreed: DealTerms | null;
  /** Who walked away or said no, and why (in their own head). */
  declinedBy?: CitizenId;
  why?: string;
}
