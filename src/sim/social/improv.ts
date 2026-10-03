import { situation } from "../ai/situation";
import { citizenAcc, transfer } from "../economy/ledger";
import { logEvent } from "../events";
import { remember } from "../memory/memory";
import { dominantEmotion, feel, feelingsToward, strongestFeelingAboutSomeone } from "../mind/emotions";
import { memoryCallback } from "../mind/voice";
import { chance, hashSeed, pick, rand, weightedPick, type RngHolder } from "../rng";
import { happeningById, knows, learnNews, stanceOn } from "../town/happenings";
import type { Citizen, CitizenId, Conversation, ConversationLine, ConvNote, Emotion, Happening, Memory, WorldState } from "../types";
import { capitalise, clamp, money } from "../util";
import { adjustRel, peekRel } from "./relationships";

// Improvised small talk. Instead of a fixed script, each chat is planned from
// what the two people actually have on their minds: news one of them hasn't
// heard, a grudge or a soft spot for someone they both know, money worries,
// how they feel, a dream, a lesson learned the hard way, the weather. Each
// beat is answered according to the listener's own view (sorry or secretly
// glad, envious or pleased, persuaded or not), and leaves notes: news passed
// on, minds changed, friendships warmed or strained. The notes are applied
// when the chat ends, whoever wrote the words (these templates or Claude).

export interface Improv {
  lines: ConversationLine[];
  notes: ConvNote[];
  topics: string[];
  /** Beat-by-beat outline (for Claude, when it writes the words). */
  brief: string[];
  summary: string;
  /** Feed line, when something worth reporting was said. */
  headline: string | null;
}

const LEISURE = new Set(["socialize", "eat", "rest", "talk", "idle", "shop", "browse"]);

function sentence(s: string): string {
  const t = s.trim();
  if (!t) return t;
  const c = t[0].toUpperCase() + t.slice(1);
  return /[.!?…"]$/.test(c) ? c : `${c}.`;
}

/** "Someone broke into my home" -> "someone broke into my home" (names and "I" keep their capitals). */
function lowerStart(world: WorldState, s: string): string {
  const word = s.match(/^[A-Za-z']+/)?.[0] ?? "";
  if (!word || /^I('|$)/.test(word)) return s;
  if (world.citizenOrder.some((id) => world.citizens[id].name === word.replace(/'s$/, ""))) return s;
  return s[0].toLowerCase() + s.slice(1);
}

function firstSentence(text: string): string {
  const m = text.match(/^.+?[.!?](\s|$)/);
  return (m ? m[0] : text).trim();
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function closeness(x: Citizen, y: CitizenId): number {
  if (x.family.includes(y)) return 1;
  return clamp((peekRel(x, y)?.affinity ?? 0) / 60, -1, 1);
}

function hostile(x: Citizen, y: CitizenId): boolean {
  return (peekRel(x, y)?.affinity ?? 0) < -30 || (feelingsToward(x, y).anger ?? 0) > 30;
}

function stanceWord(s: number): string {
  return s <= -0.5 ? "upset" : s < -0.1 ? "sorry about it" : s >= 0.5 ? "pleased" : s > 0.1 ? "quite glad" : "not bothered";
}

/** The most vivid recent memory that stirred this feeling. */
function causeOf(c: Citizen, e: Emotion, now: number): Memory | null {
  let best: Memory | null = null;
  for (const m of [...c.memories.short, ...c.memories.long]) {
    if (now - m.t > 4 * 1440 || m.kind === "conversation") continue;
    const v = m.emotions?.[e] ?? 0;
    if (v >= 8 && (!best || v * m.strength > (best.emotions?.[e] ?? 0) * best.strength)) best = m;
  }
  return best;
}

// ---------------------------------------------------- reactions to news

function reaction(r: RngHolder, world: WorldState, h: Happening, s: number): string {
  const subj = h.subject ? (world.citizens[h.subject]?.name ?? "them") : "them";
  switch (h.kind) {
    case "fire":
      return s < -0.35 ? pick(r, [`No! Poor ${subj}.`, `That's awful. Is ${subj} alright?`, "Oh no. All that stock, gone."]) : s > 0.1 ? pick(r, [`Can't say I'm crying about it. ${subj} had it coming.`, "Well. These things happen, don't they?"]) : pick(r, ["Blimey.", "That's a shame."]);
    case "burglary":
      return s < -0.3 ? pick(r, ["That's horrible. Did they catch anyone?", `Poor ${subj}. I'm double-locking my door tonight.`, "That's terrifying. In our town?"]) : pick(r, ["Hm. Maybe they shouldn't flash their cash about.", "These things happen, I suppose."]);
    case "lottery":
      return s > 0.3 ? pick(r, [`Good for ${subj}! Couldn't happen to a nicer person.`, "Ha! Lucky devil.", `Brilliant. ${subj} deserves a break.`]) : s < -0.1 ? pick(r, ["Typical. Some people get all the luck.", `${subj}? Of course it's ${subj}.`, "Must be nice. I can't even win a raffle."]) : pick(r, ["Lucky them.", "Huh. Good for them, I suppose."]);
    case "celebrity":
      return s > 0.3 ? pick(r, ["Brilliant! They deserve it.", `Good for ${subj}. That'll be great for business.`]) : pick(r, ["Probably paid for it.", "Overrated, if you ask me."]);
    case "food_poisoning":
      return s < -0.2 ? pick(r, ["Ugh. I've eaten there!", "That's disgusting. I'm not going back there.", "Poor thing. That's the worst."]) : pick(r, ["Can't say I'm surprised.", "Never liked that place."]);
    case "festival":
      return s > 0.3 ? pick(r, ["Ooh, I love a festival!", "Brilliant. I'm definitely going."]) : pick(r, ["Crowds and noise. I'll pass.", "Not really my thing, festivals."]);
    case "storm":
      return pick(r, ["I know, it's horrible out there.", "I got soaked on the way over."]);
    case "power_cut":
      return pick(r, ["Ours went off too.", "Nightmare. I couldn't get anything done."]);
    case "rent_rise":
      return pick(r, ["Again?! How are we meant to manage?", "I can barely make rent as it is.", "Unbelievable. Who can afford this?"]);
    case "sculpture":
      return s > 0.3 ? pick(r, ["How mysterious! I'll have to go and see it.", "Ooh. Who do you reckon put it there?"]) : pick(r, ["Bit weird, isn't it?", "Strange. Probably some art student."]);
    case "party":
      return s > 0.3 ? pick(r, ["Ooh, a party! Are you going?", `I love a party. ${subj} always throws a good one.`]) : pick(r, [`I didn't know ${subj} was having a party.`, "Not my sort of thing, parties."]);
  }
}

function opinion(r: RngHolder, world: WorldState, h: Happening, s: number): string {
  const subj = h.subject ? (world.citizens[h.subject]?.name ?? "them") : "them";
  if (h.kind === "festival") return s > 0.3 ? pick(r, ["Best thing to happen round here in ages.", "I love it. The whole town comes out."]) : pick(r, ["Too loud and too crowded for me.", "I'm staying well away."]);
  if (h.kind === "sculpture") return s > 0.3 ? pick(r, ["I think it's beautiful, honestly.", "I like it. Makes the park feel special."]) : pick(r, ["It's just a lump of marble.", "Waste of a good park, if you ask me."]);
  if (h.kind === "rent_rise" || h.kind === "storm" || h.kind === "power_cut") return pick(r, ["I'm worried, to be honest.", "It's just one thing after another.", "We'll get through it, I suppose."]);
  if (s <= -0.4) return pick(r, [`I feel terrible for ${subj}.`, "It's awful, really.", `${subj} didn't deserve that.`]);
  if (s >= 0.4) return h.tone < 0 ? pick(r, [`Honestly? ${subj} had it coming.`, "Can't say I'm sorry."]) : pick(r, [`I'm really pleased for ${subj}.`, "Best news I've heard all week."]);
  if (s < -0.1) return pick(r, ["It's a shame, really.", "Bad luck, that."]);
  return pick(r, ["I don't really have a view on it.", "Eh. Life goes on."]);
}

/** When it happened to the speaker: tell it in the first person. */
function ownStory(r: RngHolder, world: WorldState, h: Happening): string {
  const biz = h.businessId ? world.businesses[h.businessId]?.name : null;
  switch (h.kind) {
    case "fire":
      return pick(r, [`${biz ?? "My shop"} caught fire. I lost ${money(h.amount)} of stock.`, `There was a fire at ${biz ?? "my place"}. ${money(h.amount)} of stock, gone.`]);
    case "burglary":
      return pick(r, [`Someone broke into my place and took ${money(h.amount)}.`, `I got burgled. They took ${money(h.amount)}.`]);
    case "lottery":
      return pick(r, [`I won the lottery! ${money(h.amount)}!`, `You won't believe it. I won ${money(h.amount)} on the lottery.`]);
    case "celebrity":
      return pick(r, [`A celebrity came to ${biz ?? "my place"}! We've been rammed ever since.`, `Guess who came to ${biz ?? "my shop"}? Someone off the telly!`]);
    case "food_poisoning":
      return `Someone got food poisoning at ${biz ?? "my café"}. We've had to shut for a deep clean.`;
    case "party":
      return pick(r, ["It's my birthday! I'm having a few drinks at the pub tonight. You should come.", "I'm throwing a birthday party at the pub tonight. Come along!"]);
    default:
      return firstSentence(h.text);
  }
}

/** The person it happened to, a day or two later. */
function ownAfter(r: RngHolder, h: Happening): string {
  switch (h.kind) {
    case "lottery":
      return pick(r, ["I'm still buzzing about the lottery win, honestly.", "I keep checking my bank balance. It's real!"]);
    case "celebrity":
      return pick(r, ["We're still rammed since that celebrity visit.", "I still can't believe someone famous came to my place."]);
    case "party":
      return pick(r, ["Thanks for coming to my party, by the way.", "My head still hurts from the party."]);
    case "fire":
      return pick(r, ["Still getting over the fire, to be honest.", "I'm still clearing up after the fire."]);
    case "burglary":
      return pick(r, ["I still don't feel safe since the break-in.", "I've not slept properly since the break-in."]);
    case "food_poisoning":
      return "I'm still mortified about the food poisoning business.";
    default:
      return pick(r, ["What a week it's been.", "I'm still not over it, honestly."]);
  }
}

/** A lesson put the way you'd give it as advice (null: it's personal, not advice). */
function asAdvice(world: WorldState, text: string): string | null {
  const t = text.replace(/[.!]+$/, "");
  let m: RegExpMatchArray | null;
  if (/^I owe |^I'm |^My research|^Looking for work|^I need to get out/.test(t)) return null;
  if (t === "A steady wage suits me") return "A steady wage is underrated, you know.";
  if (/^Freelancing is paying off/.test(t)) return "Freelancing pays, if you're any good. It's worked for me.";
  if (/feel for the markets/.test(t)) return "The markets are learnable, you know. It just takes time.";
  if (/^There's real money/.test(t)) return `${t}. Trust me.`;
  if ((m = t.match(/^(.+) always lets me down$/))) return `${m[1]} always lets people down, in my experience.`;
  if ((m = t.match(/^(.+) can't be trusted$/))) return `${m[1]} can't be trusted. Take it from me.`;
  if ((m = t.match(/^I should watch myself around (.+)$/))) return `Watch yourself around ${m[1]}.`;
  if ((m = t.match(/^(.+) is good people$/))) return `${m[1]} is good people, you know.`;
  if ((m = t.match(/^(.+) has my back$/))) return `${m[1]} is someone you can count on.`;
  if ((m = t.match(/^(.+) works for me$/))) return `${m[1]} has worked out well for me.`;
  if ((m = t.match(/^(.+) isn't paying like I hoped$/))) return `Between you and me, ${lowerStart(world, m[1])} doesn't pay what it should.`;
  if (/keep more money aside/.test(t)) return "Keep some money aside for rent. I learned that the hard way.";
  return `Take it from me: ${lowerStart(world, t)}.`;
}

function question(r: RngHolder, world: WorldState, h: Happening): [string, string] | null {
  switch (h.kind) {
    case "fire":
      return ["Was anyone hurt?", `Nobody hurt, thank goodness. But they lost ${money(h.amount)} of stock.`];
    case "burglary":
      return ["Do they know who did it?", pick(r, ["No idea. Makes you want to lock everything twice.", "Not a clue. The police weren't much help."])];
    case "lottery":
      return ["How much did they win?", `${money(h.amount)}! Can you believe it?`];
    case "celebrity":
      return ["Who was it?", "Someone famous off the telly. Half the town's queuing to get in now."];
    case "food_poisoning":
      return ["Is everyone alright?", "They'll live. Not sure the café's reputation will, mind."];
    case "storm":
      return ["How long's it meant to last?", "Till tonight, they reckon."];
    case "power_cut":
      return ["When's it coming back on?", "Nobody knows. A couple of hours, hopefully."];
    case "rent_rise":
      return ["How much this time?", "Five percent. On top of everything else."];
    case "sculpture":
      return ["Who put it there?", pick(r, ["Nobody knows. That's the weird part.", "Some say it's art. Some say aliens."])];
    default:
      return null;
  }
}

// --------------------------------------------- answers from real life

function dayStart(t: number): number {
  return Math.floor(t / 1440) * 1440;
}

/** The thing that happened to them today that they'd mention first, if any. */
function todaysNews(c: Citizen, now: number): Memory | null {
  let best: Memory | null = null;
  for (const m of c.memories.short.concat(c.memories.long)) {
    if (m.t < dayStart(now) || m.kind === "conversation" || m.kind === "social" || m.kind === "insight" || m.importance < 6 || Math.abs(m.valence) < 0.6) continue;
    if (!/\b(I|me|my)\b/.test(m.text) || /^(Talked|Chatted)/.test(m.text)) continue;
    if (!best || m.importance * Math.abs(m.valence) > best.importance * Math.abs(best.valence)) best = m;
  }
  return best;
}

/** "How are you?", answered from their actual day: the weather, a big moment, tiredness, hunger, or how they feel. */
function howTheyAre(r: RngHolder, world: WorldState, c: Citizen, short = false): string {
  const storm = world.happenings.some((h) => h.kind === "storm" && !h.ended && world.time >= h.t && world.time < h.until);
  if (storm && !c.insideId) return pick(r, ["Soaked to the skin.", "Drenched. Have you seen it out there?", "Wet. Very wet."]);
  const m = todaysNews(c, world.time);
  if (m) return `${m.valence > 0 ? pick(r, ["Great, actually.", "Brilliant day.", "Not bad at all."]) : pick(r, ["Not great.", "Rough day.", "Honestly? Awful."])} ${sentence(m.text)}`;
  const s = situation(world, c);
  if (s.tired > 0.78 && chance(r, 0.5)) return pick(r, ["Knackered, honestly.", "Shattered. Could sleep standing up.", "Running on fumes."]);
  if (s.hungry > 0.75 && chance(r, 0.4)) return pick(r, ["Starving, to be honest.", "Hungry. I could eat a horse."]);
  const d = dominantEmotion(c);
  const how: Partial<Record<Emotion, string[]>> = {
    sadness: ["Not great, honestly.", "I've had better weeks."],
    anger: ["Don't ask.", "Fuming, if I'm honest."],
    fear: ["Bit on edge, to be honest.", "Worried, mostly."],
    joy: ["Brilliant, actually!", "Really good, thanks!", "Never better."],
    loneliness: ["Better now someone's talking to me.", "Bit quiet, to be honest."],
    love: ["Can't complain at all.", "Happy, actually. Properly happy."],
    envy: ["Fine. Some of us have to work for it."],
    pride: ["Pretty good, actually.", "Rather pleased with myself, if I'm honest."],
    gratitude: ["Good, thanks. People have been kind."],
    shame: ["Oh, you know. Getting by."],
  };
  const pool = (d && how[d.emotion]) || ["Can't complain.", "Same old, same old.", "Getting by.", "Not bad, not bad.", "Mustn't grumble.", "Fine, thanks.", "Surviving.", "All good here."];
  return short ? pool[0] : pick(r, pool);
}

/** Where they work, as they'd say it. */
function workplace(world: WorldState, c: Citizen): string | null {
  if (c.employerId === "corp") return "CityCorp";
  return c.employerId ? (world.businesses[c.employerId]?.name ?? null) : null;
}

function workQuestion(r: RngHolder, world: WorldState, x: Citizen, biz: Citizen["businessIds"][number] | null): string {
  const b = biz ? world.businesses[biz] : null;
  if (b) return pick(r, [`How's ${b.name} doing?`, "How's business?", "Shop busy?", `Still run off your feet at ${b.name}?`]);
  const place = workplace(world, x);
  switch (x.occupation) {
    case "unemployed":
      return pick(r, ["Any luck finding work?", "Still looking for something?", "Anything come up, job-wise?"]);
    case "researcher":
      return pick(r, ["How's the research going?", "Invented anything yet?", "Any breakthroughs?"]);
    case "trader":
      return pick(r, ["How are the markets treating you?", "Making a killing yet?", "Buy low, sell high?"]);
    case "reseller":
      return pick(r, ["Find any bargains today?", "Flipped anything good lately?", "Still buying and selling?"]);
    case "freelancer":
      return pick(r, ["Clients keeping you busy?", "Enough work coming in?", "How's the freelancing going?"]);
    default:
      return place ? pick(r, [`How's it going at ${place}?`, `${place} treating you alright?`, "How's work?", "Keeping busy?"]) : pick(r, ["How's work?", "Keeping busy?", "Work treating you alright?"]);
  }
}

/** How work's really going, with real numbers where they have them. */
function workAnswer(r: RngHolder, world: WorldState, x: Citizen, avg: number): { answer: string; good: boolean } {
  const biz = x.businessIds.map((id) => world.businesses[id]).find((q) => q && q.open);
  const hour = Math.floor((world.time % 1440) / 60);
  if (biz) {
    const n = biz.today.customers;
    if (biz.missedToday >= 3) return { answer: pick(r, [`Busy, but we keep running out of stock. That's ${biz.missedToday} sales missed today.`, `Can't keep the shelves full. Turned away ${biz.missedToday} customers today.`]), good: false };
    if (biz.avgProfit > 30) return { answer: pick(r, [`${biz.name} is doing great: about ${money(biz.avgProfit)} a day!`, n >= 5 ? `Run off my feet. ${n} customers already today.` : `Really well. About ${money(biz.avgProfit)} a day profit.`]), good: true };
    if (biz.avgProfit < 0) return { answer: pick(r, [`Honestly? ${biz.name} is struggling.`, "The rent's eating me alive.", `${n <= 1 ? "Hardly a customer all day." : `Only ${n} customers today.`} I'm worried.`]), good: false };
    if (hour >= 11 && n >= 2) return { answer: pick(r, [`Steady. ${n} customers so far today.`, `Not bad. ${n} through the door today.`]), good: false };
  }
  const place = workplace(world, x);
  const today = x.finance.occToday;
  if (avg > 45) return { answer: pick(r, [`Really well, actually. I'm making about ${money(avg)} a day.`, `Can't complain at all: ${money(avg)} a day, give or take.`]), good: true };
  switch (x.occupation) {
    case "unemployed": {
      const days = Math.floor((world.time - x.occupationSince) / 1440);
      return { answer: days >= 2 ? pick(r, [`${days} days now and nothing.`, `Nothing yet. ${days} days of looking.`]) : pick(r, ["Still looking. It's grim out there.", "Nothing yet. Something'll turn up."]), good: false };
    }
    case "researcher":
      return { answer: x.research.breakthroughs > 0 ? pick(r, ["Working on the next big thing.", "One breakthrough down. Chasing another."]) : x.research.points > 50 ? pick(r, ["I think I'm close to something.", "Getting somewhere, I think. Slowly."]) : pick(r, ["Slow. Science is slow.", "Lots of dead ends."]), good: false };
    case "freelancer":
      return { answer: today > 15 ? `${money(today)} from clients so far today. Not bad.` : pick(r, ["Feast or famine, freelancing.", "Waiting on clients. Always waiting."]), good: false };
    case "reseller":
    case "trader": {
      const deal = x.memories.short.find((m) => m.t >= dayStart(world.time) && m.kind === "deal" && /£/.test(m.text) && /\b(I|my)\b/.test(m.text));
      if (deal) return { answer: sentence(deal.text), good: deal.valence > 0 };
      return { answer: pick(r, ["Quiet day on the markets.", "Waiting for the right deal.", "Prices are all over the place."]), good: false };
    }
  }
  if (place && today > 0) return { answer: pick(r, [`Long shift at ${place}. ${money(today)} in the bag today, mind.`, `Same as ever at ${place}.`]), good: false };
  return { answer: pick(r, ["Ticking along.", "Could be better, could be worse.", "Same as ever.", "Busy, which is good, I suppose.", "Quiet, to be honest.", "Don't get me started."]), good: false };
}

/** A product whose wholesale price moved a lot since yesterday (people notice). */
function priceSwing(world: WorldState): { name: string; pct: number; pid: string } | null {
  let best: { name: string; pct: number; pid: string } | null = null;
  for (const [pid, m] of Object.entries(world.market)) {
    const tape = m.tape;
    if (tape.length < 25) continue;
    const now = tape[tape.length - 1];
    const then = tape[tape.length - 25];
    if (!(then > 0)) continue;
    const pct = Math.round((now / then - 1) * 100);
    const p = world.products[pid];
    if (p && Math.abs(pct) >= 15 && (!best || Math.abs(pct) > Math.abs(best.pct))) best = { name: p.name.toLowerCase(), pct, pid };
  }
  return best;
}

/** Things two people who like the same thing say about it: [opener, reply] pairs. */
const SHARED_LIKE: Record<string, [string, string][]> = {
  "the pub": [["Pint later?", "Go on then."], ["Fancy the pub after this?", "Twist my arm."]],
  "the park": [["Walk round the park later?", "I'd like that."], ["The park's lovely this time of year.", "It really is."]],
  coffee: [["Coffee sometime? My treat.", "You're on."], ["I'd kill for a proper coffee.", "Same. I live on the stuff."]],
  "football on the radio": [["Did you catch the football last night?", "Don't. What a game!"], ["What about that match, eh?", "I was shouting at the radio."]],
  books: [["Read anything good lately?", "Halfway through a thriller. Can't put it down."], ["I've just finished a cracking book.", "Lend it to me when you're done?"]],
  cooking: [["Made a proper stew last night. You'd have loved it.", "Save me some next time!"], ["Got a new recipe to try this weekend.", "Oh, go on, what is it?"]],
  gadgets: [["Have you seen the new phones at the market?", "Don't tempt me."], ["I've got my eye on a new gadget.", "Ooh, show me later."]],
  "people-watching": [["Good spot for people-watching, this.", "The best."], ["You see all sorts round here.", "Never a dull moment."]],
  "a long lie-in": [["Had a lie-in this morning. Bliss.", "Jealous."], ["What I'd give for a lie-in.", "Tell me about it."]],
  "quiet evenings": [["Quiet night in tonight, I think.", "Sounds perfect."], ["I just want a quiet evening.", "Same. Feet up."]],
  "a good bargain": [["Got a cracking bargain at the market.", "Where? Tell me!"], ["There's always a bargain if you look.", "You've got the eye for it."]],
};

/** A pet hate the moment has set off, if any. */
function gripe(world: WorldState, x: Citizen): { dislike: string; line: string[] } | null {
  const hour = Math.floor((world.time % 1440) / 60);
  const where = x.insideId ? world.map.buildings.find((b) => b.id === x.insideId)?.type : null;
  const festival = world.happenings.some((h) => h.kind === "festival" && !h.ended && world.time < h.until && knows(x, h.id));
  for (const d of x.personality.dislikes) {
    if (d === "early mornings" && hour >= 5 && hour < 9) return { dislike: d, line: ["Too early for this.", "I hate mornings. I really do."] };
    if (d === "crowds" && festival) return { dislike: d, line: ["Too many people about for my liking.", "This festival crowd is doing my head in."] };
    if (d === "the diner's coffee" && where === "diner") return { dislike: d, line: ["The coffee in here is awful.", "Who makes coffee this bad?"] };
    if (d === "waiting around" && x.activity.kind === "shop") return { dislike: d, line: ["I've been queueing for ages.", "Why is everything so slow today?"] };
    if (d === "debt" && world.loans.some((l) => l.borrower === x.id && l.status === "active")) return { dislike: d, line: ["I hate owing money.", "Being in debt keeps me up at night."] };
  }
  return null;
}

/** "Build up £300 of savings" -> "I'm trying to build up £300 of savings." */
function planLine(world: WorldState, x: Citizen): string | null {
  const g = x.goal;
  if (!g?.label) return null;
  if (g.kind === "survive") return "I need to get off the streets. Save up for a deposit.";
  const label = lowerStart(world, g.label.replace(/[.!]+$/, ""));
  return `I'm trying to ${label}.`;
}

/** A goodbye that fits the moment: bedtime, hunger, work waiting, the weather, or just the friendship. */
function goodbye(r: RngHolder, world: WorldState, x: Citizen, y: Citizen, close: boolean, storm: boolean): string {
  const hour = Math.floor((world.time % 1440) / 60);
  const pool: string[] = close
    ? ["Good talking to you.", "Let's catch up properly soon.", "Right, I'd better get on. Take care.", "Don't be a stranger.", "Always a pleasure."]
    : ["Anyway, I'd better get going.", "Right, back to it.", "Nice chatting.", "Catch you later.", "Mind how you go.", "See you around.", "I'll let you get on."];
  if (hour >= 21 || hour < 4) pool.push("Right, bed for me.", "It's getting late. Night!");
  if (situation(world, x).hungry > 0.6) pool.push("I'm off to find something to eat.", "My stomach's rumbling. Catch you later.");
  if (x.activity.kind === "work") pool.push("Better get back to it before anyone notices.", "Duty calls.");
  if (storm) pool.push("Stay dry!", "Mind the puddles.");
  const fam = y.family.map((id) => world.citizens[id]).find((f) => f && f.id !== x.id && (peekRel(x, f.id)?.familiarity ?? 0) >= 8);
  if (fam && close) pool.push(`Say hi to ${fam.name} for me.`);
  return pick(r, pool);
}

// ------------------------------------------------------------ the chat

/** Plan and voice a whole chat between a and b. */
export function improvise(world: WorldState, conv: Conversation, a: Citizen, b: Citizen): Improv {
  const r: RngHolder = { rng: hashSeed(`${world.seed}:${conv.id}:improv`) };
  const lines: ConversationLine[] = [];
  const notes: ConvNote[] = [];
  const topics: string[] = [];
  const brief: string[] = [];
  const used = new Set<string>();
  let headline: string | null = null;
  const ab = (c: Citizen) => (c.id === a.id ? "A" : "B");
  const say = (c: Citizen, text: string) => lines.push({ speaker: c.id, text: sentence(text) });
  const hour = Math.floor((world.time % 1440) / 60);
  const leisure = LEISURE.has(a.activity.kind) && LEISURE.has(b.activity.kind);
  const maxLines = leisure ? 14 : 6;
  const room = (n: number) => lines.length + n <= maxLines - 1;
  const fam = peekRel(a, b.id)?.familiarity ?? 0;
  const enemies = hostile(a, b.id) || hostile(b, a.id);
  const storm = world.happenings.some((h) => h.kind === "storm" && !h.ended && world.time >= h.t && world.time < h.until);

  // --- hello
  if (fam < 5 && !a.family.includes(b.id)) {
    say(a, pick(r, [`Hi, I don't think we've met. I'm ${a.name}.`, `Hello! I'm ${a.name}. I've seen you around.`]));
    say(b, pick(r, [`${b.name}. Nice to meet you.`, `Hi ${a.name}, I'm ${b.name}.`]));
    brief.push("A and B meet for the first time and introduce themselves.");
  } else if (enemies) {
    say(a, memoryCallback(a, b, "greet", `${conv.id}:g`, Math.floor(world.time / 1440)) ?? pick(r, ["Oh. It's you.", `${b.name}.`]));
    say(b, hostile(b, a.id) ? pick(r, ["Don't start.", "What do you want?"]) : pick(r, [`Alright, ${a.name}.`, "Hello to you too."]));
    brief.push("A and B don't get on; the greeting is frosty.");
  } else {
    const close = closeness(a, b.id) > 0.4;
    const cb = memoryCallback(a, b, "greet", `${conv.id}:g`, Math.floor(world.time / 1440));
    const hello = hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";
    const where = conv.buildingId ? world.map.buildings.find((x) => x.id === conv.buildingId)?.type : null;
    const here: Record<string, string[]> = {
      pub: [`${b.name}! What are you drinking?`, `Fancy seeing you in here, ${b.name}.`],
      park: [`Lovely day for it, ${b.name}.`, `${b.name}! Getting some fresh air?`],
      diner: [`${b.name}! What's good today?`, "Grabbing a bite too?"],
      cafe: [`${b.name}! Caffeine break?`],
      market: [`${b.name}! Bargain hunting?`],
    };
    const greetings = close ? [`${b.name}! There you are.`, `Alright ${b.name}? How's things?`, `${b.name}! Long day?`, `Hey, ${b.name}. How are you?`] : [`${hello}, ${b.name}.`, `Alright ${b.name}?`, `${hello}! How are you doing?`, `Oh, hi ${b.name}. How's it going?`];
    say(a, cb ?? pick(r, [...greetings, ...((where && here[where]) || [])]));
    const fine = howTheyAre(r, world, b);
    const askBack = !close || chance(r, 0.5);
    say(b, askBack ? `${fine} You?` : fine);
    if (askBack) {
      const mine = howTheyAre(r, world, a);
      say(a, mine === fine ? pick(r, ["Same, actually.", "Ha. Same here.", "Snap."]) : mine);
    }
    const d = dominantEmotion(b);
    brief.push(`A greets B${close ? " (they're close)" : ""}; B says how they are${d ? ` (mostly ${d.emotion})` : ""}${askBack ? " and asks back" : ""}.`);
  }

  // --- what each of them could bring up
  type Cand = { key: string; weight: number; run: () => void };
  const candidates = (x: Citizen, y: Citizen): Cand[] => {
    const out: Cand[] = [];
    const X = ab(x);
    const Y = ab(y);
    // News the other hasn't heard.
    for (const k of x.news) {
      const h = happeningById(world, k.id);
      if (!h || world.time - k.t > 72 * 60 || h.subject === y.id) continue;
      const key = `news:${h.id}`;
      if (used.has(key)) continue;
      const ageF = 1.5 - (world.time - k.t) / (72 * 60);
      if (!knows(y, h.id)) {
        out.push({
          key,
          weight: h.scale * ageF * (0.6 + x.traits.sociability) * 2.2,
          run: () => {
            const sy = stanceOn(world, y, h);
            k.talked = (k.talked ?? 0) + 1;
            if (h.subject === x.id) {
              say(x, pick(r, ["I've had quite a day.", "You'll never guess what happened to me.", "Can I tell you something?"]));
              say(y, pick(r, ["Go on.", "What happened?", "Uh oh. What is it?"]));
              say(x, ownStory(r, world, h));
            } else if (chance(r, 0.5)) {
              say(x, pick(r, [`Did you hear about ${h.about}?`, `Have you heard about ${h.about}?`]));
              say(y, pick(r, ["No, what happened?", "No! Tell me.", "What? No."]));
              say(x, firstSentence(h.text));
            } else {
              say(x, pick(r, [`Have you heard? ${firstSentence(h.text)}`, `Big news: ${lowerStart(world, firstSentence(h.text))}`, `You'll never guess. ${firstSentence(h.text)}`]));
            }
            say(y, reaction(r, world, h, sy));
            const qa = question(r, world, h);
            if (qa && room(2) && chance(r, 0.65)) {
              say(y, qa[0]);
              say(x, qa[1]);
            }
            if (room(1) && Math.abs(k.stance - sy) > 0.8) {
              say(x, opinion(r, world, h, k.stance));
              const concede = y.personality.big5.agreeableness > 0.6 && (peekRel(y, x.id)?.trust ?? 0) > 20;
              if (room(1)) say(y, concede ? pick(r, ["Maybe you're right.", "Hm. I hadn't thought of it like that."]) : pick(r, ["Each to their own.", "I don't see it that way."]));
              if (concede) notes.push({ t: "stance", who: y.id, id: h.id, delta: (k.stance - sy) * 0.3 });
              else notes.push({ t: "rel", who: y.id, about: x.id, affinity: -1, trust: 0 });
            }
            notes.push({ t: "news", from: x.id, to: y.id, id: h.id });
            topics.push(h.about);
            brief.push(`${X} tells ${Y} about ${h.about}${h.subject === x.id ? ` (it happened to ${X})` : ""} (${Y} hadn't heard, and is ${stanceWord(sy)}).`);
            headline ??= h.subject === x.id ? `🗞️ ${x.name} told ${y.name} what happened to them: ${lowerStart(world, h.title)}.` : `🗞️ ${x.name} told ${y.name} about ${h.about}.`;
          },
        });
      } else {
        const ky = knows(y, h.id)!;
        const debate = Math.abs(k.stance - ky.stance) > 0.6;
        const stale = 1 / (1 + (k.talked ?? 0) + (ky.talked ?? 0));
        out.push({
          key,
          weight: h.scale * ageF * 0.45 * (debate ? 1.6 : 1) * stale,
          run: () => {
            k.talked = (k.talked ?? 0) + 1;
            ky.talked = (ky.talked ?? 0) + 1;
            say(x, h.subject === x.id ? ownAfter(r, h) : pick(r, [`What do you make of ${h.about}?`, `Still can't believe ${h.about}.`, `So, ${h.about}. What a week.`, `Everyone's talking about ${h.about}.`]));
            say(y, opinion(r, world, h, ky.stance));
            if (debate && room(2)) {
              say(x, opinion(r, world, h, k.stance));
              const concede = y.personality.big5.agreeableness > 0.6 && (peekRel(y, x.id)?.trust ?? 0) > 25;
              say(y, concede ? pick(r, ["Fair point, actually.", "Maybe you're right."]) : pick(r, ["We'll have to agree to disagree.", "No, I still think I'm right."]));
              if (concede) notes.push({ t: "stance", who: y.id, id: h.id, delta: (k.stance - ky.stance) * 0.3 });
              else notes.push({ t: "rel", who: y.id, about: x.id, affinity: -1, trust: 0 }, { t: "rel", who: x.id, about: y.id, affinity: -1, trust: 0 });
            } else if (!debate) {
              notes.push({ t: "rel", who: y.id, about: x.id, affinity: 1.5, trust: 0.5 });
            }
            topics.push(h.about);
            brief.push(`${X} and ${Y} talk about ${h.about}; ${debate ? "they disagree" : "they see it the same way"}.`);
          },
        });
      }
    }
    // Gossip about someone they both know.
    const f = strongestFeelingAboutSomeone(world, x);
    const z = f && f.id !== y.id ? world.citizens[f.id] : null;
    if (f && z && (peekRel(y, z.id)?.familiarity ?? 0) >= 8 && !used.has(`gossip:${z.id}`)) {
      out.push({
        key: `gossip:${z.id}`,
        weight: (f.level / 40) * (0.5 + x.traits.sociability) * (closeness(x, y.id) > 0 ? 1 : 0.4),
        run: () => {
          const bad = f.emotion === "anger" || f.emotion === "envy";
          const mem = [...x.memories.long, ...x.memories.short].filter((m) => m.people.includes(z.id) && (bad ? m.valence < -0.3 : m.valence > 0.3) && m.kind !== "conversation").sort((p, q) => q.importance * q.strength - p.importance * p.strength)[0];
          const opener =
            f.emotion === "anger"
              ? [`${z.name} has been driving me up the wall.`, `Don't get me started on ${z.name}.`]
              : f.emotion === "envy"
                ? [`Have you seen how well ${z.name} is doing? Unbelievable.`, `${z.name} makes it all look so easy.`]
                : [`${z.name} has been so good to me lately.`, `${z.name} is one of the good ones, you know.`];
          say(x, pick(r, opener));
          if (mem && room(1) && !/^Talked with/.test(mem.text)) say(x, mem.text);
          const yz = closeness(y, z.id) + ((feelingsToward(y, z.id).anger ?? 0) > 20 ? -0.6 : 0);
          let agree: boolean;
          if (bad) {
            agree = yz < -0.15;
            say(y, yz > 0.35 ? pick(r, [`Really? ${z.name}'s always been alright with me.`, `Give ${z.name} a chance.`]) : agree ? pick(r, ["Tell me about it.", "Doesn't surprise me one bit."]) : pick(r, [`Hm. I don't really know ${z.name} that well.`, "Is that right?"]));
          } else {
            agree = yz > -0.15;
            say(y, yz < -0.35 ? pick(r, [`${z.name}? Not from where I'm standing.`, "Hm. If you say so."]) : pick(r, [`That's nice. ${z.name} seems decent.`, "Good to hear."]));
          }
          const trust = peekRel(y, x.id)?.trust ?? 0;
          if (trust > 25 && Math.abs(yz) < 0.35) notes.push({ t: "rel", who: y.id, about: z.id, affinity: bad ? -3 : 3, trust: bad ? -2 : 2 });
          notes.push({ t: "rel", who: x.id, about: y.id, affinity: agree ? 2 : -1, trust: 0 });
          topics.push(z.name);
          brief.push(`${X} ${bad ? "complains about" : "speaks warmly of"} ${z.name} (${f.emotion}); ${Y} ${agree ? "agrees" : yz > 0.35 || yz < -0.35 ? "pushes back" : "doesn't know them well"}.`);
          headline ??= `💬 ${x.name} and ${y.name} ${bad ? "gossiped about" : "talked about"} ${z.name}.`;
        },
      });
    }
    // Money worries, to someone they trust.
    const s = situation(world, x);
    if (s.worry && (closeness(x, y.id) > 0.3 || x.emotions.fear > 50) && !used.has("worry")) {
      out.push({
        key: "worry",
        weight: 1.2 + s.pressure,
        run: () => {
          say(x, s.worry!);
          const kind = y.personality.big5.agreeableness > 0.5 || closeness(y, x.id) > 0.5;
          const save = y.reflections.some((l) => l.key === "money:save");
          const canGive = y.traits.generosity > 0.6 && closeness(y, x.id) > 0.6 && y.money > 120 && s.pressure > 0.6;
          if (canGive) {
            const amount = Math.min(50, Math.round((15 + y.traits.generosity * 35) / 5) * 5);
            say(y, pick(r, [`Here, take ${money(amount)}. Pay me back whenever.`, `Don't be daft. Take ${money(amount)} and get yourself sorted.`]));
            if (room(1)) say(x, pick(r, ["Seriously? Thank you.", "You're a lifesaver."]));
            notes.push({ t: "gift", from: y.id, to: x.id, amount, why: "money worries" });
          } else if (kind) {
            say(y, save ? "Put a bit aside every day. That's what I do now." : pick(r, ["That's rough. If you need anything, shout.", "Oh no. Is there anything I can do?"]));
            notes.push({ t: "feel", who: x.id, e: { fear: -4, loneliness: -4 } }, { t: "rel", who: x.id, about: y.id, affinity: 3, trust: 2 });
          } else {
            say(y, pick(r, ["Maybe cut back on the café lunches, then.", "Everyone's skint. Join the club."]));
            notes.push({ t: "feel", who: x.id, e: { sadness: 3 } }, { t: "rel", who: x.id, about: y.id, affinity: -2, trust: 0 });
          }
          topics.push("money worries");
          brief.push(`${X} admits money worries ("${s.worry}"); ${Y} ${canGive ? "gives them some money" : kind ? "is sympathetic" : "isn't very sympathetic"}.`);
          headline ??= canGive ? `💬 ${y.name} helped ${x.name} out with a bit of cash.` : `💬 ${x.name} opened up to ${y.name} about money worries.`;
        },
      });
    }
    // How they really feel.
    const d = dominantEmotion(x);
    if (d && d.level >= 40 && d.emotion !== "joy" && d.emotion !== "love" && d.emotion !== "pride" && d.emotion !== "gratitude" && closeness(x, y.id) > 0.2 && !used.has("feelings")) {
      out.push({
        key: "feelings",
        weight: 0.8 + d.level / 100,
        run: () => {
          const line: Partial<Record<Emotion, string>> = {
            sadness: "I've been feeling really low lately.",
            fear: "I can't stop worrying, to be honest.",
            anger: "I'm just so angry at the moment.",
            loneliness: "I've been a bit lonely, if I'm honest.",
            envy: "Everyone seems to be doing better than me.",
            shame: "I made a right mess of things.",
          };
          say(x, line[d.emotion] ?? "I've not been myself lately.");
          const cause = causeOf(x, d.emotion, world.time);
          if (cause && room(1)) say(x, `Ever since ${lowerStart(world, cause.text.replace(/[.!]+$/, ""))}.`);
          const supportive = y.personality.big5.agreeableness > 0.5 || closeness(y, x.id) > 0.5;
          say(y, supportive ? pick(r, ["I'm sorry. You can always talk to me.", "That sounds hard. Want to grab a drink later?", "Come here. It'll be alright."]) : pick(r, ["Chin up. Could be worse.", "Hm. We've all got problems."]));
          if (supportive) notes.push({ t: "feel", who: x.id, e: { [d.emotion]: -6, loneliness: -5 } }, { t: "rel", who: x.id, about: y.id, affinity: 4, trust: 2 });
          else notes.push({ t: "rel", who: x.id, about: y.id, affinity: -2, trust: 0 });
          topics.push(`how ${x.name} feels`);
          brief.push(`${X} admits feeling ${d.emotion}${cause ? ` since: "${cause.text}"` : ""}; ${Y} is ${supportive ? "supportive" : "dismissive"}.`);
          headline ??= `💬 ${x.name} opened up to ${y.name}.`;
        },
      });
    }
    // A dream, between close friends at leisure.
    if (closeness(x, y.id) > 0.5 && leisure && !used.has("dream")) {
      out.push({
        key: "dream",
        weight: 0.45,
        run: () => {
          const dream = x.personality.dream.replace(/\btheir\b/g, "my");
          say(x, pick(r, [`Can I tell you something? I keep thinking about ${dream}.`, `You know what I really want? ${dream[0].toUpperCase()}${dream.slice(1)}.`]));
          const shared = x.personality.values.some((v) => y.personality.values.includes(v));
          const keen = shared || y.personality.big5.agreeableness > 0.55;
          say(y, keen ? pick(r, ["You should go for it.", "You'd be great at that. I mean it."]) : pick(r, ["Big dreams. Rent first, eh?", "Good luck with that."]));
          notes.push(keen ? { t: "feel", who: x.id, e: { joy: 5, pride: 3 } } : { t: "feel", who: x.id, e: { sadness: 2 } }, { t: "rel", who: x.id, about: y.id, affinity: keen ? 3 : -1, trust: keen ? 2 : 0 });
          topics.push(`${x.name}'s dream`);
          brief.push(`${X} shares a dream (${x.personality.dream}); ${Y} is ${keen ? "encouraging" : "sceptical"}.`);
        },
      });
    }
    // Advice learned the hard way.
    const lesson = [...x.reflections].sort((p, q) => q.strength - p.strength).find((l) => !used.has(`lesson:${l.key}`) && asAdvice(world, l.text) !== null && (l.kind === "person" ? l.about !== y.id && (peekRel(y, l.about ?? "")?.familiarity ?? 0) >= 8 : l.kind === "work" ? l.key.includes(`:${y.occupation}:`) : l.kind === "money"));
    if (lesson) {
      out.push({
        key: `lesson:${lesson.key}`,
        weight: 0.6 * lesson.strength,
        run: () => {
          say(x, asAdvice(world, lesson.text)!);
          const about = lesson.about ? world.citizens[lesson.about] : null;
          const fond = about ? closeness(y, about.id) > 0.4 : false;
          say(y, fond && about ? `Funny, I've always found ${about.name} fine.` : pick(r, ["Noted.", "Good to know.", "I'll bear that in mind."]));
          if (about && !fond && (peekRel(y, x.id)?.trust ?? 0) > 20) notes.push({ t: "rel", who: y.id, about: about.id, affinity: lesson.valence < 0 ? -2 : 2, trust: lesson.valence < 0 ? -3 : 3 });
          topics.push(about ? about.name : "some advice");
          brief.push(`${X} passes on a lesson: "${lesson.text}"; ${Y} ${fond ? "disagrees" : "takes note"}.`);
        },
      });
    }
    // Business and work.
    if (!used.has(`work:${x.id}`)) {
      const biz = x.businessIds.map((id) => world.businesses[id]).find((q) => q && q.open);
      const earn = x.finance.occupationEarnings.slice(-3);
      const avg = earn.length ? earn.reduce((p, q) => p + q, 0) / earn.length : 0;
      out.push({
        key: `work:${x.id}`,
        weight: 0.35,
        run: () => {
          say(y, workQuestion(r, world, x, biz?.id ?? null));
          const { answer, good } = workAnswer(r, world, x, avg);
          say(x, answer);
          const yEarn = y.finance.occupationEarnings.slice(-3);
          const yAvg = yEarn.length ? yEarn.reduce((p, q) => p + q, 0) / yEarn.length : 0;
          const envious = good && yAvg < avg * 0.5 && (y.traits.competitiveness > 0.6 || y.emotions.envy > 30);
          if (room(1)) say(y, good ? (envious ? pick(r, ["Must be nice.", "Alright, no need to rub it in.", "Some of us aren't so lucky."]) : pick(r, ["Good for you.", "Nice one!", "Glad to hear it.", "That's brilliant."])) : pick(r, ["Hang in there.", "It'll pick up.", "Fair enough.", "That's the way it goes.", "Ah well. Onwards.", "Sounds about right.", "Rather you than me."]));
          if (envious) notes.push({ t: "feel", who: y.id, e: { envy: 6 } });
          topics.push(biz ? biz.name : "work");
          brief.push(`${Y} asks about work; ${X} says: "${answer}"${envious ? `; ${Y} is envious` : ""}.`);
        },
      });
    }
    // What they're working towards.
    const plan = planLine(world, x);
    if (plan && !used.has(`plan:${x.id}`) && closeness(x, y.id) > 0.1 && !(x.goal.kind === "beat_rival" && x.goal.label.includes(y.name))) {
      out.push({
        key: `plan:${x.id}`,
        weight: 0.4,
        run: () => {
          if (chance(r, 0.5)) say(x, pick(r, ["I've made up my mind about something.", "Can I tell you what I'm up to?", "I've got a plan, you know."]));
          say(x, plan);
          const target = x.goal.target;
          const have = Math.round(x.money + x.savings);
          if (target && room(2) && have < target && /save|savings|net worth|deposit|rent/i.test(x.goal.label)) say(x, `I'm at ${money(have)} so far.`);
          const saver = y.reflections.some((l) => l.key === "money:save");
          const rival = y.traits.competitiveness > 0.65 && x.goal.kind === "get_rich";
          const warm = saver || y.personality.big5.agreeableness > 0.6 || y.personality.big5.conscientiousness > 0.6;
          say(
            y,
            saver
              ? "Put a bit aside every day. That's what I do now."
              : rival
                ? pick(r, ["Not if I get there first.", "We'll see about that."])
                : y.personality.big5.agreeableness > 0.6
                  ? pick(r, ["Good for you. You'll do it.", "I believe in you, for what it's worth."])
                  : warm
                    ? pick(r, ["Little and often. That's the trick.", "Make a plan and stick to it."])
                    : pick(r, ["Easier said than done.", "Best of luck with that."]),
          );
          notes.push({ t: "feel", who: x.id, e: warm ? { pride: 2, joy: 2 } : { sadness: 1 } });
          if (warm || rival) notes.push({ t: "rel", who: x.id, about: y.id, affinity: warm ? 2 : -1, trust: warm ? 1 : 0 });
          topics.push(`${x.name}'s plans`);
          brief.push(`${X} talks about what they're working towards ("${x.goal.label}"); ${Y} ${warm ? "is encouraging" : rival ? "is competitive about it" : "is unimpressed"}.`);
        },
      });
    }
    // Prices: people notice when something jumps.
    const swing = priceSwing(world);
    if (swing && !used.has("prices")) {
      out.push({
        key: "prices",
        weight: 0.3 + Math.min(0.5, Math.abs(swing.pct) / 100),
        run: () => {
          const up = swing.pct > 0;
          const pct = Math.abs(swing.pct);
          say(x, pick(r, [`Have you seen the price of ${swing.name}? ${up ? "Up" : "Down"} ${pct}% since yesterday.`, `${capitalise(swing.name)} ${up ? "went up" : "dropped"} ${pct}% overnight. Mad.`]));
          const sells = y.businessIds.some((id) => (world.businesses[id]?.inventory[swing.pid]?.qty ?? 0) > 0) || (y.inventory[swing.pid]?.qty ?? 0) > 0;
          say(
            y,
            sells
              ? up
                ? pick(r, ["Good. I've got a pile of them to sell.", "Don't tell everyone, but that suits me fine."])
                : pick(r, ["Don't. I'm sitting on a load of them.", "Ouch. There goes my profit."])
              : up
                ? pick(r, ["Daylight robbery.", "Everything's going up.", "I'll be doing without, then."])
                : pick(r, ["Might stock up, then.", "About time something got cheaper."]),
          );
          topics.push(`the price of ${swing.name}`);
          brief.push(`${X} mentions ${swing.name} prices moving ${swing.pct}% since yesterday; ${Y} ${sells ? "has some to sell" : "would be buying"}.`);
        },
      });
    }
    // Something they both like.
    const like = x.personality.likes.find((l) => y.personality.likes.includes(l) && SHARED_LIKE[l] && !(l === "the pub" && hour < 12) && !(l === "the park" && storm));
    if (like && !used.has(`like:${like}`) && closeness(x, y.id) > -0.1) {
      out.push({
        key: `like:${like}`,
        weight: 0.4 * (leisure ? 1.5 : 1),
        run: () => {
          const [ask, answer] = pick(r, SHARED_LIKE[like]);
          say(x, ask);
          say(y, answer);
          notes.push({ t: "rel", who: x.id, about: y.id, affinity: 2, trust: 1 }, { t: "rel", who: y.id, about: x.id, affinity: 2, trust: 1 });
          topics.push(like);
          brief.push(`${X} and ${Y} find they both like ${like}.`);
        },
      });
    }
    // A pet hate the moment has set off.
    const g = gripe(world, x);
    if (g && !used.has(`gripe:${x.id}`)) {
      out.push({
        key: `gripe:${x.id}`,
        weight: 0.5,
        run: () => {
          say(x, pick(r, g.line));
          const same = y.personality.dislikes.includes(g.dislike);
          const opposite = (g.dislike === "early mornings" && y.personality.big5.conscientiousness > 0.7) || (g.dislike === "crowds" && y.personality.likes.includes("people-watching"));
          say(
            y,
            same
              ? pick(r, ["Tell me about it.", "Don't. Same here.", "You and me both."])
              : opposite
                ? g.dislike === "early mornings"
                  ? pick(r, ["Best part of the day, this!", "Early bird catches the worm."])
                  : "I quite like it, actually. All the faces."
                : pick(r, ["Ha. It's not that bad.", "Could be worse."]),
          );
          if (same) notes.push({ t: "rel", who: x.id, about: y.id, affinity: 2, trust: 0 });
          topics.push(g.dislike);
          brief.push(`${X} grumbles about ${g.dislike}; ${Y} ${same ? "agrees" : opposite ? "rather likes it" : "shrugs it off"}.`);
        },
      });
    }
    return out;
  };

  // --- the middle of the chat: a few topics, taking turns to lead
  const soc = (a.traits.sociability + b.traits.sociability) / 2;
  let n = 1 + (soc > 0.5 ? 1 : 0) + (closeness(a, b.id) > 0.4 ? 1 : 0) + (leisure ? 1 : 0);
  if (enemies) n = 1;
  n = Math.min(3, n);
  for (let i = 0; i < n && room(3); i++) {
    const lead = i % 2 === 0 ? a : b;
    const other = lead === a ? b : a;
    let cands = candidates(lead, other);
    if (cands.length === 0) cands = candidates(other, lead);
    if (cands.length === 0) break;
    const c = weightedPick(r, cands, (x) => Math.max(0.01, x.weight));
    if (!c) break;
    used.add(c.key);
    c.run();
  }

  // --- goodbye
  if (lines.length < maxLines) {
    const festival = world.happenings.find((h) => h.kind === "festival" && !h.ended && world.time < h.until && knows(a, h.id) && knows(b, h.id));
    const party = world.happenings.find((h) => h.kind === "party" && !h.ended && world.time < h.until && h.subject && h.subject !== a.id && h.subject !== b.id && knows(a, h.id) && knows(b, h.id));
    if (!enemies && festival && rand(r) < 0.5) {
      say(a, "See you at the festival?");
      if (lines.length < maxLines) say(b, (knows(b, festival.id)?.stance ?? 0) > 0.2 ? "Definitely!" : "Maybe. Not really my scene.");
    } else if (!enemies && party && rand(r) < 0.5) {
      say(a, `See you at ${world.citizens[party.subject!]?.name ?? "the"}'s party tonight?`);
      if (lines.length < maxLines) say(b, pick(r, ["Wouldn't miss it.", "If I can drag myself out."]));
    } else {
      const x = enemies ? a : lines.length % 2 === 0 ? a : b;
      const y = x === a ? b : a;
      say(x, enemies ? pick(r, ["Right. I'm off.", "Anyway.", "Well. This has been fun."]) : goodbye(r, world, x, y, closeness(a, b.id) > 0.4, storm));
      if (!enemies && lines.length < maxLines && chance(r, 0.5)) say(y, pick(r, ["See you.", "Take care.", "Bye now.", "Cheers.", "Later."]));
    }
  }

  const uniq = [...new Set(topics)];
  const summary = uniq.length ? `${a.name} and ${b.name} talked about ${list(uniq.slice(0, 3))}.` : `${a.name} and ${b.name} caught up.`;
  topics.splice(0, topics.length, ...uniq);
  return { lines, notes, topics, brief, summary, headline };
}

/** When the chat ends: pass on the news, shift opinions and friendships, hand over any money promised. */
export function applyNotes(world: WorldState, conv: Conversation): void {
  for (const n of conv.notes ?? []) {
    switch (n.t) {
      case "news": {
        const to = world.citizens[n.to];
        const from = world.citizens[n.from];
        const h = happeningById(world, n.id);
        if (!to || !from || !h) break;
        learnNews(world, to, h, from.id);
        const k = knows(from, n.id);
        if (k && !k.told.includes(to.id)) k.told.push(to.id);
        break;
      }
      case "stance": {
        const c = world.citizens[n.who];
        const k = c ? knows(c, n.id) : undefined;
        if (k) k.stance = Math.round(clamp(k.stance + n.delta, -1, 1) * 100) / 100;
        break;
      }
      case "rel": {
        const c = world.citizens[n.who];
        if (c && world.citizens[n.about]) adjustRel(world, c, n.about, { affinity: n.affinity, trust: n.trust });
        break;
      }
      case "feel": {
        const c = world.citizens[n.who];
        if (c) feel(c, n.e);
        break;
      }
      case "gift": {
        const from = world.citizens[n.from];
        const to = world.citizens[n.to];
        if (!from || !to || from.money < n.amount + 20) break;
        if (!transfer(world, citizenAcc(from.id), citizenAcc(to.id), n.amount, "gift", `Helping ${to.name} with ${n.why}`)) break;
        remember(world, to, { text: `${from.name} gave me ${money(n.amount)} when I was worried about money.`, kind: "favor", importance: 7, valence: 0.9, people: [from.id] });
        remember(world, from, { text: `I gave ${to.name} ${money(n.amount)} to tide them over.`, kind: "social", importance: 4, valence: 0.5, people: [to.id], feel: { joy: 4, pride: 3 } });
        logEvent(world, "social", `🎁 ${from.name} gave ${to.name} ${money(n.amount)} to help with ${n.why}.`, 3, [from.id, to.id]);
        break;
      }
      case "memory": {
        const c = world.citizens[n.who];
        if (c) remember(world, c, { text: n.text, kind: "conversation", importance: n.importance, valence: n.valence, people: n.people });
        break;
      }
    }
  }
}
