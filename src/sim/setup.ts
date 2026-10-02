import { launchBusiness } from "./ai/economyStrategy";
import { takeBankLoan } from "./economy/bank";
import { restockBusiness } from "./economy/business";
import { hireAtCorp } from "./economy/jobs";
import { addStock } from "./economy/market";
import { planBusiness } from "./economy/opportunity";
import { pick, randInt } from "./rng";
import type { BusinessKind, WorldState } from "./types";
import { citizensList } from "./world";

/**
 * Give the starting citizens their starting situation. Everyone has exactly
 * £100 in their pocket. Employees start at CityCorp; the starting
 * shopkeepers and one entrepreneur open their first business on a bank
 * start-up loan (so they begin in debt); resellers own a few old items.
 */
export function setupStartingEconomy(world: WorldState): void {
  const citizens = citizensList(world);
  for (const c of citizens) {
    if (c.occupation === "employee") hireAtCorp(world, c);
  }

  const founders: { id: string; kind: BusinessKind; occ: "shopkeeper" | "entrepreneur" }[] = [];
  citizens.filter((c) => c.occupation === "shopkeeper").forEach((c, i) => founders.push({ id: c.id, kind: i === 0 ? "shop" : "stall", occ: "shopkeeper" }));
  const ent = citizens.find((c) => c.occupation === "entrepreneur");
  if (ent) founders.push({ id: ent.id, kind: "cafe", occ: "entrepreneur" });
  for (const f of founders) {
    const c = world.citizens[f.id];
    takeBankLoan(world, c, 160, `start my ${f.kind === "stall" ? "market stall" : f.kind}`);
    const plan = planBusiness(world, c, f.kind, c.money - 40);
    if (!plan) continue;
    const b = launchBusiness(world, c, plan, f.occ);
    if (b) restockBusiness(world, b, c);
  }

  for (const c of citizens.filter((x) => x.occupation === "reseller")) {
    for (let i = 0; i < 2; i++) {
      const pid = pick(world, ["books", "clothes", "gadgets", "trainers"]);
      addStock(c.inventory, pid, randInt(world, 1, 2), world.market[pid].wholesale);
    }
  }

  // Starting moves shouldn't flood the event feed / memories.
  world.events = [];
  for (const c of citizens) {
    c.memories.short = [];
    c.memories.long = [];
    c.reviewRequested = null;
    c.lastReviewT = world.time;
  }
}
