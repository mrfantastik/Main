import { BackSide, BufferAttribute, EquirectangularReflectionMapping, BufferGeometry, CanvasTexture, Color, LinearFilter, Mesh, MeshBasicMaterial, Points, PointsMaterial, SphereGeometry, SRGBColorSpace } from "three";

// The dreamscape sky: a big dome painted with soft purple clouds on a pale
// pink-lilac sky (generated once from noise, no image files), tinted by the
// time of day, with stars that come out at night.

function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise that wraps every `period` cells in x (so the dome has no seam). */
function noise(x: number, y: number, period: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = (i: number) => ((i % period) + period) % period;
  const a = hash2(w(xi), yi);
  const b = hash2(w(xi + 1), yi);
  const c = hash2(w(xi), yi + 1);
  const d = hash2(w(xi + 1), yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number, period: number): number {
  let sum = 0;
  let amp = 0.55;
  let p = period;
  for (let o = 0; o < 5; o++) {
    sum += noise(x, y, p) * amp;
    x *= 2;
    y *= 2;
    p *= 2;
    amp *= 0.5;
  }
  return sum;
}

const HORIZON = new Color(0xf0d6ec);
const ZENITH = new Color(0xb9a2ec);
const CLOUD_DARK = new Color(0x6a3fb8);
const CLOUD_MID = new Color(0x9a6fdc);
const CLOUD_LIGHT = new Color(0xf6e8fb);
const DUSK = new Color(0xffb38a);
const NIGHT = new Color(0x2a2150);
/** The floor as reflections see it (the lower half of the environment). */
const FLOOR_NEAR = new Color(0x3c3436);
const FLOOR_FAR = new Color(0x8a7690);

/**
 * Equirectangular sky texture: pale sky with heavy purple clouds piled above
 * the horizon, lit pale pink on top like the reference. `env` paints the lower
 * half as the dark tiled floor, for reflections on glossy things.
 */
function skyCanvas(W: number, H: number, env: boolean): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  const c = new Color();
  const period = 12;
  for (let py = 0; py < H; py++) {
    // 0 at the top of the dome, 0.5 at the horizon.
    const lat = py / H;
    const up = Math.max(0, 1 - lat * 2); // 1 at zenith, 0 at horizon and below
    for (let px = 0; px < W; px++) {
      const nx = (px / W) * period;
      const ny = lat * 9;
      if (env && lat > 0.5) {
        // Below the horizon: the floor, darker the more straight down you look.
        c.copy(FLOOR_FAR).lerp(FLOOR_NEAR, Math.min(1, (lat - 0.5) * 6));
      } else {
        const n = fbm(nx, ny * 1.6, period);
        const streak = fbm(nx * 0.5 + 3.1, ny * 3.2, period / 2);
        c.copy(HORIZON).lerp(ZENITH, Math.pow(up, 0.8));
        if (lat < 0.5) {
          // Clouds pile up above the horizon and thin out overhead; their
          // tops (where the noise is just past the edge) catch the light.
          const band = Math.min(1, (0.5 - lat) * 5) * (0.7 + up * 0.3);
          const v = n * 0.75 + streak * 0.45 - 0.46;
          const cloud = Math.max(0, Math.min(1, v * 3.4)) * band;
          const depth = Math.max(0, Math.min(1, (n - 0.45) * 4));
          c.lerp(CLOUD_MID, cloud * 0.9).lerp(CLOUD_DARK, cloud * depth * 0.75);
          const rim = Math.max(0, 1 - Math.abs(v - 0.05) * 9) * band * (0.4 + (1 - up) * 0.6);
          c.lerp(CLOUD_LIGHT, rim * 0.55);
        }
      }
      const i = (py * W + px) * 4;
      img.data[i] = Math.round(Math.min(1, c.r) * 255);
      img.data[i + 1] = Math.round(Math.min(1, c.g) * 255);
      img.data[i + 2] = Math.round(Math.min(1, c.b) * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function skyTexture(W: number, H: number, env = false): CanvasTexture {
  const tex = new CanvasTexture(skyCanvas(W, H, env));
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  if (env) tex.mapping = EquirectangularReflectionMapping;
  return tex;
}

/** The environment glossy surfaces reflect: this sky above, the dark floor below (feed it to a PMREM generator). */
export function dreamEnvironment(): CanvasTexture {
  return skyTexture(512, 256, true);
}

export class DreamSky {
  readonly dome: Mesh;
  readonly stars: Points;
  /** The colour where sky meets floor (used for fog). */
  readonly horizon = new Color();
  private readonly tex: CanvasTexture;
  private readonly tint = new Color();

  constructor(radius = 460) {
    this.tex = skyTexture(1024, 512);
    const geo = new SphereGeometry(radius, 48, 24);
    this.dome = new Mesh(geo, new MeshBasicMaterial({ map: this.tex, side: BackSide, fog: false, depthWrite: false, toneMapped: false }));
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;

    const n = 700;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = hash2(i, 7) * Math.PI * 2;
      const h = 0.08 + hash2(i, 13) * 0.92;
      const r = Math.sqrt(1 - h * h) * radius * 0.97;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = h * radius * 0.97;
      pos[i * 3 + 2] = Math.sin(a) * r;
    }
    const sg = new BufferGeometry();
    sg.setAttribute("position", new BufferAttribute(pos, 3));
    this.stars = new Points(sg, new PointsMaterial({ color: 0xfff4ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false, toneMapped: false }));
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -9;
  }

  /** Keep the dome around the viewer. */
  centre(x: number, z: number): void {
    this.dome.position.set(x, 0, z);
    this.stars.position.set(x, 0, z);
  }

  /** n: 0 day .. 1 night; golden: sunrise/sunset glow 0..1. */
  setTime(n: number, golden: number): void {
    this.tint.setRGB(1, 1, 1).lerp(DUSK, golden * 0.55).lerp(NIGHT, n * 0.88);
    (this.dome.material as MeshBasicMaterial).color.copy(this.tint);
    (this.stars.material as PointsMaterial).opacity = Math.max(0, n * 1.2 - 0.2);
    this.horizon.copy(HORIZON).multiply(this.tint);
  }

  dispose(): void {
    this.tex.dispose();
    this.dome.geometry.dispose();
    (this.dome.material as MeshBasicMaterial).dispose();
    this.stars.geometry.dispose();
    (this.stars.material as PointsMaterial).dispose();
  }
}
