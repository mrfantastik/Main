import type { BubbleDTO } from "../../shared/protocol";
import type { ActivityKind } from "../../sim/types";

// Text drawn over the city (names, speech bubbles, money, icons). Shared by
// the 2D and 3D views so both read the same.

export const ACTIVITY_ICON: Partial<Record<ActivityKind, string>> = {
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

export const KIND_COLORS: Record<string, string> = {
  shop: "#f59e2c",
  stall: "#2fbf71",
  cafe: "#e5484d",
  agency: "#a46cf5",
};

/** A small dark name plate. maxWidth shortens the text with "…" to fit. */
export function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, maxWidth = Infinity): void {
  ctx.font = "600 11px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
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

/** Floating "+£5" text, fading as it rises. age is 0..1. */
export function drawMoneyPopup(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, age: number): void {
  ctx.font = "bold 12px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const yy = y - 10 - age * 30;
  ctx.globalAlpha = Math.max(0, 1 - age);
  ctx.fillStyle = "rgba(10,20,15,0.6)";
  ctx.fillText(text, x + 1, yy + 1);
  ctx.fillStyle = "#5ee08f";
  ctx.fillText(text, x, yy);
  ctx.globalAlpha = 1;
}

export function moneyText(amount: number): string {
  return `+£${amount >= 100 ? Math.round(amount) : amount.toFixed(amount % 1 ? 2 : 0)}`;
}

const inkCache = new Map<string, string>();

/** A citizen's colour, darkened if needed so their name reads on a white bubble. */
export function bubbleInk(hex: string): string {
  let ink = inkCache.get(hex);
  if (ink) return ink;
  const n = parseInt(hex.replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  let [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const k = lum > 0.45 ? 0.45 / lum : 1;
  [r, g, b] = [r, g, b].map((v) => Math.round(v * k));
  ink = `rgb(${r},${g},${b})`;
  inkCache.set(hex, ink);
  return ink;
}

/**
 * A speech bubble pointing at (sx, sy), with the speaker's name in their
 * colour when it's known. `placed` collects bubbles already drawn this
 * frame so they stack instead of overlapping.
 */
export function drawBubble(ctx: CanvasRenderingContext2D, bub: BubbleDTO, sx: number, sy: number, viewW: number, placed: { x: number; y: number }[], who?: { name: string; color: string }): void {
  ctx.font = "12px Inter, system-ui, sans-serif";
  const maxW = 200;
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
  const head = who ? 14 : 0;
  ctx.font = "800 10px Inter, system-ui, sans-serif";
  const nameW = who ? ctx.measureText(who.name).width : 0;
  ctx.font = "12px Inter, system-ui, sans-serif";
  const w = Math.min(maxW, Math.max(nameW, ...shown.map((l) => ctx.measureText(l).width))) + 18;
  const h = shown.length * 15 + 11 + head;
  let x = sx - w / 2;
  let y = sy - h - 16;
  for (const q of placed) {
    if (Math.abs(q.x - x) < w && Math.abs(q.y - y) < h) y = q.y - h - 6;
  }
  placed.push({ x, y });
  x = Math.max(4, Math.min(viewW - w - 4, x));
  const llm = bub.source === "llm";
  ctx.save();
  ctx.shadowColor = "rgba(20, 10, 40, 0.28)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = llm ? "rgba(255,249,232,0.97)" : "rgba(255,255,255,0.96)";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 10);
  ctx.moveTo(sx - 6, y + h - 0.5);
  ctx.lineTo(sx, y + h + 8);
  ctx.lineTo(sx + 6, y + h - 0.5);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = llm ? "#d4a017" : who ? who.color : "rgba(30,30,40,0.45)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 10);
  ctx.stroke();
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  if (who) {
    ctx.font = "800 10px Inter, system-ui, sans-serif";
    ctx.fillStyle = who.color;
    ctx.fillText(who.name, x + 9, y + 6);
    ctx.font = "12px Inter, system-ui, sans-serif";
  }
  ctx.fillStyle = "#1a1f2b";
  shown.forEach((l, i) => ctx.fillText(l, x + 9, y + 6 + head + i * 15));
}

/** 0 by day, up to 0.62 at night (same curve in both views). */
export function darkness(gameT: number): number {
  const h = (((gameT % 1440) + 1440) % 1440) / 60;
  if (h < 5) return 0.62;
  if (h < 7.5) return (0.62 * (7.5 - h)) / 2.5;
  if (h < 18) return 0;
  if (h < 21) return (0.62 * (h - 18)) / 3;
  return 0.62;
}

/**
 * Feelings strong enough to show next to someone on the map. Most people are
 * content most of the time, so joy and love only show when they're intense;
 * the badges are there to make the unusual feelings stand out.
 */
export function showFeelingOnMap(e: { kind: string; level: number }): boolean {
  return e.level >= (e.kind === "joy" || e.kind === "love" ? 72 : 55);
}

/** Small emoji badge for a strong feeling, drawn beside a citizen. */
export function drawEmotion(ctx: CanvasRenderingContext2D, emoji: string, x: number, y: number, size: number): void {
  ctx.font = `${size}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, x, y);
}
