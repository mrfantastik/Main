import type { Conversation, WorldState } from "../types";

// Turning a model's dialogue into lines the town can show.

/** Model lines to spoken lines: A/B (or their names) to speakers, no "Name:" prefixes, quotes or stage directions. */
export function cleanLines(world: WorldState, conv: Conversation, raw: unknown[]): Conversation["lines"] {
  const a = world.citizens[conv.a];
  const b = world.citizens[conv.b];
  const out: Conversation["lines"] = [];
  for (const item of raw) {
    const l = (item ?? {}) as { speaker?: unknown; text?: unknown };
    const who = String(l.speaker ?? "").trim();
    const speaker = who === "A" || who === a?.name ? conv.a : who === "B" || who === b?.name ? conv.b : null;
    if (!speaker || typeof l.text !== "string") continue;
    let text = l.text
      .replace(/\*[^*]*\*|\([^)]*\)|\[[^\]]*\]/g, " ")
      .replace(new RegExp(`^\\s*(${[a?.name, b?.name, "A", "B"].filter(Boolean).join("|")})\\s*:\\s*`), "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^["“]+|["”]+$/g, "")
      .trim();
    if (!text || /https?:\/\//.test(text)) continue;
    if (text.length > 200) text = `${text.slice(0, 197).replace(/\s+\S*$/, "")}…`;
    out.push({ speaker, text });
  }
  return out;
}
