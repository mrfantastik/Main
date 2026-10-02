import type { BusinessId, CitizenId, EventCategory, SimEvent, WorldState } from "./types";
import { newId, pushRing } from "./util";

export const EVENT_LIMIT = 800;

/** Adds an entry to the live event feed. */
export function logEvent(
  world: WorldState,
  cat: EventCategory,
  text: string,
  importance: number,
  citizens: CitizenId[] = [],
  businessId: BusinessId | null = null,
): SimEvent {
  const ev: SimEvent = { id: newId(world), t: world.time, cat, text, importance, citizens, businessId };
  pushRing(world.events, ev, EVENT_LIMIT);
  return ev;
}
