import type { CoreValue, Occupation } from "../types";

// Raw material for personalities. Picks are weighted by each citizen's traits
// so a greedy trader and a generous baker come out as different people.

export const VALUE_WORDS: Record<CoreValue, string> = {
  family: "family",
  status: "being respected",
  freedom: "being their own boss",
  security: "security",
  fairness: "fairness",
  wealth: "money",
  community: "community",
  knowledge: "knowing how things work",
};

export const QUIRKS = [
  "hums when counting money",
  "counts their change twice",
  "is always ten minutes early",
  "names every pigeon in the park",
  "keeps a notebook of every price they see",
  "can't walk past a bargain",
  "quotes their gran's sayings",
  "taps the table when nervous",
  "remembers everyone's birthday",
  "never finishes a cup of tea",
  "talks to their plants",
  "drums on anything when bored",
  "keeps receipts for everything",
  "always has a mint to offer",
  "re-reads the same paperback",
  "whistles off-key",
] as const;

export const LIKES = ["a good bargain", "the pub", "the park", "coffee", "quiet evenings", "gadgets", "a long lie-in", "football on the radio", "people-watching", "gossip", "cooking", "books", "being busy", "a fair deal"] as const;

export const DISLIKES = ["debt", "crowds", "being lied to", "early mornings", "waste", "rudeness", "losing", "waiting around", "show-offs", "being told what to do", "haggling", "the diner's coffee"] as const;

export const FEARS = {
  homeless: "ending up on the streets",
  poor: "dying poor",
  alone: "ending up alone",
  failure: "being a failure",
  business: "losing everything they've built",
  family: "letting their family down",
} as const;
export type FearKey = keyof typeof FEARS;

export const DREAMS: { text: string; fits: (o: Occupation) => boolean }[] = [
  { text: "owning the busiest shop in town", fits: (o) => o === "shopkeeper" || o === "entrepreneur" },
  { text: "being their own boss", fits: (o) => o !== "entrepreneur" },
  { text: "retiring by the sea", fits: () => true },
  { text: "inventing something everyone uses", fits: (o) => o === "researcher" },
  { text: "buying a proper house for their family", fits: () => true },
  { text: "being the richest person in Hustle City", fits: (o) => o === "trader" || o === "reseller" || o === "entrepreneur" },
  { text: "never worrying about rent again", fits: () => true },
  { text: "being respected at CityCorp", fits: (o) => o === "employee" },
  { text: "travelling the world on their own money", fits: () => true },
];

export const ORIGINS = [
  "Grew up above a chip shop on the coast",
  "Came to Hustle City after the factory back home closed",
  "Was raised by their gran in a two-bedroom flat",
  "Left a small farming village at eighteen",
  "Grew up the youngest of five, always fighting for scraps",
  "Was the first in their family to finish school",
  "Spent ten years drifting between odd jobs",
  "Grew up comfortable, then watched their parents lose it all",
  "Moved here from the city to start again",
  "Has lived on the same street their whole life",
];

export const TURNS: Record<CoreValue, string[]> = {
  family: ["Still rings home every Sunday.", "Sends money home whenever there's any spare."],
  status: ["Wants people to know their name.", "Hates feeling looked down on."],
  freedom: ["Never lasted long with a boss breathing down their neck.", "Wants to answer to nobody."],
  security: ["Keeps a little cash under the mattress, just in case.", "Learned the hard way that money can vanish."],
  fairness: ["Can't stand people who cheat.", "Believes a deal should be good for both sides."],
  wealth: ["Has never stopped thinking about the next pound.", "Measures every day in profit and loss."],
  community: ["Knows half the town by name.", "Thinks this town only works if people look out for each other."],
  knowledge: ["Reads anything they can get their hands on.", "Has to know how things really work."],
};
