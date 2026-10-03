import { situation } from "../ai/situation";
import { citizenAcc, transfer } from "../economy/ledger";
import { logEvent } from "../events";
import { remember } from "../memory/memory";
import { dominantEmotion, feel, feelingsToward, strongestFeelingAboutSomeone } from "../mind/emotions";
import { memoryCallback } from "../mind/voice";
import { chance, hashSeed, pick, rand, weightedPick, type RngHolder } from "../rng";
import { happeningById, knows, learnNews, stanceOn } from "../town/happenings";
import type { Citizen, CitizenId, Conversation, ConversationLine, ConvNote, Emotion, Happening, Memory, WorldState } from "../types";
import { clamp, money } from "../util";
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
  if ((m = t.match(/^(.+) isn't paying like I hoped$/))) return `Honestly? ${m[1]} isn't paying like I hoped.`;
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
    say(a, cb ?? (close ? pick(r, [`${b.name}! There you are.`, `Alright ${b.name}? How's things?`, `${b.name}! Long day?`]) : pick(r, [`${hello}, ${b.name}.`, `Alright ${b.name}?`, `${hello}! How are you doing?`])));
    const d = dominantEmotion(b);
    const how: Partial<Record<Emotion, string[]>> = {
      sadness: ["Not great, honestly.", "I've had better weeks."],
      anger: ["Don't ask.", "Fuming, if I'm honest."],
      fear: ["Bit on edge, to be honest.", "Worried, mostly."],
      joy: ["Brilliant, actually!", "Really good, thanks!"],
      loneliness: ["Better now someone's talking to me."],
      love: ["Can't complain at all."],
      envy: ["Fine. Some of us have to work for it."],
      pride: ["Pretty good, actually."],
      gratitude: ["Good, thanks. People have been kind."],
      shame: ["Oh, you know. Getting by."],
    };
    say(b, pick(r, (d && how[d.emotion]) || ["Can't complain. You?", "Same old, same old.", "Getting by."]));
    brief.push(`A greets B${close ? " (they're close)" : ""}; B says how they are${d ? ` (mostly ${d.emotion})` : ""}.`);
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
            headline ??= h.subject === x.id ? `🗞️ ${x.name} told ${y.name} what happened to them: ${h.title.charAt(0).toLowerCase()}${h.title.slice(1)}.` : `🗞️ ${x.name} told ${y.name} about ${h.about}.`;
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
          say(y, biz ? pick(r, [`How's ${biz.name} doing?`, "How's business?", "Shop busy?"]) : x.occupation === "unemployed" ? pick(r, ["Any luck finding work?", "Still looking for something?"]) : x.employerId === "corp" ? pick(r, ["Still at CityCorp?", "How's life at CityCorp?"]) : pick(r, ["How's work?", "Keeping busy?", "Work treating you alright?"]));
          let answer: string;
          let good = false;
          if (biz && biz.avgProfit > 30) (answer = `${biz.name} is doing great: about ${money(biz.avgProfit)} a day!`), (good = true);
          else if (biz && biz.avgProfit < 0) answer = `Honestly? ${biz.name} is struggling.`;
          else if (avg > 45) (answer = `Really well, actually. I'm making about ${money(avg)} a day.`), (good = true);
          else if (x.occupation === "unemployed") answer = "Still looking. It's grim out there.";
          else answer = pick(r, ["Ticking along.", "Could be better, could be worse.", "Same as ever.", "Busy, which is good, I suppose.", "Quiet, to be honest."]);
          say(x, answer);
          const yEarn = y.finance.occupationEarnings.slice(-3);
          const yAvg = yEarn.length ? yEarn.reduce((p, q) => p + q, 0) / yEarn.length : 0;
          const envious = good && yAvg < avg * 0.5 && (y.traits.competitiveness > 0.6 || y.emotions.envy > 30);
          if (room(1)) say(y, good ? (envious ? pick(r, ["Must be nice.", "Alright, no need to rub it in.", "Some of us aren't so lucky."]) : pick(r, ["Good for you.", "Nice one!", "Glad to hear it.", "That's brilliant."])) : pick(r, ["Hang in there.", "It'll pick up.", "Fair enough.", "That's the way it goes."]));
          if (envious) notes.push({ t: "feel", who: y.id, e: { envy: 6 } });
          topics.push(biz ? biz.name : "work");
          brief.push(`${Y} asks about work; ${X} says: "${answer}"${envious ? `; ${Y} is envious` : ""}.`);
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
      say(enemies ? a : lines.length % 2 === 0 ? a : b, enemies ? pick(r, ["Right. I'm off.", "Anyway."]) : closeness(a, b.id) > 0.4 ? pick(r, ["Good talking to you.", "Let's catch up properly soon.", "Right, I'd better get on. Take care."]) : pick(r, ["Anyway, I'd better get going.", "Right, back to it.", "Nice chatting."]));
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
