import { knows, happeningById } from "../town/happenings";
import { hourOf } from "../time";
import type { Citizen, Conversation, WorldState } from "../types";
import { money } from "../util";
import { peekBond, workplaceKey } from "./bonds";
import { cap, low, predicate, sentence, spokenDays } from "./grammar";
import { factById } from "./knowledge";
import type { Directive, Take } from "./plan";
import { profileOf } from "./profile";
import { rngFor } from "./topics";
import type { DialogueState, Move, TopicKind, TurnMeta } from "./types";
import { fillWords, pickFor, plain, sayingIn, stressOf, trimTo, voiced } from "./voice";

// The built-in fallback: a turn's plan put into words, in the speaker's
// voice, when no language model is writing (or it failed). The plan already
// carries the substance (what they're answering, how they take the news,
// what they're bringing up and from which of their memories); this turns it
// into something a person would say, in many forms, so it reads like *that*
// person and doesn't come out the same twice.

export interface Realized {
  text: string;
  meta: Omit<TurnMeta, "speaker" | "by">;
  /** Something about themselves they told the other (the listener now knows it). */
  disclosed?: { key: string; gist: string; sensitivity: number; valence: number; confidential: boolean };
  /** Money handed over to help (applied when the conversation ends). */
  gift?: number;
}

type Ctx = { world: WorldState; conv: Conversation; st: DialogueState; me: Citizen; them: Citizen; d: Directive; r: ReturnType<typeof rngFor> };

const N = (c: Citizen) => c.name;

function morningish(world: WorldState): "morning" | "afternoon" | "evening" | "night" {
  const h = hourOf(world.time);
  return h < 12 ? "morning" : h < 17 ? "afternoon" : h < 22 ? "evening" : "night";
}

/** "Ben is thinking of leaving CityCorp" -> "you're thinking of leaving CityCorp" (said to Ben). */
function toYou(text: string, name: string): string {
  return text
    .replace(new RegExp(`^${name} is\\b`), "you're")
    .replace(new RegExp(`^${name} was\\b`), "you were")
    .replace(new RegExp(`^${name} has\\b`), "you've")
    // "Ben's struggling" (is) / "Ben's been" (has) / "Ben's lottery win" (whose).
    .replace(new RegExp(`^${name}'s (\\w+)`), (_, w: string) => (/^(been|got|gone|had)$/.test(w) ? `you've ${w}` : /ing$|^(not|finally|back|off|out|about|always|never|still|just|in|on)$/.test(w) ? `you're ${w}` : `your ${w}`))
    .replace(new RegExp(`^${name}\\s+(\\w+?)s\\b`), "you $1")
    .replace(new RegExp(`^${name}\\b`), "you")
    .replace(new RegExp(`\\b${name}'s\\b`, "g"), "your")
    .replace(new RegExp(`\\b${name}\\b`, "g"), "you")
    .replace(/[.!?]+$/, "")
    .replace(/\btheir\b/g, "your")
    .replace(/\bthey're\b/g, "you're")
    .replace(/\bthemselves\b/g, "yourself")
    .replace(/\byour ([A-Z][a-z]+(?: [A-Z][a-z]+)*)/g, (_, w: string) => `your ${w.toLowerCase()}`);
}

/** "Mei was up all night" said by Mei -> "I was up all night". */
function firstPerson(text: string, name: string): string {
  return text
    .replace(new RegExp(`^${name} was\\b`), "I was")
    .replace(new RegExp(`^${name} is\\b`), "I'm")
    .replace(new RegExp(`^${name} has\\b`), "I've")
    .replace(new RegExp(`^${name}\\b`), "I")
    .replace(new RegExp(`\\b${name}'s\\b`, "g"), "my")
    .replace(new RegExp(`\\b${name}\\b`, "g"), "me");
}

/** Money mentioned in a line ("£34"), if any. */
function amountIn(text: string | undefined): string | null {
  return text?.match(/£[\d,.]+/)?.[0] ?? null;
}

// ------------------------------------------------------------ openings

function greetLine(x: Ctx): string {
  const { world, me, them, d, r } = x;
  const k = d.rel.kind;
  const part = morningish(world);
  const timely = part === "morning" ? ["Morning."] : part === "evening" || part === "night" ? ["Evening."] : [];
  const nm = N(them);
  let pool: string[];
  if (d.opener === "cold") pool = [`${nm}.`, "Oh. It's you.", "Right.", `${nm}.`];
  else if (k === "stranger") pool = ["Hello.", "Hi.", "Alright?", ...timely];
  else if (k === "boss") pool = [`Morning, ${nm}.`.replace("Morning", cap(part === "night" ? "evening" : part)), `Hi, ${nm}.`, `Alright, ${nm}?`];
  else if (k === "rival" || k === "dislikes" || k === "enemy") pool = [`${nm}.`, "Oh. Hello.", `Well, well. ${nm}.`];
  else if (k === "close friend" || k === "family") pool = ["Look who it is.", `Oi, ${nm}.`, "There they are.", `${nm}!`, "Oh, it's you.", "Hey you."];
  else if (k === "friend" || k === "friendly coworker") pool = [`${nm}!`, `Alright, ${nm}?`, "Hey.", "There they are.", `Hiya, ${nm}.`];
  else pool = [`Alright, ${nm}?`, "Hiya.", `Hi, ${nm}.`, ...timely.map((t) => t.replace(".", `, ${nm}.`))];
  // When they last saw each other changes the hello: twice in a day, or not for ages.
  const b = peekBond(me, them.id);
  const since = b?.lastT ? world.time - b.lastT : null;
  const friendly = !["stranger", "boss", "rival", "dislikes", "enemy"].includes(k) && d.opener !== "cold";
  if (friendly && since !== null && since < 300) pool = [...pool, "You again!", "Hello again.", "We must stop meeting like this.", "Twice in one day."];
  else if (friendly && since !== null && since > 5 * 1440) pool = [...pool, "Long time no see.", "Stranger!", "Where have you been hiding?", `Well, look who it is. ${nm}!`];
  if (friendly) pool = [...pool, ...(k === "close friend" || k === "family" ? ["Oi oi.", "Ey up.", `${nm}! Get over here.`] : ["Hey, you.", "Oh, hiya.", `How do, ${nm}.`])];
  let line = pickFor(world, me, r, `greet:${k}`, pool);
  if (d.askBack === "how" && d.opener !== "cold") {
    const asks = k === "stranger" ? ["How are you?", "You alright?"] : k === "close friend" || k === "family" ? ["You alright?", "What's new?", "How's things?", "How are you doing?", "Still alive, then?"] : ["How's things?", "You alright?", "How are you doing?", "How's it going?", "Keeping well?"];
    const q = pickFor(world, me, r, `ask:how:${k}`, asks);
    line = /\?$/.test(line) ? line : `${line} ${q}`;
  }
  return line;
}

function teaseOpen(x: Ctx): string {
  const { world, me, them, r } = x;
  const pool = ["You look rough.", "Look what the cat dragged in.", "Well, look who it is. Thought you'd emigrated.", "What have you done now?", "Have you slept at all?", "You look thrilled to be alive."];
  if (them.needs.energy < 35) pool.push("You look like you haven't slept in a week.");
  if (them.activity.kind === "eat") pool.push("Don't let me stop you stuffing your face.");
  const place = x.conv.buildingId ? world.map.buildings.find((b) => b.id === x.conv.buildingId)?.type : null;
  if (place === "pub") pool.push("In here again? Shocking.", "Fancy seeing you in here. Not.");
  return pickFor(world, me, r, "tease:open", pool);
}

// ------------------------------------------------------------ raising things

/** Tag questions ("isn't it?", "eh?"): they want agreement, not an answer. */
const TAG = /(,\s*|\s)(isn't|wasn't|aren't|weren't|don't|doesn't|didn't|won't|is|was|are|do|does) (it|he|she|they|you|we|there|that)\?$|,? eh\?$/i;

/** Answers to small-talk questions, by what they were about. */
const MUNDANE_ANSWERS: Record<string, string[]> = {
  "the football": ["Caught the end. Shocking.", "No, missed it. Any good?", "Don't. Just don't.", "We were awful."],
  books: ["Not really. No time.", "Started one. Fell asleep.", "Halfway through something good, actually.", "I don't read, me."],
  coffee: ["The café's not bad.", "Nowhere. Make your own.", "Don't ask me, I drink tea."],
  "lie-ins": ["Can't remember.", "Sunday. Bliss.", "What's a lie-in?"],
  gadgets: ["Don't tempt me.", "Who needs a watch? You've got a phone.", "Saw them. Daylight robbery."],
  "the pub": ["Go on then.", "Can't. Skint.", "Maybe. Depends who's going."],
  "always has a mint to offer": ["Go on.", "No, ta.", "Are you saying my breath smells?"],
  "remembers everyone's birthday": ["No idea. You're the one who keeps track.", "Is it? Don't tell me it's mine."],
  "whistles off-key": ["You were, yeah.", "Only a bit."],
  pub: ["Tell me about it.", "It's always like this."],
  power: ["Nope. Still dead at mine.", "Not on our street.", "Came back on at mine, actually."],
  storm: ["Doesn't look like it.", "Not at this rate.", "Forecast says tomorrow. I don't believe it."],
  nearby: ["Looks like it.", "Where?", "Don't look!", "Oh God, it is."],
  market: ["Daylight robbery, some of them.", "Saw that. Mad."],
};

/** Saying something back about small talk: relating, agreeing, a bit of their own. */
const RELATE: Record<string, string[]> = {
  "lie-ins": ["Lucky. I haven't had a lie-in in years.", "Jealous.", "Some of us were up at six."],
  "the football": ["Don't. I can't talk about it.", "Same as every week, then."],
  cooking: ["I can barely boil an egg.", "You'll have to make me something."],
  books: ["I haven't read a book in years.", "Lend it me when you're done."],
  gadgets: ["You don't need it. Get it anyway.", "Mine's held together with tape."],
  coffee: ["Same. I'm running on caffeine.", "Make it two."],
  bargains: ["Show me where.", "You and your bargains."],
  "the pub": ["Go on then. Later.", "Don't tempt me."],
  "the park": ["I should get out more.", "It's nice down there."],
  "quiet nights in": ["Sounds perfect.", "That's the dream, that."],
  "keeping busy": ["I couldn't keep up with you.", "Rather you than me."],
  "people-watching": ["You're nosy, you are.", "Best free entertainment in town."],
  "names every pigeon in the park": ["You and those pigeons.", "Gerald's got more friends than me."],
  "talks to their plants": ["You and your plants.", "Does it talk back, though."],
  "never finishes a cup of tea": ["Every time.", "Drink the thing!"],
  "keeps receipts for everything": ["You're mad, you know that.", "Your poor drawer."],
  "re-reads the same paperback": ["Read something else!", "It's a good one, to be fair."],
  "is always ten minutes early": ["Of course you were.", "Some of us like to make an entrance.", "Some of us have lives."],
  "can't walk past a bargain": ["Classic.", "You need help."],
  hungry: ["Same. Starving.", "Go and eat something!"],
  tired: ["Tell me about it.", "Go home and sleep."],
  storm: ["I'm soaked through.", "Typical, isn't it."],
  power: ["Whole street's out.", "Candles at mine tonight."],
  dislike: ["Tell me about it.", "You're not the only one.", "Same."],
  "whistles off-key": ["Don't you dare start humming it.", "Now it'll be stuck in mine.", "As long as it's not that one from the advert."],
  "remembers everyone's birthday": ["You and your birthdays.", "Don't tell me it's mine. I've got nothing in."],
  "always has a mint to offer": ["You and your mints.", "Go on then."],
  any: ["{agree}.", "True.", "Ha. Yeah.", "Tell me about it."],
};

/** "Oh, I meant to say," + "Did you hear...?" -> "Oh, I meant to say, did you hear...?" (names and "I" keep their capitals; after a full stop the next sentence starts afresh). */
function joinLead(world: WorldState, pre: string, body: string): string {
  if (!pre) return body;
  if (!body) return pre;
  if (/[.!?]$/.test(pre)) return `${pre} ${body}`;
  return `${pre} ${low(body, world.citizenOrder.map((id) => world.citizens[id].name))}`;
}

const TRANSITION: Record<string, string[]> = {
  casual: ["Anyway,", "I tell you what,", "Here,", ""],
  association: ["Speaking of which,", "That reminds me,", "Funny you say that.", "While we're on it,"],
  remembered: ["Oh, I meant to say,", "Oh, before I forget,", "Here, did I tell you?", "Oh, guess what."],
  rememberedQ: ["Oh, I meant to ask,", "Here,", "Random question, but", "Oh, before I forget,"],
  abrupt: ["Anyway.", "Right, completely different thing.", "Random, but"],
  boredom: ["Anyway.", "So.", "Anyway, enough of that."],
  callback: ["Here,"],
};

function newsLine(x: Ctx, hId: number, asOpener: boolean): { text: string; asks: boolean } {
  const { world, me, them, r } = x;
  const h = happeningById(world, hId);
  if (!h) return { text: "Did you hear what happened?", asks: true };
  const k = knows(me, h.id);
  const stance = k?.stance ?? 0;
  const subj = h.subject ? world.citizens[h.subject] : undefined;
  const short: Record<string, string[]> = {
    fire: [`There was a fire at ${h.about.replace(/^the fire at /, "")}. Whole place went up, apparently.`, `${cap(h.about)}. Have you seen the state of it?`],
    burglary: [`Someone broke into ${subj ? `${subj.name}'s` : "a"} place.`, `${cap(h.about)}. Can you believe it?`],
    lottery: [`${subj?.name ?? "Someone"} won the lottery!`, `${subj?.name ?? "Someone"} only went and won the lottery.`],
    celebrity: ["There's someone famous in town, apparently.", `${cap(h.about)}. Everyone's going mad.`],
    food_poisoning: [`Half the town's been ill after ${h.about.replace(/^(the )?food poisoning (at|from) /, "")}.`, `${cap(h.about)}. I'm not eating there again.`],
    festival: ["There's a festival on in the park.", "Festival's on today. Music, food stalls, the lot."],
    storm: ["Have you seen it out there?"],
    power_cut: ["Power's gone off half the town."],
    rent_rise: ["Rents are going up again.", "Landlords are putting the rent up. Again."],
    sculpture: ["There's a new column in the park. Nobody knows who put it there.", "Have you seen the column in the park? Where did that come from?"],
    party: [`${subj?.name ?? "Someone"}'s having a party.`, `${subj?.name ?? "Someone"}'s having a do tonight.`],
  };
  const tell = pickFor(world, me, r, `news:${h.kind}`, short[h.kind] ?? [`${cap(h.about)}.`]);
  const take = stance > 0.35 ? ["Good for them.", "About time.", "Brilliant."] : stance < -0.35 ? ["Terrible.", "Awful, isn't it.", "Shocking."] : [""];
  const tail = pickFor(world, me, r, `news:take:${stance > 0.35 ? "g" : stance < -0.35 ? "b" : "n"}`, take);
  if (asOpener || rand3(x) < 0.45) {
    const q = pickFor(world, me, r, "news:ask", [`Did you hear about ${h.about}?`, `Have you heard about ${h.about}?`, `You heard about ${h.about}?`]);
    return { text: q, asks: true };
  }
  void them;
  // A question doesn't get "Shocking." hung on the end of it.
  return /\?$/.test(tell) ? { text: tell, asks: true } : { text: `${tell} ${tail}`.trim(), asks: false };
}

/** "When was this?" / "Since when?": a question about when. */
function whenQ(question: string): string | null {
  return /\b(when|since when)\b/i.test(question) ? "when" : null;
}

function rand3(x: Ctx): number {
  return ((x.r.rng = (x.r.rng * 1103515245 + 12345) >>> 0) % 1000) / 1000;
}

function gossipLine(x: Ctx): { text: string; told: number[]; asks: boolean } {
  const { world, me, them, d, r } = x;
  const f = d.topic?.fact !== undefined ? factById(me, d.topic.fact) : undefined;
  if (!f) return { text: "Have you heard anything about anyone lately?", told: [], asks: true };
  const who = f.about ? world.citizens[f.about] : undefined;
  const from = f.from ? world.citizens[f.from] : undefined;
  const gist = low(f.text, world.citizenOrder.map((id) => world.citizens[id].name));
  const pp = profileOf(me);
  let lead: string;
  if (f.confidential || f.sensitivity > 0.6) lead = pickFor(world, me, r, "gossip:secret", ["Don't tell anyone, but", "Keep this to yourself, but", "You didn't hear this from me, but", "Between us,"]);
  else if (f.source === "rumour") lead = pickFor(world, me, r, "gossip:rumour", ["I heard", "Word is", "Someone said", "Apparently"]);
  else if (f.source === "work") lead = pickFor(world, me, r, "gossip:work", ["Word at work is", "Apparently", "Heard at work that"]);
  else if (from && from.id !== who?.id && from.id !== them.id) lead = pickFor(world, me, r, "gossip:from", [`${from.name} reckons`, `${from.name} told me`, `According to ${from.name},`, "Apparently"]);
  else if (from && from.id === who?.id) lead = pickFor(world, me, r, "gossip:direct", [`${who.name} told me`, `${who.name} said`]);
  else lead = pickFor(world, me, r, "gossip:plain", ["Apparently", "Did you know", "Turns out"]);
  const pre = who && !lead.includes(who.name) && rand3(x) < 0.35 + pp.gossip * 0.3 ? pickFor(world, me, r, "gossip:pre", [`Have you seen ${who.name} lately?`, `Have you spoken to ${who.name} recently?`, `Seen much of ${who.name}?`]) : "";
  const q = /^Did you know/.test(lead);
  // Once you've said their name ("Seen much of Ben?", "Ben told me"), it's "they" and "them" after.
  const named = !!who && (!!pre || lead.includes(who.name));
  const said = named && who
    ? gist
        .replace(new RegExp(`\\b${who.name}'s\\b`, "g"), "their")
        .replace(new RegExp(`^${who.name} (is|was|has)\\b`), (_, v: string) => `they${v === "is" ? "'re" : v === "was" ? " were" : "'ve"}`)
        .replace(new RegExp(`\\b${who.name} (\\w+)`, "g"), (_, w: string) => (/^(is|was|has|had|lent|owes|owed|won|lost|got|paid|opened|closed|said|told|did|does|went|will|can|could|would|might|wants|needs|borrowed|bought|sold)$/.test(w) || /ed$/.test(w) ? `they ${w}` : `them ${w}`))
        .replace(new RegExp(`\\b${who.name}\\b`, "g"), "them")
    : who
      ? gist.replace(new RegExp(`^(${who.name}\\b.*?)\\b${who.name}'s\\b`), "$1their")
      : gist;
  const body = `${lead} ${said.replace(/[.!?]+$/, "")}${q ? "?" : "."}`.replace(/,\s+/, ", ");
  const hedge = f.certainty < 0.5 ? pickFor(world, me, r, "gossip:hedge", [" Don't quote me.", " Could be rubbish.", " That's what I heard, anyway.", ""]) : "";
  return { text: `${pre} ${body}${hedge}`.trim(), told: [f.id], asks: q };
}

function followupLine(x: Ctx, cryptic: boolean): string {
  const { world, me, them, d, r } = x;
  const f = d.topic?.fact !== undefined ? factById(me, d.topic.fact) : undefined;
  const kind = f?.key.split(":")[1] ?? "";
  if (cryptic) return pickFor(world, me, r, "followup:cryptic", ["Well?", "So?", "Go on then.", "Well? Any news?"]);
  const nm = them.name;
  const lender = f?.text.match(/owes (\w+)/)?.[1];
  const biz = f?.text.match(/^(.+?) is struggling/)?.[1] ?? f?.text.match(/grow (.+)$/)?.[1];
  const pool: Record<string, string[]> = {
    job: ["Any luck with the job?", "Did CityCorp ever get back to you?", "How's the job hunt going?", "Find anything yet? Work-wise."],
    biz: ["Did you ever start that business?", "How's the saving going? For the business.", "Still going to open your own place?"],
    debt: [`Did you get ${lender ?? "them"} paid back in the end?`, "Did you sort that money out?"],
    rent: ["Did you make the rent in the end?", "You get the rent sorted?"],
    shop: [`How's ${biz ?? "the shop"} doing now?`, `Is ${biz ?? "the shop"} picking up?`],
  };
  // Troubles they told you about: asking after them, not "how did it go".
  const trouble = !pool[kind] && f && (f.pred === "problem" || f.valence < -0.25);
  const line = trouble
    ? pickFor(world, me, r, "followup:trouble", ["Things any better?", "You doing alright now? After everything?", "Any better since I saw you?", "Get it sorted in the end?", "How are things now? Honestly."])
    : pickFor(world, me, r, `followup:${kind}`, pool[kind] ?? [`How did ${d.topic?.label ?? "that"} go?`, `What happened with ${d.topic?.label ?? "that"} in the end?`]);
  return d.rel.closeness > 0.5 || rand3(x) < 0.5 ? line : `${nm}, ${line[0].toLowerCase()}${line.slice(1)}`;
}

function lifeLine(x: Ctx): { text: string; disclosed: Realized["disclosed"] } {
  const { world, me, them, d, r } = x;
  const t = d.topic!;
  const first = String(t.detail?.first ?? t.label);
  const deep = t.sensitive > 0.5;
  const confidential = deep && !d.rel.kind.includes("family") && d.rel.closeness < 0.85;
  let lead = "";
  if (t.kind === "brag") lead = pickFor(world, me, r, "life:brag", ["", "Guess what.", "Not to brag, but", "Can't complain, actually."]);
  else if (t.kind === "problem") lead = pickFor(world, me, r, "life:problem", ["", "Honestly?", "Can I tell you something?", "Not great, if I'm honest."]);
  else if (t.kind === "complain") lead = pickFor(world, me, r, "life:moan", ["", "You'll never guess what.", "Don't get me started."]);
  else if (t.kind === "plan") lead = pickFor(world, me, r, "life:plan", ["", "Big news, sort of.", "So,"]);
  else if (deep) lead = pickFor(world, me, r, "life:deep", ["Can I tell you something?", "I don't really tell people this, but", "Funny thing to admit, but"]);
  const secret = confidential ? pickFor(world, me, r, "life:secret", [" Don't tell anyone.", " Keep that to yourself.", " That stays between us."]) : "";
  const tail = t.kind === "complain" ? pickFor(world, me, r, "life:moan:tail", ["", " Unbelievable.", " Typical."]) : "";
  void them;
  const text = lead && /[a-z,]$/.test(lead) ? `${lead} ${low(first)}` : `${lead} ${first}`;
  return { text: `${text.trim()}${tail}${secret}`, disclosed: { key: t.key, gist: "", sensitivity: t.sensitive, valence: t.valence, confidential } };
}

const MUNDANE_LINES: Record<string, string[]> = {
  "the football": ["Did you catch the football?", "Listened to the match on the radio last night. {bad}.", "We were robbed, by the way. The football."],
  cooking: ["I tried making a curry last night. Never again.", "I've been doing a lot of cooking lately. Getting quite good.", "Burnt the tea again last night."],
  books: ["I'm reading this book at the moment, can't put it down.", "Read anything good lately?", "Stayed up till two reading. Again."],
  gadgets: ["I've been eyeing up a new gadget. I don't need it.", "My phone's on its last legs.", "Have you seen the new watches at the market?"],
  coffee: ["I need a coffee. Desperately.", "Where's a decent coffee round here?", "That's my third coffee today. Don't judge."],
  "lie-ins": ["I'd kill for a lie-in.", "Had a lie-in this morning. Bliss.", "When did you last have a proper lie-in?"],
  bargains: ["Got a right bargain at the market.", "Two for one on teabags. Stocked up.", "I can't walk past a sale, it's a problem."],
  "people-watching": ["Some of the people in this town, honestly.", "I could watch people in here all day.", "See that bloke by the door? He's been there for hours."],
  "the pub": ["Could murder a pint.", "Pub later?", "Haven't been down the pub in ages."],
  "the park": ["Went for a walk round the park this morning. Lovely.", "The park was heaving yesterday."],
  "quiet nights in": ["I'm having a quiet one tonight. Feet up.", "Best night I've had all week was on the sofa."],
  "keeping busy": ["I can't sit still, me. Need something to do.", "Keeping busy. Keeps me out of trouble."],
};

const QUIRK_LINES: Record<string, string[]> = {
  "names every pigeon in the park": ["Gerald's back, by the way.", "That pigeon nearly had my sandwich again.", "I've named another pigeon. Don't laugh."],
  "talks to their plants": ["My fern's not looking well.", "I've been talking to my plants again. They're good listeners."],
  "never finishes a cup of tea": ["I've made three cups of tea today and finished none of them.", "My tea's gone cold. Again."],
  "keeps receipts for everything": ["I've got a drawer full of receipts. Don't ask.", "Kept the receipt, obviously."],
  "re-reads the same paperback": ["I'm on my fifth read of that book now.", "Started my paperback again. Same ending, funnily enough."],
  "whistles off-key": ["Sorry, was I whistling?", "I've had a song stuck in my head all day."],
  "remembers everyone's birthday": ["Isn't it someone's birthday this week? I'm sure it is.", "I've got all the birthdays written down, you know."],
  "can't walk past a bargain": ["I bought something I don't need again. It was half price.", "Don't let me near the market."],
  "always has a mint to offer": ["Mint?", "Want a mint?"],
  "is always ten minutes early": ["I was here twenty minutes early. Obviously.", "I hate being late. I'd rather wait."],
};

const DISLIKE_LINES: Record<string, string[]> = {
  crowds: ["Too many people in here.", "It's {very} busy. I hate it."],
  "early mornings": ["Who decided mornings were a good idea?", "Too early for this."],
  "waiting around": ["I've been waiting ages.", "If I have to wait any longer I'll scream."],
  "the diner's coffee": ["The coffee in the diner is a crime.", "Don't drink the diner coffee. Trust me."],
  rudeness: ["Some people have no manners.", "Bloke just pushed right past me. Not a word."],
  "show-offs": ["Some people love the sound of their own voice.", "Can't stand people who show off."],
  debt: ["I hate owing anyone anything.", "Never borrow money. That's my rule."],
  waste: ["The waste in this town. It's criminal.", "They threw out a whole tray of food at the diner."],
  losing: ["I hate losing. At anything.", "Lost at cards again last night."],
  "being lied to": ["Just tell me the truth, that's all I ask.", "I can always tell when someone's lying."],
  "being told what to do": ["I don't like being told what to do.", "Nobody tells me what to do."],
  haggling: ["Why can't things just have a price?", "I hate haggling. I always lose."],
};

function environmentLine(x: Ctx): { text: string; asks: boolean } {
  const { world, me, d, r } = x;
  const det = d.topic?.detail ?? {};
  if (det.weather === "storm") return { text: pickFor(world, me, r, "env:storm", ["Perfect timing, this rain.", "I got absolutely soaked.", "It's biblical out there.", "Is it ever going to stop?"]), asks: false };
  if (det.weather === "power") return { text: pickFor(world, me, r, "env:power", ["Still no power?", "Whole street's dark.", "Power cut again. Brilliant."]), asks: false };
  if (det.nearby) return { text: pickFor(world, me, r, "env:nearby", [`Don't look now, but ${det.nearby}'s over there.`, `${det.nearby}'s here. Keep your voice down.`, `Is that ${det.nearby}?`]), asks: false };
  const place = String(det.place ?? "");
  const crowd = Number(det.crowd ?? 3);
  const busy = crowd > 5;
  const dead = crowd <= 2;
  const pools: Record<string, string[]> = {
    pub: busy ? ["Rammed in here tonight.", "Can't hear yourself think in here."] : dead ? ["Dead in here, isn't it?", "Where is everyone?"] : ["Decent pint, this.", "Nice to sit down."],
    diner: ["This is actually decent.", "Chips are better than last time.", "I swear the portions are getting smaller."],
    park: ["Nice out, isn't it?", "I love it out here.", "Look at that lot feeding the ducks."],
    market: ["Have you seen the prices on some of these stalls?", "Market's busy today.", "Half these stalls weren't here last week."],
    cowork: ["Someone's microwaved fish again.", "Wi-fi's crawling today."],
    office: ["Lift's broken again.", "Another meeting about meetings."],
    lab: ["Something in there smells like burning.", "Don't touch anything in here."],
    bank: ["Queue's a joke.", "Why is there only ever one person serving?"],
    townhall: ["Nobody knows what actually goes on in this place.", "Council's busy for once."],
    house: ["Sorry about the mess.", "Excuse the state of the place."],
    apartments: ["The lift in this place, honestly.", "Neighbours were at it again last night."],
    shop_unit: busy ? ["Busy in here today."] : ["Quiet today, isn't it?"],
    depot: ["Mind the boxes.", "Smells of cardboard in here."],
  };
  return { text: pickFor(world, me, r, `env:${place}`, pools[place] ?? ["Busy round here today.", "Quiet today."]), asks: false };
}

/** Daft questions, each with the kinds of answer it gets (from who's answering). */
const HYPOS: { q: string; a: (me: Citizen) => string[] }[] = [
  { q: "If you won the lottery, what's the first thing you'd buy?", a: (me) => money_(me) },
  { q: "Honestly, what would you do with a million quid?", a: (me) => money_(me) },
  { q: "Would you rather never have to work again, or never have to sleep?", a: (me) => (me.traits.ambition > 0.6 ? ["Never sleep. Think what I'd get done.", "Never sleep, obviously."] : ["Never work. Easy.", "Never work. I like my bed too much.", "Is that even a question? Never work."]) },
  { q: "If you could run any shop in town, what would it be?", a: (me) => [...(me.personality.likes.includes("the pub") ? ["A pub. Obviously."] : []), ...(me.personality.likes.includes("books") ? ["A bookshop. Nobody would bother me."] : []), ...(me.personality.likes.includes("coffee") ? ["A coffee place. A proper one."] : []), "A bakery. Fresh bread every morning.", "Something with no customers.", "A chippy. I'd eat the profits."] },
  { q: "What would you do if you were mayor for a day?", a: (me) => [...(me.rentArrears > 0 || me.traits.generosity > 0.6 ? ["Cap the rents. First thing."] : []), "Free coffee for everyone.", "Sack the council.", "Fix the lift in my building. Then go home.", "Ban early mornings."] },
  { q: "If you could live anywhere, where would it be? Not here, obviously.", a: (me) => [...(me.personality.values.includes("family") ? ["Wherever my family is."] : []), "By the sea.", "Somewhere warm.", "Honestly? I'd stay. Don't tell anyone.", "The countryside. Proper quiet."] },
];

function money_(me: Citizen): string[] {
  const t = me.traits;
  const p = me.personality;
  const pool: string[] = [];
  if (t.greed > 0.6) pool.push("Buy the whole market and put the prices up.", "Invest it. Then invest the profit.");
  if (t.generosity > 0.6) pool.push("Pay off everyone's rent. Then a holiday.", "Sort my family out first.");
  if (t.risk > 0.6) pool.push("Stick the lot on red. Life's too short.");
  if (p.values.includes("family")) pool.push("Proper house for my family. Done.");
  if (p.values.includes("freedom")) pool.push("Never work for anyone again.");
  if (p.dream) pool.push(`Honestly? ${cap(p.dream.replace(/\btheir\b/g, "my"))}.`);
  pool.push("No idea. Probably waste it.", "Pay off my rent for a year. Glamorous, I know.");
  return pool;
}

function hypoLine(x: Ctx): { text: string; n: number } {
  const text = pickFor(x.world, x.me, x.r, "hypo", HYPOS.map((h) => h.q));
  return { text, n: Math.max(0, HYPOS.findIndex((h) => h.q === text)) };
}

/** Their answer to the daft question in this conversation. */
function hypoAnswer(x: Ctx): string {
  const asked = [...x.st.turns].reverse().find((t) => t.q === "hypo");
  const n = Number(asked?.gist?.replace(/^hypo:/, "") ?? 0) || 0;
  return pickFor(x.world, x.me, x.r, `hypo:a${n}`, HYPOS[n]?.a(x.me) ?? ["No idea."]);
}

function eveningAnswer(x: Ctx): string {
  const { world, me, r } = x;
  const plan = me.agent?.plan?.items.find((i) => i.status === "todo" && i.hour > hourOf(world.time));
  if (plan) return `${cap(plan.label.replace(/^(Go|Head) to /, "").replace(/^Eat at /, ""))}, probably.`;
  if (me.needs.energy < 35) return pickFor(world, me, r, "eve:tired", ["Bed. Early.", "Nothing. I'm shattered.", "Early night, I reckon."]);
  if (me.personality.likes.includes("the pub")) return pickFor(world, me, r, "eve:pub", ["Pub, probably.", "Few drinks, maybe.", "The Gilded Pint, if anyone's about."]);
  if (me.personality.likes.includes("quiet evenings")) return pickFor(world, me, r, "eve:quiet", ["Nothing. Sofa.", "Quiet night in.", "Feet up, telly on."]);
  return pickFor(world, me, r, "eve:any", ["Not sure yet.", "Nothing much.", "Haven't decided."]);
}

// --------------------------------------------------------- reactions

function reactLine(x: Ctx): { text: string; tone: string; known?: boolean } {
  const { world, me, them, d, r } = x;
  const k0 = d.reply?.kind;
  const take: Take = (k0 === "gossip" || k0 === "disclose") && d.take === "practical" ? "curious" : k0 === "disclose" && d.take === "suspicious" ? "skeptical" : (d.take ?? "indifferent");
  const last = d.reply;
  const amt = amountIn(last?.gist);
  const who = last?.ref && world.citizens[last.ref] ? world.citizens[last.ref].name : null;
  const nm = them.name;
  const P: Record<Take, string[]> = {
    supportive: ["That's {good}.", "Nice one.", "Good for you. Seriously.", "About time something went your way.", "Get in."],
    impressed: ["Seriously? That's {good}.", "Get you!", "{surprise}. Nice.", "Well done, you."],
    jealous: ["Must be nice.", "Nice. Good for you.", "Lucky you.", "Some of us have to work for it."],
    competitive: [amt ? `Only ${amt}?` : "Not bad.", "Not bad. I did better last week, mind.", "Huh. Right."],
    practical: ["How much?", "Doing what?", "How did you manage that?", "When was this?"],
    suspicious: ["Legally?", "Where'd that come from?", "Hmm. Who from?"],
    dismissive: ["Everyone's has.", "Join the club.", "Could be worse.", "Right."],
    anxious: ["Wait, can they do that?", "Oh no. That's worrying.", "That's not good, is it."],
    sympathetic: ["That's {bad}.", "Oh no. I'm sorry.", "That's taking the piss, that.", `Ah, ${nm}.`, "That's rough."],
    "told-you-so": ["I told you that would happen.", "Did I not say?", "I said, didn't I?"],
    amused: ["Ha!", "That's brilliant.", "Stop it.", "{surprise}."],
    indifferent: ["Right.", "Huh.", "Okay.", "{agree}."],
    skeptical: k0 === "disclose" || k0 === "brag" || k0 === "plan" ? ["Really?", "Huh. Didn't see that coming.", "If you say so."] : ["Says who?", "I'll believe it when I see it.", who ? `Really? ${who}?` : "Really?", who ? `Doesn't sound like ${who}.` : "Sounds like rubbish to me."],
    protective: [who ? `Leave ${who} alone.` : "Leave it out.", who ? `That's not fair on ${who}.` : "That's not fair."],
    curious: k0 === "plan" ? ["Ooh. Doing what?", "Really? Like what?", "Go on then. What's the plan?"] : k0 === "brag" ? ["{surprise}. How?", "No way. Go on.", "Really?"] : k0 === "disclose" && /^(dream|fear):/.test(d.reply?.topic ?? "") ? ["Really? Why's that?", "Go on.", "Since when?"] : k0 === "disclose" ? ["{surprise}. When was this?", "Go on.", "No way.", "Really? Since when?"] : ["{surprise}. What happened?", "Really? Since when?", "Go on.", "No way."],
    awkward: ["Oh. Right. Um.", "I don't really know what to say.", "Right... sorry."],
    sarcastic: ["Brilliant. Exactly what this week needed.", "Oh, lovely.", "Well, that's just great."],
    teasing: ["Listen to you.", ...(amt ? ["Get you, moneybags."] : []), "You'll be unbearable now.", "Oh, here we go."],
  };
  // Plans for tonight, daft answers: a quick word back, no interrogation.
  if (last?.kind === "evening" || last?.kind === "hypothetical") {
    const pool = last.kind === "evening" ? (take === "jealous" || take === "competitive" ? ["Lucky you.", "Alright for some."] : ["Nice.", "Fair enough.", "Have fun.", "Sounds about right."]) : ["Ha. Fair.", "Good answer.", "Boring!", "Course you would.", "Ha. I'd have said the same."];
    return { text: pickFor(world, me, r, `react:${last.kind}`, pool), tone: "light", known: true };
  }
  // A plain answer to your question: acknowledge it.
  if (last?.move === "answer" && Math.abs(last.valence) < 0.3 && last.kind !== "news") {
    const pool = last.valence >= 0.1 ? ["Good stuff.", "Glad to hear it.", "Nice.", "Can't argue with that."] : last.valence <= -0.1 ? ["Ah well.", "Shame.", "Could be worse.", "Fair enough."] : ["Fair enough.", "Right.", "Ah, right.", "Fair.", "Okay."];
    return { text: pickFor(world, me, r, `ack:${last.valence >= 0.1 ? "g" : last.valence <= -0.1 ? "b" : "n"}`, pool), tone: "light" };
  }
  // News of the town: react to the happening itself, in their own take.
  const newsRef = last?.ref?.startsWith("news:") ? last.ref : last?.topic?.startsWith("news:") ? last.topic : null;
  if (last?.kind === "news" && newsRef) {
    const h = happeningById(world, Number(newsRef.slice(5)));
    const k = h ? knows(me, h.id) : undefined;
    const stance = k?.stance ?? (h ? h.tone : 0);
    if (h && k && k.t < world.time - 30) return { text: pickFor(world, me, r, "react:news:known", ["Yeah, I heard.", "I know. Heard this morning.", `Heard about it. ${stance < -0.3 ? "Awful." : stance > 0.3 ? "Good for them." : "Mad, isn't it."}`]), tone: "flat", known: true };
    const pool = stance > 0.3 ? ["Good for them!", "Ha! Brilliant.", "Lucky so-and-so."] : stance < -0.3 ? ["That's awful.", "Oh no. Is everyone alright?", "{surprise}. That's {bad}."] : ["Huh. Mad.", "{surprise}.", "Really?"];
    return { text: pickFor(world, me, r, `react:news:${stance > 0.3 ? "g" : stance < -0.3 ? "b" : "n"}`, pool), tone: stance < -0.3 ? "sympathetic" : "light" };
  }
  // Small talk gets small-talk back: agreeing, relating, a bit of mickey-taking.
  if (last?.kind === "mundane" || last?.kind === "environment" || (last?.kind === "complain" && /dislike/.test(last.topic ?? ""))) {
    const key = smallKey(x);
    const said = pickFor(world, me, r, `relate:${key}`, RELATE[key] ?? RELATE.any);
    const lead = take === "amused" && !/^Ha\b/.test(said) ? "Ha. " : "";
    return { text: `${lead}${said}`, tone: take === "amused" ? "amused" : "light" };
  }
  return { text: pickFor(world, me, r, `react:${take}`, P[take]), tone: take };
}

/** What a bit of small talk was about (for relating to it). */
function smallKey(x: Ctx): string {
  const k = x.d.reply?.topic ?? x.st.topic ?? "";
  if (k.startsWith("like:")) return k.slice(5);
  if (k.startsWith("quirk:")) return k.slice(6);
  if (k.startsWith("dislike:")) return "dislike";
  if (k.startsWith("body:")) return k.split(":")[1];
  if (k.startsWith("env:storm")) return "storm";
  if (k.startsWith("env:power")) return "power";
  return "any";
}

/** A follow-up question after a reaction or on their topic. */
function askLine(x: Ctx, q: string): string {
  const { world, me, d, r } = x;
  const kind = d.reply?.kind ?? d.topic?.kind ?? null;
  const pools: Record<string, string[]> = {
    detail: kind === "problem" ? ["What are you going to do?", "How much are you short?", "Have you told anyone?"] : kind === "plan" ? ["When do you find out?", "And then what?"] : kind === "brag" ? ["How'd you manage that?", "Doing what?"] : kind === "news" ? ["When was this?", "Is everyone alright?"] : ["Since when?", "How come?"],
    who: ["Who told you that?", "Says who?", "Where did you hear that?"],
    what: ["What happened?", "Go on.", "And?", "Like what?"],
    how: ["You?", "And you?", "How about you?", "You alright?"],
    you: ["You?", "And you?", "What about you?"],
    wrong: ["Why, what's up?", "What's wrong?", "Oh no. What's happened?", "Uh oh. What's going on?", "Why? What's up?"],
  };
  return pickFor(world, me, r, `ask:${q}:${kind ?? "any"}`, pools[q] ?? pools.what);
}

/** More about their own topic, when asked: when it was, or what happened (real details where there are any). */
function detailFor(x: Ctx, want: "when" | "what"): string | null {
  const { world, me, r, st } = x;
  const key = st.topic ?? "";
  const said = (t: string) => (st.said ?? []).some((s) => s.startsWith("t:") && s.includes(plain(t)));
  const whenText = (t: number) => {
    const hrs = (world.time - t) / 60;
    const h = hourOf(t);
    const nowH = hourOf(world.time);
    return hrs < 3 ? "Just now, apparently." : dayDiff(world.time, t) === 0 ? (h < 12 ? "This morning." : nowH < 17 ? "This afternoon." : "Earlier today.") : dayDiff(world.time, t) === 1 ? (h >= 18 ? "Last night." : "Yesterday.") : "A couple of days ago.";
  };
  if (key.startsWith("news:")) {
    const h = happeningById(world, Number(key.slice(5)));
    if (!h) return null;
    // Not their own news back at them.
    if (h.subject === x.them.id) return pickFor(world, me, r, "detail:theirs", ["If you need anything, just say.", "Awful thing to happen.", "You don't deserve that.", "Anything I can do?"]);
    const when = whenText(h.t);
    // The news itself first (to someone who hadn't heard), then the details.
    const parts = h.text.split(/(?<=[.!?])\s+/);
    if (want === "what" && parts[0] && !said(parts[0])) return firstPerson(parts[0], me.name);
    const second = parts.slice(1).find((s2) => s2.length < 110 && !said(s2) && !/£(\d{1,2}(\.\d+)?)\b(?![\d,])/.test(s2));
    if (want === "when" && !said(when)) return when;
    if (second) return second;
    return said(when) ? pickFor(world, me, r, "detail:news:all", ["That's all I know.", "That's all I heard, anyway.", "No idea. Ask someone else."]) : when;
  }
  if (key.startsWith("mem:")) {
    const m = [...me.memories.short, ...me.memories.long].find((mm) => `mem:${me.id}:${mm.id}` === key);
    if (want === "when" && m && !said(whenText(m.t))) return `${whenText(m.t)} ${pickFor(world, me, r, "detail:mem:tail", ["", "Still can't believe it.", "Mad, really."])}`.trim();
    const bad = ["problem", "complain"].includes(x.st.topicKind ?? "") || (m?.valence ?? 0) < -0.2;
    if (bad) return pickFor(world, me, r, "detail:mem:bad", ["Don't ask.", "Long story.", "It's a mess, honestly.", "I'd rather not go into it."]);
    return m && m.valence > 0.3 ? pickFor(world, me, r, "detail:mem:good", ["Made my week, that.", "Best thing that's happened in ages.", "I'm still buzzing, honestly."]) : pickFor(world, me, r, "detail:mem", ["Long story.", "Don't ask. Honestly.", "I'll tell you another time."]);
  }
  if (key.startsWith("dream:")) return pickFor(world, me, r, "detail:dream", ["Just want something of my own.", "Sick of working for other people.", "Why not? You only live once.", "Always have, really."]);
  if (key.startsWith("fear:")) return pickFor(world, me, r, "detail:fear", ["Seen it happen to people.", "Just a feeling.", "Money, mostly.", "Don't know. It just gets to me."]);
  if (key.startsWith("plan:")) return pickFor(world, me, r, "detail:plan", want === "when" ? ["Soon, hopefully.", "Day or two. We'll see."] : ["Depends who you ask.", "Early days.", "I'll tell you when I know."]);
  if (key.startsWith("fact:")) {
    if (want === "what") return pickFor(world, me, r, "detail:fact", ["That's all I know.", "No idea. That's just what I heard.", "Don't know any more than that."]);
    return pickFor(world, me, r, "detail:fact:when", ["Couple of days ago, I think.", "Recently, I think.", "No idea when."]);
  }
  return null;
}

function dayDiff(a: number, b: number): number {
  return Math.floor(a / 1440) - Math.floor(b / 1440);
}

/** Something from their own life that what was just said reminds them of. */
function relateLine(x: Ctx): string {
  const { world, me, d, r } = x;
  const kind = d.reply?.kind;
  if (kind === "mundane" || kind === "environment") return "";
  if (kind === "problem" || kind === "complain") return pickFor(world, me, r, "relate:problem", ["I've been there.", "Same boat, honestly.", "It's the same for everyone at the minute.", "Welcome to my life."]);
  if (kind === "brag") return pickFor(world, me, r, "relate:brag", ["I did alright myself this week, actually.", "Wish I could say the same.", "Fair play. Not my week."]);
  if (kind === "news" || kind === "gossip") return pickFor(world, me, r, "relate:news", ["Wouldn't surprise me.", "Typical, that.", "Nothing surprises me in this town."]);
  if (kind === "plan") return pickFor(world, me, r, "relate:plan", ["I keep meaning to do something like that.", "Wish I had the nerve."]);
  return "";
}

function answerLine(x: Ctx): { text: string; valence: number; gist?: string } {
  const { world, me, them, d, r } = x;
  const q = d.reply?.q ?? "what";
  if (d.answer) {
    let t = d.answer.first;
    if (q === "how" && d.answer.honest && d.answer.valence < 0 && profileOf(me).openness > 0.5 && d.rel.closeness > 0.4) {
      const item = (d.topic && d.topic.detail?.first) || null;
      if (item) t = `${t} ${item}`;
    }
    if (q === "how" && !d.answer.honest) t = pickFor(world, me, r, "how:hide", ["Fine.", "Alright.", "Can't complain.", "Fine. You know.", "Surviving.", "Oh, you know. Fine.", "Getting there.", "Yeah. Fine."]);
    else if (q === "how" && d.answer.valence > 0.3) t = pickFor(world, me, r, "how:good", [t, "Not bad at all, actually.", "Good, yeah. {good} day.", "Can't complain.", "Pretty good, to be fair.", "Yeah, good! Really good.", "Better than yesterday.", "{good}, thanks."]);
    else if (q === "how" && d.answer.first === "Alright.") t = pickFor(world, me, r, "how:ok", ["Alright.", "Not bad.", "Same old.", "Surviving.", "Yeah, fine.", "Ticking along.", "Mustn't grumble.", "Oh, you know. Plodding on.", "Could be worse."]);
    return { text: t, valence: d.answer.valence, gist: t };
  }
  if (q === "news" && d.reply?.ref?.startsWith("news:")) {
    const k = knows(me, Number(d.reply.ref.slice(5)));
    if (!k) return { text: pickFor(world, me, r, "ans:news:no", ["No, what?", "No? What happened?", "No. Go on.", "No! What?", "Don't think so. What?"]), valence: 0 };
    // How (and when) they heard: grounded in how the news actually reached them.
    const teller = world.citizens[k.via];
    const when = dayDiff(world.time, k.t) === 0 ? (hourOf(k.t) < 12 && hourOf(world.time) >= 12 ? "this morning" : "earlier") : dayDiff(world.time, k.t) === 1 ? "yesterday" : "days ago";
    const pool = [
      "Yeah, I heard.",
      "Who hasn't?",
      `Heard about it ${when}.`,
      k.talked && k.talked > 2 ? "Old news, that." : "Yeah, everyone's on about it.",
      k.via === "saw" ? "Saw it myself, actually." : k.via === "paper" ? "Read about it in the paper." : teller && teller.id !== them.id ? `Yeah, ${teller.name} told me.` : "Yeah, someone said.",
    ];
    return { text: pickFor(world, me, r, "ans:news:yes", pool), valence: 0 };
  }
  if (q === "agree") {
    const yes = d.take !== "skeptical";
    const t = yes ? pickFor(world, me, r, "ans:agree", ["{agree}.", "Tell me about it.", "It is, yeah.", "You're not wrong.", "Yeah."]) : pickFor(world, me, r, "ans:disagree", ["Is it? Seems alright to me.", "I don't mind it.", "Could be worse."]);
    return { text: d.askBack === "relate" ? `${t} ${pickFor(world, me, r, `relate:${smallKey(x)}`, RELATE[smallKey(x)] ?? RELATE.any)}` : t, valence: 0 };
  }
  if (q.startsWith("m:")) return { text: pickFor(world, me, r, `ans:${q}`, MUNDANE_ANSWERS[q.slice(2)] ?? ["Not really.", "Can't say I have.", "Maybe.", "Not lately."]), valence: 0 };
  if (q === "epnews") return stressOf(me) > 0.45 ? { text: pickFor(world, me, r, "ans:ep:bad", ["Not really. Still the same.", "Don't ask.", "If anything it's worse."]), valence: -0.3 } : { text: pickFor(world, me, r, "ans:ep:ok", ["Nothing new, really.", "A bit better, actually.", "All sorted, more or less.", "Same old."]), valence: 0.1 };
  if (q === "alright") return { text: pickFor(world, me, r, "ans:alright", ["Think so. Nobody hurt.", "Far as I know.", "Seems so. Lucky, really."]), valence: 0 };
  if (q === "theirs") {
    // Asked about what's happened to them (the town's talking about it).
    const h = d.reply?.ref?.startsWith("news:") ? happeningById(world, Number(d.reply.ref.slice(5))) : undefined;
    const good = (h?.tone ?? 0) >= 0;
    const open = profileOf(me).openness * 0.6 + d.rel.closeness * 0.7 > 0.35;
    return good
      ? { text: pickFor(world, me, r, open ? "ans:theirs:good" : "ans:theirs:good:shy", open ? ["It is! Still can't believe it.", "Yeah! Mad, isn't it?", "True. Don't tell everyone.", "It's true. Best week ever."] : ["Word gets round, doesn't it.", "Yeah. Thanks.", "Bit embarrassing, but yeah."]), valence: 0.6 }
      : { text: pickFor(world, me, r, open ? "ans:theirs:bad" : "ans:theirs:bad:shy", open ? ["It's been grim, honestly.", "Don't. It's been awful.", "We're getting there. Slowly.", "Still in shock, to be honest."] : ["I'm fine. Really.", "It is what it is.", "I'd rather not talk about it."]), valence: open ? -0.6 : -0.2 };
  }
  if (q === "you") {
    // They asked it back: your own answer.
    const k = x.st.topicKind;
    if (k === "evening") return { text: eveningAnswer(x), valence: 0 };
    if (k === "hypothetical") return { text: hypoAnswer(x), valence: 0.2 };
    return { text: pickFor(world, me, r, "ans:you", ["Same, really.", "Much the same.", "Don't ask."]), valence: 0 };
  }
  if (q === "evening") return { text: eveningAnswer(x), valence: 0 };
  if (q === "hypo") return { text: hypoAnswer(x), valence: 0.2 };
  if (q === "work") {
    const wk = workplaceKey(world, me);
    if (!wk) return { text: me.occupation === "unemployed" ? pickFor(world, me, r, "ans:work:none", ["What work?", "Still looking.", "Don't ask."]) : "Ticking over.", valence: 0 };
    const biz = world.businesses[wk];
    if (biz && biz.ownerId === me.id) return { text: biz.avgProfit > 30 ? pickFor(world, me, r, "ans:work:biz:good", ["Busy, thank God.", "Not bad at all. Can't complain."]) : pickFor(world, me, r, "ans:work:biz:bad", ["Quiet. Too quiet.", "Struggling, if I'm honest."]), valence: biz.avgProfit > 30 ? 0.4 : -0.4 };
    return { text: pickFor(world, me, r, "ans:work", ["Busy.", "Same as ever.", "Don't get me started.", "It pays the rent. Just."]), valence: 0 };
  }
  if (q === "who") {
    const f = d.reply?.ref ? factById(me, Number(d.reply.ref)) : undefined;
    const src = f?.from ? world.citizens[f.from]?.name : null;
    return { text: src ? pickFor(world, me, r, "ans:who", [`${src} told me.`, `${src}. Don't say I said.`]) : pickFor(world, me, r, "ans:who:none", ["Just something I heard.", "Everyone's saying it."]), valence: 0 };
  }
  if (q === "fact") {
    // "Is it true you're...?" Owning up, or not, depending how they feel about the asker.
    const open = profileOf(me).openness * 0.6 + d.rel.closeness * 0.7 - d.rel.guarded * 0.4;
    return open > 0.45 ? { text: pickFor(world, me, r, "ans:fact:yes", ["Who told you that? Yeah, it's true.", "Yeah. It's true.", "Word gets round, doesn't it. Yeah."]), valence: 0 } : { text: pickFor(world, me, r, "ans:fact:no", ["No. Where did you hear that?", "Don't believe everything you hear.", "That's news to me."]), valence: 0 };
  }
  if (q === "favour") return { text: pickFor(world, me, r, "ans:owe", ["I know, I know. Give me a few days.", "I'll sort it, I promise.", "Can it wait till the end of the week?"]), valence: -0.2 };
  // Asked about their own topic: give the detail.
  if ((q === "what" || q === "detail" || q === "when") && x.st.topicOwner === me.id) {
    const more = detailFor(x, q === "when" ? "when" : "what");
    if (more) return { text: more, valence: 0 };
  }
  if (q === "joke") return { text: pickFor(world, me, r, "ans:joke", ["Very funny.", "Thriving, thanks.", "Better than me, anyway.", "Don't start."]), valence: 0.2 };
  if (q === "detail" && d.reply) {
    const amt = amountIn(d.reply.gist);
    return { text: amt ? `${amt}. Don't laugh.` : pickFor(world, me, r, "ans:detail", ["Long story.", "Don't ask.", "Couple of days ago.", "I'll tell you another time."]), valence: 0 };
  }
  void them;
  return { text: pickFor(world, me, r, "ans:what", ["Nothing much.", "Not a lot.", "Same as always.", "You know how it is."]), valence: 0 };
}

const MORE: Record<string, string[]> = {
  "the pub": ["I could murder a pint.", "Proper pint, mind. Not that fizzy stuff."],
  "the football": ["Second half was a disgrace.", "I don't know why I bother."],
  cooking: ["Set the smoke alarm off twice.", "Tasted alright in the end."],
  books: ["Stayed up till two with it.", "Bit slow in the middle, mind."],
  gadgets: ["Saving up for it. Sort of.", "I don't need it. That's never stopped me."],
  coffee: ["Hands are shaking a bit, to be honest.", "Can't function without it."],
  "lie-ins": ["Didn't get up till ten.", "Best thing I've done all week."],
  bargains: ["Half price. Couldn't leave it.", "Don't need it, mind."],
  "the park": ["Sat by the pond for an hour.", "Ducks were out in force."],
  "quiet nights in": ["Telly, tea, bed.", "Best kind of night."],
  "people-watching": ["You see all sorts in here.", "Some of them, honestly."],
  "keeping busy": ["Can't sit still, me.", "Idle hands and all that."],
};

function elaborateLine(x: Ctx): string {
  const { world, me, d, r } = x;
  const kind = d.topic?.kind ?? x.st.topicKind;
  const key = x.st.topic ?? "";
  if (key.startsWith("like:") && MORE[key.slice(5)]) return pickFor(world, me, r, `more:${key}`, MORE[key.slice(5)]);
  if (kind === "evening" || kind === "hypothetical") {
    // Your own answer to your own question.
    const lead = pickFor(world, me, r, `elab:${kind}`, kind === "evening" ? ["Me, ", "I'm thinking ", ""] : ["Me? ", "I'd say ", "Easy. "]);
    const ans = kind === "evening" ? eveningAnswer(x) : hypoAnswer(x);
    if (/^Honestly\?/.test(ans) || /\.$/.test(ans) && /^(Never|Is that)/.test(ans)) return ans;
    return /[a-z,] $/.test(lead) ? `${lead}${low(ans)}` : `${lead}${ans}`;
  }
  if (/^dream:/.test(key)) return pickFor(world, me, r, "elab:dream", ["One day.", "Daft, maybe.", "I mean it, though.", "We'll see."]);
  if (/^fear:/.test(key)) return pickFor(world, me, r, "elab:fear", ["Keeps me up at night, some nights.", "Stupid, really.", "Anyway. Enough of that."]);
  if (kind === "disclose" && (d.topic?.sensitive ?? 0.6) <= 0.5) return pickFor(world, me, r, "elab:light", ["Good fun, it was.", "Made my week, that.", "Can't complain, really."]);
  if (key.startsWith("news:")) {
    const more = detailFor(x, "what");
    if (more && rand3(x) < 0.5) return more;
  }
  const pools: Partial<Record<TopicKind, string[]>> = {
    problem: ["It's doing my head in.", "I don't know what I'm going to do.", "It's not like I can just magic it up.", "Anyway. It'll sort itself out. Probably."],
    brag: ["Not bad for a week, eh?", "Told you it'd work.", "Keep that to yourself, mind."],
    plan: ["Fingers crossed.", "We'll see. I'm not holding my breath.", "Wish me luck."],
    news: ["Of all the weeks.", "Everyone's talking about it.", "Mad, isn't it."],
    gossip: ["That's what I heard, anyway.", "Don't say I told you.", "I mean, I'm not surprised."],
    complain: ["Every single time.", "It's the principle of it.", "I'm not having it."],
    work: ["Same rubbish, different day.", "Still, it's money.", "Can't wait for the weekend."],
    mundane: ["Honestly.", "Best part of my week, that.", "Don't judge me."],
    environment: ["Anyway.", "Every time."],
    disclose: ["I don't tell many people that.", "Funny, saying it out loud.", "Anyway. Forget I said."],
    hypothetical: ["Go on. Answer.", "You have to pick one."],
    shared: ["Good night, that.", "We should do it again."],
  };
  return pickFor(world, me, r, `elab:${kind ?? "any"}`, pools[kind ?? "mundane"] ?? ["Anyway.", "Yeah."]);
}

function closeLine(x: Ctx): string {
  const { world, me, d, r } = x;
  const h = hourOf(world.time);
  if (["enemy", "dislikes"].includes(d.rel.kind)) return pickFor(world, me, r, "close:cold", ["Right.", "Whatever.", "I'm going.", "Anyway.", "Yeah. Bye."]);
  if (me.activity.kind === "work" || me.activity.kind === "manage") return pickFor(world, me, r, "close:work", ["Anyway, I need to get back.", "Right, back to it.", "Better get on. See you.", "Duty calls.", "Right, I'd better crack on.", "These won't sort themselves out. See you.", "I'll get back to it before anyone notices.", "Anyway, I'm meant to be working."]);
  if (me.needs.hunger < 30) return pickFor(world, me, r, "close:hungry", ["Right, I'm starving. See you.", "I need food. Later.", "I'm going to get something to eat. See you.", "Food. Now. See you later."]);
  if (me.needs.energy < 25 || h >= 22) return pickFor(world, me, r, "close:tired", ["I'm off to bed. Night.", "Right, I'm done in. Night.", "Bed's calling. Night.", "I'm dead on my feet. See you tomorrow."]);
  if (profileOf(me).formality > 0.68) return pickFor(world, me, r, "close:formal", ["I must be off. Good to see you.", "Well, I shall let you get on.", "Do take care.", "Lovely to see you. Goodbye."]);
  if (d.rel.closeness > 0.55) return pickFor(world, me, r, "close:close", ["Right, I'm off. Text me.", "Go on, I'll let you go. Laters.", "Anyway. See you later.", "Don't be a stranger.", "Right, I'm off. Behave.", "Come round sometime, yeah?"]);
  return pickFor(world, me, r, "close:any", ["See you later.", "Catch you later.", "Right, I'll let you go.", "Anyway. See you around.", "I'll leave you to it.", "Right, I'm off.", "Mind how you go.", "Anyway, good to see you."]);
}

function byeLine(x: Ctx): string {
  const { world, me, d, r } = x;
  if (["enemy", "dislikes"].includes(d.rel.kind)) return pickFor(world, me, r, "bye:cold", ["Right.", "Yeah.", "Bye.", "Mm."]);
  const h = hourOf(world.time);
  return pickFor(world, me, r, "bye", ["See you.", "Yeah, later.", "Bye.", "Go on then.", "Take care.", h >= 21 ? "Night." : "See you around.", "Cheers, see you.", "Ta-ra.", "Bye now.", "Laters.", "Mind how you go.", "See ya."]);
}

/** Something else to say when the obvious line has already been said in this chat. */
const ALT: Partial<Record<Move, string[]>> = {
  react: ["Hm.", "Fair.", "Right.", "Ha.", "Yeah?", "Mad.", "Go on.", "Is that right."],
  backchannel: ["Mm.", "Yeah.", "Right.", "Ha."],
  elaborate: ["Anyway.", "So yeah.", "That's about it.", "Yeah. Anyway."],
  answer: ["Not sure, to be honest.", "Couldn't tell you.", "That's all I know.", "No idea."],
  close: ["Right, I'm off.", "Anyway, see you.", "I'll leave you to it."],
  byeback: ["Bye.", "See you.", "Later."],
};

// ------------------------------------------------------------ the turn

/** Put a planned turn into words, in the speaker's voice. */
export function realize(world: WorldState, conv: Conversation, st: DialogueState, me: Citizen, them: Citizen, d: Directive): Realized {
  const r = rngFor(world, conv, me.id, `say${st.turns.length}`);
  const x: Ctx = { world, conv, st, me, them, d, r };
  const p = profileOf(me);
  let text = "";
  let asks = false;
  let q: string | undefined;
  let ref: string | undefined;
  let told: number[] = [];
  let tone = d.take ?? "light";
  let valence = d.topic?.valence ?? 0;
  let gist: string | undefined;
  let disclosed: Realized["disclosed"];
  let gift: number | undefined;
  const kind = d.topic?.kind ?? null;
  const move: Move = d.move;
  sayingIn((st.said ??= []));
  if (st.said.length > 160) st.said.splice(0, st.said.length - 160);
  const before = new Set(st.said);

  switch (move) {
    case "open":
      text = d.opener === "tease" ? teaseOpen(x) : greetLine(x);
      // "Alright?" is a hello that wants one back.
      asks = d.opener !== "cold" && /\?$/.test(text);
      q = asks ? (d.opener === "tease" ? "what" : "how") : undefined;
      tone = d.opener === "tease" ? "teasing" : d.opener === "cold" ? "cold" : "light";
      break;
    case "greet": {
      // Hello back: not a fresh "Alright, Ben?" but the reply to one.
      const k = d.rel.kind;
      const pool = ["enemy", "dislikes", "rival"].includes(k)
        ? ["Hm.", "Hello.", `${N(them)}.`]
        : k === "stranger"
          ? ["Hello.", "Hi there.", "Oh, hello."]
          : k === "boss" || k === "staff"
            ? ["Hello.", `Morning, ${N(them)}.`.replace("Morning", cap(morningish(world) === "night" ? "evening" : morningish(world))), "Hi."]
            : ["Hiya.", "Hey.", "Alright.", "Oh, hey.", `Hi, ${N(them)}.`, "Hello, you."];
      text = pickFor(world, me, r, `greetback:${k}`, pool);
      if (d.askBack === "how") {
        text = `${text} ${pickFor(world, me, r, "greetback:how", ["You alright?", "How are you?", "How's things?", "You good?"])}`;
        asks = true;
        q = "how";
      }
      tone = ["enemy", "dislikes", "rival"].includes(k) ? "cold" : "light";
      break;
    }
    case "raise": {
      const t = d.topic!;
      let body = "";
      switch (t.kind) {
        case "followup": {
          const cryptic = d.opener === "followup" && d.rel.closeness > 0.5 && rand3(x) < 0.5;
          body = followupLine(x, cryptic);
          asks = true;
          q = "followup";
          ref = String(t.fact ?? "");
          gist = cryptic ? "cryptic" : undefined;
          break;
        }
        case "concern":
          body = pickFor(world, me, r, "concern", ["You alright now? You seemed a bit off last time.", "Feeling better than last time?", "You seemed a bit down the other day. All good?"]);
          asks = true;
          q = "how";
          break;
        case "owed": {
          const amount = d.rel.owed && d.rel.owed.amount > 0 ? money(d.rel.owed.amount) : "the money";
          body = p.bluntness > 0.55 ? pickFor(world, me, r, "owed:blunt", [`You still owe me ${amount}, by the way.`, `Don't suppose you've got my ${amount}?`, `When am I getting my ${amount} back?`]) : pickFor(world, me, r, "owed:soft", [`I don't want to be that person, but... the ${amount}?`, "Sorry to bring it up, but that money...", "Any chance of that money soon?"]);
          asks = true;
          q = "favour";
          break;
        }
        case "disagreement":
          body = pickFor(world, me, r, "disagree:again", [`Still think you're right about ${t.label}?`, `I've been thinking about what you said. About ${t.label}.`]);
          break;
        case "news":
        case "shared": {
          if (t.kind === "shared" && t.key.startsWith("ep:")) {
            // Picking up from last time.
            body = pickFor(world, me, r, "lasttime", [`About ${t.label} the other day. Any more news?`, `Been thinking about what you said. ${cap(t.label)}.`, `Anything new? With ${t.label}, I mean.`]);
            asks = /\?$/.test(body);
            q = asks ? "epnews" : undefined;
          } else if (t.kind === "shared") body = pickFor(world, me, r, "shared", [`Good do, wasn't it? ${cap(t.label)}.`, `${cap(t.label)}, eh?`, `Were you at ${t.label}? I thought I saw you.`]);
          else {
            const n = newsLine(x, t.happening ?? -1, d.opener === "news");
            body = n.text;
            asks = n.asks;
            q = asks ? "news" : undefined;
          }
          ref = `news:${t.happening}`;
          break;
        }
        case "gossip": {
          const g = gossipLine(x);
          body = g.text;
          told = g.told;
          asks = g.asks;
          q = asks ? "what" : undefined;
          ref = d.topic?.about ?? undefined;
          gist = body;
          break;
        }
        case "ask": {
          if (t.key === "ask:work") {
            const theirs = workplaceKey(world, them);
            const biz = theirs ? world.businesses[theirs] : undefined;
            const place = biz ? biz.name.replace(/^\w+'s /, "the ").replace(/^the (.+)$/, (_, w: string) => `the ${w.toLowerCase()}`) : "";
            body = biz && biz.ownerId === them.id ? pickFor(world, me, r, "askwork:biz", [`How's ${place} doing?`, `${cap(place)} busy?`, "How's business?"]) : theirs === "corp" ? pickFor(world, me, r, "askwork:corp", ["How's CityCorp treating you?", "Still at CityCorp?"]) : pickFor(world, me, r, "askwork", ["How's work?", "Busy at work?", "Work alright?"]);
            q = "work";
          } else if (t.happening !== undefined) {
            const h = happeningById(world, t.happening);
            const yours = h ? toYou(h.about, them.name) : "your news";
            body = (h?.tone ?? 0) < 0 ? pickFor(world, me, r, "ask:hap:bad", [`I heard about ${yours}. You alright?`, `Sorry about ${yours}. Is it bad?`, `I'm so sorry about ${yours}.`]) : pickFor(world, me, r, "ask:hap:good", [`I heard about ${yours}! Congratulations.`, `${cap(yours)}! Is it true?`, `Here, is it true? ${cap(yours)}?`]);
            q = "theirs";
            ref = `news:${t.happening}`;
          } else {
            const f = t.fact !== undefined ? factById(me, t.fact) : undefined;
            const you = f ? toYou(f.text, them.name) : t.label;
            body = p.bluntness > 0.55 ? pickFor(world, me, r, "askfact:blunt", [`Is it true ${you}?`, `So ${you}? I heard.`]) : pickFor(world, me, r, "askfact:soft", [`Someone said ${you}. Is that right?`, `Don't take this the wrong way, but I heard ${you}.`]);
            q = "fact";
            ref = f ? String(f.id) : undefined;
            told = f ? [f.id] : [];
          }
          asks = true;
          break;
        }
        case "disclose":
        case "problem":
        case "plan":
        case "brag":
        case "complain": {
          if (t.detail?.dislike) {
            // A pet hate set off by the moment: not news about their life.
            body = pickFor(world, me, r, `dislike:${String(t.detail.dislike)}`, DISLIKE_LINES[String(t.detail.dislike)] ?? ["Don't get me started."]);
            if (/\?$/.test(body)) {
              asks = true;
              q = "agree";
            }
            break;
          }
          const l = lifeLine(x);
          body = l.text;
          disclosed = l.disclosed;
          gist = String(t.detail?.first ?? body);
          break;
        }
        case "work":
          body = pickFor(world, me, r, "work:talk", ["Madhouse today, wasn't it?", "Did you see the state of the place this morning?", "They want us doing double again.", "Is it just me or is it dead today?"]);
          asks = /\?$/.test(body);
          q = asks ? "agree" : undefined;
          break;
        case "environment": {
          const e = environmentLine(x);
          body = e.text;
          asks = /\?$/.test(body);
          q = asks ? "what" : undefined;
          break;
        }
        case "mundane": {
          const det = t.detail ?? {};
          const pool = det.like ? MUNDANE_LINES[String(det.like)] : det.quirk ? QUIRK_LINES[String(det.quirk)] : det.body === "hungry" ? ["I'm starving.", "I could eat a horse.", "When did I last eat? Honestly."] : det.body === "tired" ? ["I'm shattered.", "I could sleep for a week.", "I'm running on fumes today."] : null;
          body = pickFor(world, me, r, `mundane:${String(det.like ?? det.quirk ?? det.body ?? "x")}`, pool ?? ["Anyway.", "Mad week."]);
          asks = /\?$/.test(body);
          q = asks ? "what" : undefined;
          break;
        }
        case "hypothetical":
          {
            const h = hypoLine(x);
            body = h.text;
            gist = `hypo:${h.n}`;
          }
          asks = true;
          q = "hypo";
          break;
        case "evening":
          body = pickFor(world, me, r, "evening", ["You doing anything later?", "Pub later?", "What are you up to tonight?", "Any plans tonight?"]);
          asks = true;
          q = "evening";
          break;
        case "joke": {
          if (t.key.startsWith("thread:")) {
            // Something they said they'd do together and never did.
            body = pickFor(world, me, r, "promise:pint", ["We never did have that pint.", "You still owe me a pint, you know.", "That pint's not going to drink itself.", "Are we ever having that pint, or what?"]);
            asks = /\?$/.test(body);
            q = asks ? "evening" : undefined;
            tone = "warm";
            break;
          }
          const j = peekBond(me, them.id)?.jokes.find((jj) => jj.hook === t.label);
          body = j ? j.line : `Still ${t.label}?`;
          if (j) j.uses++;
          tone = "amused";
          break;
        }
        case "tease":
          body = pickFor(world, me, r, "tease", them.needs.energy < 35 ? ["You look like you haven't slept in a week.", "Late night, was it?"] : ["Still pretending to work, then?", "What's that face for?", "You're quiet. That's a first."]);
          tone = "teasing";
          break;
        default:
          body = `${cap(t.label)}.`;
      }
      // "Dead in here, isn't it?" wants agreement, not an answer; "Read anything good lately?" wants one about books.
      if (/\?$/.test(body) && (!asks || q === "what")) {
        asks = true;
        const det = t.detail ?? {};
        q = TAG.test(body) || /^(is it just me|isn't it|who decided)/i.test(body) ? "agree" : t.kind === "news" ? "news" : t.kind === "joke" ? "joke" : t.kind === "mundane" || t.kind === "environment" ? `m:${det.nearby ? "nearby" : String(det.like ?? det.quirk ?? det.weather ?? det.place ?? det.body ?? "x")}` : "what";
      } else if (asks && TAG.test(body)) q = "agree";
      // How they get onto it: it reminded them, they've been meaning to say, or they're just changing the subject.
      const isQ = /\?$/.test(body) && !/[.!]\s/.test(body);
      const trKind = d.transition === "remembered" && ["mundane", "environment", "hypothetical", "evening", "tease", "joke"].includes(t.kind) ? "casual" : d.transition === "remembered" && isQ ? "rememberedQ" : d.transition;
      const ownLead = /^(Guess what|Can I tell you|Honestly\?|Not to brag|Don't get me started|You'll never guess|Big news|I don't really tell|Funny thing|Not great|So,|Here,|Oh,)/.test(body);
      const pre = trKind && !ownLead && d.opener !== "continue" && d.opener === undefined && rand3(x) < 0.5 ? pickFor(world, me, r, `tr:${trKind}`, TRANSITION[trKind] ?? [""]) : "";
      text = joinLead(world, pre, body);
      ref ??= d.topic?.fact !== undefined ? String(d.topic.fact) : undefined;
      break;
    }
    case "answer": {
      if (d.reply?.move === "clarify") {
        // They didn't follow: say what you meant.
        const prev = [...st.turns].reverse().find((t) => t.speaker === me.id && t.q === "followup");
        text = prev?.topic ? `${pickFor(world, me, r, "clarify:what", [d.rel.closeness > 0.6 ? "The job, idiot." : "", "You know.", ""])} ${followupLine({ ...x, d: { ...d, topic: { key: prev.topic, kind: "followup", label: prev.topic.replace(/^thread:/, ""), score: 1, intent: "find something out", sensitive: 0, valence: 0, about: them.id, fact: prev.ref ? Number(prev.ref) : undefined } } }, false)}`.trim() : "Never mind.";
        asks = true;
        q = "followup";
        ref = prev?.ref;
        break;
      }
      const a = answerLine(x);
      text = a.text;
      // What they let on, not what they feel: a "Fine." sounds fine.
      valence = d.answer && !d.answer.honest ? 0 : a.valence;
      gist = a.gist ?? a.text;
      if (d.reply?.q === "news" && d.reply.ref?.startsWith("news:")) {
        if (knows(me, Number(d.reply.ref.slice(5)))) tone = "flat";
        else if (/\?$/.test(text)) {
          // "No, what?": tell me.
          asks = true;
          q = "what";
        }
      }
      if (d.reply?.q === "fact" && /(hear|told you) that\?/.test(text)) {
        asks = true;
        q = "who";
        ref = d.reply.ref;
      }
      if (d.askBack && d.askBack !== "relate" && !/\?$/.test(text)) {
        const qq = askLine(x, d.askBack);
        text = `${text} ${qq}`;
        asks = true;
        q = whenQ(qq) ?? d.askBack;
      }
      break;
    }
    case "deflect":
      if (d.reply?.q === "wrong") {
        text = pickFor(world, me, r, "deflect:wrong", ["Ah, nothing. Just one of those weeks.", "It's nothing. I'll be fine.", "Long story. Another time.", "Don't worry about it."]);
        tone = "guarded";
        break;
      }
      text = pickFor(world, me, r, "deflect", ["Let's not.", "Another time.", "I'd rather not get into it.", "Long story.", "It's fine. Honestly.", "Can we talk about something else?"]);
      tone = "guarded";
      break;
    case "react": {
      const re = reactLine(x);
      text = re.text;
      tone = re.tone;
      // A close, generous friend with money to spare helps out with money worries.
      if (d.reply?.kind === "problem" && (tone === "sympathetic" || d.take === "practical")) {
        const close = me.family.includes(them.id) || (me.relationships[them.id]?.affinity ?? 0) / 60 > 0.6;
        if (me.traits.generosity > 0.6 && close && me.money > 120 && them.rentArrears + (them.money < 40 ? 1 : 0) > 0) {
          gift = Math.min(50, Math.round((15 + me.traits.generosity * 35) / 5) * 5);
          text = `${text} ${pickFor(world, me, r, "gift", [`Here. Take ${money(gift)}. Pay me back whenever.`, `Look, have ${money(gift)}. Don't argue.`, `I can lend you ${money(gift)}. Call it a gift.`])}`;
        }
      }
      if (re.known) {
        // Old news to them: nothing to ask.
      } else if (d.askBack === "relate") {
        // Something of their own it reminds them of (not tacked onto a question).
        const mine = /\?/.test(text) || d.take === "competitive" || d.take === "jealous" ? "" : relateLine(x);
        if (mine) text = `${text} ${mine}`;
      } else if (d.askBack && !/\?$/.test(text)) {
        const qq = askLine(x, d.askBack);
        text = `${text} ${qq}`;
        asks = true;
        q = whenQ(qq) ?? d.askBack;
      }
      if (!asks && /\?$/.test(text)) {
        asks = true;
        const lastQ = text.split(/(?<=[.!]) /).pop() ?? "";
        q = /everyone alright\?$/.test(text) ? "alright" : /^(Says who|Who from|Where'd that come from)|who\?$/i.test(lastQ) ? "who" : (whenQ(lastQ) ?? "what");
      }
      valence = d.reply?.valence ?? 0;
      break;
    }
    case "elaborate":
      text = elaborateLine(x);
      if (d.askBack) {
        text = `${text} ${askLine(x, d.askBack)}`;
        asks = true;
        q = d.askBack;
      }
      break;
    case "ask":
      text = askLine(x, d.askBack ?? "detail");
      asks = true;
      q = whenQ(text) ?? d.askBack ?? "detail";
      break;
    case "backchannel":
      text = st.mode === "fail" && ["enemy", "dislikes"].includes(d.rel.kind) ? pickFor(world, me, r, "back:cold", ["Mm.", "Right.", "Yeah."]) : st.mode === "fail" ? pickFor(world, me, r, "back:fail", ["Yeah. You?", "Yeah.", "Not bad.", "Fine."]) : pickFor(world, me, r, "back", ["Yeah.", "Mm.", "{agree}.", "True.", "Fair.", "Ha."]);
      tone = "flat";
      break;
    case "clarify":
      text = pickFor(world, me, r, "clarify", ["What?", "Sorry, what?", "What are you on about?", "Eh?"]);
      asks = true;
      q = "what";
      break;
    case "excuse":
      text = pickFor(world, me, r, "excuse", ["Can't stop, sorry. Busy.", "Sorry, I'm in a rush.", "Not now, I'm working.", "Can't talk, sorry."]);
      break;
    case "close":
      text = closeLine(x);
      break;
    case "byeback":
      text = byeLine(x);
      break;
    default:
      text = "Yeah.";
  }

  const pp = profileOf(me);
  if (before.has(`t:${plain(fillWords(text, pp, { you: them.name, me: me.name }))}`) && ALT[move]) {
    text = pickFor(world, me, r, `alt:${move}`, ALT[move]!);
    if (move === "answer" || move === "elaborate") asks = false;
  }
  text = spokenDays(fillWords(text, pp, { you: them.name, me: me.name }), world.time);
  const raw = text;
  if (["react", "elaborate", "backchannel", "close", "byeback", "excuse", "deflect"].includes(move) && !d.askBack) text = trimTo(text, d.length);
  if (asks && !/\?/.test(text) && q !== "fact" && q !== "favour" && q !== "theirs") asks = false;
  text = voiced(world, me, them, text, { move, rel: d.rel, stress: stressOf(me), negative: valence < -0.25 || tone === "sympathetic" || tone === "sarcastic" }, r);
  if (disclosed) disclosed.gist = d.topic ? String(d.topic.detail?.first ?? "") : "";
  st.said.push(`t:${plain(text)}`, `t:${plain(raw)}`);
  sayingIn(null);
  return {
    text: sentence(text),
    meta: { move, topic: d.topic?.key ?? (move === "react" || move === "answer" ? (d.reply?.topic ?? null) : null), kind: kind ?? (move === "react" || move === "answer" ? (d.reply?.kind ?? null) : null), intent: d.intent, tone, asks, q, ref, gist, bye: d.bye || move === "close" || move === "byeback", valence, told },
    disclosed,
    gift,
  };
}

/** For callers that need just the predicate of a gist ("couldn't pay their rent"). */
export const gistPredicate = predicate;
