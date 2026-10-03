import { placeName } from "../places";
import { formatTime } from "../time";
import { activeHappenings, canHappen, createHappening, HAPPENING_KINDS, HAPPENING_LABEL, happeningById } from "../town/happenings";
import type { Citizen, Conversation, Happening, HappeningKind, WorldState } from "../types";
import { personalitySummary } from "../mind/personality";
import { cleanLines } from "./lines";
import { profile } from "./llm";

// Unscripted, on request. Two things a person can ask for:
//  - "Hear it unscripted": the AI writes a conversation between two citizens
//    from scratch, from who they are, how they feel, what they've heard and
//    what they remember about each other. No beats, no templates.
//  - "Invent an event": the AI makes up something that happens in town,
//    about real residents and businesses. The engine then plays it out
//    (a fire really shuts the shop) and the news spreads like any other.
// The prompts and checks live here; the call itself goes through the AI
// director, to the free AI or (with an API key) Claude.

export const UNSCRIPTED_SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: { type: "object", properties: { speaker: { type: "string", enum: ["A", "B"] }, text: { type: "string" } }, required: ["speaker", "text"] },
    },
  },
  required: ["lines"],
};

export const UNSCRIPTED_SYSTEM =
  "You write spontaneous, natural conversations between residents of Hustle City, a small British town in a life simulation. " +
  "There is no script: they talk about whatever is really on their minds, in their own voices. Spoken words only. Reply only with JSON.";

function newsLines(world: WorldState, c: Citizen): string[] {
  return c.news
    .slice(-6)
    .map((k) => {
      const h = happeningById(world, k.id);
      if (!h) return "";
      const take = k.stance <= -0.5 ? "upset about it" : k.stance < -0.1 ? "sorry about it" : k.stance >= 0.5 ? "pleased" : k.stance > 0.1 ? "quietly glad" : "not bothered";
      const via = world.citizens[k.via]?.name;
      return `- ${h.title} (${formatTime(h.t)}): ${h.text} [${take}${via ? `; heard it from ${via}` : ""}]`;
    })
    .filter(Boolean);
}

function memoriesOf(c: Citizen, other: Citizen): string[] {
  return [...c.memories.long, ...c.memories.short]
    .filter((m) => m.people.includes(other.id))
    .sort((x, y) => y.importance * y.strength - x.importance * x.strength)
    .slice(0, 3)
    .map((m) => `- ${formatTime(m.t).replace(/ \d\d:\d\d$/, "")}: ${m.text}`);
}

function relation(c: Citizen, other: Citizen): string {
  const r = c.relationships[other.id];
  if (c.family.includes(other.id)) return "family";
  if (!r || r.familiarity < 5) return "strangers";
  const feel = r.affinity > 50 ? "close friends" : r.affinity > 20 ? "friendly" : r.affinity < -40 ? "can't stand each other" : r.affinity < -10 ? "wary" : "acquaintances";
  return `${feel} (affinity ${Math.round(r.affinity)}, trust ${Math.round(r.trust)})`;
}

/** The prompt for a from-scratch conversation, or why it can't be done. */
export function unscriptedPrompt(world: WorldState, convId: number): { prompt: string; conv: Conversation } | string {
  const conv = world.conversations.find((c) => c.id === convId) ?? world.conversationLog.find((c) => c.id === convId);
  if (!conv) return "That conversation has gone from memory.";
  const a = world.citizens[conv.a];
  const b = world.citizens[conv.b];
  if (!a || !b) return "One of them has left town.";
  const town = activeHappenings(world).map((h) => `${h.title}.`);
  const block = (x: Citizen, y: Citizen, tag: string) => {
    const news = newsLines(world, x);
    const mem = memoriesOf(x, y);
    return [
      `${tag}: ${profile(world, x)}`,
      `${tag}'s dream: ${x.personality.dream}. Fear: ${x.personality.fear}. Backstory: ${x.personality.backstory}`,
      news.length ? `What ${tag} has heard lately:\n${news.join("\n")}` : `${tag} hasn't heard any news lately.`,
      `${tag} and the other: ${relation(x, y)}.${mem.length ? ` ${tag} remembers:\n${mem.join("\n")}` : ""}`,
    ].join("\n");
  };
  const prompt = [
    `Where: ${placeName(world, conv.buildingId)}, ${formatTime(conv.startedT)}.${town.length ? ` Going on in town right now: ${town.join(" ")}` : ""}`,
    block(a, b, "A"),
    block(b, a, "B"),
    conv.summary ? `(For reference only, the simulation's own summary of this chat: "${conv.summary}". You don't have to follow it.)` : "",
    `Write the conversation A starts with B: what these two would really say to each other right now. It can wander: news, gossip, worries, jokes, plans, an argument, a confession. Let their personalities, speaking styles (A ${a.personality.style}, B ${b.personality.style}), feelings and history show. Don't invent new money amounts or events that contradict the facts above.`,
    `Reply with only JSON: {"lines": [{"speaker": "A" or "B", "text": "..."}]} with 6 to 12 lines, A first, mostly alternating, each line under 30 words.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { prompt, conv };
}

/** Put the AI's version in place. Returns a message for the player. */
export function applyUnscripted(world: WorldState, convId: number, reply: unknown): string {
  const conv = world.conversations.find((c) => c.id === convId) ?? world.conversationLog.find((c) => c.id === convId);
  if (!conv) return "That conversation has gone from memory.";
  const raw = (reply as { lines?: unknown } | null)?.lines;
  if (!Array.isArray(raw)) throw new Error("the reply wasn't a conversation.");
  const lines = cleanLines(world, conv, raw).slice(0, 14);
  if (lines.length < 2) throw new Error("the reply was too short to use.");
  conv.lines = lines;
  conv.source = "llm";
  if (conv.status !== "done") conv.revealed = Math.min(conv.revealed, lines.length);
  const a = world.citizens[conv.a]?.name ?? "A";
  const b = world.citizens[conv.b]?.name ?? "B";
  return `✨ ${a} and ${b}'s conversation, rewritten from scratch (${lines.length} lines).`;
}

export const INVENT_SYSTEM =
  "You invent believable, specific small-town happenings for Hustle City, a British life simulation, using its real residents and businesses. Reply only with JSON.";

/** Kinds that could happen right now (time of day, something to happen to). */
export function inventableKinds(world: WorldState): HappeningKind[] {
  return HAPPENING_KINDS.filter((k) => canHappen(world, k, true));
}

export function inventPrompt(world: WorldState, idea = ""): string {
  const kinds = inventableKinds(world);
  const people = world.citizenOrder
    .map((id) => world.citizens[id])
    .map((c) => {
      const owns = c.businessIds.map((id) => world.businesses[id]).filter((b) => b && b.open).map((b) => b.name);
      const mood = Object.entries(c.emotions).sort((x, y) => y[1] - x[1])[0][0];
      return `- ${c.name}: ${c.occupation}${owns.length ? `, owns ${owns.join(", ")}` : ""}; mostly feeling ${mood}; ${personalitySummary(c.personality)}`;
    });
  const businesses = world.businessOrder.map((id) => world.businesses[id]).filter((b) => b && b.open).map((b) => `- ${b.name} (${b.kind}, owner ${world.citizens[b.ownerId]?.name ?? "?"})`);
  const recent = world.happenings.slice(-5).map((h) => `- ${h.title}`);
  return [
    `It's ${formatTime(world.time)} in Hustle City.`,
    `Residents:\n${people.join("\n")}`,
    `Open businesses:\n${businesses.join("\n") || "- none"}`,
    recent.length ? `Recent happenings (don't repeat these):\n${recent.join("\n")}` : "",
    idea ? `The player's idea: "${idea.slice(0, 200)}". Follow it if it fits one of the kinds below.` : "",
    `Invent ONE thing that happens right now that the residents will gossip about. It must be one of these kinds: ${kinds.map((k) => `${k} (${HAPPENING_LABEL[k]})`).join(", ")}. Make it specific and a little surprising, but believable. Don't state money amounts: the town works those out.`,
    `Reply with only JSON: {"kind": one of [${kinds.map((k) => `"${k}"`).join(", ")}], "who": a resident's first name or null, "business": a business name or null, "title": "headline under 60 characters", "about": "how people mention it mid-sentence, e.g. 'the fire at Mike's Café'", "text": "one or two sentences under 220 characters"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const INVENT_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: HAPPENING_KINDS },
    who: { type: ["string", "null"] },
    business: { type: ["string", "null"] },
    title: { type: "string" },
    about: { type: "string" },
    text: { type: "string" },
  },
  required: ["kind", "title", "about", "text"],
};

/** Make the AI's idea happen. Returns the happening, or why it couldn't be. */
export function applyInvented(world: WorldState, reply: unknown): Happening | string {
  const r = (reply ?? {}) as { kind?: unknown; who?: unknown; business?: unknown; title?: unknown; about?: unknown; text?: unknown };
  const kind = String(r.kind ?? "") as HappeningKind;
  if (!HAPPENING_KINDS.includes(kind)) return "the AI suggested something the town can't do yet.";
  const who = typeof r.who === "string" ? world.citizenOrder.map((id) => world.citizens[id]).find((c) => c.name.toLowerCase() === String(r.who).trim().toLowerCase()) : undefined;
  const biz = typeof r.business === "string" ? world.businessOrder.map((id) => world.businesses[id]).find((b) => b && b.open && b.name.toLowerCase() === String(r.business).trim().toLowerCase()) : undefined;
  const clean = (v: unknown, max: number) => (typeof v === "string" && v.trim().length > 3 && v.trim().length <= max ? v.trim() : undefined);
  return createHappening(world, kind, {
    source: "llm",
    subject: who?.id ?? null,
    businessId: biz?.id ?? null,
    title: clean(r.title, 80),
    about: clean(r.about, 80),
    text: clean(r.text, 300),
  });
}
