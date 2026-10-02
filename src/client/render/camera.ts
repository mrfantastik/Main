// Pan/zoom camera. World units are tiles; TILE pixels per tile at zoom 1.

export const TILE = 32;

export class Camera {
  /** World position (tiles) at the centre of the screen. */
  x = 26;
  y = 21;
  zoom = 1;
  width = 800;
  height = 600;
  minZoom = 0.35;
  maxZoom = 3.5;

  get scale(): number {
    return TILE * this.zoom;
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.x) * this.scale + this.width / 2, y: (wy - this.y) * this.scale + this.height / 2 };
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.width / 2) / this.scale + this.x, y: (sy - this.height / 2) / this.scale + this.y };
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToWorld(sx, sy);
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  fit(worldW: number, worldH: number): void {
    this.x = worldW / 2;
    this.y = worldH / 2;
    this.zoom = Math.min(this.width / (worldW * TILE), this.height / (worldH * TILE)) * 0.98;
  }

  clamp(worldW: number, worldH: number): void {
    this.x = Math.min(worldW, Math.max(0, this.x));
    this.y = Math.min(worldH, Math.max(0, this.y));
  }
}
