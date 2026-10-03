import type { ActivityKind, CityMap } from "../../sim/types";

/** Where a citizen is drawn this frame (tile coordinates). */
export interface Pos {
  x: number;
  y: number;
  kind: ActivityKind;
  inside: string | null;
}

/** What the app needs from a city view (2D canvas or 3D). */
export interface CityRenderer {
  start(): void;
  stop(): void;
  setMap(map: CityMap): void;
  /** Centre the view on a tile position (and zoom in a little). */
  focusOn(x: number, y: number): void;
  positionOf(id: string): Pos | undefined;
  /** Current interpolated game time (minutes). */
  readonly gameTime: number;
  /** CSS-pixel position of a ground point, relative to the canvas. For tests and tools. */
  worldToScreen(x: number, y: number): { x: number; y: number };
  /** Show the whole city. */
  fitView(): void;
  /** Where a citizen is drawn on screen (CSS px), or null if hidden. For tests and tools. */
  citizenToScreen(id: string): { x: number; y: number } | null;
  /** A clickable point on a building (CSS px). For tests and tools. */
  buildingToScreen(id: string): { x: number; y: number } | null;
  /** Current zoom: CSS pixels per tile. */
  readonly zoom: number;
  /** Tile position at the centre of the view. */
  readonly center: { x: number; y: number };
}
