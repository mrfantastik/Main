import { getBuildingIndexed } from "../city/lookup";
import { findRoute, nearestRoadTile } from "../city/pathfinding";
import { rand } from "../rng";
import type { Building, Citizen, Vec, WorldState } from "../types";

// Physical movement. Citizens walk along road centre-lines (with a personal
// lane offset so crowds spread out) and then step inside their destination.

function laneOffset(c: Citizen): Vec {
  let h = 0;
  for (let i = 0; i < c.id.length; i++) h = (h * 31 + c.id.charCodeAt(i)) | 0;
  const a = ((h & 0xff) / 255 - 0.5) * 0.7;
  const b = (((h >> 8) & 0xff) / 255 - 0.5) * 0.7;
  return { x: a, y: b };
}

export function randomSpot(world: WorldState, b: Building): Vec {
  const pad = b.w >= 6 ? 0.9 : 0.55;
  return {
    x: b.x + pad + rand(world) * (b.w - pad * 2),
    y: b.y + pad + rand(world) * (b.h - pad * 2),
  };
}

/** Send a citizen walking to a building. */
export function startTravel(world: WorldState, c: Citizen, dest: Building): void {
  const map = world.map;
  const from = c.insideId ? getBuildingIndexed(map, c.insideId)?.door ?? nearestRoadTile(map, c.pos) : nearestRoadTile(map, c.pos);
  const route = findRoute(map, from, dest.door);
  const lane = laneOffset(c);
  const path = route.map((p) => ({ x: p.x + lane.x, y: p.y + lane.y }));
  const spot = randomSpot(world, dest);
  path.push(spot);
  c.path = path;
  c.insideId = null;
  c.spot = spot;
}

/** Advance a walking citizen by one game minute. Returns true on arrival. */
export function moveStep(c: Citizen): boolean {
  if (c.path.length === 0) return false;
  let remaining = c.speed;
  while (remaining > 0 && c.path.length > 0) {
    const target = c.path[0];
    const dx = target.x - c.pos.x;
    const dy = target.y - c.pos.y;
    const d = Math.hypot(dx, dy);
    if (d <= remaining) {
      c.pos = { x: target.x, y: target.y };
      c.path.shift();
      remaining -= d;
    } else {
      c.pos = { x: c.pos.x + (dx / d) * remaining, y: c.pos.y + (dy / d) * remaining };
      remaining = 0;
    }
  }
  return c.path.length === 0;
}

/** Remaining walking distance in tiles (used to estimate travel time). */
export function pathLength(c: Citizen): number {
  let len = 0;
  let prev = c.pos;
  for (const p of c.path) {
    len += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return len;
}

/** Rough travel minutes between a citizen and a building (Manhattan estimate). */
export function travelMinutes(c: Citizen, b: Building): number {
  if (c.insideId === b.id) return 0;
  const d = Math.abs(c.pos.x - (b.door.x + 0.5)) + Math.abs(c.pos.y - (b.door.y + 0.5));
  return Math.round(d / c.speed) + 2;
}
