import { BoxGeometry, BufferAttribute, BufferGeometry, CircleGeometry, Color, ConeGeometry, CylinderGeometry, IcosahedronGeometry, Matrix4, PlaneGeometry, Quaternion, SphereGeometry, Vector3 } from "three";
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
const fwdZ = new Vector3(0, 0, 1);
const col = new Color();

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
   * A classical Ionic column on y: square plinth, round base, a slightly
   * tapered fluted-looking shaft and a capital with scroll ends. `broken`
   * columns stop part-way with no capital (ruins).
   */
  column(x: number, y: number, z: number, h: number, r: number, color: number, broken = false): this {
    const base = r * 0.55;
    this.box(x, y, z, r * 3, base * 0.6, r * 3, color);
    this.shaft(x, y + base * 0.6, z, r * 1.32, r * 1.22, base * 0.45, color, 20);
    const shaftH = broken ? h * 0.55 : h - base * 1.05 - r * 1.1;
    this.shaft(x, y + base * 1.05, z, r, r * 0.88, shaftH, color, 20);
    if (broken) return this;
    const top = y + base * 1.05 + shaftH;
    this.shaft(x, top, z, r * 0.95, r * 1.15, r * 0.3, color, 20);
    this.box(x, top + r * 0.3, z, r * 2.7, r * 0.32, r * 2.1, color);
    // Scrolls: short horizontal cylinders at each end of the capital.
    for (const side of [-1, 1]) {
      q.setFromAxisAngle(fwdZ, Math.PI / 2);
      m.compose(pos.set(x + side * r * 1.2, top + r * 0.18, z), q, scl.set(r * 0.42, r * 2.0, r * 0.42));
      this.push(new CylinderGeometry(1, 1, 1, 14, 1), color, m);
    }
    this.box(x, top + r * 0.62, z, r * 2.9, r * 0.2, r * 2.9, color);
    return this;
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
