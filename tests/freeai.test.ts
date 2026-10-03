// The free AI: a keyless public endpoint writes the words of conversations;
// the town keeps deciding what happens.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, newWorld } from "../src/sim";
import { AIDirector } from "../src/sim/ai/director";
import { createFreeAIClient, extractJson, FreeAIError, shapeOf } from "../src/sim/ai/freeai";
import { cleanLines } from "../src/sim/ai/lines";
import type { Conversation, WorldState } from "../src/sim/types";

type Call = { url: string; body: Record<string, unknown> };

/** A stand-in for the public endpoint: answers like an OpenAI-style chat API. */
function fakeEndpoint(calls: Call[], reply: (body: Record<string, unknown>, n: number) => { status?: number; content?: string }): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(url), body });
    const r = reply(body, calls.length);
    if (r.status && r.status !== 200) return new Response("slow down", { status: r.status });
    return new Response(JSON.stringify({ model: "openai-fast", choices: [{ message: { content: r.content ?? "" } }], usage: { prompt_tokens: 900, completion_tokens: 120 } }), { status: 200 });
  }) as typeof fetch;
}

/** Dialogue in the shape a smaller model tends to send: names as speakers, a "Name:" prefix, a stage direction, a code fence. */
function messyDialogue(body: Record<string, unknown>): string {
  const user = String((body.messages as { content: string }[])[1].content);
  const a = user.match(/^A is (\w+)/m)?.[1] ?? "A";
  const b = user.match(/^B is (\w+)/m)?.[1] ?? "B";
  return "```json\n" + JSON.stringify({ lines: [
    { speaker: a, text: `${a}: *waves* Fancy seeing you here, ${b}!` },
    { speaker: "B", text: `"Oh, you know me. Can't keep away."` },
    { speaker: "A", text: "Have you tried the new pastries? (laughs) Dangerous." },
    { speaker: b, text: "Don't. I've had three." },
  ], outcome: { agreed: false, amount: 99999 } }) + "\n```";
}

test("reading a smaller model's replies: fences, chatter around the JSON, or plain A:/B: lines", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here you go: {"lines":[]} Hope that helps.'), { lines: [] });
  assert.deepEqual(extractJson("A: Morning!\nB: Is it?\nA: Fair point."), { lines: [{ speaker: "A", text: "Morning!" }, { speaker: "B", text: "Is it?" }, { speaker: "A", text: "Fair point." }] });
  assert.equal(extractJson("no idea"), null);
  assert.deepEqual(shapeOf({ type: "object", properties: { lines: { type: "array", items: { type: "object", properties: { speaker: { type: "string", enum: ["A", "B"] }, text: { type: "string" } } } }, n: { type: "number" } } }), {
    lines: [{ speaker: "A | B", text: "..." }],
    n: 0,
  });
});

test("the free client: keyless request, private, a different seed each call; errors say whether to back off", async () => {
  const calls: Call[] = [];
  const client = createFreeAIClient({ url: "http://fake/openai", fetchImpl: fakeEndpoint(calls, (_b, n) => (n === 3 ? { status: 429 } : { content: '{"ok":true}' })) });
  assert.equal(client.free, true);
  const req = { system: "Be brief.", user: "Hi", schema: { type: "object", properties: { ok: { type: "boolean" } } }, maxTokens: 100 };
  const r1 = await client.complete(req);
  const r2 = await client.complete(req);
  assert.deepEqual(r1.json, { ok: true });
  assert.equal(calls[0].url, "http://fake/openai");
  const body = calls[0].body as { messages: { role: string; content: string }[]; private: boolean; seed: number; response_format: unknown };
  assert.equal(body.private, true, "kept out of the public feed");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.match(body.messages[0].content, /Be brief\.[\s\S]*"ok":true/, "the system prompt shows the shape to reply in");
  assert.notEqual(calls[0].body.seed, calls[1].body.seed, "every conversation its own");
  assert.ok(r2.model.startsWith("free:"));
  await assert.rejects(client.complete(req), (e: FreeAIError) => e instanceof FreeAIError && e.status === 429);
  const offline = createFreeAIClient({ fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
  await assert.rejects(offline.complete(req), (e: FreeAIError) => e.status === 0 && /reach/.test(e.message));
});

test("model lines become clean spoken lines", () => {
  const w = newWorld(80);
  const [a, b] = w.citizenOrder.map((id) => w.citizens[id]);
  const conv = { id: 1, a: a.id, b: b.id } as Conversation;
  const lines = cleanLines(w, conv, [
    { speaker: a.name, text: `${a.name}: *sighs* Long day.` },
    { speaker: "B", text: '"Tell me about it."' },
    { speaker: "C", text: "Who am I?" },
    { speaker: "A", text: "(pause)" },
    { speaker: "A", text: "Look at https://example.com" },
    { speaker: "B", text: "Right. Pint?" },
  ]);
  assert.deepEqual(lines, [
    { speaker: a.id, text: "Long day." },
    { speaker: b.id, text: "Tell me about it." },
    { speaker: b.id, text: "Right. Pint?" },
  ]);
});

async function run(w: WorldState, director: AIDirector, minutes: number): Promise<void> {
  for (let i = 0; i < minutes / 5; i++) {
    advance(w, 5);
    await new Promise((r) => setImmediate(r));
    director.pump(w);
  }
}

test("with the free AI, conversations get fresh words; the town still decides what happens; it costs nothing", async () => {
  const calls: Call[] = [];
  const client = createFreeAIClient({ url: "http://fake/openai", fetchImpl: fakeEndpoint(calls, (body) => ({ content: messyDialogue(body) })) });
  const director = new AIDirector(client, { total: () => 1e9, add: () => assert.fail("nothing to pay") }, { maxConcurrent: 2, minIntervalMs: 0, timeoutMs: 5000 });
  director.attach();
  const w = newWorld(81);
  w.ai.mode = "llm";
  w.ai.budgetUsd = 0; // no budget needed
  w.ai.maxCallsPerDay = 5000;
  const seen = new Map<number, Conversation>();
  for (let h = 0; h < 36; h++) {
    await run(w, director, 60);
    for (const c of w.conversationLog) seen.set(c.id, c);
  }
  const all = [...seen.values()];
  const voiced = all.filter((c) => c.source === "llm");
  assert.ok(voiced.length >= 20, `only ${voiced.length} of ${all.length} conversations voiced`);
  assert.ok(voiced.some((c) => c.topic !== "chat"), "deals and favours get voiced too");
  for (const c of voiced) {
    assert.deepEqual(c.lines.map((l) => l.text), ["Fancy seeing you here, " + w.citizens[c.b].name + "!", "Oh, you know me. Can't keep away.", "Have you tried the new pastries? Dangerous.", "Don't. I've had three."]);
    assert.deepEqual(c.outcome, c.fallback!.outcome, "the outcome is the town's, not the model's");
  }
  assert.equal(w.ai.spentUsd, 0);
  // The prompt carries who they are and what to cover.
  const chatPrompt = calls.map((c) => String((c.body.messages as { content: string }[])[1].content)).find((u) => u.includes("What they talk about"));
  assert.ok(chatPrompt, "a chat prompt");
  assert.match(chatPrompt!, /A is \w+ \w+, \d+\./);
  assert.match(chatPrompt!, /never "A" or "B"/);
});

test("when the free AI says slow down (or can't be reached), the town backs off and talks for itself", async () => {
  const calls: Call[] = [];
  const client = createFreeAIClient({ url: "http://fake/openai", fetchImpl: fakeEndpoint(calls, () => ({ status: 429 })) });
  const director = new AIDirector(client, { total: () => 0, add: () => {} }, { maxConcurrent: 1, minIntervalMs: 0, timeoutMs: 5000 });
  director.attach();
  const w = newWorld(82);
  w.ai.mode = "llm";
  w.ai.maxCallsPerDay = 5000;
  await run(w, director, 600);
  assert.ok(calls.length <= 2, `${calls.length} calls: after a refusal it waits instead of hammering the endpoint`);
  const log = [...w.conversationLog, ...w.conversations];
  assert.ok(log.length > 3 && log.every((c) => c.source === "template"), "everyone still talks, in the built-in AI's words");
  assert.ok(w.ai.log.some((l) => l.status === "error" && /429/.test(l.note)));
});
