// Only the AI speaks: every line of every conversation is the AI's, a line it
// gets wrong is asked for again (never filled in), and when it stops
// answering, conversations end where they are with nobody left standing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, newWorld } from "../src/sim";
import { AIDirector } from "../src/sim/ai/director";
import type { LLMClient } from "../src/sim/ai/llm";
import { DEALS } from "../src/sim/dialogue/deal";
import { prepareLoadedWorld } from "../src/sim/migrate";
import type { Conversation, WorldState } from "../src/sim/types";

const WORDS = "kettle bus rain market rent pigeon football cousin bakery parking telly garden invoice pub boss holiday phone biscuits traffic weekend sandwich bike laundry neighbour dentist umbrella sofa coffee lottery festival storm shoes curry cinema allotment bins postman radio nephew wedding scooter bread hedge porch window ticket ferry seaside stall wages plumber".split(" ");

/** A stand-in model: a fresh line each time (or a bad one, every `bad`th reply; every one if `dead`). */
function fakeModel(opts: { bad?: number; dead?: () => boolean } = {}): LLMClient & { calls: number } {
  let x = 7;
  const word = () => {
    x = (x * 1103515245 + 12345) >>> 0;
    return WORDS[x % WORDS.length];
  };
  const client = {
    model: "fake",
    free: true as const,
    label: "Fake",
    calls: 0,
    async complete(req: { system: string; user: string; schema?: Record<string, unknown> }) {
      client.calls++;
      const props = (req.schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
      if (props.action && props.intention) return { json: { action: "carry_on", reason: "Nothing doing.", intention: "Get on with my day." }, inputTokens: 1, outputTokens: 1, model: "fake" };
      if (opts.dead?.() || (opts.bad && client.calls % opts.bad === 0)) return { json: { spoken: "As an AI language model, I can't help with that." }, inputTokens: 1, outputTokens: 1, model: "fake" };
      if (props.spoken) {
        const deal = /THE DEAL/.test(req.user) && /Decide your move/.test(req.user);
        return {
          json: { spoken: `The ${word()} and the ${word()}, by the ${word()} near the ${word()}.`, intent: "pass time", topic: "x", endConversation: client.calls % 11 === 0, ...(deal ? { deal: { action: client.calls % 4 ? "decline" : "accept" } } : {}) },
          inputTokens: 1,
          outputTokens: 1,
          model: "fake",
        };
      }
      return { json: null, inputTokens: 0, outputTokens: 0, model: "fake" };
    },
  };
  return client;
}

function aiOnlyTown(seed: number, client: LLMClient | null): { w: WorldState; d: AIDirector } {
  const d = new AIDirector(client, { total: () => 0, add: () => {} }, { maxConcurrent: 4, minIntervalMs: 0, timeoutMs: 5000, liveChats: 20 });
  d.attach();
  const w = newWorld(seed);
  w.ai.mode = client ? "llm" : "off";
  w.ai.maxCallsPerDay = 100000;
  w.ai.aiOnly = true;
  return { w, d };
}

async function run(w: WorldState, d: AIDirector, minutes: number, seen?: Map<number, Conversation>): Promise<void> {
  for (let i = 0; i < minutes; i++) {
    advance(w, 1);
    await new Promise((r) => setImmediate(r));
    d.pump(w);
    if (seen) for (const c of w.conversationLog) seen.set(c.id, c);
  }
}

/** Who wrote each line: the AI, or the built-in voice. */
function writers(c: Conversation): string[] {
  if (c.group) return c.group.turns.map((t) => t.by);
  if (c.dlg && c.dlg.turns.length === c.lines.length) return c.dlg.turns.map((t) => t.by);
  return c.lines.map(() => (c.source === "llm" ? "llm" : "built-in"));
}

const stuck = (w: WorldState) => w.citizenOrder.filter((id) => w.citizens[id].activity.kind === "talk" && !w.conversations.some((c) => c.a === id || c.b === id || c.group?.present.includes(id)));

test("only the AI speaks: every line of every conversation is the AI's", async () => {
  const { w, d } = aiOnlyTown(42, fakeModel());
  advance(w, 7 * 60);
  const seen = new Map<number, Conversation>();
  await run(w, d, 24 * 60, seen);
  const all = [...seen.values()];
  assert.ok(all.length >= 15, `only ${all.length} conversations`);
  const lines = all.flatMap(writers);
  assert.ok(lines.length >= 100, `only ${lines.length} lines`);
  assert.ok(lines.every((b) => b === "llm"), `${lines.filter((b) => b !== "llm").length} built-in lines`);
  assert.ok(all.every((c) => c.source === "llm"));
  assert.deepEqual(stuck(w), []);
});

test("a line the AI gets wrong is asked for again, never filled in", async () => {
  const { w, d } = aiOnlyTown(43, fakeModel({ bad: 3 }));
  advance(w, 7 * 60);
  const seen = new Map<number, Conversation>();
  await run(w, d, 18 * 60, seen);
  const all = [...seen.values()];
  assert.ok(all.length >= 8, `only ${all.length} conversations`);
  assert.ok(all.flatMap(writers).every((b) => b === "llm"), "nothing filled in by the built-in voice");
  assert.ok(w.ai.log.some((l) => /asking for \w+'s line again/.test(l.note)), "the AI was asked again");
  assert.ok(!w.ai.log.some((l) => /built-in line instead/.test(l.note)));
  assert.deepEqual(stuck(w), []);
});

test("when the AI stops answering, conversations end where they are, and nobody's left standing there", async () => {
  let dead = false;
  const { w, d } = aiOnlyTown(44, fakeModel({ dead: () => dead }));
  advance(w, 9 * 60);
  const seen = new Map<number, Conversation>();
  await run(w, d, 3 * 60, seen);
  dead = true;
  await run(w, d, 6 * 60, seen);
  const after = [...seen.values()].filter((c) => c.endT > w.time - 5 * 60);
  assert.ok([...seen.values()].flatMap(writers).every((b) => b === "llm"));
  // Whatever started while it was dead never got a word out, and isn't kept.
  assert.ok(after.every((c) => c.lines.length > 0));
  assert.deepEqual(stuck(w), []);
  // Switched off altogether: anything still going ends, with nothing filled in.
  dead = false;
  await run(w, d, 60);
  w.ai.mode = "off";
  await run(w, d, 3 * 60, seen);
  assert.equal(w.conversations.filter((c) => c.status === "live" && !c.live?.done).length, 0, "everyone's stopped talking");
  assert.ok([...seen.values()].flatMap(writers).every((b) => b === "llm"));
  assert.deepEqual(stuck(w), []);
});

test("with no AI at all, an AI-only town is quiet but carries on", () => {
  const w = newWorld(45);
  w.ai.aiOnly = true;
  advance(w, 2 * 1440);
  assert.equal(w.conversationLog.length + w.conversations.length, 0, "nobody says a word");
  for (const id of w.citizenOrder) {
    const c = w.citizens[id];
    assert.ok(Number.isFinite(c.money) && c.money >= -0.001);
    assert.notEqual(c.activity.kind, "talk");
  }
});

test("every kind of conversation in town can be spoken by the AI", () => {
  const { w, d } = aiOnlyTown(46, fakeModel());
  const [a, b] = w.citizenOrder;
  const hook = (d as unknown as { conversationHook: (world: WorldState, conv: Partial<Conversation>, brief: string, schema: object, stakes: number) => boolean | "live" }).conversationHook.bind(d);
  for (const topic of ["chat", "argue", ...Object.keys(DEALS)]) {
    const conv = { id: 9000 + topic.length, a, b, topic, terms: {}, agenda: {} } as unknown as Conversation;
    assert.equal(hook(w, conv, "", {}, 0), "live", `the AI won't speak "${topic}"`);
    (d as unknown as { live: Map<number, unknown> }).live.delete(conv.id);
  }
});

test("saved mid-conversation, an AI-only town picks it up again with the AI", async () => {
  const one = aiOnlyTown(47, fakeModel());
  advance(one.w, 8 * 60);
  let conv: Conversation | undefined;
  for (let i = 0; i < 6 * 60 && !conv; i++) {
    await run(one.w, one.d, 1);
    conv = one.w.conversations.find((c) => c.status === "live" && !c.live?.done && c.lines.length >= 2 && !c.group);
  }
  assert.ok(conv, "a conversation in progress");
  const said = conv!.lines.length;
  const loaded = prepareLoadedWorld(JSON.parse(JSON.stringify(one.w)))!;
  assert.ok(loaded.conversations.some((c) => c.id === conv!.id && c.status === "live"), "still going after loading");
  const two = new AIDirector(fakeModel(), { total: () => 0, add: () => {} }, { maxConcurrent: 4, minIntervalMs: 0, timeoutMs: 5000, liveChats: 20 });
  two.attach();
  loaded.ai.mode = "llm";
  const seen = new Map<number, Conversation>();
  await run(loaded, two, 4 * 60, seen);
  const done = seen.get(conv!.id) ?? loaded.conversations.find((c) => c.id === conv!.id)!;
  assert.ok(done.lines.length > said, "it carried on");
  assert.ok(writers(done).every((b) => b === "llm"), "with the AI");
});
