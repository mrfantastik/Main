// The town's brain: a small open-source model running in the page. Its
// prompts, how its replies are read, and how the director uses it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, newWorld } from "../src/sim";
import { AIDirector } from "../src/sim/ai/director";
import type { LLMClient, LLMRequest } from "../src/sim/ai/llm";
import { hourLabel, looksLikeSpeech, readChoice, readDiary, readLines, readPlan, readThought, smallChoicePrompt, smallConversationPrompt, smallThoughtPrompt, withNames } from "../src/sim/ai/small";
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
function fakeBrain(seen: LLMRequest[], opts: { ready?: () => boolean; slow?: () => boolean; pick?: "first" | "last" | "friend" } = {}): LLMClient {
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
      if (p.kind === "plan") {
        // From the first time it was given: the first four things on the list, two and a half hours apart.
        const m = p.prefill.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)/)!;
        const start = (Number(m[1]) % 12) + (m[3] === "pm" ? 12 : 0) + (m[2] ? 0.5 : 0);
        const text = `${p.prefill} 1 - first things first\n${[1, 2, 3].map((k) => `${hourLabel(start + k * 2.5)}: ${k + 1} - then this, obviously`).join("\n")}`;
        return { json: { items: readPlan(text, p.options!, p.labels!) }, inputTokens: 0, outputTokens: 0, model: "brain" };
      }
      if (p.kind === "diary") return { json: { text: readDiary(`${p.prefill} was long, but I got through it. Tomorrow I'll ring Mum.`) }, inputTokens: 0, outputTokens: 0, model: "brain" };
      const friend = p.options?.findIndex((id) => id.startsWith("see:")) ?? -1;
      const json =
        p.kind === "lines"
          ? { lines: readLines(`${p.prefill} Fancy seeing you here!\n${p.names![1]}: I live round the corner, you know.\n${p.names![0]}: Course you do.`, p.names!) }
          : p.kind === "thought"
            ? { thought: readThought("Today feels like a lucky day, for once.", "") }
            : opts.pick === "last"
              ? readChoice(`${p.options!.length}. I fancy a change, honestly.`, p.options!)
              : opts.pick === "friend" && friend >= 0
                ? readChoice(`${friend + 1}. I miss them.`, p.options!)
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
    if (i === 1) {
      assert.ok(seen.some((r) => r.small!.kind === "thought" && r.small!.user.startsWith(`${me.name} (`)), "the person in focus gets a thought straight away");
      assert.ok(w.ai.log.some((l) => l.kind === "thought" && l.status === "ok" && l.citizenId === me.id), "and it's used");
    }
  }
  assert.ok(seen.every((r) => r.small), "every request carries a short prompt");
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

test("with the brain awake, people act on its choices: it picks their next move, and their reason is what they think", async () => {
  const seen: LLMRequest[] = [];
  const d = new AIDirector(fakeBrain(seen, { pick: "last" }), { total: () => 0, add: () => {} }, { maxConcurrent: 1, minIntervalMs: 0, timeoutMs: 5000 });
  d.attach();
  const w = newWorld(93);
  w.ai.mode = "llm";
  w.ai.maxCallsPerDay = 5000;
  advance(w, 8 * 60);
  const me = w.citizens[w.citizenOrder[2]];
  d.focus = me.id;
  await run(w, d, 8 * 60);
  const plans = seen.filter((r) => /After this, what does/.test(r.small!.user));
  assert.ok(plans.length >= 10, `${plans.length} next moves asked for`);
  assert.ok(plans.some((r) => r.small!.user.startsWith(`${me.name} (`)), "the person in focus is asked");
  for (const r of plans) assert.ok(r.small!.options!.length >= 2 && r.small!.options!.length <= 8, "a short list of sensible options (and friends to see)");
  const people = w.citizenOrder.map((id) => w.citizens[id]);
  const byBrain = people.flatMap((c) => c.decisions.filter((x) => x.kind === "activity" && x.source === "llm"));
  assert.ok(byBrain.length >= 8, `${byBrain.length} moves chosen by the brain`);
  assert.ok(new Set(people.filter((c) => c.decisions.some((x) => x.source === "llm")).map((c) => c.id)).size >= 5, "not just the person in focus");
  assert.ok(me.decisions.some((x) => x.source === "llm"), "the person in focus acts on it");
  // Moves are the brain's pick (with its reason) or the next thing on the plan it wrote them for the day (with the plan's reason).
  assert.ok(byBrain.every((x) => x.thought === "I fancy a change, honestly." || /^(First things first|Then this, obviously)\.$/.test(x.thought)), "their reason is the brain's");
  assert.ok(byBrain.filter((x) => x.thought === "I fancy a change, honestly.").length >= 5, "picks made while they were busy");
  assert.ok(byBrain.some((x) => x.chosen !== x.options[0].id), "and it isn't always what the utility AI would have picked");
  assert.ok(people.some((c) => c.thoughtSource === "llm" && c.thought === "I fancy a change, honestly."), "what they think now");
  assert.ok(d.tally.plan + d.tally.followed >= byBrain.length, "counted");
  assert.ok(w.ai.log.some((l) => l.kind === "plan" && l.status === "ok" && /next: "I fancy a change/.test(l.note)), "in the AI log");
  // Still a working town: the brain's whims don't leave more people starving or worn out than the utility AI does.
  const plain = newWorld(93);
  advance(plain, 16 * 60);
  const worn = (ws: WorldState) => ws.citizenOrder.map((id) => ws.citizens[id]).filter((c) => c.needs.hunger < 10 || c.needs.energy < 5).length;
  assert.ok(worn(w) <= worn(plain) + 2, `${worn(w)} worn out with the brain, ${worn(plain)} without`);
});

test("the brain's pick is dropped when it no longer makes sense, or comes too late", async () => {
  const seen: LLMRequest[] = [];
  const d = new AIDirector(fakeBrain(seen, { pick: "last" }), { total: () => 0, add: () => {} }, { maxConcurrent: 1, minIntervalMs: 0, timeoutMs: 5000 });
  d.attach();
  const w = newWorld(94);
  w.ai.mode = "llm";
  w.ai.maxCallsPerDay = 5000;
  advance(w, 9 * 60);
  await run(w, d, 4 * 60);
  // Every brain-made move was one of the options it was offered, and still sensible when it was taken.
  for (const c of w.citizenOrder.map((id) => w.citizens[id]))
    for (const x of c.decisions.filter((r) => r.source === "llm")) {
      const chosen = x.options.find((o) => o.id === x.chosen)!;
      assert.ok(chosen, "a real option");
      if (x.chosen.startsWith("see:")) continue; // going to see a friend isn't scored
      assert.ok(chosen.score >= x.options[0].score - 2.21, `${c.name}: ${chosen.label} (${chosen.score}) vs ${x.options[0].label} (${x.options[0].score})`);
    }
});

test("reading a plan for the day: times, numbers or words, in order", () => {
  const ids = ["work_corp", "eat_diner", "pub", "see:c4"];
  const labels = ["Go to work at CityCorp", "Eat at City Diner (£7)", "Have a drink at the pub", "Meet up with Priya"];
  const text = "8am: 1 - rent's due Friday\n12:30pm - 2: starving by then\n3pm: work again\n6 pm: drink at the pub - it's Friday!\n7pm: 4\nThat's the plan.\n9pm: 3";
  assert.deepEqual(readPlan(text, ids, labels), [
    { hour: 8, id: "work_corp", why: "rent's due Friday" },
    { hour: 12.5, id: "eat_diner", why: "starving by then" },
    { hour: 15, id: "work_corp", why: "work again" },
    { hour: 18, id: "pub", why: "drink at the pub - it's Friday!" },
    { hour: 19, id: "see:c4", why: "" },
  ]);
  assert.deepEqual(readPlan("1: 2 - lunch\n11am: 1 - too early", ids, labels).map((x) => x.hour), [13], "1 means 1pm; going back in time is ignored");
  assert.deepEqual(readPlan("Sure! Here is the plan.", ids, labels), []);
  assert.equal(hourLabel(13.5), "1:30pm");
  assert.equal(readDiary("Today was fine. I sold two pies. And then..."), "Today was fine. I sold two pies.");
});

test("each citizen is an agent: it plans its day, follows the plan, and writes a diary it reads back the next day", async () => {
  const seen: LLMRequest[] = [];
  const d = new AIDirector(fakeBrain(seen), { total: () => 0, add: () => {} }, { maxConcurrent: 1, minIntervalMs: 0, timeoutMs: 5000 });
  d.attach();
  const w = newWorld(95);
  w.ai.mode = "llm";
  w.ai.maxCallsPerDay = 50000;
  advance(w, 12 * 60);
  const me = w.citizens[w.citizenOrder[4]];
  d.focus = me.id;
  await run(w, d, 42 * 60); // to the middle of the day after next
  const people = w.citizenOrder.map((id) => w.citizens[id]);
  const dayPlans = seen.filter((r) => r.small!.kind === "plan");
  assert.ok(dayPlans.length >= 15, `${dayPlans.length} day plans asked for`);
  for (const r of dayPlans.slice(0, 5)) {
    assert.match(r.small!.user, /Things \w+ could do today:\n1\. /);
    assert.ok(r.small!.options!.length >= 3 && r.small!.options!.length <= 11);
  }
  const planned = people.filter((c) => c.agent?.plan);
  assert.ok(planned.length >= 15, `${planned.length} of 20 have a plan`);
  assert.ok(me.agent?.plan, "the person in focus has one");
  const followed = people.flatMap((c) => c.decisions.filter((x) => x.source === "llm" && x.thought === "Then this, obviously."));
  assert.ok(followed.length >= 10, `${followed.length} moves made from their own plans`);
  assert.ok(d.tally.followed >= followed.length && d.tally.dayplan >= 15);
  const done = people.flatMap((c) => c.agent?.plan?.items ?? []).filter((i) => i.status === "done").length;
  assert.ok(done >= 10, `${done} plan items ticked off`);
  // Diaries, at night, and read back the next day.
  const diarists = people.filter((c) => c.agent?.diary.length);
  assert.ok(diarists.length >= 15, `${diarists.length} wrote a diary`);
  assert.equal(diarists[0].agent!.diary[0].text, "Today was long, but I got through it. Tomorrow I'll ring Mum.");
  assert.ok(seen.some((r) => r.small!.kind === "plan" && r.small!.user.includes('From their diary: "Today was long')), "the diary is read back when planning the next day");
  assert.ok(d.tally.diary >= diarists.length, "counted");
});

test("an agent can choose to go and see a friend, and they talk", async () => {
  const seen: LLMRequest[] = [];
  const d = new AIDirector(fakeBrain(seen, { pick: "friend" }), { total: () => 0, add: () => {} }, { maxConcurrent: 1, minIntervalMs: 0, timeoutMs: 5000 });
  d.attach();
  const w = newWorld(96);
  w.ai.mode = "llm";
  w.ai.maxCallsPerDay = 50000;
  advance(w, 2 * 1440 + 9 * 60); // two days in, so people have friends
  const before = new Set(w.conversationLog.map((c) => c.id));
  await run(w, d, 10 * 60);
  const people = w.citizenOrder.map((id) => w.citizens[id]);
  const visits = people.flatMap((c) => c.decisions.filter((x) => x.source === "llm" && x.chosen.startsWith("see:")).map((x) => ({ c, x })));
  assert.ok(visits.length >= 3, `${visits.length} visits to friends`);
  for (const { c, x } of visits) assert.ok(c.relationships[x.chosen.slice(4)]?.affinity > 15, "only people they like");
  const chats = w.conversationLog.filter((cv) => !before.has(cv.id) && visits.some(({ c, x }) => cv.a === c.id && cv.b === x.chosen.slice(4)));
  assert.ok(chats.length >= 1, `${chats.length} of those visits ended in a chat`);
});
