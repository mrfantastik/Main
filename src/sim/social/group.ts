import { hearStory } from "../ai/beliefs";
import { endDialogue, revealMinutes } from "../dialogue";
import { builtInGroupTurn, GROUP, newGroup, pairView, planGroupTurn, recordGroupLine, type GroupPlan } from "../dialogue/group";
import { factById, tell } from "../dialogue/knowledge";
import type { TurnMeta } from "../dialogue/types";
import { logEvent } from "../events";
import { remember } from "../memory/memory";
import { feel, recallPerson } from "../mind/emotions";
import { rememberChat } from "../mind/bot";
import { placeName } from "../places";
import { chance, hashSeed, rand } from "../rng";
import { settleDecision } from "../society/state";
import { happeningById, knows, learnNews } from "../town/happenings";
import type { Citizen, CitizenId, Conversation, WorldState } from "../types";
import { clamp, newId, pushRing } from "../util";
import { canTalk, CONVERSATION_LOG_LIMIT, lockIntoTalk, voiceWithAI } from "./conversation";
import { compatibility } from "./encounters";
import { adjustRel } from "./relationships";

// Group conversations in the town: who comes over to join a chat, who
// drifts off, and what everyone takes away. The talking itself (who speaks
// when, and what they say) is the scheduler in dialogue/group.ts; this is
// the part that touches the world (people stop what they're doing to join,
// and go back to it when they leave).

const inGroup = (conv: Conversation, id: CitizenId) => conv.a === id || conv.b === id || !!conv.group?.present.includes(id);

/** Whether this person is in (or on their way into) any conversation. */
export function inAnyConversation(world: WorldState, id: CitizenId): boolean {
  return world.conversations.some((x) => inGroup(x, id) || !!x.group?.arriving.some((a) => a.who === id));
}

/** How keen someone is to wander over and join two (or more) people talking. */
function joinKeenness(world: WorldState, c: Citizen, people: Citizen[]): number {
  if (!canTalk(world, c) || inAnyConversation(world, c.id) || c.needs.hunger < 25 || c.needs.energy < 20) return 0;
  const rels = people.map((o) => c.relationships[o.id]);
  // They have to know at least one of them, and not loathe any of them.
  const best = Math.max(...rels.map((r, i) => (r?.affinity ?? 0) + (r?.familiarity ?? 0) / 2 + (c.family.includes(people[i].id) ? 40 : 0)));
  if (best < 20 || rels.some((r) => (r?.affinity ?? 0) < -30)) return 0;
  const ctx = c.activity.kind === "socialize" ? 1 : c.activity.kind === "eat" || c.activity.kind === "rest" || c.activity.kind === "idle" ? 0.65 : c.activity.kind === "browse" || c.activity.kind === "shop" ? 0.4 : 0.22;
  const lonely = (100 - c.needs.social) / 100;
  return clamp(ctx * (0.12 + c.personality.big5.extraversion * 0.25 + c.traits.sociability * 0.15 + lonely * 0.2 + Math.min(0.3, best / 300)), 0, 0.7);
}

/** Who'd come over when two people start talking here (and when). */
export function joinersFor(world: WorldState, a: Citizen, b: Citizen, present: Citizen[]): { who: CitizenId; after: number }[] {
  const out: { who: CitizenId; after: number }[] = [];
  const r = { rng: hashSeed(`${world.seed}:${world.time}:${a.id}:${b.id}:join`) };
  const others = present.filter((o) => o.id !== a.id && o.id !== b.id);
  let after = 2;
  for (const o of others) {
    if (out.length >= GROUP.maxSize - 2) break;
    if (rand(r) >= joinKeenness(world, o, [a, b])) continue;
    after += 1 + Math.floor(rand(r) * 4);
    out.push({ who: o.id, after });
  }
  return out;
}

/** Whether anyone here might come over later (someone free who knows one of them). */
export function mightBeJoined(world: WorldState, a: Citizen, b: Citizen, present: Citizen[]): boolean {
  return present.some((o) => o.id !== a.id && o.id !== b.id && joinKeenness(world, o, [a, b]) > 0.08);
}

/** Two people start a conversation that others are coming over to join. */
export function startGroupChat(world: WorldState, a: Citizen, b: Citizen, arriving: { who: CitizenId; after: number }[]): Conversation | null {
  if (!canTalk(world, a) || !canTalk(world, b) || a.insideId !== b.insideId) return null;
  const conv: Conversation = {
    id: newId(world),
    a: a.id,
    b: b.id,
    topic: "chat",
    buildingId: a.insideId,
    startedT: world.time,
    lines: [],
    revealed: 0,
    nextRevealT: world.time + 1,
    status: "live",
    live: { done: false, lastLineT: world.time },
    agenda: {},
    terms: {},
    outcome: {},
    fallback: null,
    summary: "",
    source: "template",
    endT: 0,
  };
  recallPerson(world, a, b.id);
  recallPerson(world, b, a.id);
  newGroup(world, conv, a, b, arriving, "built-in");
  world.conversations.push(conv);
  lockIntoTalk(world, a, b, conv.id);
  lockIntoTalk(world, b, a, conv.id);
  a.cooldowns.lastTalk = world.time;
  b.cooldowns.lastTalk = world.time;
  // The AI may speak for them, a line at a time.
  if (voiceWithAI(world, conv) === "live") conv.group!.driver = "ai";
  return conv;
}

/** Someone heads over to join a group that's already talking (they say hello after the current line). */
export function joinGroup(world: WorldState, conv: Conversation, c: Citizen, afterLines = 1): boolean {
  const g = conv.group;
  if (!g || g.ended || conv.status !== "live" || conv.live?.done) return false;
  if (g.present.length + g.arriving.length >= GROUP.maxSize || !canTalk(world, c) || c.insideId !== conv.buildingId || inAnyConversation(world, c.id)) return false;
  // Not when the two of them are saying goodbye.
  if (g.present.length <= 2 && g.pairs.some((p) => p.dlg.turns.some((t) => t.bye))) return false;
  g.arriving.push({ who: c.id, after: conv.lines.length + afterLines });
  return true;
}

/** The scheduler's next line, once anyone who can't come over after all is dropped (null: it's over). */
export function nextGroupPlan(world: WorldState, conv: Conversation): GroupPlan | null {
  const g = conv.group;
  if (!g) return null;
  g.arriving = g.arriving.filter((x) => {
    const c = world.citizens[x.who];
    return !!c && canTalk(world, c, conv) && c.insideId === conv.buildingId && g.present.length < GROUP.maxSize;
  });
  // Anyone who's been pulled away (asleep, gone home) is no longer in it.
  for (const id of [...g.present]) {
    const c = world.citizens[id];
    if (c && c.insideId === conv.buildingId && c.activity.kind === "talk") continue;
    g.present = g.present.filter((x) => x !== id);
    g.left.push({ who: id, line: conv.lines.length, why: "wandered off" });
  }
  return planGroupTurn(world, conv);
}

/** Say a line in the group (written by the AI or the built-in voices), and do what it does: someone joins, someone goes. */
export function sayGroup(world: WorldState, conv: Conversation, plan: GroupPlan, text: string, by: "llm" | "built-in", meta?: TurnMeta, extras?: Parameters<typeof recordGroupLine>[6]): void {
  const res = recordGroupLine(world, conv, plan, text, by, meta, extras);
  if (by === "llm") conv.source = "llm";
  if (conv.live) conv.live.lastLineT = world.time;
  if (res.joined) {
    const c = world.citizens[res.joined];
    const to = world.citizens[plan.pair?.split("|").find((id) => id !== c.id) ?? conv.a];
    if (c && to) {
      lockIntoTalk(world, c, to, conv.id);
      c.cooldowns.lastTalk = world.time;
      for (const id of conv.group!.present) if (id !== c.id) recallPerson(world, c, id);
      // Whoever they'd meant to go and find was here, talking: they've joined them.
      const it = c.society?.intents.find((i) => i.topic === "chat" && conv.group!.present.includes(i.target));
      if (it) {
        c.society!.intents = c.society!.intents.filter((i) => i !== it);
        settleDecision(c, it.decision, "done", `Found ${world.citizens[it.target]?.name} chatting with ${conv.group!.present.filter((x) => x !== c.id && x !== it.target).map((x) => world.citizens[x]?.name).join(" and ")}, and joined them.`);
      }
    }
  }
  for (const id of res.gone) release(world, conv, id);
  if (res.over && conv.live) conv.live.done = true;
}

function release(world: WorldState, conv: Conversation, id: CitizenId): void {
  const c = world.citizens[id];
  if (!c || c.activity.kind !== "talk" || c.activity.action?.params?.conversationId !== conv.id) return;
  c.activity.endsAt = world.time;
}

/** The built-in voices say the next line (false: there's nothing more to say). */
export function groupStep(world: WorldState, conv: Conversation): boolean {
  const plan = nextGroupPlan(world, conv);
  if (!plan) return false;
  const t = builtInGroupTurn(world, conv, plan);
  sayGroup(world, conv, plan, t.text, "built-in", t.meta ? { ...t.meta, by: "built-in" } : undefined, t.extras);
  return true;
}

/** A line hasn't come for this long (game minutes): the built-in voices take over. */
const AI_STALL = 90;

/** Every minute: show the next line; when the built-in voices are speaking, say it. */
export function groupTick(world: WorldState, conv: Conversation, finish: (conv: Conversation) => void): void {
  const g = conv.group!;
  if (!conv.live) return;
  if (conv.revealed < conv.lines.length) {
    if (world.time >= conv.nextRevealT) {
      conv.nextRevealT = world.time + revealMinutes(conv.lines[conv.revealed].text);
      conv.revealed++;
    }
    return;
  }
  if (world.time < conv.nextRevealT) return;
  if (conv.live.done) {
    finish(conv);
    return;
  }
  if (g.driver === "ai") {
    if (world.time - conv.live.lastLineT <= AI_STALL) return;
    g.driver = "built-in";
  }
  if (!groupStep(world, conv)) conv.live.done = true;
}

/** It's over: what everyone takes away (from what they said, and what they overheard). */
export function finishGroup(world: WorldState, conv: Conversation): void {
  const g = conv.group!;
  conv.status = "done";
  conv.endT = world.time;
  g.ended = true;
  const members = g.members.map((id) => world.citizens[id]).filter(Boolean);
  // Each pair's exchange: what they told each other, threads to follow up, jokes, how it went.
  for (const p of g.pairs) {
    if (!p.lines.length) continue;
    const view = pairView(conv, p);
    view.revealed = p.lines.length;
    rememberChat(world, view);
    endDialogue(world, view);
  }
  // What the others overheard: gossip and news told to one is heard by all.
  for (const t of g.turns) {
    if (!t.pair || t.at === undefined) continue;
    const p = g.pairs.find((x) => x.key === t.pair);
    const m = p?.dlg.turns[t.at];
    if (!p || !m) continue;
    const speaker = world.citizens[t.speaker];
    if (!speaker) continue;
    for (const id of t.heard) {
      if (id === p.a || id === p.b) continue;
      const listener = world.citizens[id];
      if (!listener) continue;
      for (const fid of m.told) {
        const f = factById(speaker, fid);
        // (Not gossip about themselves, and not if they stuck up for whoever it was about.)
        if (!f || f.about === id || g.notes.some((n) => n.who === id && n.about === speaker.id && n.affinity < 0)) continue;
        tell(world, speaker, listener, f);
      }
      if (m.ref?.startsWith("news:") && m.kind === "news") {
        const h = happeningById(world, Number(m.ref.slice(5)));
        if (h && !knows(listener, h.id)) learnNews(world, listener, h, speaker.id);
      }
    }
  }
  // Sides taken in front of everyone.
  for (const n of g.notes) {
    const who = world.citizens[n.who];
    if (!who || !world.citizens[n.about]) continue;
    adjustRel(world, who, n.about, { affinity: n.affinity, trust: n.trust });
    const other = world.citizens[n.about];
    if (Math.abs(n.affinity) >= 3) remember(world, other, { text: n.affinity < 0 ? `${who.name} had a go at me in front of everyone (${n.why}).` : `${who.name} backed me up in front of everyone.`, kind: "conversation", importance: 3, valence: n.affinity < 0 ? -0.4 : 0.3, people: [who.id], feel: n.affinity < 0 ? { anger: 5 } : { gratitude: 4 } });
  }
  // Everyone who was there together.
  const spoke = new Set(g.turns.map((t) => t.speaker));
  for (const x of members) {
    const company = members.filter((o) => o.id !== x.id);
    for (const o of company) {
      const talked = !!g.pairs.find((p) => (p.a === x.id && p.b === o.id) || (p.a === o.id && p.b === x.id))?.lines.length;
      const compat = compatibility(x, o);
      adjustRel(world, x, o.id, { familiarity: talked ? 4 : 2, affinity: (talked ? 1.5 : 0.6) + compat * (talked ? 3 : 1), trust: talked ? 1 : 0 });
    }
    if (!spoke.has(x.id)) continue;
    x.needs.social = clamp(x.needs.social + 10 + 3 * company.length, 0, 100);
    feel(x, { joy: 3 + company.length, loneliness: -6 - 2 * company.length }, { social: true });
    // How the others are getting on (fuel for copying what works).
    for (const o of company) {
      const biz = o.businessIds.map((id) => world.businesses[id]).find((b) => b && b.open);
      const earn = o.finance.occupationEarnings.slice(-3);
      const amount = biz ? biz.avgProfit : earn.length ? earn.reduce((s, v) => s + v, 0) / earn.length : 0;
      if (Math.abs(amount) > 5) hearStory(world, x, { citizenId: o.id, occupation: o.occupation, productId: biz?.products[0] ?? null, amount: Math.round(amount), t: world.time }, o.name);
    }
  }
  // What it was, in a line.
  const topics = [...new Set(g.pairs.flatMap((p) => p.dlg.covered))].filter(Boolean);
  conv.topics = topics.slice(0, 5);
  const names = members.map((c) => c.name);
  const who = names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const chimes = g.turns.filter((t) => t.move === "chime").length;
  conv.summary = `${who} got talking at ${placeName(world, conv.buildingId)}${topics.length ? `: ${topics.slice(0, 3).join(", ")}` : ""}.${chimes ? " Everyone had their say." : ""}${g.notes.some((n) => n.affinity < 0) ? " Not everyone agreed." : ""}`;
  if (members.length >= 3) {
    logEvent(world, "social", `🗣️ ${conv.summary}`, 2, members.map((c) => c.id)).conversationId = conv.id;
    for (const x of members) if (spoke.has(x.id)) remember(world, x, { text: `Stood chatting with ${names.filter((n) => n !== x.name).join(", ")} at ${placeName(world, conv.buildingId)}.`, kind: "conversation", importance: 2, valence: 0.3, people: members.filter((o) => o.id !== x.id).map((o) => o.id), key: `group:${conv.id}` });
  }
  for (const id of g.members) release(world, conv, id);
  for (const c of members) c.awaitingAI = false;
  world.conversations = world.conversations.filter((x) => x.id !== conv.id);
  pushRing(world.conversationLog, conv, CONVERSATION_LOG_LIMIT);
}

/**
 * Every ten minutes: free people near a group who know someone in it may
 * wander over (and anyone who'd decided to go and find someone, and finds
 * them in a group, joins them).
 */
export function maybeJoinGroups(world: WorldState): void {
  for (const conv of world.conversations) {
    const g = conv.group;
    if (!g || g.ended || conv.status !== "live" || conv.live?.done || g.leaving || !conv.buildingId) continue;
    if (g.present.length + g.arriving.length >= GROUP.maxSize) continue;
    const here = g.present.map((id) => world.citizens[id]).filter(Boolean);
    for (const id of world.citizenOrder) {
      const c = world.citizens[id];
      if (c.insideId !== conv.buildingId || g.members.includes(id)) continue;
      const looking = c.society?.intents.some((i) => i.topic === "chat" && g.present.includes(i.target) && i.until >= world.time);
      const keen = looking ? 0.85 : joinKeenness(world, c, here) * 0.8;
      if (keen > 0 && chance(world, keen) && joinGroup(world, conv, c)) break;
    }
  }
}
