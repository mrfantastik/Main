import { registerAction } from "../ai/actions";
import { recordDecision, setThought, type Option } from "../ai/decision";
import { situation } from "../ai/situation";
import { logEvent } from "../events";
import { remember } from "../memory/memory";
import { gauss } from "../rng";
import type { Citizen, WorldState } from "../types";
import { money, round2 } from "../util";
import { ensureCash } from "./bank";
import { sellersOf } from "./business";
import { addListing, buyListing, delist, listingsFor, refPrice, removeStock } from "./market";

// Resellers scan the Marketplace for listings priced below what goods
// usually sell for, buy them, and relist at a profit. Their skill decides
// how accurately they value things; competition from other resellers (and
// from shops) squeezes their margins.

/** Goods a citizen keeps for themselves rather than reselling. */
function keepForSelf(pid: string, qty: number): number {
  return pid === "food" ? Math.min(qty, 3) : 0;
}

export function runResellerSession(world: WorldState, c: Citizen): string {
  const s = situation(world, c);
  const notes: string[] = [];
  const options: Option<null>[] = [];

  // Personal valuation of each product (skill = accuracy).
  const estimate: Record<string, number> = {};
  for (const pid of world.productOrder) estimate[pid] = refPrice(world, pid) * (1 + gauss(world) * 0.18 * (1 - c.skills.sales / 100));

  // 1. Reprice my stale listings.
  for (const l of world.listings.filter((x) => x.sellerId === c.id)) {
    const age = world.time - l.listedT;
    if (age < 30 * 60) continue;
    const floor = l.cost * (age > 3 * 1440 ? 0.85 : 1.03);
    const newPrice = round2(Math.max(floor, l.price * 0.92));
    if (newPrice < l.price - 0.01) {
      notes.push(`cut my ${world.products[l.productId].name} to ${money(newPrice)} (not selling)`);
      l.price = newPrice;
      l.listedT = world.time - 6 * 60;
    } else if (age > 4 * 1440) {
      delist(world, l);
    }
  }

  // 2. Hunt for bargains.
  const target = 0.22 + (1 - c.traits.risk) * 0.1 - c.traits.greed * 0.05;
  let budget = Math.max(0, (s.liquid - s.dailyCost * 2.5) * (0.5 + c.traits.risk * 0.4));
  const deals = world.listings
    .filter((l) => l.sellerId !== c.id && l.qty > 0)
    .map((l) => ({ l, margin: (estimate[l.productId] * 0.95 - l.price) / l.price }))
    .sort((a, b) => b.margin - a.margin);
  for (const d of deals.slice(0, 6)) {
    const pname = world.products[d.l.productId].name;
    options.push({
      id: `buy:${d.l.id}`,
      label: `Buy ${d.l.qty}× ${pname} at ${money(d.l.price)} (est. worth ${money(estimate[d.l.productId])})`,
      factors: { margin: round2(d.margin), target: -target },
      payload: null,
      thought: "",
    });
    if (d.margin < target || budget < d.l.price) continue;
    const qty = Math.min(d.l.qty, Math.floor(budget / d.l.price));
    if (!ensureCash(c, d.l.price * qty)) continue;
    const seller = d.l.sellerId;
    const got = buyListing(world, c, d.l, qty);
    if (got > 0) {
      budget -= d.l.price * got;
      notes.push(`picked up ${got}× ${pname} at ${money(d.l.price)} — they sell for ~${money(refPrice(world, d.l.productId))}`);
      if (seller !== "external" && world.citizens[seller]) {
        const sc = world.citizens[seller];
        remember(world, sc, { text: `${c.name} bought my ${pname} at the Marketplace.`, kind: "deal", importance: 3, valence: 0.2, people: [c.id] });
      }
    }
  }

  // 3. List what I hold.
  for (const [pid, it] of Object.entries({ ...c.inventory })) {
    const qty = it.qty - keepForSelf(pid, it.qty);
    if (qty <= 0) continue;
    const competitors = [
      ...listingsFor(world, pid).filter((l) => l.sellerId !== c.id && l.sellerId !== "external").map((l) => l.price),
      ...sellersOf(world, pid).map((b) => b.prices[pid]),
    ];
    let price = refPrice(world, pid) * (1 + c.traits.greed * 0.1);
    const cheapest = competitors.length ? Math.min(...competitors) : Infinity;
    if (cheapest < price && c.traits.competitiveness > 0.4) price = cheapest * 0.97;
    price = round2(Math.max(it.avgCost * 1.08, price));
    removeStock(c.inventory, pid, qty);
    addListing(world, c.id, pid, qty, price, it.avgCost);
    notes.push(`listed ${qty}× ${world.products[pid].name} at ${money(price)}`);
  }

  c.skills.sales = Math.min(100, c.skills.sales + 0.3);
  const bought = notes.filter((n) => n.startsWith("picked up"));
  if (bought.length) logEvent(world, "market", `🔁 ${c.name} ${bought[0]}.`, 2, [c.id]);
  const thought = notes.length ? `At the Marketplace: ${notes.slice(0, 3).join("; ")}.` : "No bargains at the Marketplace today. Everything's overpriced.";
  options.push({ id: "wait", label: "Wait for better deals", factors: { patience: 0.05 }, payload: null, thought });
  const chosen = options.find((o) => notes.some((n) => n.startsWith("picked")) && o.id.startsWith("buy:")) ?? options[options.length - 1];
  recordDecision(world, c, "reaction", options, chosen, "utility", thought);
  setThought(world, c, thought, 3);
  return thought;
}

/** Anyone can list their own possessions (e.g. when desperate for cash). */
export function sellPossessions(world: WorldState, c: Citizen): string {
  const sold: string[] = [];
  for (const [pid, it] of Object.entries({ ...c.inventory })) {
    const p = world.products[pid];
    if (!p || p.category === "essential" || it.qty <= 0) continue;
    const price = round2(refPrice(world, pid) * 0.6);
    removeStock(c.inventory, pid, it.qty);
    addListing(world, c.id, pid, it.qty, price, it.avgCost);
    sold.push(`${it.qty}× ${p.name} at ${money(price)}`);
  }
  if (sold.length) {
    logEvent(world, "life", `${c.name} is selling their belongings at the Marketplace to make ends meet.`, 3, [c.id]);
    remember(world, c, { text: `I had to put my things up for sale: ${sold.join(", ")}.`, kind: "financial", importance: 6, valence: -0.6, people: [] });
  }
  return sold.length ? `I listed ${sold.join(", ")}. I need the cash.` : "I have nothing left worth selling.";
}

export function registerResellerActions(): void {
  registerAction("BROWSE_MARKET", {
    kind: "browse",
    complete(world, c, _a, minutes) {
      c.workedToday += minutes;
      if (minutes >= 20) runResellerSession(world, c);
    },
  });
  registerAction("SELL_POSSESSIONS", {
    kind: "browse",
    complete(world, c, _a, minutes) {
      if (minutes >= 10) setThought(world, c, sellPossessions(world, c), 3);
    },
  });
}
