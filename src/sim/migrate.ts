import { neutralEmotions } from "./mind/emotions";
import { generatePersonality } from "./mind/personality";
import type { WorldState } from "./types";
import { WORLD_VERSION } from "./world";

/**
 * Prepare a world loaded from disk for running. Fills in fields that older
 * saves may lack and clears transient state that can't survive a restart
 * (in-flight Claude requests). Returns null if the save is unusable.
 */
export function prepareLoadedWorld(raw: unknown): WorldState | null {
  try {
    return migrate(raw);
  } catch {
    return null;
  }
}

function migrate(raw: unknown): WorldState | null {
  const w = raw as WorldState;
  if (!w || typeof w !== "object" || !w.citizens || !w.map || typeof w.time !== "number") return null;
  if (!Array.isArray(w.citizenOrder) || !Array.isArray(w.businessOrder) || !Array.isArray(w.productOrder) || !w.economy || !w.ai || !w.market || !w.stats) return null;
  if (w.citizenOrder.some((id) => !w.citizens[id])) return null;
  if ((w.version ?? 0) > WORLD_VERSION) return null;
  w.id ??= `w${(w.seed ?? 0).toString(36)}-legacy`;
  w.conversationLog ??= [];
  w.listings ??= [];
  w.loans ??= [];
  w.shocks ??= [];
  w.inventionPool ??= [];
  w.ai.log ??= [];
  w.economy.rentIndex ??= 1;
  for (const id of w.citizenOrder) {
    const c = w.citizens[id];
    c.strategyLog ??= [];
    c.workLog ??= [];
    c.workedToday ??= 0;
    c.thoughtT ??= 0;
    c.thoughtPriority ??= 0;
    c.awaitingAI = false;
    // Saves from before personalities: generate one (deterministic from the
    // seed and citizen) and start them calm.
    c.personality ??= generatePersonality(w.seed ?? 0, c);
    c.emotions ??= neutralEmotions();
    c.reflections ??= [];
    c.lastReflectionDay ??= 0;
  }
  for (const pid of w.productOrder) {
    const m = w.market[pid];
    m.tape ??= [m.wholesale];
    m.unmetYesterday ??= 0;
  }
  for (const bid of w.businessOrder) {
    const b = w.businesses[bid];
    b.salesAvg ??= {};
    b.missedToday ??= 0;
    b.missedYesterday ??= 0;
    b.staffedHoursToday ??= 0;
    b.staffedHoursYesterday ??= 0;
    b.agencyEarned ??= 0;
  }
  // Conversations waiting on an AI reply fall back to their template version.
  for (const conv of w.conversations) {
    if (conv.status === "awaiting_ai" && conv.fallback) {
      conv.status = "talking";
      conv.lines = conv.fallback.lines;
      conv.outcome = conv.fallback.outcome;
    }
  }
  return w;
}
