import { registerAction } from "../ai/actions";
import { inventionSeed } from "../data/products";
import { logEvent } from "../events";
import { remember } from "../memory/memory";
import { chance, pick } from "../rng";
import { dayOf } from "../time";
import type { Citizen, Product, WorldState } from "../types";
import { round2 } from "../util";
import { initProductMarket } from "../world";
import { citizenAcc, creditOccupation, externalAcc, transfer } from "./ledger";

// Researchers work at the Research Lab for a grant. Research points build up
// until a breakthrough, which is either:
//  - a market insight: foreknowledge of an upcoming demand shock (which they
//    can use themselves or share/sell to friends), or
//  - an invention: a brand-new product enters the economy, with the inventor
//    earning royalties on every unit sold anywhere in town.

export function breakthroughThreshold(c: Citizen): number {
  return 90 + c.research.breakthroughs * 60;
}

export function registerResearchActions(): void {
  registerAction("RESEARCH", {
    kind: "research",
    validate(_world, c) {
      return c.occupation === "researcher" ? null : "Not a researcher";
    },
    complete(world, c, _a, minutes) {
      c.workedToday += minutes;
      const hours = minutes / 60;
      const grant = round2((world.economy.grant / 8) * Math.min(hours, 9));
      if (grant > 0) {
        transfer(world, externalAcc("institute"), citizenAcc(c.id), grant, "grant", `Research grant (${hours.toFixed(1)}h)`);
        creditOccupation(world, c.id, grant);
      }
      c.research.points += hours * (0.4 + c.skills.research / 100) * (0.6 + c.traits.diligence * 0.8) * 1.6;
      c.skills.research = Math.min(100, c.skills.research + hours * 0.1);
      if (c.research.points >= breakthroughThreshold(c)) breakthrough(world, c);
    },
  });
}

export function breakthrough(world: WorldState, c: Citizen): void {
  c.research.points = 0;
  c.research.breakthroughs++;
  const upcoming = world.shocks.filter((s) => !s.started && !c.beliefs.insights.some((i) => i.productId === s.productId && i.startT === s.startT));
  const canInvent = world.inventionPool.length > 0;
  if (upcoming.length > 0 && (!canInvent || chance(world, 0.55))) {
    const s = pick(world, upcoming);
    c.beliefs.insights.push({ productId: s.productId, kind: s.kind, startT: s.startT, magnitude: s.magnitude, source: "own" });
    const p = world.products[s.productId];
    const when = dayOf(s.startT);
    const verb = s.kind === "hype" ? "boom" : "slump";
    logEvent(world, "market", `🔬 ${c.name}'s research predicts a ${verb} in ${p.name} around Day ${when}.`, 3, [c.id]);
    remember(world, c, { text: `My research says ${p.name} demand will ${verb} around Day ${when}.`, kind: "insight", importance: 7, valence: 0.5, people: [] });
    return;
  }
  if (canInvent) {
    const id = pick(world, world.inventionPool);
    world.inventionPool = world.inventionPool.filter((x) => x !== id);
    const seed = inventionSeed(id)!;
    const product: Product = { ...seed, inventorId: c.id, royalty: 0.06, inventedT: world.time };
    world.products[id] = product;
    world.productOrder.push(id);
    world.market[id] = initProductMarket(product, 1.7);
    c.research.patents.push(id);
    logEvent(world, "market", `💡 BREAKTHROUGH: ${c.name} invented ${product.emoji} ${product.name}! A new market is born.`, 5, [c.id]);
    remember(world, c, { text: `I invented ${product.name}. I earn royalties on every sale.`, kind: "financial", importance: 10, valence: 1, people: [] });
    // Everyone hears the news: a fresh opportunity.
    for (const oid of world.citizenOrder) {
      const o = world.citizens[oid];
      o.beliefs.products[id] = { margin: product.baseRetail - product.baseCost, demand: 1.6, sellers: 0, t: world.time, source: "news" };
      if (o.id !== c.id) o.reviewRequested = o.reviewRequested ?? `heard about ${product.name}`;
    }
    return;
  }
  // Nothing left to discover: a modest bonus grant.
  transfer(world, externalAcc("institute"), citizenAcc(c.id), 80, "grant", "Breakthrough bonus");
  logEvent(world, "market", `🔬 ${c.name} published a well-received paper and got an £80 bonus.`, 2, [c.id]);
}
