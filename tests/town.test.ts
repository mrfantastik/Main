// Town happenings, news spreading by word of mouth, improvised conversations,
// and invented events.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, newWorld } from "../src/sim";
import { AIDirector } from "../src/sim/ai/director";
import type { LLMClient, LLMRequest } from "../src/sim/ai/llm";
import { applyInvented, inventableKinds, inventPrompt } from "../src/sim/ai/unscripted";
import { applyGodCommand } from "../src/sim/god";
import { prepareLoadedWorld } from "../src/sim/migrate";
import { applyNotes, improvise } from "../src/sim/social/improv";
import { businessFactor, createHappening, happeningById, knows, learnNews, townDemand } from "../src/sim/town/happenings";
import type { Citizen, Conversation, Happening, WorldState } from "../src/sim/types";

const people = (w: WorldState): Citizen[] => w.citizenOrder.map((id) => w.citizens[id]);

/** Skip to a time of day (some happenings only happen in certain hours). */
function at(w: WorldState, day: number, hour: number): void {
  const want = day * 1440 + hour * 60;
  if (want > w.time) advance(w, want - w.time);
}

function happen(w: WorldState, kind: Happening["kind"], opts: Parameters<typeof createHappening>[2] = {}): Happening {
  const h = createHappening(w, kind, { source: "god", ...opts });
  assert.equal(typeof h, "object", `couldn't make a ${kind} happen: ${h as string}`);
  return h as Happening;
}

function chat(w: WorldState, a: Citizen, b: Citizen, id: number): Conversation {
  return { id, a: a.id, b: b.id, topic: "chat", buildingId: a.insideId, startedT: w.time, lines: [], revealed: 0, nextRevealT: w.time, status: "talking", agenda: {}, terms: {}, outcome: null, fallback: null, summary: "", source: "template", endT: w.time + 30 };
}

test("happenings come along on their own, deterministically, and the news spreads", () => {
  const run = () => {
    const w = newWorld(61);
    advance(w, 1440 * 10);
    return w;
  };
  const a = run();
  const b = run();
  const sig = (w: WorldState) => w.happenings.map((h) => `${h.t}:${h.kind}:${h.title}`);
  assert.deepEqual(sig(a), sig(b), "same seed, same happenings");
  assert.ok(a.happenings.length >= 4, `only ${a.happenings.length} happenings in 10 days`);
  assert.ok(new Set(a.happenings.map((h) => h.kind)).size >= 3, "a mix of kinds");
  // Word of mouth: plenty of people heard about things from someone else.
  const told = people(a).flatMap((c) => c.news).filter((k) => a.citizens[k.via]);
  assert.ok(told.length >= 10, `only ${told.length} pieces of news passed on in conversation`);
  for (const c of people(a)) for (const k of c.news) assert.ok(k.stance >= -1 && k.stance <= 1, "stance stays in range");
});

test("a fire shuts the business and burns stock until it reopens", () => {
  const w = newWorld(62);
  at(w, 1, 10);
  const b = w.businessOrder.map((id) => w.businesses[id]).find((x) => x.open && x.kind !== "agency")!;
  const stock = Object.values(b.inventory).reduce((s, it) => s + it.qty, 0);
  const h = happen(w, "fire", { businessId: b.id });
  assert.equal(h.businessId, b.id, "the named business is the one on fire");
  assert.equal(businessFactor(w, b).capacity, 0, "can't trade while it's shut");
  assert.ok(Object.values(b.inventory).reduce((s, it) => s + it.qty, 0) <= stock, "stock went up in smoke");
  const owner = w.citizens[b.ownerId];
  assert.equal(knows(owner, h.id)?.via, "self", "the owner knows first-hand");
  assert.ok(owner.memories.long.concat(owner.memories.short).some((m) => /caught fire/.test(m.text)), "and remembers it");
  advance(w, h.until - w.time + 60);
  assert.ok(happeningById(w, h.id)?.ended, "it's over");
  assert.equal(businessFactor(w, b).capacity, 1, "trading again");
  assert.ok(w.events.some((e) => e.text.includes(`${b.name} reopened`)), "the reopening is in the feed");
});

test("burglaries and lottery wins move real money through the ledger", () => {
  const w = newWorld(63);
  at(w, 1, 11);
  const victim = people(w).find((c) => c.money >= 60 && c.homeId && !c.homeless)!;
  const before = victim.money;
  const theft = happen(w, "burglary", { subject: victim.id });
  assert.equal(theft.subject, victim.id);
  assert.ok(Math.abs(before - theft.amount - victim.money) < 0.01, "the stolen amount left their pocket");
  assert.ok(w.transactions.some((t) => t.kind === "theft" && t.amount === theft.amount), "recorded as theft");

  const lucky = people(w)[3];
  const had = lucky.money;
  const win = happen(w, "lottery", { subject: lucky.id });
  assert.equal(win.subject, lucky.id);
  assert.ok(Math.abs(lucky.money - had - win.amount) < 0.01, "the prize arrived");
  assert.ok(w.transactions.some((t) => t.kind === "prize" && t.amount === win.amount), "recorded as a prize");
});

test("storms and power cuts keep shoppers in; market stalls trade through a power cut", () => {
  const w = newWorld(64);
  at(w, 0, 12); // before the first happening of the run
  assert.equal(townDemand(w), 1);
  happen(w, "storm");
  assert.ok(townDemand(w) < 1, "fewer shoppers in a storm");
  happen(w, "power_cut");
  for (const id of w.businessOrder) {
    const b = w.businesses[id];
    assert.equal(businessFactor(w, b).capacity, b.kind === "stall" ? 1 : 0, `${b.name} (${b.kind})`);
  }
  // Only one of each at a time.
  assert.equal(typeof createHappening(w, "storm", { source: "god" }), "string");
});

test("God mode can make things happen, and refuses what can't", () => {
  const w = newWorld(65);
  at(w, 1, 3);
  assert.throws(() => applyGodCommand(w, { cmd: "happening", kind: "festival" }), /between/);
  at(w, 1, 10);
  const msg = applyGodCommand(w, { cmd: "happening", kind: "festival" });
  assert.match(msg, /festival/i);
  const h = w.happenings[w.happenings.length - 1];
  assert.equal(h.source, "god");
  assert.equal(people(w).filter((c) => knows(c, h.id)).length, 20, "everyone hears about the festival");
});

test("improvised chats pass news on, and the listener makes up their own mind", () => {
  const w = newWorld(66);
  at(w, 1, 12);
  const [teller, listener, winner] = people(w).slice(0, 3);
  for (const c of [teller, listener]) c.activity.kind = "socialize";
  const h = happen(w, "lottery", { subject: winner.id });
  learnNews(w, teller, h, "saw");
  listener.news = listener.news.filter((k) => k.id !== h.id);
  let told = 0;
  for (let i = 0; i < 12; i++) {
    const conv = chat(w, teller, listener, 90000 + i);
    const imp = improvise(w, conv, teller, listener);
    assert.ok(imp.lines.length >= 2 && imp.lines.length <= 16, `${imp.lines.length} lines`);
    for (const l of imp.lines) assert.ok(l.speaker === teller.id || l.speaker === listener.id);
    if (imp.notes.some((n) => n.t === "news" && n.from === teller.id && n.to === listener.id && n.id === h.id)) {
      told++;
      assert.ok(imp.lines.some((l) => l.text.includes(winner.name)), "they actually talk about it");
      assert.ok(imp.topics.length >= 1);
    }
  }
  assert.ok(told >= 8, `news only came up in ${told}/12 chats`);
  // Apply one: the listener now knows, heard it from the teller, and has their own view.
  const conv = chat(w, teller, listener, 90100);
  conv.notes = improvise(w, conv, teller, listener).notes;
  applyNotes(w, conv);
  const k = knows(listener, h.id);
  if (conv.notes.some((n) => n.t === "news")) {
    assert.ok(k, "listener heard the news");
    assert.equal(k.via, teller.id);
    assert.ok(knows(teller, h.id)!.told.includes(listener.id));
  }
});

test("improvised lines read like speech: capitals, full stops, no template leftovers", () => {
  const w = newWorld(67);
  const seen = new Map<number, Conversation>();
  for (let m = 0; m < 1440 * 6; m += 30) {
    advance(w, 30);
    for (const c of w.conversationLog) if (c.topic === "chat" && c.status === "done") seen.set(c.id, c);
  }
  const chats = [...seen.values()];
  assert.ok(chats.length >= 80, `only ${chats.length} chats in 6 days`);
  const lines = chats.flatMap((c) => c.lines.map((l) => l.text));
  for (const t of lines) {
    assert.ok(t.length > 0 && t === t.trim(), `untrimmed: "${t}"`);
    assert.ok(!/^[a-z]/.test(t), `starts lower case: "${t}"`);
    assert.ok(/[.!?…"')]$/.test(t), `no closing punctuation: "${t}"`);
    assert.ok(!/undefined|NaN|null|\[object|\{|\}/.test(t), `template leftover: "${t}"`);
    assert.ok(!/[^.]\.\.(?!\.)|  |\s[,.!?]/.test(t), `messy punctuation: "${t}"`);
  }
  // Quick "See you."s repeat, as in life; what people actually say mostly doesn't.
  const said = lines.filter((t) => t.split(/\s+/).length > 3);
  assert.ok(new Set(said).size / said.length > 0.4, `only ${new Set(said).size} different things said in ${said.length} lines`);
  assert.equal(new Set(chats.map((c) => c.lines.map((l) => l.text).join("|"))).size, chats.length, "no two chats the same");
  const topics = chats.flatMap((c) => c.topics ?? []);
  const aboutNews = topics.filter((t) => w.happenings.some((h) => h.about === t)).length;
  assert.ok(aboutNews >= 10, `only ${aboutNews} chats about town news`);
  const long = chats.filter((c) => c.lines.length >= 8).length;
  assert.ok(long >= 10, `only ${long} longer conversations`);
});

test("old saves get news and happenings and keep running", () => {
  const w = newWorld(68);
  advance(w, 1440);
  const raw = JSON.parse(JSON.stringify(w));
  delete raw.happenings;
  delete raw.nextHappeningT;
  for (const id of raw.citizenOrder) delete raw.citizens[id].news;
  for (const c of raw.conversationLog) {
    delete c.notes;
    delete c.topics;
  }
  const loaded = prepareLoadedWorld(raw)!;
  assert.ok(loaded);
  assert.deepEqual(loaded.happenings, []);
  assert.ok(loaded.nextHappeningT > loaded.time);
  for (const c of people(loaded)) assert.deepEqual(c.news, []);
  advance(loaded, 1440 * 4);
  assert.ok(loaded.happenings.length >= 1, "things start happening");
});

test("invented events are checked before use", () => {
  const w = newWorld(69);
  at(w, 1, 14);
  const kinds = inventableKinds(w);
  assert.ok(kinds.length > 0);
  const ip = inventPrompt(w, "something at the pub");
  assert.ok(people(w).every((c) => ip.includes(c.name)), "Claude sees every resident");
  assert.ok(ip.includes("something at the pub"));
  assert.equal(typeof applyInvented(w, { kind: "volcano", title: "Boom" }), "string");
  const lucky = people(w)[5];
  const money = lucky.money;
  const h = applyInvented(w, { kind: "lottery", who: lucky.name.toUpperCase(), business: null, title: `${lucky.name}'s numbers came up`, about: `${lucky.name}'s big win`, text: `${lucky.name} matched five numbers on the lottery.` });
  assert.equal(typeof h, "object");
  const hh = h as Happening;
  assert.equal(hh.subject, lucky.id, "names are matched loosely");
  assert.equal(hh.source, "llm");
  assert.equal(hh.title, `${lucky.name}'s numbers came up`);
  assert.ok(lucky.money > money, "the town works out the money");
  // An unknown business falls back to a real one.
  const fire = applyInvented(w, { kind: "fire", business: "The Moon Café", title: "Smoke on the high street", about: "the high street fire", text: "Smoke poured out of a shop." });
  assert.equal(typeof fire, "object");
  assert.ok(w.businesses[(fire as Happening).businessId!], "a real business");
});

// A fake Claude for the director: writes chats and invents a lottery win.
function mockClient(calls: LLMRequest[]): LLMClient {
  return {
    model: "claude-opus-5-5",
    async complete(req) {
      calls.push(req);
      const props = req.schema.properties as Record<string, unknown>;
      if (props.kind) return { json: { kind: "lottery", who: null, business: null, title: "A winning ticket", about: "the winning ticket", text: "Someone's ticket came up." }, inputTokens: 900, outputTokens: 80, model: "claude-opus-5-5" };
      if (props.lessons) return { json: { lessons: [] }, inputTokens: 100, outputTokens: 10, model: "claude-opus-5-5" };
      if (props.choice) return { json: null, inputTokens: 100, outputTokens: 10, model: "claude-opus-5-5" };
      return { json: { lines: [{ speaker: "A", text: "Did you hear?" }, { speaker: "B", text: "Hear what?" }, { speaker: "A", text: "Never mind." }], outcome: {} }, inputTokens: 700, outputTokens: 90, model: "claude-opus-5-5" };
    },
  };
}

test("the director: news chats stay within their share of calls; invent on request", async () => {
  const calls: LLMRequest[] = [];
  let spent = 0;
  const director = new AIDirector(mockClient(calls), { total: () => spent, add: (u) => (spent += u) }, { maxConcurrent: 4, minIntervalMs: 0, timeoutMs: 5000 });
  director.attach();
  const w = newWorld(70);
  w.ai.mode = "llm";
  w.ai.budgetUsd = 50;
  w.ai.maxCallsPerDay = 30;
  const step = async (minutes: number) => {
    for (let i = 0; i < minutes / 10; i++) {
      advance(w, 10);
      await new Promise((r) => setImmediate(r));
      director.pump(w);
    }
  };
  await step(1440 * 3);
  const newsChats = calls.filter((c) => /Write 5-10 alternating lines/.test(c.user));
  assert.ok(newsChats.length <= 3 * 10, `${newsChats.length} news chats in 3 days (limit 10 a day)`);

  at(w, 3, 12);
  await step(30);
  assert.equal(director.invent(w, "a lucky ticket") ?? "accepted", "accepted");
  await step(60);
  const last = w.happenings[w.happenings.length - 1];
  assert.equal(last.source, "llm");
  assert.equal(last.title, "A winning ticket");
  assert.ok(director.notices.some((n) => n.text.includes("A winning ticket")));
  assert.ok(w.ai.log.some((l) => l.kind === "invent"), "in the AI log");

  const off = new AIDirector(null, { total: () => 0, add: () => {} });
  assert.match(off.invent(w) ?? "", /isn't available/);
});

test("telling your own news keeps names capitalised in the feed", () => {
  const w = newWorld(71);
  at(w, 1, 12);
  const [winner, friend] = people(w);
  for (const c of [winner, friend]) c.activity.kind = "socialize";
  const h = happen(w, "lottery", { subject: winner.id });
  friend.news = friend.news.filter((k) => k.id !== h.id);
  const headlines = Array.from({ length: 12 }, (_, i) => improvise(w, chat(w, winner, friend, 91000 + i), winner, friend).headline).filter((x): x is string => !!x && x.includes("what happened to them"));
  assert.ok(headlines.length > 0, "the winner tells their own news");
  for (const x of headlines) assert.ok(x.includes(`: ${winner.name} won the lottery.`), x);
});
