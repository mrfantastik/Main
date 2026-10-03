import { Box3, BufferGeometry, Vector3 } from "three";
import type { Building, CityMap } from "../../sim/types";
import { lampPositions } from "../render/cityLayer";
import { GeoBuilder, hash } from "./geometry";
import { P, ROOFS, setLook, WALLS, type Look } from "./palette";

// Builds the static 3D city once per map: everything that never moves is
// merged into a few geometries (one draw call each).

/** Height of the raised city blocks (pavement / gardens) above the road. */
export const SLAB = 0.12;

/** Which look is being built (set by buildCity). */
let LOOK: Look = "retro";

/** How citizens inside a building are shown. */
export type InsideMode = "home" | "open" | "roof";

export interface BuildingInfo {
  b: Building;
  /** Height of the roof (top of the building). */
  top: number;
  /** Where people "inside" stand when shown: rooftop deck or open ground. */
  deck: { x0: number; z0: number; x1: number; z1: number; y: number };
  mode: InsideMode;
  /** Box used for click picking. */
  box: Box3;
  /** Outward direction of the entrance: 0 south (+z), 1 east, 2 north, 3 west. */
  face: number;
}

export interface CityGeometry {
  /** Ground, roads and buildings (opaque, vertex colours). */
  city: BufferGeometry;
  /** Window panes that light up at night; ranges per building id. */
  windows: BufferGeometry;
  windowRanges: Map<string, { start: number; count: number }>;
  /** Street-lamp heads (glow at night). */
  lampHeads: BufferGeometry;
  /** Pools of lamp light on the road. */
  lampPools: BufferGeometry;
  info: Map<string, BuildingInfo>;
}

/** Which way a building's entrance faces, from its door tile. */
export function doorFace(b: Building): number {
  if (b.door.y >= b.y + b.h) return 0;
  if (b.door.y < b.y) return 2;
  if (b.door.x >= b.x + b.w) return 1;
  return 3;
}

interface Ctx {
  g: GeoBuilder;
  win: GeoBuilder;
  winRanges: Map<string, { start: number; count: number }>;
}

/** Offsets a point on a facade outwards. */
function out(face: number, d: number): [number, number] {
  return face === 0 ? [0, d] : face === 1 ? [d, 0] : face === 2 ? [0, -d] : [-d, 0];
}

/**
 * Windows on the given faces of a box (centre cx/cz, size w x d), `floors`
 * rows starting at y. Each pane goes in the city mesh (glass) and in the
 * night-window mesh (lights).
 */
function windows(c: Ctx, cx: number, cz: number, w: number, d: number, y: number, floors: number, floorH: number, spacing: number, paneW: number, paneH: number, faces: number[], skip?: (face: number, along: number, floor: number) => boolean) {
  for (const face of faces) {
    const len = face % 2 === 0 ? w : d;
    const n = Math.max(1, Math.floor(len / spacing));
    for (let f = 0; f < floors; f++) {
      for (let i = 0; i < n; i++) {
        const along = -len / 2 + (len / n) * (i + 0.5);
        if (skip?.(face, along, f)) continue;
        const px = face % 2 === 0 ? cx + along : cx + (face === 1 ? w / 2 : -w / 2);
        const pz = face % 2 === 0 ? cz + (face === 0 ? d / 2 : -d / 2) : cz + along;
        const yy = y + f * floorH + (floorH - paneH) / 2;
        const [ox, oz] = out(face, 0.012);
        c.g.panel(px + ox, yy, pz + oz, paneW, paneH, face, P.glass);
        const [lx, lz] = out(face, 0.024);
        c.win.panel(px + lx, yy, pz + lz, paneW * 0.86, paneH * 0.86, face, P.windowLit);
      }
    }
  }
}

function door(c: Ctx, b: Building, cx: number, cz: number, w: number, d: number, y: number, face: number, dw = 0.5, dh = 0.85, color: number = P.door) {
  const along = face % 2 === 0 ? b.door.x + 0.5 : b.door.y + 0.5;
  const px = face % 2 === 0 ? along : cx + (face === 1 ? w / 2 : -w / 2);
  const pz = face % 2 === 0 ? cz + (face === 0 ? d / 2 : -d / 2) : along;
  const [ox, oz] = out(face, 0.015);
  c.g.panel(px + ox, y, pz + oz, dw, dh, face, color);
  // a small step in front
  const [sx, sz] = out(face, 0.18);
  c.g.box(px + sx, y - SLAB, pz + sz, face % 2 === 0 ? dw + 0.2 : 0.3, SLAB + 0.04, face % 2 === 0 ? 0.3 : dw + 0.2, P.stone);
}

function tree(g: GeoBuilder, x: number, z: number, y: number, size: number, seed: number) {
  if (LOOK === "dream") {
    // Cypresses and the odd stray column instead of leafy trees.
    if (seed < 0.25) g.column(x, y, z, 1.2 + size * 0.8, 0.09, P.white, seed < 0.08);
    else g.cypress(x, y, z, 1.5 + size * 1.1, [P.leaf, P.leafDark, P.leafLight][Math.floor(seed * 3) % 3], P.trunk);
    return;
  }
  const trunkH = 0.35 + size * 0.25;
  g.box(x, y, z, 0.14, trunkH, 0.14, P.trunk);
  const greens = [P.leaf, P.leafDark, P.leafLight, P.moss];
  const color = greens[Math.floor(seed * greens.length)];
  if (seed > 0.72) {
    g.cone(x, y + trunkH * 0.6, z, 0.42 * size + 0.15, 1.3 * size + 0.4, color, 6);
  } else {
    g.ico(x, y + trunkH + 0.35 * size, z, 0.36 * size + 0.18, color, 0.95);
    if (seed < 0.3) g.ico(x + 0.18, y + trunkH + 0.6 * size, z - 0.1, 0.22 * size + 0.1, color, 1);
  }
}

function bush(g: GeoBuilder, x: number, z: number, y: number, r: number, seed: number) {
  if (LOOK === "dream") {
    g.sphere(x, y + r * 0.8, z, r * 0.9, seed > 0.5 ? P.leafDark : P.moss, 10);
    return;
  }
  g.ico(x, y + r * 0.6, z, r, seed > 0.5 ? P.leafDark : P.moss, 0.7);
}

function flatRoof(c: Ctx, cx: number, cz: number, w: number, d: number, y: number, color: number, parapet = 0.12) {
  c.g.box(cx, y, cz, w + 0.08, 0.1, d + 0.08, color);
  if (parapet > 0) {
    c.g.box(cx, y + 0.1, cz - d / 2, w + 0.08, parapet, 0.08, color);
    c.g.box(cx, y + 0.1, cz + d / 2, w + 0.08, parapet, 0.08, color);
    c.g.box(cx - w / 2, y + 0.1, cz, 0.08, parapet, d + 0.08, color);
    c.g.box(cx + w / 2, y + 0.1, cz, 0.08, parapet, d + 0.08, color);
  }
}

function addBuilding(c: Ctx, b: Building, info: Map<string, BuildingInfo>) {
  const g = c.g;
  const s = hash(b.x, b.y, 7);
  const y = SLAB;
  const cx = b.x + b.w / 2;
  const cz = b.y + b.h / 2;
  const face = doorFace(b);
  const startWin = c.win.vertexCount;
  let top = y;
  let mode: InsideMode = "roof";
  let deck = { x0: b.x + 0.4, z0: b.y + 0.4, x1: b.x + b.w - 0.4, z1: b.y + b.h - 0.4, y: 0 };
  const frontSkip = (doorAlong: number) => (f: number, along: number, floor: number) =>
    f === face && floor === 0 && Math.abs(along - doorAlong) < 0.45;
  const doorAlong = face % 2 === 0 ? b.door.x + 0.5 - cx : b.door.y + 0.5 - cz;

  switch (b.type) {
    case "house": {
      mode = "home";
      const w = b.w - 0.5;
      const d = b.h - 0.5;
      const h = 1.3;
      g.box(cx, y, cz, w, h, d, WALLS[Math.floor(s * WALLS.length)]);
      const roof = ROOFS[Math.floor(hash(b.x, b.y, 3) * ROOFS.length)];
      if (s < 0.55) g.gable(cx, y + h, cz, w + 0.35, d + 0.35, 0.95, roof, face % 2 === 0);
      else g.pyramid(cx, y + h, cz, w + 0.45, d + 0.45, 1.0, roof);
      g.box(cx + w * 0.25, y + h + 0.2, cz - d * 0.2, 0.22, 0.75, 0.22, P.brick);
      windows(c, cx, cz, w, d, y + 0.15, 1, 0.95, 1.2, 0.38, 0.36, [0, 1, 2, 3], frontSkip(doorAlong));
      door(c, b, cx, cz, w, d, y, face);
      bush(g, b.x + 0.25, b.y + 0.25, y, 0.22, s);
      bush(g, b.x + b.w - 0.2, b.y + b.h - 0.25, y, 0.18, 1 - s);
      top = y + h + 1;
      break;
    }
    case "shop_unit": {
      const w = b.w - 0.25;
      const d = b.h - 0.25;
      const h = 1.85;
      g.box(cx, y, cz, w, h, d, s > 0.5 ? P.stone : P.sand);
      // big shop window either side of the door
      const along = face % 2 === 0 ? b.door.x + 0.5 : b.door.y + 0.5;
      const fx = face % 2 === 0 ? along : cx + (face === 1 ? w / 2 : -w / 2);
      const fz = face % 2 === 0 ? cz + (face === 0 ? d / 2 : -d / 2) : along;
      const [ox, oz] = out(face, 0.012);
      const [lx, lz] = out(face, 0.024);
      for (const off of [-0.85, 0.85]) {
        const px = fx + (face % 2 === 0 ? off : 0) + ox;
        const pz = fz + (face % 2 === 0 ? 0 : off) + oz;
        g.panel(px, y + 0.2, pz, 0.75, 0.75, face, P.glass);
        c.win.panel(px - ox + lx, y + 0.24, pz - oz + lz, 0.66, 0.66, face, P.windowLit);
      }
      windows(c, cx, cz, w, d, y + 1.1, 1, 0.7, 0.95, 0.34, 0.3, [face]);
      door(c, b, cx, cz, w, d, y, face, 0.45, 0.85);
      flatRoof(c, cx, cz, w, d, y + h, s > 0.5 ? P.slate : P.stone, 0.14);
      // rooftop clutter: an air-con unit and a vent
      g.box(cx + (s - 0.5) * 1.2, y + h + 0.1, cz - 0.5, 0.6, 0.35, 0.45, P.metal);
      g.cylinder(cx - 0.7, y + h + 0.1, cz + 0.6, 0.12, 0.3, P.metal, 6);
      top = y + h + 0.1;
      break;
    }
    case "apartments": {
      const w = b.w - 0.8;
      const d = b.h - 0.8;
      const h = 6.4;
      g.box(cx, y, cz, w, h, d, P.sand);
      for (let f = 1; f < 7; f++) g.box(cx, y + f * 0.9 - 0.04, cz, w + 0.06, 0.08, d + 0.06, P.stone);
      windows(c, cx, cz, w, d, y + 0.05, 7, 0.9, 1.2, 0.5, 0.48, [0, 1, 2, 3], frontSkip(doorAlong));
      door(c, b, cx, cz, w, d, y, face, 0.8, 0.85);
      flatRoof(c, cx, cz, w, d, y + h, P.slate);
      g.box(cx - 1, y + h + 0.1, cz - 0.8, 1.2, 0.7, 1, P.stone);
      g.cylinder(cx + 1.3, y + h + 0.1, cz + 1.1, 0.45, 0.9, P.rust, 8);
      mode = "home";
      top = y + h + 0.1;
      break;
    }
    case "office": {
      // CityCorp Tower: podium, glass tower, crown and a helipad.
      const pw = b.w - 0.4;
      const pd = b.h - 0.4;
      g.box(cx, y, cz, pw, 1.5, pd, P.slate);
      windows(c, cx, cz, pw, pd, y + 0.1, 1, 1.3, 1.1, 0.8, 0.9, [0, 1, 2, 3], frontSkip(doorAlong));
      door(c, b, cx, cz, pw, pd, y, face, 1, 1);
      const tw = 3.8;
      const th = 8.4;
      g.box(cx, y + 1.5, cz, tw, th, tw, P.sky);
      for (let f = 0; f < 9; f++) g.box(cx, y + 1.5 + f * 0.93 + 0.85, cz, tw + 0.05, 0.08, tw + 0.05, P.slateDark);
      windows(c, cx, cz, tw, tw, y + 1.55, 9, 0.93, 0.6, 0.42, 0.62, [0, 1, 2, 3]);
      const ty = y + 1.5 + th;
      g.box(cx, ty, cz, tw + 0.3, 0.35, tw + 0.3, P.slateDark);
      g.disc(cx, ty + 0.36, cz, 1.25, P.charcoal, 12);
      g.flat(cx - 0.35, ty + 0.37, cz, 0.12, 0.9, P.white);
      g.flat(cx + 0.35, ty + 0.37, cz, 0.12, 0.9, P.white);
      g.flat(cx, ty + 0.37, cz, 0.6, 0.12, P.white);
      top = ty + 0.35;
      deck = { x0: cx - tw / 2 + 0.3, z0: cz - tw / 2 + 0.3, x1: cx + tw / 2 - 0.3, z1: cz + tw / 2 - 0.3, y: 0 };
      flatRoof(c, cx, cz, pw, pd, y + 1.5, P.slateDark, 0.1);
      break;
    }
    case "cowork": {
      const w = b.w - 0.25;
      const d = b.h - 0.25;
      const h = 2.8;
      g.box(cx, y, cz, w, h, d, P.teal);
      for (let f = 0; f < 3; f++) {
        for (const fc of [0, 1, 2, 3]) {
          const len = fc % 2 === 0 ? w : d;
          const [ox, oz] = out(fc, 0.012);
          const px = fc % 2 === 0 ? cx : cx + (fc === 1 ? w / 2 : -w / 2);
          const pz = fc % 2 === 0 ? cz + (fc === 0 ? d / 2 : -d / 2) : cz;
          if (f === 0 && fc === face) continue;
          g.panel(px + ox, y + 0.2 + f * 0.9, pz + oz, len - 0.4, 0.45, fc, P.tealLight);
        }
      }
      windows(c, cx, cz, w, d, y + 0.1, 3, 0.9, 0.7, 0.32, 0.28, [0, 1, 2, 3], frontSkip(doorAlong));
      door(c, b, cx, cz, w, d, y, face, 0.7, 0.9, P.slateDark);
      flatRoof(c, cx, cz, w, d, y + h, P.slateDark);
      bush(g, cx - 0.6, cz - 2, y + h + 0.1, 0.3, 0.2);
      bush(g, cx + 0.6, cz + 2, y + h + 0.1, 0.3, 0.8);
      top = y + h + 0.1;
      break;
    }
    case "lab": {
      const w = b.w - 0.25;
      const d = b.h - 0.25;
      const h = 2.4;
      g.box(cx, y, cz, w, h, d, P.white);
      g.box(cx, y + h * 0.3, cz, w + 0.04, 0.12, d + 0.04, P.tealLight);
      g.box(cx, y + h * 0.68, cz, w + 0.04, 0.12, d + 0.04, P.tealLight);
      windows(c, cx, cz, w, d, y + 0.2, 2, 1, 0.9, 0.4, 0.38, [0, 1, 2, 3], frontSkip(doorAlong));
      door(c, b, cx, cz, w, d, y, face, 0.6, 0.85, P.slate);
      flatRoof(c, cx, cz, w, d, y + h, P.stone, 0.08);
      g.dome(cx, y + h + 0.1, b.y + 1.5, 1.05, P.white);
      g.box(cx + 0.8, y + h + 0.1, cz + 1.5, 0.06, 1.2, 0.06, P.metal);
      top = y + h + 0.1;
      deck = { x0: b.x + 0.4, z0: b.y + 2.8, x1: b.x + b.w - 0.4, z1: b.y + b.h - 0.4, y: 0 };
      break;
    }
    case "bank": {
      const w = b.w - 0.5;
      const d = b.h - 0.9;
      const h = 2.5;
      const bz = cz - 0.2;
      g.box(cx, y, bz, w, h, d, P.stone);
      windows(c, cx, bz, w, d, y + 0.5, 2, 0.95, 1.4, 0.3, 0.55, [1, 2, 3]);
      // portico: steps, columns, pediment
      const fz = bz + d / 2;
      g.box(cx, y, fz + 0.35, w, 0.12, 0.7, P.cream);
      for (let i = 0; i < 4; i++) {
        const px = b.x + 0.45 + i * ((b.w - 0.9) / 3);
        if (LOOK === "dream") g.column(px, y + 0.12, fz + 0.45, h - 0.32, 0.1, P.white);
        else g.cylinder(px, y + 0.12, fz + 0.45, 0.1, h - 0.3, P.cream, 6);
      }
      g.box(cx, y + h - 0.2, fz + 0.35, w, 0.2, 0.75, P.cream);
      g.gable(cx, y + h, cz, w + 0.1, b.h - 0.5, 0.6, P.cream, true);
      g.panel(cx, y, fz + 0.012, 0.6, 1, 0, P.door);
      top = y + h;
      break;
    }
    case "townhall": {
      const w = b.w - 0.4;
      const d = b.h - 0.6;
      const h = 2.3;
      g.box(cx, y, cz, w, h, d, P.cream);
      windows(c, cx, cz, w, d, y + 0.3, 2, 0.95, 1.1, 0.3, 0.5, [0, 1, 2, 3], frontSkip(doorAlong));
      door(c, b, cx, cz, w, d, y, face, 0.7, 1.1);
      flatRoof(c, cx, cz, w, d, y + h, P.sand, 0.1);
      // clock tower with a little spire and a flag
      g.box(cx, y + h + 0.1, cz - 1.2, 1.1, 1.8, 1.1, P.sand);
      g.panel(cx, y + h + 1.1, cz - 1.2 + 0.565, 0.6, 0.6, 0, P.white);
      g.pyramid(cx, y + h + 1.9, cz - 1.2, 1.3, 1.3, 1, P.terracotta);
      g.box(cx, y + h + 2.9, cz - 1.2, 0.05, 0.9, 0.05, P.charcoal);
      g.box(cx + 0.28, y + h + 3.45, cz - 1.2, 0.5, 0.3, 0.03, P.red);
      top = y + h + 0.1;
      deck = { x0: b.x + 0.4, z0: b.y + 2.6, x1: b.x + b.w - 0.4, z1: b.y + b.h - 0.4, y: 0 };
      break;
    }
    case "pub": {
      const w = b.w - 0.3;
      const d = b.h - 0.3;
      const h = 2;
      g.box(cx, y, cz, w, h, d, P.brick);
      g.box(cx, y + 1.0, cz, w + 0.04, 0.14, d + 0.04, P.trunk);
      windows(c, cx, cz, w, d, y + 0.15, 2, 0.95, 0.9, 0.42, 0.42, [0, 1, 2, 3], frontSkip(doorAlong));
      door(c, b, cx, cz, w, d, y, face, 0.55, 0.85);
      flatRoof(c, cx, cz, w, d, y + h, P.charcoal, 0.18);
      const [sx, sz] = out(face, 0.35);
      g.box(cx + sx + 0.7, y + 1.3, cz + sz + (face % 2 === 0 ? 0 : 0.7), 0.5, 0.45, 0.06, P.ochre);
      top = y + h + 0.1;
      break;
    }
    case "diner": {
      const w = b.w - 0.3;
      const d = b.h - 0.3;
      const h = 1.8;
      g.box(cx, y, cz, w, h, d, P.white);
      for (let i = 0; i < 6; i++) g.box(b.x + 0.35 + i * ((b.w - 0.7) / 5), y + h - 0.35, cz, 0.18, 0.35, d + 0.05, P.red);
      g.box(cx, y + h - 0.35, cz, w + 0.05, 0.35, 0.18, P.red);
      windows(c, cx, cz, w, d, y + 0.2, 1, 1.1, 0.8, 0.55, 0.6, [0, 1, 2, 3], frontSkip(doorAlong));
      door(c, b, cx, cz, w, d, y, face, 0.6, 0.85);
      flatRoof(c, cx, cz, w, d, y + h, P.slateDark, 0.08);
      g.box(cx, y + h + 0.1, cz - 1.6, 2, 0.75, 0.15, P.red);
      g.box(cx, y + h + 0.25, cz - 1.53, 1.6, 0.45, 0.04, P.ochre);
      top = y + h + 0.1;
      deck = { x0: b.x + 0.4, z0: b.y + 2, x1: b.x + b.w - 0.4, z1: b.y + b.h - 0.4, y: 0 };
      break;
    }
    case "depot": {
      const w = b.w - 0.4;
      const d = b.h - 1.4;
      const h = 2.6;
      const bz = cz - 0.5;
      g.box(cx, y, bz, w, h, d, P.rust);
      for (let i = 0; i < 7; i++) g.box(b.x + 0.4 + i * ((b.w - 0.8) / 6), y, bz, 0.06, h, d + 0.04, P.trunk);
      for (const off of [-1.5, 0, 1.5]) g.panel(cx + off, y, bz + d / 2 + 0.012, 1.1, 1.5, 0, P.charcoal);
      windows(c, cx, bz, w, d, y + 1.9, 1, 0.6, 0.9, 0.4, 0.3, [1, 2, 3]);
      flatRoof(c, cx, bz, w, d, y + h, P.metal, 0.1);
      for (let i = 0; i < 6; i++) {
        const xx = b.x + 0.5 + hash(i, b.x) * (b.w - 1);
        const zz = b.y + b.h - 0.9 + hash(b.y, i) * 0.5;
        const sz = 0.35 + hash(i, i, 2) * 0.2;
        g.box(xx, y, zz, sz, sz, sz, P.crate);
        if (i % 2 === 0) g.box(xx, y + sz, zz, sz * 0.8, sz * 0.8, sz * 0.8, P.crate);
      }
      top = y + h + 0.1;
      deck = { x0: b.x + 0.5, z0: bz - d / 2 + 0.4, x1: b.x + b.w - 0.5, z1: bz + d / 2 - 0.4, y: 0 };
      break;
    }
    case "market": {
      mode = "open";
      // Decorative stalls on the top two rows (the bottom of the plaza is
      // where citizens' own stalls go).
      const awnings = [P.red, P.ochre, P.leaf, P.sky, P.plum, P.terracotta];
      for (let r = 0; r < 2; r++) {
        for (let k = 0; k < 3; k++) {
          const sx = b.x + 0.62 + k * 2.5 + 0.78;
          const sz = b.y + 0.7 + r * 2.3 + 0.53;
          g.box(sx, y, sz + 0.2, 1.4, 0.5, 0.45, P.trunk);
          for (const [px, pz] of [[-0.65, -0.4], [0.65, -0.4], [-0.65, 0.4], [0.65, 0.4]]) g.box(sx + px, y, sz + pz, 0.06, 1.05, 0.06, P.trunk);
          const color = awnings[(r * 3 + k) % awnings.length];
          for (let st = 0; st < 5; st++) g.box(sx - 0.64 + st * 0.32 + 0.16, y + 1.05, sz, 0.32, 0.08, 1.05, st % 2 ? P.white : color);
        }
      }
      top = y;
      break;
    }
    case "park": {
      mode = "open";
      g.flat(cx, y + 0.005, cz, 0.7, b.h, P.path);
      g.flat(cx, y + 0.006, cz, b.w, 0.7, P.path);
      if (b.id === "park") {
        g.disc(b.x + b.w * 0.27, y + 0.01, b.y + b.h * 0.27, 1.3, P.water, 10);
        g.disc(b.x + b.w * 0.24, y + 0.012, b.y + b.h * 0.24, 0.5, P.waterLight, 8);
      } else {
        g.cylinder(cx, y, cz, 1, 0.25, P.stone, 10);
        g.disc(cx, y + 0.26, cz, 0.85, P.water, 10);
        g.cylinder(cx, y, cz, 0.15, 0.7, P.stone, 6);
      }
      for (let i = 0; i < 14; i++) {
        const tx = b.x + (12 + hash(i, b.x, 3) * (b.w * 32 - 24)) / 32;
        const tz = b.y + (12 + hash(b.y, i, 5) * (b.h * 32 - 24)) / 32;
        if (Math.abs(tx - cx) < 0.45 || Math.abs(tz - cz) < 0.45) continue;
        if (b.id === "park" && tx < b.x + b.w * 0.45 && tz < b.y + b.h * 0.45) continue;
        tree(g, tx, tz, y, 0.8 + hash(i, i) * 0.5, hash(i, b.y));
      }
      g.box(cx + 1.2, y, cz + 0.6, 0.8, 0.2, 0.25, P.trunk);
      g.box(cx - 1.2, y, cz - 0.6, 0.8, 0.2, 0.25, P.trunk);
      if (LOOK === "dream" && b.id !== "park") {
        // A little ring of columns round the fountain: the town's folly.
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + 0.3;
          g.column(cx + Math.cos(a) * 1.75, y, cz + Math.sin(a) * 1.75, 2.4, 0.11, P.white, i === 4);
        }
      }
      top = y;
      break;
    }
    case "green": {
      mode = "open";
      for (let i = 0; i < 20; i++) {
        tree(g, b.x + (10 + hash(i, b.x, 9) * (b.w * 32 - 20)) / 32, b.y + (10 + hash(b.y, i, 2) * (b.h * 32 - 20)) / 32, y, 0.7 + hash(i, 3) * 0.6, hash(i, b.x));
      }
      top = y;
      break;
    }
  }
  if (mode === "roof" || mode === "home") deck.y = top + 0.02;
  else deck = { x0: b.x + 0.2, z0: b.y + 0.2, x1: b.x + b.w - 0.2, z1: b.y + b.h - 0.2, y: SLAB };
  const end = c.win.vertexCount;
  if (end > startWin) c.winRanges.set(b.id, { start: startWin, count: end - startWin });
  info.set(b.id, {
    b,
    top,
    deck,
    mode,
    face,
    box: new Box3(new Vector3(b.x, 0, b.y), new Vector3(b.x + b.w, Math.max(top, SLAB + 0.3), b.y + b.h)),
  });
}

/** What each 8x8 block looks like underneath its buildings. */
function blockSurface(map: CityMap, x0: number, y0: number): number {
  const inside = map.buildings.filter((b) => b.x >= x0 && b.x < x0 + 8 && b.y >= y0 && b.y < y0 + 8);
  if (inside.some((b) => b.type === "park")) return P.grass;
  if (inside.some((b) => b.type === "green")) return P.meadow;
  if (inside.some((b) => b.type === "market")) return P.paving;
  if (inside.some((b) => b.type === "house")) return P.grass;
  return P.pavement;
}

export function buildCity(map: CityMap, look: Look = "retro"): CityGeometry {
  LOOK = look;
  setLook(look);
  const c: Ctx = { g: new GeoBuilder(), win: new GeoBuilder(), winRanges: new Map() };
  const g = c.g;
  const W = map.width;
  const H = map.height;
  const dream = look === "dream";

  // Ground: countryside around the town, asphalt for the street grid. (The
  // dreamscape stands on a reflective tiled floor drawn separately.)
  if (!dream) {
    g.flat(W / 2, -0.03, H / 2, W + 90, H + 90, P.grassDark);
    g.flat(W / 2, 0, H / 2, W, H, P.asphalt);
  }

  // Raised blocks with a kerb rim.
  for (let y0 = 2; y0 < H; y0 += 10) {
    for (let x0 = 2; x0 < W; x0 += 10) {
      g.box(x0 + 4, 0, y0 + 4, 8, SLAB, 8, P.kerb);
      const surface = blockSurface(map, x0, y0);
      g.flat(x0 + 4, SLAB + 0.002, y0 + 4, 7.8, 7.8, surface);
      if (surface === P.grass && !map.buildings.some((b) => b.type === "park" && b.x === x0)) {
        // garden paths from each house to the pavement
        for (const b of map.buildings) {
          if (b.type !== "house" || b.x < x0 || b.x >= x0 + 8 || b.y < y0 || b.y >= y0 + 8) continue;
          const toTop = b.door.y < b.y;
          const pz0 = toTop ? y0 : b.y + b.h;
          const pz1 = toTop ? b.y : y0 + 8;
          g.flat(b.door.x + 0.5, SLAB + 0.004, (pz0 + pz1) / 2, 0.5, Math.max(0.2, pz1 - pz0), P.path);
        }
      }
    }
  }

  // Lane markings and zebra crossings.
  for (let k = 0; !dream && k * 10 <= H - 2; k++) {
    const zc = k * 10 + 1;
    for (let x = 0; x < W; x += 2) if (x % 10 >= 2) g.flat(x + 0.5, 0.008, zc, 0.9, 0.07, P.lane);
  }
  for (let k = 0; !dream && k * 10 <= W - 2; k++) {
    const xc = k * 10 + 1;
    for (let y = 0; y < H; y += 2) if (y % 10 >= 2) g.flat(xc, 0.008, y + 0.5, 0.07, 0.9, P.lane);
  }
  for (let iy = 0; !dream && iy < H; iy += 10) {
    for (let ix = 0; ix < W; ix += 10) {
      for (let k = 0; k < 4; k++) {
        if (ix + 2 < W) g.flat(ix + 2.35, 0.009, iy + 0.25 + k * 0.5, 0.45, 0.25, P.lane);
        if (iy + 2 < H) g.flat(ix + 0.25 + k * 0.5, 0.009, iy + 2.35, 0.25, 0.45, P.lane);
      }
    }
  }

  // Dreamscape: columns standing about on the endless floor, some fallen short.
  for (let i = 0; dream && i < 70; i++) {
    const a = hash(i, 23, 4) * Math.PI * 2;
    const rr = hash(i, 5, 19);
    const x = W / 2 + Math.cos(a) * (W / 2 + 4 + rr * 40);
    const z = H / 2 + Math.sin(a) * (H / 2 + 4 + rr * 34);
    const tall = 2.5 + hash(i, 9, 1) * 5.5;
    g.column(x, 0, z, tall, 0.16 + tall * 0.025, P.white, hash(i, 2, 8) < 0.22);
  }

  // Countryside: scattered trees and hedges around the edge of town.
  for (let i = 0; !dream && i < 140; i++) {
    const a = hash(i, 17, 4) * Math.PI * 2;
    const rr = 0.5 + hash(i, 5, 9) * 0.9;
    const x = W / 2 + Math.cos(a) * (W / 2 + 2 + rr * 14);
    const z = H / 2 + Math.sin(a) * (H / 2 + 2 + rr * 12);
    if (x > -1.5 && x < W + 1.5 && z > -1.5 && z < H + 1.5) continue;
    if (hash(i, 2, 2) > 0.85) bush(g, x, z, -0.03, 0.4, hash(i, 1));
    else tree(g, x, z, -0.03, 0.8 + hash(i, 3, 3) * 0.7, hash(i, 7));
  }

  const info = new Map<string, BuildingInfo>();
  for (const b of map.buildings) addBuilding(c, b, info);

  // Street lamps: a post on the nearest pavement corner, light pooled on the road.
  const heads = new GeoBuilder();
  const pools = new GeoBuilder();
  for (const l of lampPositions(map)) {
    // On a road crossing the post goes on the next block's kerb (or the
    // previous one at the edge of town); mid-road lamps step onto the kerb.
    const px = l.x % 10 === 1 ? (l.x + 1 < W - 0.5 ? l.x + 1.18 : l.x - 1.18) : l.x;
    const pz = l.y % 10 === 1 ? (l.y + 1 < H - 0.5 ? l.y + 1.18 : l.y - 1.18) : l.y;
    g.box(px, SLAB, pz, 0.08, 1.7, 0.08, P.lampPost);
    g.box(px, SLAB + 1.65, pz, 0.24, 0.05, 0.24, P.lampPost);
    heads.box(px, SLAB + 1.5, pz, 0.2, 0.16, 0.2, 0xffffff);
    pools.glow(l.x, 0.02, l.y, 2.3, P.lampOn);
  }

  return {
    city: g.build(),
    windows: c.win.build(),
    windowRanges: c.winRanges,
    lampHeads: heads.build(),
    lampPools: pools.build(),
    info,
  };
}
