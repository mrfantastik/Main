import { registerAction } from "../ai/actions";
import { bestOf, recordDecision, setThought, type Option } from "../ai/decision";
import { logEvent } from "../events";
import { remember, rememberBetrayal } from "../memory/memory";
import { chance } from "../rng";
import { addRole, getRel, peekRel } from "../social/relationships";
import type { Business, Citizen, WorldState } from "../types";
import { money, round2 } from "../util";
import { CONFIG } from "../config";
import { expectedDailySales, priceFloor, restockBusiness, sellersOf } from "./business";
import { hireAtBusiness } from "./jobs";
import { listingsFor, refPrice } from "./market";

// Running a business day to day: opening up (MANAGE), restocking at the
// depot (RESTOCK), pricing, and deciding on job applicants.

/** Price review for one product. Logged as a decision so the UI can explain it. */
function reviewPrice(world: WorldState, b: Business, owner: Citizen, pid: string): void {
  const m = world.market[pid];
  const pname = world.products[pid].name;
  const price = b.prices[pid];
  const stock = b.inventory[pid]?.qty ?? 0;
  const sold = b.salesAvg[pid] ?? 0;
  const expected = Math.max(1, expectedDailySales(world, b, pid));
  const cost = Math.max(b.inventory[pid]?.avgCost ?? 0, m.wholesale);
  const floor = priceFloor(world, b, owner, pid);
  const ref = refPrice(world, pid);
  const rivals = sellersOf(world, pid, b.id);
  const rivalPrices = [...rivals.map((r) => ({ name: world.citizens[r.ownerId]?.name ?? r.name, price: r.prices[pid] })), ...listingsFor(world, pid).filter((l) => l.sellerId !== "external").map((l) => ({ name: "the Marketplace", price: l.price }))];
  const cheapest = rivalPrices.sort((a, x) => a.price - x.price)[0];
  const daysTracked = b.history.length;

  const opts: Option<number>[] = [];
  opts.push({
    id: "hold",
    label: `Keep ${pname} at ${money(price)}`,
    factors: { inertia: 0.25 + owner.traits.frugality * 0.1 },
    payload: price,
    thought: `${pname} at ${money(price)} is about right. Leave it.`,
  });
  const raise = round2(Math.max(floor, price * 1.08));
  const thin = price < cost * 1.3;
  opts.push({
    id: "raise",
    label: `Raise ${pname} to ${money(raise)}`,
    factors: {
      sellingOut: stock === 0 && sold >= 1 ? 0.55 : sold > expected * 1.3 ? 0.3 : 0,
      greed: owner.traits.greed * 0.25,
      belowRef: price < ref * 0.88 ? 0.35 : 0,
      thinMargin: thin ? 0.4 : 0,
      rivalCheaper: cheapest && cheapest.price < price && !thin ? -0.4 : 0,
      tooNew: daysTracked < 1 ? -0.4 : 0,
    },
    payload: raise,
    thought: thin ? `I'm barely making anything on ${pname}. Prices have to go up.` : stock === 0 ? `We keep selling out of ${pname}. Time to raise prices.` : `Customers will pay more for ${pname}. Nudging the price up.`,
  });
  const cut = round2(Math.max(floor, price * 0.9));
  if (cut < price - 0.01) {
    opts.push({
      id: "cut",
      label: `Cut ${pname} to ${money(cut)}`,
      factors: {
        slowSales: sold < expected * 0.5 && stock > 2 ? 0.45 : 0,
        overpriced: price > ref * 1.12 ? 0.4 : 0,
        cashTight: b.cash < CONFIG.rent[b.kind] * 3 ? 0.15 : 0,
        tooNew: daysTracked < 1 ? -0.4 : 0,
      },
      payload: cut,
      thought: `Business is bad. I should reduce my ${pname} prices.`,
    });
  }
  if (cheapest && cheapest.price < price * 0.98 && cheapest.price >= floor * 0.95) {
    const under = round2(Math.max(floor, cheapest.price * 0.97));
    if (under < price - 0.01) {
      opts.push({
        id: "undercut",
        label: `Undercut ${cheapest.name}: ${pname} to ${money(under)}`,
        factors: {
          rivalCheaper: Math.min(0.6, ((price - cheapest.price) / price) * 3),
          competitive: owner.traits.competitiveness * 0.35,
          lowSales: sold < expected * 0.8 ? 0.15 : -0.15,
          margin: under <= floor + 0.01 ? -0.3 : 0,
        },
        payload: under,
        thought: `${cheapest.name} is selling ${pname.toLowerCase()} for ${money(cheapest.price)}. I'll go to ${money(under)}.`,
      });
    }
  }
  const chosen = bestOf(opts);
  if (chosen.id === "hold") return;
  b.prices[pid] = chosen.payload;
  b.lastPriceChangeT = world.time;
  recordDecision(world, owner, "strategy", opts, chosen, "utility", chosen.thought);
  setThought(world, owner, chosen.thought, 3);
  if (chosen.id === "undercut" && cheapest && cheapest.name !== "the Marketplace") {
    const rival = rivals.find((r) => world.citizens[r.ownerId]?.name === cheapest.name);
    if (rival) {
      addRole(owner, rival.ownerId, "rival");
      const rc = world.citizens[rival.ownerId];
      if (rc) addRole(rc, owner.id, "rival");
      if (chance(world, 0.35)) logEvent(world, "business", `⚔️ Price war! ${owner.name} undercut ${cheapest.name} on ${pname} (${money(chosen.payload)}).`, 3, [owner.id, rival.ownerId], b.id);
    }
  }
}

export function registerOperationsActions(): void {
  registerAction("MANAGE", {
    kind: "manage",
    validate(world, c, a) {
      const b = world.businesses[String(a.params.businessId)];
      if (!b || !b.open) return "That business is closed";
      return b.ownerId === c.id ? null : "Not my business";
    },
    complete(world, c, a, minutes) {
      c.workedToday += minutes;
      const b = world.businesses[String(a.params.businessId)];
      if (!b || !b.open) return;
      const hours = minutes / 60;
      c.skills.sales = Math.min(100, c.skills.sales + hours * 0.08);
      c.skills.management = Math.min(100, c.skills.management + hours * 0.06);
      // Review prices at most once a day.
      if (b.kind !== "agency" && world.time - b.lastPriceChangeT > 20 * 60) {
        b.lastPriceChangeT = world.time;
        for (const pid of b.products) reviewPrice(world, b, c, pid);
      }
    },
  });

  registerAction("RESTOCK", {
    kind: "restock",
    validate(world, c, a) {
      const b = world.businesses[String(a.params.businessId)];
      if (!b || !b.open) return "That business is closed";
      return b.ownerId === c.id || c.employerId === b.id ? null : "Not my business";
    },
    complete(world, c, a, minutes) {
      if (minutes < 10) return;
      const b = world.businesses[String(a.params.businessId)];
      if (!b || !b.open) return;
      setThought(world, c, restockBusiness(world, b, c), 2);
    },
  });
}

/** Owner's decision on a job applicant. Returns true if hired. */
export function considerApplicant(world: WorldState, b: Business, applicant: Citizen): boolean {
  const owner = world.citizens[b.ownerId];
  if (!owner || !b.open || b.hiringWage <= 0) return false;
  const rel = peekRel(owner, applicant.id);
  const betrayal = rememberBetrayal(owner, applicant.id);
  const skill = b.kind === "agency" ? applicant.skills.tech : (applicant.skills.sales + applicant.skills.management) / 2;
  const factors: Record<string, number> = {
    skill: (skill - 30) / 60,
    friendship: rel ? rel.affinity / 150 : 0,
    trust: rel ? rel.trust / 200 : 0,
    family: owner.family.includes(applicant.id) ? 0.3 : 0,
    betrayal: betrayal ? -1.2 : 0,
    enemy: rel && rel.affinity < -40 ? -0.8 : 0,
    canAfford: b.cash > b.hiringWage * 2 ? 0.2 : -0.4,
  };
  const score = Object.values(factors).reduce((a, x) => a + x, 0);
  const hire = score > -0.15;
  const opts: Option<null>[] = [
    { id: "hire", label: `Hire ${applicant.name} at ${money(b.hiringWage)}/day`, factors, payload: null, thought: `${applicant.name} seems right for ${b.name}. Hired!` },
    { id: "reject", label: `Turn ${applicant.name} down`, factors: { bar: -0.15 }, payload: null, thought: betrayal ? `Hire ${applicant.name}? After what they did to me? No.` : `${applicant.name} isn't what ${b.name} needs.` },
  ];
  const chosen = hire ? opts[0] : opts[1];
  recordDecision(world, owner, "reaction", opts, chosen, "utility", chosen.thought);
  setThought(world, owner, chosen.thought, 3);
  if (hire) {
    hireAtBusiness(world, applicant, b.id, b.hiringWage);
  } else {
    getRel(applicant, owner.id);
    remember(world, applicant, { text: `${owner.name} turned me down for a job at ${b.name}.`, kind: "job", importance: 4, valence: -0.4, people: [owner.id], key: `rejected:${b.id}` });
  }
  return hire;
}
