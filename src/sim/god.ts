import { changeCareer } from "./ai/careers";
import { launchBusiness } from "./ai/economyStrategy";
import { closeBusiness, findPremises, KIND_INFO, restockBusiness } from "./economy/business";
import { hireAtCorp } from "./economy/jobs";
import { citizenAcc, externalAcc, transfer } from "./economy/ledger";
import { addListing, refPrice } from "./economy/market";
import { logEvent } from "./events";
import { remember } from "./memory/memory";
import { createHappening, HAPPENING_KINDS } from "./town/happenings";
import { randInt, randRange } from "./rng";
import type { GodCommand } from "../shared/protocol";
import type { BusinessKind, Occupation, WorldState } from "./types";
import { OCCUPATIONS } from "./types";
import { clamp, money, newId, round2 } from "./util";

// God Mode: the player's interventions. Every command goes through the same
// systems the citizens use (ledger, markets, careers, businesses), so the
// agents react to them naturally — a windfall triggers a rethink, a crash
// brings layoffs, a shortage sends prices up.

export class GodError extends Error {}

const BOOM_DAYS = 5;
const CRASH_DAYS = 6;

/** Money amounts typed into God Mode: a positive number, capped at £1m. */
function validAmount(raw: unknown): number {
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 1) throw new GodError("Enter an amount of at least £1");
  return round2(Math.min(v, 1_000_000));
}

export function applyGodCommand(world: WorldState, cmd: GodCommand): string {
  switch (cmd.cmd) {
    case "give_money": {
      const c = world.citizens[cmd.citizenId];
      if (!c) throw new GodError("No such citizen");
      const amount = validAmount(cmd.amount);
      transfer(world, externalAcc("god"), citizenAcc(c.id), amount, "god", "A gift from the heavens");
      logEvent(world, "god", `⚡ A mysterious benefactor gave ${c.name} ${money(amount)}!`, 5, [c.id]);
      remember(world, c, { text: `${money(amount)} appeared in my account out of nowhere!`, kind: "financial", importance: 9, valence: 1, people: [] });
      c.reviewRequested = "windfall";
      c.lastReviewT = -1e9;
      return `Gave ${c.name} ${money(amount)}.`;
    }
    case "take_money": {
      const c = world.citizens[cmd.citizenId];
      if (!c) throw new GodError("No such citizen");
      const want = validAmount(cmd.amount);
      const fromSavings = Math.min(c.savings, Math.max(0, want - c.money));
      c.savings = round2(c.savings - fromSavings);
      c.money = round2(c.money + fromSavings);
      const amount = round2(Math.min(want, c.money));
      if (amount <= 0) throw new GodError(`${c.name} has no money to take`);
      transfer(world, citizenAcc(c.id), externalAcc("god"), amount, "god", "Taken by unseen forces");
      logEvent(world, "god", `⚡ ${money(amount)} vanished from ${c.name}'s pockets.`, 5, [c.id]);
      remember(world, c, { text: `${money(amount)} just disappeared from my account. I'm ruined.`, kind: "financial", importance: 9, valence: -1, people: [] });
      c.reviewRequested = "lost money";
      c.lastReviewT = -1e9;
      return `Took ${money(amount)} from ${c.name}.`;
    }
    case "shortage": {
      const p = world.products[cmd.productId];
      const m = world.market[cmd.productId];
      if (!p || !m) throw new GodError("No such product");
      m.supply = 0.25;
      m.depotStock = Math.min(m.depotStock, Math.round(p.externalDemand * 0.4));
      m.wholesale = round2(m.wholesale * 1.35);
      logEvent(world, "god", `⚡ SHORTAGE: ${p.emoji} ${p.name} are suddenly hard to get. Wholesale prices are spiking.`, 5);
      return `Created a shortage of ${p.name}.`;
    }
    case "surplus": {
      const p = world.products[cmd.productId];
      const m = world.market[cmd.productId];
      if (!p || !m) throw new GodError("No such product");
      m.supply = 2.8;
      m.depotStock = Math.round((p.externalDemand * 2.5 + 15) * 2.8);
      m.wholesale = round2(m.wholesale * 0.7);
      for (let i = 0; i < 6; i++) addListing(world, "external", p.id, randInt(world, 2, 5), round2(refPrice(world, p.id) * randRange(world, 0.35, 0.6)), 0);
      logEvent(world, "god", `⚡ SURPLUS: the market is flooded with cheap ${p.emoji} ${p.name}. Bargains everywhere.`, 5);
      return `Created a surplus of ${p.name}.`;
    }
    case "set_price": {
      const p = world.products[cmd.productId];
      const m = world.market[cmd.productId];
      if (!p || !m) throw new GodError("No such product");
      if (!(Number(cmd.price) > 0) || !Number.isFinite(Number(cmd.price))) throw new GodError("Enter a price above £0");
      const price = round2(clamp(Number(cmd.price), 0.1, 100_000));
      const ratio = price / p.baseCost;
      p.baseCost = price;
      p.baseRetail = round2(p.baseRetail * ratio);
      m.wholesale = price;
      m.tape.push(price);
      logEvent(world, "god", `⚡ The wholesale price of ${p.emoji} ${p.name} is now ${money(price)}.`, 4);
      return `${p.name} now cost ${money(price)} wholesale.`;
    }
    case "happening": {
      if (!HAPPENING_KINDS.includes(cmd.kind)) throw new GodError("Unknown kind of happening");
      const h = createHappening(world, cmd.kind, { source: "god", subject: cmd.citizenId || null, businessId: cmd.businessId || null });
      if (typeof h === "string") throw new GodError(h);
      return `${h.title}.`;
    }
    case "hype": {
      const p = world.products[cmd.productId];
      if (!p) throw new GodError("No such product");
      world.shocks = world.shocks.filter((s) => s.productId !== p.id);
      world.shocks.push({ id: newId(world), productId: p.id, kind: "hype", startT: world.time, magnitude: 2.3, durationDays: 3, started: true });
      logEvent(world, "god", `⚡ ${p.emoji} ${p.name} are suddenly EVERYWHERE on social media. Demand is exploding.`, 5);
      return `Started a craze for ${p.name}.`;
    }
    case "set_job": {
      const c = world.citizens[cmd.citizenId];
      if (!c) throw new GodError("No such citizen");
      const occ = cmd.occupation as Occupation;
      if (!OCCUPATIONS.includes(occ)) throw new GodError("Unknown occupation");
      if (occ === "employee") {
        if (world.corpEmployees.length >= world.economy.corpOpenings) world.economy.corpOpenings++;
        hireAtCorp(world, c);
      } else if (occ === "shopkeeper" || occ === "entrepreneur") {
        const kind: BusinessKind = occ === "shopkeeper" ? (findPremises(world, "shop") ? "shop" : "stall") : findPremises(world, "agency") ? "agency" : "cafe";
        return spawnBusiness(world, c.id, kind, occ === "shopkeeper" ? bestProduct(world) : "food", occ);
      } else {
        changeCareer(world, c, occ, "Fate decided it.");
      }
      c.lastCareerChangeT = world.time;
      logEvent(world, "god", `⚡ ${c.name} woke up as ${occ === "employee" ? "a CityCorp employee" : `a ${occ}`}.`, 4, [c.id]);
      return `${c.name} is now ${occ}.`;
    }
    case "spawn_business":
      return spawnBusiness(world, cmd.citizenId, cmd.kind as BusinessKind, cmd.productId, cmd.kind === "agency" || cmd.kind === "cafe" ? "entrepreneur" : "shopkeeper");
    case "close_business": {
      const b = world.businesses[cmd.businessId];
      if (!b || !b.open) throw new GodError("That business isn't open");
      closeBusiness(world, b, "shut down by divine intervention", false);
      logEvent(world, "god", `⚡ ${b.name} was shut down by forces beyond anyone's control.`, 5, [b.ownerId], b.id);
      return `Closed ${b.name}.`;
    }
    case "boom": {
      world.economy.mode = "boom";
      world.economy.modeUntil = world.time + BOOM_DAYS * 1440;
      world.economy.corpOpenings = 9;
      logEvent(world, "god", "⚡ 📈 ECONOMIC BOOM! Visitors flood into town, clients want more work, CityCorp is hiring.", 5);
      for (const id of world.citizenOrder) {
        const c = world.citizens[id];
        remember(world, c, { text: "The economy is booming. Now's the time to make money.", kind: "world", importance: 6, valence: 0.7, people: [], key: "macro" });
        c.reviewRequested = "boom";
      }
      return "The economy is booming.";
    }
    case "crash": {
      world.economy.mode = "crash";
      world.economy.modeUntil = world.time + CRASH_DAYS * 1440;
      world.economy.corpOpenings = 3;
      for (const pid of world.productOrder) world.market[pid].wholesale = round2(world.market[pid].wholesale * 0.82);
      logEvent(world, "god", "⚡ 📉 MARKET CRASH! Customers vanish, clients cancel contracts, CityCorp announces layoffs.", 5);
      for (const id of world.citizenOrder) {
        const c = world.citizens[id];
        remember(world, c, { text: "The economy crashed. Everyone's scared.", kind: "world", importance: 7, valence: -0.8, people: [], key: "macro" });
        c.reviewRequested = "crash";
      }
      return "The economy has crashed.";
    }
  }
}

function bestProduct(world: WorldState): string {
  return [...world.productOrder].sort((a, b) => world.market[b].unmetYesterday - world.market[a].unmetYesterday)[0];
}

function spawnBusiness(world: WorldState, citizenId: string, kind: BusinessKind, productId: string, occ: "shopkeeper" | "entrepreneur"): string {
  const c = world.citizens[citizenId];
  if (!c) throw new GodError("No such citizen");
  if (!KIND_INFO[kind]) throw new GodError("Unknown business type");
  if (!findPremises(world, kind)) throw new GodError(`No free premises for a ${KIND_INFO[kind].noun}`);
  const products = kind === "agency" ? [] : kind === "cafe" ? ["food", "coffee"] : [productId].filter((p) => world.products[p]);
  if (kind !== "agency" && products.length === 0) throw new GodError("Pick a product");
  // Heaven provides the start-up capital.
  const capital = 250;
  transfer(world, externalAcc("god"), citizenAcc(c.id), capital, "god", "Divine start-up capital");
  const b = launchBusiness(world, c, { kind, products, expectedProfit: 0, startupCost: capital, reason: "" }, occ);
  if (!b) throw new GodError("Couldn't open the business");
  restockBusiness(world, b, c);
  logEvent(world, "god", `⚡ ${c.name} was blessed with a brand-new business: ${b.name}.`, 5, [c.id], b.id);
  remember(world, c, { text: `Out of nowhere I was handed ${b.name}. Don't waste it.`, kind: "business", importance: 9, valence: 0.9, people: [] });
  return `Opened ${b.name} for ${c.name}.`;
}

/** Hourly: the macro economy drifts toward its current mode, and modes expire. */
export function macroHourly(world: WorldState): void {
  const e = world.economy;
  if (e.mode !== "normal" && world.time >= e.modeUntil) {
    logEvent(world, "market", e.mode === "boom" ? "📊 The boom is cooling off. Things are returning to normal." : "📊 The economy is recovering from the crash.", 4);
    e.mode = "normal";
    e.corpOpenings = 6;
  }
  const target = e.mode === "boom" ? 1.6 : e.mode === "crash" ? 0.5 : 1;
  // Snap the last few percent, otherwise rounding leaves it stuck just short of the target.
  e.multiplier = Math.abs(target - e.multiplier) < 0.05 ? target : round2(e.multiplier + (target - e.multiplier) * 0.12);
}
