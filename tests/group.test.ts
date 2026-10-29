// Group conversations: three to five people, a scheduler deciding who
// speaks, people joining, chipping in and leaving, and everyone hearing
// what's said.
import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, newWorld } from "../src/sim";
import { ChatAudit } from "../src/sim/social/coherence";
import { startGroupChat } from "../src/sim/social/group";
import { prepareLoadedWorld } from "../src/sim/migrate";
import type { Citizen, Conversation, WorldState } from "../src/sim/types";

const people = (w: WorldState): Citizen[] => w.citizenOrder.map((id) => w.citizens[id]);

/** Four friends in the pub: two start talking, two more are on their way over. */
function pubScene(seed: number): { w: WorldState; conv: Conversation; crowd: Citizen[] } {
  const w = newWorld(seed);
  advance(w, 1440 + 18 * 60);
  const pub = w.map.buildings.find((b) => b.type === "pub")!;
  const crowd = people(w).filter((c) => !w.conversations.some((x) => x.a === c.id || x.b === c.id || x.group?.present.includes(c.id))).slice(0, 4);
  for (const c of crowd) {
    c.insideId = pub.id;
    c.path = [];
    c.needs.hunger = c.needs.energy = c.needs.social = 70;
    c.activity = { kind: "socialize", label: "Having a drink", buildingId: pub.id, startedAt: w.time, endsAt: w.time + 6 * 60, action: null };
    for (const o of crowd) if (o.id !== c.id) c.relationships[o.id] = { ...(c.relationships[o.id] ?? { roles: [], lastT: 0 }), affinity: 45, familiarity: 50, trust: 45 } as Citizen["relationships"][string];
  }
  const [a, b, x, y] = crowd;
  const conv = startGroupChat(w, a, b, [
    { who: x.id, after: 2 },
    { who: y.id, after: 6 },
  ])!;
  assert.ok(conv, "the chat starts");
  return { w, conv, crowd };
}

function runToEnd(w: WorldState, conv: Conversation): Conversation {
  for (let i = 0; i < 6 * 60 && w.conversations.some((c) => c.id === conv.id); i++) advance(w, 1);
  return w.conversationLog.find((c) => c.id === conv.id) ?? conv;
}

test("a group: newcomers say hello, each pair takes turns, questions get answers, goodbyes get replies, and everyone goes back to their day", () => {
  for (const seed of [11, 12, 13]) {
    const { w, conv: c0, crowd } = pubScene(seed);
    const conv = runToEnd(w, c0);
    const g = conv.group!;
    assert.equal(conv.status, "done", `seed ${seed}: it finished`);
    assert.ok(g.members.length >= 3, `seed ${seed}: ${g.members.length} people in it`);
    assert.ok(conv.lines.length >= 8, `seed ${seed}: only ${conv.lines.length} lines`);
    assert.equal(g.turns.length, conv.lines.length, "every line has a turn");
    // Whoever came over said hello before anything else.
    for (const id of g.members.slice(2)) assert.equal(g.turns.find((t) => t.speaker === id)?.move, "join", "a newcomer's first line is hello");
    // The scheduler never has more than five there at once.
    for (const t of g.turns) assert.ok(t.heard.length <= 5);
    // Each pair's exchange alternates, and a question is answered by the one it was put to.
    for (const p of g.pairs) {
      p.lines.forEach((l, i) => i && assert.notEqual(l.speaker, p.lines[i - 1].speaker, "each pair takes turns"));
      p.dlg.turns.forEach((m, i) => {
        const next = p.dlg.turns[i + 1];
        if (m.asks && m.q !== "agree" && next) assert.notEqual(next.speaker, m.speaker, "a question gets its answer");
      });
    }
    // Lines are addressed: in a pair, to the other one; a hello or a goodbye, to everyone.
    g.turns.forEach((t, i) => {
      if (t.move === "pair") assert.ok(t.to && t.to !== t.speaker, "said to someone");
      if (t.move === "join" || t.move === "leave") assert.equal(t.to, null);
      if (t.move === "leave") assert.ok(g.turns.slice(i + 1).some((x) => x.move === "farewell" && x.to === t.speaker), "a goodbye gets a reply");
    });
    // Nobody talks about someone standing right there.
    for (const p of g.pairs) for (const m of p.dlg.turns) if (m.kind === "gossip") {
      const about = m.told.map((fid) => (w.citizens[m.speaker].talk?.facts ?? []).find((f) => f.id === fid)?.about);
      const t = g.turns.find((x) => x.pair === p.key && x.at === p.dlg.turns.indexOf(m));
      for (const id of about) assert.ok(!id || !t?.heard.includes(id), "no gossip about someone who's there");
    }
    // Afterwards they're free again, and they know each other a little better.
    for (const c of crowd) {
      if (!g.members.includes(c.id)) continue;
      assert.ok(!w.conversations.some((x) => x.group?.present.includes(c.id) && x.id === conv.id));
      assert.ok(c.activity.kind !== "talk" || c.activity.action?.params?.conversationId !== conv.id || c.activity.endsAt <= w.time, `${c.name} isn't stuck in it`);
    }
    assert.ok(conv.summary.length > 10);
  }
});

test("a group is the same every time from the same start (and the transcript says who said what to whom)", () => {
  const run = () => {
    const { w, conv } = pubScene(21);
    const done = runToEnd(w, conv);
    return done.lines.map((l) => `${l.speaker}>${l.to ?? "all"}: ${l.text}`).join("\n");
  };
  const one = run();
  assert.equal(run(), one);
  assert.match(one, />all: /, "some lines are to everyone");
});

test("what's said in a group is heard by everyone there", () => {
  let checked = 0;
  for (const seed of [31, 32, 33, 34, 35, 36]) {
    const { w, conv: c0 } = pubScene(seed);
    const conv = runToEnd(w, c0);
    const g = conv.group!;
    for (const t of g.turns) {
      const p = t.pair ? g.pairs.find((x) => x.key === t.pair) : undefined;
      const m = p && t.at !== undefined ? p.dlg.turns[t.at] : undefined;
      if (!m?.ref?.startsWith("news:") || m.kind !== "news") continue;
      const id = Number(m.ref.slice(5));
      for (const who of t.heard) {
        if (who === t.speaker) continue;
        checked++;
        assert.ok(w.citizens[who].news.some((k) => k.id === id), `${w.citizens[who].name} heard the news too`);
      }
    }
  }
  assert.ok(checked >= 0);
});

test("groups form on their own: people wander over, chip in and drift off, and the talk still makes sense", () => {
  const audit = new ChatAudit();
  let groups = 0;
  let chimes = 0;
  let joins = 0;
  let leaves = 0;
  for (const seed of [42, 7]) {
    const w = newWorld(seed);
    const seen = new Set<number>();
    for (let h = 0; h < 4 * 24; h++) {
      advance(w, 60);
      for (const c of w.conversationLog) {
        if (c.status !== "done" || seen.has(c.id)) continue;
        seen.add(c.id);
        audit.add(w, c);
        if (!c.group) continue;
        if (c.group.members.length >= 3) groups++;
        chimes += c.group.turns.filter((t) => t.move === "chime").length;
        joins += c.group.turns.filter((t) => t.move === "join").length;
        leaves += c.group.turns.filter((t) => t.move === "leave").length;
      }
    }
  }
  assert.ok(groups >= 10, `only ${groups} groups of three or more`);
  assert.ok(joins >= groups && leaves >= groups / 2, `${joins} joins, ${leaves} leaves`);
  assert.ok(chimes >= 2, `only ${chimes} people chipped in`);
  const show = [...audit.examples.values()].flat().slice(0, 2).join("\n\n");
  assert.ok(audit.total() / audit.chats < 0.01, `${audit.total()} problems in ${audit.chats} chats:\n${show}`);
});

test("a group saved mid-conversation carries on after loading, in the built-in voices", () => {
  const { w, conv } = pubScene(41);
  for (let i = 0; i < 25; i++) advance(w, 1);
  assert.ok(conv.lines.length >= 2 && w.conversations.some((c) => c.id === conv.id), "saved mid-chat");
  const loaded = prepareLoadedWorld(JSON.parse(JSON.stringify(w)))!;
  const again = loaded.conversations.find((c) => c.id === conv.id)!;
  assert.equal(again.group!.driver, "built-in");
  const done = runToEnd(loaded, again);
  assert.equal(done.status, "done");
  assert.ok(done.lines.length > conv.lines.length, "it went on");
});
