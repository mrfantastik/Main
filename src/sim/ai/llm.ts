// Interfaces and prompt builders for the (optional) LLM layer.
// The simulation never imports an SDK: the server injects an LLMClient.

import { placeName } from "../places";
import { recallAbout } from "../memory/memory";
import { formatTime } from "../time";
import type { Citizen, Conversation, WorldState } from "../types";
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
  return `${c.name} ${c.surname}, ${c.age}. Personality: ${traitWords(c)}. Job: ${job}. Cash ${money(c.money)}, savings ${money(c.savings)}${debts > 0 ? `, owes ${money(debts)}` : ""}. Goal: ${c.goal.label}. Mood ${Math.round(c.mood)}/100.${c.homeless ? " Homeless." : ""}`;
}

function memoryLines(c: Citizen, limit: number, aboutId?: string): string[] {
  const mems = aboutId ? recallAbout(c, aboutId, limit) : [...c.memories.long].sort((a, b) => b.importance * b.strength - a.importance * a.strength).slice(0, limit);
  return mems.map((m) => `- ${formatTime(m.t).replace(/ \d\d:\d\d$/, "")}: ${m.text}`);
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
    `Situation and constraints: ${brief}`,
    `Write 3-6 alternating lines, A first. Then the outcome.`,
  ].join("\n");
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
