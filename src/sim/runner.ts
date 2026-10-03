import { MAX_SKIP_MINUTES, MS_PER_GAME_MINUTE, SPEEDS } from "../shared/protocol";
import { step } from "./engine";
import type { WorldState } from "./types";

/**
 * Runs the simulation in real time. Game time advances in fixed 1-minute
 * steps (so results are deterministic regardless of frame rate); the speed
 * setting just changes how many steps run per real second.
 */
export class SimRunner {
  speed = 1;
  paused = false;
  private acc = 0;
  private last = performance.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Called after each batch of steps (used by the AI director). */
  afterSteps: ((world: WorldState) => void) | null = null;

  constructor(public world: WorldState) {}

  start(): void {
    if (this.timer) return;
    this.last = performance.now();
    this.timer = setInterval(() => this.loop(), 20);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Jump ahead instantly. Runs the same fixed steps as normal play (so the
   * outcome is identical to watching it), with Claude paused meanwhile so a
   * skip never burns API budget. Returns how many events happened.
   */
  skip(minutes: number): number {
    const n = Math.max(1, Math.min(MAX_SKIP_MINUTES, Math.round(minutes)));
    const before = this.world.events[this.world.events.length - 1]?.id ?? 0;
    const mode = this.world.ai.mode;
    this.world.ai.mode = "off";
    try {
      for (let i = 0; i < n; i++) step(this.world);
    } finally {
      this.world.ai.mode = mode;
    }
    this.acc = 0;
    this.afterSteps?.(this.world);
    return this.world.events.filter((e) => e.id > before).length;
  }

  setSpeed(speed: number): void {
    if ((SPEEDS as readonly number[]).includes(speed)) this.speed = speed;
  }

  private loop(): void {
    const now = performance.now();
    const dt = now - this.last;
    this.last = now;
    if (this.paused) {
      this.acc = 0;
      return;
    }
    this.acc += (dt * this.speed) / MS_PER_GAME_MINUTE;
    let steps = Math.floor(this.acc);
    if (steps > 400) {
      // Server fell behind (e.g. laptop asleep): don't try to catch up.
      steps = 400;
      this.acc = 0;
    } else {
      this.acc -= steps;
    }
    for (let i = 0; i < steps; i++) step(this.world);
    if (steps > 0) this.afterSteps?.(this.world);
  }
}
