import { MS_PER_GAME_MINUTE, type FrameMsg } from "../../shared/protocol";
import { store } from "../net/store";
import type { Pos } from "./types";

type Row = FrameMsg["c"][number];

interface Slot extends Pos {
  /** Frame counter when this citizen was last seen (stale slots are dropped). */
  seen: number;
}

/**
 * Turns the server's position frames (10/s) into smooth per-frame positions.
 * Interpolates on *game time*, so motion is smooth at every simulation speed.
 * Positions are updated in place: no allocations per animation frame.
 */
export class FrameInterpolator {
  readonly positions = new Map<string, Slot>();
  private clientT = 0;
  private lastNow = performance.now();
  private tick = 0;
  private nextIndexFor: FrameMsg | null = null;
  private nextIndex = new Map<string, Row>();

  get gameTime(): number {
    return this.clientT;
  }

  update(now: number): void {
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
    if (b !== this.nextIndexFor) {
      this.nextIndexFor = b;
      this.nextIndex.clear();
      if (b) for (const row of b.c) this.nextIndex.set(row[0], row);
    }
    const tick = ++this.tick;
    for (const row of a.c) {
      const nb = b ? this.nextIndex.get(row[0]) : undefined;
      const jump = nb ? Math.hypot(nb[1] - row[1], nb[2] - row[2]) : 0;
      const useNext = nb !== undefined && jump < 40;
      let slot = this.positions.get(row[0]);
      if (!slot) {
        slot = { x: 0, y: 0, kind: row[3], inside: row[4], seen: tick };
        this.positions.set(row[0], slot);
      }
      slot.x = useNext ? row[1] + (nb[1] - row[1]) * f : row[1];
      slot.y = useNext ? row[2] + (nb[2] - row[2]) * f : row[2];
      slot.kind = f > 0.5 && nb ? nb[3] : row[3];
      slot.inside = f > 0.5 && nb ? nb[4] : row[4];
      slot.seen = tick;
    }
    if (this.positions.size > a.c.length) {
      for (const [id, slot] of this.positions) if (slot.seen !== tick) this.positions.delete(id);
    }
  }
}
