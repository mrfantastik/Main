// Tunable limits for the conversation system. Everything that bounds memory,
// prompt size or how talkative the town is lives here.

export const TALK = {
  /** Facts a citizen keeps (the least useful are forgotten first). */
  maxFacts: 70,
  /** Per person they talk to: recent conversations kept in detail ... */
  episodesKept: 5,
  /** ... older ones boiled down into a summary this long (characters). */
  historyChars: 420,
  threadsPerBond: 6,
  jokesPerBond: 4,
  opinionsPerBond: 5,
  /** Topic keys remembered per pair, for not going over the same ground. */
  topicsPerBond: 24,
  /** People whose bond is kept (the least recent are forgotten beyond this). */
  bondsKept: 19,
  viewsKept: 16,
  /** Own openers / questions / phrasings remembered, for not repeating themselves. */
  recentOpeners: 10,
  recentQuestions: 14,
  recentPhrases: 60,

  // ---- what goes into a prompt (per turn)
  promptMemories: 4,
  promptFacts: 5,
  promptEpisodes: 2,
  promptThreads: 3,
  promptTurns: 10,

  // ---- conversation lengths (lines) per mode
  lengths: {
    fail: [2, 2],
    brief: [2, 4],
    normal: [4, 8],
    engaged: [8, 14],
    significant: [12, 18],
    argument: [5, 10],
    deal: [4, 8],
  } as Record<string, [number, number]>,

  /** Minutes a line stays up, by words: base + per word, capped. */
  revealBase: 2,
  revealPerWord: 0.22,
  revealMax: 9,

  /** Lines from the town's brain or a free AI: how adventurous (scaled by each person's own creativity). */
  temperature: { min: 0.6, max: 1.0 },
  /** Model replies longer than this (characters) are cut back to whole sentences. */
  maxLineChars: 260,

  /** Swearing at all (each person's own tendency still applies). */
  swearing: true,
  /** Show what the conversation system was thinking under each transcript (developer view). */
  debugByDefault: false,
};
