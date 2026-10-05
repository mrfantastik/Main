// Built-in conversations: many wordings, nobody repeating themselves, and
// replies that answer what was said.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, newWorld } from "../src/sim";
import { remember } from "../src/sim/memory/memory";
import { improvise } from "../src/sim/social/improv";
import { wordings } from "../src/sim/social/talk";
import type { Citizen, Conversation, WorldState } from "../src/sim/types";

const people = (w: WorldState): Citizen[] => w.citizenOrder.map((id) => w.citizens[id]);

test("every move has plenty of wordings", () => {
  for (const move of ["meet", "meetBack", "greetFriend", "greetAcquaintance", "howFine", "askBack", "sympathy", "congrats", "newsBlurt", "newsNo", "bye", "byeBack", "comfort", "supportive", "disagree", "concede"]) {
    assert.ok(wordings(move) >= 6, `${move}: only ${wordings(move)} wordings`);
  }
});

test("four days of chat: varied openers and lines, nothing said over and over", () => {
  for (const seed of [42, 7]) {
    const w = newWorld(seed);
    advance(w, 4 * 1440);
    const chats = w.conversationLog.filter((c) => c.topic === "chat" && c.lines.length);
    const names = people(w).map((c) => c.name);
    const shape = (t: string) => names.reduce((s, n) => s.replaceAll(n, "NAME"), t).replace(/£[\d,.]+/g, "£N").replace(/\d+/g, "N");
    const lines = chats.flatMap((c) => c.lines.map((l) => shape(l.text)));
    const distinct = new Set(lines).size / lines.length;
    assert.ok(distinct > 0.62, `seed ${seed}: only ${Math.round(distinct * 100)}% of lines different`);
    const openers = new Map<string, number>();
    for (const c of chats) openers.set(shape(c.lines[0].text), (openers.get(shape(c.lines[0].text)) ?? 0) + 1);
    const top = Math.max(...openers.values());
    assert.ok(top <= Math.max(4, chats.length * 0.08), `seed ${seed}: the same opener ${top} times in ${chats.length} chats`);
    const counts = new Map<string, number>();
    for (const l of lines) if (l.split(/\s+/).length > 4) counts.set(l, (counts.get(l) ?? 0) + 1);
    const [worst, n] = [...counts].sort((x, y) => y[1] - x[1])[0];
    assert.ok(n <= 6, `seed ${seed}: "${worst}" said ${n} times`);
    const avg = lines.length / chats.length;
    assert.ok(avg >= 6.5, `seed ${seed}: chats average ${avg.toFixed(1)} lines`);
  }
});

test("bad news gets a reply to it, not small talk", () => {
  const w = newWorld(130);
  advance(w, 1440 + 11 * 60);
  const [a, b] = people(w).filter((c) => (c.relationships[people(w)[0].id]?.familiarity ?? 0) >= 0).slice(0, 2);
  for (const c of [a, b]) c.activity.kind = "socialize";
  a.relationships[b.id] = { ...(a.relationships[b.id] ?? { trust: 30, roles: [] }), affinity: 50, familiarity: 40, trust: 40 } as Citizen["relationships"][string];
  b.relationships[a.id] = { ...(b.relationships[a.id] ?? { trust: 30, roles: [] }), affinity: 50, familiarity: 40, trust: 40 } as Citizen["relationships"][string];
  remember(w, b, { text: "Someone stole my bike from outside my flat.", kind: "financial", importance: 8, valence: -0.8, people: [] });
  let answered = 0;
  for (let i = 0; i < 6; i++) {
    const conv: Conversation = { id: 95000 + i, a: a.id, b: b.id, topic: "chat", buildingId: a.insideId, startedT: w.time, lines: [], revealed: 0, nextRevealT: w.time, status: "talking", agenda: {}, terms: {}, outcome: null, fallback: null, summary: "", source: "template", endT: 0 };
    const imp = improvise(w, conv, a, b);
    const at = imp.lines.findIndex((l) => /stole my bike/.test(l.text));
    assert.ok(at >= 1 && at <= 3 && imp.lines[at].speaker === b.id, "they say it when asked how they are");
    const reply = imp.lines[at + 1];
    assert.equal(reply.speaker, a.id);
    assert.ok(!/^(Can't complain|Same old|Getting by|Fine, thanks|Mustn't grumble|Surviving|Not bad)/.test(reply.text), `answered with small talk: "${reply.text}"`);
    if (imp.topics.includes(`${b.name}'s bad day`)) answered++;
  }
  assert.equal(answered, 6);
});

test("conversations make sense: no answers to unasked questions, hanging questions, wrong-sized reactions or voice tics", async () => {
  const { ChatAudit } = await import("../src/sim/social/coherence");
  const audit = new ChatAudit();
  for (const seed of [42, 7]) {
    const w = newWorld(seed);
    const seen = new Set<number>();
    for (let h = 0; h < 6 * 24; h++) {
      advance(w, 60);
      for (const c of w.conversationLog) {
        if (c.status !== "done" || seen.has(c.id)) continue;
        seen.add(c.id);
        audit.add(w, c);
      }
    }
  }
  const n = (k: string) => audit.counts.get(k as never) ?? 0;
  const show = [...audit.examples.values()].flat().slice(0, 3).join("\n\n");
  assert.ok(audit.chats > 300, `only ${audit.chats} chats`);
  for (const k of ["unasked answer", "day number", "voice tic", "wrong time of day", "unanswered goodbye", "wrong opinion"]) assert.equal(n(k), 0, `${k}:\n${show}`);
  assert.ok(audit.total() / audit.chats < 0.01, `${audit.total()} problems in ${audit.chats} chats:\n${show}`);
});
