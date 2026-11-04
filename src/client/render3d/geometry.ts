import { BoxGeometry, BufferAttribute, BufferGeometry, CircleGeometry, Color, ConeGeometry, CylinderGeometry, IcosahedronGeometry, Matrix4, PlaneGeometry, Quaternion, SphereGeometry, TorusGeometry, Vector3 } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** Deterministic 0..1 noise from integers (same as the 2D city layer). */
export function hash(x: number, y: number, s = 0): number {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const m = new Matrix4();
const q = new Quaternion();
const pos = new Vector3();
const scl = new Vector3();
const up = new Vector3(0, 1, 0);
const col = new Color();

function mergeParts(parts: BufferGeometry[]): BufferGeometry {
  const flat = parts.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    n.deleteAttribute("uv");
    return n;
  });
  const merged = mergeGeometries(flat, false)!;
  for (const g of new Set([...parts, ...flat])) g.dispose();
  return merged;
}

function ring(radius: number, tube: number, y: number, radial = 6, tubular = 20): BufferGeometry {
  const g = new TorusGeometry(radius, tube, radial, tubular);
  g.rotateX(Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

/**
 * Classical column parts, for a column of radius 1 (scale them by the
 * radius; the shaft also by its height). The Attic base: square plinth, two
 * rounded mouldings with a hollow between, from y = 0 to COLUMN_BASE_H.
 */
export const COLUMN_BASE_H = 0.78;
export function columnBaseGeometry(): BufferGeometry {
  const plinth = new BoxGeometry(2.9, 0.34, 2.9);
  plinth.translate(0, 0.17, 0);
  const lower = ring(1.18, 0.17, 0.5);
  const scotia = new CylinderGeometry(1.04, 1.12, 0.16, 20, 1);
  scotia.translate(0, 0.62, 0);
  const upper = ring(1.06, 0.12, 0.7);
  const g = mergeParts([plinth, lower, scotia, upper]);
  g.computeVertexNormals();
  return g;
}

/**
 * The shaft, from y = 0 to 1 (scale it by the height): fluted (concave
 * channels separated by narrow fillets), tapering towards the top with a
 * slight swell a third of the way up, as the Greeks built them.
 */
export function columnShaftGeometry(flutes = 20): BufferGeometry {
  const per = 3;
  const g = new CylinderGeometry(0.86, 1, 1, flutes * per, 6, true);
  g.translate(0, 0.5, 0);
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const a = Math.atan2(z, x);
    // Which vertex of the flute this is (0 = fillet, 1 and 2 = the channel).
    const k = Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / ((Math.PI * 2) / (flutes * per))) % per;
    const swell = 1 + 0.035 * Math.sin(Math.min(1, y * 1.4) * Math.PI);
    const r = (k === 0 ? 1 : 0.92) * swell;
    p.setXYZ(i, x * r, y, z * r);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * The Ionic capital, from the top of the shaft (y = 0) up to
 * COLUMN_CAPITAL_H: a beaded ring, the swelling echinus, the cushion with a
 * scroll (volute) at each end, and a thin square abacus on top.
 */
export const COLUMN_CAPITAL_H = 0.86;
export function columnCapitalGeometry(): BufferGeometry {
  const bead = ring(0.88, 0.08, 0.04, 6, 20);
  const echinus = new CylinderGeometry(1.12, 0.9, 0.26, 20, 1);
  echinus.translate(0, 0.2, 0);
  const cushion = new BoxGeometry(2.5, 0.3, 1.5);
  cushion.translate(0, 0.46, 0);
  const parts: BufferGeometry[] = [bead, echinus, cushion];
  for (const side of [-1, 1]) {
    // Each volute: a scroll seen end-on from the front and back, a smaller "eye" standing out of it.
    const scroll = new CylinderGeometry(0.46, 0.46, 1.62, 16, 1);
    scroll.rotateX(Math.PI / 2);
    scroll.translate(side * 1.32, 0.36, 0);
    const eye = new CylinderGeometry(0.17, 0.17, 1.8, 10, 1);
    eye.rotateX(Math.PI / 2);
    eye.translate(side * 1.32, 0.36, 0);
    parts.push(scroll, eye);
  }
  const abacus = new BoxGeometry(2.8, 0.2, 2.8);
  abacus.translate(0, 0.72, 0);
  const top = new BoxGeometry(2.6, 0.06, 2.6);
  top.translate(0, 0.83, 0);
  parts.push(abacus, top);
  const g = mergeParts(parts);
  g.computeVertexNormals();
  return g;
}

let columnParts: { base: BufferGeometry; shaft: BufferGeometry; capital: BufferGeometry } | null = null;

/**
 * Collects low-poly shapes (each with one flat vertex colour) and merges
 * them into a single geometry, so a whole layer of the city is one draw call.
 * Coordinates: x/z are tile coordinates on the ground, y is height.
 */
export class GeoBuilder {
  private parts: BufferGeometry[] = [];

  get vertexCount(): number {
    let n = 0;
    for (const g of this.parts) n += g.getAttribute("position").count;
    return n;
  }

  private push(g: BufferGeometry, color: number, matrix: Matrix4): this {
    const geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    geo.deleteAttribute("uv");
    geo.applyMatrix4(matrix);
    col.setHex(color);
    const n = geo.getAttribute("position").count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      c[i * 3] = col.r;
      c[i * 3 + 1] = col.g;
      c[i * 3 + 2] = col.b;
    }
    geo.setAttribute("color", new BufferAttribute(c, 3));
    this.parts.push(geo);
    return this;
  }

  /** Axis-aligned box: centre x/z, bottom at y. */
  box(x: number, y: number, z: number, w: number, h: number, d: number, color: number, rotY = 0): this {
    q.setFromAxisAngle(up, rotY);
    m.compose(pos.set(x, y + h / 2, z), q, scl.set(w, h, d));
    return this.push(new BoxGeometry(1, 1, 1), color, m);
  }

  /** Gable roof (triangular prism). Ridge runs along x when alongX, else along z. */
  gable(x: number, y: number, z: number, w: number, d: number, h: number, color: number, alongX: boolean): this {
    // A 3-sided cylinder is a triangular prism; rotate it onto its side.
    const g = new CylinderGeometry(0.5, 0.5, 1, 3, 1);
    g.rotateX(-Math.PI / 2); // one edge points up, axis along z
    g.rotateY(Math.PI / 2); // axis along x
    // Stretch the triangle to fill a unit box sitting on y = 0.
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    g.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
    g.scale(1 / (bb.max.x - bb.min.x), 1 / (bb.max.y - bb.min.y), 1 / (bb.max.z - bb.min.z));
    q.setFromAxisAngle(up, alongX ? 0 : Math.PI / 2);
    m.compose(pos.set(x, y, z), q, alongX ? scl.set(w, h, d) : scl.set(d, h, w));
    return this.push(g, color, m);
  }

  /** Four-sided pyramid roof. */
  pyramid(x: number, y: number, z: number, w: number, d: number, h: number, color: number): this {
    const g = new ConeGeometry(Math.SQRT1_2, 1, 4, 1);
    g.rotateY(Math.PI / 4);
    m.compose(pos.set(x, y + h / 2, z), q.identity(), scl.set(w, h, d));
    return this.push(g, color, m);
  }

  cone(x: number, y: number, z: number, r: number, h: number, color: number, segments = 6): this {
    m.compose(pos.set(x, y + h / 2, z), q.identity(), scl.set(r, h, r));
    return this.push(new ConeGeometry(1, 1, segments, 1), color, m);
  }

  cylinder(x: number, y: number, z: number, r: number, h: number, color: number, segments = 8): this {
    m.compose(pos.set(x, y + h / 2, z), q.identity(), scl.set(r, h, r));
    return this.push(new CylinderGeometry(1, 1, 1, segments, 1), color, m);
  }

  /** A smooth sphere (lamp globes, topiary). */
  sphere(x: number, y: number, z: number, r: number, color: number, segments = 12): this {
    m.compose(pos.set(x, y, z), q.identity(), scl.set(r, r, r));
    return this.push(new SphereGeometry(1, segments, Math.max(6, segments >> 1)), color, m);
  }

  /** Tapered round shaft (columns, cypress trunks). */
  shaft(x: number, y: number, z: number, rBottom: number, rTop: number, h: number, color: number, segments = 18): this {
    m.compose(pos.set(x, y + h / 2, z), q.identity(), scl.set(1, h, 1));
    return this.push(new CylinderGeometry(rTop, rBottom, 1, segments, 1), color, m);
  }

  /**
   * A classical Ionic column on y: Attic base, fluted shaft and a capital
   * with scrolls. `broken` columns stop part-way with no capital (ruins).
   */
  column(x: number, y: number, z: number, h: number, r: number, color: number, broken = false): this {
    columnParts ??= { base: columnBaseGeometry(), shaft: columnShaftGeometry(16), capital: columnCapitalGeometry() };
    const shaftH = broken ? h * 0.55 : h - (COLUMN_BASE_H + COLUMN_CAPITAL_H) * r;
    m.compose(pos.set(x, y, z), q.identity(), scl.set(r, r, r));
    this.push(columnParts.base.clone(), color, m);
    m.compose(pos.set(x, y + COLUMN_BASE_H * r, z), q.identity(), scl.set(r, shaftH, r));
    this.push(columnParts.shaft.clone(), color, m);
    if (broken) return this;
    m.compose(pos.set(x, y + COLUMN_BASE_H * r + shaftH, z), q.identity(), scl.set(r, r, r));
    return this.push(columnParts.capital.clone(), color, m);
  }

  /** A slim cypress tree: short trunk, tall tapering crown. */
  cypress(x: number, y: number, z: number, h: number, color: number, trunk: number): this {
    this.shaft(x, y, z, 0.06, 0.05, h * 0.15, trunk, 8);
    m.compose(pos.set(x, y + h * 0.15 + (h * 0.85) / 2, z), q.identity(), scl.set(h * 0.13, h * 0.85, h * 0.13));
    return this.push(new SphereGeometry(1, 12, 10).scale(1, 0.5, 1), color, m);
  }

  /** Low-poly blob (tree crowns, bushes). */
  ico(x: number, y: number, z: number, r: number, color: number, squash = 1): this {
    m.compose(pos.set(x, y, z), q.identity(), scl.set(r, r * squash, r));
    return this.push(new IcosahedronGeometry(1, 0), color, m);
  }

  /** Half sphere sitting on y. */
  dome(x: number, y: number, z: number, r: number, color: number): this {
    m.compose(pos.set(x, y, z), q.identity(), scl.set(r, r, r));
    return this.push(new SphereGeometry(1, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2), color, m);
  }

  /** Flat horizontal rectangle (paths, markings, pads). */
  flat(x: number, y: number, z: number, w: number, d: number, color: number): this {
    const g = new PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    m.compose(pos.set(x, y, z), q.identity(), scl.set(w, 1, d));
    return this.push(g, color, m);
  }

  /** Flat disc on the ground. */
  disc(x: number, y: number, z: number, r: number, color: number, segments = 10): this {
    const g = new CylinderGeometry(1, 1, 0.001, segments, 1);
    m.compose(pos.set(x, y, z), q.identity(), scl.set(r, 1, r));
    return this.push(g, color, m);
  }

  /** A flat disc that fades from `color` in the middle to black at the rim (for additive glows). */
  glow(x: number, y: number, z: number, r: number, color: number, segments = 14): this {
    const g = new CircleGeometry(1, segments).toNonIndexed();
    g.rotateX(-Math.PI / 2);
    g.deleteAttribute("uv");
    const p = g.getAttribute("position");
    const c = new Float32Array(p.count * 3);
    col.setHex(color);
    for (let i = 0; i < p.count; i++) {
      const k = Math.pow(1 - Math.min(1, Math.hypot(p.getX(i), p.getZ(i))), 1.6);
      c[i * 3] = col.r * k;
      c[i * 3 + 1] = col.g * k;
      c[i * 3 + 2] = col.b * k;
    }
    g.setAttribute("color", new BufferAttribute(c, 3));
    m.compose(pos.set(x, y, z), q.identity(), scl.set(r, 1, r));
    g.applyMatrix4(m);
    this.parts.push(g);
    return this;
  }

  /**
   * A rectangle stuck on a wall (windows, doors). `face` is the outward
   * direction: 0 = +z (south), 1 = +x (east), 2 = -z (north), 3 = -x (west).
   */
  panel(x: number, y: number, z: number, w: number, h: number, face: number, color: number): this {
    const g = new PlaneGeometry(1, 1);
    q.setFromAxisAngle(up, (face * Math.PI) / 2);
    m.compose(pos.set(x, y + h / 2, z), q, scl.set(w, h, 1));
    return this.push(g, color, m);
  }

  build(): BufferGeometry {
    const merged = this.parts.length ? mergeGeometries(this.parts, false) : new BufferGeometry();
    for (const g of this.parts) g.dispose();
    this.parts = [];
    if (!merged) throw new Error("could not merge city geometry");
    return merged;
  }
}
