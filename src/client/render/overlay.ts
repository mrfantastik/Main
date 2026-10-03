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

/**
 * A speech bubble pointing at (sx, sy). `placed` collects bubbles already
 * drawn this frame so they stack instead of overlapping.
 */
export function drawBubble(ctx: CanvasRenderingContext2D, bub: BubbleDTO, sx: number, sy: number, viewW: number, placed: { x: number; y: number }[]): void {
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
  let x = sx - w / 2;
  let y = sy - h - 16;
  for (const q of placed) {
    if (Math.abs(q.x - x) < w && Math.abs(q.y - y) < h) y = q.y - h - 6;
  }
  placed.push({ x, y });
  x = Math.max(4, Math.min(viewW - w - 4, x));
  ctx.fillStyle = bub.source === "llm" ? "rgba(255,248,225,0.97)" : "rgba(255,255,255,0.95)";
  ctx.strokeStyle = bub.source === "llm" ? "#d4a017" : "rgba(30,30,40,0.5)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 8);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sx - 5, y + h);
  ctx.lineTo(sx, y + h + 8);
  ctx.lineTo(sx + 5, y + h);
  ctx.fill();
  ctx.fillStyle = "#1a1f2b";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  shown.forEach((l, i) => ctx.fillText(l, x + 8, y + 6 + i * 15));
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
