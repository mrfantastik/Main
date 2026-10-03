import { placeName } from "../places";
import { dominantEmotion } from "../mind/emotions";
import { dayOf, formatTime } from "../time";
import type { Citizen, Conversation, SpeakingStyle, WorldState } from "../types";
import { money } from "../util";
import { situation } from "./situation";

// Prompts and readers for a small language model running in the page (the
// town's brain). A model with a few hundred million parameters does best with
// short, concrete prompts and a plain format ("Name: words"), and it needs a
// nudge to stay on track, so each prompt carries the beats of the scene, the
// people's voices and what's really on their minds, and the reply is
// started for it. The engine still decides what happens; the model writes
// how they say it and what they're thinking.

export const SMALL_TALK_SYSTEM =
  "You write dialogue for a story set in Hustle City, a small British town. Every person has their own voice, worries and opinions, and they talk like real people: short lines, specific details, jokes, questions, the odd grumble. " +
  "Write only the spoken lines, each starting with the speaker's first name and a colon.";

export const SMALL_THOUGHT_SYSTEM =
  "You write the private thoughts of people in a story set in Hustle City, a small British town. Write in the first person, as the person, in one or two short sentences: specific, honest, sometimes funny, sometimes worried. No quotation marks. " +
  "For example, for a baker short of money: Flour's gone up again and rent's due Friday. If Priya pays me back I might just make it.";

export const SMALL_CHOICE_SYSTEM =
  "You decide what a person in a story would really do, given who they are and how they feel. Answer with the option number, then one short sentence in their voice saying why.";

const VOICE: Record<SpeakingStyle, string> = {
  formal: "speaks formally and politely, never uses slang",
  blunt: "blunt and brief, says exactly what they think",
  chatty: "chatty, goes off on tangents, lots of exclamations",
  sarcastic: "dry and sarcastic, teases people",
  warm: "warm and kind, calls people love or mate",
  nervous: "nervous and hesitant, says um and sorry a lot",
};

const FEEL: Record<string, string> = {
  joy: "happy",
  sadness: "low",
  anger: "angry",
  fear: "worried",
  pride: "proud of themselves",
  shame: "embarrassed",
  envy: "envious",
  gratitude: "grateful",
  loneliness: "lonely",
  love: "content",
};

function partOfDay(t: number): string {
  const h = Math.floor((t % 1440) / 60);
  return h < 5 ? "late at night" : h < 12 ? "in the morning" : h < 17 ? "in the afternoon" : h < 22 ? "in the evening" : "late at night";
}

function job(world: WorldState, c: Citizen): string {
  const biz = c.businessIds.map((id) => world.businesses[id]).find((b) => b && b.open);
  if (biz) return `runs ${biz.name}`;
  if (c.occupation === "employee") return `works at ${c.employerId === "corp" ? "CityCorp" : (world.businesses[c.employerId ?? ""]?.name ?? "a local shop")}`;
  if (c.occupation === "unemployed") return "out of work";
  return `a ${c.occupation}`;
}

/** One line about who someone is and how they are right now. */
export function sketch(world: WorldState, c: Citizen): string {
  const d = dominantEmotion(c);
  const feel = d && d.level >= 30 ? FEEL[d.emotion] : "fine";
  return `${c.name} (${c.age}, ${job(world, c)}): ${VOICE[c.personality.style]}. Feeling ${feel}. Dreams of ${c.personality.dream}.`;
}

/** The thing on their mind: a worry, a big moment today, or news. */
function onTheirMind(world: WorldState, c: Citizen): string[] {
  const out: string[] = [];
  const s = situation(world, c);
  if (s.worry) out.push(`Worried: "${s.worry}"`);
  const today = dayOf(world.time);
  const big = [...c.memories.short, ...c.memories.long]
    .filter((m) => dayOf(m.t) >= today - 1 && m.importance >= 6 && m.kind !== "conversation")
    .sort((a, b) => b.importance - a.importance)[0];
  if (big) out.push(`Lately: ${big.text}`);
  const heard = c.news
    .slice(-2)
    .map((k) => world.happenings.find((h) => h.id === k.id)?.title)
    .filter(Boolean);
  if (heard.length) out.push(`Heard about: ${heard.join("; ")}`);
  return out.slice(0, 3);
}

function relation(world: WorldState, a: Citizen, b: Citizen): string {
  if (a.family.includes(b.id)) return `${a.name} and ${b.name} are family`;
  const r = a.relationships[b.id];
  if (!r || r.familiarity < 5) return `${a.name} and ${b.name} have just met`;
  if (r.affinity > 50) return `${a.name} and ${b.name} are close friends`;
  if (r.affinity > 20) return `${a.name} and ${b.name} get on well`;
  if (r.affinity < -40) return `${a.name} can't stand ${b.name}`;
  if (r.affinity < -10) return `${a.name} is wary of ${b.name}`;
  return `${a.name} and ${b.name} know each other a little`;
}

/** "A greets B" -> "Mike greets Sarah". */
export function withNames(text: string, a: Citizen, b: Citizen): string {
  return text.replace(/\bA\b/g, a.name).replace(/\bB\b/g, b.name);
}

export interface SmallPrompt {
  system: string;
  user: string;
  /** The start of the reply, written for the model (it carries on from here). */
  prefill: string;
  kind: "lines" | "thought" | "choice";
  /** For "lines": who may speak. For "choice": option ids in order. */
  names?: string[];
  options?: string[];
}

/** A conversation: who, where, how they speak, what's on their minds, what happens, and a rough draft to improve on. */
export function smallConversationPrompt(world: WorldState, conv: Conversation, brief: string): SmallPrompt {
  const a = world.citizens[conv.a];
  const b = world.citizens[conv.b];
  const beats = brief
    .replace(/^A casual chat\. Beats, in order \(keep to them, in your own words\): /, "")
    .split(/(?<=\.)\s+(?=[A-Z])/)
    .map((x) => `- ${withNames(x.trim(), a, b)}`)
    .slice(0, 6);
  const draft = (conv.fallback?.lines ?? []).slice(0, 10).map((l) => `${world.citizens[l.speaker]?.name ?? "?"}: ${l.text}`);
  const mind = (c: Citizen) => onTheirMind(world, c).map((x) => `  ${x}`);
  const user = [
    `${placeName(world, conv.buildingId)}, ${partOfDay(world.time)}. ${relation(world, a, b)}.`,
    sketch(world, a),
    ...mind(a),
    sketch(world, b),
    ...mind(b),
    conv.topic === "chat" ? `What they talk about:\n${beats.join("\n")}` : `What happens (already decided, keep it): ${withNames(conv.summary || brief, a, b).slice(0, 300)}`,
    draft.length ? `A rough draft (say the same things, but better: in their own voices, with real details):\n${draft.join("\n")}` : "",
    `Write their conversation, ${draft.length > 6 ? "7 to 10" : "5 to 8"} lines, ${a.name} first.`,
  ]
    .filter(Boolean)
    .join("\n");
  return { system: SMALL_TALK_SYSTEM, user, prefill: `${a.name}:`, kind: "lines", names: [a.name, b.name] };
}

/** What someone is thinking right now. */
export function smallThoughtPrompt(world: WorldState, c: Citizen): SmallPrompt {
  const user = [
    sketch(world, c),
    `It's ${formatTime(world.time).replace(/^Day \d+ /, "")} ${partOfDay(world.time)}. ${c.name} is ${c.activity.label.charAt(0).toLowerCase()}${c.activity.label.slice(1)} (${placeName(world, c.insideId)}).`,
    ...onTheirMind(world, c),
    `Money: ${money(c.money)} in their pocket, ${money(c.savings)} saved. Goal: ${c.goal.label}.`,
    `What is ${c.name} thinking right now?`,
  ].join("\n");
  return { system: SMALL_THOUGHT_SYSTEM, user, prefill: "", kind: "thought" };
}

/** A tough choice, as a numbered list. */
export function smallChoicePrompt(world: WorldState, c: Citizen, options: { id: string; label: string }[]): SmallPrompt {
  const user = [
    sketch(world, c),
    ...onTheirMind(world, c),
    `Money: ${money(c.money)} in their pocket, ${money(c.savings)} saved.`,
    `${c.name} has to decide:`,
    ...options.map((o, i) => `${i + 1}. ${o.label}`),
    `Which would ${c.name} choose?`,
  ].join("\n");
  return { system: SMALL_CHOICE_SYSTEM, user, prefill: "", kind: "choice", options: options.map((o) => o.id) };
}

/** What they'll do once they've finished what they're doing (asked while they're still at it). */
export function smallPlanPrompt(world: WorldState, c: Citizen, options: { id: string; label: string }[]): SmallPrompt {
  const s = situation(world, c);
  const body = [s.hungry > 0.75 ? "very hungry" : s.hungry > 0.5 ? "hungry" : "", s.tired > 0.75 ? "exhausted" : s.tired > 0.5 ? "tired" : ""].filter(Boolean);
  const doing = c.activity.label.charAt(0).toLowerCase() + c.activity.label.slice(1);
  const user = [
    sketch(world, c),
    `It's ${formatTime(world.time).replace(/^Day \d+ /, "")} ${partOfDay(world.time)}. ${c.name} is ${doing}${body.length ? `, and ${body.join(" and ")}` : ""}.`,
    ...onTheirMind(world, c),
    `Money: ${money(c.money)} in their pocket, ${money(c.savings)} saved. Goal: ${c.goal.label}.`,
    `After this, what does ${c.name} do?`,
    ...options.map((o, i) => `${i + 1}. ${o.label}`),
  ].join("\n");
  return { system: SMALL_CHOICE_SYSTEM, user, prefill: "", kind: "choice", options: options.map((o) => o.id) };
}

// ------------------------------------------------------------- readers

/** Looks like words a person would say (not markup, not a model talking about itself, not noise). */
export function looksLikeSpeech(t: string): boolean {
  if (t.length < 2 || t.length > 220) return false;
  if (/<\||\|>|https?:|assistant|\buser\b|as an ai|language model|^\W*$/i.test(t)) return false;
  const letters = (t.match(/[A-Za-z]/g) ?? []).length;
  return letters / t.length > 0.55;
}

/** "Mike: Hello!" lines, only from the two people talking, until the model wanders off. */
export function readLines(text: string, names: string[]): { speaker: string; text: string }[] {
  const out: { speaker: string; text: string }[] = [];
  for (const raw of text.split(/\n+/)) {
    const m = raw.match(/^\s*\**\s*([A-Z][A-Za-z'-]+)\s*\**\s*:\s*(.+)$/);
    if (!m) {
      if (out.length && raw.trim()) break; // narration or a new section: stop here
      continue;
    }
    const who = names.find((n) => n.toLowerCase() === m[1].toLowerCase());
    if (!who) break; // someone else has walked in: stop
    const said = m[2].trim().replace(/^["“]|["”]$/g, "");
    if (!looksLikeSpeech(said)) break; // gibberish: stop here
    if (out.some((l) => l.text === said)) continue;
    out.push({ speaker: who, text: said });
    if (out.length >= 12) break;
  }
  return out;
}

/** The first sentence or two, cleaned up. */
export function readThought(text: string, name: string): string {
  let t = text
    .split(/\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? "";
  t = t
    .replace(new RegExp(`^${name}\\s*(thinks|:)\\s*:?\\s*`, "i"), "")
    .replace(/^["“'*]+|["”'*]+$/g, "")
    .trim();
  const sentences = t.match(/[^.!?]+[.!?]+/g) ?? (t ? [t] : []);
  t = sentences
    .slice(0, 2)
    .map((x) => x.trim())
    .join(" ");
  if (t && !/[.!?…]$/.test(t)) t += ".";
  return t.length >= 6 && t.length <= 220 && looksLikeSpeech(t) ? t : "";
}

/** "2. Because..." -> the second option, and the reason. */
export function readChoice(text: string, options: string[]): { choice: string; thought: string } | null {
  const m = text.match(/\b([1-9])\b/);
  const n = m ? Number(m[1]) : NaN;
  if (!(n >= 1 && n <= options.length)) return null;
  const rest = text.slice((m!.index ?? 0) + 1).replace(/^[\s.):\-–]+/, "");
  const why = readThought(rest.replace(/^(option|number)\s*\d+[.:]?\s*/i, ""), "");
  return { choice: options[n - 1], thought: why };
}
