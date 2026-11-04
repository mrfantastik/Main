// The agent bench: put the town's ten AI agents in it, let it run for days
// with nobody touching anything, and report what happened to each of them:
// what they wanted, what they planned and how it went, what they decided
// (and whether the AI or the built-in judgement decided it), who they fell
// in or out with, and what the town made of them. Run it with different
// seeds to see the towns turn out differently.
//
//   npm run agents                          (town 42, 7 days, every agent)
//   npm run agents -- --seed 7 --days 10 --agent Mei --all
//
//   --seed N      which town
//   --days N      how long it runs
//   --agent NAME  just this one (in full)
//   --all         include "carried on with the day" decisions

import { advance, newWorld } from "../src/sim";
import { dayOf } from "../src/sim/time";
import { actionLabel } from "../src/sim/society/prompt";
import { alliesOf, reputationOf } from "../src/sim/society/reputation";
import { societyOf, societyWorld } from "../src/sim/society/state";
import type { Citizen } from "../src/sim/types";

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? def) : def;
};
const seed = Number(arg("seed", "42"));
const days = Number(arg("days", "7"));
const only = arg("agent", "");
const all = args.includes("--all");

const w = newWorld(seed);
advance(w, 60);
const roster = societyWorld(w).roster.map((id) => w.citizens[id]);
const name = (id?: string | null) => (id ? (w.citizens[id]?.name ?? id) : "");
const start = new Map(roster.map((c) => [c.id, { money: c.money + c.savings, rel: Object.fromEntries(Object.entries(c.relationships).map(([k, r]) => [k, { affinity: r.affinity, roles: [...r.roles] }])) }]));
const t0 = Date.now();
advance(w, days * 1440);
const ms = Date.now() - t0;

const when = (t: number) => `day ${dayOf(t)} ${String(Math.floor((t % 1440) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
const line = (s = "") => console.log(s);

line(`Town ${seed}: ${days} days with nobody touching it (${ms} ms). The AI's ${roster.length} agents (built-in judgement standing in: no language model here):`);
line(roster.map((c) => `${c.name} (${c.occupation}, ${c.personality.style})`).join(", "));

function relChanges(c: Citizen): string[] {
  const before = start.get(c.id)!.rel;
  const out: { s: string; d: number }[] = [];
  for (const [id, r] of Object.entries(c.relationships)) {
    const b = before[id];
    const d = r.affinity - (b?.affinity ?? 0);
    const newRoles = r.roles.filter((x) => !(b?.roles ?? []).includes(x));
    const lost = (b?.roles ?? []).filter((x) => !r.roles.includes(x));
    if (Math.abs(d) >= 15 || newRoles.length || lost.length) out.push({ s: `${name(id)} ${d >= 0 ? "+" : ""}${Math.round(d)}${newRoles.length ? ` (now ${newRoles.join(", ")})` : ""}${lost.length ? ` (no longer ${lost.join(", ")})` : ""}`, d: Math.abs(d) + (newRoles.length || lost.length ? 100 : 0) });
  }
  return out.sort((x, y) => y.d - x.d).slice(0, 5).map((x) => x.s);
}

function report(c: Citizen): void {
  const s = societyOf(w, c);
  const was = start.get(c.id)!;
  line();
  line(`━━ ${c.name} ${c.surname}, ${c.age}, ${c.occupation} · £${Math.round(was.money)} → £${Math.round(c.money + c.savings)}`);
  line(`   wants: ${s.goals.map((g) => `${g.text}${g.who ? ` (${name(g.who)})` : ""}${g.status !== "active" ? ` [${g.status}]` : ""}`).join("; ")}`);
  for (const p of s.projects) {
    line(`   plan: ${p.title} [${p.status}]${p.need ? ` £${p.raised}/${p.need} promised` : ""}${p.partners.length ? `, in with them: ${p.partners.map(name).join(", ")}` : ""}${p.refused.length ? `, said no: ${p.refused.map(name).join(", ")}` : ""}`);
    for (const l of p.log.slice(-4)) line(`         ${when(l.t)} ${l.good ? "+" : "-"} ${l.text}`);
  }
  const ds = s.decisions.filter((d) => all || d.action.type !== "carry_on");
  for (const d of ds.slice(-12)) line(`   ${when(d.t)}  ${d.source === "llm" ? "AI   " : "rules"} ${actionLabel(w, d.action)} → ${d.status}${d.result ? `: ${d.result}` : ""}${d.error && d.status === "rejected" ? ` (${d.error})` : ""}`);
  const rc = relChanges(c);
  if (rc.length) line(`   people: ${rc.join("; ")}`);
  const rep = reputationOf(w, c);
  line(`   the town: standing ${rep.standing}${rep.tags.length ? `, ${rep.tags.join(", ")}` : ""}${alliesOf(w, c).length ? `; on their side: ${alliesOf(w, c).map((x) => `${name(x.ally)} vs ${name(x.against)}`).join(", ")}` : ""}`);
  for (const d of s.days.slice(-3)) line(`   day ${d.day}: ${d.text}`);
}

for (const c of roster.filter((x) => !only || x.name.toLowerCase() === only.toLowerCase())) report(c);

// The town as a whole.
const decisions = w.citizenOrder.flatMap((id) => societyOf(w, w.citizens[id]).decisions);
const by = (k: string) => decisions.filter((d) => d.action.type === k).length;
line();
line(`━━ The town`);
line(`   decisions (still in the logs): ${decisions.length}; talk ${by("talk")}, deals ${by("propose_deal")}, work ${by("seek_work")}, plans ${by("start_project")}, help/lend ${by("help") + by("lend")}, price wars ${by("compete")}, rows ${by("confront")}, making up ${by("make_up")}, asking out ${by("ask_out")}, rumours ${by("spread_rumour")}`);
const conv = w.conversationLog;
const deals = conv.filter((c) => c.dlg?.deal);
line(`   recent conversations: ${conv.length} (${conv.filter((c) => c.group && c.group.members.length >= 3).length} groups of three or more; ${deals.length} negotiations: ${deals.filter((c) => c.dlg!.deal!.status === "agreed").length} agreed, ${deals.filter((c) => c.dlg!.deal!.status === "declined").length} turned down)`);
const couples = w.citizenOrder.flatMap((id) => Object.entries(w.citizens[id].relationships).filter(([o, r]) => r.roles.includes("couple") && id < o).map(([o]) => `${name(id)} & ${name(o)}`));
line(`   couples: ${couples.join(", ") || "none"}`);
const rivals = w.citizenOrder.flatMap((id) => Object.entries(w.citizens[id].relationships).filter(([o, r]) => r.roles.includes("rival") && id < o).map(([o]) => `${name(id)} v ${name(o)}`));
line(`   rivals: ${rivals.join(", ") || "none"}`);
for (const r of societyWorld(w).rumours) line(`   story: "${r.text}" (started by ${name(r.origin)}, ${r.truth === false ? "made up" : r.truth ? "true" : "unclear"}; ${r.heard} believed it, ${r.exposed?.length ?? 0} saw through it)`);
line(`   lately: ${w.events.slice(-6).map((e) => e.text).join(" | ")}`);


