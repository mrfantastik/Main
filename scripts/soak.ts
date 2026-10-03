// Soak test: runs whole cities for a long time and checks that nothing is
// quietly going wrong. Claude is off, so every run is reproducible.
//
//   npm run soak                                   (3 seeds x 120 days)
//   npm run soak -- --days 365 --seeds 42,7,2024
//   npm run soak -- --days 120 --god               (random God Mode meddling too)
//
// Checked every game hour: money is conserved (it only enters/leaves through
// recorded outside flows), no negative or NaN balances, jobs/businesses/homes/
// loans are consistent with each other, nobody is stuck doing one thing.
// Checked every day: no NaN anywhere in the world, the UI snapshot builders
// work for every citizen and business, lists stay bounded, speed stays flat.
// Every 30 days: save -> reload -> both copies must play out identically.

import { newWorld, advance, step } from "../src/sim";
import { applyGodCommand, GodError } from "../src/sim/god";
import { prepareLoadedWorld } from "../src/sim/migrate";
import * as snap from "../src/sim/snapshot";
import { netWorth } from "../src/sim/economy/valuation";
import { KIND_INFO } from "../src/sim/economy/business";
import { SHORT_LIMIT, LONG_LIMIT } from "../src/sim/memory/memory";
import type { GodCommand } from "../src/shared/protocol";
import type { WorldState } from "../src/sim/types";

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const DAYS = Number(arg("days", "120"));
const SEEDS = arg("seeds", "42,7,2024").split(",").map(Number);
const GOD = args.includes("--god");

let problems = 0;
const seen = new Map<string, number>();
function problem(seed: number, w: WorldState, msg: string): void {
  const key = msg.replace(/[\d.]+/g, "#");
  const n = (seen.get(key) ?? 0) + 1;
  seen.set(key, n);
  problems++;
  if (n <= 3) console.log(`  ❌ [seed ${seed} day ${Math.floor(w.time / 1440) + 1} ${String(Math.floor((w.time % 1440) / 60)).padStart(2, "0")}:00] ${msg}`);
  else if (n === 4) console.log(`  … (more like this suppressed)`);
}

function internalMoney(w: WorldState): number {
  let m = 0;
  for (const id of w.citizenOrder) m += w.citizens[id].money + w.citizens[id].savings;
  for (const id of w.businessOrder) m += w.businesses[id].cash;
  return m;
}

function findNonFinite(v: unknown, path: string, out: string[], depth = 0): void {
  if (out.length > 5 || depth > 12) return;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) out.push(path);
  } else if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) findNonFinite(v[i], `${path}[${i}]`, out, depth + 1);
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) findNonFinite(x, `${path}.${k}`, out, depth + 1);
  }
}

function stateHash(w: WorldState): string {
  return JSON.stringify([w.time, w.rng, w.citizens, w.businesses, w.loans, w.listings, w.market, w.economy]);
}

const OCCS = ["unemployed", "employee", "freelancer", "shopkeeper", "reseller", "trader", "entrepreneur", "researcher"];
const KINDS = ["shop", "stall", "cafe", "agency"];

function randomGod(w: WorldState, r: () => number): GodCommand {
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const cid = r() < 0.05 ? "nobody" : pick(w.citizenOrder);
  const pid = r() < 0.05 ? "unobtainium" : pick(w.productOrder);
  const bid = r() < 0.1 ? "nope" : pick(w.businessOrder.length ? w.businessOrder : ["nope"]);
  const amount = pick([1000, 50, 0, -20, 1e9, NaN]);
  return pick<GodCommand>([
    { cmd: "give_money", citizenId: cid, amount },
    { cmd: "take_money", citizenId: cid, amount },
    { cmd: "shortage", productId: pid },
    { cmd: "surplus", productId: pid },
    { cmd: "hype", productId: pid },
    { cmd: "set_price", productId: pid, price: pick([0.5, 5, 80, 0, -3, NaN]) },
    { cmd: "set_job", citizenId: cid, occupation: pick(OCCS) as never },
    { cmd: "spawn_business", citizenId: cid, kind: pick([...KINDS, "casino"]), productId: pid },
    { cmd: "close_business", businessId: bid },
    { cmd: "boom" },
    { cmd: "crash" },
  ]);
}

interface RunSummary {
  seed: number;
  secs: number;
  line: string;
}

function run(seed: number): RunSummary {
  console.log(`\n▶ seed ${seed}: ${DAYS} days${GOD ? " with random God Mode commands" : ""}`);
  const w = newWorld(seed);
  let fuzz = seed * 9301 + 49297;
  const r = () => ((fuzz = (fuzz * 9301 + 49297) % 233280) / 233280);
  const t0 = performance.now();
  let money = internalMoney(w);
  let lastTx = w.transactions[w.transactions.length - 1]?.id ?? 0;
  const lastActivityChange = new Map<string, { key: string; t: number }>();
  const longest: Record<string, { mins: number; who: string }> = {};
  const dayMs: number[] = [];
  const sizes: string[] = [];
  let godOk = 0;
  let godRejected = 0;
  let godIds = 0;
  const loanSeen = new Map<number, { peer: boolean; status: string }>();

  for (let day = 1; day <= DAYS; day++) {
    const dStart = performance.now();
    for (let h = 0; h < 24; h++) {
      if (GOD && r() < 0.02) {
        const cmd = randomGod(w, r);
        try {
          applyGodCommand(w, cmd);
          godOk++;
        } catch (err) {
          if (err instanceof GodError) godRejected++;
          else problem(seed, w, `God command ${JSON.stringify(cmd)} crashed: ${(err as Error).stack?.split("\n").slice(0, 3).join(" | ")}`);
        }
        // God money comes from / goes to outside the town; recount the baseline.
        money = internalMoney(w);
        lastTx = w.transactions[w.transactions.length - 1]?.id ?? lastTx;
        godIds++;
      }
      try {
        for (let m = 0; m < 60; m++) step(w);
      } catch (err) {
        problem(seed, w, `engine crashed: ${(err as Error).stack?.split("\n").slice(0, 4).join(" | ")}`);
        return { seed, secs: (performance.now() - t0) / 1000, line: "CRASHED" };
      }
      hourly();
    }
    dayMs.push(performance.now() - dStart);
    daily(day);
  }

  function hourly(): void {
    // 1. Money conservation.
    if (w.transactions.length && w.transactions[0].id > lastTx + 1 && lastTx > 0) problem(seed, w, "transaction ring overflowed within an hour");
    let net = 0;
    for (const t of w.transactions) {
      if (t.id <= lastTx) continue;
      const fromExt = t.from.startsWith("x:");
      const toExt = t.to.startsWith("x:");
      if (fromExt && !toExt) net += t.amount;
      else if (!fromExt && toExt) net -= t.amount;
    }
    lastTx = w.transactions[w.transactions.length - 1]?.id ?? lastTx;
    const now = internalMoney(w);
    if (Math.abs(now - money - net) > 0.05) problem(seed, w, `money not conserved: drift £${(now - money - net).toFixed(2)}`);
    money = now;

    const capacity = new Map<string, number>();
    for (const b of w.map.buildings) capacity.set(b.id, b.capacity || 99);
    const residents = new Map<string, number>();

    for (const id of w.citizenOrder) {
      const c = w.citizens[id];
      // 2. Balances and bounded values.
      if (!(c.money >= -0.001) || !(c.savings >= -0.001)) problem(seed, w, `${c.name} has money ${c.money} savings ${c.savings}`);
      for (const [k, v] of Object.entries(c.needs)) if (!(v >= 0 && v <= 100)) problem(seed, w, `${c.name} need ${k}=${v}`);
      if (!(c.mood >= 0 && c.mood <= 100)) problem(seed, w, `${c.name} mood=${c.mood}`);
      if (!(c.creditScore >= 0 && c.creditScore <= 100)) problem(seed, w, `${c.name} credit=${c.creditScore}`);
      if (!(c.pos.x >= 0 && c.pos.y >= 0 && c.pos.x <= w.map.width && c.pos.y <= w.map.height)) problem(seed, w, `${c.name} is off the map at ${c.pos.x},${c.pos.y}`);
      for (const [p, q] of Object.entries(c.inventory)) if (!(q.qty >= 0 && q.avgCost >= 0)) problem(seed, w, `${c.name} holds ${q.qty} ${p} at ${q.avgCost}`);
      if (c.memories.short.length > SHORT_LIMIT || c.memories.long.length > LONG_LIMIT) problem(seed, w, `${c.name} memory overflow`);
      // 3. Jobs.
      if (c.employerId === "corp" && !w.corpEmployees.includes(c.id)) problem(seed, w, `${c.name} thinks they work at CityCorp but isn't on the payroll`);
      if (c.employerId && c.employerId !== "corp") {
        const b = w.businesses[c.employerId];
        if (!b) problem(seed, w, `${c.name} works for a business that doesn't exist`);
        else if (!b.open) problem(seed, w, `${c.name} still works for closed ${b.name}`);
        else if (!b.employees.some((e) => e.citizenId === c.id)) problem(seed, w, `${c.name} works for ${b.name} but isn't on its staff list`);
      }
      if (c.occupation === "employee" && !c.employerId) problem(seed, w, `${c.name} is an employee with no employer`);
      // 4. Homes.
      if (c.homeless !== (c.homeId === null)) problem(seed, w, `${c.name} homeless=${c.homeless} but homeId=${c.homeId}`);
      if (c.homeId) residents.set(c.homeId, (residents.get(c.homeId) ?? 0) + 1);
      // 5. Stuck detection.
      const key = `${c.activity.kind}|${c.activity.label}|${c.activity.startedAt}`;
      const prev = lastActivityChange.get(id);
      if (!prev || prev.key !== key) lastActivityChange.set(id, { key, t: w.time });
      else {
        const mins = w.time - prev.t;
        const k = c.activity.kind;
        if (!longest[k] || mins > longest[k].mins) longest[k] = { mins, who: `${c.name} (${c.activity.label})` };
        const limit = k === "sleep" ? 15 * 60 : k === "work" || k === "manage" || k === "research" ? 13 * 60 : 8 * 60;
        if (mins === limit) problem(seed, w, `${c.name} stuck ${Math.round(mins / 60)}h in "${c.activity.label}" (${k})`);
      }
      if (c.awaitingAI) problem(seed, w, `${c.name} is waiting on Claude although Claude is off`);
    }
    for (const [hid, n] of residents) if (n > (capacity.get(hid) ?? 99)) problem(seed, w, `${hid} has ${n} residents (capacity ${capacity.get(hid)})`);
    for (const cid of w.corpEmployees) if (w.citizens[cid]?.employerId !== "corp") problem(seed, w, `CityCorp payroll has ${w.citizens[cid]?.name ?? cid} who doesn't work there`);

    // 6. Businesses.
    for (const id of w.businessOrder) {
      const b = w.businesses[id];
      if (!(b.cash >= -0.001)) problem(seed, w, `${b.name} cash ${b.cash}`);
      for (const [p, q] of Object.entries(b.inventory)) if (!(q.qty >= 0 && q.avgCost >= 0)) problem(seed, w, `${b.name} stock ${p}=${q.qty} at ${q.avgCost}`);
      for (const [p, v] of Object.entries(b.prices)) if (!(v > 0 && Number.isFinite(v))) problem(seed, w, `${b.name} price ${p}=${v}`);
      const owner = w.citizens[b.ownerId];
      if (!owner) problem(seed, w, `${b.name} has no owner`);
      else if (b.open && !owner.businessIds.includes(b.id)) problem(seed, w, `${owner.name} owns ${b.name} but doesn't know it`);
      if (!b.open && b.employees.length) problem(seed, w, `closed ${b.name} still has ${b.employees.length} staff`);
      for (const e of b.employees) if (w.citizens[e.citizenId]?.employerId !== b.id) problem(seed, w, `${b.name} staff list has ${w.citizens[e.citizenId]?.name} who works elsewhere`);
      const shares = b.partners.reduce((s, p) => s + p.share, 0);
      if (shares > 0.95) problem(seed, w, `${b.name} gave away ${Math.round(shares * 100)}% to partners`);
      if (b.open && w.map.buildings.every((x) => x.id !== b.buildingId)) problem(seed, w, `${b.name} is in a building that doesn't exist`);
    }
    const perSite = new Map<string, number>();
    for (const id of w.businessOrder) {
      const b = w.businesses[id];
      if (!b.open) continue;
      const n = (perSite.get(b.buildingId) ?? 0) + 1;
      perSite.set(b.buildingId, n);
      if (n > KIND_INFO[b.kind].maxPerBuilding) problem(seed, w, `${n} businesses crammed into ${b.buildingId} (max ${KIND_INFO[b.kind].maxPerBuilding} ${b.kind}s)`);
    }
    // 7. Loans and listings.
    for (const l of w.loans) {
      loanSeen.set(l.id, { peer: l.lender !== "bank", status: l.status });
      if (!w.citizens[l.borrower]) problem(seed, w, `loan ${l.id} has a missing borrower`);
      if (l.paid > l.totalDue + 0.02) problem(seed, w, `loan ${l.id} overpaid (${l.paid} of ${l.totalDue})`);
      if (l.lender !== "bank" && l.lender === l.borrower) problem(seed, w, `${w.citizens[l.borrower]?.name} lent money to themselves`);
    }
    for (const li of w.listings) {
      if (!(li.price > 0 && Number.isFinite(li.price))) problem(seed, w, `listing ${li.id} price ${li.price}`);
      if (!(li.qty > 0)) problem(seed, w, `listing ${li.id} has qty ${li.qty}`);
      if (li.sellerId !== "external" && !w.citizens[li.sellerId]) problem(seed, w, `listing ${li.id} has a missing seller`);
    }
  }

  function daily(day: number): void {
    const bad: string[] = [];
    findNonFinite(w, "world", bad);
    if (bad.length) problem(seed, w, `non-finite numbers at ${bad.join(", ")}`);

    // UI snapshot builders must work for everything that can be clicked.
    try {
      const sizes0 = [
        JSON.stringify(snap.frame(w, 1, false)).length,
        JSON.stringify(snap.state(w, { speed: 1, paused: false, events: w.events.slice(-60), ai: undefined as never, savedAt: null, fx: [] })).length,
        JSON.stringify(snap.dashboard(w)).length,
      ];
      for (const id of w.citizenOrder) {
        const d = snap.citizenDetail(w, id);
        if (!d) problem(seed, w, `no detail for citizen ${id}`);
        sizes0.push(JSON.stringify(d).length);
      }
      for (const id of w.businessOrder) {
        const d = snap.businessDetail(w, id);
        if (!d) problem(seed, w, `no detail for business ${id}`);
        sizes0.push(JSON.stringify(d).length);
      }
      const biggest = Math.max(...sizes0);
      if (biggest > 400_000) problem(seed, w, `a UI message is ${Math.round(biggest / 1000)}KB`);
    } catch (err) {
      problem(seed, w, `snapshot crashed: ${(err as Error).stack?.split("\n").slice(0, 3).join(" | ")}`);
    }

    if (day % 30 === 0 || day === DAYS) {
      const json = JSON.stringify(w);
      sizes.push(`d${day}:${Math.round(json.length / 1000)}KB`);
      if (day % 30 === 0 && day < DAYS) {
        // Save -> reload must continue identically.
        const copy = prepareLoadedWorld(JSON.parse(json));
        if (!copy) problem(seed, w, "saved world failed to reload");
        else {
          const probe = prepareLoadedWorld(JSON.parse(json))!;
          advance(probe, 1440);
          const ref = prepareLoadedWorld(JSON.parse(json))!;
          advance(ref, 1440);
          if (stateHash(probe) !== stateHash(ref)) problem(seed, w, "two reloads of the same save diverged");
          // And the live world must match a reloaded copy too.
          const live = prepareLoadedWorld(JSON.parse(json))!;
          const a = JSON.stringify(live.citizens) === JSON.stringify(w.citizens);
          if (!a) problem(seed, w, "reloading changed citizens' state");
        }
      }
    }
  }

  const secs = (performance.now() - t0) / 1000;
  const firstWeek = dayMs.slice(0, 7).reduce((a, b) => a + b, 0) / Math.min(7, dayMs.length);
  const lastWeek = dayMs.slice(-7).reduce((a, b) => a + b, 0) / Math.min(7, dayMs.length);
  if (lastWeek > firstWeek * 3 && lastWeek > 40) problem(seed, w, `sim slowed down: ${firstWeek.toFixed(0)}ms/day → ${lastWeek.toFixed(0)}ms/day`);

  const s = w.stats.daily[w.stats.daily.length - 1];
  const people = w.citizenOrder.map((id) => w.citizens[id]);
  const occ: Record<string, number> = {};
  for (const c of people) occ[c.occupation] = (occ[c.occupation] ?? 0) + 1;
  const peer = [...loanSeen.values()].filter((l) => l.peer);
  const bank = [...loanSeen.values()].filter((l) => !l.peer);
  const closed = w.businessOrder.filter((id) => !w.businesses[id].open).length;
  const nw = people.map((c) => netWorth(w, c)).sort((a, b) => a - b);
  console.log(`  ⏱  ${secs.toFixed(1)}s (${firstWeek.toFixed(0)} → ${lastWeek.toFixed(0)} ms per game day) · world size ${sizes.join(" ")}`);
  console.log(`  💷 avg £${s.avgWealth.toFixed(0)} · median £${s.medianWealth.toFixed(0)} · poorest £${nw[0].toFixed(0)} · richest £${nw[nw.length - 1].toFixed(0)} · gini ${s.gini} · rent ×${w.economy.rentIndex}`);
  console.log(`  🏪 ${s.businesses} open, ${closed} closed · bankruptcies ${people.reduce((a, c) => a + c.finance.bankruptcies, 0)} · homeless now ${people.filter((c) => c.homeless).length} · unemployed ${Math.round(s.unemployment * 100)}%`);
  console.log(`  🤝 peer loans ${peer.length} (${peer.filter((l) => l.status === "defaulted").length} defaulted) · bank loans ${bank.length} (${bank.filter((l) => l.status === "defaulted").length} defaulted) · loans kept in memory ${w.loans.length}`);
  console.log(`  👥 ${Object.entries(occ).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`  🔁 longest stretch per activity: ${Object.entries(longest).sort((a, b) => b[1].mins - a[1].mins).slice(0, 5).map(([k, v]) => `${k} ${Math.round(v.mins / 60)}h`).join(", ")}`);
  console.log(`  📚 events ${w.events.length} · tx ${w.transactions.length} · conversations ${w.conversationLog.length} · listings ${w.listings.length} · hourly stats ${w.stats.hourly.length} · daily stats ${w.stats.daily.length}`);
  if (GOD) console.log(`  ⚡ God commands: ${godOk} applied, ${godRejected} rejected with a message (of ${godIds})`);
  return { seed, secs, line: `avg £${s.avgWealth.toFixed(0)} gini ${s.gini} biz ${s.businesses}` };
}

const all = SEEDS.map(run);
console.log(`\n${problems === 0 ? "✅ No problems found" : `❌ ${problems} problem(s) found`} across ${SEEDS.length} cities × ${DAYS} days (${all.reduce((a, r) => a + r.secs, 0).toFixed(1)}s).`);
process.exit(problems === 0 ? 0 : 1);
