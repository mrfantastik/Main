import { situation } from "../ai/situation";
import { botCard } from "../mind/bot";
import { dominantEmotion } from "../mind/emotions";
import { placeName } from "../places";
import { happeningById } from "../town/happenings";
import { dayOf, hourOf } from "../time";
import type { Citizen, Conversation, Memory, WorldState } from "../types";
import { dueThreads, peekBond, relGuide, type RelView } from "./bonds";
import { TALK } from "./config";
import { mentions, spokenDays } from "./grammar";
import { factsAbout } from "./knowledge";
import type { Directive } from "./plan";
import { profileOf } from "./profile";
import type { DialogueState } from "./types";

// What a speaker is given to work from, for one turn. Only what *they* know:
// who they are and how they talk, how they are right now (in words, not
// numbers: "hungry and short-tempered", never "hunger 0.63"), the person in
// front of them as *they* see them, the few memories that matter right now
// (scored for recency, importance, whether it's about this person, whether it
// touches the current topic, how much it stung, and whether it's unfinished
// business), where they are, and the conversation so far. Bounded, so a
// prompt stays small however long the game runs.

export interface Context {
  identity: string[];
  examples: string[];
  state: string[];
  relationship: string[];
  memories: string[];
  scene: string[];
  /** What they're after, privately. */
  intent: string;
  /** This turn's plan, in words. */
  plan: string;
  /** Labels of what was retrieved (for the debug view). */
  retrieved: string[];
}

const FEEL: Record<string, string> = {
  joy: "in a good mood",
  sadness: "low",
  anger: "angry",
  fear: "worried",
  pride: "pleased with yourself",
  shame: "embarrassed about something",
  envy: "fed up, a bit envious of people",
  gratitude: "grateful to someone",
  loneliness: "lonely",
  love: "content",
};

function ago(world: WorldState, t: number): string {
  const d = dayOf(world.time) - dayOf(t);
  return d <= 0 ? "earlier today" : d === 1 ? "yesterday" : d < 7 ? `${d} days ago` : d < 20 ? "a couple of weeks ago" : "a while back";
}

function job(world: WorldState, c: Citizen): string {
  const biz = c.businessIds.map((id) => world.businesses[id]).find((b) => b && b.open);
  if (biz) return `run ${biz.name}`;
  if (c.occupation === "employee") return `work at ${c.employerId === "corp" ? "CityCorp" : (world.businesses[c.employerId ?? ""]?.name ?? "a local shop")}`;
  if (c.occupation === "unemployed") return "are out of work";
  return `are a ${c.occupation}`;
}

/** How they are right now, in words. */
export function stateInWords(world: WorldState, c: Citizen): string[] {
  const out: string[] = [];
  const d = dominantEmotion(c, 32);
  const cause = d ? [...c.memories.short, ...c.memories.long].filter((m) => world.time - m.t < 3 * 1440 && (m.emotions?.[d.emotion] ?? 0) >= 8 && m.kind !== "conversation").sort((a, b) => b.t - a.t)[0] : undefined;
  out.push(d ? `You're ${FEEL[d.emotion]}${cause ? ` (${cause.text.replace(/\.$/, "")})` : ""}.` : "You're alright, nothing much on your mind.");
  if (c.needs.energy < 25) out.push("You're exhausted.");
  else if (c.needs.energy < 45) out.push("You're a bit tired.");
  if (c.needs.hunger < 30) out.push("You're hungry and getting short-tempered.");
  if (c.needs.social < 30) out.push("You've been on your own a lot lately.");
  const s = situation(world, c);
  if (s.worry) out.push(`Money's on your mind: ${s.worry}`);
  const diary = c.agent?.diary[c.agent.diary.length - 1];
  if (diary && diary.day >= dayOf(world.time) - 1) out.push(`What you wrote in your diary last night: "${diary.text}"`);
  return out;
}

/** The memories worth having in mind right now (scored, best few). */
function relevantMemories(world: WorldState, me: Citizen, them: Citizen, topic: string | null): { text: string; label: string }[] {
  const seen = new Set<number>();
  const scored: { m: Memory; s: number }[] = [];
  const cues = topic ? topic.toLowerCase().match(/[a-z]{4,}/g) ?? [] : [];
  for (const m of [...me.memories.long, ...me.memories.short]) {
    if (seen.has(m.id) || m.kind === "conversation" && !m.people.includes(them.id)) continue;
    seen.add(m.id);
    const days = (world.time - m.t) / 1440;
    const s =
      Math.exp(-days / 5) * 0.3 +
      (m.importance / 10) * 0.3 +
      (m.people.includes(them.id) ? 0.35 : 0) +
      (cues.length && mentions(m.text, cues, 1) ? 0.3 : 0) +
      Math.abs(m.valence) * 0.12 * m.strength;
    scored.push({ m, s });
  }
  return scored
    .sort((a, b) => b.s - a.s)
    .slice(0, TALK.promptMemories)
    .map(({ m }) => ({ text: `${m.text} (${ago(world, m.t)})`, label: `memory: ${m.text.slice(0, 50)}` }));
}

/** Everything one speaker needs for one turn, from their side only. */
/** Who they are, how they talk, what matters to them (their character card and talk profile), in the second person. */
export function identityOf(world: WorldState, me: Citizen): string[] {
  const p = profileOf(me);
  const card = botCard(me);
  return [
    `You are ${me.name} ${me.surname}, ${me.age}. You ${job(world, me)} in Hustle City, a small British town.`,
    card.bio,
    `How you talk: ${card.custom && card.voice ? card.voice : p.habitText.length ? `${p.habitText.join(". ")}.` : "Plainly."}`,
    `Words you tend to use (now and then, not every line): "${p.lexicon.good}", "${p.lexicon.bad}", "${p.lexicon.very}", "${p.lexicon.agree}".${p.address ? ` With people you're easy with you sometimes call them "${p.address}".` : ""}`,
    p.verbosity < 0.35 ? "You don't say much: often a word or two." : p.verbosity > 0.7 ? "You can talk the hind legs off a donkey." : "",
    p.questionRate < 0.22 ? "You rarely ask questions; you mostly just say things." : "",
    p.insecurities.length ? `Touchy subjects for you: ${p.insecurities.join(", ")}.` : "",
    card.cares,
    card.secret ? `Something you keep to yourself (unless you really trust someone): ${card.secret}` : "",
    card.instructions ? `Also: ${card.instructions}` : "",
  ].filter(Boolean);
}

export function contextFor(world: WorldState, conv: Conversation, st: DialogueState, me: Citizen, them: Citizen, d: Directive): Context {
  const card = botCard(me);
  const rel: RelView = d.rel;
  const retrieved: string[] = [];
  const identity = identityOf(world, me);

  const relationship = relGuide(world, me, them, rel);
  const memories: string[] = [];
  const b = peekBond(me, them.id);
  const eps = (b?.episodes ?? []).slice(-TALK.promptEpisodes);
  if (b?.history) memories.push(`Your history with ${them.name}, roughly: ${b.history}`);
  for (const e of eps) {
    memories.push(`Last time you talked (${ago(world, e.t)}, at ${e.place}): ${e.summary}`);
    retrieved.push(`episode: ${e.summary.slice(0, 60)}`);
  }
  for (const th of dueThreads(world, b).slice(0, TALK.promptThreads)) {
    memories.push(`You meant to: ${th.text}.`);
    retrieved.push(`thread: ${th.text}`);
  }
  for (const f of factsAbout(world, me, them.id, TALK.promptFacts)) {
    const src = f.source === "told" && f.from === them.id ? `${them.name} told you` : f.source === "rumour" ? "a rumour" : f.from ? `${world.citizens[f.from]?.name ?? "someone"} told you` : f.source;
    memories.push(`You know (${src}${f.certainty < 0.5 ? ", not sure it's true" : ""}): ${f.text}.`);
    retrieved.push(`fact: ${f.text.slice(0, 60)}`);
  }
  for (const j of (b?.jokes ?? []).slice(0, 2)) memories.push(`A running joke between you: ${j.hook} ("${j.line}").`);
  if (b?.seemed) memories.push(`Last time ${them.name} seemed ${b.seemed.text}.`);
  for (const m of relevantMemories(world, me, them, st.topicLabel)) {
    memories.push(`You remember: ${m.text}`);
    retrieved.push(m.label);
  }
  // Gossip on their mind, if it's what this turn is about.
  if (d.topic?.kind === "gossip" && d.topic.about) {
    for (const f of factsAbout(world, me, d.topic.about, 2)) memories.push(`What you've heard about ${world.citizens[d.topic.about]?.name}: ${f.text}${f.source === "rumour" ? " (a rumour)" : ""}.`);
  }

  const scene: string[] = [];
  const h = hourOf(world.time);
  scene.push(`You're at ${placeName(world, conv.buildingId)}, ${h < 5 ? "in the middle of the night" : h < 12 ? "in the morning" : h < 17 ? "in the afternoon" : h < 22 ? "in the evening" : "late at night"}. You were ${me.activity.kind === "talk" ? "about your business" : me.activity.label.charAt(0).toLowerCase() + me.activity.label.slice(1)}.`);
  const weather = world.happenings.find((x) => !x.ended && world.time >= x.t && world.time < x.until && (x.kind === "storm" || x.kind === "power_cut" || x.kind === "festival"));
  if (weather) scene.push(weather.kind === "storm" ? "It's pouring down outside." : weather.kind === "power_cut" ? "The power's off across town." : "The festival's on in the park.");
  const near = st.nearby.map((id) => world.citizens[id]?.name).filter(Boolean);
  if (near.length) scene.push(`Also here, within earshot: ${near.slice(0, 4).join(", ")}. You wouldn't say anything private or about them in front of them.`);
  for (const k of me.news.slice(-2)) {
    const hap = happeningById(world, k.id);
    if (hap && world.time - k.t < 2 * 1440) scene.push(`You've heard about ${hap.about}.`);
  }

  const intentWords: Record<string, string> = {
    "pass time": "just passing the time",
    "check on them": `checking ${them.name}'s alright`,
    complain: "having a moan",
    brag: "letting them know how well you're doing",
    "ask a favour": "after a favour",
    "find something out": "wanting to find something out",
    "make peace": "wanting to patch things up",
    vent: "needing to get something off your chest",
    gossip: "itching to pass something on",
    confront: "wanting to have it out",
    "get advice": "wanting their advice",
    "joke around": "messing about",
    "share news": "wanting to tell them your news",
    "keep it short": "wanting to keep this short",
    "get away": "wanting to get away",
    "close the deal": "wanting to get this settled",
  };

  // In words a person would use: "in a couple of days", not "Day 11".
  const said = (xs: string[]) => xs.map((x) => spokenDays(x, world.time));
  return {
    identity: said(identity),
    examples: card.examples.slice(0, 4),
    state: said(stateInWords(world, me)),
    relationship: said(relationship),
    memories: said(memories.slice(0, 10)),
    scene,
    intent: `Privately, you're ${intentWords[st.intents[me.id] ?? "pass time"] ?? "just passing the time"}.`,
    plan: spokenDays(d.hint, world.time),
    retrieved: retrieved.slice(0, 10),
  };
}

/** Rough size of a context, in characters (for keeping prompts in budget). */
export function contextSize(c: Context): number {
  return [...c.identity, ...c.examples, ...c.state, ...c.relationship, ...c.memories, ...c.scene, c.intent, c.plan].join("\n").length;
}

/** Clip a context to a character budget, dropping the least important parts first. */
export function clipContext(c: Context, max: number): Context {
  const out = { ...c, memories: [...c.memories], scene: [...c.scene], identity: [...c.identity] };
  while (contextSize(out) > max && out.memories.length > 2) out.memories.pop();
  while (contextSize(out) > max && out.scene.length > 1) out.scene.pop();
  while (contextSize(out) > max && out.identity.length > 3) out.identity.splice(out.identity.length - 2, 1);
  return out;
}

