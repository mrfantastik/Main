import type { Conversation, WorldState } from "../types";
import { fitsTime, wordingsOf } from "./talk";

// Checks a finished conversation for the kinds of nonsense a player notices:
// answering a question nobody asked, leaving a question hanging, a huge
// reaction to a few pounds, "lunch" at nine at night, a goodbye nobody
// answers, the same line twice, "Day 12" said out loud, "bad luck" about a
// lottery win, and voice tics stuck on where they don't belong. Used by the
// tests and by `npm run chatcheck`, which runs whole towns and counts them.

export type IssueKind =
  | "unasked answer"
  | "unanswered question"
  | "oversized reaction"
  | "wrong time of day"
  | "unanswered goodbye"
  | "repeated line"
  | "day number"
  | "wrong opinion"
  | "voice tic";

export interface Issue {
  kind: IssueKind;
  line: number;
  text: string;
}

const HOW = [
  "howFine",
  "howTired",
  "howHungry",
  "howWet",
  "howGoodDay",
  "howBadDay",
  "howGoodSmall",
  "howBadSmall",
  "howSad",
  "howAngry",
  "howScared",
  "howHappy",
  "howLonely",
  "howProud",
  "howEnvy",
  "howGrateful",
  "howAshamed",
];
const BIG_REACTIONS = ["congrats", "elaborateGood", "sympathy", "elaborateBad", "comfort", "supportive"];
const GOODBYES = ["bye", "byeClose"];

let howAnswers: string[] | null = null;
let bigReactions: Set<string> | null = null;
let goodbyes: Set<string> | null = null;

/** Lead-ins a speaker's voice may put in front of a line. */
const LEAD = /^(Um, |Er, |Oh, um, |Oh! |Honestly, |You know what\? |Oh, and |Look, |Ha! |Sorry, |Um, sorry, |It's good to talk to someone\. )+/;
let NAME_LEAD: RegExp | null = null;

function bare(text: string): string {
  let t = text.replace(LEAD, "");
  if (NAME_LEAD) t = t.replace(NAME_LEAD, "").replace(LEAD, "");
  t = t[0] ? t[0].toUpperCase() + t.slice(1) : t;
  return t.replace(/(, love|, pet|, mate)\.$/, ".").replace(/\.\.\.$/, ".");
}

/** Questions that are only a lead-in to what the speaker says next, or not really questions. */
const RHETORICAL = /(can i be honest with you|can i tell you something|did i tell you|can i have a moan|guess what|can i tell you what i('m| am) up to|alright|is that right|really|can you believe it|between us|seriously, how|have you heard|did you know|can't you tell|shouldn't you|isn't it|wasn't it|eh)\?$/i;

/** Check one finished conversation. */
export function checkChat(world: WorldState, conv: Conversation): Issue[] {
  // (Leaving out wordings that are also ordinary replies elsewhere, like "Could be worse.")
  howAnswers ??= HOW.flatMap((m) => wordingsOf(m)).filter((h) => !["gripeShrug", "dismissive", "workBad", "sameHere"].some((m) => wordingsOf(m).includes(h)));
  bigReactions ??= new Set(BIG_REACTIONS.flatMap((m) => wordingsOf(m)));
  goodbyes ??= new Set(GOODBYES.flatMap((m) => wordingsOf(m)).filter((g) => !wordingsOf("byeBack").includes(g)));
  NAME_LEAD ??= new RegExp(`^(${world.citizenOrder.map((id) => world.citizens[id].name).join("|")}), `);
  const issues: Issue[] = [];
  const lines = conv.lines;
  const flag = (kind: IssueKind, i: number) => issues.push({ kind, line: i, text: lines[i].text });
  const t = conv.startedT ?? world.time;
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const prev = lines[i - 1];
    const text = bare(l.text);
    // Answering "how are you?" when nobody asked.
    if (howAnswers.some((h) => text === h || (h.split(" ").length > 1 && text.startsWith(h))) && prev && (prev.speaker === l.speaker || !/\?/.test(prev.text))) flag("unasked answer", i);
    // A real question, then the same person carries on as if it wasn't asked.
    const next = lines[i + 1];
    if (/\?$/.test(l.text) && next && next.speaker === l.speaker && !RHETORICAL.test(l.text)) flag("unanswered question", i);
    // Raptures or commiserations over a few pounds.
    const amt = /£([\d,]+(?:\.\d+)?)/.exec(l.text);
    if (amt && Number(amt[1].replace(/,/g, "")) < 20 && !/\?/.test(l.text)) {
      for (const j of [i + 1, i + 2]) if (lines[j] && lines[j].speaker !== l.speaker && bigReactions.has(bare(lines[j].text))) flag("oversized reaction", j);
    }
    if (!fitsTime(l.text, t)) flag("wrong time of day", i);
    if (seen.has(l.text) && l.text.split(/\s+/).length > 2) flag("repeated line", i);
    seen.add(l.text);
    if (/\bDay \d+\b/.test(l.text)) flag("day number", i);
    if (/(lottery|celebrity|festival|party)/i.test(l.text) && next && next.speaker !== l.speaker && /^(Bad luck, that|Rotten timing|It's a shame, really)/.test(bare(next.text))) flag("wrong opinion", i + 1);
    if (/ Anyway!$|^(Right, so: |I'm worried, (?!to be honest))/.test(l.text) || (/^Sorry, /.test(l.text) && !/^Sorry, I (don't|didn't|do not|did not|can't|cannot|can not)\b/.test(l.text) && !/\b(need|short|could|can I|would you|lend|borrow|sorry)\b/i.test(l.text.slice(7)))) flag("voice tic", i);
  }
  // A goodbye with no reply, or said straight after their own line.
  const last = lines.length - 1;
  if (conv.topic === "chat" && last >= 1 && goodbyes.has(bare(lines[last].text))) flag("unanswered goodbye", last);
  return issues;
}

/** Tally of issues over many conversations, with a few examples of each. */
export class ChatAudit {
  chats = 0;
  lines = 0;
  counts = new Map<IssueKind, number>();
  examples = new Map<IssueKind, string[]>();

  add(world: WorldState, conv: Conversation): void {
    if (!conv.lines.length) return;
    this.chats++;
    this.lines += conv.lines.length;
    for (const is of checkChat(world, conv)) {
      this.counts.set(is.kind, (this.counts.get(is.kind) ?? 0) + 1);
      const ex = this.examples.get(is.kind) ?? [];
      if (ex.length < 4) {
        const name = (id: string) => world.citizens[id]?.name ?? id;
        ex.push(conv.lines.map((l, i) => `${i === is.line ? ">>" : "  "} ${name(l.speaker)}: ${l.text}`).join("\n"));
        this.examples.set(is.kind, ex);
      }
    }
  }

  total(): number {
    return [...this.counts.values()].reduce((a, b) => a + b, 0);
  }
}
