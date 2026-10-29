// Tunable numbers for the agent layer (see docs/agent-society.md).

export const SOCIETY = {
  /** How many citizens a language model thinks and speaks for (the rest use the built-in AI). */
  rosterSize: 10,
  /** An AI agent stops to think about what to do with people this often while awake (game minutes)... */
  thinkEvery: 180,
  /** ...and a built-in one this often. */
  rulesThinkEvery: 300,
  /** Something big happening makes them think again sooner (but not more often than this). */
  minThinkGap: 45,
  /** Kept per agent. */
  decisionsKept: 30,
  goalsKept: 6,
  projectsKept: 6,
  daysKept: 7,
  intentsKept: 4,
  /** An intention to talk to someone is forgotten after this long (game minutes). */
  intentMinutes: 20 * 60,
  /** Rumours the world keeps track of. */
  rumoursKept: 60,
  /** The longest thing an agent may claim in a rumour or a row (characters). */
  maxClaim: 140,
  /** The most an agent may give away or lend in one go, as a share of what they have to spare. */
  maxGiveShare: 0.6,
};
