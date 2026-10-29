// The conversation test bench. Runs a town and measures its conversations,
// then has the same two people meet again and again to see whether they
// remember, follow up and avoid repeating themselves, and checks whether
// each person sounds like themselves.
//
//   npm run talkbench                                  (town 42, 7 days; a pair, 20 encounters)
//   npm run talkbench -- --seed 7 --days 10 --pair 3,8 --meet 20 --show 4 --debug
//
//   --seed N      which town
//   --days N      how long the town runs first
//   --pair i,j    which two people (by index; default: the pair who know each other best)
//   --meet N      how many times they meet (a day apart)
//   --show N      print the first N encounters in full (all of them with --show all)
//   --debug       with each line, what the speaker meant to do (move, topic, question)

import { advance, newWorld } from "../src/sim";
import { contextFor, contextSize } from "../src/sim/dialogue/context";
import { forceChat, talkMetrics, voiceIdentification, voiceStats } from "../src/sim/dialogue/metrics";
import { planTurn, whoseTurn } from "../src/sim/dialogue";
import { ChatAudit } from "../src/sim/social/coherence";
import type { Conversation, WorldState } from "../src/sim/types";

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? def) : def;
};
const seed = Number(arg("seed", "42"));
const days = Number(arg("days", "7"));
const meets = Number(arg("meet", "20"));
const showArg = arg("show", "3");
const debug = args.includes("--debug");

const pct = (x: number) => `${Math.round(x * 100)}%`;
const t0 = Date.now();

function transcript(w: WorldState, c: Conversation): string {
  const name = (id: string) => w.citizens[id]?.name ?? id;
  return c.lines
    .map((l, i) => {
      const m = c.dlg?.turns[i];
      const why = debug && m ? `   [${m.move}${m.kind ? `/${m.kind}` : ""}${m.q ? ` ?${m.q}` : ""}${m.tone ? ` ${m.tone}` : ""}]` : "";
      return `    ${name(l.speaker)}: ${l.text}${why}`;
    })
    .join("\n");
}

function report(title: string, w: WorldState, convs: Conversation[]): void {
  const m = talkMetrics(w, convs);
  console.log(`\n${title}`);
  console.log(`  ${m.chats} conversations, ${m.lines} lines, ${m.avgLines.toFixed(1)} lines on average (${m.shortest} to ${m.longest})`);
  console.log(`  different wordings: ${pct(m.distinctLines)} of lines · openers used before: ${pct(m.repeatedOpeners)} · questions: ${pct(m.questionsPerLine)} of lines`);
  console.log(`  most-said line: "${m.topLine.text}" (${m.topLine.n}x)`);
  console.log(`  picked up from before (follow-ups, jokes, checking in, old rows): ${m.callbacks} · ended with a goodbye: ${pct(m.naturalEndings)}`);
  console.log(`  how they went: ${Object.entries(m.modes).map(([k, n]) => `${k} ${n}`).join(", ")}`);
}

// ---- 1. a town, left to itself
const w = newWorld(seed);
const seen = new Set<number>();
const town: Conversation[] = [];
const audit = new ChatAudit();
let sampled = 0;
let ctxTotal = 0;
let ctxMax = 0;
for (let h = 0; h < days * 24; h++) {
  advance(w, 60);
  for (const c of w.conversationLog) {
    if (c.status !== "done" || seen.has(c.id)) continue;
    seen.add(c.id);
    if (c.topic === "chat" || c.topic === "argue") town.push(c);
    audit.add(w, c);
  }
  // What a model would be given for a turn, now and then (prompt size stays bounded however long the town runs).
  for (const conv of w.conversations) {
    if (!conv.dlg || conv.dlg.mode === "deal" || sampled > 400) continue;
    const speaker = whoseTurn(conv);
    const d = planTurn(w, structuredClone(conv), speaker);
    if (!d) continue;
    const me = w.citizens[speaker];
    const them = w.citizens[speaker === conv.a ? conv.b : conv.a];
    const size = contextSize(contextFor(w, conv, conv.dlg, me, them, d));
    ctxTotal += size;
    ctxMax = Math.max(ctxMax, size);
    sampled++;
  }
}
report(`TOWN ${seed}, ${days} days`, w, town);
console.log(`  sense check: ${audit.total()} problems in ${audit.chats} conversations${audit.total() ? ` (${[...audit.counts].map(([k, n]) => `${k} ${n}`).join(", ")})` : ""}`);
if (sampled) console.log(`  what a model is given per turn: ${Math.round(ctxTotal / sampled)} characters on average, ${ctxMax} at most (${sampled} turns sampled)`);

// ---- 2. who sounds like who
const half = Math.floor(town.length / 2);
const id = voiceIdentification(w, town.slice(0, half), town.slice(half));
console.log(`\nVOICES`);
console.log(`  telling who's talking with the names taken out: ${pct(id.accuracy)} right over ${id.tested} people (guessing: ${pct(id.chance)})`);
const vs = [...voiceStats(town)].sort((a, b) => b[1].avgWords - a[1].avgWords);
const fmt = ([cid, v]: [string, ReturnType<typeof voiceStats> extends Map<string, infer V> ? V : never]) => `${w.citizens[cid].name} ${v.avgWords.toFixed(1)} words, ${pct(v.questionRate)} questions${v.swearRate ? `, swears ${pct(v.swearRate)}` : ""}`;
console.log(`  wordiest: ${vs.slice(0, 3).map(fmt).join(" · ")}`);
console.log(`  quietest: ${vs.slice(-3).map(fmt).join(" · ")}`);

// ---- 3. the same two, again and again
const people = w.citizenOrder.map((cid) => w.citizens[cid]);
let [a, b] = [people[0], people[1]];
const pairArg = arg("pair", "");
if (pairArg) [a, b] = pairArg.split(",").map((i) => people[Number(i)]);
else {
  let best = -1;
  for (const x of people)
    for (const y of people) {
      const f = x.id < y.id ? (x.relationships[y.id]?.familiarity ?? 0) : -1;
      if (f > best) [best, a, b] = [f, x, y];
    }
}
const encounters: Conversation[] = [];
for (let n = 0; n < meets; n++) {
  // A day apart, in the early evening (the town carries on in between).
  const next = (Math.floor(w.time / 1440) + 1) * 1440 + 18 * 60;
  advance(w, next - w.time);
  const [x, y] = n % 2 ? [b, a] : [a, b];
  encounters.push(forceChat(w, x, y));
}
report(`${a.name} AND ${b.name}, ${meets} encounters a day apart`, w, encounters);
const topics = encounters.map((c) => new Set(c.dlg?.turns.filter((t) => t.move === "raise" && t.topic).map((t) => t.topic!) ?? []));
let again = 0;
for (let i = 1; i < topics.length; i++) for (const t of topics[i]) if (topics[i - 1].has(t)) again++;
console.log(`  the same topic as the time before: ${again} times · topics over all: ${new Set(topics.flatMap((s) => [...s])).size}`);
const shown = showArg === "all" ? encounters.length : Number(showArg);
encounters.slice(0, shown).forEach((c, i) => console.log(`\n  #${i + 1} (day ${Math.floor(c.startedT / 1440) + 1}, ${c.dlg?.mode}${c.dlg?.reason ? `: ${c.dlg.reason}` : ""})\n${transcript(w, c)}`));
if (shown < encounters.length) console.log(`\n  (${encounters.length - shown} more: --show all)`);

console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)} s`);
