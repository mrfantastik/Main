import type { Building, CityMap } from "../../sim/types";
import { TILE_ROAD } from "../../sim/types";
import { TILE } from "./camera";

// Pre-renders the static city (ground, roads, buildings) once into an
// off-screen canvas. Simple shapes, but deliberately cheerful.

const T = TILE;

function hash(x: number, y: number, s = 0): number {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

function tree(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, seed: number) {
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.beginPath();
  ctx.ellipse(cx + r * 0.25, cy + r * 0.35, r, r * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();
  const greens = ["#2f7d3b", "#3b8f45", "#2a6e35", "#4a9a4f"];
  ctx.fillStyle = greens[Math.floor(seed * greens.length)];
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.14)";
  ctx.beginPath();
  ctx.arc(cx - r * 0.3, cy - r * 0.3, r * 0.45, 0, Math.PI * 2);
  ctx.fill();
}

function windows(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, gap = 10, size = 5) {
  ctx.fillStyle = color;
  for (let yy = y + gap / 2; yy < y + h - size; yy += gap) {
    for (let xx = x + gap / 2; xx < x + w - size; xx += gap) ctx.fillRect(xx, yy, size, size);
  }
}

function doorMark(ctx: CanvasRenderingContext2D, b: Building) {
  const doorBelow = b.door.y >= b.y + b.h;
  const dx = (b.door.x + 0.5) * T;
  const y = doorBelow ? (b.y + b.h) * T - 4 : b.y * T;
  rect(ctx, dx - 5, y, 10, 4, "#3a2a1e");
}

const ROOFS = ["#c0504d", "#8c5a3c", "#4f6d8f", "#6b8e4e", "#a0522d", "#7a5c99", "#b5763a"];

function drawBuilding(ctx: CanvasRenderingContext2D, b: Building) {
  const x = b.x * T;
  const y = b.y * T;
  const w = b.w * T;
  const h = b.h * T;
  const s = hash(b.x, b.y, 7);
  // drop shadow
  if (b.type !== "park" && b.type !== "green" && b.type !== "market") {
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(x + 5, y + 6, w - 2, h - 2);
  }
  switch (b.type) {
    case "house": {
      roundRect(ctx, x + 2, y + 2, w - 4, h - 4, 3, "#efe2c6");
      const roof = ROOFS[Math.floor(s * ROOFS.length)];
      roundRect(ctx, x + 4, y + 4, w - 8, h - 8, 2, roof);
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fillRect(x + 4, y + 4, w - 8, (h - 8) / 2);
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 6, y + h / 2);
      ctx.lineTo(x + w - 6, y + h / 2);
      ctx.stroke();
      rect(ctx, x + w * 0.68, y + 8, 8, 10, "#6b4b3a");
      doorMark(ctx, b);
      break;
    }
    case "apartments": {
      roundRect(ctx, x, y, w, h, 4, "#7d8fa6");
      roundRect(ctx, x + 6, y + 6, w - 12, h - 12, 3, "#9aaabd");
      windows(ctx, x + 10, y + 10, w - 20, h - 20, "#dfe8f1", 16, 7);
      doorMark(ctx, b);
      break;
    }
    case "office": {
      roundRect(ctx, x, y, w, h, 4, "#3f6fb8");
      roundRect(ctx, x + 6, y + 6, w - 12, h - 12, 3, "#5b8bd6");
      windows(ctx, x + 8, y + 8, w - 16, h - 16, "#a9c8f5", 14, 9);
      ctx.strokeStyle = "#f2f2f2";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x + w / 2, y + h / 2, 22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#f2f2f2";
      ctx.font = "bold 22px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("H", x + w / 2, y + h / 2 + 1);
      doorMark(ctx, b);
      break;
    }
    case "cowork": {
      roundRect(ctx, x, y, w, h, 4, "#2e8f86");
      for (let i = 0; i < 4; i++) rect(ctx, x + 10, y + 14 + i * 44, w - 20, 22, "#9fe3dc");
      doorMark(ctx, b);
      break;
    }
    case "lab": {
      roundRect(ctx, x, y, w, h, 4, "#d6eef5");
      rect(ctx, x, y + h * 0.3, w, 8, "#22c3d6");
      rect(ctx, x, y + h * 0.65, w, 8, "#22c3d6");
      ctx.fillStyle = "#b8dbe6";
      ctx.beginPath();
      ctx.arc(x + w / 2, y + h * 0.15 + 12, 18, 0, Math.PI * 2);
      ctx.fill();
      doorMark(ctx, b);
      break;
    }
    case "bank": {
      roundRect(ctx, x, y, w, h, 3, "#cfc6b8");
      rect(ctx, x + 4, y + 4, w - 8, 16, "#9d8f7a");
      ctx.fillStyle = "#b3a891";
      for (let i = 0; i < 4; i++) ctx.fillRect(x + 12 + i * ((w - 24) / 3.5), y + h - 70, 8, 60);
      ctx.fillStyle = "#6b5d45";
      ctx.font = "bold 30px serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("£", x + w / 2, y + h * 0.4);
      doorMark(ctx, b);
      break;
    }
    case "townhall": {
      roundRect(ctx, x, y, w, h, 3, "#e0d6c2");
      ctx.fillStyle = "#b8a77f";
      ctx.beginPath();
      ctx.arc(x + w / 2, y + h * 0.4, 26, 0, Math.PI * 2);
      ctx.fill();
      rect(ctx, x + w / 2 - 1, y + 10, 2, 30, "#555");
      rect(ctx, x + w / 2 + 1, y + 10, 16, 10, "#d33");
      doorMark(ctx, b);
      break;
    }
    case "pub": {
      roundRect(ctx, x, y, w, h, 3, "#5a2e22");
      roundRect(ctx, x + 6, y + 6, w - 12, h - 12, 2, "#7b3f2f");
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = 2;
      for (let yy = y + 14; yy < y + h - 8; yy += 12) {
        ctx.beginPath();
        ctx.moveTo(x + 8, yy);
        ctx.lineTo(x + w - 8, yy);
        ctx.stroke();
      }
      ctx.font = "26px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("🍺", x + w / 2, y + h / 2);
      doorMark(ctx, b);
      break;
    }
    case "diner": {
      roundRect(ctx, x, y, w, h, 3, "#f4f1ea");
      for (let i = 0; i < 8; i++) rect(ctx, x + (i * w) / 8, y, w / 16, h, "#e05a4f");
      roundRect(ctx, x + 10, y + h / 2 - 18, w - 20, 36, 6, "#fff");
      ctx.font = "24px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("🍔", x + w / 2, y + h / 2);
      doorMark(ctx, b);
      break;
    }
    case "depot": {
      roundRect(ctx, x, y, w, h, 3, "#8c6239");
      ctx.strokeStyle = "rgba(0,0,0,0.2)";
      ctx.lineWidth = 2;
      for (let xx = x + 6; xx < x + w; xx += 8) {
        ctx.beginPath();
        ctx.moveTo(xx, y + 4);
        ctx.lineTo(xx, y + h - 4);
        ctx.stroke();
      }
      for (let i = 0; i < 5; i++) {
        const cx = x + 14 + hash(i, b.x) * (w - 40);
        const cy = y + 14 + hash(b.y, i) * (h - 40);
        roundRect(ctx, cx, cy, 18, 18, 2, "#c9a26b");
        ctx.strokeStyle = "#7a5530";
        ctx.strokeRect(cx + 2, cy + 2, 14, 14);
      }
      doorMark(ctx, b);
      break;
    }
    case "shop_unit": {
      roundRect(ctx, x + 1, y + 1, w - 2, h - 2, 3, "#d9cbb3");
      roundRect(ctx, x + 5, y + 5, w - 10, h - 10, 2, "#c4b293");
      doorMark(ctx, b);
      break;
    }
    case "market": {
      rect(ctx, x, y, w, h, "#e6d4ac");
      ctx.strokeStyle = "rgba(120,90,50,0.15)";
      ctx.lineWidth = 1;
      for (let i = 0; i <= b.w * 2; i++) {
        ctx.beginPath();
        ctx.moveTo(x + (i * T) / 2, y);
        ctx.lineTo(x + (i * T) / 2, y + h);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y + (i * T) / 2);
        ctx.lineTo(x + w, y + (i * T) / 2);
        ctx.stroke();
      }
      const awnings = ["#e5484d", "#f59e2c", "#2fbf71", "#4f8ef7", "#a46cf5", "#f2c94c"];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const sx = x + 20 + c * 80;
          const sy = y + 22 + r * 78;
          const col = awnings[(r * 3 + c) % awnings.length];
          roundRect(ctx, sx, sy, 50, 34, 3, col);
          for (let k = 0; k < 5; k++) rect(ctx, sx + k * 10, sy, 5, 34, "rgba(255,255,255,0.45)");
        }
      }
      break;
    }
    case "park": {
      rect(ctx, x, y, w, h, "#6db35a");
      ctx.strokeStyle = "#d8c9a3";
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.moveTo(x + w / 2, y);
      ctx.lineTo(x + w / 2, y + h);
      ctx.moveTo(x, y + h / 2);
      ctx.lineTo(x + w, y + h / 2);
      ctx.stroke();
      if (b.id === "park") {
        ctx.fillStyle = "#5fa8d3";
        ctx.beginPath();
        ctx.ellipse(x + w * 0.27, y + h * 0.27, 40, 28, 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.3)";
        ctx.beginPath();
        ctx.ellipse(x + w * 0.24, y + h * 0.24, 14, 6, 0.3, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = "#d8c9a3";
        ctx.beginPath();
        ctx.arc(x + w / 2, y + h / 2, 30, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#5fa8d3";
        ctx.beginPath();
        ctx.arc(x + w / 2, y + h / 2, 14, 0, Math.PI * 2);
        ctx.fill();
      }
      for (let i = 0; i < 14; i++) {
        const tx = x + 12 + hash(i, b.x, 3) * (w - 24);
        const ty = y + 12 + hash(b.y, i, 5) * (h - 24);
        if (Math.abs(tx - (x + w / 2)) < 14 || Math.abs(ty - (y + h / 2)) < 14) continue;
        if (b.id === "park" && tx < x + w * 0.45 && ty < y + h * 0.45) continue;
        tree(ctx, tx, ty, 9 + hash(i, i) * 6, hash(i, b.y));
      }
      break;
    }
    case "green": {
      rect(ctx, x, y, w, h, "#79b866");
      for (let i = 0; i < 20; i++) {
        tree(ctx, x + 10 + hash(i, b.x, 9) * (w - 20), y + 10 + hash(b.y, i, 2) * (h - 20), 8 + hash(i, 3) * 7, hash(i, b.x));
      }
      break;
    }
  }
}

export function drawCityLayer(map: CityMap): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = map.width * T;
  canvas.height = map.height * T;
  const ctx = canvas.getContext("2d")!;
  // grass
  rect(ctx, 0, 0, canvas.width, canvas.height, "#86c06c");
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      for (let k = 0; k < 3; k++) {
        const r = hash(x, y, k);
        ctx.fillStyle = r > 0.5 ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)";
        ctx.fillRect(x * T + hash(y, x, k) * T, y * T + r * T, 3, 3);
      }
    }
  }
  // roads
  const isRoad = (x: number, y: number) => x >= 0 && y >= 0 && x < map.width && y < map.height && map.tiles[y * map.width + x] === TILE_ROAD;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (!isRoad(x, y)) continue;
      rect(ctx, x * T, y * T, T, T, "#4a4f59");
    }
  }
  // kerbs
  ctx.fillStyle = "#b9bec6";
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (!isRoad(x, y)) continue;
      if (!isRoad(x, y - 1) && y > 0) ctx.fillRect(x * T, y * T, T, 3);
      if (!isRoad(x, y + 1) && y < map.height - 1) ctx.fillRect(x * T, y * T + T - 3, T, 3);
      if (!isRoad(x - 1, y) && x > 0) ctx.fillRect(x * T, y * T, 3, T);
      if (!isRoad(x + 1, y) && x < map.width - 1) ctx.fillRect(x * T + T - 3, y * T, 3, T);
    }
  }
  // lane markings
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 10]);
  for (let y = 1; y < map.height; y += 10) {
    for (let x = 0; x < map.width; x++) {
      if (x % 10 < 2) continue;
      ctx.beginPath();
      ctx.moveTo(x * T, y * T);
      ctx.lineTo(x * T + T, y * T);
      ctx.stroke();
    }
  }
  for (let x = 1; x < map.width; x += 10) {
    for (let y = 0; y < map.height; y++) {
      if (y % 10 < 2) continue;
      ctx.beginPath();
      ctx.moveTo(x * T, y * T);
      ctx.lineTo(x * T, y * T + T);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  // zebra crossings near intersections
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  for (let iy = 0; iy < map.height; iy += 10) {
    for (let ix = 0; ix < map.width; ix += 10) {
      for (let k = 0; k < 4; k++) {
        if (ix + 2 < map.width) ctx.fillRect((ix + 2) * T + 3, iy * T + 4 + k * 15, 10, 8);
        if (iy + 2 < map.height) ctx.fillRect(ix * T + 4 + k * 15, (iy + 2) * T + 3, 8, 10);
      }
    }
  }
  for (const b of map.buildings) drawBuilding(ctx, b);
  return canvas;
}

/** Street-lamp positions (tile coords) for the night lighting. */
export function lampPositions(map: CityMap): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < map.height; y += 10) {
    for (let x = 0; x < map.width; x += 10) {
      out.push({ x: x + 1, y: y + 1 });
      if (x + 6 < map.width) out.push({ x: x + 6, y: y + 1 });
      if (y + 6 < map.height) out.push({ x: x + 1, y: y + 6 });
    }
  }
  return out;
}
