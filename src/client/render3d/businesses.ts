import { Box3, BufferGeometry, Vector3 } from "three";
import type { BusinessSummary } from "../../shared/protocol";
import { KIND_COLORS } from "../render/overlay";
import type { BuildingInfo } from "./city";
import { GeoBuilder } from "./geometry";
import { P } from "./palette";

// Shop awnings, market stalls and agency banners for the businesses that are
// open right now. Rebuilt only when the set of businesses changes.

export interface BusinessDecor {
  geometry: BufferGeometry;
  /** Click box and label anchor per business id. */
  boxes: Map<string, Box3>;
}

function hex(css: string): number {
  return parseInt(css.slice(1), 16);
}

/** A signature that changes whenever the decor needs rebuilding. */
export function decorKey(businesses: BusinessSummary[]): string {
  let k = "";
  for (const b of businesses) if (b.open) k += `${b.id}:${b.kind}:${b.buildingId};`;
  return k;
}

export function buildDecor(businesses: BusinessSummary[], info: Map<string, BuildingInfo>): BusinessDecor {
  const g = new GeoBuilder();
  const boxes = new Map<string, Box3>();
  const perBuilding = new Map<string, number>();
  for (const biz of businesses) {
    if (!biz.open) continue;
    const bi = info.get(biz.buildingId);
    if (!bi) continue;
    const b = bi.b;
    const color = hex(KIND_COLORS[biz.kind] ?? "#888888");
    const n = perBuilding.get(b.id) ?? 0;
    perBuilding.set(b.id, n + 1);
    const y = bi.deck.y;
    if (b.type === "shop_unit") {
      // Striped awning over the shop front and a sign board on the roof.
      const face = bi.face;
      const cx = b.x + b.w / 2;
      const cz = b.y + b.h / 2;
      const half = (face % 2 === 0 ? b.h : b.w) / 2 - 0.12;
      const fx = face === 1 ? cx + half + 0.25 : face === 3 ? cx - half - 0.25 : cx;
      const fz = face === 0 ? cz + half + 0.25 : face === 2 ? cz - half - 0.25 : cz;
      const along = face % 2 === 0;
      for (let s = 0; s < 6; s++) {
        const o = -1.25 + s * 0.5 + 0.25;
        g.box(along ? fx + o : fx, 1.12, along ? fz : fz + o, along ? 0.5 : 0.55, 0.1, along ? 0.55 : 0.5, s % 2 ? P.white : color);
      }
      const sx = face === 1 ? cx + half - 0.1 : face === 3 ? cx - half + 0.1 : cx;
      const sz = face === 0 ? cz + half - 0.1 : face === 2 ? cz - half + 0.1 : cz;
      g.box(sx, bi.top, sz, along ? 2.2 : 0.12, 0.5, along ? 0.12 : 2.2, color);
      if (biz.kind === "cafe") {
        const [tx, tz] = face === 0 ? [0, 0.95] : face === 2 ? [0, -0.95] : face === 1 ? [0.95, 0] : [-0.95, 0];
        for (const off of [-0.8, 0.8]) {
          const x = fx + tx * 0.6 + (along ? off : 0);
          const z = fz + tz * 0.6 + (along ? 0 : off);
          g.cylinder(x, 0.12, z, 0.04, 0.38, P.charcoal, 5);
          g.cylinder(x, 0.5, z, 0.22, 0.04, P.white, 8);
        }
      }
      boxes.set(biz.id, bi.box.clone());
    } else if (b.type === "market") {
      // Citizens' stalls along the bottom of the plaza (as in the 2D view).
      const col = n % 4;
      const row = Math.floor(n / 4);
      const x = b.x + 0.4 + col * 1.9 + 0.8;
      const z = b.y + b.h - 1.3 - row * 1.1 + 0.45;
      g.box(x, y, z + 0.15, 1.3, 0.48, 0.45, P.trunk);
      g.box(x - 0.62, y, z - 0.3, 0.06, 1, 0.06, P.trunk);
      g.box(x + 0.62, y, z - 0.3, 0.06, 1, 0.06, P.trunk);
      g.box(x, y + 1, z, 1.5, 0.1, 0.9, color);
      boxes.set(biz.id, new Box3(new Vector3(x - 0.8, 0, z - 0.5), new Vector3(x + 0.8, y + 1.15, z + 0.5)));
    } else {
      // Agencies: a vertical banner on the building's front.
      const face = bi.face;
      const cx = b.x + b.w / 2;
      const cz = b.y + b.h / 2;
      const along = face % 2 === 0;
      const len = along ? b.w : b.h;
      const o = -len / 2 + 0.5 + (n % 4) * ((len - 1) / 3);
      const half = (along ? b.h : b.w) / 2 - 0.12 + 0.06;
      const x = along ? cx + o : cx + (face === 1 ? half : -half);
      const z = along ? cz + (face === 0 ? half : -half) : cz + o;
      g.box(x, 1, z, along ? 0.55 : 0.06, 1.5, along ? 0.06 : 0.55, color);
      boxes.set(biz.id, new Box3(new Vector3(x - 0.4, 0.9, z - 0.4), new Vector3(x + 0.4, 2.6, z + 0.4)));
    }
  }
  return { geometry: g.build(), boxes };
}
