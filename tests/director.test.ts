import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, newWorld } from "../src/sim";
import { AIDirector } from "../src/sim/ai/director";
import type { LLMClient, LLMRequest } from "../src/sim/ai/llm";

// A fake Claude: picks the last strategy option, and in conversations
// always agrees — with deliberately out-of-range numbers, to prove the
// engine clamps AI output to what the characters can actually do.
function mockClient(calls: LLMRequest[]): LLMClient {
  return {
    model: "claude-opus-5-5",
    async complete(req) {
      calls.push(req);
      const props = req.schema.properties as Record<string, { enum?: string[] }>;
      if (props.choice) {
        const ids = props.choice.enum!;
        return { json: { choice: ids[ids.length - 1], thought: "I've thought hard about this and I'm going for it." }, inputTokens: 600, outputTokens: 150, model: "claude-opus-5-5" };
      }
      return {
        json: {
          lines: [
            { speaker: "A", text: "Can we do a deal?" },
            { speaker: "B", text: "Go on then." },
            { speaker: "A", text: "Brilliant." },
          ],
          outcome: { agreed: true, amount: 99999, rate: 5, days: 99, share: 0.99, wage: 9999, gift: 9999, qty: 9999, price: 0.01, result: "refuse" },
        },
        inputTokens: 700,
        outputTokens: 200,
        model: "claude-opus-5-5",
      };
    },
  };
}

test("AI director: calls Claude for important moments, validates, tracks spend", async () => {
  const calls: LLMRequest[] = [];
  let spent = 0;
  const director = new AIDirector(mockClient(calls), { total: () => spent, add: (u) => (spent += u) }, { maxConcurrent: 4, minIntervalMs: 0, timeoutMs: 5000 });
  director.attach();
  const world = newWorld(7);
  world.ai.mode = "llm";
  world.ai.budgetUsd = 5;
  world.ai.maxCallsPerDay = 40;
  for (let i = 0; i < 6 * 24 * 6; i++) {
    advance(world, 10);
    await new Promise((r) => setImmediate(r));
    director.pump(world);
  }
  assert.ok(calls.length > 0, "director should have called the LLM");
  assert.ok(spent > 0 && world.ai.spentUsd > 0, "spend should be tracked");
  const llmConvs = world.conversationLog.filter((c) => c.source === "llm");
  assert.ok(llmConvs.length > 0, "some conversations should be voiced by the LLM");
  for (const conv of llmConvs) {
    const o = conv.outcome ?? {};
    const t = conv.terms;
    if (conv.topic === "ask_loan" && o.agreed) {
      assert.ok((o.amount as number) <= (t.maxLend as number), "loan amount clamped to what the lender can spare");
      assert.ok((o.rate as number) <= (t.maxRate as number) + 1e-9, "rate clamped to what the borrower accepts");
    }
    if (conv.topic === "ask_loan" && t.willing === false) assert.equal(o.agreed, false, "an unwilling lender can't be talked into it by the LLM");
    if (conv.topic === "demand_repayment" && t.honest === true) assert.notEqual(o.result, "refuse", "honest debtors don't refuse");
  }
  // Money must still be conserved and nobody negative.
  for (const id of world.citizenOrder) assert.ok(world.citizens[id].money >= -0.001);
  assert.ok(world.ai.log.length > 0);
  // Budget cap is respected.
  const before = calls.length;
  world.ai.budgetUsd = spent; // now exhausted
  advance(world, 1440);
  await new Promise((r) => setImmediate(r));
  director.pump(world);
  assert.equal(calls.length, before, "no calls after the budget is spent");
});
