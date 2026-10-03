// Interfaces and prompt builders for the (optional) LLM layer.
// The simulation never imports an SDK: the server injects an LLMClient.

import { placeName } from "../places";
import { recallAbout } from "../memory/memory";
import { personalitySummary } from "../mind/personality";
import { formatTime } from "../time";
import { EMOTIONS, type Citizen, type Conversation, type Memory, type Reflection, type WorldState } from "../types";
import { money } from "../util";
import { relLabel } from "../social/relationships";
import { situation } from "./situation";

export interface LLMRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}

export interface LLMResponse {
  json: unknown;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface LLMClient {
  readonly model: string;
  complete(req: LLMRequest): Promise<LLMResponse>;
}

/** $ per million tokens (input, output). Used to track spend precisely. */
const PRICES: Record<string, [number, number]> = {
  "claude-fable-5-1": [10, 50],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const [pin, pout] = PRICES[model] ?? [5, 25];
  return (inputTokens * pin + outputTokens * pout) / 1_000_000;
}

// ------------------------------------------------------------- profiles

function traitWords(c: Citizen): string {
  const t = c.traits;
  const words: string[] = [...c.archetypes.map((a) => a.toLowerCase())];
  if (t.generosity > 0.7 && !words.includes("generous")) words.push("generous");
  if (t.greed > 0.7 && !words.includes("greedy")) words.push("greedy");
  if (t.diligence < 0.3 && !words.includes("lazy")) words.push("lazy");
  if (t.sociability > 0.75) words.push("outgoing");
  if (t.sociability < 0.25) words.push("introverted");
  return words.slice(0, 5).join(", ");
}

export function profile(world: WorldState, c: Citizen): string {
  const s = situation(world, c);
  const biz = c.businessIds.map((id) => world.businesses[id]).filter((b) => b && b.open);
  const job =
    c.occupation === "employee"
      ? `employee at ${c.employerId === "corp" ? "CityCorp" : world.businesses[c.employerId ?? ""]?.name ?? "a business"} (£${Math.round(c.wage)}/day)`
      : c.occupation + (biz.length ? ` (owns ${biz.map((b) => `${b.name}, ~${money(b.avgProfit)}/day profit`).join("; ")})` : s.occEarnAvg ? ` (earning ~${money(s.occEarnAvg)}/day lately)` : "");
  const debts = world.loans.filter((l) => l.borrower === c.id && l.status === "active").reduce((a, l) => a + l.totalDue - l.paid, 0);
  const p = c.personality;
  return [
    `${c.name} ${c.surname}, ${c.age}. Traits: ${traitWords(c)}. ${personalitySummary(p)} Speaking style: ${p.style}.`,
    `Quirks: ${p.quirks.join("; ") || "none"}. Likes ${p.likes.join(", ")}; dislikes ${p.dislikes.join(", ")}. Afraid of ${p.fear}; dreams of ${p.dream}.`,
    `Job: ${job}. Cash ${money(c.money)}, savings ${money(c.savings)}${debts > 0 ? `, owes ${money(debts)}` : ""}. Goal: ${c.goal.label}. Mood ${Math.round(c.mood)}/100. Feeling: ${feelingWords(c)}.${c.homeless ? " Homeless." : ""}`,
  ].join(" ");
}

/** "anxious (fear 62), lonely (loneliness 48)" — the feelings that stand out. */
export function feelingWords(c: Citizen): string {
  const strong = EMOTIONS.map((e) => [e, Math.round(c.emotions[e])] as const)
    .filter(([e, v]) => v >= (e === "joy" || e === "love" ? 45 : 25))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  return strong.length ? strong.map(([e, v]) => `${e} ${v}`).join(", ") : "calm";
}

function feltText(m: Memory): string {
  const top = Object.entries(m.emotions ?? {})
    .filter(([, v]) => (v ?? 0) >= 5)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, 2)
    .map(([e]) => e);
  return top.length ? ` (felt ${top.join(" and ")})` : "";
}

function memoryLines(c: Citizen, limit: number, aboutId?: string): string[] {
  const mems = aboutId ? recallAbout(c, aboutId, limit) : [...c.memories.long].sort((a, b) => b.importance * b.strength - a.importance * a.strength).slice(0, limit);
  return mems.map((m) => `- ${formatTime(m.t).replace(/ \d\d:\d\d$/, "")}: ${m.text}${feltText(m)}`);
}

/** Lessons they've drawn from experience (strongest first). */
function lessonLines(c: Citizen, limit: number, about?: string): string[] {
  return [...c.reflections]
    .filter((r) => !about || r.about === about || r.kind !== "person")
    .sort((a, b) => b.strength - a.strength)
    .slice(0, limit)
    .map((r) => `- ${r.text}`);
}

// --------------------------------------------------------- strategy prompt

export const STRATEGY_SYSTEM =
  "You are the inner voice of a citizen in 'AI Hustle City', a British small-town economic life simulation. " +
  "Choose the option this person would genuinely pick given their personality, situation, memories and what they've heard. " +
  "People aren't perfectly rational: pride, loyalty, fear, envy and ambition matter. Reply only with JSON.";

export function strategyPrompt(world: WorldState, c: Citizen, options: { id: string; label: string }[]): { user: string; schema: Record<string, unknown> } {
  const stories = c.beliefs.stories.slice(-3).map((s) => `- ${world.citizens[s.citizenId]?.name ?? "someone"} makes ~${money(s.amount)}/day as a ${s.occupation}${s.productId ? ` selling ${world.products[s.productId]?.name.toLowerCase()}` : ""}`);
  const s = situation(world, c);
  const user = [
    `Time: ${formatTime(world.time)}.`,
    `Citizen: ${profile(world, c)}`,
    s.worry ? `Worry: ${s.worry}` : "",
    memoryLines(c, 4).length ? `Important memories:\n${memoryLines(c, 4).join("\n")}` : "",
    lessonLines(c, 3).length ? `Lessons they've learned:\n${lessonLines(c, 3).join("\n")}` : "",
    stories.length ? `What they've heard:\n${stories.join("\n")}` : "",
    `Options:\n${options.map((o) => `[${o.id}] ${o.label}`).join("\n")}`,
    `Return {"choice": one option id, "thought": their inner monologue, first person, max 35 words, mentioning the real reason}.`,
  ]
    .filter(Boolean)
    .join("\n");
  const schema = {
    type: "object",
    properties: { choice: { type: "string", enum: options.map((o) => o.id) }, thought: { type: "string" } },
    required: ["choice", "thought"],
    additionalProperties: false,
  };
  return { user, schema };
}

// ----------------------------------------------------- conversation prompt

export const CONVERSATION_SYSTEM =
  "You write short, natural dialogue between two citizens of 'AI Hustle City', a British small-town economic simulation, and decide how the conversation ends. " +
  "The constraints are the real limits of what each person can and will do — the outcome must respect them. " +
  "Lines are spoken words only (no narration), under 20 words, in character, plain British English. Reply only with JSON.";

export function conversationPrompt(world: WorldState, conv: Conversation, brief: string, outcomeSchema: Record<string, unknown>): { user: string; schema: Record<string, unknown> } {
  const a = world.citizens[conv.a];
  const b = world.citizens[conv.b];
  const place = placeName(world, conv.buildingId);
  const rel = (x: Citizen, y: Citizen) => {
    const r = x.relationships[y.id];
    return r ? `${relLabel(r).toLowerCase()} (affinity ${Math.round(r.affinity)}, trust ${Math.round(r.trust)})` : "strangers";
  };
  const memA = memoryLines(a, 2, b.id);
  const memB = memoryLines(b, 3, a.id);
  const user = [
    `Place: ${place}, ${formatTime(world.time)}.`,
    `A: ${profile(world, a)}`,
    `B: ${profile(world, b)}`,
    `A sees B as: ${rel(a, b)}.${memA.length ? ` A remembers:\n${memA.join("\n")}` : ""}`,
    `B sees A as: ${rel(b, a)}.${memB.length ? ` B remembers:\n${memB.join("\n")}` : ""}`,
    lessonLines(a, 2, b.id).length ? `A's lessons:\n${lessonLines(a, 2, b.id).join("\n")}` : "",
    lessonLines(b, 2, a.id).length ? `B's lessons:\n${lessonLines(b, 2, a.id).join("\n")}` : "",
    `Situation and constraints: ${brief}`,
    `Write 3-6 alternating lines, A first. Each speaks in their own style (A ${a.personality.style}, B ${b.personality.style}), shows how they feel right now, and may bring up something they remember about the other. Then the outcome.`,
  ]
    .filter(Boolean)
    .join("\n");
  const props = (outcomeSchema as Record<string, unknown>) ?? {};
  const schema = {
    type: "object",
    properties: {
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: { speaker: { type: "string", enum: ["A", "B"] }, text: { type: "string" } },
          required: ["speaker", "text"],
          additionalProperties: false,
        },
      },
      outcome: { type: "object", properties: props, required: Object.keys(props), additionalProperties: false },
    },
    required: ["lines", "outcome"],
    additionalProperties: false,
  };
  return { user, schema };
}

// ------------------------------------------------------- reflection prompt

export const REFLECTION_SYSTEM =
  "You are the inner voice of a citizen of 'AI Hustle City', a British small-town economic life simulation, lying awake at night going over the day. " +
  "Reword each lesson in their own voice and speaking style, first person, max 18 words. Keep its meaning and who it's about. Reply only with JSON.";

export function reflectionPrompt(world: WorldState, c: Citizen, learned: Reflection[]): { user: string; schema: Record<string, unknown> } {
  const since = world.time - 26 * 60;
  const today = [...c.memories.long, ...c.memories.short]
    .filter((m) => m.t >= since)
    .sort((a, b) => Math.abs(b.valence) * b.importance - Math.abs(a.valence) * a.importance)
    .slice(0, 5)
    .map((m) => `- ${m.text}${feltText(m)}`);
  const user = [
    `Citizen: ${profile(world, c)}`,
    today.length ? `The day's strongest memories:\n${today.join("\n")}` : "",
    `Lessons to reword:\n${learned.map((r) => `[${r.key}] ${r.text}`).join("\n")}`,
    `Return {"lessons": [{"key": the lesson key, "text": the lesson in their words}]} with one entry per lesson.`,
  ]
    .filter(Boolean)
    .join("\n");
  const schema = {
    type: "object",
    properties: {
      lessons: {
        type: "array",
        items: {
          type: "object",
          properties: { key: { type: "string", enum: learned.map((r) => r.key) }, text: { type: "string" } },
          required: ["key", "text"],
          additionalProperties: false,
        },
      },
    },
    required: ["lessons"],
    additionalProperties: false,
  };
  return { user, schema };
}
