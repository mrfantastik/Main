import { formatTime } from "../time";
import { canHappen, createHappening, HAPPENING_KINDS, HAPPENING_LABEL } from "../town/happenings";
import type { Happening, HappeningKind, WorldState } from "../types";
import { personalitySummary } from "../mind/personality";

// Unscripted, on request: "Invent an event". The AI makes up something that
// happens in town, about real residents and businesses. The engine then
// plays it out (a fire really shuts the shop) and the news spreads like any
// other. The prompt and checks live here; the call itself goes through the
// AI director, to the free AI or (with an API key) Claude.

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
