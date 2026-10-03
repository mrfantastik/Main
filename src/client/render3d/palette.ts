// A small, warm palette: every surface in the 3D city picks from these, so
// the whole town reads as one retro scene.

export const P = {
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
} as const;

/** Roof colours for houses, picked per house. */
export const ROOFS = [P.terracotta, P.brick, P.rust, P.slate, P.olive, P.plum, P.ochre];
/** Wall colours for houses. */
export const WALLS = [P.cream, P.sand, P.white, P.stone];
/** Skin tones for citizens. */
export const SKIN = [0xf1c9a5, 0xd9a47e, 0xb67a52, 0x8a5636, 0xe8b88f];
