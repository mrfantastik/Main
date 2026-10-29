import { hourOf, dayOf } from "../time";
import type { Citizen, WorldState } from "../types";
import { setRumourHook } from "../dialogue/knowledge";
import { adjustRel } from "../social/relationships";
import { SOCIETY } from "./config";
import { checkAction, carryOut, readAction } from "./actions";
import { projectsDaily } from "./projects";
import { heardAboutMe, reputationDaily } from "./reputation";
import { proposeByRules } from "./propose";
import { activeGoals, fillRoster, logDecision, onRoster, settleDecision, societyOf, societyWorld } from "./state";
import type { AgentAction, AgentDecision } from "./types";

// When agents stop to think, and what keeps their plans honest. Each agent
// (while awake and free) reconsiders every few hours, sooner when something
// big happens to them. Agents on the roster ask the language model (through
// the hook the AI director installs); the rest, and anyone the model can't
// answer for, decide by the built-in judgement. Whatever is decided goes
// through the same check and the same log.

/** Asks the model to decide for someone (returns false if it can't take it on now). */
export type DecisionHook = (world: WorldState, c: Citizen, why: string) => boolean;
let decisionHook: DecisionHook | null = null;
/** Whether the model is driving the roster's social lives right now (so the built-in habits stand back). */
let modelDrives: ((world: WorldState) => boolean) | null = null;

export function setDecisionHook(hook: DecisionHook | null, drives: ((world: WorldState) => boolean) | null = null): void {
  decisionHook = hook;
  modelDrives = drives;
}

/** This citizen's social and economic moves come from the model (not the built-in habits). */
export function modelRuns(world: WorldState, c: Citizen): boolean {
  return !!modelDrives && modelDrives(world) && onRoster(world, c.id);
}

/** Decide something for them: the world checks it, then it's done (or they're told why not). */
export function decide(world: WorldState, c: Citizen, a: AgentAction, source: "llm" | "rules", why?: string): AgentDecision {
  const d = logDecision(world, c, a, source, why);
  const err = checkAction(world, c, a);
  if (err) {
    settleDecision(c, d.id, "rejected", `Couldn't: ${err}.`, err);
    return d;
  }
  const result = carryOut(world, c, a, d);
  const s = societyOf(world, c);
  s.intention = { text: result, t: world.time, source };
  return d;
}

/**
 * The model's answer for someone: read it, check it, do it. If it's no good
 * (unknown action, impossible, nonsense), that's logged as rejected and the
 * built-in judgement decides instead.
 */
export function applyModelDecision(world: WorldState, c: Citizen, reply: unknown, note?: string): { decision: AgentDecision; fallback: AgentDecision | null } {
  const r = readAction(world, c, (reply as { decision?: unknown } | null)?.decision ?? reply);
  const intention = typeof (reply as { intention?: unknown } | null)?.intention === "string" ? String((reply as { intention: string }).intention).slice(0, 160) : null;
  if (!r.ok) {
    const d = logDecision(world, c, { type: "carry_on", reason: "(the model's answer couldn't be used)" }, "llm", note);
    settleDecision(c, d.id, "rejected", `Couldn't use it: ${r.error}.`, r.error);
    return { decision: d, fallback: rulesDecide(world, c, `after the model's answer was turned down (${r.error})`) };
  }
  const d = decide(world, c, r.action, "llm", note);
  if (intention && d.status !== "rejected") societyOf(world, c).intention = { text: intention, t: world.time, source: "llm" };
  if (d.status === "rejected") return { decision: d, fallback: rulesDecide(world, c, `after the model's choice wasn't possible (${d.error})`) };
  return { decision: d, fallback: null };
}

/** The built-in judgement decides. */
export function rulesDecide(world: WorldState, c: Citizen, why = ""): AgentDecision {
  const p = proposeByRules(world, c);
  return decide(world, c, p.action, "rules", `${why ? `${why}; ` : ""}weighed: ${p.why}`);
}

/** Something big happened to them since they last thought: think again. */
function shaken(c: Citizen, since: number): string | null {
  if (c.shock && c.shock.t > since) return c.shock.text;
  const m = [...c.memories.short].reverse().find((x) => x.t > since && x.importance >= 7 && x.kind !== "conversation");
  return m ? m.text : null;
}

/** Every ten minutes: anyone due to think about what to do next does. */
export function societyTick(world: WorldState): void {
  const sw = societyWorld(world);
  if (sw.roster.length < sw.size) fillRoster(world);
  const h = hourOf(world.time);
  if (h < 7 || h >= 22) return;
  for (const id of world.citizenOrder) {
    const c = world.citizens[id];
    const s = societyOf(world, c);
    // Intentions they never got round to.
    for (const it of s.intents.filter((x) => world.time > x.until)) settleDecision(c, it.decision, "expired", "Never got the chance.");
    s.intents = s.intents.filter((x) => world.time <= x.until);
    if (c.activity.kind === "sleep" || c.activity.kind === "talk" || c.awaitingAI) continue;
    const roster = onRoster(world, c.id);
    const since = world.time - s.lastThought;
    const jolt = since >= SOCIETY.minThinkGap ? shaken(c, s.lastThought) : null;
    if (since < (roster ? SOCIETY.thinkEvery : SOCIETY.rulesThinkEvery) && !jolt) continue;
    s.lastThought = world.time;
    const why = jolt ? `after: ${jolt}` : "time to take stock";
    if (roster && decisionHook && decisionHook(world, c, why)) continue;
    rulesDecide(world, c, why);
  }
}

/** Every night: plans checked against the real town, goals ticked off, a line about the day. */
export function societyDaily(world: WorldState): void {
  const day = dayOf(world.time) - 1;
  reputationDaily(world);
  for (const id of world.citizenOrder) {
    const c = world.citizens[id];
    const s = societyOf(world, c);
    projectsDaily(world, c);
    // Goals the town says they've reached.
    for (const g of activeGoals(c)) {
      const met =
        (g.kind === "get_job" && (c.occupation === "employee" || !!c.employerId)) ||
        (g.kind === "start_business" && c.businessIds.some((b) => world.businesses[b]?.open)) ||
        (g.kind === "pay_debts" && !world.loans.some((l) => l.borrower === c.id && l.status === "active")) ||
        (g.kind === "find_love" && Object.values(c.relationships).some((r) => r.roles.includes("couple")));
      if (met) g.status = "achieved";
    }
    // Their day, in a line (from their own side).
    // What came of what they decided (not what they meant to do), and how their plans went.
    const today = s.decisions.filter((d) => dayOf(d.t) === day && d.action.type !== "carry_on" && d.status !== "pending");
    const bits = [...new Set(today.slice(-3).map((d) => d.result ?? d.action.type))];
    const proj = s.projects.filter((p) => p.log.some((l) => dayOf(l.t) === day)).map((p) => `${p.title}: ${p.log[p.log.length - 1].text}`);
    const text = [...new Set([...bits, ...proj])].join(" ").slice(0, 260);
    if (text) {
      s.days.push({ day, text });
      if (s.days.length > SOCIETY.daysKept) s.days.shift();
    }
  }
}

// Believing a rumour about someone changes what you think of them (unless you know them too well to buy it).
setRumourHook((world, listener, f) => {
  if (!f.about) return;
  // A story about themselves: hurt, and angry with whoever's telling it.
  if (f.about === listener.id) {
    heardAboutMe(world, listener, f.from ?? undefined);
    return;
  }
  const r = listener.relationships[f.about];
  const loyal = (r?.affinity ?? 0) > 55 || listener.family.includes(f.about);
  const credulity = (1 - listener.personality.big5.conscientiousness * 0.5) * f.certainty;
  if (loyal) {
    // They stick up for them, and think less of whoever's spreading it.
    if (f.from) adjustRel(world, listener, f.from, { affinity: -4, trust: -6 });
    return;
  }
  adjustRel(world, listener, f.about, { affinity: -Math.round(4 + credulity * 6), trust: -Math.round(3 + credulity * 8) });
  const sw = world.society;
  const rumour = sw?.rumours.find((x) => x.id === f.rumour);
  if (rumour) rumour.heard++;
});
