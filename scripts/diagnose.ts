// Economy diagnostics: money flows by kind, businesses, occupations.
//   npx tsx scripts/diagnose.ts --days 20 --seed 42
import { newWorld, advance } from "../src/sim";
import { netWorth } from "../src/sim/economy/valuation";

const args = process.argv.slice(2);
const arg = (n: string, d: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const days = Number(arg("days", "20"));
const seed = Number(arg("seed", "42"));
const w = newWorld(seed);
const flows: Record<string, number> = {};
let lastTx = 0;
for (let d = 0; d < days; d++) {
  advance(w, 1440);
  for (const t of w.transactions) {
    if (t.id <= lastTx) continue;
    const dir = t.from.startsWith("x:") ? "IN " : t.to.startsWith("x:") ? "OUT" : "int";
    const key = `${dir} ${t.kind.padEnd(12)} ${t.from.startsWith("x:") ? t.from : t.to.startsWith("x:") ? t.to : ""}`;
    flows[key] = (flows[key] ?? 0) + t.amount;
  }
  lastTx = w.transactions[w.transactions.length - 1]?.id ?? lastTx;
}
console.log(`\nMoney flows over ${days} days (per day):`);
for (const [k, v] of Object.entries(flows).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(38)} £${(v / days).toFixed(0).padStart(6)}`);
console.log("\nBusinesses:");
for (const id of w.businessOrder) {
  const b = w.businesses[id];
  console.log(`  ${b.open ? "OPEN  " : "CLOSED"} ${b.name.padEnd(28)} ${b.kind.padEnd(7)} owner ${w.citizens[b.ownerId].name.padEnd(7)} cash £${b.cash.toFixed(0).padStart(5)} avgProfit £${b.avgProfit.toFixed(0).padStart(5)} totProfit £${b.totalProfit.toFixed(0).padStart(6)} staff ${b.employees.length} rep ${b.reputation.toFixed(0)} prices ${b.products.map((p) => `${p}:${b.prices[p]}`).join(",")} ${b.closedReason ?? ""}`);
}
console.log("\nMarket:");
for (const pid of w.productOrder) {
  const m = w.market[pid];
  console.log(`  ${pid.padEnd(12)} wholesale £${m.wholesale.toFixed(2).padStart(7)} retail £${m.retail.toFixed(2).padStart(7)} trend ${m.trend.toFixed(2)} soldTotal ${m.soldTotal} unmetYday ${m.unmetYesterday}`);
}
const occ: Record<string, number[]> = {};
for (const id of w.citizenOrder) {
  const c = w.citizens[id];
  (occ[c.occupation] ??= []).push(c.finance.occupationEarnings.slice(-5).reduce((a, b) => a + b, 0) / Math.max(1, c.finance.occupationEarnings.slice(-5).length));
}
console.log("\nOccupational earnings (avg last 5 days):");
for (const [o, v] of Object.entries(occ)) console.log(`  ${o.padEnd(12)} n=${v.length} avg £${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(0)}  [${v.map((x) => x.toFixed(0)).join(", ")}]`);
console.log("\nStreet income beliefs:", JSON.stringify(w.economy.streetIncome));
console.log("Listings:", w.listings.length, "external:", w.listings.filter((l) => l.sellerId === "external").length);
console.log("Loans:", w.loans.map((l) => `${l.lender}->${w.citizens[l.borrower].name} £${l.principal} ${l.status}`).join("; "));
console.log("Avg net worth:", (w.citizenOrder.reduce((s, id) => s + netWorth(w, w.citizens[id]), 0) / w.citizenOrder.length).toFixed(0));
