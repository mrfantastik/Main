import { situation } from "../ai/situation";
import { citizenAcc, transfer } from "../economy/ledger";
import { logEvent } from "../events";
import { remember } from "../memory/memory";
import { dominantEmotion, feel, feelingsToward, strongestFeelingAboutSomeone } from "../mind/emotions";
import { memoryCallback } from "../mind/voice";
import { chance, hashSeed, rand, weightedPick, type RngHolder } from "../rng";
import { happeningById, knows, learnNews, stanceOn } from "../town/happenings";
import type { Citizen, CitizenId, Conversation, ConversationLine, ConvNote, Emotion, Happening, Memory, WorldState } from "../types";
import { capitalise, clamp, money } from "../util";
import { adjustRel, peekRel } from "./relationships";
import { choose, phrase, PLACE_GREETS, talkIn } from "./talk";

// Improvised conversation. Instead of a fixed script, each chat is planned from
// what the two people actually have on their minds: news one of them hasn't
// heard, how their day has really gone, what they talked about last time,
// something that happened to them, a grudge or a soft spot for someone they
// both know, money worries, family, a dream, a plan, work, the place they're
// in, the economy, a pet hate. Each line answers the one before (bad news
// gets sympathy, or a shrug from someone who doesn't care; a question gets
// an answer from real life), and each beat leaves notes: news passed on,
// minds changed, friendships warmed or strained. The notes are applied when
// the chat ends, whoever wrote the words (this, or an AI).
//
// The words come from the phrasebook (talk.ts): many wordings for every
// move, in each person's own style, and nobody repeats what they've said
// lately, so chats don't come out the same.

export interface Improv {
  lines: ConversationLine[];
  notes: ConvNote[];
  topics: string[];
  /** Beat-by-beat outline (for an AI, when it writes the words). */
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
  if (/^(CityCorp|Central|Hustle|Skyline|Cowork|Wholesale|Research|Town|Gilded|Marketplace|City)$/.test(word)) return s;
  return s[0].toLowerCase() + s.slice(1);
}

/** A memory retold to the person in it: "Grace told me" -> "you told me", "Grace's" -> "your". */
function toYou(text: string, listener: Citizen | undefined): string {
  if (!listener) return text;
  return text.replace(new RegExp(`\\b${listener.name}'s\\b`, "g"), "your").replace(new RegExp(`\\b${listener.name}\\b`, "g"), "you");
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

/**
 * Is what this memory says about their life still true? A job they've since
 * left, rent they've since paid, being fired when they've found work again:
 * those aren't how things are now, so they don't get told as if they were.
 */
function stillTrue(world: WorldState, c: Citizen, m: Memory): boolean {
  const t = m.text;
  const job = /gave me a job at (.+?) for |^(CityCorp) hired me/.exec(t);
  if (job) {
    const now = c.employerId === "corp" ? "CityCorp" : c.employerId ? world.businesses[c.employerId]?.name : null;
    return now === (job[1] ?? job[2]);
  }
  if (/fired me|lost my job/.test(t)) return c.occupation === "unemployed" || world.time - m.t < 1440;
  if (/owe the landlord|couldn't pay my rent/.test(t)) return c.rentArrears > 0;
  if (/evicted|sleeping in the park/.test(t)) return c.homeless;
  if (/\blent me\b/.test(t) && m.key?.startsWith("loan:")) return world.loans.some((l) => `loan:${l.id}` === m.key && l.status === "active");
  return true;
}

/** The most vivid recent memory that stirred this feeling. */
function causeOf(world: WorldState, c: Citizen, e: Emotion, now: number): Memory | null {
  let best: Memory | null = null;
  for (const m of [...c.memories.short, ...c.memories.long]) {
    if (now - m.t > 4 * 1440 || m.kind === "conversation" || /\btold me\b/.test(m.text) || !stillTrue(world, c, m)) continue;
    const v = m.emotions?.[e] ?? 0;
    if (v >= 8 && (!best || v * m.strength > (best.emotions?.[e] ?? 0) * best.strength)) best = m;
  }
  return best;
}

const hourOf = (world: WorldState) => Math.floor((world.time % 1440) / 60);

// ---------------------------------------------------- reactions to news

/** Reacting to someone's news about themselves, to their face. */
function reactionToYou(r: RngHolder, sp: Citizen, h: Happening, s: number, small = false): string {
  const k = `rty:${h.kind}:${s < -0.2 ? "bad" : s > 0.2 ? "good" : "meh"}`;
  // A few pounds lost (or won) isn't a tragedy (or a fortune).
  if (small && (h.kind === "fire" || h.kind === "burglary")) return choose(r, sp, `${k}:small`, ["Oh no. Could've been a lot worse, though.", "Ah, that's annoying. At least it wasn't more.", "Rotten luck. Still, not the end of the world."]);
  if (small && h.kind === "lottery") return choose(r, sp, `${k}:small`, ["Ooh, nice. Drinks on you? Small ones.", "Not bad! Every little helps.", "Ha! Lucky you."]);
  switch (h.kind) {
    case "fire":
      return s < -0.35
        ? choose(r, sp, k, ["Oh no! Are you alright?", "That's awful. I'm so sorry.", "Your shop? Oh, that's heartbreaking.", "All that work. I'm so sorry.", "Was anyone hurt? Were you there?"])
        : s > 0.1
          ? choose(r, sp, k, ["Well. These things happen, don't they?", "Insured, I hope."])
          : choose(r, sp, k, ["Blimey. What a day you've had.", "That's rotten luck."]);
    case "burglary":
      return s < -0.3 ? choose(r, sp, k, ["That's horrible. Are you OK?", "In your own home? That's awful.", "That's so violating. I'm sorry.", "Have you told the police?"]) : choose(r, sp, k, ["These things happen, I suppose.", "Better locks, maybe?"]);
    case "lottery":
      return s > 0.3
        ? choose(r, sp, k, ["Brilliant! Couldn't happen to a nicer person.", "Ha! You lucky devil.", "No way! What are you going to do with it?", "Drinks are on you, then!", "I'm so pleased for you."])
        : s < -0.1
          ? choose(r, sp, k, ["Typical. Some people get all the luck.", "Must be nice.", "Don't spend it all at once."])
          : choose(r, sp, k, ["Well, good for you.", "Nice one."]);
    case "celebrity":
      return s > 0.3 ? choose(r, sp, k, ["Brilliant! You deserve it.", "Good for you. That'll be great for business.", "No way! Did you get a selfie?"]) : choose(r, sp, k, ["Lucky you.", "Probably just passing through."]);
    case "food_poisoning":
      return s < -0.2 ? choose(r, sp, k, ["Oh no. That must have been awful for you.", "Ouch. You'll bounce back.", "That's a nightmare. Is everyone alright?"]) : choose(r, sp, k, ["Can't say I'm surprised.", "Hm. Not great for business."]);
    case "party":
      return s > 0.3 ? choose(r, sp, k, ["Ooh, count me in!", "I'll be there.", "Happy birthday! Of course I'll come."]) : choose(r, sp, k, ["Not really my thing, parties. Have a good one.", "Happy birthday. I might pop in."]);
    default:
      return s < -0.2 ? choose(r, sp, k, ["Oh no. I'm sorry.", "That's hard."]) : s > 0.2 ? choose(r, sp, k, ["Good for you!", "That's great."]) : choose(r, sp, k, ["Huh. Fancy that.", "Well I never."]);
  }
}

function reaction(r: RngHolder, sp: Citizen, world: WorldState, h: Happening, s: number): string {
  const subj = h.subject ? (world.citizens[h.subject]?.name ?? "them") : "them";
  const k = `re:${h.kind}:${s < -0.2 ? "bad" : s > 0.2 ? "good" : "meh"}`;
  switch (h.kind) {
    case "fire":
      return s < -0.35
        ? choose(r, sp, k, [`No! Poor ${subj}.`, `That's awful. Is ${subj} alright?`, "Oh no. All that stock, gone.", `${subj} must be devastated.`, "That's terrible. That place was their life.", "Oh, that's heartbreaking."])
        : s > 0.1
          ? choose(r, sp, k, [`Can't say I'm crying about it. ${subj} had it coming.`, "Well. These things happen, don't they?", "Shame. Less competition, mind."])
          : choose(r, sp, k, ["Blimey.", "That's a shame.", "Crikey. Was it bad?"]);
    case "burglary":
      return s < -0.3
        ? choose(r, sp, k, ["That's horrible. Did they catch anyone?", `Poor ${subj}. I'm double-locking my door tonight.`, "That's terrifying. In our town?", `Is ${subj} OK?`, "Right, that's it, I'm getting a better lock."])
        : choose(r, sp, k, ["Hm. Maybe they shouldn't flash their cash about.", "These things happen, I suppose.", "Can't be too careful these days."]);
    case "lottery":
      return s > 0.3
        ? choose(r, sp, k, [`Good for ${subj}! Couldn't happen to a nicer person.`, "Ha! Lucky devil.", `Brilliant. ${subj} deserves a break.`, `Hope ${subj} buys a round.`])
        : s < -0.1
          ? choose(r, sp, k, ["Typical. Some people get all the luck.", `${subj}? Of course it's ${subj}.`, "Must be nice. I can't even win a raffle.", "And I'm still counting coppers."])
          : choose(r, sp, k, ["Lucky them.", "Huh. Good for them, I suppose."]);
    case "celebrity":
      return s > 0.3 ? choose(r, sp, k, ["Brilliant! They deserve it.", `Good for ${subj}. That'll be great for business.`, "Who was it? Anyone I'd know?"]) : choose(r, sp, k, ["Probably paid for it.", "Overrated, if you ask me.", "Celebrities. Pfft.", "Never heard of them, probably.", "Prices'll go up now, you watch."]);
    case "food_poisoning":
      return s < -0.2 ? choose(r, sp, k, ["Ugh. I've eaten there!", "That's disgusting. I'm not going back there.", "Poor thing. That's the worst.", "My stomach just turned."]) : choose(r, sp, k, ["Can't say I'm surprised.", "Never liked that place."]);
    case "festival":
      return s > 0.3 ? choose(r, sp, k, ["Ooh, I love a festival!", "Brilliant. I'm definitely going.", "Finally, something fun round here."]) : choose(r, sp, k, ["Crowds and noise. I'll pass.", "Not really my thing, festivals.", "Great. Parking will be a nightmare."]);
    case "storm":
      return choose(r, sp, k, ["I know, it's horrible out there.", "I got soaked on the way over.", "My umbrella turned inside out.", "Perfect weather for staying in."]);
    case "power_cut":
      return choose(r, sp, k, ["Ours went off too.", "Nightmare. I couldn't get anything done.", "Everything in my freezer's ruined."]);
    case "rent_rise":
      return choose(r, sp, k, ["Again?! How are we meant to manage?", "I can barely make rent as it is.", "Unbelievable. Who can afford this?", "That's daylight robbery."]);
    case "sculpture":
      return s > 0.3 ? choose(r, sp, k, ["How mysterious! I'll have to go and see it.", "Ooh. Who do you reckon put it there?"]) : choose(r, sp, k, ["Bit weird, isn't it?", "Strange. Probably some art student."]);
    case "party":
      return s > 0.3 ? choose(r, sp, k, ["Ooh, a party! Are you going?", `I love a party. ${subj} always throws a good one.`]) : choose(r, sp, k, [`I didn't know ${subj} was having a party.`, "Not my sort of thing, parties."]);
  }
}

function opinion(r: RngHolder, sp: Citizen, world: WorldState, h: Happening, s: number): string {
  const subj = h.subject ? (world.citizens[h.subject]?.name ?? "them") : "them";
  const k = `op:${h.kind}:${s <= -0.4 ? "bad" : s >= 0.4 ? "good" : "meh"}`;
  if (h.kind === "festival") return s > 0.3 ? choose(r, sp, k, ["Best thing to happen round here in ages.", "I love it. The whole town comes out.", "It's lovely seeing everyone out."]) : choose(r, sp, k, ["Too loud and too crowded for me.", "I'm staying well away.", "Give me a quiet night in any day."]);
  if (h.kind === "sculpture") return s > 0.3 ? choose(r, sp, k, ["I think it's beautiful, honestly.", "I like it. Makes the park feel special."]) : choose(r, sp, k, ["It's just a lump of marble.", "Waste of a good park, if you ask me."]);
  if (h.kind === "rent_rise" || h.kind === "storm" || h.kind === "power_cut") return choose(r, sp, k, ["I'm worried, to be honest.", "It's just one thing after another.", "We'll get through it, I suppose.", "Someone needs to do something about it.", "It's the last thing anyone needed.", "Honestly, I'm losing sleep over it.", "Nobody seems to be doing anything about it.", "Typical. Never rains but it pours."]);
  // Good news for someone (a win, a famous visitor) and bad news (a fire, a break-in) call for different words.
  if (h.tone >= 0) {
    if (s >= 0.4) return choose(r, sp, `${k}:up`, [`I'm really pleased for ${subj}.`, "Best news I've heard all week.", `Good things happen to good people. ${subj}'s proof.`]);
    if (s <= -0.4) return choose(r, sp, `${k}:up`, ["Some people get all the luck.", `${subj}? Of all people.`, "Must be nice. I can't even win a raffle.", "Good for them. I suppose."]);
    if (s < -0.1) return choose(r, sp, `${k}:up`, ["Lucky them.", "Good for them, I suppose.", "Wish it was me."]);
    return choose(r, sp, `${k}:up`, ["Good for them.", "Eh. Good luck to them.", "Not my business, really."]);
  }
  if (s <= -0.4) return choose(r, sp, k, [`I feel terrible for ${subj}.`, "It's awful, really.", `${subj} didn't deserve that.`, `I keep thinking about ${subj}.`]);
  if (s >= 0.4) return choose(r, sp, k, [`Honestly? ${subj} had it coming.`, "Can't say I'm sorry.", "What goes around comes around."]);
  if (s < -0.1) return choose(r, sp, k, ["It's a shame, really.", "Bad luck, that.", "Rotten timing."]);
  return choose(r, sp, k, ["I don't really have a view on it.", "Eh. Life goes on.", "Not my business, really."]);
}

/** When it happened to the speaker: tell it in the first person. */
function ownStory(r: RngHolder, sp: Citizen, world: WorldState, h: Happening): string {
  const name = h.businessId ? world.businesses[h.businessId]?.name : null;
  // Their own place, as they'd say it: not "Sarah's Café" from Sarah.
  const biz = name && name.startsWith(sp.name) ? choose(r, sp, "own:place", ["my place", "the shop", "my café"].filter((p) => p !== "my café" || /Caf/.test(name))) : name;
  const k = `own:${h.kind}`;
  switch (h.kind) {
    case "fire":
      return choose(r, sp, k, [`${biz ?? "My shop"} caught fire. I lost ${money(h.amount)} of stock.`, `There was a fire at ${biz ?? "my place"}. ${money(h.amount)} of stock, gone.`, `${biz ?? "My shop"} went up in smoke. ${money(h.amount)} of stock, just like that.`]);
    case "burglary":
      return choose(r, sp, k, [`Someone broke into my place and took ${money(h.amount)}.`, `I got burgled. They took ${money(h.amount)}.`, `I came home and the door was open. ${money(h.amount)}, gone.`]);
    case "lottery":
      return choose(r, sp, k, [`I won the lottery! ${money(h.amount)}!`, `You won't believe it. I won ${money(h.amount)} on the lottery.`, `My numbers came up. ${money(h.amount)}!`]);
    case "celebrity":
      return choose(r, sp, k, [`A celebrity came to ${biz ?? "my place"}! We've been rammed ever since.`, `Guess who came to ${biz ?? "my shop"}? Someone off the telly!`]);
    case "food_poisoning":
      return choose(r, sp, k, [`Someone got food poisoning at ${biz ?? "my café"}. We've had to shut for a deep clean.`, `We've had a food poisoning scare at ${biz ?? "my place"}. I'm mortified.`]);
    case "party":
      return choose(r, sp, k, ["It's my birthday! I'm having a few drinks at the pub tonight. You should come.", "I'm throwing a birthday party at the pub tonight. Come along!"]);
    default:
      return firstSentence(h.text);
  }
}

/** The person it happened to, a day or two later. */
function ownAfter(r: RngHolder, sp: Citizen, h: Happening): string {
  const k = `after:${h.kind}`;
  switch (h.kind) {
    case "lottery":
      return choose(r, sp, k, ["I'm still buzzing about the lottery win, honestly.", "I keep checking my bank balance. It's real!", "People keep asking me for money since the lottery. Awkward."]);
    case "celebrity":
      return choose(r, sp, k, ["We're still rammed since that celebrity visit.", "I still can't believe someone famous came to my place."]);
    case "party":
      return choose(r, sp, k, ["Thanks for coming to my party, by the way.", "My head still hurts from the party."]);
    case "fire":
      return choose(r, sp, k, ["Still getting over the fire, to be honest.", "I'm still clearing up after the fire.", "I can still smell the smoke."]);
    case "burglary":
      return choose(r, sp, k, ["I still don't feel safe since the break-in.", "I've not slept properly since the break-in.", "I jump at every noise since the burglary."]);
    case "food_poisoning":
      return choose(r, sp, k, ["I'm still mortified about the food poisoning business.", "Customers are only just coming back after the food poisoning."]);
    default:
      return choose(r, sp, k, ["What a week it's been.", "I'm still not over it, honestly."]);
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

/** The news, as this person would put it (not word for word the same every time). */
function retell(r: RngHolder, sp: Citizen, world: WorldState, h: Happening): string {
  const subj = h.subject ? world.citizens[h.subject]?.name : null;
  const biz = h.businessId ? world.businesses[h.businessId]?.name : null;
  const amt = money(h.amount);
  const k = `retell:${h.kind}`;
  const as = (opts: (string | null)[]) => choose(r, sp, k, [firstSentence(h.text), ...opts.filter((x): x is string => !!x)]);
  switch (h.kind) {
    case "fire":
      return as([biz && `${biz} caught fire.`, biz && `There's been a fire at ${biz}. ${amt} of stock gone.`, biz && `${biz} went up in smoke this morning.`]);
    case "burglary":
      return as([subj && `${subj} got burgled. They took ${amt}.`, subj && `Someone broke into ${subj}'s place.`, subj && `${subj} was robbed. ${amt}, gone, just like that.`]);
    case "lottery":
      return as([subj && `${subj} won the lottery!`, subj && `${subj}'s numbers came up. ${amt}!`, subj && `${subj} won ${amt} on the lottery.`]);
    case "celebrity":
      return as([biz && `Someone famous turned up at ${biz}.`, biz && `There was a celebrity at ${biz}! Off the telly!`]);
    case "food_poisoning":
      return as([biz && `Someone got food poisoning at ${biz}.`, biz && `${biz}'s had to shut. Food poisoning.`]);
    case "festival":
      return as(["There's a festival in the park!", "They've put a festival on in the park. Music, stalls, the lot."]);
    case "party":
      return as([subj && `It's ${subj}'s birthday. There's a party at the pub tonight.`, subj && `${subj}'s having a birthday do at the pub.`]);
    case "rent_rise":
      return as(["Rents are going up again.", "The landlords have put the rent up. Again."]);
    case "power_cut":
      return as(["Half the town's lost power.", "There's a power cut. Nothing's working."]);
    case "storm":
      return as(["There's a storm coming in.", "It's chucking it down out there."]);
    case "sculpture":
      return as(["Someone's put a giant column in the park overnight.", "There's a mysterious column in the park. Nobody knows where it came from."]);
    default:
      return firstSentence(h.text);
  }
}

/** Answering a question someone asked in reaction to the news ("Are you going?", "Is Mike alright?"), going by what they asked. */
function answerReaction(r: RngHolder, sp: Citizen, world: WorldState, h: Happening, stance: number, asked: string): string {
  const k = `ans:${h.kind}`;
  if (h.subject === sp.id) {
    // It happened to them: they answer for themselves.
    const o = `${k}:own`;
    if (/selfie/i.test(asked)) return choose(r, sp, `${o}:selfie`, ["Course I did!", "I was too starstruck to ask."]);
    if (/police/i.test(asked)) return choose(r, sp, `${o}:police`, ["For all the good it'll do.", "They took a statement. That's about it."]);
    if (/\bthere\?/i.test(asked)) return choose(r, sp, `${o}:there`, ["I was in the back. Got out fine.", "No, thank goodness. I was out."]);
    if (/\b(alright|OK|okay|hurt)\?/i.test(asked)) return choose(r, sp, `${o}:ok`, ["Shaken, but I'll be alright.", "I'm OK. Just a bit rattled.", "Getting there."]);
    if (/catch|who/i.test(asked)) return choose(r, sp, `${o}:who`, ["Nobody saw a thing.", "Not a clue."]);
    if (/do with it|spend/i.test(asked)) return choose(r, sp, `${o}:spend`, ["Pay off a few things first. Then a holiday.", "Save most of it. Maybe one treat.", "No idea yet!"]);
    return choose(r, sp, o, ["I'm still taking it in.", "Honestly, I don't know yet."]);
  }
  if (/\b(alright|OK|okay|hurt|there)\?$/i.test(asked)) return choose(r, sp, `${k}:ok`, ["Shaken, but they'll be alright.", "I haven't seen them, to be honest.", "They're putting a brave face on it.", "Nobody's sure yet."]);
  if (/catch|who|police/i.test(asked)) return choose(r, sp, `${k}:who`, ["Not yet. Nobody saw a thing.", "No idea. The police aren't saying.", "Not a clue."]);
  if (/our town|here\?|round here/i.test(asked)) return choose(r, sp, `${k}:town`, ["I know. Makes you think.", "That's what I said!", "Right here. Unbelievable."]);
  if (/going|come|coming|count me|be there/i.test(asked)) return stance > 0.2 ? choose(r, sp, `${k}:go`, ["Wouldn't miss it.", "Course I am!", "Try and stop me."]) : choose(r, sp, `${k}:nogo`, ["Might pop in for one.", "Probably not, to be honest.", "Not really my thing."]);
  if (/do with it|spend/i.test(asked)) return choose(r, sp, `${k}:spend`, ["Knowing them, they'll blow it all by Friday.", "Holiday, they reckon.", "No idea. I'd buy a house."]);
  switch (h.kind) {
    case "party":
    case "festival":
      return stance > 0.2 ? choose(r, sp, k, ["Wouldn't miss it.", "Course I am!", "Try and stop me."]) : choose(r, sp, k, ["Might pop in for one.", "Probably not, to be honest.", "Not really my thing."]);
    case "fire":
    case "burglary":
    case "food_poisoning":
      return choose(r, sp, k, ["Shaken, but they'll be alright.", "I haven't seen them, to be honest.", "They're putting a brave face on it.", "Nobody's sure yet."]);
    case "lottery":
      return choose(r, sp, k, ["Knowing them, they'll blow it all by Friday.", "Holiday, they reckon.", "No idea. I'd buy a house."]);
    case "sculpture":
      return choose(r, sp, k, ["No idea. That's the weird part.", "Aliens, according to the pub."]);
    default:
      return choose(r, sp, k, ["No idea, honestly.", "Your guess is as good as mine.", "Who knows?"]);
  }
}

/** A follow-up question about the news, and the teller's answer to that question (not some other one). */
function question(r: RngHolder, asker: Citizen, teller: Citizen, h: Happening, told = ""): [string, string] | null {
  const amt = money(h.amount);
  const QA: Partial<Record<Happening["kind"], [string, string[]][]>> = {
    fire: [
      ["Was anyone hurt?", ["Nobody hurt, thank goodness.", "No one, luckily. Just the stock."]],
      ["How did it start?", ["Faulty wiring, they reckon.", "Nobody knows yet. Kitchen, maybe."]],
      ["Did they lose much?", [`${amt} of stock, apparently.`, `About ${amt} worth, I heard.`]],
      ["Are they going to reopen?", ["Once they've cleaned up, they say.", "Hopefully. Nobody's sure."]],
    ],
    burglary: [
      ["Do they know who did it?", ["No idea. Makes you want to lock everything twice.", "Not a clue. The police weren't much help."]],
      ["Did they take much?", [`${amt}, apparently.`, `${amt}. Cash, mostly.`]],
      ["How did they get in?", ["Through the back window, I heard.", "Nobody knows. That's the scary bit."]],
    ],
    lottery: [
      ["How much did they win?", [`${amt}! Can you believe it?`, `${amt}. Not life-changing, but close.`]],
      ["What are they going to do with it?", ["Holiday, they reckon.", "Pay off some bills, apparently. Sensible.", "Knowing them? Blow it by Friday."]],
    ],
    celebrity: [
      ["Who was it?", ["Someone off the telly. I can never remember names.", "Some presenter. Signed a napkin and everything."]],
      ["Did you see them?", ["No! I missed it by ten minutes.", "Only from a distance."]],
    ],
    food_poisoning: [
      ["Is everyone alright?", ["They'll live. Not sure the café's reputation will, mind.", "Rough night, but they're alright now."]],
      ["What was it?", ["Dodgy chicken, they're saying.", "Something in the soup, apparently."]],
    ],
    storm: [
      ["How long's it meant to last?", ["Till tonight, they reckon.", "All day, apparently."]],
      ["Is it getting worse?", ["Worse before it gets better, apparently.", "Seems to be easing off."]],
    ],
    power_cut: [
      ["When's it coming back on?", ["Nobody knows. A couple of hours, hopefully.", "Soon, they say. Whatever that means."]],
      ["Is it the whole street?", ["Half the town, I think.", "Most of the centre."]],
    ],
    rent_rise: [
      ["How much this time?", ["Five percent. On top of everything else.", "Enough to hurt."]],
      ["Can they even do that?", ["Apparently they can.", "They just did."]],
    ],
    sculpture: [
      ["Who put it there?", ["Nobody knows. That's the weird part.", "Some say it's art. Some say aliens."]],
      ["What does it look like?", ["A big white column. Just standing there.", "Like something off a Greek temple."]],
    ],
  };
  // Not "how much?" when they've just said how much.
  const pairs = QA[h.kind]?.filter((p) => !(/£/.test(told) && p[1].every((a) => a.includes(amt))));
  if (!pairs?.length) return null;
  const q = choose(r, asker, `q:${h.kind}`, pairs.map((p) => p[0]));
  const i = pairs.findIndex((p) => p[0] === q);
  return [q, choose(r, teller, `a:${h.kind}:${i}`, pairs[i][1])];
}

// --------------------------------------------- answers from real life

function dayStart(t: number): number {
  return Math.floor(t / 1440) * 1440;
}

/** The thing that happened to them today that they'd mention first, if any. */
function todaysNews(world: WorldState, c: Citizen, now: number, listener?: Citizen): Memory | null {
  let best: Memory | null = null;
  for (const m of c.memories.short.concat(c.memories.long)) {
    if ((listener && m.people.includes(listener.id)) || !stillTrue(world, c, m)) continue;
    if (m.t < dayStart(now) || m.kind === "conversation" || m.kind === "social" || m.kind === "insight" || m.importance < 6 || Math.abs(m.valence) < 0.6) continue;
    if (!/\b(I|me|my)\b/.test(m.text) || /^(Talked|Chatted)/.test(m.text) || /\btold me about\b|^Read about|with my own eyes/.test(m.text)) continue;
    if (!best || m.importance * Math.abs(m.valence) > best.importance * Math.abs(best.valence)) best = m;
  }
  return best;
}

/** Is this news a small thing for them (a few pounds, a minor upset) or a big one? */
function isSmall(c: Citizen, m: Memory): boolean {
  const amt = /£([\d,]+(?:\.\d+)?)/.exec(m.text);
  if (amt) {
    const v = Number(amt[1].replace(/,/g, ""));
    return v < Math.max(20, 0.1 * Math.max(0, c.money + c.savings)) && v < 200;
  }
  return m.importance * Math.abs(m.valence) < 5;
}

/** Did this line ask how they are? */
function asksHow(text: string): boolean {
  return /\?/.test(text) && /\b(how|alright|keeping well|you well|you're well|long day|still alive|surviving|you OK)\b/i.test(text);
}

interface HowTheyAre {
  /** Their answer to "how are you?". */
  text: string;
  mood: "good" | "bad" | "fine";
  /** Something that happened to them today, if that's what they'll talk about. */
  news: Memory | null;
  /** The news is only a small thing for them. */
  small: boolean;
  /** The news on its own, as they'd say it. */
  told: string;
}

/** "How are you?", answered from their actual day: the weather, a big moment, tiredness, hunger, or how they feel. */
function howTheyAre(r: RngHolder, world: WorldState, c: Citizen, listener: Citizen): HowTheyAre {
  const storm = world.happenings.some((h) => h.kind === "storm" && !h.ended && world.time >= h.t && world.time < h.until);
  if (storm && !c.insideId) return { text: phrase(r, c, listener, "howWet"), mood: "bad", news: null, small: false, told: "" };
  const m = todaysNews(world, c, world.time, listener);
  if (m) {
    const small = isSmall(c, m);
    const told = sentence(toYou(m.text, listener));
    const move = m.valence > 0 ? (small ? "howGoodSmall" : "howGoodDay") : small ? "howBadSmall" : "howBadDay";
    return { text: `${phrase(r, c, listener, move)} ${told}`, mood: m.valence > 0 ? "good" : "bad", news: m, small, told };
  }
  const s = situation(world, c);
  if (s.tired > 0.78 && chance(r, 0.5)) return { text: phrase(r, c, listener, "howTired"), mood: "bad", news: null, small: false, told: "" };
  if (s.hungry > 0.75 && chance(r, 0.4)) return { text: phrase(r, c, listener, "howHungry"), mood: "fine", news: null, small: false, told: "" };
  const d = dominantEmotion(c);
  const move: Partial<Record<Emotion, string>> = { sadness: "howSad", anger: "howAngry", fear: "howScared", joy: "howHappy", loneliness: "howLonely", love: "howHappy", envy: "howEnvy", pride: "howProud", gratitude: "howGrateful", shame: "howAshamed" };
  const mood = !d ? "fine" : ["joy", "love", "pride", "gratitude"].includes(d.emotion) ? "good" : ["sadness", "anger", "fear", "loneliness"].includes(d.emotion) ? "bad" : "fine";
  return { text: phrase(r, c, listener, (d && move[d.emotion]) || "howFine"), mood, news: null, small: false, told: "" };
}

/** Where they work, as they'd say it. */
function workplace(world: WorldState, c: Citizen): string | null {
  if (c.employerId === "corp") return "CityCorp";
  return c.employerId ? (world.businesses[c.employerId]?.name ?? null) : null;
}

function workQuestion(r: RngHolder, asker: Citizen, world: WorldState, x: Citizen, biz: Citizen["businessIds"][number] | null): string {
  const b = biz ? world.businesses[biz] : null;
  const q = (k: string, opts: string[]) => choose(r, asker, `wq:${k}`, opts);
  if (b) return q("biz", [`How's ${b.name} doing?`, "How's business?", "Shop busy?", `Still run off your feet at ${b.name}?`, `Making a fortune at ${b.name} yet?`, `How are the customers at ${b.name}?`, "Business booming?"]);
  const place = workplace(world, x);
  switch (x.occupation) {
    case "unemployed":
      return q("none", ["Any luck finding work?", "Still looking for something?", "Anything come up, job-wise?", "Any interviews lined up?", "Have you tried CityCorp? They were hiring."]);
    case "researcher":
      return q("res", ["How's the research going?", "Invented anything yet?", "Any breakthroughs?", "Still in the lab all hours?", "Cured anything yet?"]);
    case "trader":
      return q("trade", ["How are the markets treating you?", "Making a killing yet?", "Buy low, sell high?", "Any hot tips?", "Up or down this week?"]);
    case "reseller":
      return q("resell", ["Find any bargains today?", "Flipped anything good lately?", "Still buying and selling?", "What's the next big thing to sell?"]);
    case "freelancer":
      return q("free", ["Clients keeping you busy?", "Enough work coming in?", "How's the freelancing going?", "Any good clients lately?", "Still working from the Cowork Hub?"]);
    default:
      return place
        ? q("job", [`How's it going at ${place}?`, `${place} treating you alright?`, "How's work?", "Keeping busy?", `Still at ${place}?`, `Is ${place} still working you to the bone?`])
        : q("job2", ["How's work?", "Keeping busy?", "Work treating you alright?"]);
  }
}

/** How work's really going, with real numbers where they have them. */
function workAnswer(r: RngHolder, sp: Citizen, world: WorldState, x: Citizen, avg: number): { answer: string; good: boolean } {
  const biz = x.businessIds.map((id) => world.businesses[id]).find((q) => q && q.open);
  const hour = hourOf(world);
  const a = (k: string, opts: string[]) => choose(r, sp, `wa:${k}`, opts);
  if (biz) {
    const n = biz.today.customers;
    if (biz.missedToday >= 3) return { answer: a("short", [`Busy, but we keep running out of stock. That's ${biz.missedToday} sales missed today.`, `Can't keep the shelves full. Turned away ${biz.missedToday} customers today.`, `I need a bigger stockroom. ${biz.missedToday} people left empty-handed today.`]), good: false };
    if (biz.avgProfit > 30) return { answer: a("great", [`${biz.name} is doing great: about ${money(biz.avgProfit)} a day!`, n >= 5 ? `Run off my feet. ${n} customers already today.` : `Really well. About ${money(biz.avgProfit)} a day profit.`, `Honestly? Better than I ever dreamed. ${money(biz.avgProfit)} a day.`]), good: true };
    if (biz.avgProfit < 0) return { answer: a("bad", [`Honestly? ${biz.name} is struggling.`, "The rent's eating me alive.", `${n <= 1 ? "Hardly a customer all day." : `Only ${n} customers today.`} I'm worried.`, `I'm losing money every day at ${biz.name}. Something's got to change.`]), good: false };
    if (hour >= 11 && n >= 2) return { answer: a("ok", [`Steady. ${n} customers so far today.`, `Not bad. ${n} through the door today.`, `Ticking over. ${n} customers today.`]), good: false };
  }
  const place = workplace(world, x);
  const today = x.finance.occToday;
  if (avg > 45) return { answer: a("rich", [`Really well, actually. I'm making about ${money(avg)} a day.`, `Can't complain at all: ${money(avg)} a day, give or take.`, `Good money. ${money(avg)} a day on average.`]), good: true };
  switch (x.occupation) {
    case "unemployed": {
      const days = Math.floor((world.time - x.occupationSince) / 1440);
      return { answer: days >= 2 ? a("none", [`${days} days now and nothing.`, `Nothing yet. ${days} days of looking.`, `${days} days. I'm starting to lose hope.`]) : a("none2", ["Still looking. It's grim out there.", "Nothing yet. Something'll turn up.", "I've got applications in everywhere."]), good: false };
    }
    case "researcher":
      return { answer: x.research.breakthroughs > 0 ? a("res1", ["Working on the next big thing.", "One breakthrough down. Chasing another."]) : x.research.points > 50 ? a("res2", ["I think I'm close to something.", "Getting somewhere, I think. Slowly."]) : a("res3", ["Slow. Science is slow.", "Lots of dead ends.", "Three weeks on one problem. Don't ask."]), good: false };
    case "freelancer":
      return { answer: today > 15 ? a("free1", [`${money(today)} from clients so far today. Not bad.`, `Decent day. ${money(today)} in already.`]) : a("free2", ["Feast or famine, freelancing.", "Waiting on clients. Always waiting.", "One client's been ghosting me all week."]), good: today > 25 };
    case "reseller":
    case "trader": {
      const deal = x.memories.short.find((m) => m.t >= dayStart(world.time) && m.kind === "deal" && /£/.test(m.text) && /\b(I|my)\b/.test(m.text));
      if (deal) return { answer: sentence(deal.text), good: deal.valence > 0 };
      return { answer: a("trade", ["Quiet day on the markets.", "Waiting for the right deal.", "Prices are all over the place.", "Sitting on stock, waiting for prices to turn."]), good: false };
    }
  }
  if (place && today >= 15) return { answer: a("shift", [`Long shift at ${place}. ${money(today)} in the bag today, mind.`, `Same as ever at ${place}.`, `${place} had me on my feet all day. ${money(today)}, though.`]), good: false };
  if (place && today > 0) return { answer: a("shift:early", [`Only just got going at ${place}.`, `Quiet so far at ${place}.`, `Same as ever at ${place}.`]), good: false };
  return { answer: a("meh", ["Ticking along.", "Could be better, could be worse.", "Same as ever.", "Busy, which is good, I suppose.", "Quiet, to be honest.", "Don't get me started."]), good: false };
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
const SHARED_LIKE: Record<string, ([string, string] | [string, string, string])[]> = {
  "the pub": [["Pint later?", "Go on then."], ["Fancy the pub after this?", "Twist my arm."], ["Quiz night at the pub this week?", "Only if I'm on your team."], ["The pub's new ale is decent, you know.", "I'll be the judge of that."]],
  "the park": [["Walk round the park later?", "I'd like that."], ["The park's lovely this time of year.", "It really is."], ["I saw a heron in the park this morning.", "No! Where?", "By the pond. Just standing there like it owned the place."], ["Picnic in the park at the weekend?", "I'll bring the sandwiches."]],
  coffee: [["Coffee sometime? My treat.", "You're on."], ["I'd kill for a proper coffee.", "Same. I live on the stuff."], ["Have you tried the coffee at the café? Proper stuff.", "Better than the diner's, anyway."]],
  "football on the radio": [["Did you catch the football last night?", "Did I! What a game!"], ["What about that match, eh?", "I was shouting at the radio."], ["That referee wants his eyes tested.", "Don't get me started on him."]],
  books: [["Read anything good lately?", "Halfway through a thriller. Can't put it down."], ["I've just finished a cracking book.", "Lend it to me?", "Course. I'll drop it round."], ["I'm on my third book this week.", "Show-off. I'm still on page twelve of mine."]],
  cooking: [["Made a proper stew last night. You'd have loved it.", "Save me some next time!"], ["Got a new recipe to try this weekend.", "Oh, go on, what is it?", "A curry. From scratch. Wish me luck."], ["I burnt the rice again.", "How do you burn rice?", "Talent, apparently."]],
  gadgets: [["Have you seen the new phones at the market?", "Don't tempt me."], ["I've got my eye on a new gadget.", "Ooh, show me later."], ["My phone's on its last legs.", "Time for an upgrade, then."]],
  "people-watching": [["Good spot for people-watching, this.", "The best."], ["You see all sorts round here.", "Never a dull moment."], ["See that bloke in the hat? Third time today.", "Ha! I noticed that too."]],
  "a long lie-in": [["Had a lie-in this morning. Bliss.", "Jealous."], ["What I'd give for a lie-in.", "Tell me about it."]],
  "quiet evenings": [["Quiet night in tonight, I think.", "Sounds perfect."], ["I just want a quiet evening.", "Same. Feet up."]],
  "a good bargain": [["Got a cracking bargain at the market.", "Where? Tell me!", "The stall at the back. Don't tell everyone."], ["There's always a bargain if you look.", "You've got the eye for it."]],
};

/** A pet hate the moment has set off, if any. */
function gripe(world: WorldState, x: Citizen): { dislike: string; line: string[] } | null {
  const hour = hourOf(world);
  const where = x.insideId ? world.map.buildings.find((b) => b.id === x.insideId)?.type : null;
  const festival = world.happenings.some((h) => h.kind === "festival" && !h.ended && world.time < h.until && knows(x, h.id));
  for (const d of x.personality.dislikes) {
    if (d === "early mornings" && hour >= 5 && hour < 9) return { dislike: d, line: ["Too early for this.", "I hate mornings. I really do.", "Nobody should be awake at this hour.", "My alarm clock and I are not friends."] };
    if (d === "crowds" && festival) return { dislike: d, line: ["Too many people about for my liking.", "This festival crowd is doing my head in.", "I can't move for people today."] };
    if (d === "the diner's coffee" && where === "diner") return { dislike: d, line: ["The coffee in here is awful.", "Who makes coffee this bad?", "I think this coffee is just hot water and regret."] };
    if (d === "waiting around" && x.activity.kind === "shop") return { dislike: d, line: ["I've been queueing for ages.", "Why is everything so slow today?", "If I wait any longer I'll grow roots."] };
    if (d === "debt" && world.loans.some((l) => l.borrower === x.id && l.status === "active")) return { dislike: d, line: ["I hate owing money.", "Being in debt keeps me up at night.", "Every time I get paid it goes straight back out on the loan."] };
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

/** What they'll be doing later, as they'd say it: their plan for the day if the town's brain wrote one, otherwise their goal and likes. */
function laterLine(r: RngHolder, world: WorldState, x: Citizen): string | null {
  const hour = hourOf(world);
  const next = x.agent?.plan?.items.find((i) => i.status === "todo" && i.hour > hour);
  if (next) {
    const when = next.hour >= 18 ? "tonight" : next.hour >= 12 ? "this afternoon" : "later on";
    const what = lowerStart(world, next.label.replace(/\s*\(.*?\)/g, "").trim());
    const why = next.why && !/#/.test(next.why) ? ` ${sentence(next.why)}` : "";
    return `I'm going to ${what} ${when}.${why}`;
  }
  if (hour >= 17) {
    if (x.personality.likes.includes("the pub")) return choose(r, x, "later:pub", ["Pub, probably. It's been that sort of day.", "A pint at the Gilded Pint, I reckon."]);
    if (x.personality.likes.includes("quiet evenings")) return choose(r, x, "later:quiet", ["Quiet night in. Feet up.", "Nothing. Glorious nothing."]);
    return choose(r, x, "later:eve", ["Home, dinner, bed.", "Not sure yet. Something cheap."]);
  }
  if (x.occupation === "unemployed") return choose(r, x, "later:job", ["More job applications. Joy.", "Going to try CityCorp again."]);
  if (x.businessIds.length) return choose(r, x, "later:biz", ["Back to the shop. It doesn't run itself.", "Restocking, then the accounts."]);
  return null;
}

/** A goodbye that fits the moment: bedtime, hunger, work waiting, the weather, or just the friendship. */
function goodbye(r: RngHolder, world: WorldState, x: Citizen, y: Citizen, close: boolean, storm: boolean): string {
  const hour = hourOf(world);
  const extra: string[] = [];
  if (hour >= 21 || hour < 4) extra.push("Right, bed for me.", "It's getting late. Night!", "I'm off to bed before I fall asleep here.", "Is it that time already? Night.", "Early start tomorrow. Night!");
  if (situation(world, x).hungry > 0.6) extra.push("I'm off to find something to eat.", "My stomach's rumbling. Catch you later.", "I need food before I faint.", "Lunch is calling.", "Dinner's calling.", "Breakfast first, then I'm human.", "I could eat a horse. Bye!");
  if (x.activity.kind === "work") extra.push("Better get back to it before anyone notices.", "Duty calls.", "The boss is looking. Bye!", "Back to the grindstone.", "This won't do itself. See you.");
  if (storm) extra.push("Stay dry!", "Mind the puddles.", "Hope you've got a brolly.");
  const fam = y.family.map((id) => world.citizens[id]).find((f) => f && f.id !== x.id && (peekRel(x, f.id)?.familiarity ?? 0) >= 8);
  if (fam && close) extra.push(`Say hi to ${fam.name} for me.`);
  if (extra.length && chance(r, 0.3)) return choose(r, x, "bye:ctx", extra);
  return phrase(r, x, y, close && chance(r, 0.5) ? "byeClose" : "bye", {}, world.time);
}

/** The last chat these two had (before this one), if it was recent. */
function lastChat(world: WorldState, a: Citizen, b: Citizen, convId: number): Conversation | null {
  for (let i = world.conversationLog.length - 1; i >= 0; i--) {
    const c = world.conversationLog[i];
    if (c.id === convId || c.status !== "done") continue;
    if ((c.a === a.id && c.b === b.id) || (c.a === b.id && c.b === a.id)) return world.time - c.endT < 5 * 1440 ? c : null;
  }
  return null;
}

/** Something that happened to them lately that isn't town news: a deal, a loan, a new job, a favour, a betrayal. */
function lifeEvent(world: WorldState, x: Citizen, now: number, used: Set<string>, listener?: Citizen): Memory | null {
  let best: Memory | null = null;
  for (const m of [...x.memories.short, ...x.memories.long]) {
    if (now - m.t > 2 * 1440 || used.has(`event:${m.id}`) || m.importance < 5 || Math.abs(m.valence) < 0.35) continue;
    if ((listener && m.people.includes(listener.id)) || !stillTrue(world, x, m)) continue;
    if (!["deal", "loan", "job", "business", "financial", "favor", "betrayal"].includes(m.kind)) continue;
    if (!/\b(I|me|my|I'm|I've)\b/.test(m.text) || /^(Talked|Chatted|Wrote)/.test(m.text) || /\btold me about\b|^Read about/.test(m.text)) continue;
    if (!best || m.importance * Math.abs(m.valence) > best.importance * Math.abs(best.valence)) best = m;
  }
  return best;
}

/** Money worries the way you'd say them out loud (not "I need income"). */
function spokenWorry(r: RngHolder, x: Citizen, s: ReturnType<typeof situation>): string {
  const pounds = (n: number) => `£${Math.max(0, Math.floor(n))}`;
  const when = s.rentDueIn <= 1 ? "tonight" : "in two days";
  if (s.rent > 0 && s.rentDueIn <= 2 && s.liquid < s.rent * 1.15) {
    return s.liquid < s.rent
      ? choose(r, x, "worry:rent:short", [`Rent's due ${when} and I'm ${pounds(s.rent - s.liquid)} short.`, `I've got ${pounds(s.liquid)} to my name and rent's ${pounds(s.rent)}. It's due ${when}.`, `I can't make rent. It's due ${when}.`])
      : choose(r, x, "worry:rent:tight", [`Rent's due ${when}. Once it's paid I've got about ${pounds(s.liquid - s.rent)} left.`, `I can just about make rent ${when}, and then I'm skint.`]);
  }
  if (x.rentArrears > 0) return choose(r, x, "worry:arrears", [`I'm behind on rent. ${money(x.rentArrears)} behind.`, `I owe the landlord ${money(x.rentArrears)}. If I don't pay soon, I'm out.`]);
  return choose(r, x, "worry:low", [`I'm down to my last ${pounds(s.liquid)}.`, `Money's tight. Really tight.`, `I've got ${pounds(s.liquid)} and nothing coming in.`]);
}

/** Questions about something that happened to someone, each with answers that fit it. Leaves out what they've already said. */
function lifeQuestion(ev: Memory, good: boolean): [string, string[]][] {
  const t = ev.text;
  const said = { pay: /£/.test(t), why: /\b(for|because)\b/.test(t) };
  const all: [string, string[]][] =
    ev.kind === "job"
      ? good
        ? [
            ["Do you like it?", ["So far, yes.", "Early days, but yes.", "It's better than nothing."]],
            ["How are you finding it?", ["Tiring, but good.", "Still learning the ropes.", "Better than I expected."]],
            ["What are the people like?", ["Nice enough.", "Mostly alright. One or two characters."]],
            ...(said.pay ? [] : ([["What's the pay like?", ["Enough to live on.", "Better than nothing."]]] as [string, string[]][])),
          ]
        : [
            ...(said.why ? [] : ([["What happened?", ["They said I wasn't pulling my weight.", "Don't really want to talk about it."]]] as [string, string[]][])),
            ["What will you do now?", ["Look for something else, I suppose.", "No idea yet.", "Try CityCorp, maybe. They take most people."]],
            ["Are you alright for money?", ["For now. Just about.", "Not really, no."]],
          ]
      : ev.kind === "deal"
        ? good
          ? [["How did you pull that off?", ["Right place, right time.", "Patience. And a bit of luck."]], ["Will you do it again?", ["If I can.", "Watch this space."]]]
          : [["What went wrong?", ["Bought too high. Classic.", "Bad timing, mostly."]], ["Will you try again?", ["Not for a while.", "Probably. I never learn."]]]
        : ev.kind === "loan"
          ? /\bI lent\b/.test(t)
            ? [["Will they pay you back?", ["They'd better.", "I hope so."]]]
            : [["How long have you got to pay it back?", ["A week or two.", "Not long enough."]], ["Are you alright with that?", ["It's fine. It'll be fine.", "Ask me next week."]]]
          : ev.kind === "business"
            ? good
              ? [["What's next?", ["Grow it, if I can.", "Keep the lights on, mostly."]]]
              : [["Are you going to keep going?", ["I'll give it another week.", "I don't know yet."]]]
            : ev.kind === "financial"
              ? good
                ? [["What are you going to do with it?", ["Save it. Probably.", "Pay off a few things."]], ["Treating yourself?", ["Maybe a little treat.", "No, it's going in the pot."]], ["Any plans for it?", ["Not yet.", "Rainy day fund."]]]
                : [["Are you alright for money?", ["Just about.", "I'll manage."]]]
              : ev.kind === "favor"
                ? good
                  ? [["That was good of them.", ["It really was.", "I'll have to pay them back somehow."]]]
                  : []
                : ev.kind === "betrayal"
                  ? [["What are you going to do about it?", ["Nothing. Just steer clear.", "I haven't decided."]], ["Have you said anything to them?", ["Not yet.", "What's the point?"]]]
                  : [];
  return all;
}

/** Plan and voice a whole chat between a and b. */
export function improvise(world: WorldState, conv: Conversation, a: Citizen, b: Citizen): Improv {
  const was = talkIn((world.talkRecent ??= []), world.time);
  try {
    return improviseChat(world, conv, a, b);
  } finally {
    talkIn(was, world.time);
  }
}

function improviseChat(world: WorldState, conv: Conversation, a: Citizen, b: Citizen): Improv {
  const r: RngHolder = { rng: hashSeed(`${world.seed}:${conv.id}:improv`) };
  const lines: ConversationLine[] = [];
  const notes: ConvNote[] = [];
  const topics: string[] = [];
  const brief: string[] = [];
  const used = new Set<string>();
  let headline: string | null = null;
  const ab = (c: Citizen) => (c.id === a.id ? "A" : "B");
  const say = (c: Citizen, text: string) => lines.push({ speaker: c.id, text: sentence(text) });
  const P = (sp: Citizen, to: Citizen, move: string, vars: Record<string, string> = {}) => phrase(r, sp, to, move, vars, world.time);
  const hour = hourOf(world);
  const leisure = LEISURE.has(a.activity.kind) && LEISURE.has(b.activity.kind);
  const maxLines = leisure ? 16 : 7;
  const room = (n: number) => lines.length + n <= maxLines - 1;
  const fam = peekRel(a, b.id)?.familiarity ?? 0;
  const enemies = hostile(a, b.id) || hostile(b, a.id);
  const storm = world.happenings.some((h) => h.kind === "storm" && !h.ended && world.time >= h.t && world.time < h.until);
  const close = closeness(a, b.id) > 0.4;
  const where = conv.buildingId ? world.map.buildings.find((x) => x.id === conv.buildingId)?.type : null;
  /** They've talked about what happened to them: their own town news doesn't get told again in this chat. */
  const toldOwn = (c: Citizen) => {
    for (const k of c.news) if (happeningById(world, k.id)?.subject === c.id) used.add(`news:${k.id}`);
  };

  // ------------------------------------------------------------- hello
  if (fam < 5 && !a.family.includes(b.id)) {
    say(a, P(a, b, "meet"));
    say(b, P(b, a, "meetBack"));
    brief.push("A and B meet for the first time and introduce themselves.");
    if (room(2) && chance(r, 0.6)) {
      // Getting to know each other: what do you do?
      const what = (x: Citizen) => {
        const biz = x.businessIds.map((id) => world.businesses[id]).find((q) => q && q.open);
        if (biz) return choose(r, x, "intro:biz", [`I run ${biz.name}.`, `I've got ${biz.name}. Come by sometime.`, `${biz.name} is mine. Well, mine and the bank's.`]);
        const place = workplace(world, x);
        if (place) return choose(r, x, "intro:job", [`I work at ${place}.`, `I'm at ${place}. For my sins.`, `${place}. It pays the rent.`]);
        if (x.occupation === "unemployed") return choose(r, x, "intro:none", ["Between jobs, at the moment.", "Looking for work, honestly.", "Nothing right now. Something'll come up."]);
        return choose(r, x, "intro:occ", [`I'm a ${x.occupation}.`, `${capitalise(x.occupation)}. It's a living.`, `I'm a ${x.occupation}, would you believe.`]);
      };
      say(a, choose(r, a, "intro:ask", ["What do you do?", "So what do you do with yourself?", "What keeps you busy?", "What do you do for a living?"]));
      say(b, what(b));
      if (room(1)) say(b, choose(r, b, "intro:back", ["You?", "And you?", "What about you?"]));
      if (room(1)) {
        const same = a.occupation === b.occupation && !a.businessIds.length && !b.businessIds.length && a.employerId === b.employerId;
        say(a, same ? choose(r, a, "intro:same", [`Same, actually! ${capitalise(a.occupation)} too.`, "Snap! Same as you.", "Ha! Same thing. Small world."]) : what(a));
      }
      notes.push({ t: "rel", who: a.id, about: b.id, affinity: 1, trust: 0 }, { t: "rel", who: b.id, about: a.id, affinity: 1, trust: 0 });
      brief.push("They say what they each do.");
    }
  } else if (enemies) {
    say(a, memoryCallback(a, b, "greet", `${conv.id}:g`, Math.floor(world.time / 1440)) ?? P(a, b, "greetCold"));
    say(b, hostile(b, a.id) ? P(b, a, "coldBack") : P(b, a, "coldNeutral"));
    brief.push("A and B don't get on; the greeting is frosty.");
  } else {
    // Something between them colours the hello ("I still owe you for yesterday"), but not every time they meet.
    const cbKey = `cb:${b.id}`;
    const cb = (a.said ?? []).includes(cbKey) ? null : memoryCallback(a, b, "greet", `${conv.id}:g`, Math.floor(world.time / 1440));
    if (cb) (a.said ??= []).push(cbKey);
    const spot = a.activity.kind === "work" && b.activity.kind === "work" ? "work" : where;
    const greets = spot && PLACE_GREETS[spot] && !(spot === "park" && storm) && chance(r, 0.35) ? PLACE_GREETS[spot] : null;
    if (cb) {
      say(a, cb);
      // The thanks waved off, or the grudge pushed back on.
      if (/owe you/.test(cb)) say(b, choose(r, b, "cb:owe", ["Don't be daft.", "Any time. You know that.", "Don't mention it.", "You'd do the same for me."]));
      else if (/show your face|really\?|Back already/.test(cb)) say(b, choose(r, b, "cb:grudge", ["Are we still on that?", "That's not fair, and you know it.", "I said I was sorry.", "Let it go, will you?"]));
    } else if (greets) {
      // A hello about the place, and an answer to it.
      const hello = choose(r, a, `pg:${spot}`, greets.map((g) => g[0]));
      const pair = greets.find((g) => g[0] === hello)!;
      say(a, hello.replace(/\{you\}/g, b.name));
      say(b, choose(r, b, `pga:${spot}:${greets.indexOf(pair)}`, pair[1]));
      say(a, P(a, b, "askHowAnyway"));
    } else say(a, P(a, b, close ? "greetFriend" : "greetAcquaintance"));
    // Nobody answers a question that wasn't asked: if the hello didn't ask how they are, they either
    // come out with their news anyway, or get asked.
    const fine = howTheyAre(r, world, b, a);
    const lastLine = lines[lines.length - 1];
    let asked = lastLine.speaker === a.id && asksHow(lastLine.text);
    if (!asked && (lastLine.speaker === b.id || !fine.news)) {
      if (lastLine.speaker === a.id) lastLine.text = sentence(`${lastLine.text} ${P(a, b, "askHow")}`);
      else say(a, P(a, b, "askHowAnyway"));
      asked = true;
    }
    if (fine.news) {
      // Their day comes out straight away: answer that, not the small talk.
      const good = fine.news.valence > 0;
      const small = fine.small;
      if (asked) say(b, fine.text);
      else {
        const lead = P(b, a, good ? (small ? "newsLeadSmall" : "newsLeadGood") : small ? "newsLeadSmallBad" : "newsLeadBad");
        say(b, `${P(b, a, "greetBack")} ${lead} ${/but$/.test(lead) ? lowerStart(world, fine.told) : fine.told}`);
      }
      const envious = good && (a.emotions.envy > 35 || (a.traits.competitiveness > 0.7 && !close));
      const glad = !good && (feelingsToward(a, b.id).anger ?? 0) > 25;
      say(a, glad ? P(a, b, "gloat") : good ? P(a, b, envious ? (small ? "envySmall" : "envyReply") : small ? "congratsSmall" : "congrats") : P(a, b, small ? "sympathySmall" : "sympathy"));
      if (room(2) || /\?$/.test(lines[lines.length - 1].text)) say(b, P(b, a, good ? (small ? "elaborateGoodSmall" : "elaborateGood") : small ? "elaborateBadSmall" : "elaborateBad"));
      if (!good && !glad && !small && room(2) && (close || a.personality.big5.agreeableness > 0.55)) {
        say(a, P(a, b, "comfort"));
        if (room(1) && chance(r, 0.6)) say(b, P(b, a, "thanks"));
        notes.push({ t: "feel", who: b.id, e: { sadness: -4, fear: -3, loneliness: -5 } }, { t: "rel", who: b.id, about: a.id, affinity: 3, trust: 2 });
      } else if (envious) notes.push({ t: "feel", who: a.id, e: { envy: 5 } });
      else if (glad) notes.push({ t: "rel", who: b.id, about: a.id, affinity: -3, trust: -2 });
      used.add(`event:${fine.news.id}`);
      toldOwn(b);
      topics.push(good ? `${b.name}'s good news` : `${b.name}'s bad day`);
      brief.push(`A greets B; B says straight away how their day has really gone ("${fine.news.text}"); A is ${glad ? "secretly pleased" : good ? (envious ? "envious" : "delighted for them") : "sympathetic"}.`);
    } else {
      const askBack = !close || chance(r, 0.6);
      say(b, askBack ? `${fine.text} ${P(b, a, "askBack")}` : fine.text);
      if (fine.mood === "bad" && closeness(a, b.id) > 0.15 && chance(r, 0.7) && room(3)) {
        // "Not great." "Why, what's up?"
        say(a, choose(r, a, "whatsup", ["Why, what's up?", "Oh? What's happened?", "That doesn't sound good. What's wrong?", "Uh oh. Talk to me.", "What's going on?"]));
        const d = dominantEmotion(b);
        const cause = d ? causeOf(world, b, d.emotion, world.time) : null;
        say(b, cause ? sentence(toYou(cause.text, a)) : choose(r, b, "nocause", ["Oh, nothing in particular. Just one of those weeks.", "I don't even know. Everything and nothing.", "Long story. I'll bore you with it another time."]));
        if (cause) {
          toldOwn(b);
          used.add(`event:${cause.id}`);
        }
        const supportive = b.personality.big5.agreeableness > 0.4 || closeness(a, b.id) > 0.4 ? a.personality.big5.agreeableness > 0.35 || closeness(a, b.id) > 0.5 : false;
        say(a, cause && isSmall(b, cause) ? P(a, b, "sympathySmall") : P(a, b, supportive ? "supportive" : "dismissive"));
        if (/\?$/.test(lines[lines.length - 1].text)) say(b, choose(r, b, "support:ans", ["I'll be alright. Thanks.", "Just talking helps, honestly.", "Not really. But thanks."]));
        notes.push(supportive ? { t: "feel", who: b.id, e: { sadness: -4, loneliness: -5 } } : { t: "feel", who: b.id, e: { sadness: 2 } }, { t: "rel", who: b.id, about: a.id, affinity: supportive ? 3 : -2, trust: supportive ? 2 : 0 });
        used.add("feelings");
        topics.push(`how ${b.name} feels`);
        brief.push(`A greets B; B isn't doing well${cause ? ` ("${cause.text}")` : ""}, and A is ${supportive ? "supportive" : "dismissive"}.`);
      } else if (askBack) {
        const mine = howTheyAre(r, world, a, b);
        if (mine.news && room(3) && fine.mood !== "bad") {
          say(a, mine.text);
          const good = mine.news.valence > 0;
          say(b, good ? P(b, a, mine.small ? "congratsSmall" : "congrats") : P(b, a, mine.small ? "sympathySmall" : "sympathy"));
          if (room(1)) say(a, P(a, b, good ? (mine.small ? "elaborateGoodSmall" : "elaborateGood") : mine.small ? "elaborateBadSmall" : "elaborateBad"));
          used.add(`event:${mine.news.id}`);
          toldOwn(a);
          topics.push(good ? `${a.name}'s good news` : `${a.name}'s bad day`);
        } else {
          // Having just heard they're not doing well, nobody says "Great! Life's good."
          const ack = choose(r, a, "ack:bad", ["Sorry to hear that.", "Oh dear.", "Ah, that's no good.", "Oh no.", "Poor you."]);
          say(
            a,
            fine.mood === "bad"
              ? `${ack} ${mine.mood === "good" ? P(a, b, "howFine") : mine.text}`
              : mine.mood === fine.mood && mine.mood === "fine" && chance(r, 0.4)
                ? P(a, b, "sameHere")
                : mine.mood === "good" && fine.mood === "good" && chance(r, 0.5)
                  ? `${choose(r, a, "me:too", ["Me too, as it happens.", "Same! Good day all round.", "Ha, me too."])} ${mine.text}`
                  : mine.text,
          );
          if (mine.mood === "bad" && closeness(b, a.id) > 0.15 && chance(r, 0.6) && room(3)) {
            say(b, choose(r, b, "whatsup", ["Why, what's up?", "Oh? What's happened?", "That doesn't sound good. What's wrong?", "Uh oh. Talk to me.", "What's going on?"]));
            const d = dominantEmotion(a);
            const cause = d ? causeOf(world, a, d.emotion, world.time) : null;
            say(a, cause ? sentence(toYou(cause.text, b)) : choose(r, a, "nocause", ["Oh, nothing in particular. Just one of those weeks.", "I don't even know. Everything and nothing.", "Long story. I'll bore you with it another time."]));
            if (cause) {
              toldOwn(a);
              used.add(`event:${cause.id}`);
            }
            const supportive = b.personality.big5.agreeableness > 0.35 || closeness(b, a.id) > 0.5;
            say(b, cause && isSmall(a, cause) ? P(b, a, "sympathySmall") : P(b, a, supportive ? "supportive" : "dismissive"));
            if (/\?$/.test(lines[lines.length - 1].text)) say(a, choose(r, a, "support:ans", ["I'll be alright. Thanks.", "Just talking helps, honestly.", "Not really. But thanks."]));
            notes.push(supportive ? { t: "feel", who: a.id, e: { sadness: -4, loneliness: -5 } } : { t: "feel", who: a.id, e: { sadness: 2 } }, { t: "rel", who: a.id, about: b.id, affinity: supportive ? 3 : -2, trust: supportive ? 2 : 0 });
            used.add("feelings");
            topics.push(`how ${a.name} feels`);
          }
        }
        brief.push(`A greets B${close ? " (they're close)" : ""}; they say how they are.`);
      } else brief.push(`A greets B${close ? " (they're close)" : ""}; B says how they are.`);
    }
  }

  // --- what each of them could bring up
  type Cand = { key: string; weight: number; run: () => void };
  const candidates = (x: Citizen, y: Citizen): Cand[] => {
    const out: Cand[] = [];
    const X = ab(x);
    const Y = ab(y);
    const xy = closeness(x, y.id);
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
              say(x, P(x, y, "ownNewsIntro"));
              say(y, P(y, x, "tellMore"));
              say(x, ownStory(r, x, world, h));
            } else if (chance(r, 0.5)) {
              say(x, P(x, y, "newsAsk", { about: h.about }));
              say(y, P(y, x, "newsNo"));
              say(x, retell(r, x, world, h));
            } else {
              const news = retell(r, x, world, h);
              say(x, P(x, y, "newsBlurt", { news, newsLower: lowerStart(world, news) }));
            }
            const small = h.amount > 0 && h.amount < Math.max(20, 0.1 * (x.money + x.savings));
            const react = h.subject === x.id ? reactionToYou(r, y, h, sy, small) : reaction(r, y, world, h, sy);
            say(y, react);
            // A question in the reaction gets an answer before anything else.
            // (Answered even when the chat is nearly over: a question isn't left hanging.)
            const asked = /\?$/.test(react);
            if (asked) say(x, answerReaction(r, x, world, h, k.stance, react));
            const qa = asked || h.subject === x.id ? null : question(r, y, x, h, lines[lines.length - 2]?.text ?? "");
            if (qa && room(2) && chance(r, 0.65)) {
              say(y, qa[0]);
              say(x, qa[1]);
            }
            if (room(1) && Math.abs(k.stance - sy) > 0.8) {
              say(x, opinion(r, x, world, h, k.stance));
              const concede = y.personality.big5.agreeableness > 0.6 && (peekRel(y, x.id)?.trust ?? 0) > 20;
              if (room(1)) say(y, P(y, x, concede ? "concede" : "disagree"));
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
            say(x, h.subject === x.id ? ownAfter(r, x, h) : P(x, y, "newsAgain", { about: h.about }));
            say(y, opinion(r, y, world, h, ky.stance));
            if (debate && room(2)) {
              say(x, opinion(r, x, world, h, k.stance));
              const concede = y.personality.big5.agreeableness > 0.6 && (peekRel(y, x.id)?.trust ?? 0) > 25;
              say(y, P(y, x, concede ? "concede" : "disagree"));
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
    // Following up on last time.
    const last = lastChat(world, x, y, conv.id);
    if (last && !used.has("callback") && xy > -0.2) {
      const t = last.topics ?? [];
      const theirs = (s: string) => s.startsWith(`${y.name}'s`) || s === `how ${y.name} feels`;
      const follow: (() => [string, string, string, number]) | null = t.includes(`how ${y.name} feels`) || t.includes(`${y.name}'s bad day`)
        ? () => {
            const d = dominantEmotion(y);
            const better = !d || ["joy", "love", "pride", "gratitude"].includes(d.emotion) || d.level < 45;
            return [
              choose(r, x, "cb:feel", ["Are you feeling any better than last time?", "You seemed a bit down last time. Better now?", "How are you doing, really? After the other day?", "I've been thinking about what you said last time. You OK?"]),
              better ? choose(r, y, "cb:feel:yes", ["Much better, thanks. It passed.", "Yeah, a lot better. Thanks for asking.", "Better. Talking helped, actually."]) : choose(r, y, "cb:feel:no", ["Not really, if I'm honest.", "Up and down. Mostly down.", "Getting there. Slowly."]),
              better ? "feeling better" : "still struggling",
              better ? 1 : -1,
            ];
          }
        : t.includes("money worries") || t.includes(`${y.name}'s plans`) || t.includes("saving up")
          ? () => {
              const s = situation(world, y);
              const have = Math.round(y.money + y.savings);
              const saving = t.includes("saving up") || t.includes(`${y.name}'s plans`);
              const ok = s.pressure < 0.4;
              return [
                saving
                  ? choose(r, x, "cb:save", ["How's the saving going?", "Still putting money away?", "How's the pot looking?"])
                  : choose(r, x, "cb:money", ["Did you get the money thing sorted?", "Any better with the money side of things?", "Last time you were worried about money. Sorted?"]),
                saving
                  ? ok
                    ? choose(r, y, "cb:save:yes", [`Not bad. ${money(have)} so far.`, `Slowly. I'm at ${money(have)}.`, "Getting there. Little and often."])
                    : choose(r, y, "cb:save:no", ["Badly. Something always comes up.", `Gone backwards. I'm down to ${money(have)}.`, "Don't ask."])
                  : ok
                    ? choose(r, y, "cb:money:yes", [`Getting there. I've got ${money(have)} now.`, "Just about, thanks. Touch wood.", `Better. ${money(have)} in the pot.`])
                    : choose(r, y, "cb:money:no", ["Not yet. Still worrying.", `Worse, honestly. I'm down to ${money(have)}.`, "Don't ask. It's still a mess."]),
                s.pressure < 0.4 ? "money getting better" : "money still tight",
                s.pressure < 0.4 ? 1 : -1,
              ];
            }
          : t.includes(`${y.name}'s dream`)
            ? () => [
                choose(r, x, "cb:dream", [`Any closer to ${y.personality.dream.replace(/\btheir\b/g, "your")}?`, "Still dreaming big?", "Done anything about that dream of yours?"]),
                choose(r, y, "cb:dream:a", ["A tiny bit closer. Baby steps.", "Not yet. But I haven't given up.", "I've started saving for it, actually."]),
                "their dream",
                0,
              ]
            : (() => {
                const news = t.map((s) => world.happenings.find((h) => h.about === s)).find((h): h is Happening => !!h && !used.has(`news:${h.id}`));
                if (!news) return null;
                return () => {
                  const over = news.ended || world.time > news.until;
                  const biz = news.businessId ? world.businesses[news.businessId] : null;
                  return [
                    choose(r, x, "cb:news", [`Any more news about ${news.about}?`, `Did anything come of ${news.about}?`, `Whatever happened with ${news.about}?`]),
                    news.kind === "fire" && biz
                      ? biz.open
                        ? choose(r, y, "cb:fire:open", [`${biz.name}'s back open, actually.`, `They've reopened. Smells of paint now.`])
                        : choose(r, y, "cb:fire:shut", [`${biz.name}'s still shut.`, "Still boarded up. Sad to see."])
                      : over
                        ? choose(r, y, "cb:over", ["It's all blown over now.", "Old news. Everyone's moved on.", "Nothing since. Funny how quick people forget."])
                        : choose(r, y, "cb:on", ["Still going on. People can't stop talking about it.", "Nothing new. Still the talk of the town."]),
                    news.about,
                    news.kind === "fire" && biz ? (biz.open ? 1 : -1) : over ? (news.tone < 0 ? 1 : 0) : news.tone < 0 ? -1 : 0,
                  ];
                };
              })();
      const followed = follow ?? (t.some((s) => !theirs(s) && world.citizens[world.citizenOrder.find((id) => world.citizens[id].name === s) ?? ""])
        ? () => {
            const z = world.citizens[world.citizenOrder.find((id) => t.includes(world.citizens[id].name)) ?? ""];
            const mad = (peekRel(y, z.id)?.affinity ?? 0) < -10;
            return [
              choose(r, x, "cb:who", [`Seen ${z.name} since we talked?`, `Have you made up with ${z.name}?`, `How are things with ${z.name}?`]),
              mad ? choose(r, y, "cb:who:no", [`Still not talking to ${z.name}.`, `Don't. ${z.name}'s still the same.`]) : choose(r, y, "cb:who:yes", [`We're alright now, me and ${z.name}.`, `${z.name}? Fine, actually. Water under the bridge.`]),
              z.name,
              mad ? -1 : 1,
            ];
          }
        : null);
      if (followed) {
        out.push({
          key: "callback",
          weight: 1.1 + xy,
          run: () => {
            const [q, ans, what, tone] = followed();
            say(x, chance(r, 0.4) ? `${choose(r, x, "cb:lead", ["I meant to ask.", "Oh, I've been wondering.", "Before I forget."])} ${q}` : q);
            say(y, ans);
            if (room(1))
              say(
                x,
                tone > 0
                  ? choose(r, x, "cb:react:good", ["Good. I'm glad.", "That's a relief.", "Brilliant. About time something went right.", "Glad to hear it."])
                  : tone < 0
                    ? choose(r, x, "cb:react:bad", ["Oh dear. Keep me posted.", "That's a shame. Let me know if I can help.", "Hang in there.", "Hm. Shout if you need anything."])
                    : choose(r, x, "cb:react:meh", ["Huh. Fair enough.", "Well, keep me posted.", "Funny how things go."]),
              );
            notes.push({ t: "rel", who: y.id, about: x.id, affinity: 2, trust: 1 });
            topics.push(what);
            brief.push(`${X} follows up on what they talked about last time (${what}); ${Y} updates them.`);
          },
        });
      }
    }
    // Something that happened to them lately (a deal, a loan, a new job...).
    const ev = lifeEvent(world, x, world.time, used, y);
    if (ev && (xy > 0 || x.traits.sociability > 0.6)) {
      out.push({
        key: `event:${ev.id}`,
        weight: 0.8 + ev.importance / 10,
        run: () => {
          used.add(`event:${ev.id}`);
          const good = ev.valence > 0;
          if (chance(r, 0.5)) say(x, choose(r, x, "ev:lead", ["Did I tell you?", "So, guess what.", "Oh, this'll make you laugh. Or cry.", "I've got news, actually.", "Something happened yesterday."]));
          say(x, sentence(toYou(ev.text, y)));
          const envious = good && ev.kind !== "loan" && (y.emotions.envy > 35 || y.traits.competitiveness > 0.75);
          const small = isSmall(x, ev);
          const borrowed = ev.kind === "loan" && /lent me|borrowed/.test(ev.text);
          say(
            y,
            borrowed
              ? choose(r, y, "ev:loan:borrowed", ["Glad you got it sorted.", "That's a weight off, then.", "Good. Just make sure you pay it back on time."])
              : ev.kind === "loan"
                ? choose(r, y, "ev:loan:lent", ["That's good of you.", "Generous of you.", "Hope they pay you back."])
                : good
                  ? P(y, x, envious ? (small ? "envySmall" : "envyReply") : small ? "congratsSmall" : "congrats")
                  : P(y, x, small ? "sympathySmall" : "sympathy"),
          );
          if (/\?$/.test(lines[lines.length - 1].text)) {
            // "Do you want to talk about it?" gets an answer, not another question.
            say(x, P(x, y, good ? (small ? "elaborateGoodSmall" : "elaborateGood") : small ? "elaborateBadSmall" : "elaborateBad"));
          } else if (room(2)) {
            const qa = lifeQuestion(ev, good);
            if (qa.length) {
              const q = choose(r, y, `ev:ask:${ev.kind}:${good ? "good" : "bad"}`, qa.map((p) => p[0]));
              const i = qa.findIndex((p) => p[0] === q);
              say(y, q);
              say(x, choose(r, x, `ev:ans:${ev.kind}:${good ? "good" : "bad"}:${i}`, qa[i][1]));
            } else say(x, P(x, y, good ? (small ? "elaborateGoodSmall" : "elaborateGood") : small ? "elaborateBadSmall" : "elaborateBad"));
          }
          notes.push({ t: "rel", who: x.id, about: y.id, affinity: envious ? -1 : 2, trust: 1 });
          if (envious) notes.push({ t: "feel", who: y.id, e: { envy: 5 } });
          topics.push(ev.kind === "job" ? (good ? `${x.name}'s new job` : `${x.name} losing their job`) : good ? `${x.name}'s good news` : `${x.name}'s troubles`);
          brief.push(`${X} tells ${Y} something that happened to them ("${ev.text}"); ${Y} is ${good ? (envious ? "envious" : "pleased for them") : "sympathetic"}.`);
        },
      });
    }
    // Gossip about someone they both know.
    const f = strongestFeelingAboutSomeone(world, x);
    const z = f && f.id !== y.id ? world.citizens[f.id] : null;
    if (f && z && (peekRel(y, z.id)?.familiarity ?? 0) >= 8 && !used.has(`gossip:${z.id}`)) {
      out.push({
        key: `gossip:${z.id}`,
        weight: (f.level / 40) * (0.5 + x.traits.sociability) * (xy > 0 ? 1 : 0.4),
        run: () => {
          const bad = f.emotion === "anger" || f.emotion === "envy";
          const mem = [...x.memories.long, ...x.memories.short].filter((m) => m.people.includes(z.id) && (bad ? m.valence < -0.3 : m.valence > 0.3) && m.kind !== "conversation" && stillTrue(world, x, m) && !used.has(`event:${m.id}`)).sort((p, q) => q.importance * q.strength - p.importance * p.strength)[0];
          const opener =
            f.emotion === "anger"
              ? [`${z.name} has been driving me up the wall.`, `Don't get me started on ${z.name}.`, `Can I say something about ${z.name}? Between us?`, `I've had it up to here with ${z.name}.`, `${z.name}. Honestly. I could scream.`]
              : f.emotion === "envy"
                ? [`Have you seen how well ${z.name} is doing? Unbelievable.`, `${z.name} makes it all look so easy.`, `How is ${z.name} doing so well? Seriously, how?`, `Everything ${z.name} touches turns to gold.`]
                : [`${z.name} has been so good to me lately.`, `${z.name} is one of the good ones, you know.`, `I don't know what I'd do without ${z.name}.`, `${z.name} really came through for me.`];
          say(x, choose(r, x, `gossip:${f.emotion}`, opener));
          if (mem && room(1) && !/^Talked with/.test(mem.text)) {
            say(x, sentence(toYou(mem.text, y)));
            used.add(`event:${mem.id}`);
          }
          const yz = closeness(y, z.id) + ((feelingsToward(y, z.id).anger ?? 0) > 20 ? -0.6 : 0);
          let agree: boolean;
          if (bad) {
            agree = yz < -0.15;
            say(y, yz > 0.35 ? P(y, x, "gossipDefend", { who: z.name }) : agree ? P(y, x, "gossipAgree") : P(y, x, "gossipUnsure", { who: z.name }));
          } else {
            agree = yz > -0.15;
            say(y, yz < -0.35 ? P(y, x, "praiseDoubt", { who: z.name }) : P(y, x, "praiseAgree", { who: z.name }));
          }
          if (agree && bad && room(2) && chance(r, 0.5)) {
            // Piling on: they each have a story.
            const theirs = [...y.memories.long, ...y.memories.short].find((m) => m.people.includes(z.id) && m.valence < -0.3 && m.kind !== "conversation" && stillTrue(world, y, m));
            if (theirs) {
              say(y, `${choose(r, y, "gossip:pile", ["Same here.", "You're not the only one.", "Listen to this."])} ${sentence(toYou(theirs.text, x))}`);
              say(x, choose(r, x, "gossip:wow", ["No! Really?", "See? It's not just me.", "Unbelievable."]));
            }
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
    if (s.worry && (xy > 0.3 || x.emotions.fear > 50) && !used.has("worry")) {
      out.push({
        key: "worry",
        weight: 1.2 + s.pressure,
        run: () => {
          if (chance(r, 0.4)) say(x, choose(r, x, "worry:lead", ["Can I be honest with you?", "I'm a bit worried, actually.", "Can I tell you something?", "Don't tell anyone, but..."]));
          say(x, spokenWorry(r, x, s));
          const kind = y.personality.big5.agreeableness > 0.5 || closeness(y, x.id) > 0.5;
          const save = y.reflections.some((l) => l.key === "money:save");
          const canGive = y.traits.generosity > 0.6 && closeness(y, x.id) > 0.6 && y.money > 120 && s.pressure > 0.6;
          if (canGive) {
            const amount = Math.min(50, Math.round((15 + y.traits.generosity * 35) / 5) * 5);
            say(y, P(y, x, "giveMoney", { amount: money(amount) }));
            if (room(1)) say(x, P(x, y, "takeMoney"));
            notes.push({ t: "gift", from: y.id, to: x.id, amount, why: "money worries" });
          } else if (kind) {
            say(y, save ? P(y, x, "saveAdvice") : P(y, x, "kind"));
            if (/\?$/.test(lines[lines.length - 1].text)) say(x, choose(r, x, "worry:ask:ans", ["Not really. I just needed to say it out loud.", "Just listening helps, honestly.", "I don't think so. Thanks, though."]));
            else if (room(2) && chance(r, 0.5)) {
              // Practical help from their own life.
              const tip =
                y.occupation === "employee" && x.occupation === "unemployed"
                  ? choose(r, y, "worry:tip:job", ["CityCorp's hiring, you know. I'll put a word in.", "Have you tried CityCorp? They're always short of people."])
                  : y.traits.frugality > 0.6
                    ? choose(r, y, "worry:tip:thrift", ["Cook at home. The diner's a money pit.", "Groceries from the market, not the café. Saves a fortune."])
                    : choose(r, y, "worry:tip:any", ["Is there anything you can sell?", "Could you pick up some extra shifts?", "Talk to the bank before it gets worse."]);
              say(y, tip);
              say(x, choose(r, x, "worry:tip:ok", ["That's a thought. Thanks.", "I might just do that.", "Maybe. Yeah. Thanks."]));
            }
            notes.push({ t: "feel", who: x.id, e: { fear: -4, loneliness: -4 } }, { t: "rel", who: x.id, about: y.id, affinity: 3, trust: 2 });
          } else {
            say(y, P(y, x, "unkind"));
            if (room(1)) say(x, choose(r, x, "unkind:hurt", ["Thanks for that.", "Wow. OK.", "I'll remember that.", "Forget I said anything."]));
            notes.push({ t: "feel", who: x.id, e: { sadness: 3 } }, { t: "rel", who: x.id, about: y.id, affinity: -2, trust: 0 });
          }
          topics.push("money worries");
          brief.push(`${X} admits money worries ("${s.worry}"); ${Y} ${canGive ? "gives them some money" : kind ? "is sympathetic" : "isn't very sympathetic"}.`);
          headline ??= canGive ? `💬 ${y.name} helped ${x.name} out with a bit of cash.` : `💬 ${x.name} opened up to ${y.name} about money worries.`;
        },
      });
    }
    // How they really feel (if it hasn't come up already).
    const d = dominantEmotion(x);
    if (d && d.level >= 40 && !["joy", "love", "pride", "gratitude"].includes(d.emotion) && xy > 0.2 && !used.has("feelings")) {
      out.push({
        key: "feelings",
        weight: 0.8 + d.level / 100,
        run: () => {
          used.add("feelings");
          const line: Partial<Record<Emotion, string[]>> = {
            sadness: ["I've been feeling really low lately.", "I've not been right this week, if I'm honest.", "Everything feels a bit grey at the moment."],
            fear: ["I can't stop worrying, to be honest.", "I've been lying awake worrying.", "I'm scared, if I'm honest."],
            anger: ["I'm just so angry at the moment.", "I'm fed up. Properly fed up.", "Everything's winding me up lately."],
            loneliness: ["I've been a bit lonely, if I'm honest.", "Some days I don't speak to anyone.", "It's nice to just talk to someone."],
            envy: ["Everyone seems to be doing better than me.", "Why does everyone else have it sorted?"],
            shame: ["I made a right mess of things.", "I'm a bit embarrassed about something."],
          };
          say(x, choose(r, x, `feel:${d.emotion}`, line[d.emotion] ?? ["I've not been myself lately."]));
          const cause = causeOf(world, x, d.emotion, world.time);
          if (cause) used.add(`event:${cause.id}`);
          if (cause && room(1)) say(x, `${choose(r, x, "feel:since", ["Ever since", "It started when", "It's since"])} ${lowerStart(world, toYou(cause.text, y).replace(/[.!]+$/, ""))}.`);
          const supportive = y.personality.big5.agreeableness > 0.5 || closeness(y, x.id) > 0.5;
          say(y, P(y, x, supportive ? "supportive" : "dismissive"));
          if (supportive) notes.push({ t: "feel", who: x.id, e: { [d.emotion]: -6, loneliness: -5 } }, { t: "rel", who: x.id, about: y.id, affinity: 4, trust: 2 });
          else notes.push({ t: "rel", who: x.id, about: y.id, affinity: -2, trust: 0 });
          topics.push(`how ${x.name} feels`);
          brief.push(`${X} admits feeling ${d.emotion}${cause ? ` since: "${cause.text}"` : ""}; ${Y} is ${supportive ? "supportive" : "dismissive"}.`);
          headline ??= `💬 ${x.name} opened up to ${y.name}.`;
        },
      });
    }
    // Family: asking after someone in the other's family.
    const kin = y.family.map((id) => world.citizens[id]).find((q) => q && q.id !== x.id && (peekRel(x, q.id)?.familiarity ?? 0) >= 5);
    if (kin && !used.has(`family:${kin.id}`) && xy > -0.1) {
      out.push({
        key: `family:${kin.id}`,
        weight: 0.45,
        run: () => {
          say(x, choose(r, x, "fam:ask", [`How's ${kin.name} doing?`, `How's ${kin.name}? Haven't seen them in ages.`, `Give my best to ${kin.name}. How are they?`, `Is ${kin.name} keeping well?`]));
          const kd = dominantEmotion(kin);
          const kwork = workplace(world, kin);
          const kbiz = kin.businessIds.map((id) => world.businesses[id]).find((q) => q && q.open);
          const ans = kd && ["sadness", "fear", "anger", "loneliness"].includes(kd.emotion)
            ? choose(r, y, "fam:bad", [`${kin.name}'s having a hard time, actually.`, `Not great. ${kin.name}'s been worrying about money.`, `${kin.name}'s a bit down. I keep an eye on them.`])
            : kbiz
              ? choose(r, y, "fam:biz", [`Busy with ${kbiz.name}. I hardly see them.`, `${kin.name}'s working all hours at ${kbiz.name}.`])
              : kwork
                ? choose(r, y, "fam:job", [`Good, thanks. Still at ${kwork}.`, `${kin.name}'s fine. ${kwork} keeps them busy.`])
                : choose(r, y, "fam:ok", [`${kin.name}'s fine, thanks for asking.`, "Oh, same as ever.", `${kin.name}'s good. I'll tell them you asked.`]);
          say(y, ans);
          notes.push({ t: "rel", who: y.id, about: x.id, affinity: 2, trust: 1 });
          topics.push(kin.name);
          brief.push(`${X} asks after ${kin.name}, ${Y}'s family.`);
        },
      });
    }
    // A dream, between close friends at leisure.
    if (xy > 0.5 && leisure && !used.has("dream")) {
      out.push({
        key: "dream",
        weight: 0.45,
        run: () => {
          const dream = x.personality.dream.replace(/\btheir\b/g, "my");
          say(x, choose(r, x, "dream:say", [`Can I tell you something? I keep thinking about ${dream}.`, `You know what I really want? ${dream[0].toUpperCase()}${dream.slice(1)}.`, `I dream about ${dream}, you know. Daft, really.`, `Do you ever think about what you'd do if money didn't matter? For me it's ${dream}.`]));
          const shared = x.personality.values.some((v) => y.personality.values.includes(v));
          const keen = shared || y.personality.big5.agreeableness > 0.55;
          say(y, P(y, x, keen ? "dreamKeen" : "dreamDoubt"));
          if (/\?$/.test(lines[lines.length - 1].text)) say(x, choose(r, x, "dream:stop", ["Money, mostly.", "Rent. It's always rent.", "Nerve, if I'm honest.", "Time. And money."]));
          if (keen && room(2) && chance(r, 0.5)) {
            const mine = y.personality.dream.replace(/\btheir\b/g, "my");
            say(y, choose(r, y, "dream:mine", [`Mine's ${mine}. Daft, isn't it?`, `I've always dreamed of ${mine}.`, `For me it'd be ${mine}.`]));
            say(x, choose(r, x, "dream:mine:ok", ["Not daft at all.", "We should both just go for it.", "Ha! We're as bad as each other."]));
          }
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
          const tip = asAdvice(world, lesson.text)!;
          say(
            y,
            fond && about
              ? choose(r, y, "lesson:fond", [`Funny, I've always found ${about.name} fine.`, `${about.name}? That's not my experience at all.`])
              : /^Between you and me/.test(tip)
                ? choose(r, y, "lesson:gripe", ["Good to know.", "Is that right? Huh.", "Thanks for the warning."])
                : choose(r, y, "lesson:ok", ["Noted.", "Good to know.", "I'll bear that in mind.", "Wise words.", "Thanks. I'll remember that."]),
          );
          if (about && !fond && (peekRel(y, x.id)?.trust ?? 0) > 20) notes.push({ t: "rel", who: y.id, about: about.id, affinity: lesson.valence < 0 ? -2 : 2, trust: lesson.valence < 0 ? -3 : 3 });
          topics.push(about ? about.name : "some advice");
          brief.push(`${X} passes on a lesson: "${lesson.text}"; ${Y} ${fond ? "disagrees" : "takes note"}.`);
        },
      });
    }
    // Asking for advice about their own situation.
    if (!used.has("askAdvice") && xy > 0 && (x.occupation === "unemployed" || (x.traits.entrepreneurship > 0.6 && !x.businessIds.length) || situation(world, x).pressure > 0.6)) {
      out.push({
        key: "askAdvice",
        weight: 0.55,
        run: () => {
          let q: string;
          let ans: string;
          if (x.occupation === "unemployed") {
            q = choose(r, x, "adv:job:q", ["How did you get your job, if you don't mind me asking?", "Any tips for finding work round here?", "Do you know anyone who's hiring?"]);
            const place = workplace(world, y);
            ans = place
              ? choose(r, y, "adv:job:a", [`I just kept going back to ${place} until they said yes.`, `Try ${place}. Ask for the manager, not the front desk.`, `Persistence. I applied to ${place} three times.`])
              : choose(r, y, "adv:job:b", ["CityCorp's your best bet. They take most people.", "Freelancing, maybe? The Cowork Hub's always got something.", "Honestly? I'm the wrong person to ask."]);
          } else if (x.traits.entrepreneurship > 0.6 && !x.businessIds.length) {
            q = choose(r, x, "adv:biz:q", ["Do you reckon I should open my own shop?", "Would you go into business, if you were me?", "I keep thinking about starting something. Mad?"]);
            ans = y.traits.risk > 0.6 || y.businessIds.length
              ? choose(r, y, "adv:biz:yes", ["Do it. Worst case, you learn something.", "Life's short. Go for it.", "If you've got a bit saved, why not?"])
              : choose(r, y, "adv:biz:no", ["Save first. Shops eat money.", "I'd wait. The rent on those places is brutal.", "Bit risky, isn't it?"]);
          } else {
            q = choose(r, x, "adv:money:q", ["What would you do, in my shoes?", "How do you manage it all?", "How do you keep on top of your money?"]);
            ans = y.traits.frugality > 0.55 ? choose(r, y, "adv:money:thrift", ["Write everything down. Every penny.", "No takeaways. That's my secret.", "I put a little away every single day."]) : choose(r, y, "adv:money:loose", ["Honestly? I don't. I just hope.", "Ask me when I've worked it out.", "Something always turns up."]);
          }
          say(x, q);
          say(y, ans);
          if (room(1)) say(x, choose(r, x, "adv:thanks", ["That's helpful, actually.", "Hm. I'll think about it.", "Thanks. Really."]));
          notes.push({ t: "rel", who: x.id, about: y.id, affinity: 2, trust: 2 });
          topics.push("some advice");
          brief.push(`${X} asks ${Y} for advice about their situation, and ${Y} gives it.`);
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
          say(y, workQuestion(r, y, world, x, biz?.id ?? null));
          const { answer, good } = workAnswer(r, x, world, x, avg);
          say(x, answer);
          const yEarn = y.finance.occupationEarnings.slice(-3);
          const yAvg = yEarn.length ? yEarn.reduce((p, q) => p + q, 0) / yEarn.length : 0;
          const envious = good && yAvg < avg * 0.5 && (y.traits.competitiveness > 0.6 || y.emotions.envy > 30);
          if (room(1)) say(y, good ? P(y, x, envious ? "envyReply" : "workGood") : P(y, x, "workBad"));
          if (room(2) && chance(r, 0.4) && !used.has(`work:${y.id}`)) {
            // And back the other way.
            say(x, choose(r, x, "work:back", ["And yours?", "How's yours going?", "And how's work for you?"]));
            say(y, workAnswer(r, y, world, y, yAvg).answer);
            used.add(`work:${y.id}`);
          }
          if (envious) notes.push({ t: "feel", who: y.id, e: { envy: 6 } });
          topics.push(biz ? biz.name : "work");
          brief.push(`${Y} asks about work; ${X} says: "${answer}"${envious ? `; ${Y} is envious` : ""}.`);
        },
      });
    }
    // What they're working towards.
    const plan = planLine(world, x);
    if (plan && !used.has("plans") && xy > 0.1 && !(x.goal.kind === "beat_rival" && x.goal.label.includes(y.name))) {
      out.push({
        key: "plans",
        weight: 0.4,
        run: () => {
          if (chance(r, 0.5)) say(x, P(x, y, "planIntro"));
          const goal = lowerStart(world, x.goal.label.replace(/[.!]+$/, ""));
          say(x, x.goal.kind === "survive" ? plan : choose(r, x, "plan:say", [plan, `My goal? To ${goal}.`, `I've set myself a target: ${goal}.`, `I'm determined to ${goal}. This year, if it kills me.`, `Everything's going towards one thing: to ${goal}.`]));
          const target = x.goal.target;
          const have = Math.round(x.money + x.savings);
          if (target && room(2) && have < target && /save|savings|net worth|deposit|rent/i.test(x.goal.label)) say(x, choose(r, x, "plan:sofar", [`I'm at ${money(have)} so far.`, `${money(have)} in the pot. Long way to go.`, `Got ${money(have)}. Getting there.`]));
          const saver = y.reflections.some((l) => l.key === "money:save");
          const rival = y.traits.competitiveness > 0.65 && x.goal.kind === "get_rich";
          if (y.goal.label === x.goal.label && room(2)) {
            say(y, P(y, x, "planSame"));
            const theirs = Math.round(y.money + y.savings);
            if (x.goal.target && theirs < x.goal.target) say(y, theirs > have ? `I'm at ${money(theirs)}. Race you.` : `I'm only at ${money(theirs)}.`);
            notes.push({ t: "rel", who: x.id, about: y.id, affinity: 3, trust: 1 }, { t: "rel", who: y.id, about: x.id, affinity: 3, trust: 1 });
            topics.push("saving up");
            brief.push(`${X} and ${Y} find they're both trying to ${lowerStart(world, x.goal.label)}.`);
            return;
          }
          const warm = saver || y.personality.big5.agreeableness > 0.6 || y.personality.big5.conscientiousness > 0.6;
          say(y, saver ? P(y, x, "saveAdvice") : rival ? P(y, x, "planRival") : warm ? P(y, x, "planGood") : P(y, x, "planMeh"));
          notes.push({ t: "feel", who: x.id, e: warm ? { pride: 2, joy: 2 } : { sadness: 1 } });
          if (warm || rival) notes.push({ t: "rel", who: x.id, about: y.id, affinity: warm ? 2 : -1, trust: warm ? 1 : 0 });
          topics.push(`${x.name}'s plans`);
          brief.push(`${X} talks about what they're working towards ("${x.goal.label}"); ${Y} ${warm ? "is encouraging" : rival ? "is competitive about it" : "is unimpressed"}.`);
        },
      });
    }
    // What they're up to later (and maybe doing it together).
    const later = laterLine(r, world, x);
    if (later && !used.has("later") && xy > 0) {
      out.push({
        key: "later",
        weight: 0.4 + (leisure ? 0.2 : 0),
        run: () => {
          say(y, choose(r, y, "later:q", ["What are you up to later?", "Any plans for the rest of the day?", "Doing anything nice later?", "Busy day ahead?", "Any plans for tonight?"].filter((q) => hour < 17 || !/rest of the day|day ahead/.test(q))));
          say(x, later);
          const join = xy > 0.4 && y.traits.sociability > 0.5 && /pub|park|drink|see|meet|café|cafe|eat/i.test(later);
          if (room(2)) {
            if (join) {
              say(y, choose(r, y, "later:join", ["Mind if I tag along?", "Ooh, I might join you.", "Save me a seat."]));
              say(x, choose(r, x, "later:yes", ["The more the merrier.", "Go on then.", "I'd like that."]));
              notes.push({ t: "rel", who: x.id, about: y.id, affinity: 3, trust: 1 }, { t: "rel", who: y.id, about: x.id, affinity: 3, trust: 1 });
            } else {
              const chore = /work|shop|accounts|restock|applications|CityCorp|job/i.test(later);
              const quiet = /home|bed|nothing|feet up|quiet/i.test(later);
              say(y, chore ? choose(r, y, "later:chore", ["Rather you than me.", "Don't work too hard.", "No rest for the wicked."]) : quiet ? choose(r, y, "later:quiet", ["Sounds perfect, honestly.", "Nothing wrong with that.", "Bliss."]) : choose(r, y, "later:ok", ["Sounds good.", "Enjoy that.", "Lovely."]));
            }
          }
          topics.push(`${x.name}'s plans for later`);
          brief.push(`${Y} asks what ${X} is up to later ("${later}")${join ? `, and invites themselves along` : ""}.`);
        },
      });
    }
    // Teasing, between friends who like a laugh.
    if (xy > 0.45 && (x.personality.style === "sarcastic" || x.personality.style === "chatty" || x.traits.sociability > 0.7) && !used.has("tease")) {
      const rich = y.money + y.savings > 600;
      const ybiz = y.businessIds.map((id) => world.businesses[id]).find((q) => q && q.open);
      const jibes = [
        ...(rich ? [`Look at you, ${y.name}. Too posh to buy me a coffee?`, "Have you bought your yacht yet?"] : []),
        ...(ybiz ? [`Still pretending ${ybiz.name} makes money?`, `Do they let you take samples at ${ybiz.name}?`] : []),
        ...(y.occupation === "unemployed" ? ["Living the life of leisure, I see."] : []),
        ...(y.personality.likes.includes("the pub") ? ["Didn't see you in the pub last night. Are you ill?"] : []),
        "You look like you slept in a hedge.",
        "Is that the same jumper as yesterday?",
        "Still can't parallel park, I hear.",
      ];
      out.push({
        key: "tease",
        weight: 0.4,
        run: () => {
          used.add("tease");
          say(x, choose(r, x, "tease", jibes));
          const thinSkin = y.personality.big5.neuroticism > 0.7;
          say(y, thinSkin ? choose(r, y, "tease:hurt", ["That's a bit harsh.", "Thanks. Thanks a lot.", "Was that necessary?"]) : choose(r, y, "tease:back", ["Says you.", "Cheeky.", "Look who's talking.", "I'll remember that.", "Ha! You're one to talk."]));
          if (!thinSkin && room(1)) say(x, choose(r, x, "tease:laugh", ["Ha! Only joking.", "You love me really.", "Someone's got to keep you humble."]));
          notes.push({ t: "rel", who: y.id, about: x.id, affinity: thinSkin ? -2 : 2, trust: 0 });
          topics.push("a bit of banter");
          brief.push(`${X} teases ${Y}; ${Y} ${thinSkin ? "takes it badly" : "gives as good as they get"}.`);
        },
      });
    }
    // The economy, when it's booming or crashing.
    if (world.economy.mode !== "normal" && !used.has("economy")) {
      const boom = world.economy.mode === "boom";
      out.push({
        key: "economy",
        weight: 0.6,
        run: () => {
          used.add("economy");
          say(x, boom ? choose(r, x, "eco:boom", ["Is it me, or is everyone flush at the moment?", "This boom's mad, isn't it?", "Town's buzzing. Never seen it this busy."]) : choose(r, x, "eco:crash", ["This crash is scary.", "Everyone's tightening their belts.", "Have you seen how quiet it is? Since the crash?"]));
          const exposed = y.businessIds.length > 0 || y.occupation === "trader" || y.occupation === "reseller";
          say(y, boom ? (exposed ? choose(r, y, "eco:boom:biz", ["Best week I've had all year.", "Make hay while the sun shines."]) : choose(r, y, "eco:boom:no", ["Not for me it isn't.", "Doesn't seem to reach my wallet."])) : exposed ? choose(r, y, "eco:crash:biz", ["Don't. My takings have halved.", "I'm barely covering the rent."]) : choose(r, y, "eco:crash:no", ["Glad I've got a steady job.", "Keep your head down and it'll pass."]));
          topics.push(boom ? "the boom" : "the crash");
          brief.push(`${X} and ${Y} talk about the ${boom ? "boom" : "crash"}.`);
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
          say(x, choose(r, x, "price:say", [`Have you seen the price of ${swing.name}? ${up ? "Up" : "Down"} ${pct}% since yesterday.`, `${capitalise(swing.name)} ${up ? "went up" : "dropped"} ${pct}% overnight. Mad.`, `${capitalise(swing.name)} ${up ? "up" : "down"} ${pct}% in a day. What's going on?`]));
          const sells = y.businessIds.some((id) => (world.businesses[id]?.inventory[swing.pid]?.qty ?? 0) > 0) || (y.inventory[swing.pid]?.qty ?? 0) > 0;
          say(
            y,
            sells
              ? up
                ? choose(r, y, "price:sell:up", ["Good. I've got plenty to sell.", "Don't tell everyone, but that suits me fine."])
                : choose(r, y, "price:sell:down", ["Don't. I'm sitting on a load of stock.", "Ouch. There goes my profit."])
              : up
                ? choose(r, y, "price:buy:up", ["Daylight robbery.", "Everything's going up.", "I'll be doing without, then."])
                : choose(r, y, "price:buy:down", ["Might stock up, then.", "About time something got cheaper."]),
          );
          topics.push(`the price of ${swing.name}`);
          brief.push(`${X} mentions ${swing.name} prices moving ${swing.pct}% since yesterday; ${Y} ${sells ? "has some to sell" : "would be buying"}.`);
        },
      });
    }
    // Something they both like.
    const like = x.personality.likes.find((l) => y.personality.likes.includes(l) && SHARED_LIKE[l] && !(l === "the pub" && hour < 12) && !(l === "the park" && storm));
    if (like && !used.has(`like:${like}`) && xy > -0.1) {
      out.push({
        key: `like:${like}`,
        weight: 0.4 * (leisure ? 1.5 : 1),
        run: () => {
          const pairs = SHARED_LIKE[like];
          const i = Math.floor(rand(r) * pairs.length) % pairs.length;
          say(x, choose(r, x, `like:${like}`, [pairs[i][0], ...pairs.filter((_, j) => j !== i).map((p) => p[0])]));
          const asked = pairs.find((p) => lines[lines.length - 1].text.startsWith(p[0].slice(0, 12))) ?? pairs[i];
          say(y, asked[1]);
          if (asked[2] && room(1)) say(x, asked[2]);
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
          say(x, choose(r, x, `gripe:${g.dislike}`, g.line));
          const same = y.personality.dislikes.includes(g.dislike);
          const opposite = (g.dislike === "early mornings" && y.personality.big5.conscientiousness > 0.7) || (g.dislike === "crowds" && y.personality.likes.includes("people-watching"));
          say(
            y,
            same
              ? P(y, x, "gripeSame")
              : opposite
                ? g.dislike === "early mornings"
                  ? choose(r, y, "gripe:early", ["Best part of the day, this!", "Early bird catches the worm."])
                  : "I quite like it, actually. All the faces."
                : P(y, x, "gripeShrug"),
          );
          if (same) notes.push({ t: "rel", who: x.id, about: y.id, affinity: 2, trust: 0 });
          topics.push(g.dislike);
          brief.push(`${X} grumbles about ${g.dislike}; ${Y} ${same ? "agrees" : opposite ? "rather likes it" : "shrugs it off"}.`);
        },
      });
    }
    // Things raised in their last chat are less likely to come up again.
    const lastTopics = new Set(lastChat(world, x, y, conv.id)?.topics ?? []);
    for (const c of out) if (c.key !== "callback" && [...lastTopics].some((t) => c.key.includes(t) || (c.key === "worry" && t === "money worries"))) c.weight *= 0.25;
    return out;
  };

  // --- the middle of the chat: a few topics, taking turns to lead
  const soc = (a.traits.sociability + b.traits.sociability) / 2;
  let n = 1 + (soc > 0.5 ? 1 : 0) + (close ? 1 : 0) + (leisure ? 1 : 0) + (leisure && close && soc > 0.6 ? 1 : 0);
  if (enemies) n = 1;
  if (!leisure) n = Math.min(n, 1 + (chance(r, 0.3) ? 1 : 0));
  n = Math.min(4, n);
  for (let i = 0; i < n && room(3); i++) {
    const lead = i % 2 === 0 ? a : b;
    const other = lead === a ? b : a;
    let cands = candidates(lead, other);
    if (cands.length === 0) cands = candidates(other, lead);
    if (cands.length === 0) break;
    const c = weightedPick(r, cands, (x) => Math.max(0.01, x.weight));
    if (!c) break;
    used.add(c.key);
    // Moving on to something else, now and then said out loud ("Anyway, have you heard...").
    const before = lines.length;
    c.run();
    const first = lines[before];
    if (first && before > 3 && chance(r, 0.45) && !/^[A-Z][a-z]+[,!]/.test(first.text)) {
      const sp = world.citizens[first.speaker];
      const lead = choose(r, sp, "turn", ["Anyway,", "Oh, before I forget,", "Speaking of which,", "Changing the subject,", "On another note,", "Oh, that reminds me,", "Right, anyway,", "Oh! I meant to say,", "By the way,", "Listen,"]);
      first.text = `${lead} ${lowerStart(world, first.text)}`;
    }
  }

  // --- goodbye (after answering anything still hanging)
  const hanging = lines[lines.length - 1];
  if (hanging && /\?$/.test(hanging.text) && !/(can you believe it|isn't it|eh|alright|really)\?$/i.test(hanging.text)) {
    const other = hanging.speaker === a.id ? b : a;
    say(other, choose(r, other, "hang:ans", ["I'll be alright. Thanks.", "Not really, but thanks.", "Maybe. We'll see.", "Ha. Ask me another time."]));
  }
  if (lines.length < maxLines + 3) {
    const festival = world.happenings.find((h) => h.kind === "festival" && !h.ended && world.time < h.until && knows(a, h.id) && knows(b, h.id));
    const party = world.happenings.find((h) => h.kind === "party" && !h.ended && world.time < h.until && h.subject && h.subject !== a.id && h.subject !== b.id && knows(a, h.id) && knows(b, h.id));
    if (!enemies && festival && rand(r) < 0.4) {
      say(a, choose(r, a, "bye:fest", ["See you at the festival?", "Are you going to the festival later?", "Festival tonight?"]));
      if (lines.length < maxLines) say(b, (knows(b, festival.id)?.stance ?? 0) > 0.2 ? choose(r, b, "bye:fest:y", ["Definitely!", "Wouldn't miss it.", "Course!"]) : choose(r, b, "bye:fest:n", ["Maybe. Not really my scene.", "Probably not, to be honest."]));
    } else if (!enemies && party && rand(r) < 0.4) {
      say(a, `See you at ${world.citizens[party.subject!]?.name ?? "the"}'s party tonight?`);
      if (lines.length < maxLines) say(b, choose(r, b, "bye:party", ["Wouldn't miss it.", "If I can drag myself out.", "I'll be the one by the snacks."]));
    } else {
      const lastSpeaker = lines[lines.length - 1]?.speaker;
      const x = enemies ? a : lastSpeaker === a.id ? b : a;
      const y = x === a ? b : a;
      say(x, enemies ? P(x, y, "byeCold") : goodbye(r, world, x, y, close, storm));
      const bye = lines[lines.length - 1].text;
      if (!enemies) say(y, P(y, x, /take care|good to see|look after|good talking|nice chatting|always a pleasure|good to speak/i.test(bye) && chance(r, 0.5) ? "byeBackToo" : "byeBack"));
    }
  }

  const uniq = [...new Set(topics)];
  const summary = uniq.length ? `${a.name} and ${b.name} talked about ${list(uniq.slice(0, 3))}.` : `${a.name} and ${b.name} caught up.`;
  topics.splice(0, topics.length, ...uniq);
  return { lines, notes, topics, brief, summary, headline };
}

/** When the chat ends: pass on the news, shift opinions and friendships, hand over any money promised. */
/** Words that show a happening came up in what was said. */
const MENTIONS: Record<Happening["kind"], RegExp> = {
  fire: /fire|burn|smoke|blaze/i,
  burglary: /burgl|broke in|break-in|broken into|robbed|stole|thie/i,
  lottery: /lottery|won|numbers came up|jackpot/i,
  celebrity: /celebrit|famous|telly|star\b/i,
  food_poisoning: /poison|sick|ill\b|dodgy|stomach/i,
  festival: /festival/i,
  storm: /storm|rain|wind|weather/i,
  power_cut: /power|electric|lights|blackout/i,
  rent_rise: /rent/i,
  sculpture: /column|sculpture|statue|monument/i,
  party: /party|birthday/i,
};

export function applyNotes(world: WorldState, conv: Conversation): void {
  // In a chat the AI spoke live, they talked about what they chose: news only passes on if it came up.
  const said = conv.live ? conv.lines.map((l) => l.text).join(" ") : null;
  for (const n of conv.notes ?? []) {
    switch (n.t) {
      case "news": {
        const to = world.citizens[n.to];
        const from = world.citizens[n.from];
        const h = happeningById(world, n.id);
        if (!to || !from || !h) break;
        if (said !== null && !MENTIONS[h.kind]?.test(said)) break;
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
