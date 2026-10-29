import { citizenAcc, transfer } from "../economy/ledger";
import { logEvent } from "../events";
import { remember } from "../memory/memory";
import { placeName } from "../places";
import { adjustRel } from "../social/relationships";
import { happeningById, knows, learnNews } from "../town/happenings";
import type { Citizen, Conversation, WorldState } from "../types";
import { clamp, money } from "../util";
import { addEpisode, addJoke, addThread, bondOf, noteTopic, resolveThread, setOpinion } from "./bonds";
import { mentions, toThird } from "./grammar";
import { factById, learn, noticeLeak, tell } from "./knowledge";
import { howItWent } from "./life";
import { drift, profileOf, talkOf } from "./profile";
import type { DialogueState, TurnMeta } from "./types";

// When a conversation ends, each of them takes something away from it, from
// their own side:
//   - what they were told: facts passed on (gossip loses a little each time),
//     things the other said about their own life, and plans to ask about
//     later ("Ask how Ben's job hunt went", once the day's come),
//   - questions that got answered (a follow-up is settled, or kept going if
//     there's no news yet),
//   - impressions: they seemed off, they're funny, they talk a lot,
//   - running jokes born of something that made them both laugh,
//   - a short summary of the conversation as they'd remember it,
//   - a small, careful nudge to the relationship.
// Only what matters goes into long-term memory (a confidence, a promise, a
// row); "hello" doesn't. And if something said in confidence came up with
// the person it was about, they work out who let it slip.

const JOKE_LINE: Record<string, string> = {
  "the pigeons": "How's Gerald?",
  "the plants": "How's the fern? Still talking to it?",
  tea: "Finished a cup of tea yet?",
  receipts: "Kept the receipt?",
  "being early": "Been here long? Twenty minutes, was it?",
  whistling: "Don't start whistling.",
  "that paperback": "Still on that book?",
  mints: "Got a mint?",
  bargains: "Bought anything you don't need today?",
  "a daft question": "Still spending your millions?",
};

/** Was this line actually about the thing (for lines a model wrote, which may not have followed the plan)? */
function spokeOf(line: string, cues: string[] | undefined): boolean {
  return !cues || !cues.length || mentions(line, cues, 1);
}

/** Pull out what they each take away, and update their memories, knowledge and the relationship. */
export function takeAway(world: WorldState, conv: Conversation, a: Citizen, b: Citizen): void {
  const st = conv.dlg;
  if (!st) return;
  const lines = conv.lines.slice(0, Math.max(conv.revealed, conv.lines.length));
  const metas = st.turns.slice(0, lines.length);
  const pairs: [Citizen, Citizen][] = [
    [a, b],
    [b, a],
  ];
  const said = lines.map((l) => l.text).join(" ");
  const place = placeName(world, conv.buildingId);

  for (const [x, y] of pairs) {
    const bx = bondOf(world, x, y.id);
    bx.talks++;
    bx.lastT = world.time;
    // Ground covered (so they don't go over it again too soon).
    for (const m of metas) if (m.topic) noteTopic(world, bx, m.topic);
    for (const m of metas) if (m.q === "work") noteTopic(world, bx, "ask:work");
    const op = metas.find((m) => m.speaker === x.id);
    if (op) {
      bx.openers.push(`${op.move}:${op.tone}`);
      if (bx.openers.length > 5) bx.openers.shift();
    }
  }

  // Facts passed on in what was said (a model's line only counts if it actually touched on it).
  metas.forEach((m, i) => {
    if (!m.told.length) return;
    const speaker = world.citizens[m.speaker];
    const listener = m.speaker === a.id ? b : a;
    if (!speaker) return;
    for (const id of m.told) {
      const f = factById(speaker, id);
      if (!f) continue;
      if (m.by === "llm" && !spokeOf(lines[i]?.text ?? "", f.cues)) continue;
      tell(world, speaker, listener, f);
    }
  });

  // Town news that came up passes on (with the teller as the source).
  metas.forEach((m, i) => {
    if (!m.ref?.startsWith("news:") || m.kind !== "news") return;
    const h = happeningById(world, Number(m.ref.slice(5)));
    const speaker = world.citizens[m.speaker];
    const listener = m.speaker === a.id ? b : a;
    if (!h || !speaker) return;
    const next = metas[i + 1];
    const spoken = m.by === "built-in" || /fire|burgl|broke in|robbed|lottery|won|famous|celebr|poison|ill\b|sick|festival|storm|rain|power|rent|column|statue|party|birthday/i.test(`${lines[i]?.text ?? ""} ${lines[i + 1]?.text ?? ""} ${lines[i + 2]?.text ?? ""}`);
    if (!spoken || knows(listener, h.id)) return;
    // A "did you hear?" counts once the other says they hadn't (or it's told outright).
    if (m.asks && next && next.speaker !== m.speaker && /^yeah|heard/i.test(lines[i + 1]?.text ?? "")) return;
    learnNews(world, listener, h, speaker.id);
    const k = knows(speaker, h.id);
    if (k && !k.told.includes(listener.id)) k.told.push(listener.id);
  });

  // What they told each other about their own lives.
  for (const l of st.learned) {
    const listener = world.citizens[l.who];
    const about = world.citizens[l.about];
    if (!listener || !about) continue;
    const teller = l.from ?? about.id;
    const firstHand = teller === about.id;
    const f = learn(world, listener, { about: about.id, pred: firstHand ? (l.when !== null ? "plan" : l.valence < -0.2 ? "problem" : "event") : "said", key: l.key, text: l.text || toThird(l.label, about.name), source: firstHand ? "told" : "rumour", from: teller, origin: about.id, certainty: firstHand ? 0.95 : 0.6, sensitivity: l.sensitive, valence: l.valence, importance: 4 + l.sensitive * 4, when: l.when, confidential: firstHand ? l.confidential : undefined, chain: firstHand ? undefined : [teller] });
    if (!firstHand) continue;
    // Plans: something to ask about once there's news.
    if (l.when !== null && l.follow) addThread(world, bondOf(world, listener, about.id), { kind: "followup", topic: l.label.startsWith("the ") ? `${about.name}'s ${l.label.slice(4)}` : l.label, text: l.follow, fact: f.id, after: Math.max(world.time + 6 * 60, l.when), until: Math.max(world.time + 6 * 60, l.when) + 6 * 1440, importance: 5 + l.sensitive * 2 });
    // Troubles: someone who cares asks after them next time.
    else if (l.valence < -0.25 && !l.key.startsWith("dislike:")) {
      const care = profileOf(listener).empathy * 0.6 + (listener.relationships[about.id]?.affinity ?? 0) / 100 + (listener.family.includes(about.id) ? 0.4 : 0);
      if (care > 0.3) addThread(world, bondOf(world, listener, about.id), { kind: "followup", topic: `how ${about.name}'s getting on`, text: `Ask ${about.name} if things are any better`, fact: f.id, after: world.time + 14 * 60, until: world.time + 6 * 1440, importance: 4 + l.sensitive * 3 });
    }
    // A real confidence is worth remembering.
    if (l.sensitive >= 0.55) remember(world, listener, { text: `${about.name} told me ${l.text ? l.text.replace(new RegExp(`^${about.name}\\b`), "they").replace(/^they is\b/, "they're") : l.label}.`, kind: "conversation", importance: 5, valence: 0.2, people: [about.id], key: `confided:${about.id}:${l.key}`, feel: { love: 2, gratitude: 1 } });
  }

  // Follow-ups asked and answered: settled, or kept going if there's no news yet.
  metas.forEach((m, i) => {
    if (m.q !== "followup" || !m.ref) return;
    const asker = world.citizens[m.speaker];
    const other = m.speaker === a.id ? b : a;
    const reply = metas[i + 1];
    if (!asker || !reply || reply.speaker === m.speaker || reply.move !== "answer") return;
    const bx = bondOf(world, asker, other.id);
    const f = factById(asker, Number(m.ref));
    for (const th of bx.threads.filter((t) => t.fact === Number(m.ref) || t.kind === "followup" && f && t.topic.includes(other.name))) {
      resolveThread(bx, th.id);
      st.resolved.push({ who: asker.id, thread: th.id });
    }
    if (!f) return;
    const went = howItWent(world, other, f);
    if (!went) return;
    // What they now know, and whether to ask again.
    f.text = toThird(went.first, other.name).replace(/\.$/, "");
    f.learnedAt = world.time;
    f.valence = went.valence;
    if (!went.settled) addThread(world, bx, { kind: "followup", topic: `${other.name}'s news`, text: `Ask ${other.name} if there's any news`, fact: f.id, after: world.time + 2 * 1440, until: world.time + 8 * 1440, importance: 4 });
    else f.when = null;
  });

  // Concern, owed money: asking is dealing with it (owed comes back if it's still owed).
  metas.forEach((m) => {
    if (!m.topic?.startsWith("thread:")) return;
    const asker = world.citizens[m.speaker];
    const other = m.speaker === a.id ? b : a;
    if (!asker) return;
    const bx = bondOf(world, asker, other.id);
    for (const th of bx.threads.filter((t) => `thread:${t.topic}` === m.topic)) {
      resolveThread(bx, th.id);
      if (th.kind === "owed") addThread(world, bx, { ...th, after: world.time + 2 * 1440, until: world.time + 10 * 1440 });
    }
  });

  // "Pub later?" "Go on then." A pint they'll bring up next time.
  metas.forEach((m, i) => {
    const reply = metas[i + 1];
    if (!reply || reply.speaker === m.speaker || reply.move !== "answer") return;
    const pub = m.q === "m:the pub" || (m.q === "evening" && /\bpub\b|pint/i.test(lines[i]?.text ?? ""));
    if (!pub || !/^(Go on( then)?|Yeah, go on|Why not|Yes|Yeah)\b/i.test(lines[i + 1]?.text ?? "")) return;
    for (const [x, y] of pairs) addThread(world, bondOf(world, x, y.id), { kind: "promise", topic: "that pint", text: `Remind ${y.name} about that pint`, after: world.time + 10 * 60, until: world.time + 6 * 1440, importance: 3 });
  });

  // Impressions of each other.
  const turnsOf = (c: Citizen) => metas.filter((m) => m.speaker === c.id);
  for (const [x, y] of pairs) {
    const px = profileOf(x);
    const bx = bondOf(world, x, y.id);
    const theirs = turnsOf(y);
    // They said they were fine, but they weren't: an empathetic friend notices. Or they said so outright.
    const care = px.empathy * 0.7 + (x.relationships[y.id]?.affinity ?? 0) / 150;
    const saidBad = theirs.some((m) => m.move === "answer" && m.valence <= -0.4 && metas[metas.indexOf(m) - 1]?.q === "how");
    if ((st.hid?.includes(y.id) && care > 0.45) || (saidBad && care > 0.3)) {
      bx.seemed = { text: saidBad ? "down" : "a bit off", t: world.time };
      addThread(world, bx, { kind: "concern", topic: `${y.name} seeming ${saidBad ? "down" : "off"}`, text: `Check ${y.name}'s alright`, after: world.time + 8 * 60, until: world.time + 5 * 1440, importance: 4 });
    }
    if (theirs.some((m) => m.tone === "teasing" || m.tone === "amused") && metas.some((m) => m.speaker === x.id && m.tone === "amused")) setOpinion(world, bx, "funny", "funny", 0.2);
    const words = theirs.reduce((s, m, i) => s + (lines[metas.indexOf(m)]?.text.split(/\s+/).length ?? 0) + i * 0, 0);
    if (theirs.length >= 3 && words / theirs.length > 16 && px.patience < 0.45) setOpinion(world, bx, "talks", "talks a lot", 0.15);
    if (theirs.some((m) => m.tone === "sympathetic") && metas.some((m) => m.speaker === x.id && (m.kind === "problem" || m.kind === "disclose"))) setOpinion(world, bx, "kind", "there for you", 0.25);
    if (theirs.some((m) => m.tone === "jealous" || m.tone === "dismissive" || m.tone === "competitive")) {
      setOpinion(world, bx, "funny-about", "a bit funny about things", 0.12);
      if (px.empathy > 0.55) bx.seemed = { text: "a bit funny about it", t: world.time };
    }
    if (theirs.some((m) => m.tone === "guarded") && (x.relationships[y.id]?.affinity ?? 0) > 30) setOpinion(world, bx, "closed", "keeps things to themselves", 0.1);
    bx.tension = clamp(bx.tension * 0.5 + st.tension * 0.6, 0, 1);
  }

  // Running jokes: something odd of theirs that got a laugh.
  metas.forEach((m, i) => {
    const next = metas[i + 1];
    if (!m.topic || !next || next.tone !== "amused" && next.tone !== "teasing") return;
    const label = st.covered.find((c) => JOKE_LINE[c]) ?? null;
    if (!label) return;
    for (const [x, y] of pairs) if ((x.relationships[y.id]?.affinity ?? 0) > 15) addJoke(world, bondOf(world, x, y.id), label, JOKE_LINE[label]);
  });

  // Help with money, as it was offered.
  for (const g of st.gifts ?? []) {
    const from = world.citizens[g.from];
    const to = world.citizens[g.to];
    if (!from || !to || from.money < g.amount + 20) continue;
    if (!transfer(world, citizenAcc(from.id), citizenAcc(to.id), g.amount, "gift", `Helping ${to.name} out`)) continue;
    remember(world, to, { text: `${from.name} gave me ${money(g.amount)} when I was worried about money.`, kind: "favor", importance: 7, valence: 0.9, people: [from.id] });
    remember(world, from, { text: `I gave ${to.name} ${money(g.amount)} to tide them over.`, kind: "social", importance: 4, valence: 0.5, people: [to.id], feel: { joy: 4, pride: 3 } });
    logEvent(world, "social", `🎁 ${from.name} gave ${to.name} ${money(g.amount)} to help out.`, 3, [from.id, to.id]).conversationId = conv.id;
  }

  // Did something told in confidence come up with the person it's about?
  for (const [x, y] of pairs) {
    const leaker = noticeLeak(world, x, y, said);
    if (leaker) {
      const lw = world.citizens[leaker];
      if (lw) {
        addThread(world, bondOf(world, x, leaker), { kind: "disagreement", topic: "them blabbing", text: `Have it out with ${lw.name} for telling people`, after: world.time, until: world.time + 7 * 1440, importance: 7 });
        logEvent(world, "social", `🤐 ${x.name} found out ${lw.name} had been telling people what they said in confidence.`, 3, [x.id, leaker]);
      }
    }
  }

  // The relationship moves a little with how it went (never far in one go).
  const warm = metas.filter((m) => m.tone === "amused" || m.tone === "sympathetic" || m.tone === "supportive" || m.tone === "warm").length;
  const sour = metas.filter((m) => m.tone === "dismissive" || m.tone === "sarcastic" && st.tension > 0.3 || m.move === "deflect" || m.tone === "jealous").length;
  for (const [x, y] of pairs) {
    const fromY = metas.filter((m) => m.speaker === y.id);
    const nice = fromY.filter((m) => ["amused", "sympathetic", "supportive", "impressed", "warm"].includes(m.tone)).length;
    const nasty = fromY.filter((m) => ["dismissive", "jealous", "cold"].includes(m.tone) || m.move === "disagree").length;
    const d = clamp(nice * 0.7 - nasty * 0.8 + (warm > sour ? 0.3 : 0), -2.5, 2.5);
    const confided = st.learned.some((l) => l.who === y.id && l.about === x.id && l.sensitive >= 0.55);
    if (Math.abs(d) > 0.05 || confided) adjustRel(world, x, y.id, { affinity: d, trust: confided ? 1.5 : nice > nasty ? 0.4 : 0 });
  }

  // Each remembers it their own way.
  for (const [x, y] of pairs) {
    const bx = bondOf(world, x, y.id);
    const parts: string[] = [];
    const theirNews = st.learned.filter((l) => l.who === x.id).map((l) => (l.text || l.label).replace(new RegExp(`^${y.name}\\b`), "they"));
    const myNews = st.learned.filter((l) => l.who === y.id).map((l) => l.label);
    const gossip = metas.filter((m) => m.speaker !== x.id && m.kind === "gossip").length;
    const topics = st.covered.filter((t) => t && !/^thread:/.test(t)).slice(0, 3);
    if (topics.length) parts.push(`We talked about ${topics.join(", ")}.`);
    if (theirNews.length) parts.push(`${y.name} told me ${theirNews[0]}.`);
    if (myNews.length) parts.push(`I told ${y.name} about ${myNews[0]}.`);
    if (gossip) parts.push(`${y.name} had some gossip.`);
    if (st.mode === "fail") parts.push(["enemy", "dislikes"].includes(st.tone) ? `We barely spoke.` : `${y.name} couldn't stop.`);
    if (st.tension > 0.45) parts.push("It got a bit tense.");
    else if (st.tone === "warm") parts.push("It was nice.");
    if (!parts.length) parts.push(st.mode === "brief" ? "Just said hello." : "Small talk.");
    const importance = Math.round(clamp(1 + st.learned.filter((l) => l.who === x.id).reduce((s, l) => s + 1 + l.sensitive * 3, 0) + st.tension * 3 + (st.mode === "significant" ? 2 : 0) + gossip, 1, 10));
    addEpisode(x, bx, { t: world.time, summary: parts.join(" ").slice(0, 240), topics, tone: st.tension > 0.45 ? "tense" : st.tone, place, importance });
  }
}

/** Daily: knowledge fades, bonds settle, and life slowly changes who they are. */
export function lifeShapesThem(world: WorldState, c: Citizen): void {
  const t = talkOf(c);
  const yesterday = world.time - 1440;
  for (const m of [...c.memories.short, ...c.memories.long]) {
    if (m.t < yesterday) continue;
    if (m.kind === "betrayal") drift(c, { trust: -0.03, openness: -0.01 });
    if (m.kind === "business" && m.valence > 0.5 && m.importance >= 7) drift(c, { confidence: 0.025, optimism: 0.01 });
    if (m.kind === "business" && m.valence < -0.5 && m.importance >= 8) drift(c, { confidence: -0.03, optimism: -0.02 });
    if (m.key.startsWith("friend:")) drift(c, { openness: 0.012 });
    if (m.kind === "favor" && m.valence > 0.5) drift(c, { trust: 0.01 });
  }
  if (c.daysUnemployed > 3) drift(c, { optimism: -0.008, confidence: -0.004 });
  // And it all slowly settles back towards who they were.
  for (const k of Object.keys(t.drift) as (keyof typeof t.drift)[]) t.drift[k] = Math.round(t.drift[k] * 0.995 * 1000) / 1000;
}

/** For the debug view: the turn metadata as short strings. */
export function describeTurns(st: DialogueState): string[] {
  return st.turns.map((m: TurnMeta) => `${m.move}${m.kind ? `/${m.kind}` : ""}${m.q ? ` ?${m.q}` : ""} · ${m.intent} · ${m.tone}${m.by === "llm" ? " · model" : ""}`);
}
