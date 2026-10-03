// The town's brain: a small open-source model running in the page. Its
// prompts, how its replies are read, and how the director uses it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, newWorld } from "../src/sim";
import { AIDirector } from "../src/sim/ai/director";
import type { LLMClient, LLMRequest } from "../src/sim/ai/llm";
import { looksLikeSpeech, readChoice, readLines, readThought, smallChoicePrompt, smallConversationPrompt, smallThoughtPrompt, withNames } from "../src/sim/ai/small";
import type { Conversation, WorldState } from "../src/sim/types";

test("reading a small model's dialogue: only the two of them, until it wanders off", () => {
  const text = "Mike: Well, look who it is!\nSarah: Don't start.\n**Mike**: \"What? I'm being nice.\"\nSarah: Don't start.\nSarah: Fine. Pint?\nNarrator: They went to the bar.\nMike: never shown";
  assert.deepEqual(readLines(text, ["Mike", "Sarah"]), [
    { speaker: "Mike", text: "Well, look who it is!" },
    { speaker: "Sarah", text: "Don't start." },
    { speaker: "Mike", text: "What? I'm being nice." },
    { speaker: "Sarah", text: "Fine. Pint?" },
  ]);
  assert.deepEqual(readLines("Mike: Hi.\nSarah: <|im_start|>assistant", ["Mike", "Sarah"]), [{ speaker: "Mike", text: "Hi." }], "stops at markup");
  assert.deepEqual(readLines("Mike: Hi there.\nSarah: ~~~ ### 123 !!!", ["Mike", "Sarah"]), [{ speaker: "Mike", text: "Hi there." }], "stops at noise");
  assert.equal(looksLikeSpeech("As an AI language model, I can't."), false);
});

test("reading a thought and a choice", () => {
  assert.equal(readThought('"Rent\'s due Friday. I\'m £12 short. Maybe Sarah will help." Then more.', "Mike"), "Rent's due Friday. I'm £12 short.");
  assert.equal(readThought("Mike thinks: if the café works out, I'm made", "Mike"), "if the café works out, I'm made.");
  assert.equal(readThought("<|im_end|>", "Mike"), "");
  assert.deepEqual(readChoice("2. Because I can't stand working for someone else.", ["stay", "start_cafe", "save"]), { choice: "start_cafe", thought: "Because I can't stand working for someone else." });
  assert.equal(readChoice("I'd go for the third, obviously", ["a", "b", "c"]), null);
  assert.equal(readChoice("7. Nope", ["a", "b"]), null);
});

function chat(w: WorldState, i: number, j: number): Conversation {
  const [a, b] = [w.citizens[w.citizenOrder[i]], w.citizens[w.citizenOrder[j]]];
  return { id: 99, a: a.id, b: b.id, topic: "chat", buildingId: a.insideId, startedT: w.time, lines: [], revealed: 0, nextRevealT: w.time, status: "talking", agenda: {}, terms: {}, outcome: null, summary: "", source: "template", endT: 0, fallback: { lines: [{ speaker: a.id, text: "Alright?" }, { speaker: b.id, text: "Not bad. You?" }], outcome: {} } };
}

test("small prompts: who, where, how they speak, what's on their minds, what happens, and a draft to improve", () => {
  const w = newWorld(90);
  advance(w, 600);
  const conv = chat(w, 0, 1);
  const [a, b] = [w.citizens[conv.a], w.citizens[conv.b]];
  const p = smallConversationPrompt(w, conv, "A casual chat. Beats, in order (keep to them, in your own words): A greets B. B tells A about the fire at the café.");
  assert.equal(p.kind, "lines");
  assert.equal(p.prefill, `${a.name}:`, "the reply is started for it, in the right format");
  assert.deepEqual(p.names, [a.name, b.name]);
  assert.match(p.user, new RegExp(`- ${a.name} greets ${b.name}\\.`));
  assert.match(p.user, new RegExp(`${b.name}: Not bad\\. You\\?`), "the draft is there to improve on");
  assert.ok(!/\bA greets\b/.test(p.user), "no A/B placeholders left");
  assert.ok(p.user.length < 1600, `short enough for a small model (${p.user.length} chars)`);
  assert.equal(withNames("A and B argue; B wins.", a, b), `${a.name} and ${b.name} argue; ${b.name} wins.`);
  const t = smallThoughtPrompt(w, a);
  assert.equal(t.kind, "thought");
  assert.match(t.user, new RegExp(`What is ${a.name} thinking right now\\?$`));
  const c = smallChoicePrompt(w, a, [
    { id: "x", label: "Open a café" },
    { id: "y", label: "Keep the day job" },
  ]);
  assert.match(c.user, /1\. Open a café\n2\. Keep the day job/);
  assert.deepEqual(c.options, ["x", "y"]);
});

/** A stand-in for the in-page brain: answers by the kind of small prompt it's given. */
function fakeBrain(seen: LLMRequest[], opts: { ready?: () => boolean; slow?: () => boolean } = {}): LLMClient {
  return {
    model: "brain",
    free: true,
    small: true,
    label: "Town brain",
    ready: opts.ready ?? (() => true),
    slow: opts.slow,
    async complete(req) {
      seen.push(req);
      const p = req.small!;
      const json =
        p.kind === "lines"
          ? { lines: readLines(`${p.prefill} Fancy seeing you here!\n${p.names![1]}: I live round the corner, you know.\n${p.names![0]}: Course you do.`, p.names!) }
          : p.kind === "thought"
            ? { thought: readThought("Today feels like a lucky day, for once.", "") }
            : readChoice("1. Feels right.", p.options!);
      return { json, inputTokens: 0, outputTokens: 0, model: "brain" };
    },
  };
}

async function run(w: WorldState, d: AIDirector, minutes: number): Promise<void> {
  for (let i = 0; i < minutes / 5; i++) {
    advance(w, 5);
    await new Promise((r) => setImmediate(r));
    d.pump(w);
  }
}

test("with the brain awake, people think and talk through it; asleep, nothing is asked of it", async () => {
  const seen: LLMRequest[] = [];
  let awake = false;
  const d = new AIDirector(fakeBrain(seen, { ready: () => awake }), { total: () => 0, add: () => {} }, { maxConcurrent: 1, minIntervalMs: 0, timeoutMs: 5000 });
  d.attach();
  const w = newWorld(91);
  w.ai.mode = "llm";
  w.ai.maxCallsPerDay = 5000;
  advance(w, 9 * 60);
  await run(w, d, 120);
  assert.equal(seen.length, 0, "asleep: no calls");
  awake = true;
  const me = w.citizens[w.citizenOrder[3]];
  d.focus = me.id;
  const seenConvs = new Map<number, Conversation>();
  for (let i = 0; i < 24; i++) {
    await run(w, d, 30);
    for (const c of w.conversationLog) seenConvs.set(c.id, c);
  }
  assert.ok(seen.every((r) => r.small), "every request carries a short prompt");
  assert.ok(seen.some((r) => r.small!.kind === "thought" && r.small!.user.includes(me.name)), "the person in focus gets thoughts");
  assert.ok(w.ai.log.some((l) => l.kind === "thought" && l.status === "ok" && l.citizenId === me.id), "and they're used");
  const voiced = [...seenConvs.values()].filter((c) => c.source === "llm");
  assert.ok(voiced.length >= 3, `only ${voiced.length} conversations voiced`);
  for (const c of voiced) assert.equal(c.lines[1].text, "I live round the corner, you know.");
  assert.ok(!w.ai.log.some((l) => l.kind === "reflection"), "lessons aren't reworded by a small model");
  assert.match(d.invent(w) ?? "", /bigger AI/);
});

test("a slow brain (no graphics card) only voices the conversations you're watching", async () => {
  const seen: LLMRequest[] = [];
  const d = new AIDirector(fakeBrain(seen, { slow: () => true }), { total: () => 0, add: () => {} }, { maxConcurrent: 1, minIntervalMs: 0, timeoutMs: 5000 });
  d.attach();
  const w = newWorld(92);
  w.ai.mode = "llm";
  w.ai.maxCallsPerDay = 5000;
  advance(w, 9 * 60);
  d.focus = w.citizenOrder[0];
  await run(w, d, 6 * 60);
  const convPrompts = seen.filter((r) => r.small!.kind === "lines");
  const focusName = w.citizens[d.focus].name;
  assert.ok(convPrompts.every((r) => r.small!.names!.includes(focusName)), "only chats with the person in focus");
});
