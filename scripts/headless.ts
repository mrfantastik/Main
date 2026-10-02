// Headless simulation runner — the main debugging tool.
//
//   npm run sim -- --days 10 --seed 42
//   npm run sim -- --days 5 --seed 7 --explain Jake      (why did Jake do what he did?)
//   npm run sim -- --days 30 --quiet                      (just the summary)
//
// Runs the exact same engine as the server, with Claude switched off, so a
// given seed always produces the same story.

import { netWorth } from "../src/sim/economy/valuation";
import { newWorld, advance } from "../src/sim";
import { formatTime } from "../src/sim/time";
import type { WorldState } from "../src/sim/types";

const args = process.argv.slice(2);
const arg = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const days = Number(arg("days", "7"));
const seed = Number(arg("seed", "42"));
const explain = arg("explain");
const quiet = args.includes("--quiet");
const minImportance = Number(arg("importance", "2"));

const world: WorldState = newWorld(seed);
const t0 = performance.now();
let lastEvent = 0;
for (let d = 0; d < days; d++) {
  advance(world, 1440);
  const s = world.stats.daily[world.stats.daily.length - 1];
  if (!quiet) {
    console.log(`\n=== ${formatTime(world.time)} — money £${s?.totalMoney.toFixed(0)} · avg wealth £${s?.avgWealth.toFixed(0)} · unemployed ${Math.round((s?.unemployment ?? 0) * 100)}% · businesses ${s?.businesses} · gini ${s?.gini}`);
    for (const e of world.events) {
      if (e.id <= lastEvent || e.importance < minImportance) continue;
      console.log(`  [${formatTime(e.t)}] ${e.text}`);
    }
  }
  lastEvent = world.events[world.events.length - 1]?.id ?? lastEvent;
}
const ms = performance.now() - t0;

console.log(`\nSimulated ${days} days in ${(ms / 1000).toFixed(2)}s (seed ${seed}).\n`);
const rows = world.citizenOrder.map((id) => world.citizens[id]).map((c) => ({ c, nw: netWorth(world, c) })).sort((a, b) => b.nw - a.nw);
for (const { c, nw } of rows) {
  console.log(
    `${c.name.padEnd(7)} ${c.occupation.padEnd(12)} net £${nw.toFixed(0).padStart(6)}  cash £${c.money.toFixed(0).padStart(5)}  mood ${c.mood.toFixed(0).padStart(3)}  ${c.archetypes.join("/").padEnd(26)} 🎯 ${c.goal.label}`,
  );
}

if (explain) {
  const c = Object.values(world.citizens).find((x) => x.name.toLowerCase() === explain.toLowerCase());
  if (!c) {
    console.log(`No citizen called ${explain}`);
  } else {
    console.log(`\n────────── Why ${c.name} did what they did ──────────`);
    console.log(`Now: ${c.activity.label}. Thinking: "${c.thought}"`);
    const all = [...c.strategyLog, ...c.decisions].sort((a, b) => a.t - b.t);
    for (const d of all) {
      const chosen = d.options.find((o) => o.id === d.chosen);
      console.log(`\n[${formatTime(d.t)}] ${d.kind.toUpperCase()} via ${d.source} → ${chosen?.label}`);
      console.log(`   "${d.thought}"`);
      for (const o of d.options) {
        const f = Object.entries(o.factors).filter(([, v]) => Math.abs(v) >= 0.05).map(([k, v]) => `${k} ${v >= 0 ? "+" : ""}${v.toFixed(2)}`).join(", ");
        console.log(`   ${o.id === d.chosen ? "➜" : " "} ${o.score.toFixed(2).padStart(6)}  ${o.label}  [${f}]`);
      }
    }
    console.log(`\nMemories:`);
    for (const m of [...c.memories.long].sort((a, b) => a.t - b.t)) console.log(`  ⭐ [${formatTime(m.t)}] ${m.text} (importance ${m.importance.toFixed(0)})`);
    console.log(`\nRelationships:`);
    for (const [id, r] of Object.entries(c.relationships)) {
      if (r.familiarity < 5 && r.roles.length === 0) continue;
      console.log(`  ${world.citizens[id].name.padEnd(7)} affinity ${r.affinity.toFixed(0).padStart(4)} trust ${r.trust.toFixed(0).padStart(4)} ${r.roles.join(",")}`);
    }
  }
}
