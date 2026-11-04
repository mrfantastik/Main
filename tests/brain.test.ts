// The town's brain: a small open-source model running in the page. Its
// prompts, how its replies are read, and how the director uses it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, newWorld } from "../src/sim";
import { AIDirector } from "../src/sim/ai/director";
import type { LLMClient, LLMRequest } from "../src/sim/ai/llm";
import { hourLabel, looksLikeSpeech, readChoice, readDiary, readLines, readPlan, readThought, readTurn, smallChoicePrompt, smallThoughtPrompt, withNames } from "../src/sim/ai/small";
import { beginDialogue, builtInTurn, endDialogue, modelRequest, planTurn, recordLine } from "../src/sim/dialogue";
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

test("small prompts: a thought, a choice, names for A and B", () => {
  const w = newWorld(90);
  advance(w, 600);
  const conv = chat(w, 0, 1);
  const [a, b] = [w.citizens[conv.a], w.citizens[conv.b]];
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
      if (p.kind === "turn") {
        // A line of its own each time, as the person whose turn it is (the other's name shows it was meant for them).
        const n = seen.filter((r) => r.small?.kind === "turn").length;
        const them = p.names![1];
        const cue = p.messages?.at(-1)?.content ?? p.user;
        const said = [`${them}, you'll never guess what I saw this morning.`, `Honestly, ${them}, the queue at the bank was a joke.`, `${them}, have you tried the pies at the diner?`, `I'm not so sure about that, ${them}.`, `Go on then, ${them}, tell me more.`, `That's the funniest thing I've heard all week, ${them}.`, `My feet are killing me, ${them}.`, `Rent's due Friday and I'm dreading it, ${them}.`, `Did you see the rain earlier, ${them}?`, `I've been meaning to ask you something, ${them}.`, `Mad week, ${them}. Mad.`];
        const line = /\bbye\b/i.test(cue) ? `Right, I'd better go. Bye, ${them}!` : said[n % said.length];
        return { json: { line: readTurn(`${p.prefill} ${line}`, p.names![0], p.names![1]) }, inputTokens: 0, outputTokens: 0, model: "brain" };
      }
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
  // Live chats: each of them speaks for themselves, a line at a time, taking turns, and they say goodbye.
  const voiced = [...seenConvs.values()].filter((c) => c.source === "llm" && c.live);
  assert.ok(voiced.length >= 3, `only ${voiced.length} conversations spoken live`);
  for (const c of voiced) {
    const name = (id: string) => w.citizens[id].name;
    if (c.group) {
      // A group: each pair takes turns; the brain's lines in a pair's exchange are said to the other one.
      const g = c.group;
      assert.equal(g.turns.length, c.lines.length, "every line is a group turn");
      for (const p of g.pairs) p.lines.forEach((l, i) => i && assert.notEqual(l.speaker, p.lines[i - 1].speaker, "each pair takes turns"));
      c.lines.forEach((l, i) => {
        const t = g.turns[i];
        if (t.by === "llm" && t.move === "pair" && t.to) assert.ok(l.text.includes(name(t.to)), `said to the one they're talking to: "${l.text}"`);
      });
      assert.ok(g.turns.filter((t) => t.by === "llm").length >= c.lines.length - 3, "the brain wrote (nearly) all of it");
      continue;
    }
    assert.equal(c.lines[0].speaker, c.a, "whoever started it speaks first");
    assert.ok(c.lines.length >= 3, `a real exchange (${c.lines.length} lines)`);
    assert.equal(c.dlg!.turns.length, c.lines.length, "every line is a planned turn");
    c.lines.forEach((l, i) => {
      if (i) assert.notEqual(l.speaker, c.lines[i - 1].speaker, "they take turns");
      // The brain's lines are said to the other one; a turn it couldn't write is the built-in voice's.
      if (c.dlg!.turns[i].by === "llm") assert.ok(l.text.includes(name(l.speaker === c.a ? c.b : c.a)), `each line is said to the other one: "${l.text}"`);
    });
    assert.ok(c.dlg!.turns.filter((t) => t.by === "llm").length >= c.lines.length - 2, "the brain wrote (nearly) all of it");
  }
  assert.ok(voiced.some((c) => /\bBye\b/.test(c.lines[c.lines.length - 1].text)), "and they say goodbye");
  assert.ok(
    seen.some((r) => r.small!.kind === "turn" && (r.small!.messages?.length ?? 0) >= 3 && r.small!.messages!.some((m) => m.role === "assistant")),
    "each turn is a real chat: what the other said, and what they've said themselves",
  );
  assert.ok(!w.ai.log.some((l) => l.kind === "reflection"), "lessons aren't reworded by a small model");
  assert.match(d.invent(w) ?? "", /bigger AI/);
});

test("each citizen is their own chatbot: their character card, how they are, who they're with, and the chat so far", async () => {
  const { botCard, defaultCard, saveCard } = await import("../src/sim/mind/bot");
  const w = newWorld(90);
  advance(w, 600);
  const conv = chat(w, 0, 1);
  const [a, b] = [w.citizens[conv.a], w.citizens[conv.b]];
  beginDialogue(w, conv, a, b);
  const card = botCard(a);
  assert.equal(card.custom, false);
  assert.ok(card.examples.length >= 3 && card.bio.length > 20 && card.voice && card.cares && card.secret, "a full card, made from their personality");
  assert.notDeepEqual(defaultCard(a).examples, defaultCard(b).examples, "everyone's different");
  const d = planTurn(w, conv, a.id)!;
  const open = modelRequest(w, conv, a.id, d, true).small!;
  assert.equal(open.kind, "turn");
  assert.match(open.system, new RegExp(`^You are ${a.name}, talking with ${b.name}`), "the system prompt is theirs");
  assert.ok(open.system.includes(card.bio), "their own character card");
  assert.match(open.system, /How you sound: "/, "with the way they talk");
  assert.equal(open.messages![0].role, "user");
  assert.ok(open.messages!.at(-1)!.content.includes(d.hint), "this turn's plan is the cue");
  // Their line, then the other's turn: what was said comes as the other person's words.
  const t1 = builtInTurn(w, conv, a.id, d);
  recordLine(w, conv, a.id, d, t1.text, t1.meta, t1.extras);
  const d2 = planTurn(w, conv, b.id)!;
  const reply = modelRequest(w, conv, b.id, d2, true).small!;
  assert.match(reply.messages![0].content, new RegExp(`${a.name}: ${t1.text.replace(/[.?*+()[\]]/g, "\\$&")}`), "the other person speaks as the user");
  assert.ok(!reply.system.includes(d.hint) && !reply.user.includes(d.hint), "and nobody sees what the other one privately meant to do");
  const t2 = builtInTurn(w, conv, b.id, d2);
  recordLine(w, conv, b.id, d2, t2.text, t2.meta, t2.extras);
  const mine = modelRequest(w, conv, a.id, planTurn(w, conv, a.id)!, true).small!;
  assert.deepEqual(mine.messages!.filter((m) => m.role === "assistant").map((m) => m.content), [t1.text], "their own lines are theirs");
  // The player's version of them, and their settings.
  saveCard(a, { instructions: "Always brings up football.", creativity: 1, chattiness: 0, examples: ["Up the Town!", "  "] });
  const custom = modelRequest(w, conv, a.id, planTurn(w, conv, a.id)!, true).small!;
  assert.match(custom.system, /Also: Always brings up football\./);
  assert.match(custom.system, /"Up the Town!"/);
  assert.match(custom.system, /a few words/);
  assert.equal(custom.temperature, 1);
  assert.ok(botCard(a).custom && botCard(a).examples.length === 1, "blank example lines are dropped");
  saveCard(a, null);
  assert.equal(botCard(a).custom, false, "and back to how they were");
  // They remember how their last chat went, next time.
  conv.revealed = conv.lines.length;
  endDialogue(w, conv);
  const next = chat(w, 0, 1);
  next.id = 100;
  beginDialogue(w, next, a, b);
  assert.match(modelRequest(w, next, a.id, planTurn(w, next, a.id)!, true).small!.system, /Last time you talked \(/);
  assert.ok(open.system.length < 2600, `short enough for a small model (${open.system.length} chars)`);
});

test("reading one line of a live chat: just what they say, as them", () => {
  assert.equal(readTurn("Mike: Alright, Sarah? You look done in.\nSarah: Cheers.", "Mike", "Sarah"), "Alright, Sarah? You look done in.");
  assert.equal(readTurn('Mike: "Not bad, thanks." *smiles* Sarah: You?', "Mike", "Sarah"), "Not bad, thanks.");
  assert.equal(readTurn("Mike: (laughs) Go on then. One more. And then I'm off. Honest.", "Mike", "Sarah"), "Go on then. One more. And then I'm off.");
  assert.equal(readTurn("Mike: <|im_end|>", "Mike", "Sarah"), "");
  assert.equal(readTurn("Mike: As an AI language model, I can't.", "Mike", "Sarah"), "");
  assert.equal(readTurn("Mike: Hello! How can I help you today?", "Mike", "Sarah"), "", "not a chatbot talking to its user");
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
  const convPrompts = seen.filter((r) => r.small!.kind === "turn");
  const focusName = w.citizens[d.focus].name;
  assert.ok(convPrompts.length > 0, "the chats you're watching are spoken");
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

test("on a graphics card the brain works for several people at once, and gets to more of the town", async () => {
  const measure = async (parallel: number) => {
    let inFlight = 0;
    let most = 0;
    const seen: LLMRequest[] = [];
    const inner = fakeBrain(seen);
    const brain: LLMClient = {
      ...inner,
      parallel: () => parallel,
      async complete(req) {
        most = Math.max(most, ++inFlight);
        // Replies take a few game minutes of real time, like the real thing.
        await new Promise((r) => setTimeout(r, 12));
        inFlight--;
        return inner.complete(req);
      },
    };
    const d = new AIDirector(brain, { total: () => 0, add: () => {} }, { maxConcurrent: 1, minIntervalMs: 0, timeoutMs: 5000 });
    d.attach();
    const w = newWorld(97);
    w.ai.mode = "llm";
    w.ai.maxCallsPerDay = 50000;
    advance(w, 7 * 60);
    for (let i = 0; i < 160; i++) {
      advance(w, 3);
      await new Promise((r) => setTimeout(r, 3));
      d.pump(w);
    }
    const moves = w.citizenOrder.flatMap((id) => w.citizens[id].decisions.filter((x) => x.kind === "activity" && x.t > 7 * 60 + 360 + 60));
    return { most, asked: seen.length, share: moves.filter((x) => x.source === "llm").length / Math.max(1, moves.length) };
  };
  const one = await measure(1);
  const four = await measure(4);
  assert.equal(one.most, 1);
  assert.ok(four.most >= 3, `up to ${four.most} at once`);
  assert.ok(four.asked > one.asked * 1.5, `${four.asked} requests vs ${one.asked}`);
  assert.ok(four.share >= one.share, `${Math.round(four.share * 100)}% of moves from the brain vs ${Math.round(one.share * 100)}%`);
});
