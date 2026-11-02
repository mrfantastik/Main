// Only the AI decides: what everyone does next, their big decisions, what
// they do about other people, and what an owner makes of an applicant or an
// offer are all the AI's, and the only thoughts shown are the AI's. When it
// can't answer, nobody decides for them: they wait, and nothing breaks. And
// the free version only ever uses a model on this computer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, newWorld } from "../src/sim";
import { waitForAI, waitingForAI } from "../src/sim/ai/brain";
import { choicesHourly, waitingChoices } from "../src/sim/ai/choices";
import { shownThought } from "../src/sim/ai/decision";
import { AIDirector } from "../src/sim/ai/director";
import { pickModel } from "../src/sim/ai/freeai";
import type { LLMClient } from "../src/sim/ai/llm";
import { isCloudModel, isLocalUrl, notLocal } from "../src/sim/ai/localai";
import { startActivity } from "../src/sim/ai/actions";
import { considerApplicant } from "../src/sim/economy/operations";
import { chooseInstalled, localModels, modelForHardware, ollamaBase, settingsForSpeed } from "../src/server/free";
import { carryOut, checkAction, readAction } from "../src/sim/society/actions";
import { logDecision } from "../src/sim/society/state";
import { createPeerLoan } from "../src/sim/economy/bank";
import type { WorldState } from "../src/sim/types";

const WORDS = "kettle bus rain market rent pigeon football cousin bakery parking telly garden invoice pub boss holiday phone biscuits traffic weekend sandwich bike laundry neighbour dentist umbrella sofa coffee lottery festival storm shoes curry cinema allotment bins postman radio nephew wedding scooter bread hedge porch window ticket ferry seaside stall wages plumber".split(" ");

/** A stand-in model that answers everything: lines, choices, thoughts, decisions (`dead`: nothing usable at all). */
function fakeModel(opts: { dead?: () => boolean; pick?: (ids: string[]) => string } = {}): LLMClient & { calls: number } {
  let x = 3;
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
      const res = (json: unknown) => ({ json, inputTokens: 1, outputTokens: 1, model: "fake" });
      if (opts.dead?.()) return res(null);
      const props = (req.schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
      if (props.action && props.intention) return res({ action: "carry_on", reason: `The ${word()} can wait.`, intention: "Get on with my day." });
      const ids = (props.choice as { enum?: string[] } | undefined)?.enum;
      if (ids?.length) return res({ choice: opts.pick ? opts.pick(ids) : ids[client.calls % 5 === 0 ? ids.length - 1 : 0], thought: `Right, the ${word()} first, then the ${word()}.` });
      if (props.thought) return res({ thought: `I keep thinking about the ${word()} and the ${word()}.` });
      if (props.spoken) return res({ spoken: `The ${word()} and the ${word()}, by the ${word()} near the ${word()}.`, intent: "pass time", topic: "x", endConversation: client.calls % 11 === 0 });
      return res(null);
    },
  };
  return client;
}

function town(seed: number, client: LLMClient | null): { w: WorldState; d: AIDirector } {
  const d = new AIDirector(client, { total: () => 0, add: () => {} }, { maxConcurrent: 4, minIntervalMs: 0, timeoutMs: 5000, liveChats: 20 });
  d.attach();
  const w = newWorld(seed);
  w.ai.mode = client ? "llm" : "off";
  w.ai.maxCallsPerDay = 100000;
  w.ai.aiOnly = true;
  return { w, d };
}

async function run(w: WorldState, d: AIDirector, minutes: number, each?: () => void): Promise<void> {
  for (let i = 0; i < minutes; i++) {
    advance(w, 1);
    await new Promise((r) => setImmediate(r));
    d.pump(w);
    each?.();
  }
}

const since = (w: WorldState, t: number) => ({
  activity: w.citizenOrder.flatMap((id) => w.citizens[id].decisions.filter((x) => x.t >= t)),
  strategy: w.citizenOrder.flatMap((id) => w.citizens[id].strategyLog.filter((x) => x.t >= t)),
  agents: w.citizenOrder.flatMap((id) => (w.citizens[id].society?.decisions ?? []).filter((x) => x.t >= t)),
});

test("only the AI decides: every decision made, and every thought shown, is the AI's", async () => {
  const { w, d } = town(51, fakeModel());
  const start = w.time;
  let shown = 0;
  await run(w, d, 30 * 60, () => {
    if (w.time % 30) return;
    for (const id of w.citizenOrder) {
      const c = w.citizens[id];
      const t = shownThought(w, c);
      if (t) shown++;
      assert.ok(!t || c.thoughtSource === "llm", `${c.name} shows a built-in thought: "${t}"`);
    }
  });
  const all = since(w, start);
  assert.ok(all.activity.length >= 150, `only ${all.activity.length} decisions about what to do next`);
  assert.ok(all.agents.length >= 20, `only ${all.agents.length} agent decisions`);
  for (const [kind, list] of Object.entries(all)) assert.deepEqual([...new Set(list.map((x) => x.source))], list.length ? ["llm"] : [], `${kind} decisions not all the AI's`);
  assert.ok(shown > 100, "the AI's thoughts are shown");
  assert.ok(w.conversationLog.length >= 10, "and people still talk");
  assert.ok(w.citizenOrder.every((id) => w.citizens[id].activity.kind !== "talk" || w.conversations.some((c) => c.a === id || c.b === id || c.group?.present.includes(id))));
});

test("with no AI answering, nobody decides for them: they wait, and the town doesn't break", async () => {
  const { w, d } = town(52, fakeModel({ dead: () => true }));
  advance(w, 8 * 60);
  const start = w.time;
  let waiting = 0;
  await run(w, d, 10 * 60, () => {
    waiting = Math.max(waiting, w.citizenOrder.filter((id) => waitingForAI(w.citizens[id])).length);
  });
  const all = since(w, start);
  assert.equal(all.activity.length + all.strategy.length, 0, "nothing decided for them");
  assert.ok(all.agents.every((x) => x.source === "llm"), "no built-in agent decisions");
  assert.ok(waiting >= 10, `people wait for the AI (${waiting} at most)`);
  assert.ok(d.pace(w) < 1, "and the clock slows for them");
  for (const id of w.citizenOrder) {
    const c = w.citizens[id];
    assert.ok(Number.isFinite(c.money) && c.money >= -0.001);
    assert.ok(!shownThought(w, c) || c.thoughtSource === "llm");
  }
  // Switched off altogether: still nobody decides for them, and nothing runs away.
  w.ai.mode = "off";
  const off = w.time;
  advance(w, 24 * 60);
  const after = since(w, off);
  assert.equal(after.activity.length + after.strategy.length, 0);
  assert.equal(w.conversations.length, 0);
});

test("an owner's AI decides on an applicant; if nobody decides, it lapses", async () => {
  const { w, d } = town(42, fakeModel({ pick: (ids) => (ids.includes("hire") ? "hire" : ids[0]) }));
  const b = w.businesses.b13;
  const owner = w.citizens[b.ownerId];
  const ben = w.citizens.c11;
  assert.equal(ben.occupation, "unemployed");
  b.hiringWage = 30;
  assert.equal(considerApplicant(w, b, ben), false, "not on the spot");
  assert.equal(waitingChoices(w).length, 1, "it's waiting for the owner's AI");
  for (let i = 0; i < 30 && waitingChoices(w).length; i++) {
    await new Promise((r) => setImmediate(r));
    d.pump(w);
  }
  assert.equal(ben.employerId, b.id, `${owner.name}'s AI took Ben on`);
  assert.ok(owner.strategyLog.some((x) => x.source === "llm" && x.chosen === "hire"));
  // No AI: it waits, then lapses (Ben never hears back), and nobody decides for the owner.
  const sofia = w.citizens.c16;
  w.ai.mode = "off";
  b.hiringWage = 30;
  considerApplicant(w, b, sofia);
  assert.equal(waitingChoices(w).length, 1);
  w.time += 9 * 60;
  choicesHourly(w);
  assert.equal(waitingChoices(w).length, 0);
  assert.notEqual(sofia.employerId, b.id);
  assert.ok(sofia.memories.short.some((m) => /never heard back/.test(m.text)));
  // And with only the AI deciding switched off, whatever's still waiting is decided the usual way.
  w.ai.aiOnly = true;
  b.hiringWage = 30;
  considerApplicant(w, b, sofia);
  w.ai.aiOnly = false;
  choicesHourly(w);
  assert.equal(waitingChoices(w).length, 0);
  assert.ok(owner.strategyLog.some((x) => x.source === "utility"));
});

test("the clock slows while people wait for the AI (unless told not to)", () => {
  const { w, d } = town(53, fakeModel());
  assert.equal(d.pace(w), 1);
  for (const id of w.citizenOrder.slice(0, 10)) startActivity(w, w.citizens[id], waitForAI(w.citizens[id]));
  assert.ok(d.pace(w) <= 0.25, `pace ${d.pace(w)}`);
  assert.equal(d.backlog(w).people, 10);
  w.ai.waitForAI = false;
  assert.equal(d.pace(w), 1);
  w.ai.waitForAI = true;
  w.ai.aiOnly = false;
  assert.equal(d.pace(w), 1, "only when only the AI decides");
});

test("agents can chase what they're owed, and ask for help", () => {
  const w = newWorld(42);
  const jake = w.citizens.c1;
  const friend = w.citizens[Object.keys(jake.relationships)[0]];
  jake.money = Math.max(jake.money, 200);
  const loan = createPeerLoan(w, jake, friend, 40, 0.05, 3, "a bit of help")!;
  assert.ok(loan);
  const act = (raw: Record<string, unknown>) => {
    const r = readAction(w, jake, { action: "propose_deal", reason: "fair's fair", ...raw });
    assert.ok(r.ok, JSON.stringify(r));
    return (r as Extract<typeof r, { ok: true }>).action;
  };
  const chase = act({ deal: "repayment", target: friend.name });
  assert.match(checkAction(w, jake, chase) ?? "", /isn't due/);
  loan.dueT = w.time - 60;
  assert.equal(checkAction(w, jake, chase), null);
  assert.match(carryOut(w, jake, chase, logDecision(w, jake, chase, "llm")), /owe/);
  assert.ok(jake.society!.intents.some((i) => i.topic === "demand_repayment" && i.target === friend.id));
  const other = w.citizens[Object.keys(jake.relationships)[1]];
  assert.match(checkAction(w, jake, act({ deal: "repayment", target: other.name })) ?? "", /doesn't owe/);
  const help = act({ deal: "ask_help", target: other.name });
  assert.equal(checkAction(w, jake, help), null);
  assert.match(carryOut(w, jake, help, logDecision(w, jake, help, "llm")), /help/);
});

test("the free version: only models on this computer, never a cloud one", () => {
  assert.ok(isLocalUrl("http://localhost:11434/v1/chat/completions"));
  assert.ok(isLocalUrl("http://127.0.0.1:1234/v1/chat/completions"));
  assert.ok(isLocalUrl("http://192.168.1.20:11434/v1/chat/completions"));
  assert.ok(isLocalUrl("http://[::1]:11434/v1/chat/completions"));
  assert.ok(!isLocalUrl("https://ollama.com/v1/chat/completions"));
  assert.ok(!isLocalUrl("https://api.openai.com/v1/chat/completions"));
  assert.ok(!isLocalUrl("not a url"));
  for (const m of ["gpt-oss:120b-cloud", "glm-4.6:cloud", "qwen3-coder:480b-cloud"]) assert.ok(isCloudModel(m), m);
  for (const m of ["qwen2.5:7b", "llama3.1", "mistral-nemo", "cloudberry:7b"]) assert.ok(!isCloudModel(m), m);
  assert.equal(notLocal("http://localhost:11434/v1/chat/completions", "qwen2.5:7b"), null);
  assert.match(notLocal("http://localhost:11434/v1/chat/completions", "gpt-oss:20b-cloud") ?? "", /cloud/);
  assert.match(notLocal("https://api.example.com/v1/chat/completions", "x") ?? "", /isn't on this computer/);
  // Picking from what Ollama lists: cloud stubs and embedding models are never used.
  const tags = [
    { name: "gpt-oss:120b-cloud", size: 384, remote_host: "https://ollama.com:443" },
    { name: "nomic-embed-text:latest", size: 274e6, details: { family: "nomic-bert" } },
    { name: "phi3:mini", size: 2.2e9 },
    { name: "qwen2.5:7b-instruct-q4_K_M", size: 4.7e9 },
  ];
  assert.deepEqual(localModels(tags).map((m) => m.name), ["phi3:mini", "qwen2.5:7b-instruct-q4_K_M"]);
  assert.equal(chooseInstalled(tags)?.name, "qwen2.5:7b-instruct-q4_K_M");
  assert.equal(chooseInstalled(tags, "phi3:mini")?.name, "phi3:mini");
  assert.equal(chooseInstalled(tags, "gpt-oss:120b-cloud"), null);
  assert.equal(chooseInstalled([{ name: "gpt-oss:20b-cloud", size: 300 }]), null);
  assert.equal(pickModel(["gpt-oss:120b-cloud", "llama3.1:8b"]), "llama3.1:8b");
  // What to download, and how hard to work it.
  assert.equal(modelForHardware(8, 16).name, "qwen2.5:7b");
  assert.equal(modelForHardware(12, 32).name, "qwen2.5:14b");
  assert.equal(modelForHardware(null, 16).name, "qwen2.5:3b");
  assert.equal(modelForHardware(null, 8).name, "qwen2.5:1.5b");
  assert.equal(modelForHardware(null, 16, true).name, "qwen2.5:7b");
  assert.equal(settingsForSpeed(1).concurrency, 4);
  assert.equal(settingsForSpeed(5).pace, "steady");
  assert.equal(settingsForSpeed(20).timeoutMs, 120_000);
  assert.equal(ollamaBase(undefined), "http://127.0.0.1:11434");
  assert.equal(ollamaBase("0.0.0.0:11434"), "http://127.0.0.1:11434");
  assert.equal(ollamaBase("http://192.168.1.5"), "http://192.168.1.5:11434");
});
