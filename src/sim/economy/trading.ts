import { registerAction } from "../ai/actions";
import { recordDecision, setThought, type Option } from "../ai/decision";
import { situation } from "../ai/situation";
import { logEvent } from "../events";
import { remember } from "../memory/memory";
import { gauss } from "../rng";
import type { Citizen, WorldState } from "../types";
import { money, round2 } from "../util";
import { ensureCash } from "./bank";
import { citizenAcc, creditOccupation, externalAcc, transfer } from "./ledger";
import { addStock, removeStock } from "./market";

// Traders speculate on wholesale prices at the Exchange (inside the bank).
// Risk-takers chase momentum; cautious traders buy dips. Skill reduces
// mistakes; research insights give a real edge. Their own buying and selling
// pushes prices — so a crowd of momentum traders can inflate a bubble.

export const SPREAD = 0.01;

/**
 * How many units the Exchange absorbs before the price moves ~10%. Big orders
 * move the price against the trader *as they fill*, so nobody can buy a
 * mountain of stock, push the price up and sell into their own pump.
 */
export function marketDepth(world: WorldState, pid: string): number {
  return Math.max(3, world.products[pid].externalDemand * 5);
}
const IMPACT = 0.1;

/** Fill an order: returns the average price paid/received and moves the market. */
function fill(world: WorldState, pid: string, qty: number, side: "buy" | "sell"): number {
  const m = world.market[pid];
  const p = world.products[pid];
  const move = (IMPACT * qty) / marketDepth(world, pid);
  const dir = side === "buy" ? 1 : -1;
  const avg = m.wholesale * (1 + dir * SPREAD) * (1 + (dir * move) / 2);
  m.wholesale = round2(Math.min(p.baseCost * 4, Math.max(p.baseCost * 0.35, m.wholesale * (1 + dir * move))));
  return round2(Math.max(0.01, avg));
}

/** Largest position a trader will hold in one product. */
export function maxPosition(world: WorldState, c: Citizen, pid: string): number {
  return Math.floor(marketDepth(world, pid) * (0.4 + c.traits.risk * 0.6));
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
}

export interface Signal {
  pid: string;
  signal: number;
  factors: Record<string, number>;
}

export function tradingSignals(world: WorldState, c: Citizen): Signal[] {
  const out: Signal[] = [];
  for (const pid of world.productOrder) {
    const m = world.market[pid];
    const tape = m.tape.length ? m.tape : [m.wholesale];
    const fast = mean(tape.slice(-6));
    const slow = mean(tape);
    const momentum = (m.wholesale - fast) / fast + (fast - mean(tape.slice(-12, -6).length ? tape.slice(-12, -6) : tape)) / fast;
    const reversion = (slow - m.wholesale) / slow;
    const factors: Record<string, number> = {
      momentum: c.traits.risk * momentum * 3,
      dip: (1 - c.traits.risk) * reversion * 2.5,
      hype: (m.trend - 1) * 0.12,
      noise: gauss(world) * 0.05 * (1 - c.skills.trading / 100),
    };
    const insight = c.beliefs.insights.find((i) => i.productId === pid && i.startT > world.time - 1440 && i.startT < world.time + 3 * 1440);
    if (insight) factors.insight = insight.kind === "hype" ? 0.15 : -0.15;
    const signal = Object.values(factors).reduce((a, b) => a + b, 0);
    out.push({ pid, signal, factors });
  }
  return out;
}

export function runTradingSession(world: WorldState, c: Citizen): string {
  const s = situation(world, c);
  const signals = tradingSignals(world, c).sort((a, b) => b.signal - a.signal);
  const notes: string[] = [];
  const options: Option<null>[] = [];
  // Fear makes traders twitchy: they need a stronger signal and bet less.
  const fear = c.emotions.fear / 100;
  const buyThreshold = 0.03 + (1 - c.traits.risk) * 0.015 + fear * 0.03;

  // Sell first: take profits, cut losses, or exit on a bad signal.
  for (const sig of signals) {
    const it = c.inventory[sig.pid];
    if (!it || it.qty <= 0) continue;
    const m = world.market[sig.pid];
    const price = round2(m.wholesale * (1 - SPREAD));
    const change = (price - it.avgCost) / it.avgCost;
    const takeProfit = change >= 0.05 * (1 + c.traits.greed);
    const stopLoss = change <= -0.07 * (0.5 + c.traits.risk);
    const sell = takeProfit || stopLoss || sig.signal < -0.02;
    options.push({
      id: `sell:${sig.pid}`,
      label: `Sell ${it.qty}× ${world.products[sig.pid].name} at ${money(price)} (${change >= 0 ? "+" : ""}${Math.round(change * 100)}%)`,
      factors: { ...sig.factors, takeProfit: takeProfit ? 0.3 : 0, stopLoss: stopLoss ? 0.3 : 0 },
      payload: null,
      thought: "",
    });
    if (!sell) continue;
    const qty = it.qty;
    const unitCost = removeStock(c.inventory, sig.pid, qty);
    const fillPrice = fill(world, sig.pid, qty, "sell");
    const total = round2(fillPrice * qty);
    transfer(world, externalAcc("exchange"), citizenAcc(c.id), total, "trade", `Sold ${qty}× ${world.products[sig.pid].name} on the Exchange`);
    const profit = round2((fillPrice - unitCost) * qty);
    creditOccupation(world, c.id, profit);
    notes.push(`${profit >= 0 ? "made" : "lost"} ${money(Math.abs(profit))} on ${world.products[sig.pid].name}`);
    if (Math.abs(profit) >= 60) {
      logEvent(world, "finance", `${profit >= 0 ? "📈" : "📉"} ${c.name} ${profit >= 0 ? "made" : "lost"} ${money(Math.abs(profit))} trading ${world.products[sig.pid].name}.`, 3, [c.id]);
      remember(world, c, { text: `I ${profit >= 0 ? "made" : "lost"} ${money(Math.abs(profit))} trading ${world.products[sig.pid].name}.`, kind: "financial", importance: 6, valence: profit >= 0 ? 0.7 : -0.7, people: [] });
    }
  }

  // Then buy the strongest signals.
  let budget = Math.max(0, (s.liquid - s.dailyCost * 3) * (0.4 + c.traits.risk * 0.5) * (1 - fear * 0.4));
  for (const sig of signals.slice(0, 3)) {
    const m = world.market[sig.pid];
    const price = round2(m.wholesale * (1 + SPREAD));
    options.push({ id: `buy:${sig.pid}`, label: `Buy ${world.products[sig.pid].name} at ${money(price)}`, factors: sig.factors, payload: null, thought: "" });
    if (sig.signal < buyThreshold || budget < price) continue;
    const room = maxPosition(world, c, sig.pid) - (c.inventory[sig.pid]?.qty ?? 0);
    const qty = Math.min(room, Math.floor((budget * 0.6) / price));
    if (qty <= 0) continue;
    // Quote the whole order (including its price impact) before committing.
    const move = (IMPACT * qty) / marketDepth(world, sig.pid);
    const quote = round2(price * (1 + move / 2) * qty);
    if (quote > budget || !ensureCash(c, quote)) continue;
    const fillPrice = fill(world, sig.pid, qty, "buy");
    const total = round2(fillPrice * qty);
    if (!transfer(world, citizenAcc(c.id), externalAcc("exchange"), total, "trade", `Bought ${qty}× ${world.products[sig.pid].name} on the Exchange`)) continue;
    addStock(c.inventory, sig.pid, qty, fillPrice);
    budget -= total;
    const why = sig.factors.insight ? "my research tip says it's about to boom" : sig.factors.momentum > sig.factors.dip ? "the price has momentum" : "it's below its usual price";
    notes.push(`bought ${qty}× ${world.products[sig.pid].name} at ${money(fillPrice)} because ${why}`);
  }
  c.skills.trading = Math.min(100, c.skills.trading + 0.4);

  const thought = notes.length ? `Trading session: ${notes.join("; ")}.` : "Nothing on the Exchange looks good today. Sitting on my hands.";
  options.push({ id: "hold", label: "Hold / do nothing", factors: { patience: 0.03 }, payload: null, thought });
  const chosen = notes.length ? options.find((o) => o.id.startsWith(notes[0].startsWith("bought") ? "buy" : "sell")) ?? options[options.length - 1] : options[options.length - 1];
  recordDecision(world, c, "reaction", options, chosen, "utility", thought);
  setThought(world, c, thought, 3);
  return thought;
}

export function registerTradingActions(): void {
  registerAction("TRADE", {
    kind: "trade",
    validate: (_w, c) => (c.occupation === "trader" ? null : "Not a trader"),
    complete(world, c, _a, minutes) {
      c.workedToday += minutes;
      if (minutes >= 20) runTradingSession(world, c);
    },
  });
}
