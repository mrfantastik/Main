import type { Option } from "../ai/decision";
import type { Citizen, PlannedAction, WorldState } from "../types";
import { feelingsToward } from "./emotions";
import { lesson } from "./reflection";

// How feelings, personality and lessons tilt everyday and big decisions.
// Each effect is added as a named factor on the option, so the Mind tab
// shows it ("lonely +0.31") next to the usual reasons. All effects are
// small and bounded: feelings tilt choices, they don't override needs.

const WORK = new Set(["WORK", "MANAGE", "RESTOCK", "TRADE", "RESEARCH", "BROWSE_MARKET", "APPLY_FOR_JOB", "SELL"]);
const SOCIAL = new Set(["SOCIALIZE", "MEET"]);
const REST = new Set(["REST", "GO_HOME"]);

function add(o: Option, name: string, v: number): void {
  if (Math.abs(v) >= 0.005) o.factors[name] = (o.factors[name] ?? 0) + v;
}

/** Tilt "what next?" options by how the citizen feels. */
export function tiltActivities(c: Citizen, options: Option<PlannedAction>[]): void {
  const e = c.emotions;
  const p = c.personality;
  const goOut = lesson(c, "social:out");
  for (const o of options) {
    const type = o.payload?.type;
    if (!type) continue;
    if (SOCIAL.has(type)) {
      add(o, "lonely (feeling)", (e.loneliness / 100) * 0.5 + goOut * 0.12);
      if (o.id === "pub") {
        if (p.likes.includes("the pub")) add(o, "likes the pub", 0.15);
        if (p.dislikes.includes("crowds")) add(o, "hates crowds", -0.12);
      }
      if (o.id === "park_social" && p.likes.includes("the park")) add(o, "likes the park", 0.12);
    } else if (WORK.has(type)) {
      add(o, "feeling low", -(e.sadness / 100) * 0.3);
      add(o, "money fears", (e.fear / 100) * 0.2);
      add(o, "pride", (e.pride / 100) * 0.08);
    } else if (REST.has(type)) {
      add(o, "needs a break", (e.sadness / 100) * 0.2);
      if (o.id === "rest_park" && p.likes.includes("the park")) add(o, "likes the park", 0.1);
      if (o.id === "rest_home" && p.likes.includes("quiet evenings")) add(o, "likes quiet evenings", 0.08);
    }
  }
}

const RISKY = ["career:trader", "career:entrepreneur", "career:shopkeeper", "career:reseller", "expand"];

/** Tilt big decisions (career, business, money) by feelings and lessons. */
export function tiltStrategy(world: WorldState, c: Citizen, options: Option[]): void {
  const e = c.emotions;
  const fear = e.fear / 100;
  const envy = e.envy / 100;
  const workGood = lesson(c, `work:${c.occupation}:+`);
  const workBad = lesson(c, `work:${c.occupation}:-`);
  const save = lesson(c, "money:save");
  for (const o of options) {
    const id = o.id;
    if (id === "deposit") add(o, "afraid of being skint", fear * 0.3 + save * 0.15);
    else if (id === "stay") {
      add(o, "plays it safe", fear * 0.15);
      add(o, "lesson: this works", workGood * 0.12 - workBad * 0.12);
    } else if (RISKY.some((r) => id.startsWith(r)) || id.startsWith("addline") || id.startsWith("invest:")) {
      add(o, "fear of losing", -fear * 0.3);
      if (!id.startsWith("invest:")) add(o, "envy", envy * 0.25);
    } else if (id.startsWith("career:")) {
      add(o, "lesson: time for a change", workBad * 0.1);
    } else if (id === "quit" && c.employerId && c.employerId !== "corp") {
      const boss = world.businesses[c.employerId]?.ownerId;
      if (boss) add(o, "angry with the boss", ((feelingsToward(c, boss).anger ?? 0) / 100) * 0.4);
    } else if (id.startsWith("close")) {
      add(o, "fear of losing", fear * 0.2);
    }
  }
}
