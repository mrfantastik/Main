import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshPhongMaterial,
  Sprite,
  SpriteMaterial,
  type Material,
  type Object3D,
  type Vector3,
} from "three";
import type { HappeningDTO } from "../../shared/protocol";
import type { BuildingInfo } from "./city";
import { GeoBuilder } from "./geometry";
import { P } from "./palette";

// What town happenings look like on the map: flames and a glow over a shop
// on fire, rain and a darker sky in a storm, coloured lights strung round the
// park for a festival, a party glow over the pub, searchlights for a
// celebrity visit, and a new column in the park for each mysterious one.
// Rebuilt only when the set of happenings changes; animated every frame
// without allocating.

function glowTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

interface Flicker {
  obj: Object3D;
  base: number;
  speed: number;
  phase: number;
  kind: "flame" | "twinkle" | "disco" | "beam";
}

const DISCO = [0xff5fa2, 0x5fd0ff, 0xffe15f, 0x9b6bff, 0x5fff9b];
const RAIN = 1400;

export class TownEffects {
  readonly group = new Group();
  private readonly tex = glowTexture();
  private readonly owned: { geo?: BufferGeometry; mat?: Material }[] = [];
  private animated: Flicker[] = [];
  private key = "";
  private rain: LineSegments | null = null;
  private rainPos: Float32Array | null = null;
  private stormLevel = 0;
  private stormOn = false;
  private cut = false;
  private readonly col = new Color();

  /** 0..1, eased: how stormy it is right now (darkens the scene). */
  get storm(): number {
    return this.stormLevel;
  }

  /** The power is off: no lit windows or street lamps. */
  get powerCut(): boolean {
    return this.cut;
  }

  /** Call when a new state arrives. Rebuilds the effects if the happenings changed. */
  sync(list: HappeningDTO[], info: Map<string, BuildingInfo>): void {
    const active = list.filter((h) => h.active || h.kind === "sculpture");
    const key = active.map((h) => `${h.id}:${h.kind}`).join(",");
    this.stormOn = active.some((h) => h.kind === "storm" && h.active);
    this.cut = active.some((h) => h.kind === "power_cut" && h.active);
    if (key === this.key) return;
    this.key = key;
    this.clear();
    const center = (bid: string | null) => {
      const bi = bid ? info.get(bid) : undefined;
      return bi ? { x: bi.b.x + bi.b.w / 2, z: bi.b.y + bi.b.h / 2, top: bi.top, w: bi.b.w, h: bi.b.h } : null;
    };
    let sculptures = 0;
    for (const h of active) {
      const at = center(h.buildingId);
      switch (h.kind) {
        case "fire":
          if (!at) break;
          for (let i = 0; i < 5; i++) {
            const s = this.sprite(i < 3 ? 0xff7a1f : 0xffc04a, 1.1 + (i % 3) * 0.35);
            s.position.set(at.x + (i - 2) * 0.35, at.top + 0.4 + (i % 2) * 0.3, at.z + ((i * 7) % 3) * 0.2 - 0.2);
            this.animated.push({ obj: s, base: s.scale.x, speed: 9 + i * 2.3, phase: i * 1.7, kind: "flame" });
          }
          {
            const halo = this.sprite(0xff5a14, Math.max(at.w, at.h) * 1.4);
            halo.position.set(at.x, at.top * 0.6 + 0.3, at.z);
            this.animated.push({ obj: halo, base: halo.scale.x, speed: 4, phase: 0.3, kind: "flame" });
          }
          break;
        case "festival": {
          if (!at) break;
          const n = 28;
          for (let i = 0; i < n; i++) {
            const t = i / n;
            const side = Math.floor(t * 4);
            const f = (t * 4) % 1;
            const x0 = at.x - at.w / 2 + 0.3;
            const x1 = at.x + at.w / 2 - 0.3;
            const z0 = at.z - at.h / 2 + 0.3;
            const z1 = at.z + at.h / 2 - 0.3;
            const x = side === 0 ? x0 + (x1 - x0) * f : side === 1 ? x1 : side === 2 ? x1 - (x1 - x0) * f : x0;
            const z = side === 0 ? z0 : side === 1 ? z0 + (z1 - z0) * f : side === 2 ? z1 : z1 - (z1 - z0) * f;
            const s = this.sprite(DISCO[i % DISCO.length], 0.55);
            s.position.set(x, 1.5 + Math.sin(f * Math.PI) * 0.35, z);
            this.animated.push({ obj: s, base: 0.55, speed: 3 + (i % 5), phase: i, kind: "twinkle" });
          }
          break;
        }
        case "party": {
          if (!at) break;
          const s = this.sprite(DISCO[0], 3.2);
          s.position.set(at.x, at.top + 0.8, at.z);
          this.animated.push({ obj: s, base: 3.2, speed: 2.5, phase: 0, kind: "disco" });
          break;
        }
        case "celebrity": {
          if (!at) break;
          for (let i = 0; i < 2; i++) {
            const geo = new ConeGeometry(1.2, 14, 16, 1, true);
            geo.translate(0, 7, 0);
            geo.rotateX(Math.PI);
            geo.translate(0, 14, 0);
            const mat = new MeshBasicMaterial({ color: 0xfff1c4, transparent: true, opacity: 0.16, blending: AdditiveBlending, depthWrite: false });
            const beam = new Mesh(geo, mat);
            beam.position.set(at.x + (i ? 0.8 : -0.8), at.top, at.z);
            this.own(geo, mat);
            this.group.add(beam);
            this.animated.push({ obj: beam, base: 0, speed: 0.9, phase: i * Math.PI, kind: "beam" });
          }
          break;
        }
        case "sculpture": {
          const park = info.get("park");
          if (!park) break;
          const g = new GeoBuilder();
          const a = sculptures * 2.1 + 0.7;
          const px = park.b.x + park.b.w / 2 + Math.cos(a) * (1.2 + sculptures * 0.5);
          const pz = park.b.y + park.b.h / 2 + Math.sin(a) * (1.2 + sculptures * 0.5);
          g.column(px, 0.12, pz, 3.4, 0.16, P.white);
          const geo = g.build();
          const mat = new MeshPhongMaterial({ vertexColors: true, shininess: 60, specular: new Color(0x555566) });
          const mesh = new Mesh(geo, mat);
          mesh.castShadow = mesh.receiveShadow = true;
          this.own(geo, mat);
          this.group.add(mesh);
          sculptures++;
          break;
        }
      }
    }
  }

  /** Animate (flicker, twinkle, sweep) and move the rain with the camera. */
  animate(now: number, dt: number, around: Vector3): void {
    const t = now / 1000;
    this.stormLevel += ((this.stormOn ? 1 : 0) - this.stormLevel) * Math.min(1, dt * 0.8);
    for (const a of this.animated) {
      if (a.kind === "flame") {
        const k = 0.75 + 0.25 * Math.sin(t * a.speed + a.phase) + 0.1 * Math.sin(t * a.speed * 2.3 + a.phase);
        a.obj.scale.set(a.base * k, a.base * k * 1.3, 1);
      } else if (a.kind === "twinkle") {
        const s = a.base * (0.75 + 0.35 * Math.max(0, Math.sin(t * a.speed + a.phase)));
        a.obj.scale.set(s, s, 1);
      } else if (a.kind === "disco") {
        const m = (a.obj as Sprite).material as SpriteMaterial;
        m.color.setHex(DISCO[Math.floor(t * a.speed) % DISCO.length]);
        const s = a.base * (0.85 + 0.15 * Math.sin(t * 6));
        a.obj.scale.set(s, s, 1);
      } else if (a.kind === "beam") {
        a.obj.rotation.set(Math.sin(t * a.speed + a.phase) * 0.35, 0, Math.cos(t * a.speed * 0.8 + a.phase) * 0.35);
      }
    }
    // Rain: a box of falling streaks that follows the camera.
    if (this.stormLevel > 0.02) {
      if (!this.rain) this.makeRain();
      const pos = this.rainPos!;
      const fall = dt * 22;
      for (let i = 0; i < RAIN; i++) {
        const j = i * 6;
        pos[j + 1] -= fall;
        pos[j + 4] -= fall;
        if (pos[j + 4] < 0) {
          const x = around.x + ((i * 7919) % 600) / 10 - 30 + Math.sin(t + i) * 0.5;
          const z = around.z + ((i * 104729) % 600) / 10 - 30;
          const y = 14 + ((i * 31) % 80) / 10;
          pos[j] = x - 0.12;
          pos[j + 1] = y + 0.8;
          pos[j + 2] = z + 0.1;
          pos[j + 3] = x;
          pos[j + 4] = y;
          pos[j + 5] = z;
        }
      }
      this.rain!.geometry.getAttribute("position").needsUpdate = true;
      (this.rain!.material as LineBasicMaterial).opacity = 0.7 * this.stormLevel;
      this.rain!.visible = true;
    } else if (this.rain) {
      this.rain.visible = false;
    }
  }

  private makeRain(): void {
    this.rainPos = new Float32Array(RAIN * 6);
    for (let i = 0; i < RAIN; i++) this.rainPos[i * 6 + 4] = -1; // respawn on the first frame
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(this.rainPos, 3));
    const mat = new LineBasicMaterial({ color: 0xeef2ff, transparent: true, opacity: 0, depthWrite: false });
    this.rain = new LineSegments(geo, mat);
    this.rain.frustumCulled = false;
    this.group.add(this.rain);
  }

  private sprite(color: number, size: number): Sprite {
    const mat = new SpriteMaterial({ map: this.tex, color: this.col.setHex(color), blending: AdditiveBlending, depthWrite: false, transparent: true, fog: false });
    const s = new Sprite(mat);
    s.scale.set(size, size, 1);
    this.own(undefined, mat);
    this.group.add(s);
    return s;
  }

  private own(geo?: BufferGeometry, mat?: Material): void {
    this.owned.push({ geo, mat });
  }

  private clear(): void {
    for (const o of this.owned) {
      o.geo?.dispose();
      o.mat?.dispose();
    }
    this.owned.length = 0;
    this.animated = [];
    for (const child of [...this.group.children]) if (child !== this.rain) this.group.remove(child);
  }

  dispose(): void {
    this.clear();
    if (this.rain) {
      this.rain.geometry.dispose();
      (this.rain.material as Material).dispose();
    }
    this.tex.dispose();
  }
}
