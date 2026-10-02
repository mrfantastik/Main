import { randInt, type RngHolder } from "../rng";
import { TILE_BUILDING, TILE_GRASS, TILE_ROAD, type Building, type BuildingType, type CityMap } from "../types";

// The city is a grid of blocks separated by 2-tile-wide roads.
export const BLOCK = 8;
export const ROAD = 2;
export const PERIOD = BLOCK + ROAD;
export const COLS = 5;
export const ROWS = 4;

type BlockKind =
  | "res"
  | "shops"
  | "office"
  | "market"
  | "park"
  | "apts"
  | "depot"
  | "green"
  | ["bank", "townhall"]
  | ["diner", "pub"]
  | ["cowork", "lab"];

// Block layout, row by row. Edit this to reshape the city.
const LAYOUT: BlockKind[][] = [
  ["res", "res", "office", ["bank", "townhall"], "res"],
  ["res", "shops", "market", "park", "apts"],
  ["shops", ["diner", "pub"], "depot", "park", "res"],
  ["green", ["cowork", "lab"], "shops", "green", "green"],
];

const STREETS = ["Oak Lane", "Elm Street", "Mill Road", "Station Road", "Rose Avenue", "Kings Row"];

const VENUE_NAMES: Partial<Record<BuildingType, string>> = {
  office: "CityCorp Tower",
  market: "Marketplace",
  park: "Central Park",
  depot: "Wholesale Depot",
  bank: "Hustle Bank",
  townhall: "Town Hall",
  diner: "City Diner",
  pub: "The Gilded Pint",
  cowork: "Cowork Hub",
  lab: "Research Lab",
  apartments: "Skyline Apartments",
  green: "Green Belt",
};

export function isRoadXY(x: number, y: number): boolean {
  return x % PERIOD < ROAD || y % PERIOD < ROAD;
}

export function generateCity(rng: RngHolder): CityMap {
  const width = ROAD + COLS * PERIOD;
  const height = ROAD + ROWS * PERIOD;
  const tiles: number[] = new Array(width * height).fill(TILE_GRASS);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isRoadXY(x, y)) tiles[y * width + x] = TILE_ROAD;
    }
  }

  const buildings: Building[] = [];
  let houseNo = 1;
  let shopNo = 1;
  let greenNo = 1;

  const add = (b: Omit<Building, "businessId">) => {
    buildings.push({ ...b, businessId: null });
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) tiles[y * width + x] = TILE_BUILDING;
    }
  };

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const kind = LAYOUT[r][c];
      const x0 = ROAD + c * PERIOD;
      const y0 = ROAD + r * PERIOD;
      // Rent is higher near the centre of town.
      const central = 1 - (Math.abs(c - 2) + Math.abs(r - 1.5)) / 4;

      if (kind === "res" || kind === "shops") {
        const lots = [
          { ox: 0, oy: 0, top: true },
          { ox: 5, oy: 0, top: true },
          { ox: 0, oy: 5, top: false },
          { ox: 5, oy: 5, top: false },
        ];
        for (const lot of lots) {
          const bx = x0 + lot.ox;
          const by = y0 + lot.oy;
          const door = lot.top ? { x: bx + 1, y: y0 - 1 } : { x: bx + 1, y: y0 + BLOCK };
          if (kind === "res") {
            const street = STREETS[(r * 2 + (lot.top ? 0 : 1)) % STREETS.length];
            const capacity = randInt(rng, 1, 2);
            add({
              id: `house${houseNo}`,
              type: "house",
              name: `${houseNo * 2 + 1} ${street}`,
              x: bx,
              y: by,
              w: 3,
              h: 3,
              door,
              capacity,
              rent: Math.round(42 + central * 22 + randInt(rng, 0, 10) - (capacity - 1) * 6),
            });
            houseNo++;
          } else {
            add({
              id: `unit${shopNo}`,
              type: "shop_unit",
              name: `Unit ${shopNo}`,
              x: bx,
              y: by,
              w: 3,
              h: 3,
              door,
              capacity: 1,
              rent: 0,
            });
            shopNo++;
          }
        }
      } else if (Array.isArray(kind)) {
        const [left, right] = kind;
        add({
          id: left,
          type: left,
          name: VENUE_NAMES[left] ?? left,
          x: x0,
          y: y0 + 1,
          w: 3,
          h: 6,
          door: { x: x0 + 1, y: y0 + BLOCK },
          capacity: 30,
          rent: 0,
        });
        add({
          id: right,
          type: right,
          name: VENUE_NAMES[right] ?? right,
          x: x0 + 5,
          y: y0 + 1,
          w: 3,
          h: 6,
          door: { x: x0 + 6, y: y0 + BLOCK },
          capacity: 30,
          rent: 0,
        });
      } else if (kind === "market" || kind === "park" || kind === "green") {
        const type: BuildingType = kind;
        const id = kind === "green" ? `green${greenNo++}` : kind === "park" && buildings.some((b) => b.id === "park") ? "park2" : kind;
        add({
          id,
          type,
          name: VENUE_NAMES[type] ?? kind,
          x: x0,
          y: y0,
          w: BLOCK,
          h: BLOCK,
          door: { x: x0 + 4, y: y0 + BLOCK },
          capacity: 60,
          rent: 0,
        });
      } else {
        const type: BuildingType = kind === "apts" ? "apartments" : kind;
        add({
          id: kind,
          type,
          name: VENUE_NAMES[type] ?? kind,
          x: x0 + 1,
          y: y0 + 1,
          w: 6,
          h: 6,
          door: { x: x0 + 4, y: y0 + BLOCK },
          capacity: type === "apartments" ? 8 : 40,
          rent: type === "apartments" ? 30 : 0,
        });
      }
    }
  }

  return { width, height, tiles, buildings };
}

export function getBuilding(map: CityMap, id: string | null | undefined): Building | undefined {
  if (!id) return undefined;
  return map.buildings.find((b) => b.id === id);
}

export function buildingsOfType(map: CityMap, type: BuildingType): Building[] {
  return map.buildings.filter((b) => b.type === type);
}

/** Point just inside the entrance, used as the base for indoor spots. */
export function interiorSpot(b: Building, r1: number, r2: number) {
  const pad = b.w >= 6 ? 1 : 0.6;
  return {
    x: b.x + pad + r1 * (b.w - pad * 2),
    y: b.y + pad + r2 * (b.h - pad * 2),
  };
}
