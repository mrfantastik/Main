import { CONFIG } from "../config";
import { expectedDailySales, KIND_INFO, openBusinesses, staffOnDuty } from "../economy/business";
import { hourWeight, listingsFor, refPrice } from "../economy/market";
import { rememberBetrayal } from "../memory/memory";
import { peekRel } from "../social/relationships";
import type { Business, Citizen, WorldState } from "../types";
import { money } from "../util";
import { makeAction } from "./actions";
import { hoursFactor, registerActivityProvider, registerWorkProvider, travelPenalty, untilHour, type ActivityOption } from "./activity";
import { costPenalty, type Situation } from "./situation";

// Activity options for the economy: running businesses, working shifts,
// flipping goods, trading, shopping and eating out.

function opt(id: string, label: string, factors: Record<string, number>, payload: ActivityOption["payload"], thought: string, priority = 1): ActivityOption {
  return { id, label, factors, payload, thought, priority };
}

function ownedOpen(world: WorldState, c: Citizen): Business[] {
  return c.businessIds.map((id) => world.businesses[id]).filter((b): b is Business => !!b && b.open && b.ownerId === c.id);
}

// ------------------------------------------------------------- owners

function ownerOptions(world: WorldState, c: Citizen, s: Situation): ActivityOption[] {
  const out: ActivityOption[] = [];
  const h = s.hour;
  for (const b of ownedOpen(world, c)) {
    const open = b.kind === "agency" ? hoursFactor(h, 9, 18, 1) : hoursFactor(h, 9, 19, 1);
    // Restock run to the depot.
    if (b.kind !== "agency" && h >= 7 && h < 19) {
      const low = b.products.filter((pid) => (b.inventory[pid]?.qty ?? 0) < Math.max(1, expectedDailySales(world, b, pid) * 0.6));
      const empty = b.products.filter((pid) => (b.inventory[pid]?.qty ?? 0) === 0).length;
      const canPay = b.cash + c.money > Math.min(...b.products.map((pid) => world.market[pid].wholesale)) + 5;
      if (low.length > 0 && canPay) {
        const names = low.map((pid) => world.products[pid].name.toLowerCase()).join(" and ");
        out.push(
          opt(
            `restock:${b.id}`,
            `Restock ${b.name} at the depot`,
            { lowStock: (low.length / b.products.length) * 0.9, empty: empty * 0.35, duty: 0.2 + c.traits.diligence * 0.4, travel: travelPenalty(world, c, "depot") },
            makeAction("RESTOCK", "depot", 40, `Buying stock for ${b.name}`, { businessId: b.id }),
            empty ? `We're out of ${names}! Off to the depot.` : `Running low on ${names}. Better restock.`,
            2,
          ),
        );
      }
    }
    if (open <= 0) continue;
    const staffNow = staffOnDuty(world, b).filter((x) => x.id !== c.id).length;
    const stockOk = b.kind === "agency" || b.products.some((pid) => (b.inventory[pid]?.qty ?? 0) > 0);
    const minutes = 120 + Math.round(c.traits.diligence * 120);
    const where = b.kind === "stall" ? "at the market stall" : b.kind === "agency" ? "at the agency" : "in the shop";
    out.push(
      opt(
        `manage:${b.id}`,
        `Work ${where} (${b.name})`,
        {
          hours: open * 0.35,
          duty: 0.35 + c.traits.diligence * 0.6,
          pressure: s.pressure * 0.5,
          rushHour: hourWeight(Math.floor(h)) * 4,
          noStaff: staffNow === 0 ? 0.3 : -0.2,
          noStock: stockOk ? 0 : -0.9,
          doneForToday: c.workedToday > s.workTarget ? -0.7 : 0,
          fatigue: s.tired > 0.75 ? -0.6 : 0,
        },
        makeAction("MANAGE", b.buildingId, minutes, `Running ${b.name}`, { businessId: b.id }),
        b.avgProfit > 40
          ? `${b.name} is doing well (${money(b.avgProfit)}/day). Keep it going.`
          : b.avgProfit < 0 && b.history.length > 1
            ? `${b.name} is losing money. I need customers.`
            : `Opening up ${b.name}.`,
      ),
    );
  }
  return out;
}

registerWorkProvider("shopkeeper", ownerOptions);
registerWorkProvider("entrepreneur", ownerOptions);

// --------------------------------------------- employees of businesses

registerWorkProvider("employee", (world, c, s) => {
  if (!c.employerId || c.employerId === "corp") return [];
  const b = world.businesses[c.employerId];
  if (!b || !b.open) return [];
  const h = s.hour;
  if (h < 8.5 || h >= 16.5 || c.workedToday >= 400) return [];
  const untilT = world.time + untilHour(world.time, 17);
  const owner = world.citizens[b.ownerId];
  const rel = owner ? peekRel(c, owner.id) : undefined;
  return [
    opt(
      "work_biz",
      `Go to work at ${b.name}`,
      {
        duty: 1.05 * (0.35 + c.traits.diligence),
        pressure: s.pressure * 0.6,
        loyalty: rel ? rel.affinity / 200 : 0,
        unpaid: c.unpaidWages > 0 ? -0.5 : 0,
        fatigue: s.tired > 0.75 ? -0.7 : 0,
      },
      makeAction("WORK", b.buildingId, untilT - world.time, `Working at ${b.name}`, { role: "business", untilT }),
      c.unpaidWages > 0 ? `${owner?.name ?? "The boss"} still owes me ${money(c.unpaidWages)}. Why am I even going in?` : s.worry ?? `Shift at ${b.name}.`,
    ),
  ];
});

// ------------------------------------------------------------ resellers

registerWorkProvider("reseller", (world, c, s) => {
  const h = s.hour;
  const open = hoursFactor(h, 9, 19, 1);
  if (open <= 0 || c.workedToday > s.workTarget) return [];
  const myListings = world.listings.filter((l) => l.sellerId === c.id).length;
  const bargains = world.listings.filter((l) => l.sellerId !== c.id && l.price < refPrice(world, l.productId) * 0.75).length;
  return [
    opt(
      "browse",
      "Hunt for bargains at the Marketplace",
      {
        hours: open * 0.35,
        drive: 0.3 + c.traits.diligence * 0.6,
        pressure: s.pressure * 0.8,
        bargains: Math.min(0.6, bargains * 0.12),
        stockToSell: Object.keys(c.inventory).length ? 0.25 : 0,
        listed: myListings > 0 ? 0.1 : 0,
        fatigue: s.tired > 0.75 ? -0.6 : 0,
      },
      makeAction("BROWSE_MARKET", "market", 90, "Hunting for bargains at the Marketplace"),
      bargains > 0 ? `I heard there are cheap lots at the Marketplace. Let's flip some.` : s.worry ?? "Let's see what's for sale at the Marketplace.",
    ),
  ];
});

// -------------------------------------------------------------- traders

registerWorkProvider("trader", (world, c, s) => {
  const h = s.hour;
  const open = hoursFactor(h, 9, 17, 1);
  if (open <= 0 || c.workedToday > s.workTarget * 0.8) return [];
  const holding = Object.keys(c.inventory).filter((k) => k !== "food").length;
  return [
    opt(
      "trade",
      "Trade on the Exchange",
      { hours: open * 0.35, drive: 0.3 + c.traits.diligence * 0.5, risk: c.traits.risk * 0.3, pressure: s.pressure * 0.5, positions: holding ? 0.3 : 0, fatigue: s.tired > 0.75 ? -0.6 : 0 },
      makeAction("TRADE", "bank", 90, "Trading on the Exchange"),
      holding ? "I need to watch my positions." : "Let's see what the markets are doing.",
    ),
  ];
});

// ------------------------------------------------------- job seekers

function businessJobOptions(world: WorldState, c: Citizen, s: Situation): ActivityOption[] {
  // Who looks at the job board: the unemployed, plus anyone earning less than a posting pays.
  if (c.businessIds.some((id) => world.businesses[id]?.open)) return [];
  const currentPay = c.occupation === "employee" ? c.wage : s.occEarnAvg || (c.occupation === "unemployed" ? 0 : 30);
  const h = s.hour;
  if (h < 9 || h >= 18) return [];
  const out: ActivityOption[] = [];
  const postings = openBusinesses(world)
    .filter((b) => b.hiringWage > 0 && b.ownerId !== c.id && c.employerId !== b.id)
    .filter((b) => c.occupation === "unemployed" || b.hiringWage > currentPay * 1.12)
    .sort((a, b) => b.hiringWage - a.hiringWage)
    .slice(0, 2);
  for (const b of postings) {
    if (world.time - (c.cooldowns[`applied:${b.id}`] ?? -1e9) < 2 * 1440) continue;
    const owner = world.citizens[b.ownerId];
    const rel = owner ? peekRel(c, owner.id) : undefined;
    out.push(
      opt(
        `apply:${b.id}`,
        `Apply for a job at ${b.name} (${money(b.hiringWage)}/day)`,
        {
          need: (c.occupation === "unemployed" ? 0.55 : 0.1) + s.pressure * 0.7,
          raise: (b.hiringWage - currentPay) / 40,
          security: c.occupation === "employee" ? 0 : (1 - c.traits.risk) * 0.2,
          knowsOwner: rel ? rel.affinity / 150 : 0,
          lazy: -(1 - c.traits.diligence) * 0.35,
          travel: travelPenalty(world, c, b.buildingId),
        },
        makeAction("APPLY_FOR_JOB", b.buildingId, 30, `Applying for a job at ${b.name}`, { target: b.id }),
        `${b.name} is hiring at ${money(b.hiringWage)} a day.${owner && rel && rel.affinity > 30 ? ` I know ${owner.name} — worth a shot.` : " I'll apply."}`,
        2,
      ),
    );
  }
  return out;
}

// ------------------------------------------------- shopping & eating

function shoppingOptions(world: WorldState, c: Citizen, s: Situation): ActivityOption[] {
  const h = s.hour;
  if (h < 8 || h >= 20) return [];
  const out: ActivityOption[] = [];
  const businesses = openBusinesses(world).filter((b) => b.kind !== "agency" && b.ownerId !== c.id);

  const bestSeller = (pid: string, qty: number) => {
    let best: { score: number; label: string; bid: string | null; price: number; where: string; owner: Citizen | null } | null = null;
    const ref = refPrice(world, pid);
    for (const b of businesses) {
      if (!b.products.includes(pid) || (b.inventory[pid]?.qty ?? 0) < qty) continue;
      const owner = world.citizens[b.ownerId] ?? null;
      const rel = owner ? peekRel(c, owner.id) : undefined;
      const price = b.prices[pid];
      const grudge = owner && rememberBetrayal(c, owner.id) ? -1.2 : 0;
      const score = -(price / ref - 1) * 2 + (b.reputation - 50) / 100 + (rel ? rel.affinity / 120 : 0) + grudge + travelPenalty(world, c, b.buildingId);
      if (!best || score > best.score) best = { score, label: b.name, bid: b.id, price, where: b.buildingId, owner };
    }
    if (h < 19) {
      const l = listingsFor(world, pid).filter((x) => x.sellerId !== c.id && x.qty >= qty).sort((a, b) => a.price - b.price)[0];
      if (l) {
        const score = -(l.price / ref - 1) * 2 - 0.15 + travelPenalty(world, c, "market");
        if (!best || score > best.score) best = { score, label: "the Marketplace", bid: null, price: l.price, where: "market", owner: null };
      }
    }
    return best;
  };

  // Treats (durables & luxuries & coffee).
  const wants = Object.entries(c.wants)
    .filter(([pid, w]) => w >= 55 && world.products[pid])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);
  for (const [pid, want] of wants) {
    const best = bestSeller(pid, 1);
    if (!best) continue;
    const affordable = s.liquid >= best.price * (2.5 + c.traits.frugality * 4) + s.dailyCost * 2;
    if (!affordable) continue;
    const p = world.products[pid];
    const friend = best.owner && (peekRel(c, best.owner.id)?.affinity ?? 0) > 35;
    out.push(
      opt(
        `shop:${pid}`,
        `Buy ${p.name.toLowerCase()} at ${best.label} (${money(best.price)})`,
        {
          want: (want / 100) * (0.5 + (1 - c.traits.frugality) * 0.6),
          mood: (c.mood - 50) / 250,
          cost: -costPenalty(c, s, best.price) * 0.5,
          seller: best.score * 0.3,
        },
        makeAction("SHOP", best.where, 25, `Shopping for ${p.name.toLowerCase()}`, { productId: pid, qty: 1, businessId: best.bid }),
        friend ? `I'll get my ${p.name.toLowerCase()} from ${best.owner!.name} — gotta support friends.` : `I've wanted ${p.name.toLowerCase()} for a while. ${best.label} has them for ${money(best.price)}.`,
      ),
    );
  }

  // Groceries (cook at home: cheaper than eating out).
  const food = c.inventory.food?.qty ?? 0;
  if (food < 2 && !c.homeless) {
    const qty = 3;
    const best = bestSeller("food", qty);
    if (best && best.price < CONFIG.dinerMealPrice) {
      out.push(
        opt(
          "groceries",
          `Buy groceries at ${best.label} (${money(best.price)} each)`,
          {
            thrifty: 0.15 + c.traits.frugality * 0.55,
            savings: (CONFIG.dinerMealPrice - best.price) / 6,
            hungry: s.hungry * 0.3,
            cost: -costPenalty(c, s, best.price * qty) * 0.3,
            seller: best.score * 0.2,
          },
          makeAction("SHOP", best.where, 25, "Buying groceries", { productId: "food", qty, businessId: best.bid }),
          `Groceries at ${best.label} are ${money(best.price)}. Cheaper than the diner.`,
        ),
      );
    }
  }
  return out;
}

function cafeOptions(world: WorldState, c: Citizen, s: Situation): ActivityOption[] {
  if (s.hungry < 0.22) return [];
  const h = s.hour;
  if (h < 7 || h >= 21) return [];
  const out: ActivityOption[] = [];
  const hunger = s.hungry ** 1.6 * 2.7;
  const mealtime = (h >= 7 && h < 9.5) || (h >= 12 && h < 14) || (h >= 18 && h < 20.5) ? 0.35 : 0;
  for (const b of openBusinesses(world)) {
    if (b.kind !== "cafe" || (b.inventory.food?.qty ?? 0) < 1) continue;
    const price = b.prices.food ?? 99;
    const owner = world.citizens[b.ownerId];
    const rel = owner ? peekRel(c, owner.id) : undefined;
    out.push(
      opt(
        `cafe:${b.id}`,
        `Eat at ${b.name} (${money(price)})`,
        {
          hunger,
          mealtime,
          cost: -costPenalty(c, s, price),
          reputation: (b.reputation - 50) / 150,
          friend: rel ? rel.affinity / 150 : 0,
          travel: travelPenalty(world, c, b.buildingId),
        },
        makeAction("EAT", b.buildingId, 40, `Eating at ${b.name}`, { venue: b.id }),
        owner && rel && rel.affinity > 30 ? `Lunch at ${owner.name}'s place — supporting a friend.` : `${b.name} does a meal for ${money(price)}. Cheaper than the diner.`,
      ),
    );
  }
  return out;
}

function desperateOptions(world: WorldState, c: Citizen, s: Situation): ActivityOption[] {
  if (s.pressure < 0.9 || s.hour < 8 || s.hour >= 19) return [];
  const sellable = Object.entries(c.inventory).filter(([pid, it]) => world.products[pid]?.category !== "essential" && it.qty > 0);
  if (sellable.length === 0 || c.occupation === "reseller") return [];
  return [
    opt(
      "sell_stuff",
      "Sell my belongings at the Marketplace",
      { desperate: s.pressure * 0.8, attachment: -0.35 },
      makeAction("SELL_POSSESSIONS", "market", 30, "Selling belongings at the Marketplace"),
      s.worry ? `${s.worry} I'll have to sell some of my things.` : "I need cash. Time to sell some of my things.",
      2,
    ),
  ];
}

registerActivityProvider(businessJobOptions);
registerActivityProvider(shoppingOptions);
registerActivityProvider(cafeOptions);
registerActivityProvider(desperateOptions);

export { KIND_INFO };
