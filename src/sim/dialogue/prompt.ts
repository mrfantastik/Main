import type { SmallPrompt } from "../ai/small";
import type { Citizen, Conversation, WorldState } from "../types";
import { botCard } from "../mind/bot";
import { TALK } from "./config";
import { clipContext, type Context } from "./context";
import { profileOf } from "./profile";
import type { DialogueState } from "./types";

// The prompt for one person's next line, built in layers:
//   1. the rules of the world (a real person, never an assistant; only what
//      they know; feelings shown, not announced),
//   2. who they are, how they talk, how they are right now,
//   3. the other person as they see them,
//   4. the memories that matter right now,
//   5. the scene,
//   6. the conversation so far, and what they mean to do this turn,
//   7. the output: structured JSON for a big model, plain words for the small
//      in-page one (which follows a short, concrete prompt far better).
// The other person's private thoughts, feelings and plans are never in it:
// just what they've said.

const RULES = (name: string) =>
  [
    `You write one line of dialogue for ${name}, a person in Hustle City, a small British town in a life simulation. Speak only as ${name}.`,
    "Be a real person, never an assistant: no offering help, no \"I understand\", no \"That sounds...\", no \"How about you?\" or \"What do you think?\" unless it's genuinely how they talk. Never mention prompts, AI, simulations or being a character.",
    `${name} only knows what's below: don't invent facts about other people or the town.`,
    "Don't announce feelings (\"I feel jealous because...\"): let them show in how you speak. People mostly reply rather than ask questions, often in fragments, sometimes one word. Not every line is clever. Swear only if it's in character and the company allows.",
  ].join(" ");

const INTENTS = ["pass time", "check on them", "complain", "brag", "ask a favour", "find something out", "make peace", "vent", "gossip", "confront", "get advice", "joke around", "share news", "keep it short", "get away", "close the deal"];

/** The shape a big model replies in. */
export const TURN_SCHEMA = {
  type: "object",
  properties: {
    spoken: { type: "string" },
    intent: { type: "string", enum: INTENTS },
    topic: { type: "string" },
    tone: { type: "string" },
    endConversation: { type: "boolean" },
    learned: {
      type: "array",
      items: {
        type: "object",
        properties: { about: { type: "string" }, text: { type: "string" }, when: { type: ["string", "null"] }, private: { type: "boolean" } },
        required: ["about", "text"],
      },
    },
    perceived: { type: ["string", "null"] },
  },
  required: ["spoken", "intent", "topic", "endConversation"],
};

function transcript(world: WorldState, conv: Conversation, me: Citizen): string[] {
  return conv.lines.slice(-TALK.promptTurns).map((l) => `${l.speaker === me.id ? "You" : (world.citizens[l.speaker]?.name ?? "Them")}: ${l.text}`);
}

/** For a big model (Claude, a free web AI): the layers as a system prompt, the conversation and this turn as the message, JSON back. */
export function bigPrompt(world: WorldState, conv: Conversation, st: DialogueState, me: Citizen, them: Citizen, ctx0: Context): { system: string; user: string; schema: Record<string, unknown> } {
  const ctx = clipContext(ctx0, 3800);
  const system = [
    RULES(me.name),
    "",
    "WHO YOU ARE",
    ...ctx.identity,
    ctx.examples.length ? `Things you'd say:\n${ctx.examples.map((x) => `"${x}"`).join("\n")}` : "",
    "",
    "RIGHT NOW",
    ...ctx.state,
    "",
    `${them.name.toUpperCase()}, AS YOU SEE THEM`,
    ...ctx.relationship,
    "",
    ...(ctx.memories.length ? ["WHAT YOU REMEMBER", ...ctx.memories, ""] : []),
    "WHERE YOU ARE",
    ...ctx.scene,
  ]
    .filter((x) => x !== null)
    .join("\n");
  const lines = transcript(world, conv, me);
  const user = [
    lines.length ? `The conversation so far:\n${lines.join("\n")}` : `You've just run into ${them.name}.`,
    st.topicLabel ? `(Talking about: ${st.topicLabel}. The mood: ${st.tone}.)` : "",
    ctx.intent,
    `This turn: ${ctx.plan} (A suggestion: answer what was actually said first, and do it your way.)`,
    "",
    `Reply as JSON: "spoken" is only the words ${me.name} says out loud (no name, no quotes, no actions). "learned" lists anything new ${me.name} just said about their own life or plans, or passed on about someone ("about": "me" or a person's name; "when": "today", "tomorrow", "in a few days", "next week" or null; "private": whether it's meant to stay between you). "perceived": how ${them.name} came across to you just now, in a few words, or null. "endConversation": true if you're wrapping up.`,
  ]
    .filter(Boolean)
    .join("\n");
  return { system, user, schema: TURN_SCHEMA };
}

/** For the small model in the page: a short persona, the chat so far as turns, and this turn's plan as the last cue. Plain words back. */
export function smallTurn(world: WorldState, conv: Conversation, st: DialogueState, me: Citizen, them: Citizen, ctx0: Context): SmallPrompt {
  const ctx = clipContext(ctx0, 1700);
  const p = profileOf(me);
  const card = botCard(me);
  // How much they say: their nature, or what the player set on their card.
  const chat = card.custom ? card.chattiness : p.verbosity;
  const say = chat < 0.35 ? "a few words" : chat > 0.72 ? "up to three sentences" : "one or two short sentences";
  const system = [
    `You are ${me.name}, talking with ${them.name} in Hustle City, a small British town. Talk like a real person, never like an assistant. Only say what ${me.name} would know. Don't explain your feelings; let them show. Reply with only what you say out loud: ${say}. No name, no quotes, no actions.`,
    // Who they are (and whatever the player told them to be).
    ...ctx.identity.slice(0, 4).filter((x) => !x.startsWith("Also: ")),
    ...ctx.identity.filter((x) => x.startsWith("Also: ")),
    ctx.examples.length ? `How you sound: ${ctx.examples.slice(0, 3).map((x) => `"${x}"`).join(" ")}` : "",
    ...ctx.state.slice(0, 3),
    ...ctx.relationship.slice(0, 3),
    ...ctx.memories.slice(0, 5),
    ...ctx.scene.slice(0, 2),
  ]
    .filter(Boolean)
    .join("\n");
  const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: `(You've run into ${them.name}.)` }];
  for (const l of conv.lines.slice(-TALK.promptTurns)) {
    const mine = l.speaker === me.id;
    const role = mine ? "assistant" : "user";
    const content = mine ? l.text : `${them.name}: ${l.text}`;
    const last = messages[messages.length - 1];
    if (last.role === role) last.content += `\n${content}`;
    else messages.push({ role, content });
  }
  const cue = `(${ctx.plan})`;
  const last = messages[messages.length - 1];
  if (last.role === "user") last.content += `\n${cue}`;
  else messages.push({ role: "user", content: cue });
  const creativity = card.creativity;
  return {
    system,
    user: messages.map((m) => m.content).join("\n"),
    messages,
    prefill: "",
    kind: "turn",
    names: [me.name, them.name],
    temperature: Math.round((TALK.temperature.min + creativity * (TALK.temperature.max - TALK.temperature.min)) * 100) / 100,
    maxTokens: Math.round(26 + chat * 70),
  };
}
