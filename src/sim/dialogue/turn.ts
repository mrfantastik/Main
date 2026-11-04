import { looksLikeSpeech } from "../ai/small";
import type { Citizen, Conversation, WorldState } from "../types";
import { TALK } from "./config";
import { sentence } from "./grammar";
import { profileOf, talkOf } from "./profile";

// Checking a line a model wrote before anyone says it. It has to be speech
// (not narration, markup or a model talking about itself); it mustn't sound
// like customer service ("I completely understand", "That sounds
// difficult", "Is there anything I can do?") unless that's genuinely this
// person; it mustn't repeat what's just been said or what they said
// lately; it mustn't speak for the other person; and it mustn't come out
// with things they couldn't know (people they've never heard of, sums of
// money that weren't in what they were given). Little crutches ("Honestly,",
// "To be fair,") are trimmed off the front when they aren't this person's
// habit. If the line fails, the caller asks again or falls back.

/** Assistant-speak: rejected unless it's genuinely how this person talks. */
const ASSISTANT = [
  /\bI (completely |totally )?understand\b/i,
  /\bthat (must be|sounds) (so |really |very )?(difficult|hard|frustrating|challenging|tough|stressful)\b/i,
  /\bI hear you\b/i,
  /\bis there anything (else )?I can do\b/i,
  /\bhow (can|may) I help\b/i,
  /\bI'?m (so )?glad to hear (that|it)\b/i,
  /\bwhat are your plans for the future\b/i,
  /\bhave you considered\b/i,
  /\bit'?s (important|okay) to\b/i,
  /\bthank you for sharing\b/i,
  /\bI appreciate you\b/i,
  /\bfeel free to\b/i,
  /\bas an AI\b|\blanguage model\b|\bsimulation\b|\bNPC\b/i,
];

/** Crutches: trimmed off the front unless they're the speaker's own habit. */
const CRUTCH = /^(honestly|to be fair|you know what|well|so|oh|i mean|look),?\s+/i;

export interface Checked {
  ok: boolean;
  text: string;
  why?: string;
}

function norm(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9£ ]+/g, " ").replace(/\s+/g, " ").trim();
}

function similar(a: string, b: string): number {
  const A = new Set(norm(a).split(" ").filter((w) => w.length > 2));
  const B = new Set(norm(b).split(" ").filter((w) => w.length > 2));
  if (!A.size || !B.size) return norm(a) === norm(b) ? 1 : 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

/** Clean a model's line and check it (see above). `context` is everything the speaker was given (for the knowledge check). */
export function checkLine(world: WorldState, conv: Conversation, me: Citizen, them: Citizen, raw: string, context: string): Checked {
  let t = String(raw ?? "")
    .replace(new RegExp(`^\\s*\\**\\s*(${me.name}|You)\\s*\\**\\s*:\\s*`, "i"), "")
    .split(/\n/)[0]
    .replace(/\*[^*]*\*/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/^["“'\s]+|["”'\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const cut = t.search(new RegExp(`\\b(${them.name}|${me.name})\\s*:`, "i"));
  if (cut >= 0) t = t.slice(0, cut).trim();
  if (!t) return { ok: false, text: "", why: "empty" };
  // Too long: back to whole sentences.
  if (t.length > TALK.maxLineChars) {
    const parts = t.match(/[^.!?]+[.!?]+/g) ?? [t];
    let kept = "";
    for (const s of parts) {
      if ((kept + s).length > TALK.maxLineChars) break;
      kept += s;
    }
    t = (kept || t.slice(0, TALK.maxLineChars)).trim();
  }
  const p = profileOf(me);
  const fillers = p.fillers.map((f) => f.toLowerCase());
  const m = t.match(CRUTCH);
  if (m && !fillers.includes(m[1].toLowerCase()) && t.length > m[0].length + 3) t = t.slice(m[0].length);
  t = sentence(t);
  if (!looksLikeSpeech(t)) return { ok: false, text: t, why: "not speech" };
  for (const re of ASSISTANT) {
    if (!re.test(t)) continue;
    // A very gentle, warm person can say "that must be hard" once in a while; nobody says "as an AI".
    const gentle = p.empathy > 0.78 && p.warmth > 0.7 && !/AI|model|simulation|NPC/.test(t);
    const used = talkOf(me).recent.phrases.includes(`assist:${re.source.slice(0, 20)}`);
    if (!gentle || used) return { ok: false, text: t, why: "assistant-speak" };
    talkOf(me).recent.phrases.push(`assist:${re.source.slice(0, 20)}`);
  }
  // Not what's just been said, nor what they keep saying.
  for (const l of conv.lines.slice(-12)) if (similar(l.text, t) > 0.85 && t.split(" ").length > 3) return { ok: false, text: t, why: "repeats a line" };
  // Knowledge: names they couldn't know, sums of money that came from nowhere.
  for (const id of world.citizenOrder) {
    const o = world.citizens[id];
    if (o.id === me.id || o.id === them.id || !new RegExp(`\\b${o.name}\\b`).test(t)) continue;
    const knowsThem = (me.relationships[id]?.familiarity ?? 0) > 0 || (me.talk?.facts ?? []).some((f) => f.about === id) || context.includes(o.name) || me.family.includes(id);
    if (!knowsThem) return { ok: false, text: t, why: `mentions ${o.name}, who they don't know` };
  }
  for (const mm of t.matchAll(/£\s?([\d,]+)/g)) {
    const v = Number(mm[1].replace(/,/g, ""));
    if (v <= 20) continue;
    const nums = [...context.matchAll(/£\s?([\d,]+(?:\.\d+)?)/g)].map((x) => Number(x[1].replace(/,/g, "")));
    if (!nums.some((n) => Math.abs(n - v) <= Math.max(5, n * 0.3))) return { ok: false, text: t, why: `made up £${v}` };
  }
  return { ok: true, text: t };
}

/** Did it end the conversation? (A goodbye, said or implied.) */
export const GOODBYE = /\b(bye|see you|see ya|catch you|take care|got to go|gotta go|better go|better get (going|back|on)|must dash|i'm off|off now|ta-ra|cheerio|good ?night|laters|night\.)\b/i;

/** Does it ask something? */
export function asksSomething(t: string): boolean {
  return /\?\s*["”']?\s*$/.test(t) || /\?\s+\S/.test(t) && !/^(really|seriously|right|eh|yeah)\?/i.test(t.trim());
}
