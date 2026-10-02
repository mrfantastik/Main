import type { Building, BuildingType, CityMap } from "../types";

// Fast building lookups. The index is rebuilt lazily whenever the map object
// changes (e.g. after loading a save).

const indexCache = new WeakMap<CityMap, Map<string, Building>>();

export function getBuildingIndexed(map: CityMap, id: string | null | undefined): Building | undefined {
  if (!id) return undefined;
  let idx = indexCache.get(map);
  if (!idx || idx.size !== map.buildings.length) {
    idx = new Map(map.buildings.map((b) => [b.id, b]));
    indexCache.set(map, idx);
  }
  return idx.get(id);
}

export function firstOfType(map: CityMap, type: BuildingType): Building {
  const b = map.buildings.find((x) => x.type === type);
  if (!b) throw new Error(`No building of type ${type}`);
  return b;
}
