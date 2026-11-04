// A model of your own (Ollama on this computer): the town never stands still
// for minutes because one answer failed or was slow; replies are held to the
// shape the town needs and read generously; and when something does go wrong
// the player is told what, and what to do about it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, newWorld } from "../src/sim";
import { AIDirector } from "../src/sim/ai/director";
import { createFreeAIClient, FreeAIError } from "../src/sim/ai/freeai";
import type { LLMClient, LLMRequest, LLMResponse } from "../src/sim/ai/llm";
import { readHour } from "../src/sim/ai/llm";
import { matchOption } from "../src/sim/ai/match";
import { SimRunner } from "../src/sim/runner";
import type { Conversation, WorldState } from "../src/sim/types";

const OLLAMA = "http://127.0.0.1:11434/v1/chat/completions";
const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const REQ = { system: "Be brief.", user: "Hi", schema: { type: "object", properties: { ok: { type: "boolean" } } }, maxTokens: 300 };

/** Run `fn` with Date.now under the test's control. */
async function withClock<T>(fn: (clock: { now: number }) => Promise<T>): Promise<T> {
  const real = Date.now;
  const clock = { now: real() };
  Date.now = () => clock.now;
  try {
    return await fn(clock);
  } finally {
    Date.now = real;
  }
}

test("Ollama: held to the reply's shape, plain JSON for an Ollama too old for that, and replies kept short", async () => {
  const bodies: Record<string, any>[] = [];
  const client = createFreeAIClient({
    url: OLLAMA,
    model: "qwen2.5:7b",
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (body.response_format?.type === "json_schema") return new Response(JSON.stringify({ error: { message: "invalid format: json_schema is not supported" } }), { status: 400 });
      return ok('{"choice":"work","thought":"Rent first."}');
    }) as typeof fetch,
  });
  assert.equal(client.local, true, "a model on this computer");
  const schema = { type: "object", properties: { choice: { type: "string", enum: ["work", "eat"] }, thought: { type: "string" } }, required: ["choice", "thought"] };
  const r = await client.complete({ system: "s", user: "u", schema, maxTokens: 400 });
  assert.deepEqual(r.json, { choice: "work", thought: "Rent first." });
  // First the exact shape (a choice can only be one from the list)...
  assert.equal(bodies[0].response_format.type, "json_schema");
  assert.deepEqual(bodies[0].response_format.json_schema.schema, schema);
  // ...turned down by this Ollama, so plain JSON, from then on.
  assert.equal(bodies[1].response_format.type, "json_object");
  await client.complete({ system: "s", user: "u", schema, maxTokens: 400 });
  assert.equal(bodies.length, 3);
  assert.equal(bodies[2].response_format.type, "json_object");
  assert.equal(bodies[2].max_tokens, 400, "a reply can't run on and on");
  // A "thinking" model's reasoning counts towards the length, so it isn't cut short.
  const thinker = createFreeAIClient({ url: OLLAMA, model: "qwen3:8b", fetchImpl: (async (_u: string, init?: RequestInit) => (bodies.push(JSON.parse(String(init?.body))), ok('{"ok":true}'))) as typeof fetch });
  await thinker.complete(REQ);
  assert.equal(bodies[3].max_tokens, undefined);
});

test("a model of your own isn't left alone for minutes after one error, and a slow answer is called slow (not unreachable)", async () => {
  await withClock(async (clock) => {
    let n = 0;
    const client = createFreeAIClient({
      url: OLLAMA,
      model: "qwen2.5:3b",
      timeoutMs: 40,
      fetchImpl: (async (_u: string, init?: RequestInit) => {
        n++;
        if (n === 1) return new Response("model runner has unexpectedly stopped", { status: 500 });
        if (n === 2)
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
          });
        return ok('{"ok":true}');
      }) as typeof fetch,
    });
    await assert.rejects(client.complete(REQ), (e: FreeAIError) => e.status === 500);
    // Straight after: still resting...
    await assert.rejects(client.complete(REQ), (e: FreeAIError) => e.status === 429 && /resting/.test(e.message));
    // ...but only for a moment (a public service would be rested for minutes).
    clock.now += 2_500;
    await assert.rejects(client.complete(REQ), (e: FreeAIError) => e.status === 408 && /took longer than/.test(e.message));
    assert.equal(client.status().providers[0].state, "busy", "slow, not unreachable");
    clock.now += 2_500;
    assert.deepEqual((await client.complete(REQ)).json, { ok: true });
  });
});

test("an answer is read generously: the id in brackets, another case, the label, its number on the list", () => {
  const options = [
    { id: "work_corp", label: "Go to work at CityCorp" },
    { id: "eat_diner", label: "Eat at City Diner (£8)" },
    { id: "see:c4", label: "Go and see Priya (at the park)" },
  ];
  assert.equal(matchOption("work_corp", options)?.id, "work_corp");
  assert.equal(matchOption("[eat_diner]", options)?.id, "eat_diner");
  assert.equal(matchOption("[eat_diner] Eat at City Diner", options)?.id, "eat_diner");
  assert.equal(matchOption(" Work_Corp. ", options)?.id, "work_corp");
  assert.equal(matchOption("Eat at City Diner", options)?.id, "eat_diner");
  assert.equal(matchOption("go and see priya", options)?.id, "see:c4");
  assert.equal(matchOption("2", options)?.id, "eat_diner");
  assert.equal(matchOption(3, options)?.id, "see:c4");
  assert.equal(matchOption("Go", options), undefined, "too short to say which");
  assert.equal(matchOption("rob a bank", options), undefined);
  assert.equal(matchOption(null, options), undefined);
  assert.equal(readHour("07:30"), 7.5);
  assert.equal(readHour("7.30pm"), 19.5);
  assert.equal(readHour("8am"), 8);
  assert.equal(readHour("12am"), 0);
  assert.equal(readHour(13.25), 13.25);
  assert.equal(readHour("teatime"), null);
});

test("the AI's answers are taken in (and the next questions sent) even while the clock is slowed right down", async () => {
  const w = newWorld(3);
  const runner = new SimRunner(w);
  let pumps = 0;
  runner.pace = () => 0;
  runner.afterSteps = () => pumps++;
  const t = w.time;
  runner.start();
  await new Promise((r) => setTimeout(r, 450));
  runner.stop();
  assert.equal(w.time, t, "the clock didn't move");
  assert.ok(pumps >= 3, `pumped ${pumps} times`);
  // Paused: nothing at all.
  pumps = 0;
  runner.paused = true;
  runner.start();
  await new Promise((r) => setTimeout(r, 250));
  runner.stop();
  assert.equal(pumps, 0);
});

const WORDS = "kettle bus rain market rent pigeon football cousin bakery parking telly garden invoice pub boss holiday phone biscuits traffic weekend sandwich bike laundry neighbour dentist umbrella sofa coffee lottery festival storm shoes curry cinema allotment".split(" ");

/** A stand-in for a model of your own that can be made to fail (it throws, like Ollama going away) or answer. */
function ownModel(): LLMClient & { local: true; failing: boolean | ((req: LLMRequest) => boolean); error: string; calls: number; lines: number; failed: number } {
  let x = 5;
  const word = () => WORDS[(x = (x * 1103515245 + 12345) >>> 0) % WORDS.length];
  const m = {
    model: "qwen2.5:3b",
    free: true as const,
    local: true as const,
    label: "Ollama",
    failing: false as boolean | ((req: LLMRequest) => boolean),
    failed: 0,
    error: "couldn't connect (fetch failed)",
    calls: 0,
    lines: 0,
    async complete(req: LLMRequest): Promise<LLMResponse> {
      m.calls++;
      if (typeof m.failing === "function" ? m.failing(req) : m.failing) {
        m.failed++;
        throw Object.assign(new Error(m.error), { status: 0 });
      }
      const props = (req.schema as { properties?: Record<string, { enum?: string[] }> }).properties ?? {};
      const json = props.action ? { action: "carry_on", reason: "Nothing doing.", intention: "Carry on." }
        : props.choice?.enum?.length ? { choice: props.choice.enum[0], thought: "Right then, that first." }
        : props.spoken ? (m.lines++, { spoken: `The ${word()} and the ${word()}, by the ${word()} near the ${word()}.`, intent: "pass time", topic: "x", endConversation: false })
        : props.thought ? { thought: "I could murder a cup of tea." }
        : null;
      return { json, inputTokens: 1, outputTokens: 1, model: "qwen2.5:3b" };
    },
  };
  return m;
}

async function play(w: WorldState, d: AIDirector, clock: { now: number }, minutes: number, seen?: Map<number, Conversation>): Promise<void> {
  for (let i = 0; i < minutes; i++) {
    advance(w, 1);
    clock.now += 250;
    await new Promise((r) => setImmediate(r));
    d.pump(w);
    if (seen) for (const c of [...w.conversations, ...w.conversationLog]) seen.set(c.id, c);
  }
}

test("Ollama going away for a bit: the town picks up again within seconds, and the player's told what's wrong and what to do", async () => {
  await withClock(async (clock) => {
    const m = ownModel();
    const d = new AIDirector(m, { total: () => 0, add: () => {} }, { maxConcurrent: 2, minIntervalMs: 0, timeoutMs: 60_000, liveChats: 6 });
    d.attach();
    const w = newWorld(11);
    w.ai.mode = "llm";
    w.ai.maxCallsPerDay = 1e6;
    w.ai.aiOnly = true;
    advance(w, 3 * 60);
    await play(w, d, clock, 60);
    assert.equal(d.trouble(w), null, "all's well");
    m.failing = true;
    await play(w, d, clock, 2 * 60);
    const t = d.trouble(w);
    assert.equal(t?.level, "error");
    assert.match(t!.text, /hasn't answered/);
    assert.match(t!.hint, /Ollama/, "says what to do about it");
    assert.ok(d.answers().failed > 0);
    // Back again: within seconds (not minutes) it's answering, and the trouble's over.
    m.failing = false;
    const before = m.calls;
    await play(w, d, clock, 60);
    assert.ok(m.calls > before + 10, `${m.calls - before} questions asked since`);
    assert.equal(d.trouble(w), null);
    assert.ok(d.answers().answered > 0);
  });
});

test("only the AI speaking: a line that got no answer (busy, slow) is asked for again, more patiently than one it got wrong", async () => {
  await withClock(async (clock) => {
    const m = ownModel();
    const d = new AIDirector(m, { total: () => 0, add: () => {} }, { maxConcurrent: 2, minIntervalMs: 0, timeoutMs: 60_000, liveChats: 6 });
    d.attach();
    const w = newWorld(42);
    w.ai.mode = "llm";
    w.ai.maxCallsPerDay = 1e6;
    w.ai.aiOnly = true;
    advance(w, 9 * 60);
    const seen = new Map<number, Conversation>();
    // Find a conversation the AI's speaking, then have it fail to answer four times in a row.
    let conv: Conversation | undefined;
    for (let i = 0; i < 6 * 60 && !conv; i++) {
      await play(w, d, clock, 1, seen);
      conv = w.conversations.find((c) => c.status === "live" && !c.live?.done && c.lines.length >= 1);
    }
    assert.ok(conv, "someone's talking");
    const had = conv!.lines.length;
    // (Only their lines go unanswered: four in a row, as many tries as a line it gets wrong has.)
    const names = [conv!.a, conv!.b].map((id) => w.citizens[id].name);
    m.failing = (req) => !!(req.schema as { properties?: { spoken?: unknown } }).properties?.spoken && names.some((n) => req.system.includes(n));
    m.error = "took longer than 60 s to answer";
    for (let i = 0; i < 240 && m.failed < 4; i++) await play(w, d, clock, 1, seen);
    assert.ok(m.failed >= 4);
    m.failing = false;
    await play(w, d, clock, 20, seen);
    const now = seen.get(conv!.id)!;
    assert.ok(now.lines.length > had, "the conversation carried on once it answered again");
  });
});
