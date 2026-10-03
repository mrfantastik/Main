import { BoxGeometry, Color, DynamicDrawUsage, InstancedMesh, Matrix4, MeshLambertMaterial, Quaternion, Vector3, type Material } from "three";
import { SKIN } from "./palette";

// Chunky blocky people: legs, body (occupation colour), head and a hat in
// the citizen's own colour. Four instanced meshes = four draw calls for the
// whole population.

export const MAX_CITIZENS = 128;
/** Total figure height in tiles. */
export const FIGURE_H = 0.82;

const LEGS_H = 0.24;
const BODY_H = 0.3;
const HEAD = 0.22;

function part(w: number, h: number, d: number, y0: number): BoxGeometry {
  const g = new BoxGeometry(w, h, d);
  g.translate(0, y0 + h / 2, 0);
  return g;
}

export class CitizenMeshes {
  readonly legs: InstancedMesh;
  readonly body: InstancedMesh;
  readonly head: InstancedMesh;
  readonly hat: InstancedMesh;
  private readonly all: InstancedMesh[];
  private readonly mat = new Matrix4();
  private readonly q = new Quaternion();
  private readonly p = new Vector3();
  private readonly s = new Vector3();
  private readonly up = new Vector3(0, 1, 0);
  private readonly c = new Color();

  constructor() {
    const mk = (w: number, h: number, d: number, y0: number, color?: number) => {
      const material = new MeshLambertMaterial({ flatShading: true, color: color ?? 0xffffff });
      const mesh = new InstancedMesh(part(w, h, d, y0), material, MAX_CITIZENS);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      return mesh;
    };
    this.legs = mk(0.26, LEGS_H, 0.16, 0, 0x3b3442);
    this.body = mk(0.34, BODY_H, 0.22, LEGS_H);
    this.head = mk(HEAD, HEAD, HEAD, LEGS_H + BODY_H);
    this.hat = mk(0.25, 0.07, 0.25, LEGS_H + BODY_H + HEAD);
    // Make sure the colour buffers exist from the start.
    for (const m of [this.body, this.head, this.hat]) m.setColorAt(0, this.c.set(0xffffff));
    this.all = [this.legs, this.body, this.head, this.hat];
  }

  get meshes(): InstancedMesh[] {
    return this.all;
  }

  /** Set the colours for one instance slot (skin tone picked from a stable per-person number). */
  paint(i: number, seed: number, body: Color, hat: Color): void {
    this.body.setColorAt(i, body);
    this.head.setColorAt(i, this.c.setHex(SKIN[seed % SKIN.length]));
    this.hat.setColorAt(i, hat);
  }

  /** Place one figure. */
  place(i: number, x: number, y: number, z: number, yaw: number, scale: number): void {
    this.q.setFromAxisAngle(this.up, yaw);
    this.mat.compose(this.p.set(x, y, z), this.q, this.s.set(scale, scale, scale));
    for (const m of this.all) m.setMatrixAt(i, this.mat);
  }

  finish(count: number, colorsChanged: boolean): void {
    for (const m of this.all) {
      m.count = count;
      m.instanceMatrix.needsUpdate = true;
      if (colorsChanged && m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const m of this.all) {
      m.geometry.dispose();
      (m.material as Material).dispose();
      m.dispose();
    }
  }
}
