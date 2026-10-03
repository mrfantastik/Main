import {
  AdditiveBlending,
  BasicShadowMap,
  Box3,
  BoxGeometry,
  BufferAttribute,
  Color,
  DirectionalLight,
  EdgesGeometry,
  Fog,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  OrthographicCamera,
  Plane,
  Raycaster,
  RingGeometry,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
} from "three";
import type { BusinessSummary, CitizenSummary } from "../../shared/protocol";
import type { CityMap } from "../../sim/types";
import { TILE_ROAD } from "../../sim/types";
import { store } from "../net/store";
import { FrameInterpolator } from "../render/interpolation";
import { ACTIVITY_ICON, darkness, drawBubble, drawLabel, drawMoneyPopup, moneyText } from "../render/overlay";
import type { CityRenderer, Pos } from "../render/types";
import { OCC_COLORS } from "../ui/format";
import { buildDecor, decorKey, type BusinessDecor } from "./businesses";
import { buildCity, SLAB, type BuildingInfo } from "./city";
import { CitizenMeshes, FIGURE_H, MAX_CITIZENS } from "./citizens";
import { P } from "./palette";

// A retro low-poly 3D view of the same city. The scene is rendered into a
// small drawing buffer (about 400 px tall) and the browser scales it up with
// nearest-neighbour filtering, giving chunky pixels. Text (names, icons,
// money, speech) is drawn crisply on a 2D overlay canvas on top.

const ELEVATION = 0.64; // radians above the ground (~37°)
const DISTANCE = 160;
const TARGET_PIXELS_TALL = 400;
const MAJOR = new Set(["office", "market", "park", "bank", "townhall", "pub", "diner", "cowork", "lab", "depot", "apartments"]);

interface Vis {
  x: number;
  z: number;
  yaw: number;
  phase: number;
  /** Last drawn head position (for picking and labels). */
  hx: number;
  hy: number;
  hz: number;
  /** Height of their feet. */
  fy: number;
  visible: boolean;
  inside: boolean;
  body: Color;
  hat: Color;
  colorKey: string;
  seed: number;
}

interface Popup {
  x: number;
  y: number;
  text: string;
  born: number;
}

/** Smallest signed angle from a to b. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function strHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const COL = {
  skyDay: new Color(0xa9cde8),
  skyDusk: new Color(0xeea882),
  skyNight: new Color(0x1a2547),
  hemiDay: new Color(0xd6e6ff),
  hemiNight: new Color(0x4a5a9a),
  groundDay: new Color(0x8c7b55),
  groundNight: new Color(0x141826),
  sunLow: new Color(0xff9a5c),
  sunHigh: new Color(0xfff0d6),
  lampOff: new Color(P.lampOff),
  lampOn: new Color(P.lampOn),
  windowLit: new Color(P.windowLit),
};

export class Renderer3D implements CityRenderer {
  private gl: WebGLRenderer;
  private scene = new Scene();
  private camera = new OrthographicCamera(-10, 10, 10, -10, 0.1, 600);
  private interp = new FrameInterpolator();
  private overlay: HTMLCanvasElement;
  private octx: CanvasRenderingContext2D;
  private map: CityMap | null = null;
  private info = new Map<string, BuildingInfo>();
  private cityMesh: Mesh | null = null;
  private windowMesh: Mesh | null = null;
  private windowRanges = new Map<string, { start: number; count: number }>();
  private windowLit = new Map<string, boolean>();
  private lampHeads: Mesh | null = null;
  private lampPools: Mesh | null = null;
  private decor: BusinessDecor | null = null;
  private decorMesh: Mesh | null = null;
  private decorKey = "";
  private people = new CitizenMeshes();
  private vis = new Map<string, Vis>();
  private selRing: Mesh;
  private hoverRing: Mesh;
  private bizOutline: LineSegments;
  private sun = new DirectionalLight(0xffffff, 2);
  private moon = new DirectionalLight(0x8fa4ff, 0);
  private hemi = new HemisphereLight(0xffffff, 0x887755, 1);
  private sunTarget = new Object3D();
  private fog = new Fog(0xa9cde8, 150, 260);
  private sky = new Color();

  // camera rig
  private target = new Vector3(26, 0, 21);
  private az = Math.PI / 4;
  private azGoal = Math.PI / 4;
  private halfH = 22;
  private maxHalfH = 40;
  private cssW = 1;
  private cssH = 1;
  private fitted = false;

  // input
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: { anchor: Vector3; moved: boolean; sx: number; sy: number } | null = null;
  private pinch: { dist: number; halfH: number } | null = null;
  private hover: string | null = null;
  private raycaster = new Raycaster();
  private ndc = new Vector2();
  private ground = new Plane(new Vector3(0, 1, 0), 0);
  private hit = new Vector3();
  private v = new Vector3();
  private v2 = new Vector3();
  private right = new Vector3();
  private fwd = new Vector3();
  private sp = { x: 0, y: 0 };

  // Lookups refreshed when a new state message arrives (twice a second), so
  // the per-frame code doesn't search arrays or allocate.
  private stateSeen: unknown = null;
  private citizenMeta = new Map<string, CitizenSummary>();
  private shopIn = new Map<string, BusinessSummary>();
  private bizById = new Map<string, BusinessSummary>();

  private raf = 0;
  private lastNow = performance.now();
  private lastSlow = 0;
  private popups: Popup[] = [];
  private lastFx: unknown = null;
  private resizeObs: ResizeObserver;
  private needsResize = true;

  // director camera
  private directorOn = false;
  private shot: { citizen: string | null; x: number; z: number; until: number } | null = null;
  private directorEventId = 0;
  private directorFxSeen: unknown = null;
  private driftUntil = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.gl = new WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    this.gl.setPixelRatio(1);
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = BasicShadowMap;
    canvas.style.imageRendering = "pixelated";

    this.overlay = document.createElement("canvas");
    this.overlay.className = "overlay-3d";
    Object.assign(this.overlay.style, { position: "absolute", left: "0", top: "0", width: "100%", height: "100%", pointerEvents: "none" });
    (canvas.parentElement ?? document.body).appendChild(this.overlay);
    this.octx = this.overlay.getContext("2d")!;

    this.scene.fog = this.fog;
    this.scene.background = this.sky;
    this.scene.add(this.hemi, this.sun, this.moon, this.sunTarget);
    this.sun.target = this.sunTarget;
    this.moon.target = this.sunTarget;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.bias = -0.0015;
    this.sun.shadow.normalBias = 0.02;
    for (const m of this.people.meshes) this.scene.add(m);

    const ringGeo = new RingGeometry(0.34, 0.46, 12);
    ringGeo.rotateX(-Math.PI / 2);
    // Rings sit on the ground at the citizen's feet (hidden behind buildings like everything else).
    this.selRing = new Mesh(ringGeo, new MeshBasicMaterial({ color: 0xffffff, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    this.hoverRing = new Mesh(ringGeo, new MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    this.selRing.renderOrder = this.hoverRing.renderOrder = 5;
    this.bizOutline = new LineSegments(new EdgesGeometry(new BoxGeometry(1, 1, 1)), new LineBasicMaterial({ color: 0xffffff }));
    this.selRing.visible = this.hoverRing.visible = this.bizOutline.visible = false;
    this.scene.add(this.selRing, this.hoverRing, this.bizOutline);

    this.resizeObs = new ResizeObserver(() => (this.needsResize = true));
    this.resizeObs.observe(canvas);
    this.attachInput();
  }

  // ------------------------------------------------------------ public

  setMap(map: CityMap): void {
    this.map = map;
    this.disposeCity();
    const geo = buildCity(map);
    this.info = geo.info;
    const flat = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.cityMesh = new Mesh(geo.city, flat);
    this.cityMesh.castShadow = true;
    this.cityMesh.receiveShadow = true;
    this.cityMesh.matrixAutoUpdate = false;
    this.windowMesh = new Mesh(geo.windows, new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false }));
    this.windowRanges = geo.windowRanges;
    this.windowLit.clear();
    const winColors = geo.windows.getAttribute("color") as BufferAttribute;
    (winColors.array as Float32Array).fill(0);
    this.lampHeads = new Mesh(geo.lampHeads, new MeshBasicMaterial({ color: P.lampOff }));
    this.lampPools = new Mesh(geo.lampPools, new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false }));
    this.scene.add(this.cityMesh, this.windowMesh, this.lampHeads, this.lampPools);
    this.decorKey = "";
    const cx = map.width / 2;
    const cz = map.height / 2;
    this.sunTarget.position.set(cx, 0, cz);
    const sc = this.sun.shadow.camera;
    const r = Math.max(map.width, map.height) * 0.75;
    sc.left = -r;
    sc.right = r;
    sc.top = r;
    sc.bottom = -r;
    sc.near = 1;
    sc.far = 200;
    sc.updateProjectionMatrix();
    this.fitted = false;
  }

  start(): void {
    const loop = (now: number) => {
      this.frame(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    window.removeEventListener("keydown", this.onKey);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("pointercancel", this.onUp);
    this.canvas.removeEventListener("pointerleave", this.onLeave);
    this.disposeCity();
    this.people.dispose();
    for (const m of [this.selRing, this.hoverRing]) (m.material as Material).dispose();
    this.selRing.geometry.dispose();
    this.bizOutline.geometry.dispose();
    (this.bizOutline.material as Material).dispose();
    this.sun.shadow.dispose();
    this.gl.dispose();
    this.gl.forceContextLoss();
    this.overlay.remove();
  }

  get gameTime(): number {
    return this.interp.gameTime;
  }

  positionOf(id: string): Pos | undefined {
    return this.interp.positions.get(id);
  }

  focusOn(x: number, y: number): void {
    this.target.set(x, 0, y);
    const close = this.cssH / 100;
    if (this.halfH > close) this.halfH = close;
  }

  worldToScreen(x: number, y: number): { x: number; y: number } {
    this.updateCamera();
    this.project(x, 0, y);
    return { x: this.sp.x, y: this.sp.y };
  }

  fitView(): void {
    if (!this.map) return;
    this.fit();
  }

  citizenToScreen(id: string): { x: number; y: number } | null {
    const v = this.vis.get(id);
    if (!v?.visible) return null;
    this.project(v.hx, (v.hy + v.fy) / 2, v.hz);
    return { x: this.sp.x, y: this.sp.y };
  }

  buildingToScreen(id: string): { x: number; y: number } | null {
    const bi = this.info.get(id);
    if (!bi) return null;
    this.project(bi.b.x + bi.b.w / 2, bi.box.max.y, bi.b.y + bi.b.h / 2);
    return { x: this.sp.x, y: this.sp.y };
  }

  get zoom(): number {
    return this.pxPerTile;
  }

  get center(): { x: number; y: number } {
    return { x: this.target.x, y: this.target.z };
  }

  /** Turn the view 90° (dir = 1 clockwise, -1 anticlockwise). */
  rotate(dir: number): void {
    this.azGoal = Math.round((this.azGoal + (dir * Math.PI) / 2 - Math.PI / 4) / (Math.PI / 2)) * (Math.PI / 2) + Math.PI / 4;
  }

  get director(): boolean {
    return this.directorOn;
  }

  /** The director camera glides to interesting moments on its own. */
  setDirector(on: boolean): void {
    this.directorOn = on;
    this.shot = null;
    this.directorEventId = store.s.events[store.s.events.length - 1]?.id ?? 0;
    if (!on) this.rotate(0);
  }

  // ----------------------------------------------------------- camera

  private updateCamera(): void {
    const aspect = this.cssW / this.cssH;
    const c = this.camera;
    c.left = -this.halfH * aspect;
    c.right = this.halfH * aspect;
    c.top = this.halfH;
    c.bottom = -this.halfH;
    c.updateProjectionMatrix();
    const ce = Math.cos(ELEVATION);
    c.position.set(this.target.x + Math.sin(this.az) * ce * DISTANCE, Math.sin(ELEVATION) * DISTANCE, this.target.z + Math.cos(this.az) * ce * DISTANCE);
    c.lookAt(this.target);
    c.updateMatrixWorld();
    this.right.set(Math.cos(this.az), 0, -Math.sin(this.az));
    this.fwd.set(-Math.sin(this.az), 0, -Math.cos(this.az));
    this.fog.near = DISTANCE - 10;
    this.fog.far = DISTANCE + 110;
  }

  /** Show the whole city, centred. */
  private fit(): void {
    const map = this.map!;
    this.target.set(map.width / 2, 0, map.height / 2);
    this.az = this.azGoal;
    this.halfH = 20;
    this.updateCamera();
    const camUp = this.v2.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    let minR = Infinity;
    let maxR = -Infinity;
    let minU = Infinity;
    let maxU = -Infinity;
    for (const x of [0, map.width]) {
      for (const z of [0, map.height]) {
        for (const y of [0, 4]) {
          this.v.set(x - this.target.x, y, z - this.target.z);
          const r = this.v.dot(this.right);
          const u = this.v.dot(camUp);
          minR = Math.min(minR, r);
          maxR = Math.max(maxR, r);
          minU = Math.min(minU, u);
          maxU = Math.max(maxU, u);
        }
      }
    }
    const aspect = this.cssW / this.cssH;
    this.halfH = Math.max((maxU - minU) / 2, (maxR - minR) / 2 / aspect) * 1.02;
    this.maxHalfH = this.halfH * 1.6;
    // centre the box on screen
    const midR = (minR + maxR) / 2;
    const midU = (minU + maxU) / 2;
    // (a ground point further away appears higher on screen by sin(elevation))
    this.target.addScaledVector(this.right, midR).addScaledVector(this.fwd, midU / Math.sin(ELEVATION));
    this.updateCamera();
  }

  /** Ground point under a CSS-pixel position (written into this.hit). */
  private groundAt(sx: number, sy: number): Vector3 | null {
    this.ndc.set((sx / this.cssW) * 2 - 1, -(sy / this.cssH) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return this.raycaster.ray.intersectPlane(this.ground, this.hit);
  }

  private zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.groundAt(sx, sy);
    if (!before) return;
    const bx = before.x;
    const bz = before.z;
    this.halfH = Math.min(this.maxHalfH, Math.max(3.5, this.halfH / factor));
    this.updateCamera();
    const after = this.groundAt(sx, sy);
    if (after) {
      this.target.x += bx - after.x;
      this.target.z += bz - after.z;
    }
  }

  private clampTarget(): void {
    if (!this.map) return;
    this.target.x = Math.min(this.map.width, Math.max(0, this.target.x));
    this.target.z = Math.min(this.map.height, Math.max(0, this.target.z));
  }

  /** CSS-pixel screen position of a world point, into this.sp. */
  private project(x: number, y: number, z: number): boolean {
    this.v.set(x, y, z).project(this.camera);
    this.sp.x = ((this.v.x + 1) / 2) * this.cssW;
    this.sp.y = ((1 - this.v.y) / 2) * this.cssH;
    return this.v.z < 1 && this.sp.x > -80 && this.sp.y > -80 && this.sp.x < this.cssW + 80 && this.sp.y < this.cssH + 80;
  }

  /** Horizontal CSS pixels per tile (like the 2D camera's scale). */
  private get pxPerTile(): number {
    return this.cssH / (2 * this.halfH);
  }

  // ------------------------------------------------------------ input

  private attachInput(): void {
    const c = this.canvas;
    c.style.touchAction = "none";
    c.addEventListener("wheel", this.onWheel, { passive: false });
    c.addEventListener("pointerdown", this.onDown);
    c.addEventListener("pointermove", this.onMove);
    c.addEventListener("pointerup", this.onUp);
    c.addEventListener("pointercancel", this.onUp);
    c.addEventListener("pointerleave", this.onLeave);
    window.addEventListener("keydown", this.onKey);
  }

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = this.local(e);
    this.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
    this.directorPause();
  };

  private onDown = (e: PointerEvent) => {
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    this.canvas.setPointerCapture(e.pointerId);
    if (this.pointers.size === 1) {
      const g = this.groundAt(p.x, p.y);
      this.drag = g ? { anchor: g.clone(), moved: false, sx: p.x, sy: p.y } : null;
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), halfH: this.halfH };
      if (this.drag) this.drag.moved = true;
    }
  };

  private onMove = (e: PointerEvent) => {
    const p = this.local(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > 10) {
        const want = Math.min(this.maxHalfH, Math.max(3.5, (this.pinch.halfH * this.pinch.dist) / d));
        this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, this.halfH / want);
      }
      this.directorPause();
      return;
    }
    if (this.drag) {
      if (Math.abs(p.x - this.drag.sx) + Math.abs(p.y - this.drag.sy) > 4) this.drag.moved = true;
      if (this.drag.moved) {
        const g = this.groundAt(p.x, p.y);
        if (g) {
          this.target.x += this.drag.anchor.x - g.x;
          this.target.z += this.drag.anchor.z - g.z;
          this.clampTarget();
          this.updateCamera();
        }
        store.setFollow(false);
        this.directorPause();
      }
      this.canvas.style.cursor = "grabbing";
      return;
    }
    const pick = this.pick(p.x, p.y);
    this.hover = pick.citizen;
    this.canvas.style.cursor = pick.citizen || pick.business ? "pointer" : "grab";
  };

  private onUp = (e: PointerEvent) => {
    const wasClick = this.drag && !this.drag.moved && this.pointers.size === 1;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (wasClick) {
      const p = this.local(e);
      this.click(p.x, p.y);
    }
    if (this.pointers.size === 0) this.drag = null;
    this.canvas.style.cursor = "grab";
  };

  private onLeave = () => {
    this.hover = null;
  };

  private onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    const step = 40 / this.pxPerTile;
    const k = e.key;
    let dx = 0;
    let dz = 0;
    if (k === "ArrowLeft" || k === "a") dx = -step;
    if (k === "ArrowRight" || k === "d") dx = step;
    if (k === "ArrowUp" || k === "w") dz = step;
    if (k === "ArrowDown" || k === "s") dz = -step;
    if (dx || dz) {
      this.target.addScaledVector(this.right, dx).addScaledVector(this.fwd, dz / Math.sin(ELEVATION));
      this.clampTarget();
      this.directorPause();
    }
    if (k === "+" || k === "=") this.zoomAt(this.cssW / 2, this.cssH / 2, 1.2);
    if (k === "-") this.zoomAt(this.cssW / 2, this.cssH / 2, 1 / 1.2);
    if (k === "q" || k === "Q") this.rotate(-1);
    if (k === "e" || k === "E") this.rotate(1);
  };

  // ---------------------------------------------------------- picking

  /** What's under the pointer: the nearest citizen (as in 2D), else a business. */
  private pick(sx: number, sy: number): { citizen: string | null; business: string | null } {
    this.ndc.set((sx / this.cssW) * 2 - 1, -(sy / this.cssH) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const ray = this.raycaster.ray;
    const worldPerPx = (2 * this.halfH) / this.cssH;
    let best: string | null = null;
    let bestD = 14;
    for (const [id, v] of this.vis) {
      if (!v.visible) continue;
      // Distance from the ray to the middle of the figure, in screen pixels.
      this.v.set(v.hx, (v.hy + v.fy) / 2, v.hz);
      const d = ray.distanceToPoint(this.v) / worldPerPx + (v.inside ? 7 : -4);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    if (best) return { citizen: best, business: null };
    // Buildings: nearest box the ray hits.
    let bestBiz: string | null = null;
    let nearest = Infinity;
    const st = store.s.state;
    if (st && this.decor) {
      for (const [bid, box] of this.decor.boxes) {
        const h = ray.intersectBox(box, this.hit);
        if (h) {
          const dist = h.distanceTo(ray.origin);
          if (dist < nearest) {
            nearest = dist;
            bestBiz = bid;
          }
        }
      }
      for (const bi of this.info.values()) {
        const h = ray.intersectBox(bi.box, this.hit);
        if (!h) continue;
        const dist = h.distanceTo(ray.origin);
        if (dist < nearest - 0.01) {
          const here = this.shopIn.get(bi.b.id);
          nearest = dist;
          bestBiz = here ? here.id : null;
        }
      }
    }
    return { citizen: null, business: bestBiz };
  }

  private click(sx: number, sy: number): void {
    const p = this.pick(sx, sy);
    if (p.citizen) {
      store.select({ kind: "citizen", id: p.citizen });
      return;
    }
    const st = store.s.state;
    if (p.business && st) {
      // Shops hold one business; the marketplace and cowork hold several:
      // clicking the building again moves on to the next one there.
      const biz = st.businesses.find((x) => x.id === p.business);
      const here = st.businesses.filter((x) => x.open && x.buildingId === biz?.buildingId);
      const sel = store.s.selection;
      const i = sel?.kind === "business" ? here.findIndex((x) => x.id === sel.id) : -1;
      if (i >= 0 && here.length > 1) store.select({ kind: "business", id: here[(i + 1) % here.length].id });
      else store.select({ kind: "business", id: p.business });
      return;
    }
    store.select(null);
  }

  // ------------------------------------------------------------ frame

  private resize(): void {
    if (!this.needsResize) return;
    this.needsResize = false;
    const r = this.canvas.getBoundingClientRect();
    this.cssW = Math.max(1, r.width);
    this.cssH = Math.max(1, r.height);
    const dpr = window.devicePixelRatio || 1;
    const devH = this.cssH * dpr;
    const scale = Math.max(1, Math.round(devH / TARGET_PIXELS_TALL));
    this.gl.setSize(Math.max(1, Math.ceil((this.cssW * dpr) / scale)), Math.max(1, Math.ceil(devH / scale)), false);
    this.overlay.width = Math.round(this.cssW * dpr);
    this.overlay.height = Math.round(this.cssH * dpr);
  }

  private refreshLookups(): void {
    const st = store.s.state;
    if (!st || st === this.stateSeen) return;
    this.stateSeen = st;
    this.citizenMeta.clear();
    for (const c of st.citizens) this.citizenMeta.set(c.id, c);
    this.shopIn.clear();
    this.bizById.clear();
    for (const b of st.businesses) {
      this.bizById.set(b.id, b);
      if (b.open && !this.shopIn.has(b.buildingId)) this.shopIn.set(b.buildingId, b);
    }
  }

  /** CPU time of the last frame in ms, smoothed (for profiling: window.hustle.renderer.cpuMs). */
  cpuMs = 0;

  private frame(now: number): void {
    const t0 = performance.now();
    this.renderFrame(now);
    this.cpuMs += (performance.now() - t0 - this.cpuMs) * 0.1;
  }

  private renderFrame(now: number): void {
    this.resize();
    this.refreshLookups();
    const dt = Math.min(0.1, (now - this.lastNow) / 1000);
    this.lastNow = now;
    if (!this.map) return;
    if (!this.fitted && this.cssW > 10) {
      this.fit();
      this.fitted = true;
    }
    this.interp.update(now);

    this.az += angleDelta(this.az, this.azGoal) * Math.min(1, dt * 8);
    const sel = store.s.selection;
    if (this.directorOn) this.direct(now, dt);
    else if (store.s.followSelected && sel?.kind === "citizen") {
      const p = this.interp.positions.get(sel.id);
      if (p) {
        this.target.x += (p.x - this.target.x) * 0.12;
        this.target.z += (p.y - this.target.z) * 0.12;
      }
    }
    this.clampTarget();
    this.updateCamera();

    if (now - this.lastSlow > 500) {
      this.lastSlow = now;
      this.updateDecor();
      this.updateWindows();
    }
    this.updateLighting();
    this.updatePeople(dt);
    this.updateSelection();
    this.gl.render(this.scene, this.camera);
    this.drawOverlay(now);
  }

  private updateLighting(): void {
    const t = this.interp.gameTime;
    const n = darkness(t) / 0.62;
    const h = (((t % 1440) + 1440) % 1440) / 60;
    // Sun crosses the sky from 05:30 to 19:30.
    const theta = ((h - 5.5) / 14) * Math.PI;
    const e = h > 5.5 && h < 19.5 ? Math.sin(theta) : 0;
    const map = this.map!;
    // Rises in the east (+x), sets in the west, a little to the south.
    this.v.set(Math.cos(theta), 0.2 + e * 1.2, 0.55).normalize();
    this.sun.position.set(map.width / 2, 0, map.height / 2).addScaledVector(this.v, 90);
    this.sun.intensity = Math.min(1, e * 3) * 2.6 * (1 - n * 0.9);
    this.sun.color.copy(COL.sunLow).lerp(COL.sunHigh, Math.min(1, e * 1.6));
    this.sun.castShadow = this.sun.intensity > 0.05;
    this.moon.position.set(map.width / 2 - 40, 70, map.height / 2 - 25);
    this.moon.intensity = n * 1.1;
    this.hemi.color.copy(COL.hemiDay).lerp(COL.hemiNight, n);
    this.hemi.groundColor.copy(COL.groundDay).lerp(COL.groundNight, n);
    this.hemi.intensity = 1.25 + n * 0.35;
    // Sky: blue by day, warm at sunrise and sunset, deep navy at night.
    const golden = h > 4.5 && h < 22 ? Math.min(1, Math.max(0, 1 - Math.abs(e) * 2.2)) * (1 - n * 0.6) : 0;
    this.sky.copy(COL.skyDay).lerp(COL.skyDusk, golden).lerp(COL.skyNight, n);
    this.hemi.color.lerp(COL.skyDusk, golden * 0.45);
    this.fog.color.copy(this.sky);
    (this.lampHeads!.material as MeshBasicMaterial).color.copy(COL.lampOff).lerp(COL.lampOn, n);
    (this.lampPools!.material as MeshBasicMaterial).opacity = n * 0.75;
    (this.windowMesh!.material as MeshBasicMaterial).opacity = Math.min(1, n * 1.6);
  }

  /** Light up windows where someone is awake inside (and the pub/diner). */
  private updateWindows(): void {
    if (!this.windowMesh) return;
    const awake = new Set<string>();
    for (const p of this.interp.positions.values()) if (p.inside && p.kind !== "sleep") awake.add(p.inside);
    const colors = this.windowMesh.geometry.getAttribute("color") as BufferAttribute;
    const arr = colors.array as Float32Array;
    let changed = false;
    for (const [id, range] of this.windowRanges) {
      const type = this.info.get(id)?.b.type;
      const lit = awake.has(id) || type === "pub" || type === "diner" || type === "townhall";
      if (this.windowLit.get(id) === lit) continue;
      this.windowLit.set(id, lit);
      changed = true;
      for (let i = range.start; i < range.start + range.count; i++) {
        arr[i * 3] = lit ? COL.windowLit.r : 0;
        arr[i * 3 + 1] = lit ? COL.windowLit.g : 0;
        arr[i * 3 + 2] = lit ? COL.windowLit.b : 0;
      }
    }
    if (changed) colors.needsUpdate = true;
  }

  private updateDecor(): void {
    const st = store.s.state;
    if (!st) return;
    const key = decorKey(st.businesses);
    if (key === this.decorKey) return;
    this.decorKey = key;
    if (this.decorMesh) {
      this.scene.remove(this.decorMesh);
      this.decorMesh.geometry.dispose();
      (this.decorMesh.material as Material).dispose();
    }
    this.decor = buildDecor(st.businesses, this.info);
    this.decorMesh = new Mesh(this.decor.geometry, new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    this.decorMesh.castShadow = true;
    this.decorMesh.receiveShadow = true;
    this.scene.add(this.decorMesh);
  }

  private updatePeople(dt: number): void {
    const st = store.s.state;
    if (!st || !this.map) return;
    const sel = store.s.selection;
    const map = this.map;
    let i = 0;
    let colorsChanged = false;
    for (const [id, p] of this.interp.positions) {
      let v = this.vis.get(id);
      if (!v) {
        const seed = strHash(id);
        v = { x: p.x, z: p.y, yaw: 0, phase: seed % 7, hx: 0, hy: 0, hz: 0, fy: 0, visible: false, inside: false, body: new Color(), hat: new Color(), colorKey: "", seed };
        this.vis.set(id, v);
      }
      v.visible = false;
      if (i >= MAX_CITIZENS) continue;
      const bi = p.inside ? this.info.get(p.inside) : undefined;
      const selected = sel?.kind === "citizen" && sel.id === id;
      if (bi && bi.mode === "home" && !selected) continue; // at home: shown as lit windows
      let x = p.x;
      let z = p.y;
      let y = 0;
      let scale = 1;
      if (bi) {
        const d = bi.deck;
        x = Math.min(d.x1, Math.max(d.x0, x));
        z = Math.min(d.z1, Math.max(d.z0, z));
        y = d.y;
        if (bi.mode !== "open") scale = 0.8;
      } else {
        const tx = Math.floor(x);
        const tz = Math.floor(z);
        const road = tx >= 0 && tz >= 0 && tx < map.width && tz < map.height && map.tiles[tz * map.width + tx] === TILE_ROAD;
        y = road ? 0.005 : SLAB;
      }
      // Face the way they're walking; bob while moving.
      const dx = x - v.x;
      const dz = z - v.z;
      const moved = Math.hypot(dx, dz);
      if (moved > 0.0005 && moved < 2) {
        v.yaw += angleDelta(v.yaw, Math.atan2(dx, dz)) * Math.min(1, dt * 10);
        v.phase += moved * 9;
      }
      v.x = x;
      v.z = z;
      const walking = moved > 0.0005 && moved < 2 && !p.inside;
      const bob = walking ? Math.abs(Math.sin(v.phase)) * 0.07 : 0;
      this.people.place(i, x, y + bob, z, v.yaw, scale);
      const meta = this.citizenMeta.get(id);
      const key = meta ? meta.occupation + meta.color : "";
      if (meta && key !== v.colorKey) {
        v.colorKey = key;
        v.body.set(OCC_COLORS[meta.occupation] ?? "#999999");
        v.hat.set(meta.color);
      }
      this.people.paint(i, v.seed, v.body, v.hat);
      colorsChanged = true;
      v.hx = x;
      v.hy = y + (FIGURE_H + 0.05) * scale;
      v.fy = y;
      v.hz = z;
      v.visible = true;
      v.inside = !!p.inside;
      i++;
    }
    if (this.vis.size > this.interp.positions.size) for (const id of this.vis.keys()) if (!this.interp.positions.has(id)) this.vis.delete(id);
    this.people.finish(i, colorsChanged);
  }

  private updateSelection(): void {
    const sel = store.s.selection;
    const sv = sel?.kind === "citizen" ? this.vis.get(sel.id) : undefined;
    this.selRing.visible = !!sv?.visible;
    if (sv?.visible) this.selRing.position.set(sv.hx, sv.fy + 0.03, sv.hz);
    const hv = this.hover && this.hover !== sel?.id ? this.vis.get(this.hover) : undefined;
    this.hoverRing.visible = !!hv?.visible;
    if (hv?.visible) this.hoverRing.position.set(hv.hx, hv.fy + 0.03, hv.hz);
    let box: Box3 | undefined;
    if (sel?.kind === "business") {
      box = this.decor?.boxes.get(sel.id);
      const biz = this.bizById.get(sel.id);
      if (biz && this.info.get(biz.buildingId)?.b.type === "shop_unit") box = this.info.get(biz.buildingId)!.box;
    }
    this.bizOutline.visible = !!box;
    if (box) {
      box.getCenter(this.bizOutline.position);
      box.getSize(this.bizOutline.scale).addScalar(0.15);
    }
  }

  // ---------------------------------------------------------- overlay

  private drawOverlay(now: number): void {
    const ctx = this.octx;
    const dpr = this.overlay.width / this.cssW;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const st = store.s.state;
    if (!st || !this.map) return;
    const s = this.pxPerTile;
    const sel = store.s.selection;

    // Building names (landmarks from further out) and business signs.
    if (s >= 9) {
      for (const bi of this.info.values()) {
        const b = bi.b;
        let name: string | null = null;
        if (MAJOR.has(b.type)) {
          if (b.id === "park2") continue;
          name = b.name;
        } else if (b.type === "shop_unit" && s >= 14) {
          const biz = this.shopIn.get(b.id);
          name = biz ? biz.name : s > 26 ? "To let" : null;
        }
        if (!name) continue;
        if (!this.project(b.x + b.w / 2, bi.top + 0.35, b.y + b.h / 2)) continue;
        drawLabel(ctx, name, this.sp.x, this.sp.y - 16, "#ffe9b0", (b.w + 1.6) * s);
      }
    }

    // Activity icons and name tags.
    for (const [id, v] of this.vis) {
      if (!v.visible) continue;
      const isSel = sel?.kind === "citizen" && sel.id === id;
      const isHover = this.hover === id;
      const showIcon = s > 26 || isSel || isHover;
      const showName = isSel || isHover || s > 44;
      if (!showIcon && !showName) continue;
      if (!this.project(v.hx, v.hy, v.hz)) continue;
      const p = this.interp.positions.get(id);
      if (showIcon && p) {
        const icon = ACTIVITY_ICON[p.kind];
        if (icon) {
          ctx.font = `${Math.max(11, Math.min(18, s * 0.45))}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.fillText(icon, this.sp.x + 8, this.sp.y - 2);
        }
      }
      if (showName) {
        const m = this.citizenMeta.get(id);
        if (m) {
          this.project(v.hx, v.fy, v.hz);
          drawLabel(ctx, m.name, this.sp.x, this.sp.y + 4, isSel ? "#fff" : "rgba(255,255,255,0.9)");
        }
      }
    }

    // Money landing.
    if (st.fx !== this.lastFx) {
      this.lastFx = st.fx;
      for (const f of st.fx.slice(0, 12)) this.popups.push({ x: f.x + (Math.random() - 0.5) * 0.8, y: f.y, text: moneyText(f.amount), born: now + Math.random() * 400 });
      if (this.popups.length > 60) this.popups.splice(0, this.popups.length - 60);
    }
    const life = 1600;
    let keep = 0;
    for (const p of this.popups) if (now - p.born < life) this.popups[keep++] = p;
    this.popups.length = keep;
    if (s >= 12) {
      for (const p of this.popups) {
        const age = (now - p.born) / life;
        if (age < 0) continue;
        if (this.project(p.x, SLAB + 0.9, p.y)) drawMoneyPopup(ctx, p.text, this.sp.x, this.sp.y, age);
      }
    }

    // Speech bubbles.
    const placed: { x: number; y: number }[] = [];
    for (const bub of st.bubbles) {
      const v = this.vis.get(bub.speaker);
      const p = this.interp.positions.get(bub.speaker);
      if (v?.visible) this.project(v.hx, v.hy + 0.1, v.hz);
      else if (p) this.project(p.x, SLAB + 1, p.y);
      else continue;
      if (this.sp.x < -100 || this.sp.y < -100 || this.sp.x > this.cssW + 100 || this.sp.y > this.cssH + 100) continue;
      drawBubble(ctx, bub, this.sp.x, this.sp.y, this.cssW, placed);
    }
  }

  // ---------------------------------------------------------- director

  private directorPause(): void {
    if (this.directorOn) {
      this.shot = null;
      this.driftUntil = performance.now() + 8000;
    }
  }

  /** Glide to interesting moments, follow them for a few seconds, drift on. */
  private direct(now: number, dt: number): void {
    const st = store.s.state;
    if (!st || !this.map) return;
    if (now < this.driftUntil && !this.shot) return; // the player just moved the camera
    if (!this.shot || now > this.shot.until) {
      const next = this.nextShot(now);
      if (next) this.shot = next;
      else if (this.shot && now > this.shot.until) this.shot = null;
    }
    const close = Math.max(4, this.cssH / 90);
    if (this.shot) {
      if (this.shot.citizen) {
        const p = this.interp.positions.get(this.shot.citizen);
        if (p) {
          this.shot.x = p.x;
          this.shot.z = p.y;
        }
      }
      const k = Math.min(1, dt * 1.8);
      this.target.x += (this.shot.x - this.target.x) * k;
      this.target.z += (this.shot.z - this.target.z) * k;
      this.halfH += (close - this.halfH) * Math.min(1, dt * 1.2);
    } else {
      // Drift: a slow orbit around town, pulled gently back towards the middle.
      this.azGoal += dt * 0.05;
      this.az = this.azGoal;
      const wide = Math.min(this.maxHalfH, close * 2.6);
      this.halfH += (wide - this.halfH) * Math.min(1, dt * 0.5);
      this.target.x += (this.map.width / 2 - this.target.x) * dt * 0.08;
      this.target.z += (this.map.height / 2 - this.target.z) * dt * 0.08;
    }
  }

  private nextShot(now: number): { citizen: string | null; x: number; z: number; until: number } | null {
    const events = store.s.events;
    let pick: (typeof events)[number] | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.id <= this.directorEventId) break;
      const interesting = e.importance >= 3 || e.conversationId !== undefined || e.cat === "business" || e.cat === "god";
      if (interesting && (e.citizens.length || e.businessId) && (!pick || e.importance > pick.importance)) pick = e;
    }
    const lastId = events[events.length - 1]?.id ?? this.directorEventId;
    if (pick) {
      this.directorEventId = lastId;
      const until = now + 6000;
      if (pick.citizens.length && this.interp.positions.has(pick.citizens[0])) {
        const p = this.interp.positions.get(pick.citizens[0])!;
        return { citizen: pick.citizens[0], x: p.x, z: p.y, until };
      }
      const biz = store.s.state?.businesses.find((b) => b.id === pick!.businessId);
      const bi = biz ? this.info.get(biz.buildingId) : undefined;
      if (bi) return { citizen: null, x: bi.b.x + bi.b.w / 2, z: bi.b.y + bi.b.h / 2, until };
    }
    // Big money changing hands.
    const st = store.s.state;
    if (st && st.fx !== this.directorFxSeen) {
      this.directorFxSeen = st.fx;
      let big: { x: number; y: number; amount: number } | null = null;
      for (const f of st.fx) if (f.amount >= 60 && (!big || f.amount > big.amount)) big = f;
      if (big) return { citizen: null, x: big.x, z: big.y, until: now + 4500 };
    }
    return null;
  }

  // --------------------------------------------------------- cleanup

  private disposeCity(): void {
    for (const m of [this.cityMesh, this.windowMesh, this.lampHeads, this.lampPools, this.decorMesh]) {
      if (!m) continue;
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as Material).dispose();
    }
    this.cityMesh = this.windowMesh = this.lampHeads = this.lampPools = this.decorMesh = null;
    this.decor = null;
  }
}
