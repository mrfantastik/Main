// Public entry point of the simulation package. The server, the headless
// runner and tests only talk to the simulation through this module.

import { initEngine } from "./engine";
import { setupStartingEconomy } from "./setup";
import type { WorldState } from "./types";
import { createWorld } from "./world";

export { advance, step } from "./engine";
export type { WorldState } from "./types";

/** Create a brand-new world from a seed, ready to run. */
export function newWorld(seed: number, name?: string): WorldState {
  initEngine();
  const world = createWorld(seed, name);
  setupStartingEconomy(world);
  return world;
}
