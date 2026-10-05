import {
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
  type Material,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { COLUMN_BASE_H, COLUMN_CAPITAL_H, columnBaseGeometry, columnCapitalGeometry, columnShaftGeometry, hash } from "../geometry";

// The dreamscape around the town: processional colonnades leading away from
// it on all four sides (some columns still carrying their beams, some
// snapped, some fallen in pieces), the ruins of two little temples, lone
// columns scattered over the floor, giant columns far off on the horizon,
// polished spheres at the ends of the avenues, and a marble band framing the
// town. Every column is drawn from a handful of instanced shapes, so they
// can be properly detailed (fluted shafts, Attic bases, Ionic scrolls).

interface Placement {
  m: Matrix4;
}

const tmpQ = new Quaternion();
const tmpE = new Euler();
const tmpP = new Vector3();
const tmpS = new Vector3();

function at(x: number, y: number, z: number, sx: number, sy: number, sz: number, rx = 0, ry = 0, rz = 0): Placement {
  tmpQ.setFromEuler(tmpE.set(rx, ry, rz, "YXZ"));
  return { m: new Matrix4().compose(tmpP.set(x, y, z), tmpQ, tmpS.set(sx, sy, sz)) };
}

/** A column drum with closed ends (for fallen pieces): fluted, radius 1, from y = 0 to 1. */
function drumGeometry(): BufferGeometry {
  const shaft = columnShaftGeometry(20);
  const bottom = new CircleGeometry(1, 30);
  bottom.rotateX(Math.PI / 2);
  const top = new CircleGeometry(0.86, 30);
  top.rotateX(-Math.PI / 2);
  top.translate(0, 1, 0);
  const parts = [shaft, bottom, top].map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    n.deleteAttribute("uv");
    return n;
  });
  const g = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return g;
}

/** The jagged top of a snapped column (radius 1): a short piece with a broken, uneven top face. */
function brokenGeometry(): BufferGeometry {
  const g = new CylinderGeometry(0.9, 0.92, 0.3, 20, 1, false);
  g.translate(0, 0.15, 0);
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) < 0.2) continue;
    const a = Math.atan2(p.getZ(i), p.getX(i));
    const r = Math.hypot(p.getX(i), p.getZ(i));
    const jag = 0.12 * Math.sin(a * 3 + 1) + 0.08 * Math.sin(a * 7) + (r < 0.1 ? 0.05 : 0);
    p.setY(i, p.getY(i) + jag);
  }
  const n = g.toNonIndexed();
  g.dispose();
  n.computeVertexNormals();
  return n;
}

export class DreamRuins {
  readonly group = new Group();
  private readonly meshes: InstancedMesh[] = [];
  private readonly marble: MeshStandardMaterial;
  private readonly chrome: MeshStandardMaterial;

  constructor(W: number, H: number) {
    this.marble = new MeshStandardMaterial({ color: 0xf3edf6, roughness: 0.36, metalness: 0, envMapIntensity: 0.75 });
    this.chrome = new MeshStandardMaterial({ color: 0xe8e2f2, roughness: 0.04, metalness: 1, envMapIntensity: 1.25 });
    const L = {
      base: [] as Placement[],
      shaft: [] as Placement[],
      capital: [] as Placement[],
      broken: [] as Placement[],
      drum: [] as Placement[],
      box: [] as Placement[],
      sphere: [] as Placement[],
    };
    let seed = 1;
    const rnd = () => hash(seed++, 77, 3);

    const column = (x: number, z: number, h: number, r: number, broken = false) => {
      L.base.push(at(x, 0, z, r, r, r));
      const shaftH = broken ? h * (0.3 + rnd() * 0.4) : h - (COLUMN_BASE_H + COLUMN_CAPITAL_H) * r;
      L.shaft.push(at(x, COLUMN_BASE_H * r, z, r, shaftH, r));
      const top = COLUMN_BASE_H * r + shaftH;
      if (broken) L.broken.push(at(x, top - 0.02, z, r, r, r, (rnd() - 0.5) * 0.3, rnd() * 6.28, (rnd() - 0.5) * 0.3));
      else L.capital.push(at(x, top, z, r, r, r, 0, rnd() < 0.5 ? 0 : Math.PI / 2));
      return broken ? 0 : h;
    };
    /** A fallen column: drums lying in a line where it came down, the capital tipped over at the end. */
    const fallen = (x: number, z: number, angle: number, r: number, pieces: number) => {
      let d = 0;
      const dx = Math.cos(angle);
      const dz = Math.sin(angle);
      L.base.push(at(x, 0, z, r, r, r));
      for (let i = 0; i < pieces; i++) {
        const len = r * (2.2 + rnd() * 2.2);
        const a = angle + (rnd() - 0.5) * 0.35;
        d += r * 1.6 + (i === 0 ? r : 0.12 + rnd() * 0.5);
        // Lying on its side: its axis turned from up to along the ground.
        const cx = x + dx * d;
        const cz = z + dz * d;
        const m = new Matrix4().makeTranslation(cx, r * 0.97, cz);
        m.multiply(new Matrix4().makeRotationY(-a));
        m.multiply(new Matrix4().makeRotationZ(-Math.PI / 2));
        m.multiply(new Matrix4().makeScale(r, len, r));
        m.multiply(new Matrix4().makeTranslation(0, -0.5, 0));
        L.drum.push({ m });
        d += len;
      }
      if (rnd() < 0.7) L.capital.push(at(x + dx * (d + r * 1.8), r * 1.35, z + dz * (d + r * 1.8), r, r, r, 1.25, angle + rnd(), 0.2));
    };
    /** A beam (architrave and cornice) resting on two column tops. */
    const beam = (x0: number, z0: number, x1: number, z1: number, y: number, r: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0) + r * 2.9;
      const ang = Math.atan2(z1 - z0, x1 - x0);
      const mx = (x0 + x1) / 2;
      const mz = (z0 + z1) / 2;
      L.box.push(at(mx, y + r * 0.6, mz, len, r * 1.2, r * 2.4, 0, -ang, 0));
      L.box.push(at(mx, y + r * 1.8, mz, len + r * 0.5, r * 0.45, r * 2.9, 0, -ang, 0));
    };

    const cx = W / 2;
    const cz = H / 2;
    // Four processional avenues, one from the middle of each side of town.
    const dirs: [number, number, number, number][] = [
      [cx, -3.5, 0, -1],
      [cx, H + 3.5, 0, 1],
      [-3.5, cz, -1, 0],
      [W + 3.5, cz, 1, 0],
    ];
    for (const [sx, sz, ux, uz] of dirs) {
      const px = -uz;
      const pz = ux;
      for (let k = 0; k < 10; k++) {
        const gate = k === 0;
        const r = gate ? 0.3 : 0.22;
        const h = gate ? 6.2 : 4.6;
        const half = gate ? 2.9 : 2.5;
        const d = gate ? 0 : 2.6 + k * 3.3;
        const bx = sx + ux * d;
        const bz = sz + uz * d;
        const ax = bx + px * half;
        const az = bz + pz * half;
        const cx2 = bx - px * half;
        const cz2 = bz - pz * half;
        const roll = rnd();
        if (!gate && roll < 0.1) {
          // One of the pair has come down.
          column(ax, az, h, r);
          fallen(cx2, cz2, Math.atan2(uz, ux) + (rnd() - 0.5) * 1.2, r, 2 + Math.floor(rnd() * 2));
          continue;
        }
        const brokenA = !gate && roll > 0.82;
        const brokenB = !gate && roll > 0.72 && roll < 0.8;
        const ha = column(ax, az, h, r, brokenA);
        const hb = column(cx2, cz2, h, r, brokenB);
        if (ha && hb && (gate || rnd() < 0.42)) beam(ax, az, cx2, cz2, h, r);
      }
      // A polished sphere on a low plinth where the avenue ends.
      const ex = sx + ux * (2.6 + 10 * 3.3 + 3);
      const ez = sz + uz * (2.6 + 10 * 3.3 + 3);
      L.box.push(at(ex, 0, ez, 3.4, 0.5, 3.4));
      L.box.push(at(ex, 0.5, ez, 2.8, 0.3, 2.8));
      L.sphere.push(at(ex, 0.8 + 1.35, ez, 1.35, 1.35, 1.35));
    }

    // A marble band framing the town.
    const bw = 1.1;
    const g = 0.35;
    L.box.push(at(cx, 0, -g - bw / 2, W + 2 * (g + bw), 0.05, bw));
    L.box.push(at(cx, 0, H + g + bw / 2, W + 2 * (g + bw), 0.05, bw));
    L.box.push(at(-g - bw / 2, 0, cz, bw, 0.05, H + 2 * g));
    L.box.push(at(W + g + bw / 2, 0, cz, bw, 0.05, H + 2 * g));

    // Two ruined temples in opposite corners: a ring of columns on a stepped platform, half of it fallen.
    for (const [tx, tz, rot] of [
      [-16, -14, 0.4],
      [W + 17, H + 13, -0.5],
    ] as [number, number, number][]) {
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      L.box.push(at(tx, 0, tz, 10.5, 0.3, 7.5, 0, -rot, 0));
      L.box.push(at(tx, 0.3, tz, 9.5, 0.3, 6.5, 0, -rot, 0));
      const pts: [number, number][] = [];
      for (let i = 0; i < 4; i++) pts.push([-3.9 + i * 2.6, -2.5], [-3.9 + i * 2.6, 2.5]);
      pts.push([-3.9, 0], [3.9, 0]);
      const tops: ([number, number, number] | null)[] = [];
      for (const [lx, lz] of pts) {
        const x = tx + lx * c - lz * s;
        const z = tz + lx * s + lz * c;
        const roll = rnd();
        if (roll < 0.2) {
          fallen(x, z, rnd() * 6.28, 0.24, 2);
          tops.push(null);
        } else {
          const h = column(x, z, 4.4, 0.24, roll > 0.75);
          tops.push(h ? [x, z, h] : null);
        }
      }
      for (let i = 0; i + 2 < 8; i += 2) {
        const a = tops[i];
        const b = tops[i + 2];
        if (a && b) beam(a[0], a[1], b[0], b[1], a[2] + 0.6, 0.24);
      }
    }

    // Lone columns scattered over the floor (kept off the avenues and the temples).
    for (let i = 0; i < 64; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = 7 + Math.pow(rnd(), 0.8) * 46;
      const x = cx + Math.cos(a) * (W / 2 + rr);
      const z = cz + Math.sin(a) * (H / 2 + rr * 0.9);
      if (x > -2.5 && x < W + 2.5 && z > -2.5 && z < H + 2.5) continue;
      if (Math.abs(x - cx) < 6 || Math.abs(z - cz) < 6) continue;
      if (Math.hypot(x + 16, z + 14) < 8 || Math.hypot(x - W - 17, z - H - 13) < 8) continue;
      const roll = rnd();
      const r = 0.17 + rnd() * 0.16;
      if (roll < 0.22) fallen(x, z, rnd() * 6.28, r, 2 + Math.floor(rnd() * 3));
      else column(x, z, 2.6 + rnd() * 5.4, r, roll > 0.66);
    }

    // Giants on the horizon (seen from the ground, through the haze).
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + rnd() * 0.25;
      const rr = 120 + rnd() * 70;
      column(cx + Math.cos(a) * rr, cz + Math.sin(a) * rr, 26 + rnd() * 26, 1.1 + rnd() * 0.7, rnd() < 0.3);
    }

    const geos = {
      base: columnBaseGeometry(),
      shaft: columnShaftGeometry(20),
      capital: columnCapitalGeometry(),
      broken: brokenGeometry(),
      drum: drumGeometry(),
      box: new BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
      sphere: new SphereGeometry(1, 48, 32),
    };
    for (const key of Object.keys(L) as (keyof typeof L)[]) {
      const list = L[key];
      if (!list.length) continue;
      const mesh = new InstancedMesh(geos[key], key === "sphere" ? this.chrome : this.marble, list.length);
      list.forEach((p, i) => mesh.setMatrixAt(i, p.m));
      mesh.castShadow = key !== "box";
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
    for (const key of Object.keys(geos) as (keyof typeof geos)[]) if (!L[key].length) geos[key].dispose();
  }

  /** At night the marble cools to lilac. */
  setNight(n: number): void {
    this.marble.color.set(0xf3edf6).lerp(NIGHT_MARBLE, n * 0.5);
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.geometry.dispose();
      m.dispose();
    }
    for (const mat of [this.marble, this.chrome] as Material[]) mat.dispose();
  }
}

const NIGHT_MARBLE = new Color(0xb8b0e8);
