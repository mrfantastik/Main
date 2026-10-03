// Every surface in the 3D city picks its colour from `P`, so the whole town
// reads as one scene. Two looks share the same shapes: the warm retro town,
// and the dreamscape (marble and pastels under a purple sky).

export type Look = "dream" | "retro";

const RETRO = {
  grass: 0x8fb35a,
  grassDark: 0x6f9a47,
  meadow: 0x7da650,
  pavement: 0xd2c3a2,
  paving: 0xe2cfa4,
  path: 0xdcc79a,
  asphalt: 0x575158,
  lane: 0xf1e6c8,
  kerb: 0xbcae92,
  cream: 0xf0e0bd,
  sand: 0xd8bf8e,
  stone: 0xc8b896,
  terracotta: 0xc2593d,
  brick: 0x9c4a33,
  rust: 0xb8743a,
  ochre: 0xd9a441,
  olive: 0x7f8a45,
  moss: 0x5c7a3a,
  leaf: 0x4f8a3c,
  leafDark: 0x3c6b33,
  leafLight: 0x6aa04a,
  trunk: 0x6b4a33,
  teal: 0x3f8f86,
  tealLight: 0x8fd1c4,
  sky: 0x6d9dc5,
  slate: 0x56607a,
  slateDark: 0x3e4558,
  charcoal: 0x2f2a2e,
  plum: 0x7a5c8f,
  white: 0xf3ecdc,
  red: 0xc9473d,
  glass: 0x7f9fb6,
  door: 0x4a3122,
  water: 0x4f93c0,
  waterLight: 0x7cb8da,
  lampPost: 0x3a3836,
  lampOff: 0x7a7266,
  lampOn: 0xffd88a,
  windowLit: 0xffc865,
  crate: 0xc79a5b,
  metal: 0x8d8f94,
};

type Palette = Record<keyof typeof RETRO, number>;

/** The dreamscape: white marble, pastel stone, glassy teal, under a lilac sky. */
const DREAM: Palette = {
  grass: 0x9fd6c4,
  grassDark: 0x7fbfae,
  meadow: 0xb7dfc9,
  pavement: 0xe9e3ef,
  paving: 0xf1ecf5,
  path: 0xdcd3e6,
  asphalt: 0x4c4650,
  lane: 0xf5f0fa,
  kerb: 0xd9d2e2,
  cream: 0xf6f1ea,
  sand: 0xeee3dc,
  stone: 0xe4dde8,
  terracotta: 0xf2a7c3,
  brick: 0xd99ab8,
  rust: 0xf0b98f,
  ochre: 0xf4d58d,
  olive: 0x9cc9b4,
  moss: 0x7fb39e,
  leaf: 0x3f7f73,
  leafDark: 0x2f6b62,
  leafLight: 0x5a9c8c,
  trunk: 0xe9e3ef,
  teal: 0x5cc8c0,
  tealLight: 0xa9eee6,
  sky: 0x9fb5ff,
  slate: 0x8e9ad8,
  slateDark: 0x6e78b8,
  charcoal: 0x4a4458,
  plum: 0xb48ad8,
  white: 0xfbf8ff,
  red: 0xf27b9b,
  glass: 0x7fd0e6,
  door: 0x5c4a7a,
  water: 0x63b6e8,
  waterLight: 0x9ad8f5,
  lampPost: 0xf3eef8,
  lampOff: 0xd8d0e6,
  lampOn: 0xffe6b0,
  windowLit: 0xffd59a,
  crate: 0xe8c9a8,
  metal: 0xc9c4d6,
};

/** The colours in use (switched by setLook before the city is built). */
export const P: Palette = { ...RETRO };

/** Roof colours for houses, picked per house. */
export const ROOFS: number[] = [];
/** Wall colours for houses. */
export const WALLS: number[] = [];

/** Switch every colour to the given look. */
export function setLook(look: Look): void {
  Object.assign(P, look === "dream" ? DREAM : RETRO);
  ROOFS.splice(0, ROOFS.length, P.terracotta, P.brick, P.rust, P.slate, P.olive, P.plum, P.ochre);
  WALLS.splice(0, WALLS.length, P.cream, P.sand, P.white, P.stone);
}
setLook("retro");
/** Skin tones for citizens. */
export const SKIN = [0xf1c9a5, 0xd9a47e, 0xb67a52, 0x8a5636, 0xe8b88f];
