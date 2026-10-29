import type { Citizen, Conversation, Memory, WorldState } from "../types";
import { relView } from "./bonds";
import { profileOf } from "./profile";
import { rngFor } from "./topics";
import { rand } from "../rng";
import type { Directive } from "./plan";
import type { DialogueState, Move } from "./types";
import { pickFor } from "./voice";

// Rows have a shape: an accusation, a defence (in the other's own style: they
// smooth it over, deflect with sarcasm, flatly deny it, or come straight back
// at you), then it escalates with old history dragged up, and ends either
// with an apology (accepted or not) or with someone walking off. Who backs
// down depends on who they are and how they feel about each other.

/** The worst thing `me` remembers about `them` (for dragging it up), other than `except`. */
function grievance(me: Citizen, them: Citizen, except: string): Memory | null {
  return [...me.memories.long, ...me.memories.short].filter((m) => m.people.includes(them.id) && m.valence < -0.3 && m.kind !== "conversation" && !/^Talked with/.test(m.text) && !m.text.includes(except.slice(0, 12))).sort((a, b) => a.valence * b.importance - b.valence * a.importance)[0] ?? null;
}

/** "Ben wouldn't lend me money" -> "you wouldn't lend me money" (said to Ben). */
function atThem(text: string, name: string): string {
  return text
    .replace(new RegExp(`^${name}'s\\b`), "your")
    .replace(new RegExp(`^${name} (\\w+)`), (_, v: string) => `you ${v === "is" ? "are" : v === "was" ? "were" : v === "has" ? "have" : v}`)
    .replace(new RegExp(`\\b${name}\\b`, "g"), "you")
    .replace(/\.$/, "");
}

/** The next move in a row, from `me`'s side. Null: it's over. */
export function argueDirective(world: WorldState, conv: Conversation, st: DialogueState, me: Citizen, them: Citizen): Directive | null {
  const i = st.turns.length;
  const r = rngFor(world, conv, me.id, `row${i}`);
  const rel = relView(world, me, them);
  const p = profileOf(me);
  const last = st.turns[i - 1] ?? null;
  const base = { reply: last, askBack: null, bye: false, rel, topic: null, length: "short" as const };
  // They've said their last word: one back (or none), and it's over.
  if (last?.bye) return st.turns.some((t) => t.speaker === me.id && t.bye) || (st.turns.filter((t) => t.speaker === me.id).length >= 2 && rand(r) < 0.4) ? null : { ...base, move: "byeback", intent: "confront", bye: true, hint: st.turns.some((t) => t.move === "concede") ? `${them.name} has had the last word. Leave it there.` : `${them.name} is walking off. Get the last word in, or let them go.` };
  const reason = String(conv.terms.reason ?? conv.agenda.reason ?? "You know what you did.");
  if (i === 0) return { ...base, move: "raise", intent: "confront", hint: `Have it out with ${them.name}: "${reason}" Say it your way.` };
  const conceded = st.turns.some((t) => t.move === "concede");
  if (conceded) {
    if (last?.move === "concede") return { ...base, move: "close", intent: "make peace", bye: true, hint: `${them.name} has apologised. Accept it, grudgingly or not, and leave it there.` };
    return null;
  }
  // Someone backs down: the more agreeable, the less angry, the more they care.
  const anger = me.emotions.anger / 100;
  const backDown = (me.personality.big5.agreeableness * 0.6 + Math.max(0, rel.affinity) / 150 - anger * 0.5 - (p.confrontation === "escalates" ? 0.3 : 0)) * (i >= 3 ? 1 : 0.3);
  if (i >= 2 && rand(r) < backDown) return { ...base, move: "concede", intent: "make peace", hint: `Back down: say sorry, your way (it doesn't have to be gracious).` };
  if (i >= st.maxTurns - 1 || st.tension > 0.9 && i >= 3) return { ...base, move: "close", intent: "get away", bye: true, hint: "You've had enough. Walk off: no goodbye." };
  const mine = st.turns.filter((t) => t.speaker === me.id).length;
  const initiator = conv.a === me.id;
  const move: Move = initiator ? "disagree" : mine === 0 ? "defend" : "disagree";
  const old = grievance(me, them, reason);
  const hint = !initiator && mine === 0
    ? `${them.name} is having a go at you. Respond the way you do in a row: ${p.confrontation === "avoids" ? "try to smooth it over" : p.confrontation === "deflects" ? "deflect it with sarcasm" : p.confrontation === "escalates" ? "come straight back at them, harder" : "deny it flatly"}.`
    : old
      ? `It's getting worse. Bring up something else they did: "${old.text}"`
      : `Keep going: you're not backing down.`;
  return { ...base, move, intent: "confront", hint };
}

/** A line of a row, in the speaker's voice. */
export function argueLine(world: WorldState, conv: Conversation, st: DialogueState, me: Citizen, them: Citizen, d: Directive): string {
  const r = rngFor(world, conv, me.id, `rowsay${st.turns.length}`);
  const p = profileOf(me);
  const reason = String(conv.terms.reason ?? conv.agenda.reason ?? "You know what you did.");
  switch (d.move) {
    case "raise": {
      const pre = pickFor(world, me, r, "row:open", ["", "Oi.", `${them.name}. A word.`, "Right, you."]);
      return `${pre} ${reason}`.trim();
    }
    case "defend": {
      const pools: Record<string, string[]> = {
        avoids: ["I didn't mean anything by it.", "Can we not do this here?", "I don't want a row about it.", "Look, I'm sorry if it came across like that."],
        deflects: ["Oh, here we go.", "Wow. Good morning to you too.", "Someone's in a mood.", "Is this what you've been stewing on?"],
        direct: ["That's not true and you know it.", "That's rubbish.", "You've got it all wrong.", "I've done nothing wrong."],
        escalates: ["Don't you dare.", "You've got some nerve.", "Say that again.", "Who do you think you are?"],
      };
      return pickFor(world, me, r, `row:def:${p.confrontation}`, pools[p.confrontation]);
    }
    case "disagree": {
      const old = grievance(me, them, reason);
      if (old && rand(r) < 0.6) return `${pickFor(world, me, r, "row:old", ["And what about when", "Don't forget", "Like when", "Same as when"])} ${atThem(old.text, them.name)}.`;
      return pickFor(world, me, r, "row:more", ["Don't give me that.", "You know exactly what I mean.", "Every time. Every single time.", "You always do this.", "Says you!", "Like you're perfect."]);
    }
    case "concede":
      return pickFor(world, me, r, "row:sorry", ["Fine. I'm sorry, alright?", "Maybe I went too far.", "Alright. That's fair. Sorry.", "Look. I'm sorry. Can we drop it?"]);
    case "close":
      if (st.turns.some((t) => t.move === "concede")) return pickFor(world, me, r, "row:accept", ["Yeah. Well.", "Fine.", "Bit late for that.", "Just don't do it again."]);
      return pickFor(world, me, r, "row:off", ["Whatever.", "I'm done with this.", "Forget it.", "Unbelievable."]);
    case "byeback":
      if (st.turns.some((t) => t.move === "concede")) return pickFor(world, me, r, "row:after", ["Right.", "Okay. See you.", "Yeah.", "Fair enough."]);
      return pickFor(world, me, r, "row:last", ["Fine. Go.", "Yeah, walk away.", "Good riddance."]);
    default:
      return "Whatever.";
  }
}
