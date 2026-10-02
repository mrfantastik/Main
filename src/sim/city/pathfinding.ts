import { TILE_ROAD, type CityMap, type Vec } from "../types";
import { PERIOD, ROAD } from "./map";

// A* over road tiles with a turn penalty (so people walk in straight lines),
// then the tile path is snapped to road centre-lines and simplified into a
// few waypoints. Results are cached: most trips (home -> work) repeat.

const DIRS = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];
const TURN_PENALTY = 4;

const cache = new Map<string, Vec[]>();
const CACHE_LIMIT = 4000;

class MinHeap {
  private items: { k: number; v: number }[] = [];
  get size() {
    return this.items.length;
  }
  push(k: number, v: number) {
    const a = this.items;
    a.push({ k, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].k <= a[i].k) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].k < a[m].k) m = l;
        if (r < a.length && a[r].k < a[m].k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top.v;
  }
}

function isRoad(map: CityMap, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.width && y < map.height && map.tiles[y * map.width + x] === TILE_ROAD;
}

/** Nearest road tile to a continuous position. */
export function nearestRoadTile(map: CityMap, p: Vec): Vec {
  const tx = Math.floor(p.x);
  const ty = Math.floor(p.y);
  if (isRoad(map, tx, ty)) return { x: tx, y: ty };
  for (let r = 1; r < 12; r++) {
    let best: Vec | null = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx;
        const y = ty + dy;
        if (!isRoad(map, x, y)) continue;
        const d = (x + 0.5 - p.x) ** 2 + (y + 0.5 - p.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { x, y };
        }
      }
    }
    if (best) return best;
  }
  return { x: 0, y: 0 };
}

function tilePath(map: CityMap, from: Vec, to: Vec): Vec[] {
  const W = map.width;
  const startIdx = from.y * W + from.x;
  const goalIdx = to.y * W + to.x;
  if (startIdx === goalIdx) return [from];
  const n = W * map.height * 4;
  const g = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap = new MinHeap();
  const h = (idx: number) => Math.abs((idx % W) - to.x) + Math.abs(Math.floor(idx / W) - to.y);
  for (let d = 0; d < 4; d++) {
    const s = startIdx * 4 + d;
    g[s] = 0;
    heap.push(h(startIdx), s);
  }
  let found = -1;
  while (heap.size > 0) {
    const s = heap.pop();
    const idx = s >> 2;
    const dir = s & 3;
    if (idx === goalIdx) {
      found = s;
      break;
    }
    const x = idx % W;
    const y = Math.floor(idx / W);
    for (let nd = 0; nd < 4; nd++) {
      const nx = x + DIRS[nd].x;
      const ny = y + DIRS[nd].y;
      if (!isRoad(map, nx, ny)) continue;
      const ns = (ny * W + nx) * 4 + nd;
      const cost = g[s] + 1 + (nd !== dir ? TURN_PENALTY : 0);
      if (cost < g[ns]) {
        g[ns] = cost;
        prev[ns] = s;
        heap.push(cost + h(ny * W + nx), ns);
      }
    }
  }
  if (found < 0) return [from, to];
  const out: Vec[] = [];
  for (let s = found; s >= 0; s = prev[s]) {
    const idx = s >> 2;
    const p = { x: idx % W, y: Math.floor(idx / W) };
    const last = out[out.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) out.push(p);
  }
  return out.reverse();
}

/** Continuous point for a road tile, snapped to the centre of its road band. */
function snap(t: Vec): Vec {
  const inV = t.x % PERIOD < ROAD;
  const inH = t.y % PERIOD < ROAD;
  return {
    x: inV ? Math.floor(t.x / PERIOD) * PERIOD + ROAD / 2 : t.x + 0.5,
    y: inH ? Math.floor(t.y / PERIOD) * PERIOD + ROAD / 2 : t.y + 0.5,
  };
}

function simplify(points: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      const collinear = (Math.abs(a.x - b.x) < 1e-6 && Math.abs(b.x - p.x) < 1e-6) || (Math.abs(a.y - b.y) < 1e-6 && Math.abs(b.y - p.y) < 1e-6);
      if (collinear) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

/** Waypoints along roads from one road tile to another. */
export function findRoute(map: CityMap, fromTile: Vec, toTile: Vec): Vec[] {
  const key = `${fromTile.x},${fromTile.y}>${toTile.x},${toTile.y}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const route = simplify(tilePath(map, fromTile, toTile).map(snap));
  if (cache.size > CACHE_LIMIT) cache.clear();
  cache.set(key, route);
  return route;
}
