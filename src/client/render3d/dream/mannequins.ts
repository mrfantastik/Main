import { BufferGeometry, CapsuleGeometry, Color, CylinderGeometry, DynamicDrawUsage, InstancedMesh, Matrix4, MeshPhongMaterial, Quaternion, SphereGeometry, Vector3, type Material } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// Smooth, glossy mannequins for the dreamscape: a body (torso, hips, neck,
// head) and four limbs that swing as they walk. Five instanced meshes for
// the whole town. Same interface as the retro block people.

export const MANNEQUIN_H = 0.84;
const HIP_Y = 0.34;
const SHOULDER_Y = 0.6;

function bodyGeometry(): BufferGeometry {
  const torso = new CapsuleGeometry(0.1, 0.14, 6, 14);
  torso.scale(1.3, 1, 0.78);
  torso.translate(0, 0.5, 0);
  const hips = new SphereGeometry(0.1, 14, 10);
  hips.scale(1.15, 0.7, 0.85);
  hips.translate(0, HIP_Y + 0.03, 0);
  const neck = new CylinderGeometry(0.03, 0.035, 0.07, 10);
  neck.translate(0, 0.665, 0);
  const head = new SphereGeometry(0.075, 18, 14);
  head.scale(0.88, 1.08, 0.95);
  head.translate(0, 0.74, 0.005);
  const parts = [torso, hips, neck, head].map((g) => (g.index ? g.toNonIndexed() : g));
  for (const p of parts) p.deleteAttribute("uv");
  const merged = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  merged.computeVertexNormals();
  return merged;
}

/** A limb hanging down from its pivot (hip or shoulder) at the origin. */
function limbGeometry(r: number, len: number): BufferGeometry {
  const g = new CapsuleGeometry(r, len, 5, 10);
  g.translate(0, -(len / 2 + r * 0.6), 0);
  return g;
}

export class MannequinMeshes {
  private readonly body: InstancedMesh;
  private readonly legL: InstancedMesh;
  private readonly legR: InstancedMesh;
  private readonly armL: InstancedMesh;
  private readonly armR: InstancedMesh;
  private readonly all: InstancedMesh[];
  private readonly base = new Matrix4();
  private readonly local = new Matrix4();
  private readonly out = new Matrix4();
  private readonly q = new Quaternion();
  private readonly q2 = new Quaternion();
  private readonly p = new Vector3();
  private readonly s = new Vector3();
  private readonly up = new Vector3(0, 1, 0);
  private readonly xAxis = new Vector3(1, 0, 0);
  private readonly zAxis = new Vector3(0, 0, 1);
  private readonly one = new Vector3(1, 1, 1);
  private readonly c = new Color();

  constructor(max: number) {
    const material = () => new MeshPhongMaterial({ color: 0xffffff, shininess: 95, specular: new Color(0x9aa4c4) });
    const mk = (geo: BufferGeometry) => {
      const mesh = new InstancedMesh(geo, material(), max);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.setColorAt(0, this.c.set(0xffffff));
      return mesh;
    };
    this.body = mk(bodyGeometry());
    this.legL = mk(limbGeometry(0.045, 0.24));
    this.legR = mk(limbGeometry(0.045, 0.24));
    this.armL = mk(limbGeometry(0.033, 0.21));
    this.armR = mk(limbGeometry(0.033, 0.21));
    this.all = [this.body, this.legL, this.legR, this.armL, this.armR];
  }

  get meshes(): InstancedMesh[] {
    return this.all;
  }

  /** One colour for the whole figure (they're mannequins: no skin, no hats). */
  paint(i: number, _seed: number, body: Color, _hat?: Color): void {
    for (const m of this.all) m.setColorAt(i, body);
  }

  /** Place one figure; `stride` (-1..1) swings the arms and legs. */
  place(i: number, x: number, y: number, z: number, yaw: number, scale: number, stride = 0): void {
    this.q.setFromAxisAngle(this.up, yaw);
    this.base.compose(this.p.set(x, y, z), this.q, this.s.set(scale, scale, scale));
    this.body.setMatrixAt(i, this.base);
    const leg = stride * 0.55;
    const arm = stride * 0.45;
    this.limb(this.legL, i, -0.055, HIP_Y, leg, 0);
    this.limb(this.legR, i, 0.055, HIP_Y, -leg, 0);
    this.limb(this.armL, i, -0.145, SHOULDER_Y, -arm, -0.1);
    this.limb(this.armR, i, 0.145, SHOULDER_Y, arm, 0.1);
  }

  private limb(mesh: InstancedMesh, i: number, px: number, py: number, swing: number, splay: number): void {
    this.q.setFromAxisAngle(this.xAxis, swing);
    this.q2.setFromAxisAngle(this.zAxis, splay);
    this.q.premultiply(this.q2);
    this.local.compose(this.p.set(px, py, 0), this.q, this.one);
    this.out.multiplyMatrices(this.base, this.local);
    mesh.setMatrixAt(i, this.out);
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
