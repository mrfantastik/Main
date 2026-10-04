import {
  BufferGeometry,
  CanvasTexture,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  GreaterDepth,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector2,
  Vector3,
  type Material,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Pose } from "../citizens";

// Glossy mannequins for the dreamscape, like the one in the reference
// picture: a sculpted torso (chest, shoulders, waist), a head with a jaw,
// brow and nose, and jointed arms and legs (upper arm and forearm with a
// hand, thigh and shin with a foot), so they walk with bending knees and
// talk with their hands. Each part is one instanced mesh for the whole town
// (eleven draw calls in all, plus a soft contact shadow under each figure).

export const MANNEQUIN_H = 0.88;
const HIP_Y = 0.41;
const SHOULDER_Y = 0.632;
const NECK_Y = 0.718;
const UPPER_ARM = 0.185;
const FOREARM = 0.165;
const THIGH = 0.2;
const SHIN = 0.19;

function merge(parts: BufferGeometry[]): BufferGeometry {
  const flat = parts.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    n.deleteAttribute("uv");
    return n;
  });
  const merged = mergeGeometries(flat, false)!;
  for (const p of [...parts, ...flat]) p.dispose();
  return merged;
}

/** Torso, hips and neck: a lathed body (narrow waist, broad chest) with pecs and shoulder caps. */
function bodyGeometry(): BufferGeometry {
  const profile = [
    [0.0, 0.385],
    [0.07, 0.39],
    [0.092, 0.42],
    [0.094, 0.455],
    [0.082, 0.5],
    [0.086, 0.545],
    [0.104, 0.59],
    [0.118, 0.628],
    [0.108, 0.658],
    [0.07, 0.684],
    [0.034, 0.696],
    [0.0, 0.7],
  ].map(([r, y]) => new Vector2(r, y));
  const torso = new LatheGeometry(profile, 20);
  torso.scale(1.22, 1, 0.74);
  const pecs = [-1, 1].map((side) => {
    const g = new SphereGeometry(0.05, 12, 8);
    g.scale(1.05, 0.72, 0.5);
    g.translate(side * 0.048, 0.602, 0.058);
    return g;
  });
  const shoulders = [-1, 1].map((side) => {
    const g = new SphereGeometry(0.046, 12, 8);
    g.scale(1, 0.9, 1);
    g.translate(side * 0.128, SHOULDER_Y + 0.004, 0);
    return g;
  });
  const glutes = new SphereGeometry(0.085, 14, 8);
  glutes.scale(1.25, 0.75, 0.9);
  glutes.translate(0, 0.425, -0.012);
  const neck = new CylinderGeometry(0.03, 0.036, 0.06, 12);
  neck.translate(0, NECK_Y - 0.02, 0);
  const g = merge([torso, ...pecs, ...shoulders, glutes, neck]);
  g.computeVertexNormals();
  return g;
}

/** The head, pivoting at the top of the neck: cranium, jaw, brow and nose (bald and smooth, as mannequins are). */
function headGeometry(): BufferGeometry {
  const cranium = new SphereGeometry(0.068, 20, 14);
  cranium.scale(0.86, 1.04, 0.98);
  cranium.translate(0, 0.082, -0.004);
  const jaw = new SphereGeometry(0.05, 14, 10);
  jaw.scale(0.88, 0.82, 0.92);
  jaw.translate(0, 0.04, 0.016);
  const chin = new SphereGeometry(0.02, 10, 6);
  chin.translate(0, 0.022, 0.052);
  const brow = new SphereGeometry(0.05, 14, 6);
  brow.scale(1.05, 0.34, 0.6);
  brow.translate(0, 0.098, 0.036);
  const nose = new ConeGeometry(0.011, 0.034, 6);
  nose.rotateX(-0.35);
  nose.translate(0, 0.074, 0.064);
  const g = merge([cranium, jaw, chin, brow, nose]);
  g.computeVertexNormals();
  return g;
}

/** A limb segment hanging from its joint at the origin, with an optional hand or foot at the end. */
function segment(r0: number, r1: number, len: number, end?: "hand" | "foot"): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const shaft = new CylinderGeometry(r1, r0, len, 12, 1);
  shaft.translate(0, -len / 2, 0);
  parts.push(shaft);
  const top = new SphereGeometry(r0, 12, 8);
  parts.push(top);
  const bottom = new SphereGeometry(r1, 12, 8);
  bottom.translate(0, -len, 0);
  parts.push(bottom);
  if (end === "hand") {
    const hand = new CapsuleGeometry(0.019, 0.03, 4, 8);
    hand.scale(0.75, 1, 1.2);
    hand.translate(0, -len - 0.036, 0.004);
    parts.push(hand);
  } else if (end === "foot") {
    const foot = new CapsuleGeometry(0.026, 0.06, 4, 8);
    foot.rotateX(Math.PI / 2);
    foot.scale(1, 0.72, 1);
    foot.translate(0, -len - 0.006, 0.03);
    parts.push(foot);
  }
  const g = merge(parts);
  g.computeVertexNormals();
  return g;
}

/** A soft round shadow texture (dark middle fading to nothing). */
function blobTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(0,0,0,1)");
  grad.addColorStop(0.45, "rgba(0,0,0,0.55)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

type Limb = { mesh: InstancedMesh; child: InstancedMesh; x: number; y: number; len: number };

export class MannequinMeshes {
  private readonly body: InstancedMesh;
  private readonly head: InstancedMesh;
  private readonly arms: Limb[];
  private readonly legs: Limb[];
  private readonly shadow: InstancedMesh;
  private readonly blob: CanvasTexture;
  private readonly painted: InstancedMesh[];
  private readonly ghosts: InstancedMesh[];
  private readonly ghostMaterial: MeshBasicMaterial;
  private readonly all: InstancedMesh[];
  private readonly base = new Matrix4();
  private readonly torso = new Matrix4();
  private readonly joint = new Matrix4();
  private readonly upper = new Matrix4();
  private readonly lower = new Matrix4();
  private readonly t = new Matrix4();
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
    // Glossy, like lacquered plastic: a clear coat over a smooth coloured base.
    const material = () => new MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.1 });
    const mk = (geo: BufferGeometry) => {
      const mesh = new InstancedMesh(geo, material(), max);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.setColorAt(0, this.c.set(0xffffff));
      return mesh;
    };
    this.body = mk(bodyGeometry());
    this.head = mk(headGeometry());
    const arm = (side: number): Limb => ({ mesh: mk(segment(0.031, 0.026, UPPER_ARM)), child: mk(segment(0.025, 0.02, FOREARM, "hand")), x: side * 0.148, y: SHOULDER_Y, len: UPPER_ARM });
    const leg = (side: number): Limb => ({ mesh: mk(segment(0.047, 0.036, THIGH)), child: mk(segment(0.034, 0.025, SHIN, "foot")), x: side * 0.058, y: HIP_Y, len: THIGH });
    this.arms = [arm(-1), arm(1)];
    this.legs = [leg(-1), leg(1)];
    this.blob = blobTexture();
    const sg = new PlaneGeometry(0.62, 0.62);
    sg.rotateX(-Math.PI / 2);
    this.shadow = new InstancedMesh(sg, new MeshBasicMaterial({ map: this.blob, color: 0x0a0614, transparent: true, opacity: 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }), max);
    this.shadow.instanceMatrix.setUsage(DynamicDrawUsage);
    this.shadow.frustumCulled = false;
    this.shadow.renderOrder = 4;
    this.shadow.count = 0;
    this.painted = [this.body, this.head, ...this.arms.flatMap((l) => [l.mesh, l.child]), ...this.legs.flatMap((l) => [l.mesh, l.child])];
    // Silhouettes: the same figures again, drawn faintly only where something
    // stands in front of them, so nobody is lost behind a building. They share
    // the figures' positions and colours, and live on layer 1, which the mirror
    // and the shadows don't see.
    this.ghostMaterial = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, depthFunc: GreaterDepth, depthWrite: false, fog: false });
    this.ghosts = this.painted.map((m) => {
      const g = new InstancedMesh(m.geometry, this.ghostMaterial, max);
      g.instanceMatrix = m.instanceMatrix;
      g.instanceColor = m.instanceColor;
      g.frustumCulled = false;
      g.renderOrder = 6;
      g.count = 0;
      g.layers.set(1);
      return g;
    });
    this.all = [...this.painted, this.shadow, ...this.ghosts];
  }

  get meshes(): InstancedMesh[] {
    return this.all;
  }

  /** One colour for the whole figure (they're mannequins: no skin, no hats). */
  paint(i: number, _seed: number, body: Color, _hat?: Color): void {
    for (const m of this.painted) m.setColorAt(i, body);
  }

  /** Place one figure, posed: walking, talking with their hands, listening, or just standing about. */
  place(i: number, x: number, y: number, z: number, yaw: number, scale: number, stride = 0, pose?: Pose): void {
    const walk = pose ? pose.walk : stride !== 0 ? 1 : 0;
    const phase = pose ? pose.phase : Math.asin(Math.max(-1, Math.min(1, stride)));
    const t = pose ? pose.t + pose.seed * 1.7 : 0;
    const talk = pose ? pose.talk * (1 - walk) : 0;
    const speaking = !!pose?.speaking;
    const idle = 1 - walk;

    this.q.setFromAxisAngle(this.up, yaw);
    this.base.compose(this.p.set(x, y, z), this.q, this.s.set(scale, scale, scale));
    // The body: a slight forward lean when walking, breathing and a gentle sway when standing.
    const breathe = Math.sin(t * 1.6) * 0.012 * idle;
    const lean = walk * 0.07 + talk * (speaking ? 0.04 : -0.02);
    this.q.setFromAxisAngle(this.xAxis, lean);
    this.q2.setFromAxisAngle(this.zAxis, Math.sin(t * 0.7) * 0.025 * idle);
    this.q.multiply(this.q2);
    this.t.compose(this.p.set(0, HIP_Y, 0), this.q, this.s.set(1, 1 + breathe, 1));
    this.torso.multiplyMatrices(this.base, this.t);
    this.t.makeTranslation(0, -HIP_Y, 0);
    this.torso.multiply(this.t);
    this.body.setMatrixAt(i, this.torso);

    // Head: turns towards whoever they're talking to; nods while listening, bobs while speaking.
    const nod = talk * (speaking ? Math.sin(t * 5.2) * 0.06 : Math.max(0, Math.sin(t * 1.9)) * 0.13) + idle * (1 - talk) * Math.sin(t * 0.5) * 0.04;
    const turn = (pose?.head ?? 0) + idle * (1 - talk) * Math.sin(t * 0.31) * 0.35;
    this.q.setFromAxisAngle(this.up, turn);
    this.q2.setFromAxisAngle(this.xAxis, nod + walk * -0.05);
    this.q.multiply(this.q2);
    this.joint.compose(this.p.set(0, NECK_Y, 0), this.q, this.one);
    this.t.multiplyMatrices(this.torso, this.joint);
    this.head.setMatrixAt(i, this.t);

    // Legs: thighs swing, knees bend on the way through, straight on the ground.
    for (let k = 0; k < 2; k++) {
      const ph = phase + k * Math.PI;
      const swing = walk * Math.sin(ph) * 0.5;
      const knee = walk * (0.06 + 0.95 * Math.pow(Math.max(0, Math.cos(ph)), 1.6)) + idle * 0.03;
      const side = k === 0 ? -1 : 1;
      // Standing, weight shifts from one leg to the other now and then.
      const shift = idle * Math.sin(t * 0.45) * 0.03 * side;
      this.limb(this.legs[k], i, this.base, -swing, side * 0.03 + shift, knee);
    }

    // Arms: swing against the legs when walking; when talking, the speaker gestures
    // with one hand raised (the other loose), the listener keeps their hands low.
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? -1 : 1;
      const ph = phase + Math.PI + k * Math.PI; // against the leg on the same side
      let fwd = walk * Math.sin(ph) * 0.42;
      let out = side * (0.09 + idle * 0.03);
      let bend = 0.22 + walk * (0.22 + Math.max(0, Math.sin(ph)) * 0.35) + idle * Math.sin(t * 1.1 + k) * 0.03;
      if (talk > 0) {
        const lead = (pose!.seed & 1) === 0 ? 1 : -1; // which hand they talk with
        if (speaking && side === lead) {
          fwd += talk * (0.55 + Math.sin(t * 2.4) * 0.22);
          out += side * talk * (0.25 + Math.sin(t * 1.7) * 0.1);
          bend += talk * (1.25 + Math.sin(t * 3.3) * 0.3);
        } else if (speaking) {
          fwd += talk * (0.2 + Math.sin(t * 2.1 + 1) * 0.08);
          bend += talk * 0.55;
        } else {
          // Listening: hands clasped in front.
          fwd += talk * 0.32;
          out -= side * talk * 0.05;
          bend += talk * 1.05;
        }
      }
      this.limb(this.arms[k], i, this.torso, -fwd, out, bend, true);
    }

    // Soft contact shadow on the ground under them.
    this.t.compose(this.p.set(x, y + 0.012, z), this.q.identity(), this.s.set(scale, 1, scale));
    this.shadow.setMatrixAt(i, this.t);
  }

  /**
   * A two-part limb from its joint on `parent`: `swing` about x (negative is
   * forwards), `splay` about z, then the elbow or knee bent by `bend`
   * (elbows bend forwards, knees backwards).
   */
  private limb(l: Limb, i: number, parent: Matrix4, swing: number, splay: number, bend: number, arm = false): void {
    this.q.setFromAxisAngle(this.zAxis, splay);
    this.q2.setFromAxisAngle(this.xAxis, swing);
    this.q.multiply(this.q2);
    this.joint.compose(this.p.set(l.x, l.y, 0), this.q, this.one);
    this.upper.multiplyMatrices(parent, this.joint);
    l.mesh.setMatrixAt(i, this.upper);
    this.q.setFromAxisAngle(this.xAxis, arm ? -bend : bend);
    this.joint.compose(this.p.set(0, -l.len, 0), this.q, this.one);
    this.lower.multiplyMatrices(this.upper, this.joint);
    l.child.setMatrixAt(i, this.lower);
  }

  finish(count: number, colorsChanged: boolean): void {
    for (const m of this.all) {
      m.count = count;
      m.instanceMatrix.needsUpdate = true;
      if (colorsChanged && m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const m of [...this.painted, this.shadow]) {
      m.geometry.dispose();
      (m.material as Material).dispose();
      m.dispose();
    }
    this.ghostMaterial.dispose();
    this.blob.dispose();
  }
}
