import {
  NeutralToneMapping,
  AdditiveBlending,
  BasicShadowMap,
  Box3,
  BoxGeometry,
  BufferAttribute,
  Color,
  DirectionalLight,
  EdgesGeometry,
  Fog,
  HalfFloatType,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  MeshStandardMaterial,
  OrthographicCamera,
  PCFShadowMap,
  PerspectiveCamera,
  Plane,
  PMREMGenerator,
  Ray,
  Raycaster,
  RingGeometry,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  type Material,
} from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import type { BusinessSummary, CitizenSummary } from "../../shared/protocol";
import type { CityMap } from "../../sim/types";
import { TILE_ROAD } from "../../sim/types";
import { store } from "../net/store";
import { FrameInterpolator } from "../render/interpolation";
import { ACTIVITY_ICON, bubbleInk, darkness, drawBubble, drawEmotion, drawLabel, drawMoneyPopup, moneyText, showFeelingOnMap } from "../render/overlay";
import type { CityRenderer, Pos } from "../render/types";
import { OCC_COLORS } from "../ui/format";
import { buildDecor, decorKey, type BusinessDecor } from "./businesses";
import { buildCity, SLAB, type BuildingInfo } from "./city";
import { CitizenMeshes, FIGURE_H, MAX_CITIZENS, type Figures, type Pose } from "./citizens";
import { MirrorFloor } from "./dream/floor";
import { MannequinMeshes, MANNEQUIN_H } from "./dream/mannequins";
import { DreamRuins } from "./dream/ruins";
import { dreamEnvironment, DreamSky } from "./dream/sky";
import { TownEffects } from "./effects";
import { P, type Look } from "./palette";

// The 3D view of the city, in one of two looks:
//  - dream (default): marble and pastel buildings and glossy mannequins on an
//    endless reflective hex-tiled floor, under a purple-clouded sky dome;
//    rendered smoothly at full resolution.
//  - retro: the low-poly town rendered into a small drawing buffer (about
//    400 px tall) and scaled up with nearest-neighbour filtering.
// Either can be seen from the usual tilted overhead camera, or from ground
// level (a perspective camera behind the selected person, or circling the
// town). Text (names, icons, money, speech) is drawn crisply on a 2D overlay.

const ELEVATION = 0.64; // radians above the ground (~37°)
const DISTANCE = 160;
const TARGET_PIXELS_TALL = 400;
/** Mannequins are drawn a little larger than life, so they read from above. */
const PEOPLE_SCALE = 1.12;
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
  /** How much they're walking and talking (eased, 0..1). */
  walk: number;
  talk: number;
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

/** Dreamscape light: lilac daylight, rose sunsets, violet nights. */
const DREAM_COL = {
  hemiDay: new Color(0xf6ecff),
  hemiNight: new Color(0x5a4aa8),
  groundDay: new Color(0x8a7a8e),
  groundNight: new Color(0x1c1630),
  dusk: new Color(0xff9fb0),
  sunLow: new Color(0xffa58a),
  sunHigh: new Color(0xfff4ec),
};

/** A soft vignette with a violet tint at the edges, like an old dream. */
const VIGNETTE = {
  uniforms: { tDiffuse: { value: null }, strength: { value: 0.32 }, tint: { value: new Color(0.82, 0.74, 1.0) } },
  vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
  fragmentShader: `uniform sampler2D tDiffuse; uniform float strength; uniform vec3 tint; varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  vec2 d = (vUv - 0.5) * vec2(1.0, 0.92);
  float v = smoothstep(0.82, 0.28, length(d));
  c.rgb *= mix(1.0 - strength, 1.0, v);
  c.rgb = mix(c.rgb * tint, c.rgb, v * 0.6 + 0.4);
  gl_FragColor = c;
}`,
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
  private people: Figures;
  private readonly look: Look;
  private readonly figureH: number;
  private dreamSky: DreamSky | null = null;
  private floor: MirrorFloor | null = null;
  private ruins: DreamRuins | null = null;
  private envRT: WebGLRenderTarget | null = null;
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private vignette: ShaderPass | null = null;
  private pose: Pose = { phase: 0, walk: 0, talk: 0, speaking: false, head: 0, t: 0, seed: 0 };
  private partner = new Map<string, string>();
  /** 2: everything; 1: no anti-aliasing or glow; 0: no mirror floor either. Stepped down if frames are slow. */
  private quality = 2;
  private frameGap = 16;
  private lastFrameAt = 0;
  private qualityCheckAt = 0;
  private readonly autoQuality = typeof location === "undefined" || !new URLSearchParams(location.search).has("hq");
  private speaking = new Set<string>();
  private fx = new TownEffects();
  private persp = new PerspectiveCamera(50, 1, 0.1, 900);
  /** Ground-level view (perspective) instead of the overhead one. */
  private groundOn = false;
  private gYaw = Math.PI / 4;
  private gDist = 5;
  private gSubject: string | null = null;
  private gEye = new Vector3();
  private gLook = new Vector3();
  private gRay = new Ray();
  private gFrom = new Vector3();
  private gHit = new Vector3();
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

  constructor(
    private canvas: HTMLCanvasElement,
    look: Look = "dream",
  ) {
    this.look = look;
    const dream = look === "dream";
    this.gl = new WebGLRenderer({ canvas, antialias: dream, powerPreference: "high-performance" });
    this.gl.setPixelRatio(1);
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = dream ? PCFShadowMap : BasicShadowMap;
    canvas.style.imageRendering = dream ? "auto" : "pixelated";
    this.people = dream ? new MannequinMeshes(MAX_CITIZENS) : new CitizenMeshes();
    this.figureH = dream ? MANNEQUIN_H : FIGURE_H;
    if (dream) {
      this.dreamSky = new DreamSky();
      this.floor = new MirrorFloor();
      this.scene.add(this.dreamSky.dome, this.dreamSky.stars, this.floor.mesh);
      // Gentle tone mapping (keeps the pastels as painted, rolls off only the brightest lights), glossy things reflecting the sky, a glow on bright lights, a vignette.
      this.gl.toneMapping = NeutralToneMapping;
      this.gl.toneMappingExposure = 0.95;
      const pm = new PMREMGenerator(this.gl);
      const env = dreamEnvironment();
      this.envRT = pm.fromEquirectangular(env);
      this.scene.environment = this.envRT.texture;
      env.dispose();
      pm.dispose();
      this.composer = new EffectComposer(this.gl, new WebGLRenderTarget(4, 4, { type: HalfFloatType, samples: 4 }));
      this.renderPass = new RenderPass(this.scene, this.camera);
      this.bloom = new UnrealBloomPass(new Vector2(256, 256), 0.3, 0.55, 0.95);
      this.vignette = new ShaderPass(VIGNETTE);
      this.composer.addPass(this.renderPass);
      this.composer.addPass(this.bloom);
      this.composer.addPass(this.vignette);
      this.composer.addPass(new OutputPass());
    }
    this.scene.add(this.fx.group);

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
    this.sun.shadow.mapSize.set(dream ? 2048 : 1024, dream ? 2048 : 1024);
    this.sun.shadow.bias = -0.0015;
    this.sun.shadow.normalBias = 0.02;
    for (const m of this.people.meshes) this.scene.add(m);
    // Layer 1 holds things only the player's cameras see (the people's see-through silhouettes).
    this.camera.layers.enable(1);
    this.persp.layers.enable(1);

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
    const geo = buildCity(map, this.look);
    this.info = geo.info;
    COL.lampOff.setHex(P.lampOff);
    COL.lampOn.setHex(P.lampOn);
    COL.windowLit.setHex(P.windowLit);
    this.cityMesh = new Mesh(geo.city, this.surfaceMaterial());
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
    if (this.look === "dream") {
      this.ruins = new DreamRuins(map.width, map.height);
      this.scene.add(this.ruins.group);
      // Windows and lamps glow brighter than white, so the bloom catches them.
      (this.windowMesh.material as MeshBasicMaterial).color.setScalar(1.9);
    }
    this.decorKey = "";
    const cx = map.width / 2;
    const cz = map.height / 2;
    this.sunTarget.position.set(cx, 0, cz);
    const sc = this.sun.shadow.camera;
    const r = Math.max(map.width, map.height) * (this.look === "dream" ? 1.1 : 0.75);
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
    this.fx.dispose();
    this.dreamSky?.dispose();
    this.floor?.dispose();
    this.composer?.dispose();
    this.envRT?.dispose();
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
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
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
    if (this.groundOn && dir !== 0) {
      this.gYaw -= (dir * Math.PI) / 4;
      return;
    }
    this.azGoal = Math.round((this.azGoal + (dir * Math.PI) / 2 - Math.PI / 4) / (Math.PI / 2)) * (Math.PI / 2) + Math.PI / 4;
  }

  get director(): boolean {
    return this.directorOn;
  }

  get groundView(): boolean {
    return this.groundOn;
  }

  /** See the town from ground level: behind the selected person, or circling the middle of town. */
  setGroundView(on: boolean): void {
    this.groundOn = on;
    this.gDist = 5;
    this.needsResize = true;
    this.updateCamera();
  }

  private surfaceMaterial(): Material {
    return this.look === "dream"
      ? new MeshStandardMaterial({ vertexColors: true, roughness: 0.46, metalness: 0, envMapIntensity: 0.6 })
      : new MeshLambertMaterial({ vertexColors: true, flatShading: true });
  }

  /** The camera in use. */
  private cam(): OrthographicCamera | PerspectiveCamera {
    return this.groundOn ? this.persp : this.camera;
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
    if (this.groundOn) {
      this.updateGroundCamera(aspect);
      return;
    }
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
    this.fog.near = this.look === "dream" ? DISTANCE + 5 : DISTANCE - 10;
    this.fog.far = this.look === "dream" ? DISTANCE + 190 : DISTANCE + 110;
  }

  /** Ground level: just behind and above the subject's shoulder, looking past them towards the horizon. */
  private updateGroundCamera(aspect: number): void {
    const sel = store.s.selection;
    const subject = this.gSubject ?? (sel?.kind === "citizen" ? sel.id : null);
    const p = subject ? this.vis.get(subject) : undefined;
    let fx = this.target.x;
    let fz = this.target.z;
    let fy = 0;
    if (p?.visible) {
      fx = p.hx;
      fz = p.hz;
      fy = p.fy;
    }
    const d = p?.visible ? this.gDist : this.gDist * 4;
    const c = this.persp;
    c.aspect = aspect;
    c.fov = 52;
    c.near = 0.1;
    c.far = 900;
    c.updateProjectionMatrix();
    this.gEye.set(fx + Math.sin(this.gYaw) * d, fy + 0.75 + d * 0.16, fz + Math.cos(this.gYaw) * d);
    if (p?.visible) this.keepEyeOutOfBuildings(fx, fy, fz);
    this.gLook.set(fx - Math.sin(this.gYaw) * 6, fy + 0.95 + d * 0.05, fz - Math.cos(this.gYaw) * 6);
    c.position.copy(this.gEye);
    c.lookAt(this.gLook);
    c.updateMatrixWorld();
    this.right.set(Math.cos(this.gYaw), 0, -Math.sin(this.gYaw));
    this.fwd.set(-Math.sin(this.gYaw), 0, -Math.cos(this.gYaw));
    this.fog.near = 30;
    this.fog.far = this.look === "dream" ? 260 : 160;
  }

  /** If a building stands between the subject and the ground camera, bring the camera in front of it. */
  private keepEyeOutOfBuildings(fx: number, fy: number, fz: number): void {
    const from = this.gFrom.set(fx, fy + 0.9, fz);
    const dir = this.gHit.copy(this.gEye).sub(from);
    const len = dir.length();
    if (len < 0.01) return;
    this.gRay.set(from, dir.divideScalar(len));
    let near = len;
    for (const bi of this.info.values()) {
      if (bi.mode === "open" || bi.box.containsPoint(from)) continue;
      const hit = this.gRay.intersectBox(bi.box, this.v2);
      if (hit) near = Math.min(near, hit.distanceTo(from));
    }
    if (near < len) this.gEye.copy(from).addScaledVector(this.gRay.direction, Math.max(0.7, near - 0.3));
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
    this.maxHalfH = this.halfH * (this.look === "dream" ? 2.2 : 1.6);
    // The corners of the town are only road: crop them a little so the town fills the view.
    if (this.look === "dream") this.halfH *= 0.88;
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
    this.raycaster.setFromCamera(this.ndc, this.cam());
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
    if (!Number.isFinite(this.target.x) || !Number.isFinite(this.target.z)) this.target.set(this.map.width / 2, 0, this.map.height / 2);
    this.target.x = Math.min(this.map.width, Math.max(0, this.target.x));
    this.target.z = Math.min(this.map.height, Math.max(0, this.target.z));
  }

  /** CSS-pixel screen position of a world point, into this.sp. */
  private project(x: number, y: number, z: number): boolean {
    this.v.set(x, y, z).project(this.cam());
    this.sp.x = ((this.v.x + 1) / 2) * this.cssW;
    this.sp.y = ((1 - this.v.y) / 2) * this.cssH;
    return this.v.z < 1 && this.sp.x > -80 && this.sp.y > -80 && this.sp.x < this.cssW + 80 && this.sp.y < this.cssH + 80;
  }

  /** Horizontal CSS pixels per tile (like the 2D camera's scale). */
  private get pxPerTile(): number {
    return this.groundOn ? this.cssH / (2 * 12 * Math.tan((this.persp.fov * Math.PI) / 360)) : this.cssH / (2 * this.halfH);
  }

  /** Pixels per tile at a point (from ground level, near things look bigger). */
  private scaleAt(x: number, y: number, z: number): number {
    if (!this.groundOn) return this.cssH / (2 * this.halfH);
    const d = Math.max(0.5, this.v2.set(x, y, z).distanceTo(this.gEye));
    return this.cssH / (2 * d * Math.tan((this.persp.fov * Math.PI) / 360));
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
    if (this.groundOn) {
      this.gDist = Math.min(30, Math.max(1.6, this.gDist * Math.exp(e.deltaY * 0.0012)));
      return;
    }
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
      this.drag = g || this.groundOn ? { anchor: (g ?? this.target).clone(), moved: false, sx: p.x, sy: p.y } : null;
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
    if (this.drag && this.groundOn) {
      if (Math.abs(p.x - this.drag.sx) + Math.abs(p.y - this.drag.sy) > 4) this.drag.moved = true;
      if (this.drag.moved) {
        this.gYaw -= (p.x - this.drag.sx) * 0.006;
        this.drag.sx = p.x;
        this.drag.sy = p.y;
        this.directorPause();
      }
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
    if (this.groundOn) {
      if (k === "q" || k === "Q") this.gYaw += Math.PI / 4;
      if (k === "e" || k === "E") this.gYaw -= Math.PI / 4;
      return;
    }
    if (k === "q" || k === "Q") this.rotate(-1);
    if (k === "e" || k === "E") this.rotate(1);
  };

  // ---------------------------------------------------------- picking

  /** What's under the pointer: the nearest citizen (as in 2D), else a business. */
  private pick(sx: number, sy: number): { citizen: string | null; business: string | null } {
    this.ndc.set((sx / this.cssW) * 2 - 1, -(sy / this.cssH) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.cam());
    const ray = this.raycaster.ray;
    let best: string | null = null;
    let bestD = 14;
    for (const [id, v] of this.vis) {
      if (!v.visible) continue;
      // Distance from the pointer to the middle of the figure, in screen pixels.
      if (!this.project(v.hx, (v.hy + v.fy) / 2, v.hz)) continue;
      const d = Math.hypot(this.sp.x - sx, this.sp.y - sy) + (v.inside ? 7 : -4);
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
    if (this.look === "dream") {
      // Smooth and full resolution (capped, to keep the mirror pass cheap).
      const r = Math.min(dpr, 1.5);
      const w = Math.max(1, Math.round(this.cssW * r));
      const h = Math.max(1, Math.round(this.cssH * r));
      this.gl.setSize(w, h, false);
      this.floor?.setSize(this.cssW * r, this.cssH * r);
      this.composer?.setSize(w, h);
      this.bloom?.setSize(Math.round(w / 2), Math.round(h / 2));
    } else {
      const scale = Math.max(1, Math.round(devH / TARGET_PIXELS_TALL));
      this.gl.setSize(Math.max(1, Math.ceil((this.cssW * dpr) / scale)), Math.max(1, Math.ceil(devH / scale)), false);
    }
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
    if (this.map) this.fx.sync(st.happenings ?? [], this.info);
    // Who's talking to whom (so they face each other), and whose turn it is.
    this.partner.clear();
    this.speaking.clear();
    for (const c of st.conversations ?? []) {
      if (!c.live) continue;
      this.partner.set(c.a, c.b);
      this.partner.set(c.b, c.a);
    }
    for (const b of st.bubbles) {
      this.partner.set(b.a, b.b);
      this.partner.set(b.b, b.a);
      this.speaking.add(b.speaker);
    }
  }

  /** CPU time of the last frame in ms, smoothed (for profiling: window.hustle.renderer.cpuMs). */
  cpuMs = 0;

  private frame(now: number): void {
    if (this.composer && this.autoQuality) this.watchFrameRate(now);
    const t0 = performance.now();
    this.renderFrame(now);
    this.cpuMs += (performance.now() - t0 - this.cpuMs) * 0.1;
  }

  /** If frames keep coming slower than about 22 a second, drop the most expensive effects (one step at a time, never back). */
  private watchFrameRate(now: number): void {
    if (this.lastFrameAt) this.frameGap += (Math.min(250, now - this.lastFrameAt) - this.frameGap) * 0.05;
    this.lastFrameAt = now;
    if (!this.qualityCheckAt) this.qualityCheckAt = now + 5000;
    if (now < this.qualityCheckAt || document.hidden) return;
    this.qualityCheckAt = now + 2500;
    if (this.frameGap < 45 || this.quality === 0) return;
    this.quality--;
    if (this.quality === 1 && this.composer && this.bloom) {
      this.bloom.enabled = false;
      for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
        rt.samples = 0;
        rt.dispose();
      }
    } else if (this.quality === 0 && this.floor) {
      this.floor.enabled = false;
      this.sun.shadow.mapSize.set(1024, 1024);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.frameGap = 16;
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
    this.gSubject = this.directorOn && this.shot?.citizen ? this.shot.citizen : null;
    if (this.groundOn && !this.gSubject && !(sel?.kind === "citizen")) this.gYaw += dt * 0.06; // a slow look around town
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
    if (this.groundOn) this.updateCamera(); // follows the subject's freshly placed figure
    this.updateSelection();
    this.fx.animate(now, dt, this.groundOn ? this.gEye : this.target);
    const cam = this.cam();
    if (this.dreamSky) this.dreamSky.centre(cam.position.x, cam.position.z);
    if (this.floor?.enabled) this.floor.render(this.gl, this.scene, cam, [this.sun, this.moon]);
    if (this.composer && this.renderPass) {
      this.renderPass.camera = cam;
      this.composer.render(dt);
    } else this.gl.render(this.scene, cam);
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
    const storm = this.fx.storm;
    this.sun.intensity = Math.min(1, e * 3) * 2.6 * (1 - n * 0.9) * (1 - storm * 0.7);
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
    const lit = this.fx.powerCut ? 0 : n;
    (this.lampHeads!.material as MeshBasicMaterial).color.copy(COL.lampOff).lerp(COL.lampOn, lit);
    (this.lampPools!.material as MeshBasicMaterial).opacity = lit * 0.75;
    (this.windowMesh!.material as MeshBasicMaterial).opacity = this.fx.powerCut ? 0 : Math.min(1, n * 1.6);
    if (this.dreamSky) {
      // The dreamscape: lilac light, a painted sky, fog the colour of the horizon.
      this.sun.color.copy(DREAM_COL.sunLow).lerp(DREAM_COL.sunHigh, Math.min(1, e * 1.6));
      this.hemi.color.copy(DREAM_COL.hemiDay).lerp(DREAM_COL.hemiNight, n).lerp(DREAM_COL.dusk, golden * 0.35);
      this.hemi.groundColor.copy(DREAM_COL.groundDay).lerp(DREAM_COL.groundNight, n);
      // Light from the sky now comes mostly from the environment (reflections and soft fill).
      this.hemi.intensity = (0.4 + n * 0.2) * (1 - storm * 0.35);
      this.sun.intensity = Math.min(1, e * 3) * 3.4 * (1 - n * 0.9) * (1 - storm * 0.7);
      this.scene.environmentIntensity = (0.6 - n * 0.38) * (1 - storm * 0.4);
      this.dreamSky.setTime(Math.min(1, n + storm * 0.55), golden);
      this.ruins?.setNight(n);
      // Bright lights bloom, more so at night; lamps glow hotter than white.
      if (this.bloom) {
        this.bloom.strength = 0.16 + n * 0.85;
        this.bloom.threshold = 0.98 - n * 0.36;
        this.bloom.radius = 0.5 + n * 0.25;
      }
      (this.lampHeads!.material as MeshBasicMaterial).color.multiplyScalar(1 + lit * 3);
      this.gl.toneMappingExposure = 1.0 + n * 0.2;
      (this.lampPools!.material as MeshBasicMaterial).opacity = lit * 0.45;
      this.sky.copy(this.dreamSky.horizon);
      this.fog.color.copy(this.dreamSky.horizon);
      this.floor!.setNight(n);
    } else if (storm > 0.01) {
      this.hemi.intensity *= 1 - storm * 0.3;
      this.sky.lerp(COL.skyNight, storm * 0.35);
      this.fog.color.copy(this.sky);
    }
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
      const lit = !this.fx.powerCut && (awake.has(id) || type === "pub" || type === "diner" || type === "townhall");
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
    this.decorMesh = new Mesh(this.decor.geometry, this.surfaceMaterial());
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
        v = { x: p.x, z: p.y, yaw: 0, phase: seed % 7, hx: 0, hy: 0, hz: 0, fy: 0, visible: false, inside: false, body: new Color(), hat: new Color(), colorKey: "", seed, walk: 0, talk: 0 };
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
      let scale = this.look === "dream" ? PEOPLE_SCALE : 1;
      if (bi) {
        const d = bi.deck;
        if (bi.mode === "terrace") {
          // Along the front by where they are inside, a stable distance out from the door.
          const depth = ((v.seed >>> 4) % 97) / 97;
          if (bi.face % 2 === 0) {
            x = Math.min(d.x1, Math.max(d.x0, x));
            z = d.z0 + depth * (d.z1 - d.z0);
          } else {
            x = d.x0 + depth * (d.x1 - d.x0);
            z = Math.min(d.z1, Math.max(d.z0, z));
          }
        } else {
          x = Math.min(d.x1, Math.max(d.x0, x));
          z = Math.min(d.z1, Math.max(d.z0, z));
        }
        y = d.y;
        if (bi.mode === "roof" || bi.mode === "home") scale *= 0.8;
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
      v.walk += ((walking ? 1 : 0) - v.walk) * Math.min(1, dt * 8);
      // In a conversation: turn to face them (when they're close), and talk with your hands.
      const other = this.partner.get(id);
      const ov = other ? this.vis.get(other) : undefined;
      const chatting = !walking && (p.kind === "talk" || (!!ov?.visible && Math.hypot(ov.x - x, ov.z - z) < 3));
      v.talk += ((chatting && other ? 1 : 0) - v.talk) * Math.min(1, dt * 3);
      if (chatting && ov && Math.hypot(ov.x - x, ov.z - z) > 0.05 && Math.hypot(ov.x - x, ov.z - z) < 3) v.yaw += angleDelta(v.yaw, Math.atan2(ov.x - x, ov.z - z)) * Math.min(1, dt * 4);
      const bob = walking ? Math.abs(Math.sin(v.phase)) * (this.look === "dream" ? 0.018 : 0.07) : 0;
      const pose = this.pose;
      pose.phase = v.phase;
      pose.walk = v.walk;
      pose.talk = v.talk;
      pose.speaking = this.speaking.has(id);
      pose.head = 0;
      pose.t = this.lastNow / 1000;
      pose.seed = v.seed;
      this.people.place(i, x, y + bob, z, v.yaw, scale, walking ? Math.sin(v.phase) : 0, pose);
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
      v.hy = y + (this.figureH + 0.05) * scale;
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
        if (this.groundOn && this.scaleAt(b.x + b.w / 2, bi.top, b.y + b.h / 2) < 9) continue;
        if (!this.project(b.x + b.w / 2, bi.top + 0.35, b.y + b.h / 2)) continue;
        drawLabel(ctx, name, this.sp.x, this.sp.y - 16, "#ffe9b0", (b.w + 1.6) * s);
      }
    }

    // Activity icons and name tags.
    for (const [id, v] of this.vis) {
      if (!v.visible) continue;
      const isSel = sel?.kind === "citizen" && sel.id === id;
      const isHover = this.hover === id;
      // From ground level, it's how close each person is that counts.
      const sv = this.groundOn ? this.scaleAt(v.hx, v.hy, v.hz) : s;
      const showIcon = sv > 26 || isSel || isHover;
      const showName = isSel || isHover || sv > (this.groundOn ? 70 : 44);
      const meta = this.citizenMeta.get(id);
      const feeling = meta?.emotion && (showFeelingOnMap(meta.emotion) || isSel || isHover) && (sv > 16 || isSel || isHover) ? meta.emotion : null;
      if (!showIcon && !showName && !feeling) continue;
      if (!this.project(v.hx, v.hy, v.hz)) continue;
      if (feeling) drawEmotion(ctx, feeling.emoji, this.sp.x - 9, this.sp.y - 6, Math.max(11, Math.min(17, sv * 0.42)));
      const p = this.interp.positions.get(id);
      if (showIcon && p) {
        const icon = ACTIVITY_ICON[p.kind];
        if (icon) {
          ctx.font = `${Math.max(11, Math.min(18, sv * 0.45))}px sans-serif`;
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
      const m = this.citizenMeta.get(bub.speaker);
      drawBubble(ctx, bub, this.sp.x, this.sp.y, this.cssW, placed, m ? { name: m.name, color: bubbleInk(m.color) } : undefined);
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
    if (this.ruins) {
      this.scene.remove(this.ruins.group);
      this.ruins.dispose();
      this.ruins = null;
    }
  }
}
