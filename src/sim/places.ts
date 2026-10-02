import { getBuildingIndexed } from "./city/lookup";
import type { WorldState } from "./types";

/** Building name, or the business occupying it (e.g. "Mike's Café" instead of "Unit 2"). */
export function placeName(world: WorldState, buildingId: string | null): string {
  const b = getBuildingIndexed(world.map, buildingId);
  if (!b) return "town";
  if (b.businessId && world.businesses[b.businessId]?.open) return world.businesses[b.businessId].name;
  return b.name;
}
