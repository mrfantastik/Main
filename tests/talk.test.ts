// Built-in conversations: many wordings, nobody repeating themselves, and
// replies that answer what was said.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, newWorld } from "../src/sim";
import { forceChat, shapeOf } from "../src/sim/dialogue/metrics";
import { remember } from "../src/sim/memory/memory";
import { wordings } from "../src/sim/social/talk";
import type { Citizen, WorldState } from "../src/sim/types";

const people = (w: WorldState): Citizen[] => w.citizenOrder.map((id) => w.citizens[id]);

test("every deal move has plenty of wordings", () => {
  for (const move of ["meet", "meetBack", "greetFriend", "greetAcquaintance", "howFine", "askBack", "sympathy", "congrats", "newsBlurt", "newsNo", "bye", "byeBack", "comfort", "supportive", "disagree", "concede"]) {
    assert.ok(wordings(move) >= 6, `${move}: only ${wordings(move)} wordings`);
  }
});

test("four days of chat: varied openers and lines, nothing said over and over", () => {
  for (const seed of [42, 7]) {
    const w = newWorld(seed);
    advance(w, 4 * 1440);
    const chats = w.conversationLog.filter((c) => c.topic === "chat" && c.lines.length);
    const lines = chats.flatMap((c) => c.lines.map((l) => shapeOf(w, l.text)));
    const distinct = new Set(lines).size / lines.length;
    assert.ok(distinct > 0.55, `seed ${seed}: only ${Math.round(distinct * 100)}% of lines different`);
    const openers = new Map<string, number>();
    for (const c of chats) openers.set(shapeOf(w, c.lines[0].text), (openers.get(shapeOf(w, c.lines[0].text)) ?? 0) + 1);
    const top = Math.max(...openers.values());
    assert.ok(top <= Math.max(5, chats.length * 0.1), `seed ${seed}: the same opener ${top} times in ${chats.length} chats`);
    // Goodbyes repeat, as in life ("Anyway, I need to get back."); what people actually say mostly doesn't.
    const said = chats.flatMap((c) => c.lines.filter((_, i) => !["close", "byeback"].includes(c.dlg?.turns[i]?.move ?? "")).map((l) => shapeOf(w, l.text)));
    const counts = new Map<string, number>();
    for (const l of said) if (l.split(/\s+/).length > 4) counts.set(l, (counts.get(l) ?? 0) + 1);
    const [worst, n] = [...counts].sort((x, y) => y[1] - x[1])[0];
    assert.ok(n <= 7, `seed ${seed}: "${worst}" said ${n} times`);
    const avg = lines.length / chats.length;
    assert.ok(avg >= 6, `seed ${seed}: chats average ${avg.toFixed(1)} lines`);
  }
});

test("bad news gets a reply to it, not small talk", () => {
  const w = newWorld(130);
  advance(w, 1440 + 11 * 60);
  const [a, b] = people(w).slice(0, 2);
  for (const c of [a, b]) c.activity.kind = "socialize";
  a.relationships[b.id] = { ...(a.relationships[b.id] ?? { roles: [] }), affinity: 60, familiarity: 50, trust: 50 } as Citizen["relationships"][string];
  b.relationships[a.id] = { ...(b.relationships[a.id] ?? { roles: [] }), affinity: 60, familiarity: 50, trust: 50 } as Citizen["relationships"][string];
  remember(w, b, { text: "Someone stole my bike from outside my flat.", kind: "financial", importance: 8, valence: -0.8, people: [], feel: { sadness: 40, anger: 30 } });
  let told = 0;
  for (let i = 0; i < 8; i++) {
    const w2 = structuredClone(w);
    w2.time += i * 11;
    w2.nextId += i * 7;
    const conv = forceChat(w2, w2.citizens[a.id], w2.citizens[b.id]);
    const at = conv.lines.findIndex((l) => /stole my bike/.test(l.text));
    if (at < 0) continue;
    told++;
    assert.equal(conv.lines[at].speaker, b.id, "it's their news to tell");
    const reply = conv.lines[at + 1];
    const m = conv.dlg!.turns[at + 1];
    assert.equal(reply.speaker, a.id);
    assert.ok(m.move === "react" || m.move === "ask", `answered with "${reply.text}" (${m.move})`);
    assert.ok(!/^(Can't complain|Same old|Getting by|Fine, thanks|Surviving|Not bad|Fair enough)/.test(reply.text), `answered with small talk: "${reply.text}"`);
  }
  assert.ok(told >= 4, `the bike only came up ${told}/8 times between friends`);
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
  for (const k of ["unasked answer", "unanswered question", "day number", "voice tic", "unanswered goodbye", "wrong opinion", "broken text"]) assert.equal(n(k), 0, `${k}:\n${show}`);
  assert.ok(audit.total() / audit.chats < 0.01, `${audit.total()} problems in ${audit.chats} chats:\n${show}`);
});
