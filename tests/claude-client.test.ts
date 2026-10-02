import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaudeClient } from "../src/server/anthropic";

// Verifies the exact HTTP request we send to the Claude API (no real call).
test("Claude client sends a structured-output request and parses the reply", async () => {
  const cap: { v: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null } = { v: null };
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    cap.v = { url: String(url), headers, body: JSON.parse(String(init?.body)) };
    const reply = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: JSON.stringify({ choice: "stay", thought: "Steady as she goes." }) }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 512, output_tokens: 64 },
    };
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const client = createClaudeClient("claude-opus-5-5", fakeFetch)!;
  const schema = { type: "object", properties: { choice: { type: "string" }, thought: { type: "string" } }, required: ["choice", "thought"], additionalProperties: false };
  const res = await client.complete({ system: "sys", user: "hello", schema, maxTokens: 3000 });

  assert.deepEqual(res.json, { choice: "stay", thought: "Steady as she goes." });
  assert.equal(res.inputTokens, 512);
  assert.ok(cap.v);
  const c = cap.v!;
  assert.match(c.url, /\/v1\/messages/);
  assert.equal(c.body.model, "claude-opus-5-5");
  assert.equal(c.body.fallbacks, "default");
  assert.deepEqual(c.body.output_config, { effort: "low", format: { type: "json_schema", schema } });
  assert.match(c.headers["anthropic-beta"] ?? "", /server-side-fallback-2026-07-01/);
});

test("Haiku requests omit effort and fallbacks", async () => {
  let body: Record<string, unknown> = {};
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = createClaudeClient("claude-haiku-4-5", fakeFetch)!;
  await client.complete({ system: "s", user: "u", schema: { type: "object", properties: {}, additionalProperties: false }, maxTokens: 500 });
  assert.equal(body.fallbacks, undefined);
  assert.deepEqual(body.output_config, { format: { type: "json_schema", schema: { type: "object", properties: {}, additionalProperties: false } } });
});
