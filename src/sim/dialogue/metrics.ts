import { rememberChat } from "../mind/bot";
import type { Citizen, Conversation, WorldState } from "../types";
import { newId } from "../util";
import { beginDialogue, endDialogue, scriptConversation } from "./index";
import { plain } from "./voice";

// Measuring conversations: how repetitive they are, how they open and end,
// how often old threads come back, and whether each person's voice is their
// own (could you tell who said a line with the names taken out?). Used by
// `npm run talkbench` and the tests.

/** A line with names and numbers taken out, for comparing wordings. */
export function shapeOf(world: WorldState, text: string): string {
  let t = text;
  for (const id of world.citizenOrder) t = t.replaceAll(world.citizens[id].name, "NAME");
  return t.replace(/£[\d,.]+/g, "£N").replace(/\d+/g, "N");
}

export interface TalkMetrics {
  chats: number;
  lines: number;
  /** Share of lines whose wording (names and numbers aside) is different from every other line. */
  distinctLines: number;
  /** Share of chats that open with a line already used to open another. */
  repeatedOpeners: number;
  /** The most-said line of more than four words, and how often. */
  topLine: { text: string; n: number };
  avgLines: number;
  shortest: number;
  longest: number;
  /** Questions per line. */
  questionsPerLine: number;
  /** Turns that pick up something from before: a follow-up, a running joke, checking in, an old row, money owed. */
  callbacks: number;
  /** How the chats went (brush-off, brief, normal, engaged, significant, argument, deal). */
  modes: Record<string, number>;
  /** Chats that end with a goodbye (and one back) rather than just stopping. */
  naturalEndings: number;
}

const CALLBACK = new Set(["followup", "joke", "concern", "owed", "disagreement", "shared"]);

/** Numbers for a set of finished conversations. */
export function talkMetrics(world: WorldState, convs: Conversation[]): TalkMetrics {
  const chats = convs.filter((c) => c.lines.length);
  const shapes = chats.flatMap((c) => c.lines.map((l) => shapeOf(world, l.text)));
  const counts = new Map<string, number>();
  for (const s of shapes) counts.set(s, (counts.get(s) ?? 0) + 1);
  const openers = new Set<string>();
  let repeatedOpeners = 0;
  for (const c of chats) {
    const o = shapeOf(world, c.lines[0].text);
    if (openers.has(o)) repeatedOpeners++;
    openers.add(o);
  }
  const long = [...counts].filter(([s]) => s.split(/\s+/).length > 4).sort((x, y) => y[1] - x[1]);
  const lens = chats.map((c) => c.lines.length);
  const modes: Record<string, number> = {};
  let callbacks = 0;
  let natural = 0;
  for (const c of chats) {
    const st = c.dlg;
    modes[st?.mode ?? "other"] = (modes[st?.mode ?? "other"] ?? 0) + 1;
    callbacks += st?.turns.filter((t) => t.move === "raise" && t.kind && CALLBACK.has(t.kind)).length ?? 0;
    const last = st?.turns[st.turns.length - 1];
    if (last && (last.move === "byeback" || last.bye)) natural++;
  }
  return {
    chats: chats.length,
    lines: shapes.length,
    distinctLines: shapes.length ? counts.size / shapes.length : 1,
    repeatedOpeners: chats.length ? repeatedOpeners / chats.length : 0,
    topLine: long.length ? { text: long[0][0], n: long[0][1] } : { text: "", n: 0 },
    avgLines: lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0,
    shortest: lens.length ? Math.min(...lens) : 0,
    longest: lens.length ? Math.max(...lens) : 0,
    questionsPerLine: shapes.length ? shapes.filter((s) => /\?/.test(s)).length / shapes.length : 0,
    callbacks,
    modes,
    naturalEndings: chats.length ? natural / chats.length : 1,
  };
}

/** How one person talks, in numbers. */
export interface VoiceStats {
  lines: number;
  avgWords: number;
  questionRate: number;
  exclaimRate: number;
  swearRate: number;
}

const SWEAR = /\b(bloody|sodding|fucking|fuck's sake|christ|bloody hell)\b/i;

/** Each speaker's numbers, over a set of conversations. */
export function voiceStats(convs: Conversation[]): Map<string, VoiceStats> {
  const acc = new Map<string, { lines: number; words: number; q: number; ex: number; sw: number }>();
  for (const c of convs)
    for (const l of c.lines) {
      const a = acc.get(l.speaker) ?? { lines: 0, words: 0, q: 0, ex: 0, sw: 0 };
      a.lines++;
      a.words += l.text.split(/\s+/).length;
      if (/\?/.test(l.text)) a.q++;
      if (/!/.test(l.text)) a.ex++;
      if (SWEAR.test(l.text)) a.sw++;
      acc.set(l.speaker, a);
    }
  const out = new Map<string, VoiceStats>();
  for (const [id, a] of acc) out.set(id, { lines: a.lines, avgWords: a.words / a.lines, questionRate: a.q / a.lines, exclaimRate: a.ex / a.lines, swearRate: a.sw / a.lines });
  return out;
}

/** Words (and word pairs) someone uses, names taken out. */
function bag(world: WorldState, texts: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of texts) {
    const w = plain(shapeOf(world, t)).split(" ").filter((x) => x && x !== "name");
    for (let i = 0; i < w.length; i++) {
      m.set(w[i], (m.get(w[i]) ?? 0) + 1);
      if (i + 1 < w.length) m.set(`${w[i]} ${w[i + 1]}`, (m.get(`${w[i]} ${w[i + 1]}`) ?? 0) + 1);
    }
  }
  return m;
}

function cosine(a: Map<string, number>, b: Map<string, number>, idf: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) {
    const w = idf.get(k) ?? 0;
    na += (v * w) ** 2;
    const u = b.get(k);
    if (u) dot += v * u * w * w;
  }
  for (const [k, v] of b) nb += (v * (idf.get(k) ?? 0)) ** 2;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Could you tell who's talking with the names taken out? Learns how each
 * person talks from `train`, then guesses the speaker of each person's lines
 * in `test` (all their lines there, together). The share guessed right, and
 * what guessing at random would get.
 */
export function voiceIdentification(world: WorldState, train: Conversation[], test: Conversation[], minLines = 12): { accuracy: number; chance: number; tested: number } {
  const by = (cs: Conversation[]) => {
    const m = new Map<string, string[]>();
    for (const c of cs) for (const l of c.lines) m.set(l.speaker, [...(m.get(l.speaker) ?? []), l.text]);
    return m;
  };
  const tr = by(train);
  const te = by(test);
  const profiles = new Map([...tr].filter(([, ls]) => ls.length >= minLines).map(([id, ls]) => [id, bag(world, ls)]));
  // Words everyone says ("yeah", "the") count for little; words only some people say count for a lot.
  const df = new Map<string, number>();
  for (const p of profiles.values()) for (const k of p.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  const idf = new Map([...df].map(([k, n]) => [k, Math.log((profiles.size + 1) / n)]));
  let right = 0;
  let tested = 0;
  for (const [id, ls] of te) {
    if (ls.length < minLines || !profiles.has(id)) continue;
    const b = bag(world, ls);
    let best = "";
    let bestSim = -1;
    for (const [pid, p] of profiles) {
      const s = cosine(b, p, idf);
      if (s > bestSim) {
        bestSim = s;
        best = pid;
      }
    }
    tested++;
    if (best === id) right++;
  }
  return { accuracy: tested ? right / tested : 0, chance: profiles.size ? 1 / profiles.size : 0, tested };
}

/**
 * Have two people chat right now, wherever they are, with the built-in
 * voices (the dev harness and tests: twenty encounters between the same two,
 * a scripted scene). Everything they take away from it is kept, as after
 * any conversation.
 */
export function forceChat(world: WorldState, a: Citizen, b: Citizen, mode?: "argument"): Conversation {
  const conv: Conversation = {
    id: newId(world),
    a: a.id,
    b: b.id,
    topic: mode === "argument" ? "argue" : "chat",
    buildingId: a.insideId,
    startedT: world.time,
    lines: [],
    revealed: 0,
    nextRevealT: world.time,
    status: "done",
    agenda: {},
    terms: {},
    outcome: {},
    fallback: null,
    summary: "",
    source: "template",
    endT: world.time,
  };
  beginDialogue(world, conv, a, b, mode);
  scriptConversation(world, conv);
  conv.revealed = conv.lines.length;
  endDialogue(world, conv);
  rememberChat(world, conv);
  return conv;
}
