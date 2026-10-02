import { registerAction } from "../ai/actions";
import { setThought } from "../ai/decision";
import { remember } from "../memory/memory";
import { adjustRel } from "../social/relationships";
import type { WorldState } from "../types";
import { clamp, money } from "../util";
import { buyFromBusiness } from "./business";
import { buyListing, listingsFor } from "./market";
import { ensureCash } from "./bank";

// Consumers. Citizens develop "wants" for goods over time (faster for
// trendy products and for status-seekers). When a want is strong and they
// can afford it, they go shopping — choosing where based on price,
// reputation, distance and who they like. That makes friends' shops,
// boycotts of rivals, and price competition matter.

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Daily want growth. */
export function updateWants(world: WorldState): void {
  for (const id of world.citizenOrder) {
    const c = world.citizens[id];
    for (const pid of world.productOrder) {
      const p = world.products[pid];
      const m = world.market[pid];
      if (p.category === "essential") continue;
      const taste = 0.4 + (hash(c.id + pid) % 100) / 100; // personal taste 0.4..1.4
      let rate: number;
      if (p.category === "consumable") rate = 18;
      else if (p.category === "durable") rate = 6;
      else rate = 3.5 * (1 + c.traits.ambition * 0.5 + c.traits.greed * 0.3);
      c.wants[pid] = clamp((c.wants[pid] ?? 0) + rate * taste * m.trend, 0, 100);
    }
  }
}

export function registerShoppingActions(): void {
  registerAction("SHOP", {
    kind: "shop",
    complete(world, c, a, minutes) {
      if (minutes < 5) return;
      const pid = String(a.params.productId);
      const qty = Number(a.params.qty ?? 1);
      const bid = a.params.businessId ? String(a.params.businessId) : null;
      const p = world.products[pid];
      if (!p) return;
      let got = 0;
      if (bid) {
        const b = world.businesses[bid];
        if (b) {
          got = buyFromBusiness(world, b, c, pid, qty);
          if (got === 0) {
            setThought(world, c, `${b.name} was closed or sold out. Wasted trip.`, 2);
            b.missedToday++;
            const owner = world.citizens[b.ownerId];
            if (owner) adjustRel(world, c, owner.id, { trust: -1 });
          }
        }
      } else {
        const l = listingsFor(world, pid).filter((x) => x.sellerId !== c.id).sort((x, y) => x.price - y.price)[0];
        if (l && ensureCash(c, l.price * Math.min(qty, l.qty))) got = buyListing(world, c, l, qty);
        if (!got) setThought(world, c, `Nothing decent at the Marketplace.`, 2);
      }
      if (got > 0) {
        c.wants[pid] = Math.max(0, (c.wants[pid] ?? 0) - 70 * got);
        c.needs.fun = clamp(c.needs.fun + (p.category === "luxury" ? 20 : 8), 0, 100);
        if (p.category === "luxury") remember(world, c, { text: `I bought ${p.name.toLowerCase()} — treated myself.`, kind: "financial", importance: 3, valence: 0.5, people: [], key: `bought:${pid}` });
        setThought(world, c, p.category === "essential" ? `Stocked up on ${p.name.toLowerCase()}.` : `Got my ${p.name.toLowerCase()}! ${money(c.money)} left.`, 2);
      }
    },
  });
}
