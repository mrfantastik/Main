import { MS_PER_GAME_MINUTE, SPEEDS } from "../shared/protocol";
import { step } from "../sim/engine";
import type { WorldState } from "../sim/types";

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
  private timer: NodeJS.Timeout | null = null;
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
