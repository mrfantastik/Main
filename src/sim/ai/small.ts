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

export const SMALL_CHAT_SYSTEM =
  "You are a person in Hustle City, a small British town, talking with someone. Stay in character: talk the way you talk, about your own life, worries and opinions, like a real person would, and answer what was just said to you. " +
  "Reply with only what you say next: one or two short sentences. No name, no quotation marks, no actions.";

export const SMALL_THOUGHT_SYSTEM =
  "You write the private thoughts of people in a story set in Hustle City, a small British town. Write in the first person, as the person, in one or two short sentences: specific, honest, sometimes funny, sometimes worried. No quotation marks. " +
  "For example, for a baker short of money: Flour's gone up again and rent's due Friday. If Priya pays me back I might just make it.";

export const SMALL_CHOICE_SYSTEM =
  "You decide what a person in a story would really do, given who they are and how they feel. Answer with the option number, then one short sentence in their voice saying why.";

export const SMALL_DAY_PLAN_SYSTEM =
  "You plan the day of a person in a story set in Hustle City, a small British town, the way they would plan it themselves: their work, money, meals, friends and what they want out of life. " +
  "Write one line per thing, in time order: the time, the number of the thing from their list, a dash, and a few words in their voice saying why. For example:\n8am: 2 - rent's due Friday, every shift counts\n1pm: 5 - Priya's been quiet lately";

export const SMALL_DIARY_SYSTEM =
  "You write the diary of a person in a story set in Hustle City, a small British town. Write in the first person, as them, one or two short sentences about their day: what happened, how they feel about it, what they'll do about it. Specific and honest. No quotation marks.";

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

/** The thing on their mind: last night's diary, a worry, a big moment today, or news. */
function onTheirMind(world: WorldState, c: Citizen): string[] {
  const out: string[] = [];
  const diary = c.agent?.diary[c.agent.diary.length - 1];
  if (diary && diary.day >= dayOf(world.time) - 1) out.push(`From their diary: "${diary.text}"`);
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
  return out.slice(0, 4);
}

/** "8am", "1:30pm". */
export function hourLabel(h: number): string {
  const hh = Math.floor(h) % 24;
  const mm = Math.round((h - Math.floor(h)) * 60);
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}${mm ? `:${String(mm).padStart(2, "0")}` : ""}${hh < 12 ? "am" : "pm"}`;
}

/** Their plan for today, as they'd read it back ("8am work (done), 1pm see Priya"). */
function planLine(c: Citizen, day: number): string {
  const plan = c.agent?.plan;
  if (!plan || plan.day !== day || !plan.items.length) return "";
  return `Their plan for today: ${plan.items.map((i) => `${hourLabel(i.hour)} ${i.label.charAt(0).toLowerCase()}${i.label.slice(1)}${i.status === "done" ? " (done)" : i.status === "skipped" ? " (didn't happen)" : ""}`).join("; ")}.`;
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
  kind: "lines" | "turn" | "thought" | "choice" | "plan" | "diary";
  /** For "lines": who may speak. For "choice" and "plan": option ids in order (and for "plan", their labels). */
  names?: string[];
  options?: string[];
  labels?: string[];
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

/** Where a live chat is: starting it, in the middle, winding it up, or saying goodbye back. */
export type TurnPhase = "open" | "talk" | "wrap" | "byeback";

/**
 * One person's turn in a live chat: who they are, how they feel, what's on
 * their mind, what they remember about the other person, where they are, and
 * the conversation so far. They say the next thing, as themselves.
 * `decided`: what happens, when the town has already settled it (a loan, a job).
 */
export function smallTurnPrompt(world: WorldState, conv: Conversation, me: Citizen, them: Citizen, phase: TurnPhase, decided: string | null): SmallPrompt {
  const remember = [...me.memories.short, ...me.memories.long]
    .filter((m) => m.people.includes(them.id) && m.importance >= 3)
    .sort((x, y) => y.t - x.t)
    .slice(0, 2)
    .map((m) => `- ${m.text}`);
  const said = conv.lines.slice(-8).map((l) => `${world.citizens[l.speaker]?.name ?? "?"}: ${l.text}`);
  const ask =
    phase === "open"
      ? `You've just run into ${them.name}. Start the conversation your way.`
      : phase === "wrap"
        ? `You need to go now. Answer what ${them.name} said, then say goodbye your way.`
        : phase === "byeback"
          ? `${them.name} is leaving. Say goodbye back.`
          : `Answer what ${them.name} just said, as yourself, and add something of your own: a question, an opinion, or your news.`;
  const user = [
    `You are ${sketch(world, me)}`,
    ...onTheirMind(world, me).map((x) => `- ${x}`),
    `You're at ${placeName(world, conv.buildingId)}, ${partOfDay(world.time)}, with ${them.name} (${them.age}, ${job(world, them)}). ${relation(world, me, them)}.`,
    remember.length ? `You remember:\n${remember.join("\n")}` : "",
    decided ? `What happens (already decided, stick to it): ${decided}` : "",
    said.length ? `The conversation so far:\n${said.join("\n")}` : "",
    ask,
  ]
    .filter(Boolean)
    .join("\n");
  return { system: SMALL_CHAT_SYSTEM, user, prefill: `${me.name}:`, kind: "turn", names: [me.name, them.name] };
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
export function smallNextPrompt(world: WorldState, c: Citizen, options: { id: string; label: string }[]): SmallPrompt {
  const s = situation(world, c);
  const body = [s.hungry > 0.75 ? "very hungry" : s.hungry > 0.5 ? "hungry" : "", s.tired > 0.75 ? "exhausted" : s.tired > 0.5 ? "tired" : ""].filter(Boolean);
  const doing = c.activity.label.charAt(0).toLowerCase() + c.activity.label.slice(1);
  const user = [
    sketch(world, c),
    `It's ${formatTime(world.time).replace(/^Day \d+ /, "")} ${partOfDay(world.time)}. ${c.name} is ${doing}${body.length ? `, and ${body.join(" and ")}` : ""}.`,
    ...onTheirMind(world, c),
    `Money: ${money(c.money)} in their pocket, ${money(c.savings)} saved. Goal: ${c.goal.label}.`,
    planLine(c, dayOf(world.time)),
    `After this, what does ${c.name} do?`,
    ...options.map((o, i) => `${i + 1}. ${o.label}`),
  ]
    .filter(Boolean)
    .join("\n");
  return { system: SMALL_CHOICE_SYSTEM, user, prefill: "", kind: "choice", options: options.map((o) => o.id) };
}

/** Something just happened to them: what goes through their mind. */
export function smallReactionPrompt(world: WorldState, c: Citizen, what: string): SmallPrompt {
  const user = [
    sketch(world, c),
    `Just now: ${what}`,
    `Money: ${money(c.money)} in their pocket, ${money(c.savings)} saved. Goal: ${c.goal.label}.`,
    ...onTheirMind(world, c).filter((x) => !x.includes(what)),
    `What goes through ${c.name}'s mind right now, and what will they do about it?`,
  ].join("\n");
  return { system: SMALL_THOUGHT_SYSTEM, user, prefill: "", kind: "thought" };
}

/** Their plan for a day, from the things they could do that day (numbered). `news`: something that's just happened to them. */
export function smallDayPlanPrompt(world: WorldState, c: Citizen, day: number, wake: number, things: { id: string; label: string }[], news?: string): SmallPrompt {
  const first = hourLabel(Math.ceil(wake * 2) / 2);
  const user = [
    sketch(world, c),
    ...(news ? [`Just now: ${news}`] : []),
    ...onTheirMind(world, c),
    `Money: ${money(c.money)} in their pocket, ${money(c.savings)} saved. Goal: ${c.goal.label}.`,
    news ? `It's day ${day}, ${first}. After what's happened, things ${c.name} could do with the rest of the day:` : `It's day ${day}. ${c.name} gets up at about ${first}. Things ${c.name} could do today:`,
    ...things.map((o, i) => `${i + 1}. ${o.label}`),
    news ? `Write ${c.name}'s new plan for the rest of today: 3 to 5 lines, from ${first}.` : `Write ${c.name}'s plan for today: 4 to 6 lines, from ${first} to the evening.`,
  ].join("\n");
  return { system: SMALL_DAY_PLAN_SYSTEM, user, prefill: `${first}:`, kind: "plan", options: things.map((o) => o.id), labels: things.map((o) => o.label) };
}

/** Last thing at night: a line in their diary about the day. */
export function smallDiaryPrompt(world: WorldState, c: Citizen): SmallPrompt {
  const today = dayOf(c.activity.kind === "sleep" ? c.activity.startedAt - 4 * 60 : world.time);
  const happened = [...c.memories.short, ...c.memories.long]
    .filter((m) => dayOf(m.t) === today)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 4)
    .map((m) => `- ${m.text}`);
  const user = [
    sketch(world, c),
    `Money: ${money(c.money)} in their pocket, ${money(c.savings)} saved. Goal: ${c.goal.label}.`,
    planLine(c, today),
    happened.length ? `What happened today:\n${happened.join("\n")}` : "A quiet day: nothing much happened.",
    `Before going to sleep, ${c.name} writes in their diary. What do they write?`,
  ]
    .filter(Boolean)
    .join("\n");
  return { system: SMALL_DIARY_SYSTEM, user, prefill: "Today", kind: "diary" };
}

// ------------------------------------------------------------- readers

/** Looks like words a person would say (not markup, not a model talking about itself, not noise). */
export function looksLikeSpeech(t: string): boolean {
  if (t.length < 2 || t.length > 220) return false;
  if (/<\||\|>|https?:|assistant|\buser\b|as an ai|language model|^\W*$/i.test(t)) return false;
  // A chatbot talking to its user, not a person talking to a neighbour.
  if (/how (can|may) i (help|assist)|i'm here to help|happy to help you|i'm just an? (ai|program|bot)|i don't have (feelings|personal)/i.test(t)) return false;
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

/** One person's next line in a live chat, cleaned up ("" if it isn't something a person would say). */
export function readTurn(text: string, me: string, them: string): string {
  let t = text.replace(new RegExp(`^\\s*\\**\\s*${me}\\s*\\**\\s*:\\s*`, "i"), "").split(/\n/)[0];
  // The other person starting to talk (or a new speaker label): stop there.
  const cut = t.search(new RegExp(`\\b(${them}|${me})\\s*:`, "i"));
  if (cut >= 0) t = t.slice(0, cut);
  t = t
    .replace(/\*[^*]*\*/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/^["“'\s]+|["”'\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = t.match(/[^.!?]+[.!?]+["”']?/g) ?? (t ? [t] : []);
  t = sentences
    .slice(0, 2)
    .map((x) => x.trim())
    .join(" ");
  if (t && !/[.!?…]$/.test(t)) t += ".";
  return t.length >= 2 && t.length <= 200 && looksLikeSpeech(t) ? t : "";
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

const STOP = new Set(["with", "from", "that", "this", "your", "their", "about", "some", "into", "at", "the", "and", "for", "go", "to", "a", "an", "of", "in", "on"]);
const words = (t: string) => t.toLowerCase().match(/[a-z']{3,}/g)?.filter((w) => !STOP.has(w)) ?? [];

/** "8am: 2 - rent's due" lines -> plan items (hour, option, why), in time order. Lines that name a thing in words are matched to the list. */
export function readPlan(text: string, ids: string[], labels: string[]): { hour: number; id: string; why: string }[] {
  const out: { hour: number; id: string; why: string }[] = [];
  for (const raw of text.split(/\n+/)) {
    const m = raw.match(/^\s*[-*•]?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*[:\-–.]?\s*(.+)$/i);
    if (!m) {
      if (out.length && raw.trim()) break;
      continue;
    }
    let h = Number(m[1]) + (m[2] ? Number(m[2]) / 60 : 0);
    const ap = (m[3] ?? "").toLowerCase().replace(/\./g, "");
    if (ap === "pm" && h < 12) h += 12;
    else if (ap === "am" && h >= 12) h -= 12;
    else if (!ap && h < 6) h += 12; // "1: lunch" means 1pm
    if (h < 4 || h >= 23) continue; // the small hours are for sleeping
    let rest = m[4].trim();
    let idx = -1;
    const num = rest.match(/^(?:no\.?\s*|number\s*|#)?(\d{1,2})\b[\s.):]*(?:[-–—:,]\s*)?(.*)$/i);
    if (num && Number(num[1]) >= 1 && Number(num[1]) <= ids.length) {
      idx = Number(num[1]) - 1;
      rest = num[2].trim();
    } else {
      // In words: the thing on the list sharing the most words with it.
      const said = new Set(words(rest));
      let best = 0;
      labels.forEach((l, i) => {
        const shared = words(l).filter((w) => said.has(w)).length;
        if (shared > best) {
          best = shared;
          idx = i;
        }
      });
    }
    if (idx < 0) continue;
    let why = rest
      .replace(/^[-–—:,\s]+/, "")
      .replace(/^["“]|["”]$/g, "")
      .trim();
    if (why && labels[idx] && why.toLowerCase().startsWith(labels[idx].toLowerCase())) why = why.slice(labels[idx].length).replace(/^[\s\-–—:,]+/, "");
    if (why && !looksLikeSpeech(why)) why = "";
    if (out.length && h <= out[out.length - 1].hour) continue; // keep time order
    if (out.length && out[out.length - 1].id === ids[idx]) continue;
    out.push({ hour: h, id: ids[idx], why: why.slice(0, 140) });
    if (out.length >= 7) break;
  }
  return out;
}

/** A diary entry: the first couple of sentences, cleaned up. */
export function readDiary(text: string): string {
  const t = readThought(text.replace(/\n+/g, " "), "");
  return t.length >= 12 ? t : "";
}
