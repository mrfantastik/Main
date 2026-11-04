// Personalities, emotions, emotional memory and nightly reflection.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, newWorld } from "../src/sim";
import { remember } from "../src/sim/memory/memory";
import { dominantEmotion, emotionTargets, feel, feelingsToward, moodFromEmotions, neutralEmotions, recallPerson, settleEmotions, stanceToward } from "../src/sim/mind/emotions";
import { generatePersonality } from "../src/sim/mind/personality";
import { draftReflections, learn, nightlyReflection } from "../src/sim/mind/reflection";
import { inVoice, memoryCallback } from "../src/sim/mind/voice";
import { prepareLoadedWorld } from "../src/sim/migrate";
import { loanTerms } from "../src/sim/social/negotiation";
import { getRel } from "../src/sim/social/relationships";
import { dayOf } from "../src/sim/time";
import type { Citizen, WorldState } from "../src/sim/types";

function two(w: WorldState): [Citizen, Citizen] {
  return [w.citizens[w.citizenOrder[0]], w.citizens[w.citizenOrder[1]]];
}

test("every citizen gets a full, seed-stable personality", () => {
  const a = newWorld(51);
  const b = newWorld(51);
  for (const id of a.citizenOrder) {
    const p = a.citizens[id].personality;
    assert.ok(p.values.length >= 2 && p.values.length <= 3, "2-3 values");
    assert.equal(p.quirks.length, 2);
    assert.ok(p.likes.length >= 2 && p.dislikes.length === 2);
    assert.ok(p.fear && p.dream && p.backstory.startsWith(a.citizens[id].name));
    for (const v of Object.values(p.big5)) assert.ok(v >= 0 && v <= 1);
    assert.deepEqual(p, b.citizens[id].personality, "same seed, same person");
  }
  const styles = new Set(a.citizenOrder.map((id) => a.citizens[id].personality.style));
  assert.ok(styles.size >= 3, `only ${styles.size} speaking styles in a town of 20`);
});

test("personality follows the economic traits it's built from", () => {
  const w = newWorld(52);
  const people = w.citizenOrder.map((id) => w.citizens[id]);
  const corr = (xs: number[], ys: number[]) => {
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let n = 0, dx = 0, dy = 0;
    for (let i = 0; i < xs.length; i++) {
      n += (xs[i] - mx) * (ys[i] - my);
      dx += (xs[i] - mx) ** 2;
      dy += (ys[i] - my) ** 2;
    }
    return n / Math.sqrt(dx * dy);
  };
  assert.ok(corr(people.map((c) => c.traits.sociability), people.map((c) => c.personality.big5.extraversion)) > 0.7, "sociable people are extraverts");
  assert.ok(corr(people.map((c) => c.traits.generosity), people.map((c) => c.personality.big5.agreeableness)) > 0.5, "generous people are agreeable");
});

test("emotions decay towards their target, at different speeds", () => {
  const w = newWorld(53);
  const [c] = two(w);
  const targets = { ...neutralEmotions(), anger: 2, love: 10 };
  c.emotions.anger = 90;
  c.emotions.love = 90;
  for (let h = 0; h < 6; h++) settleEmotions(c, targets);
  assert.ok(c.emotions.anger < 45, `anger should cool within hours (${c.emotions.anger.toFixed(1)})`);
  assert.ok(c.emotions.love > 70, `love should linger (${c.emotions.love.toFixed(1)})`);
  for (let h = 0; h < 200; h++) settleEmotions(c, targets);
  assert.ok(Math.abs(c.emotions.anger - 2) < 1 && Math.abs(c.emotions.love - 10) < 3, "both settle at the target");
  assert.equal(c.mood, moodFromEmotions(c.emotions), "mood is derived from emotions");
});

test("neuroticism amplifies bad news; loneliness targets follow social needs", () => {
  const w = newWorld(54);
  const [a, b] = two(w);
  a.personality.big5.neuroticism = 0.9;
  b.personality.big5.neuroticism = 0.1;
  a.emotions = neutralEmotions();
  b.emotions = neutralEmotions();
  feel(a, { fear: 20 });
  feel(b, { fear: 20 });
  assert.ok(a.emotions.fear - 8 > (b.emotions.fear - 8) * 1.8, "the worrier is hit much harder");
  a.needs.social = 5;
  b.needs.social = 95;
  const circ = { wellbeing: 60, pressure: 0, closeBonds: 1, doingWell: false };
  assert.ok(emotionTargets(a, circ).loneliness > emotionTargets(b, circ).loneliness + 20);
});

test("events change feelings: betrayal brings anger, help brings gratitude", () => {
  const w = newWorld(55);
  const [a, b] = two(w);
  a.emotions = neutralEmotions();
  const m = remember(w, a, { text: `${b.name} betrayed me: never paid back the £60 I lent them.`, kind: "betrayal", importance: 9, valence: -1, people: [b.id] });
  assert.ok(a.emotions.anger > 25, `anger ${a.emotions.anger}`);
  assert.ok((m.emotions?.anger ?? 0) > 20, "the memory keeps the anger it caused");
  const c = w.citizens[w.citizenOrder[2]];
  c.emotions = neutralEmotions();
  remember(w, c, { text: `${b.name} gave me £30 when I was broke.`, kind: "favor", importance: 7, valence: 0.9, people: [b.id] });
  assert.ok(c.emotions.gratitude > 20 && c.emotions.joy > 25);
});

test("grudges persist: meeting someone brings the feelings back and hardens deals", () => {
  const w = newWorld(56);
  advance(w, 60);
  const [lender, borrower] = two(w);
  lender.money = 800;
  const before = loanTerms(w, borrower, lender, 50, "rent");
  remember(w, lender, { text: `${borrower.name} cheated me out of £40 at the market.`, kind: "betrayal", importance: 9, valence: -1, people: [borrower.id] });
  lender.emotions.anger = 2; // the moment has passed...
  recallPerson(w, lender, borrower.id); // ...until they see them again
  assert.ok(lender.emotions.anger > 5, "seeing them brings the anger back");
  assert.ok((feelingsToward(lender, borrower.id).anger ?? 0) > 15);
  assert.ok(stanceToward(lender, borrower.id).toughness > 0.1);
  const after = loanTerms(w, borrower, lender, 50, "rent");
  assert.ok(after.minRate > before.minRate, `angry lender wants more interest (${before.minRate} -> ${after.minRate})`);
});

test("gratitude makes people generous to whoever helped them", () => {
  const w = newWorld(57);
  advance(w, 60);
  const [lender, borrower] = two(w);
  lender.money = 600;
  const before = loanTerms(w, borrower, lender, 80, "rent");
  remember(w, lender, { text: `${borrower.name} lent me money when I needed it.`, kind: "favor", importance: 8, valence: 0.9, people: [borrower.id] });
  const after = loanTerms(w, borrower, lender, 80, "rent");
  assert.ok(after.maxLend >= before.maxLend && after.minRate <= before.minRate);
  const agree = memoryCallback(lender, borrower, "agree", "x") ?? "";
  assert.match(agree, /helped me out|what you did for me/, "they bring it up when agreeing");
  assert.doesNotMatch(agree, /Day \d/, "people don't say 'Day 12' out loud");
  assert.match(memoryCallback(lender, borrower, "agree", "x", dayOf(w.time)) ?? "", /today/, "same-day favours are 'today', not 'Day 1'");
});

test("nightly reflection turns a bad day with someone into a lesson that changes trust", () => {
  const w = newWorld(58);
  advance(w, 60);
  const [a, b] = two(w);
  remember(w, a, { text: `${b.name} lied to me about the price.`, kind: "deal", importance: 7, valence: -0.8, people: [b.id] });
  remember(w, a, { text: `${b.name} undercut me again.`, kind: "business", importance: 6, valence: -0.7, people: [b.id] });
  const drafts = draftReflections(w, a);
  const person = drafts.find((d) => d.kind === "person");
  assert.ok(person, "a lesson about the person");
  assert.match(person!.text, new RegExp(`${b.name} (always lets me down|can't be trusted)|watch myself around ${b.name}`));
  const trustBefore = getRel(a, b.id).trust;
  learn(w, a, person!);
  assert.ok(getRel(a, b.id).trust < trustBefore, "trust drops");
  assert.ok(a.reflections.some((r) => r.key === person!.key));
});

test("reflection happens once a night while asleep, and lessons stick", () => {
  const w = newWorld(59);
  advance(w, 1440 * 6);
  const learned = w.citizenOrder.reduce((n, id) => n + w.citizens[id].reflections.length, 0);
  assert.ok(learned > 0, "people learned something over a week");
  const c = w.citizens[w.citizenOrder[0]];
  const day = c.lastReflectionDay;
  nightlyReflection(w); // same night/day: nothing new
  assert.equal(c.lastReflectionDay, day);
  for (const id of w.citizenOrder) for (const r of w.citizens[id].reflections) assert.ok(r.text.length > 5 && r.strength > 0);
});

test("speech follows speaking style and mood", () => {
  const w = newWorld(60);
  const [a, b] = two(w);
  a.emotions = neutralEmotions();
  a.personality.style = "formal";
  assert.equal(inVoice(a, "I can't do that, I'm skint.", "s1", b), "I cannot do that, I am skint.");
  a.personality.style = "blunt";
  assert.equal(inVoice(a, "I hate to ask, but could you lend me £20? It's for rent.", "s2", b).includes("I hate to ask"), false);
  a.emotions.anger = 90;
  assert.equal(dominantEmotion(a)?.emotion, "anger");
  assert.ok(inVoice(a, "No.", "s3", b).endsWith("!"), "anger raises the voice");
});

test("styled lines and thoughts stay well-formed", () => {
  const w = newWorld(63);
  const lines = new Set<string>();
  for (let m = 0; m < 1440 * 10; m += 30) {
    advance(w, 30);
    for (const id of w.citizenOrder) lines.add(w.citizens[id].thought);
  }
  for (const cv of w.conversationLog) for (const l of cv.lines) lines.add(l.text);
  assert.ok(lines.size > 200);
  for (const t of lines) {
    assert.doesNotMatch(t, /(?<!\.)[.!?] [a-z]/, "sentences start with a capital");
    assert.doesNotMatch(t, /[^.]\.\.(?!\.)/, "no doubled full stops");
    assert.doesNotMatch(t, /\?(,| (Shocking|Who'd|Lovely|Anyway|Must be nice|Not bad))/, "no tags hung on a question");
  }
});

test("old saves get personalities, calm emotions and keep running", () => {
  const w = newWorld(61);
  advance(w, 1440);
  const raw = JSON.parse(JSON.stringify(w));
  for (const id of raw.citizenOrder) {
    delete raw.citizens[id].personality;
    delete raw.citizens[id].emotions;
    delete raw.citizens[id].reflections;
    delete raw.citizens[id].lastReflectionDay;
    for (const m of [...raw.citizens[id].memories.long, ...raw.citizens[id].memories.short]) delete m.emotions;
  }
  const loaded = prepareLoadedWorld(raw)!;
  assert.ok(loaded);
  for (const id of loaded.citizenOrder) {
    const c = loaded.citizens[id];
    assert.deepEqual(c.personality, generatePersonality(loaded.seed, c), "generated deterministically");
    assert.equal(c.emotions.joy, neutralEmotions().joy);
    assert.deepEqual(c.reflections, []);
  }
  advance(loaded, 1440 * 2);
  for (const id of loaded.citizenOrder) assert.ok(Number.isFinite(loaded.citizens[id].mood));
});

test("emotions stay deterministic: same seed, same feelings", () => {
  const a = newWorld(62);
  const b = newWorld(62);
  advance(a, 1440 * 3);
  advance(b, 1440 * 3);
  for (const id of a.citizenOrder) {
    assert.deepEqual(a.citizens[id].emotions, b.citizens[id].emotions);
    assert.deepEqual(a.citizens[id].reflections, b.citizens[id].reflections);
    assert.equal(a.citizens[id].thought, b.citizens[id].thought);
  }
});
