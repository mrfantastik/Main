// Runs whole towns and checks every conversation for nonsense (see
// src/sim/social/coherence.ts): answers to questions nobody asked, questions
// left hanging, big reactions to small things, "lunch" at night, unanswered
// goodbyes, repeated lines, "Day 12" said out loud, wrong opinions, voice tics.
//
//   npm run chatcheck                          (3 towns x 14 days)
//   npm run chatcheck -- --days 30 --seeds 42,7,99 --show 3

import { advance, newWorld } from "../src/sim";
import { ChatAudit } from "../src/sim/social/coherence";

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const days = Number(arg("days", "14"));
const seeds = arg("seeds", "42,7,99").split(",").map(Number);
const show = Number(arg("show", "2"));

const audit = new ChatAudit();
const t0 = Date.now();
for (const seed of seeds) {
  const w = newWorld(seed);
  const seen = new Set<number>();
  for (let h = 0; h < days * 24; h++) {
    advance(w, 60);
    for (const c of w.conversationLog) {
      if (c.status !== "done" || seen.has(c.id)) continue;
      seen.add(c.id);
      audit.add(w, c);
    }
  }
}
console.log(`\n${audit.chats} conversations, ${audit.lines} lines, ${seeds.length} towns x ${days} days (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
console.log(`${audit.total()} problems (${((100 * audit.total()) / Math.max(1, audit.chats)).toFixed(1)} per 100 chats)\n`);
for (const [kind, n] of [...audit.counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${kind}`);
  for (const ex of (audit.examples.get(kind) ?? []).slice(0, show)) console.log(ex.replace(/^/gm, "         ") + "\n");
}
