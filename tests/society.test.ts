// The agent layer: each citizen an agent with their own goals, plans,
// knowledge and decisions; a model may propose what they do, the town
// checks it and carries it out (or says why not); the built-in judgement
// takes over when the model can't.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, newWorld } from "../src/sim";
import { AIDirector } from "../src/sim/ai/director";
import type { LLMClient, LLMRequest } from "../src/sim/ai/llm";
import { learn } from "../src/sim/dialogue/knowledge";
import { checkAction, readAction } from "../src/sim/society/actions";
import { decisionPrompt } from "../src/sim/society/prompt";
import { reputationDaily, reputationOf } from "../src/sim/society/reputation";
import { fillRoster, onRoster, societyOf, societyWorld } from "../src/sim/society/state";
import { applyModelDecision } from "../src/sim/society/tick";
import { prepareLoadedWorld } from "../src/sim/migrate";
import type { Citizen, WorldState } from "../src/sim/types";

const people = (w: WorldState): Citizen[] => w.citizenOrder.map((id) => w.citizens[id]);

function internalMoney(w: WorldState): number {
  let total = 0;
  for (const id of w.citizenOrder) total += w.citizens[id].money + w.citizens[id].savings;
  for (const id of w.businessOrder) total += w.businesses[id].cash;
  return total;
}

test("ten different agents on the roster, each with their own goals", () => {
  const w = newWorld(3);
  advance(w, 60);
  const sw = societyWorld(w);
  assert.equal(sw.roster.length, 10);
  const cs = sw.roster.map((id) => w.citizens[id]);
  assert.ok(new Set(cs.map((c) => c.occupation)).size >= 3, "a mix of occupations");
  assert.ok(new Set(cs.map((c) => c.personality.style)).size >= 3, "a mix of temperaments");
  for (const c of cs) assert.ok(societyOf(w, c).goals.length >= 1, `${c.name} wants something`);
  // Not everyone wants the same thing.
  assert.ok(new Set(cs.map((c) => societyOf(w, c).goals[0].kind)).size >= 3);
  assert.equal(fillRoster(w).length, 10, "filling it again changes nothing");
});

test("each agent decides from what they know, and nobody else's secrets", () => {
  const w = newWorld(4);
  advance(w, 1440 + 10 * 60);
  const [a, b] = societyWorld(w).roster.map((id) => w.citizens[id]);
  learn(w, a, { about: a.id, pred: "event", key: "secret:test", text: `${a.name} hid a bag of money under the floorboards`, source: "self", certainty: 1, sensitivity: 0.9, valence: -0.2, importance: 9, confidential: true });
  b.relationships[a.id] = { ...(b.relationships[a.id] ?? { roles: [], lastT: 0 }), affinity: 30, familiarity: 40, trust: 30 } as Citizen["relationships"][string];
  const pa = decisionPrompt(w, a, "time to take stock");
  const pb = decisionPrompt(w, b, "time to take stock");
  assert.match(pa.system, new RegExp(`You are ${a.name}`));
  assert.match(pb.system, new RegExp(`You are ${b.name}`));
  assert.doesNotMatch(pb.system + pb.user, /floorboards/, "b knows nothing of a's secret");
  assert.doesNotMatch(pb.system, new RegExp(`WHAT YOU WANT[\\s\\S]*${societyOf(w, a).goals[0].text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*PEOPLE IN YOUR LIFE`), "nor what a privately wants");
  // What b thinks of a is b's view, from b's side.
  assert.match(pb.system, new RegExp(`${a.name}: `));
});

test("the town checks every proposal: unknown people, impossible sums, nonsense", () => {
  const w = newWorld(5);
  advance(w, 1440 + 11 * 60);
  const c = people(w).find((x) => onRoster(w, x.id))!;
  const other = people(w).find((x) => x.id !== c.id)!;
  assert.equal(readAction(w, c, { action: "fly_to_moon", reason: "x" }).ok, false);
  const ghost = readAction(w, c, { action: "help", target: "Zaphod", amount: 5, reason: "x" });
  assert.ok(!ghost.ok && /Zaphod/.test(ghost.error));
  const huge = readAction(w, c, { action: "help", target: other.name, amount: 1e9, reason: "x" });
  if (huge.ok) assert.ok(checkAction(w, c, huge.action), "can't give away a billion");
  const self = readAction(w, c, { action: "lend", target: c.name, amount: 5, reason: "x" });
  assert.ok(!self.ok || checkAction(w, c, self.action), "can't lend to yourself");
  // A rejected proposal is logged as such (with why), and the built-in judgement decides instead.
  const before = societyOf(w, c).decisions.length;
  const r = applyModelDecision(w, c, { action: "help", target: "Zaphod", amount: 5, reason: "x", intention: "y" }, "test");
  assert.equal(r.decision.status, "rejected");
  assert.equal(r.decision.source, "llm");
  assert.ok(r.decision.error);
  assert.ok(r.fallback && r.fallback.source === "rules", "the built-in judgement steps in");
  assert.equal(societyOf(w, c).decisions.length, before + 2);
});

test("a model's decision is carried out by the town, and the agent learns what came of it", () => {
  const w = newWorld(6);
  advance(w, 1440 + 11 * 60);
  const c = people(w).find((x) => onRoster(w, x.id) && x.money > 40)!;
  // (Someone they know: you can't go looking for a stranger.)
  const friend = people(w).find((x) => x.id !== c.id && (c.relationships[x.id]?.familiarity ?? 0) > 10)!;
  const moneyBefore = c.money + friend.money;
  const r = applyModelDecision(w, c, { action: "talk", target: friend.name, reason: "I miss them.", intention: "I'll go and find them." }, "test");
  assert.equal(r.fallback, null);
  assert.equal(r.decision.status, "pending", "a talk waits until they meet");
  assert.ok(societyOf(w, c).intents.some((i) => i.target === friend.id && i.decision === r.decision.id));
  assert.equal(societyOf(w, c).intention?.source, "llm");
  // Nothing about money changed just by deciding.
  assert.equal(c.money + friend.money, moneyBefore);
  // Later: done (they talked) or expired (they never got the chance); never left hanging.
  advance(w, 1440 * 1.5);
  const d = societyOf(w, c).decisions.find((x) => x.id === r.decision.id)!;
  assert.ok(["done", "expired", "failed"].includes(d.status), d.status);
  assert.ok(d.result);
});

test("ten agents over a week: plans, deals, relationships and money all add up", () => {
  const w = newWorld(8);
  advance(w, 600);
  const before = internalMoney(w);
  const firstTx = w.transactions[w.transactions.length - 1].id;
  const rel0 = JSON.stringify(people(w).map((c) => Object.values(c.relationships).map((r) => Math.round(r.affinity))));
  advance(w, 7 * 1440);
  // Money only enters and leaves through recorded flows, whatever the agents did.
  let net = 0;
  for (const t of w.transactions) {
    if (t.id <= firstTx) continue;
    if (t.from.startsWith("x:") && !t.to.startsWith("x:")) net += t.amount;
    if (!t.from.startsWith("x:") && t.to.startsWith("x:")) net -= t.amount;
  }
  assert.ok(Math.abs(internalMoney(w) - before - net) < 0.5, "money conserved");
  for (const c of people(w)) assert.ok(c.money >= -0.001 && Number.isFinite(c.money));
  const roster = societyWorld(w).roster.map((id) => w.citizens[id]);
  const all = roster.flatMap((c) => societyOf(w, c).decisions);
  const kinds = new Set(all.map((d) => d.action.type));
  assert.ok(kinds.size >= 5, `only ${[...kinds].join(", ")}`);
  assert.ok(all.every((d) => d.status !== "pending" || w.time - d.t < 1440 * 1.2), "no decision left pending for ever");
  assert.ok(roster.some((c) => societyOf(w, c).projects.length > 0), "someone made a plan");
  assert.ok(roster.some((c) => societyOf(w, c).days.length >= 3), "they keep a record of their days");
  assert.notEqual(JSON.stringify(people(w).map((c) => Object.values(c.relationships).map((r) => Math.round(r.affinity)))), rel0, "relationships moved");
  // The decision log stays bounded.
  for (const c of people(w)) assert.ok(societyOf(w, c).decisions.length <= 30);
});

test("different towns turn out differently", () => {
  const outcome = (seed: number) => {
    const w = newWorld(seed);
    advance(w, 5 * 1440);
    return societyWorld(w).roster.map((id) => societyOf(w, w.citizens[id]).projects.map((p) => `${p.kind}:${p.status}`).join(",")).join("|");
  };
  assert.notEqual(outcome(21), outcome(22));
});

test("agent state saves and loads with the world", () => {
  const a = newWorld(9);
  advance(a, 2 * 1440 + 77);
  const b = prepareLoadedWorld(JSON.parse(JSON.stringify(a)))!;
  assert.deepEqual(b.society, a.society);
  for (const id of a.citizenOrder) assert.deepEqual(b.citizens[id].society, a.citizens[id].society);
  advance(a, 1440);
  advance(b, 1440);
  assert.equal(JSON.stringify(b.society), JSON.stringify(a.society));
});

test("a made-up story gets found out; the liar's name suffers", () => {
  const w = newWorld(10);
  advance(w, 1440 + 10 * 60);
  const [liar, victim, ...rest] = people(w);
  const sw = societyWorld(w);
  sw.rumours.push({ id: 999, t: w.time, origin: liar.id, about: victim.id, text: `${victim.name} has been fiddling the books`, truth: false, heard: 0 });
  for (const c of rest.slice(0, 8)) {
    c.relationships[victim.id] = { ...(c.relationships[victim.id] ?? { roles: [], lastT: w.time }), affinity: 20, familiarity: 80, trust: 20, lastT: w.time } as Citizen["relationships"][string];
    c.relationships[liar.id] = { ...(c.relationships[liar.id] ?? { roles: [], lastT: 0 }), affinity: 20, familiarity: 40, trust: 30 } as Citizen["relationships"][string];
    learn(w, c, { about: victim.id, pred: "said", key: "rumour:999", text: `${victim.name} has been fiddling the books`, source: "rumour", from: liar.id, origin: liar.id, certainty: 0.7, sensitivity: 0.4, valence: -0.6, importance: 6, rumour: 999 });
  }
  const trustBefore = rest.slice(0, 8).reduce((s, c) => s + c.relationships[liar.id].trust, 0);
  for (let d = 0; d < 6; d++) {
    w.time += 1440;
    reputationDaily(w);
  }
  const rm = sw.rumours.find((r) => r.id === 999)!;
  assert.ok((rm.exposed?.length ?? 0) >= 2, `only ${rm.exposed?.length ?? 0} saw through it`);
  assert.ok(rm.outed);
  assert.ok(rest.slice(0, 8).reduce((s, c) => s + c.relationships[liar.id].trust, 0) < trustBefore, "they trust the liar less");
  assert.ok(reputationOf(w, liar).tags.includes("caught telling lies"));
});

test("a couple who can't stand each other any more split up", () => {
  const w = newWorld(12);
  advance(w, 60);
  const [a, b] = people(w);
  for (const [x, y] of [
    [a, b],
    [b, a],
  ] as const) x.relationships[y.id] = { ...(x.relationships[y.id] ?? { lastT: 0 }), roles: ["couple"], affinity: -20, familiarity: 80, trust: 10 } as Citizen["relationships"][string];
  reputationDaily(w);
  assert.ok(!a.relationships[b.id].roles.includes("couple") && !b.relationships[a.id].roles.includes("couple"));
  assert.ok(w.events.some((e) => /split up/.test(e.text)));
});

test("with a model connected, roster agents' decisions come from it (and say so); a broken model hands back to the built-in judgement", async () => {
  const seen: LLMRequest[] = [];
  let broken = false;
  const client: LLMClient = {
    model: "fake",
    free: true,
    label: "Fake",
    async complete(req) {
      seen.push(req);
      const props = (req.schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
      if (broken) throw new Error("model fell over");
      if (props.action && props.intention) return { json: { action: "carry_on", reason: "Nothing doing.", intention: "Keep my head down today." }, inputTokens: 1, outputTokens: 1, model: "fake" };
      return { json: { spoken: "Right then.", intent: "pass time", topic: "x", endConversation: true }, inputTokens: 1, outputTokens: 1, model: "fake" };
    },
  };
  const d = new AIDirector(client, { total: () => 0, add: () => {} }, { maxConcurrent: 2, minIntervalMs: 0, timeoutMs: 5000 });
  d.attach();
  const w = newWorld(13);
  w.ai.mode = "llm";
  w.ai.maxCallsPerDay = 5000;
  const run = async (minutes: number) => {
    for (let i = 0; i < minutes / 5; i++) {
      advance(w, 5);
      await new Promise((r) => setImmediate(r));
      d.pump(w);
      assert.ok(d.pending <= 2, "never more requests out than allowed");
    }
  };
  await run(24 * 60);
  const roster = societyWorld(w).roster;
  const llm = roster.flatMap((id) => societyOf(w, w.citizens[id]).decisions).filter((x) => x.source === "llm");
  assert.ok(llm.length >= 5, `only ${llm.length} decisions by the model`);
  assert.ok(seen.some((r) => /WHAT YOU WANT/.test(r.system)), "decision prompts sent");
  // Off the roster: always the built-in judgement.
  const off = w.citizenOrder.find((id) => !roster.includes(id))!;
  assert.ok(societyOf(w, w.citizens[off]).decisions.every((x) => x.source === "rules"));
  // The model breaks: the built-in judgement carries on for everyone.
  broken = true;
  const t0 = w.time;
  await run(12 * 60);
  const after = roster.flatMap((id) => societyOf(w, w.citizens[id]).decisions).filter((x) => x.t > t0 + 120);
  assert.ok(after.length > 0 && after.some((x) => x.source === "rules"), "the built-in judgement took over");
  assert.ok(w.ai.log.some((l) => l.kind === "decide" && l.status === "error"));
});
