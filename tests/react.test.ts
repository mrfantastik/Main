// People react to God Mode: they feel it (in proportion), think about it,
// stop and take it in, tell the feed, sometimes blame someone; and with the
// town's brain awake, it reacts first and plans the rest of their day again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, newWorld } from "../src/sim";
import { AIDirector } from "../src/sim/ai/director";
import type { LLMClient, LLMRequest } from "../src/sim/ai/llm";
import { readPlan, readThought } from "../src/sim/ai/small";
import { applyGodCommand } from "../src/sim/god";
import type { Citizen, WorldState } from "../src/sim/types";

const people = (w: WorldState): Citizen[] => w.citizenOrder.map((id) => w.citizens[id]);
/** Someone awake, not talking or walking, with some money. */
function awake(w: WorldState): Citizen {
  return people(w).find((c) => !["sleep", "talk", "travel"].includes(c.activity.kind) && c.path.length === 0 && c.money + c.savings > 60 && !c.awaitingAI)!;
}

test("taking money: they feel it in proportion, think about it, stop to take it in, and it's in the feed", () => {
  const w = newWorld(120);
  advance(w, 5 * 60);
  const c = awake(w);
  const had = c.money + c.savings;
  const before = { ...c.emotions };
  applyGodCommand(w, { cmd: "take_money", citizenId: c.id, amount: Math.round(had * 0.8) });
  assert.ok(c.emotions.anger > before.anger + 10 && c.emotions.fear > before.fear + 10, "angry and scared");
  assert.match(c.thought, /vanished|gone/);
  assert.equal(c.thoughtPriority, 4);
  assert.equal(c.activity.label, "Taking it all in");
  assert.ok(c.shock && c.shock.t === w.time);
  assert.ok(w.events.some((e) => e.cat === "life" && e.text.includes(c.name) && /devastated|furious/.test(e.text)));
  advance(w, 25);
  assert.notEqual(c.activity.label, "Taking it all in", "then they get on with deciding what to do");

  // A few pounds from someone well off barely registers.
  const rich = people(w).find((x) => x.id !== c.id && x.money + x.savings > 200)!;
  if (rich) {
    rich.money += 2000;
    const anger = rich.emotions.anger;
    const doing = rich.activity.label;
    applyGodCommand(w, { cmd: "take_money", citizenId: rich.id, amount: 5 });
    assert.ok(rich.emotions.anger - anger < 6, "a fiver from someone with thousands: a shrug");
    assert.equal(rich.activity.label, doing, "they carry on");
    assert.match(rich.thought, /Odd/);
  }
});

test("a suspicious sort blames someone they already dislike", () => {
  const w = newWorld(121);
  advance(w, 5 * 60);
  const c = awake(w);
  const rival = people(w).find((x) => x.id !== c.id)!;
  c.personality.big5.agreeableness = 0.2;
  c.relationships[rival.id] = { ...(c.relationships[rival.id] ?? { affinity: 0, trust: 0, familiarity: 30, roles: [] }), affinity: -40, trust: 10 } as Citizen["relationships"][string];
  for (const [id, r] of Object.entries(c.relationships)) if (id !== rival.id && r.affinity < -40) r.affinity = 0;
  const trust = c.relationships[rival.id].trust;
  applyGodCommand(w, { cmd: "take_money", citizenId: c.id, amount: Math.round((c.money + c.savings) * 0.5) });
  assert.ok(c.thought.includes(`I bet ${rival.name}`), c.thought);
  assert.ok(c.relationships[rival.id].trust < trust - 10, "trusts them less");
  assert.ok([...c.memories.short, ...c.memories.long].some((m) => m.kind === "betrayal" && m.people.includes(rival.id)));
});

test("windfalls, a new job, a closed business, a crash: each lands the way it should", () => {
  const w = newWorld(122);
  advance(w, 2 * 1440 + 10 * 60);
  const lucky = awake(w);
  const joy = lucky.emotions.joy;
  applyGodCommand(w, { cmd: "give_money", citizenId: lucky.id, amount: 2000 });
  assert.ok(lucky.emotions.joy > joy + 10 && /appeared/.test(lucky.thought));

  const jobless = people(w).find((x) => x.occupation !== "employee" && x.activity.kind !== "sleep" && !x.businessIds.length)!;
  applyGodCommand(w, { cmd: "set_job", citizenId: jobless.id, occupation: "employee" });
  assert.match(jobless.thought, /CityCorp employee now/);

  const biz = Object.values(w.businesses).find((b) => b.open)!;
  const owner = w.citizens[biz.ownerId];
  const sad = owner.emotions.sadness;
  applyGodCommand(w, { cmd: "close_business", businessId: biz.id });
  assert.ok(owner.emotions.sadness > sad + 10 && owner.thought.includes(biz.name));

  applyGodCommand(w, { cmd: "crash" });
  assert.ok(people(w).every((x) => /crashed/.test(x.thought) || x.thoughtPriority > 3), "everyone's thinking about it");
  assert.ok(people(w).every((x) => x.shock?.text === "The economy crashed." || x.shock?.t === w.time));
});

/** A stand-in brain that records what it's asked and gives recognisable answers. */
function fakeBrain(seen: LLMRequest[]): LLMClient {
  return {
    model: "brain",
    free: true,
    small: true,
    label: "Town brain",
    ready: () => true,
    async complete(req) {
      seen.push(req);
      const p = req.small!;
      if (p.kind === "plan") return { json: { items: readPlan(`${p.prefill} 1 - deal with this\n9pm: 2 - then bed`, p.options!, p.labels!) }, inputTokens: 0, outputTokens: 0, model: "brain" };
      if (p.kind === "thought") return { json: { thought: readThought(/Just now:/.test(p.user) ? "Who would do this to me? I'm going straight to the bank." : "Just another day.", "") }, inputTokens: 0, outputTokens: 0, model: "brain" };
      return { json: null, inputTokens: 0, outputTokens: 0, model: "brain" };
    },
  };
}

test("with the brain awake, it reacts first: their reaction, then a new plan for the rest of the day", async () => {
  const seen: LLMRequest[] = [];
  const d = new AIDirector(fakeBrain(seen), { total: () => 0, add: () => {} }, { maxConcurrent: 1, minIntervalMs: 0, timeoutMs: 5000 });
  d.attach();
  const w = newWorld(123);
  w.ai.mode = "llm";
  w.ai.maxCallsPerDay = 50000;
  advance(w, 9 * 60);
  const pump = async (n: number) => {
    for (let i = 0; i < n; i++) {
      advance(w, 1);
      await new Promise((r) => setImmediate(r));
      d.pump(w);
    }
  };
  await pump(30);
  const c = awake(w);
  const askedBefore = seen.length;
  applyGodCommand(w, { cmd: "take_money", citizenId: c.id, amount: Math.round((c.money + c.savings) * 0.7) });
  await pump(3);
  const after = seen.slice(askedBefore);
  assert.ok(after[0].small!.kind === "thought" && after[0].small!.user.startsWith(`${c.name} (`) && /Just now: .*vanished/.test(after[0].small!.user), "the very next thing it's asked is their reaction");
  assert.equal(c.thought, "Who would do this to me? I'm going straight to the bank.");
  assert.equal(c.thoughtSource, "llm");
  await pump(10);
  const replan = seen.slice(askedBefore).find((r) => r.small!.kind === "plan" && r.small!.user.startsWith(`${c.name} (`));
  assert.ok(replan, "and a new plan for their day");
  assert.match(replan!.small!.user, /Just now: .*vanished/);
  assert.match(replan!.small!.user, /new plan for the rest of today/);
  assert.ok(c.agent?.plan && c.agent.plan.items[0].why === "deal with this", "which they now follow");
});
