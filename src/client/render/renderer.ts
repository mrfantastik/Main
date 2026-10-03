import { MS_PER_GAME_MINUTE, type BubbleDTO, type FrameMsg } from "../../shared/protocol";
import type { ActivityKind, Building, CityMap } from "../../sim/types";
import { store } from "../net/store";
import { Camera, TILE } from "./camera";
import { drawCityLayer, lampPositions } from "./cityLayer";

// Draws the live city every animation frame. Citizen positions are
// interpolated between server frames using *game time*, so motion is smooth
// at every simulation speed.

const ACTIVITY_ICON: Partial<Record<ActivityKind, string>> = {
  sleep: "💤",
  work: "💼",
  eat: "🍽️",
  shop: "🛍️",
  socialize: "🍻",
  talk: "💬",
  rest: "🌿",
  bank: "🏦",
  browse: "🔎",
  trade: "📈",
  research: "🔬",
  restock: "📦",
  job_hunt: "📄",
  manage: "🧾",
  meet: "🤝",
};

const KIND_COLORS: Record<string, string> = {
  shop: "#f59e2c",
  stall: "#2fbf71",
  cafe: "#e5484d",
  agency: "#a46cf5",
};

interface Pos {
  x: number;
  y: number;
  kind: ActivityKind;
  inside: string | null;
}

export class Renderer {
  cam = new Camera();
  private ctx: CanvasRenderingContext2D;
  private city: HTMLCanvasElement | null = null;
  private map: CityMap | null = null;
  private lamps: { x: number; y: number }[] = [];
  private buildingIndex = new Map<string, Building>();
  private light: HTMLCanvasElement = document.createElement("canvas");
  private clientT = 0;
  private lastNow = performance.now();
  private positions = new Map<string, Pos>();
  private dragging: { x: number; y: number; camX: number; camY: number; moved: boolean } | null = null;
  private hover: string | null = null;
  private raf = 0;
  private fitted = false;
  private popups: { x: number; y: number; text: string; born: number }[] = [];
  private lastFx: unknown = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.attachInput();
  }

  setMap(map: CityMap) {
    this.map = map;
    this.city = drawCityLayer(map);
    this.lamps = lampPositions(map);
    this.buildingIndex = new Map(map.buildings.map((b) => [b.id, b]));
    this.fitted = false;
  }

  start() {
    const loop = (now: number) => {
      this.draw(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  // ------------------------------------------------------------ input

  private attachInput() {
    const c = this.canvas;
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.cam.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    c.addEventListener("pointerdown", (e) => {
      this.dragging = { x: e.clientX, y: e.clientY, camX: this.cam.x, camY: this.cam.y, moved: false };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", (e) => {
      const r = c.getBoundingClientRect();
      if (this.dragging) {
        const dx = e.clientX - this.dragging.x;
        const dy = e.clientY - this.dragging.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) this.dragging.moved = true;
        if (this.dragging.moved) {
          this.cam.x = this.dragging.camX - dx / this.cam.scale;
          this.cam.y = this.dragging.camY - dy / this.cam.scale;
          store.setFollow(false);
        }
      }
      this.hover = this.citizenAt(e.clientX - r.left, e.clientY - r.top);
      c.style.cursor = this.dragging?.moved ? "grabbing" : this.hover ? "pointer" : "grab";
    });
    c.addEventListener("pointerup", (e) => {
      const d = this.dragging;
      this.dragging = null;
      if (d && !d.moved) {
        const r = c.getBoundingClientRect();
        this.click(e.clientX - r.left, e.clientY - r.top);
      }
    });
    window.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "SELECT") return;
      const step = 40 / this.cam.scale;
      if (e.key === "ArrowLeft" || e.key === "a") this.cam.x -= step;
      if (e.key === "ArrowRight" || e.key === "d") this.cam.x += step;
      if (e.key === "ArrowUp" || e.key === "w") this.cam.y -= step;
      if (e.key === "ArrowDown" || e.key === "s") this.cam.y += step;
      if (e.key === "+" || e.key === "=") this.cam.zoomAt(this.cam.width / 2, this.cam.height / 2, 1.2);
      if (e.key === "-") this.cam.zoomAt(this.cam.width / 2, this.cam.height / 2, 1 / 1.2);
    });
  }

  private citizenAt(sx: number, sy: number): string | null {
    let best: string | null = null;
    let bestD = 14;
    for (const [id, p] of this.positions) {
      const s = this.cam.worldToScreen(p.x, p.y);
      const d = Math.hypot(s.x - sx, s.y - sy) + (p.inside ? 7 : -4);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  private click(sx: number, sy: number) {
    const cid = this.citizenAt(sx, sy);
    if (cid) {
      store.select({ kind: "citizen", id: cid });
      return;
    }
    const w = this.cam.screenToWorld(sx, sy);
    const st = store.s.state;
    for (const b of this.map?.buildings ?? []) {
      if (w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h) {
        // Shops hold one business; the marketplace and cowork hold several:
        // clicking again moves on to the next one there.
        const here = st?.businesses.filter((x) => x.open && x.buildingId === b.id) ?? [];
        if (here.length) {
          const sel = store.s.selection;
          const i = sel?.kind === "business" ? here.findIndex((x) => x.id === sel.id) : -1;
          store.select({ kind: "business", id: here[(i + 1) % here.length].id });
          return;
        }
      }
    }
    store.select(null);
  }

  focusOn(x: number, y: number) {
    this.cam.x = x;
    this.cam.y = y;
    if (this.cam.zoom < 1.2) this.cam.zoom = 1.6;
  }

  positionOf(id: string): Pos | undefined {
    return this.positions.get(id);
  }

  // ------------------------------------------------------- interpolation

  private updatePositions(now: number) {
    const frames = store.frames;
    if (frames.length === 0) return;
    const latest = frames[frames.length - 1];
    const rate = latest.paused ? 0 : latest.speed / MS_PER_GAME_MINUTE; // game minutes per ms
    const dt = Math.min(100, now - this.lastNow);
    this.lastNow = now;
    const target = latest.t + Math.min((now - store.lastFrameAt) * rate, rate * 250);
    if (Math.abs(target - this.clientT) > 30 + rate * 1000) this.clientT = target;
    else this.clientT += dt * rate + (target - this.clientT) * 0.08;
    const delay = latest.paused ? 0 : rate * 160 + 1;
    const rt = Math.min(this.clientT - delay, latest.t);

    let a: FrameMsg = frames[0];
    let b: FrameMsg | null = null;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].t <= rt) a = frames[i];
      else {
        b = frames[i];
        break;
      }
    }
    const f = b && b.t > a.t ? Math.min(1, Math.max(0, (rt - a.t) / (b.t - a.t))) : 0;
    const bMap = new Map<string, FrameMsg["c"][number]>();
    if (b) for (const row of b.c) bMap.set(row[0], row);
    this.positions.clear();
    for (const row of a.c) {
      const nb = bMap.get(row[0]);
      const jump = nb ? Math.hypot(nb[1] - row[1], nb[2] - row[2]) : 0;
      const useNext = nb && jump < 40;
      this.positions.set(row[0], {
        x: useNext ? row[1] + (nb![1] - row[1]) * f : row[1],
        y: useNext ? row[2] + (nb![2] - row[2]) * f : row[2],
        kind: f > 0.5 && nb ? nb[3] : row[3],
        inside: f > 0.5 && nb ? nb[4] : row[4],
      });
    }
  }

  get gameTime(): number {
    return this.clientT;
  }

  // ------------------------------------------------------------- drawing

  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.light.width = w;
      this.light.height = h;
    }
    this.cam.width = r.width;
    this.cam.height = r.height;
    if (!this.fitted && this.map && r.width > 10) {
      this.cam.fit(this.map.width, this.map.height);
      this.fitted = true;
    }
  }

  private draw(now: number) {
    this.resize();
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#1b2430";
    ctx.fillRect(0, 0, this.cam.width, this.cam.height);
    if (!this.city || !this.map) return;
    this.updatePositions(now);

    const sel = store.s.selection;
    if (store.s.followSelected && sel?.kind === "citizen") {
      const p = this.positions.get(sel.id);
      if (p) {
        this.cam.x += (p.x - this.cam.x) * 0.12;
        this.cam.y += (p.y - this.cam.y) * 0.12;
      }
    }
    this.cam.clamp(this.map.width, this.map.height);

    const s = this.cam.scale;
    const origin = this.cam.worldToScreen(0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.city, origin.x, origin.y, this.map.width * s, this.map.height * s);

    this.drawBusinesses(ctx);
    this.drawCitizens(ctx);
    this.drawNight(ctx);
    this.drawLabels(ctx);
    this.drawMoney(ctx, now);
    this.drawBubbles(ctx);
  }

  /** Floating "+£5" where money lands — makes the economy visible. */
  private drawMoney(ctx: CanvasRenderingContext2D, now: number) {
    const st = store.s.state;
    if (st && st.fx !== this.lastFx) {
      this.lastFx = st.fx;
      for (const f of st.fx.slice(0, 12)) {
        this.popups.push({ x: f.x + (Math.random() - 0.5) * 0.8, y: f.y, text: `+£${f.amount >= 100 ? Math.round(f.amount) : f.amount.toFixed(f.amount % 1 ? 2 : 0)}`, born: now + Math.random() * 400 });
      }
      if (this.popups.length > 60) this.popups.splice(0, this.popups.length - 60);
    }
    const life = 1600;
    this.popups = this.popups.filter((p) => now - p.born < life);
    if (this.cam.scale < 12) return;
    ctx.font = "bold 12px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const p of this.popups) {
      const age = (now - p.born) / life;
      if (age < 0) continue;
      const s = this.cam.worldToScreen(p.x, p.y);
      const y = s.y - 10 - age * 30;
      ctx.globalAlpha = Math.max(0, 1 - age);
      ctx.fillStyle = "rgba(10,20,15,0.6)";
      ctx.fillText(p.text, s.x + 1, y + 1);
      ctx.fillStyle = "#5ee08f";
      ctx.fillText(p.text, s.x, y);
    }
    ctx.globalAlpha = 1;
  }

  private drawBusinesses(ctx: CanvasRenderingContext2D) {
    const st = store.s.state;
    if (!st) return;
    const s = this.cam.scale;
    const sel = store.s.selection;
    const products = new Map(st.market.map((m) => [m.id, m]));
    const stallCount = new Map<string, number>();
    for (const biz of st.businesses) {
      if (!biz.open) continue;
      const b = this.buildingIndex.get(biz.buildingId);
      if (!b) continue;
      const color = KIND_COLORS[biz.kind] ?? "#888";
      if (b.type === "shop_unit") {
        const p = this.cam.worldToScreen(b.x, b.y);
        const doorBelow = b.door.y >= b.y + b.h;
        const ay = doorBelow ? p.y + b.h * s - s * 0.7 : p.y;
        ctx.fillStyle = color;
        ctx.fillRect(p.x + s * 0.08, ay, b.w * s - s * 0.16, s * 0.7);
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        for (let k = 0; k < 6; k++) ctx.fillRect(p.x + s * 0.08 + (k * (b.w * s - s * 0.16)) / 6, ay, (b.w * s - s * 0.16) / 12, s * 0.7);
        const emoji = biz.products.map((pid) => products.get(pid)?.emoji ?? "").join("");
        ctx.font = `${Math.max(10, s * 0.75)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(emoji, p.x + (b.w * s) / 2, p.y + (b.h * s) / 2 - (doorBelow ? s * 0.3 : -s * 0.3));
        if (sel?.kind === "business" && sel.id === biz.id) {
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 3;
          ctx.strokeRect(p.x - 2, p.y - 2, b.w * s + 4, b.h * s + 4);
        }
      } else if (b.type === "market") {
        // Stalls: small coloured markers around the market plaza edge.
        const i = stallCount.get(b.id) ?? 0;
        stallCount.set(b.id, i + 1);
        const col = i % 4;
        const row = Math.floor(i / 4);
        const p = this.cam.worldToScreen(b.x + 0.4 + col * 1.9, b.y + b.h - 1.3 - row * 1.1);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(p.x, p.y, s * 1.6, s * 0.9, 3);
        ctx.fill();
        ctx.font = `${Math.max(9, s * 0.55)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(biz.products.map((pid) => products.get(pid)?.emoji ?? "").join(""), p.x + s * 0.8, p.y + s * 0.45);
      } else if (b.type === "cowork" || b.type === "office") {
        // Agencies: a badge on the building.
        const n = stallCount.get(b.id) ?? 0;
        stallCount.set(b.id, n + 1);
        const p = this.cam.worldToScreen(b.x + 0.3, b.y + 0.3 + n * 0.9);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(p.x, p.y, Math.max(40, b.w * s - 0.6 * s), s * 0.75, 4);
        ctx.fill();
        if (s > 22) {
          ctx.fillStyle = "#fff";
          ctx.font = `bold ${Math.max(9, s * 0.36)}px sans-serif`;
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(biz.name, p.x + 4, p.y + s * 0.38, b.w * s - s);
        }
      }
    }
  }

  private drawCitizens(ctx: CanvasRenderingContext2D) {
    const st = store.s.state;
    if (!st) return;
    const s = this.cam.scale;
    const sel = store.s.selection;
    const meta = new Map(st.citizens.map((c) => [c.id, c]));
    const occColor: Record<string, string> = {
      unemployed: "#9aa3ad",
      employee: "#4f8ef7",
      freelancer: "#a46cf5",
      shopkeeper: "#f59e2c",
      reseller: "#2fbf71",
      trader: "#e5484d",
      entrepreneur: "#f2c94c",
      researcher: "#22c3d6",
    };
    // Draw indoor citizens first (smaller), walkers on top.
    const entries = [...this.positions.entries()].sort((a, b) => (a[1].inside ? 0 : 1) - (b[1].inside ? 0 : 1));
    for (const [id, p] of entries) {
      const m = meta.get(id);
      if (!m) continue;
      const b = p.inside ? this.buildingIndex.get(p.inside) : undefined;
      if (b && (b.type === "house" || b.type === "apartments") && !(sel?.kind === "citizen" && sel.id === id)) {
        continue; // private homes: shown as lit windows instead
      }
      const sp = this.cam.worldToScreen(p.x, p.y);
      const r = Math.max(3.5, s * (p.inside ? 0.24 : 0.3));
      const isSel = sel?.kind === "citizen" && sel.id === id;
      if (isSel) {
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r * 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.beginPath();
      ctx.ellipse(sp.x + r * 0.2, sp.y + r * 0.7, r, r * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = occColor[m.occupation] ?? "#999";
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y - r * 0.15, r * 0.55, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = isSel ? "#fff" : "rgba(20,20,30,0.7)";
      ctx.lineWidth = isSel ? 2.5 : 1.2;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
      ctx.stroke();
      const showIcon = s > 26 || isSel || this.hover === id;
      if (showIcon) {
        const icon = ACTIVITY_ICON[p.kind];
        if (icon) {
          ctx.font = `${Math.max(10, r * 1.4)}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.fillText(icon, sp.x + r * 1.1, sp.y - r * 0.6);
        }
      }
      if (isSel || this.hover === id || s > 44) {
        this.label(ctx, m.name, sp.x, sp.y + r + 3, isSel ? "#fff" : "rgba(255,255,255,0.9)");
      }
    }
  }

  private label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, maxWidth = Infinity) {
    ctx.font = "600 11px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    // Keep names inside their building so neighbours' labels don't collide.
    if (ctx.measureText(text).width + 8 > maxWidth) {
      if (maxWidth < 34) return;
      let t = text;
      while (t.length > 1 && ctx.measureText(`${t}…`).width + 8 > maxWidth) t = t.slice(0, -1);
      text = `${t.trimEnd()}…`;
    }
    const w = ctx.measureText(text).width + 8;
    ctx.fillStyle = "rgba(15,20,30,0.72)";
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y, w, 15, 4);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(text, x, y + 2);
  }

  private darkness(): number {
    const h = (((this.clientT % 1440) + 1440) % 1440) / 60;
    if (h < 5) return 0.62;
    if (h < 7.5) return 0.62 * (7.5 - h) / 2.5;
    if (h < 18) return 0;
    if (h < 21) return (0.62 * (h - 18)) / 3;
    return 0.62;
  }

  private drawNight(ctx: CanvasRenderingContext2D) {
    const dark = this.darkness();
    if (dark <= 0.01 || !this.map) return;
    const dpr = window.devicePixelRatio || 1;
    const lc = this.light.getContext("2d")!;
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.globalCompositeOperation = "source-over";
    lc.clearRect(0, 0, this.light.width, this.light.height);
    lc.fillStyle = `rgba(8,12,38,${dark})`;
    lc.fillRect(0, 0, this.light.width, this.light.height);
    lc.setTransform(dpr, 0, 0, dpr, 0, 0);
    lc.globalCompositeOperation = "destination-out";
    const s = this.cam.scale;
    const hole = (wx: number, wy: number, radius: number, strength: number) => {
      const p = this.cam.worldToScreen(wx, wy);
      if (p.x < -radius || p.y < -radius || p.x > this.cam.width + radius || p.y > this.cam.height + radius) return;
      const g = lc.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
      g.addColorStop(0, `rgba(0,0,0,${strength})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      lc.fillStyle = g;
      lc.beginPath();
      lc.arc(p.x, p.y, radius, 0, Math.PI * 2);
      lc.fill();
    };
    for (const l of this.lamps) hole(l.x, l.y, s * 2.6, 0.75);
    // Lit buildings: anywhere someone is inside and awake, plus venues.
    const occupied = new Map<string, number>();
    for (const p of this.positions.values()) {
      if (p.inside && p.kind !== "sleep") occupied.set(p.inside, (occupied.get(p.inside) ?? 0) + 1);
    }
    const glows: { x: number; y: number; r: number }[] = [];
    for (const b of this.map.buildings) {
      const n = occupied.get(b.id) ?? 0;
      const venue = b.type === "pub" || b.type === "diner";
      if (n === 0 && !venue) continue;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const radius = s * Math.max(b.w, b.h) * 0.75;
      hole(cx, cy, radius, venue ? 0.85 : 0.65);
      glows.push({ x: cx, y: cy, r: radius * 0.6 });
    }
    ctx.drawImage(this.light, 0, 0, this.cam.width, this.cam.height);
    ctx.globalCompositeOperation = "lighter";
    for (const g of glows) {
      const p = this.cam.worldToScreen(g.x, g.y);
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, g.r);
      grad.addColorStop(0, `rgba(255,190,90,${0.22 * dark})`);
      grad.addColorStop(1, "rgba(255,190,90,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, g.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  private drawLabels(ctx: CanvasRenderingContext2D) {
    if (!this.map || this.cam.scale < 14) return;
    const major = new Set(["office", "market", "park", "bank", "townhall", "pub", "diner", "cowork", "lab", "depot", "apartments"]);
    const st = store.s.state;
    for (const b of this.map.buildings) {
      let name: string | null = null;
      if (major.has(b.type)) {
        if (b.id === "park2") continue;
        name = b.name;
      } else if (b.type === "shop_unit") {
        const biz = st?.businesses.find((x) => x.open && x.buildingId === b.id);
        name = biz ? biz.name : this.cam.scale > 26 ? "To let" : null;
      }
      if (!name) continue;
      const p = this.cam.worldToScreen(b.x + b.w / 2, b.y);
      this.label(ctx, name, p.x, p.y - 17, "#ffe9b0", (b.w + 1.6) * this.cam.scale);
    }
  }

  private drawBubbles(ctx: CanvasRenderingContext2D) {
    const st = store.s.state;
    if (!st) return;
    const placed: { x: number; y: number }[] = [];
    for (const bub of st.bubbles) this.bubble(ctx, bub, placed);
  }

  private bubble(ctx: CanvasRenderingContext2D, bub: BubbleDTO, placed: { x: number; y: number }[]) {
    const p = this.positions.get(bub.speaker);
    if (!p) return;
    const sp = this.cam.worldToScreen(p.x, p.y);
    if (sp.x < -100 || sp.y < -100 || sp.x > this.cam.width + 100 || sp.y > this.cam.height + 100) return;
    ctx.font = "12px Inter, system-ui, sans-serif";
    const maxW = 190;
    const words = bub.text.split(" ");
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(next).width > maxW && cur) {
        lines.push(cur);
        cur = w;
      } else cur = next;
    }
    if (cur) lines.push(cur);
    const shown = lines.slice(0, 4);
    if (lines.length > 4) shown[3] = `${shown[3].slice(0, 24)}…`;
    const w = Math.min(maxW, Math.max(...shown.map((l) => ctx.measureText(l).width))) + 16;
    const h = shown.length * 15 + 10;
    let x = sp.x - w / 2;
    let y = sp.y - h - 16;
    for (const q of placed) {
      if (Math.abs(q.x - x) < w && Math.abs(q.y - y) < h) y = q.y - h - 6;
    }
    placed.push({ x, y });
    x = Math.max(4, Math.min(this.cam.width - w - 4, x));
    ctx.fillStyle = bub.source === "llm" ? "rgba(255,248,225,0.97)" : "rgba(255,255,255,0.95)";
    ctx.strokeStyle = bub.source === "llm" ? "#d4a017" : "rgba(30,30,40,0.5)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 8);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sp.x - 5, y + h);
    ctx.lineTo(sp.x, y + h + 8);
    ctx.lineTo(sp.x + 5, y + h);
    ctx.fill();
    ctx.fillStyle = "#1a1f2b";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    shown.forEach((l, i) => ctx.fillText(l, x + 8, y + 6 + i * 15));
  }
}

export const TILE_PX = TILE;
