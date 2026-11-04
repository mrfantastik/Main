// Small grammar helpers for retelling: turning someone's own words about
// themselves ("I couldn't pay my rent") into how others say it ("Ben
// couldn't pay their rent"), and pulling out the words that show a thing has
// come up in conversation.

/** Present-tense verbs that take an -s after "Ben". */
const BASE = new Set(["owe", "need", "want", "think", "hate", "love", "know", "like", "reckon", "feel", "earn", "make", "get", "keep", "miss", "work", "run", "live", "wish", "hope", "mean", "plan", "try", "say", "go", "see", "spend"]);

function agree(verb: string): string {
  if (verb === "have") return "has";
  if (verb === "do") return "does";
  if (verb === "don't") return "doesn't";
  if (verb === "am") return "is";
  if (verb === "go") return "goes";
  if (verb === "try") return "tries";
  if (BASE.has(verb)) return `${verb}s`;
  return verb;
}

/**
 * "I couldn't pay my rent. I owe the landlord £50." -> "Ben couldn't pay their
 * rent. They owe the landlord £50." The first mention is by name, then "they".
 */
export function toThird(text: string, name: string): string {
  let named = false;
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  const out = sentences.map((sent) => {
    let s = sent;
    const subj = () => {
      const was = named;
      named = true;
      return was ? "they" : name;
    };
    s = s.replace(/\bI'm\b/g, () => (named ? "they're" : ((named = true), `${name}'s`)));
    s = s.replace(/\bI've\b/g, () => (named ? "they've" : ((named = true), `${name}'s`)));
    s = s.replace(/\bI'd\b/g, () => `${subj()}'d`);
    s = s.replace(/\bI'll\b/g, () => `${subj()}'ll`);
    s = s.replace(/\bI (am|was|have|do|don't)\b/g, (_, v: string) => {
      const who = subj();
      if (who === "they") return v === "am" ? "they are" : v === "was" ? "they were" : `they ${v}`;
      return `${who} ${agree(v)}`;
    });
    s = s.replace(/\bI ([a-z']+)\b/g, (_, v: string) => {
      const who = subj();
      return who === "they" ? `they ${v}` : `${who} ${agree(v)}`;
    });
    s = s.replace(/\bmy\b/g, () => (named ? "their" : ((named = true), `${name}'s`)));
    s = s.replace(/\bMy\b/g, () => (named ? "Their" : ((named = true), `${name}'s`)));
    s = s.replace(/\bme\b/g, () => (named ? "them" : ((named = true), name)));
    s = s.replace(/\bmyself\b/g, "themselves");
    s = s.replace(/\bmine\b/g, "theirs");
    return s;
  });
  let res = out.join("").trim();
  res = res.replace(/(^|[.!?]\s+)(they|their)\b/g, (_, pre: string, w: string) => `${pre}${w[0].toUpperCase()}${w.slice(1)}`);
  return res;
}

/** "I lost my job" -> "you lost your job" (for saying it back to them). */
export function toSecond(text: string): string {
  return text
    .replace(/\bI'm\b/g, "you're")
    .replace(/\bI've\b/g, "you've")
    .replace(/\bI'd\b/g, "you'd")
    .replace(/\bI'll\b/g, "you'll")
    .replace(/\bI am\b/g, "you are")
    .replace(/\bI was\b/g, "you were")
    .replace(/\bI\b/g, "you")
    .replace(/\bmy\b/g, "your")
    .replace(/\bMy\b/g, "Your")
    .replace(/\bme\b/g, "you")
    .replace(/\bmyself\b/g, "yourself")
    .replace(/\bmine\b/g, "yours");
}

/** "Ben couldn't pay their rent." -> "couldn't pay their rent" (dropping a leading name, lower-cased, no full stop). */
export function predicate(text: string, name: string): string {
  return text
    .replace(new RegExp(`^${name}('s)?\\s+`), "")
    .replace(/[.!?]+$/, "")
    .trim();
}

const STOP = new Set(
  "the a an and or but to of in on at for with from that this these those your their there they them then than have has had been being were was are is am it its it's i'm i've you you're your yours my me mine we our us he she his her him who what when where why how about into over just some more most much very really quite also only even still back like well said says told tell going gone want wants need needs make made get got take took give gave know knew think thought because while after before again ever never always anyone someone something nothing everything which would could should might will shall can can't won't don't didn't isn't wasn't".split(
    " ",
  ),
);

/** The words in a gist that show it has come up when someone says them. */
export function cuesOf(text: string, names: string[] = []): string[] {
  const skip = new Set(names.map((n) => n.toLowerCase()));
  const words = (text.toLowerCase().match(/[a-z£][a-z0-9']{3,}/g) ?? []).filter((w) => !STOP.has(w) && !skip.has(w) && !skip.has(w.replace(/'s$/, "")));
  return [...new Set(words.map((w) => w.replace(/'s$/, "")))].slice(0, 6);
}

/** Did this line touch on it? At least `need` of its cue words (stems) appear. */
export function mentions(line: string, cues: string[], need = 1): boolean {
  if (!cues.length) return false;
  const t = line.toLowerCase();
  let hits = 0;
  for (const c of cues) {
    const stem = c.length > 5 ? c.slice(0, c.length - 2) : c;
    if (t.includes(stem)) hits++;
    if (hits >= need) return true;
  }
  return false;
}

/** First letter up. */
export function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** First letter down, unless it starts with a name (in `names`), "I", or a place/business name. */
export function low(s: string, names: string[] = []): string {
  if (!s) return s;
  const first = s.match(/^[A-Za-z']+/)?.[0] ?? "";
  if (first === "I" || first.startsWith("I'") || names.some((n) => first === n || first === `${n}'s`)) return s;
  if (/^(CityCorp|Hustle|Central|Skyline|The Gilded|City Diner|Marketplace|Cowork|Gerald)\b/.test(s)) return s;
  return s[0].toLowerCase() + s.slice(1);
}

/** Make sure it ends like a sentence. */
export function sentence(s: string): string {
  const t = s
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/([^.])\.\.(?!\.)/g, "$1.")
    .replace(/([!?])\./g, "$1")
    .replace(/([.!?] )([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
  if (!t) return t;
  const c = cap(t);
  return /[.!?…]$/.test(c) ? c : `${c}.`;
}

/** Word count. */
export function words(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}

/** "around Day 11" -> "in a few days" (people don't number their days). */
export function spokenDays(text: string, now: number): string {
  const today = Math.floor(now / 1440) + 1;
  return text.replace(/\b(?:(around|on|by|since|from) )?Day (\d+)\b/g, (_, prep: string | undefined, n: string) => {
    const d = Number(n) - today;
    const rel = d === 0 ? "today" : d === 1 ? "tomorrow" : d === -1 ? "yesterday" : d > 1 && d <= 3 ? "in a couple of days" : d > 3 ? (d <= 8 ? "in about a week" : "in a few weeks") : d >= -3 ? "a couple of days ago" : "a while back";
    return prep === "since" ? `since ${rel === "yesterday" ? "yesterday" : "then"}` : rel;
  });
}
