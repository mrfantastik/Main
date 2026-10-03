import { rand, type RngHolder } from "../rng";
import type { Citizen, SpeakingStyle } from "../types";

// The built-in AI's phrasebook. Every conversational move ("say hello",
// "ask how they are", "react to bad news", "say goodbye"...) has many
// wordings, plus extra ones in each speaking style, with slots for the real
// details ({you}, {place}, {amount}...). Each person remembers the wordings
// they've used lately and avoids them, and avoids what the other person has
// just been saying, so two chats don't come out the same.

type Bank = { all: string[] } & Partial<Record<SpeakingStyle, string[]>>;

/** How many recent wordings each person remembers (and won't reuse). */
const MEMORY = 120;
/** How many the town as a whole remembers (they're used much less often while they're fresh). */
const TOWN_MEMORY = 300;

/** The town's recent wordings (the world's list), set while a conversation is being made up, and a quick lookup of them. */
let town: string[] | null = null;
let townSet = new Set<string>();

/** Use the world's list of recent wordings while making up conversations (null to stop). Returns the one it replaces. */
export function talkIn(recent: string[] | null): string[] | null {
  const was = town;
  if (recent !== town) townSet = new Set(recent ?? []);
  town = recent;
  return was;
}

function heard(key: string): void {
  if (!town) return;
  town.push(key);
  townSet.add(key);
  if (town.length > TOWN_MEMORY) {
    for (const k of town.splice(0, town.length - TOWN_MEMORY)) if (!town.includes(k)) townSet.delete(k);
  }
}

/** Remember a wording this person has used (the oldest ones are forgotten). */
function remembered(c: Citizen, key: string): void {
  const said = (c.said ??= []);
  said.push(key);
  if (said.length > MEMORY) said.splice(0, said.length - MEMORY);
}

const B: Record<string, Bank> = {
  // ------------------------------------------------------------ hellos
  meet: {
    all: [
      "Hi, I don't think we've met. I'm {me}.",
      "Hello! I'm {me}. I've seen you around.",
      "I don't think we've been introduced. {me}.",
      "Hi there. {me}. You're new to me.",
      "We keep passing each other. I'm {me}, by the way.",
      "Sorry, I don't know your name. I'm {me}.",
      "Hello. {me}. I don't think we've spoken before.",
    ],
    formal: ["Good {daypart}. I don't believe we've been introduced. {me}.", "How do you do? My name is {me}."],
    blunt: ["{me}. Don't think we've met.", "I'm {me}. You?"],
    chatty: ["Oh hello! I'm {me}! I feel like I see you everywhere and we've never actually said hi!", "Hiya! {me}. I've been meaning to say hello for ages!"],
    sarcastic: ["So we finally meet. {me}.", "I'm {me}. I'd say I've heard a lot about you, but I haven't."],
    warm: ["Hello, love. I'm {me}. Lovely to meet you.", "Hiya, I'm {me}. Welcome to the madhouse."],
    nervous: ["Oh, um, hi. I'm {me}. Sorry, I don't think we've met?", "Hi! Sorry. I'm {me}. Um, nice to meet you."],
  },
  meetBack: {
    all: ["{me}. Nice to meet you.", "Hi {you}, I'm {me}.", "{me}. Good to put a face to the name.", "I'm {me}. Pleased to meet you.", "Hello {you}. {me}.", "Nice to meet you, {you}. I'm {me}."],
    formal: ["{me}. Delighted to make your acquaintance.", "A pleasure, {you}. I'm {me}."],
    blunt: ["{me}.", "{me}. Hi."],
    chatty: ["{me}! Oh, it's so nice to finally meet you!", "Hiya {you}! I'm {me}. I knew we'd bump into each other eventually!"],
    sarcastic: ["{me}. Charmed, I'm sure.", "{me}. The pleasure's mostly yours."],
    warm: ["Aw, hello {you}. I'm {me}.", "{me}, love. Lovely to meet you."],
    nervous: ["Oh! Um, {me}. Hi.", "Hi, sorry, {me}. Nice to meet you."],
  },
  greetFriend: {
    all: [
      "{you}! There you are.",
      "Alright {you}? How's things?",
      "{you}! Long day?",
      "Hey, {you}. How are you?",
      "{you}! Just the person.",
      "Look who it is.",
      "{you}! I was hoping I'd see you.",
      "There's a face I know. How are you, {you}?",
      "{you}! How's life treating you?",
      "Well, hello stranger.",
      "{you}! Haven't seen you in ages.",
      "Oi, {you}! Over here.",
    ],
    formal: ["Good {daypart}, {you}. It's good to see you.", "{you}. How are you keeping?"],
    blunt: ["{you}. How's it going?", "Alright, {you}."],
    chatty: ["{you}!! Oh, I've got so much to tell you!", "{you}! Oh, perfect timing, I was just thinking about you!"],
    sarcastic: ["Oh look, it's {you}. My day just got slightly better.", "{you}. Still alive, then?"],
    warm: ["{you}, love! Come here, how are you?", "Aw, {you}! How are you doing, sweetheart?"],
    nervous: ["Oh, {you}! Hi! Um, how are you?", "Hi {you}! Sorry, I didn't see you there."],
  },
  greetAcquaintance: {
    all: [
      "{Daypart}, {you}.",
      "Alright {you}?",
      "{Daypart}! How are you doing?",
      "Oh, hi {you}.",
      "Hello again, {you}.",
      "Hiya, {you}.",
      "{you}. How's your {daypart} going?",
      "Oh, hello. Fancy seeing you here.",
      "Hi {you}. Keeping well?",
    ],
    formal: ["Good {daypart}, {you}.", "Hello, {you}. I trust you're well?"],
    blunt: ["{you}.", "Alright."],
    chatty: ["Oh, hi {you}! Fancy seeing you here!", "{you}! Hello hello!"],
    sarcastic: ["Oh. Hello, {you}.", "{you}. We meet again."],
    warm: ["Hello, {you}, love.", "Hiya {you}! You alright?"],
    nervous: ["Oh, hi {you}. Um, hello.", "Hi! It's {you}, isn't it? Sorry."],
  },
  greetPub: { all: ["{you}! What are you drinking?", "Fancy seeing you in here, {you}.", "{you}! Pull up a stool.", "First one's on me, {you}. Joking. Mostly.", "Thirsty work, is it, {you}?"] },
  greetPark: { all: ["Lovely day for it, {you}.", "{you}! Getting some fresh air?", "{you}! Out for a stroll?", "Nice out here, isn't it, {you}?"] },
  greetDiner: { all: ["{you}! What's good today?", "Grabbing a bite too?", "{you}! Don't have the soup.", "Lunch break, {you}?"] },
  greetCafe: { all: ["{you}! Caffeine break?", "{you}! Need a coffee as much as I do?", "Morning brew, {you}?"] },
  greetMarket: { all: ["{you}! Bargain hunting?", "{you}! Found anything good?", "Spending money again, {you}?", "{you}! Don't buy the last of the cheap stuff."] },
  greetWork: { all: ["{you}! Busy?", "Hard at it, {you}?", "{you}! Don't let me keep you.", "Working hard or hardly working, {you}?", "Got a minute, {you}?", "{you}! Quick word?", "Sorry to interrupt, {you}.", "Don't mind me, {you}. Just saying hello.", "{you}! They've got you busy today."] },
  // Answers to a greeting that asks something about the place or the moment.
  ansPub: { all: ["Just the one. Honest.", "The usual. It's been that sort of day.", "Don't mind if I do.", "Whatever's on tap.", "Something strong, please."] },
  ansPark: { all: ["Clearing my head.", "Making the most of it while it lasts.", "Just walking. It's free.", "Needed some air, to be honest."] },
  ansDiner: { all: ["Whatever's cheapest.", "The fry-up. Always the fry-up.", "Ha! Noted.", "I'm too hungry to care."] },
  ansCafe: { all: ["Desperately.", "My third today. Don't judge.", "Always. It's basically my blood.", "Go on then, I'll have one."] },
  ansMarket: { all: ["Window shopping, mostly.", "Looking for a bargain. Found nothing yet.", "Just browsing.", "Spending money I don't have."] },
  ansWork: { all: ["Rushed off my feet.", "Always. Go on, quickly.", "Never too busy for you.", "Flat out. What's up?", "I've got a minute."] },
  askHowAnyway: { all: ["How are you, anyway?", "So how are you doing?", "How's things otherwise?", "And how are you keeping?", "Anyway, how are you?"] },
  greetCold: {
    all: ["Oh. It's you.", "{you}.", "Well, well. {you}.", "Didn't expect to see you here.", "Oh, great."],
    formal: ["{you}.", "Good {daypart}. I suppose."],
    sarcastic: ["Oh joy. {you}.", "Look what the cat dragged in."],
    blunt: ["What do you want?", "{you}. Make it quick."],
  },
  coldBack: { all: ["Don't start.", "What do you want?", "Don't look at me like that.", "I'm not here for you.", "Let's not."], warm: ["Let's not do this, {you}."], formal: ["I'd rather not, {you}."] },
  coldNeutral: { all: ["Alright, {you}.", "Hello to you too.", "Nice to see you too.", "Charming as ever.", "Lovely greeting, that."] },

  // ------------------------------------------------- how are you
  askBack: { all: ["You?", "And you?", "How about you?", "What about you?", "How are you doing?", "You alright?", "And yourself?", "How's things with you?"], formal: ["And yourself?", "And how are you?"], warm: ["How are you, love?"], blunt: ["You?"] },
  sameHere: { all: ["Same, actually.", "Ha. Same here.", "Snap.", "Much the same.", "Same as you, really.", "Same old.", "Can't say different."] },
  howFine: {
    all: [
      "Can't complain.",
      "Same old, same old.",
      "Getting by.",
      "Not bad, not bad.",
      "Mustn't grumble.",
      "Fine, thanks.",
      "Surviving.",
      "All good here.",
      "Ticking along.",
      "Oh, you know. Plodding on.",
      "Could be worse.",
      "Not too shabby.",
      "Fair to middling.",
      "Still standing.",
      "Doing alright.",
      "Keeping my head above water.",
      "Another day, another pound.",
    ],
    formal: ["Quite well, thank you.", "Very well, thank you for asking."],
    blunt: ["Fine.", "Alright.", "Same as ever."],
    chatty: ["Oh, you know, busy busy! Never a dull moment!", "Good! Well, mostly good. Long story."],
    sarcastic: ["Living the dream.", "Thriving. Obviously.", "Never better. Can't you tell?"],
    warm: ["I'm alright, love. Thanks for asking.", "Not bad at all, thanks."],
    nervous: ["Um, fine? I think. Yeah.", "Oh, fine, fine. Sorry, yes."],
  },
  howTired: { all: ["Knackered, honestly.", "Shattered. Could sleep standing up.", "Running on fumes.", "Exhausted. I need my bed.", "Dead on my feet.", "Tired. So tired.", "Half asleep, to be honest."] },
  howHungry: { all: ["Starving, to be honest.", "Hungry. I could eat a horse.", "Ravenous. Haven't eaten all day.", "My stomach thinks my throat's been cut.", "Peckish. Very peckish."] },
  howWet: { all: ["Soaked to the skin.", "Drenched. Have you seen it out there?", "Wet. Very wet.", "Like a drowned rat.", "Dripping, thanks for asking."] },
  howGoodDay: { all: ["Great, actually.", "Brilliant day.", "Not bad at all.", "Really good, as it goes.", "Best day in ages.", "Honestly? Fantastic."] },
  howBadDay: { all: ["Not great.", "Rough day.", "Honestly? Awful.", "Bit of a nightmare, actually.", "Don't ask. Well, you asked.", "I've had better days."] },
  howSad: { all: ["Not great, honestly.", "I've had better weeks.", "Bit low, to be honest.", "Struggling a bit.", "Meh. Not my week."] },
  howAngry: { all: ["Don't ask.", "Fuming, if I'm honest.", "Ready to scream, frankly.", "Wound up. Very wound up.", "Spitting feathers."] },
  howScared: { all: ["Bit on edge, to be honest.", "Worried, mostly.", "Anxious. Can't settle.", "Nervous. Long story.", "Not sleeping well, put it that way."] },
  howHappy: { all: ["Brilliant, actually!", "Really good, thanks!", "Never better.", "On top of the world.", "Great! Life's good.", "Happy. Properly happy."] },
  howLonely: { all: ["Better now someone's talking to me.", "Bit quiet, to be honest.", "Lonely, if I'm honest. Good to see a face.", "Oh, you know. Haven't spoken to anyone all day."] },
  howProud: { all: ["Pretty good, actually.", "Rather pleased with myself, if I'm honest.", "Good. Really good. Things are coming together."] },
  howEnvy: { all: ["Fine. Some of us have to work for it.", "Alright. Not as good as some, mind."] },
  howGrateful: { all: ["Good, thanks. People have been kind.", "Lucky, honestly. I've got good people around me."] },
  howAshamed: { all: ["Oh, you know. Getting by.", "Bit embarrassed about something, but fine."] },

  // ---------------------------------------------- answering news they mention
  sympathy: {
    all: [
      "Oh no. What happened?",
      "That sounds awful. Are you alright?",
      "Oh, I'm sorry. Do you want to talk about it?",
      "What? Tell me everything.",
      "Oh no. You poor thing.",
      "That's rotten luck. How are you holding up?",
      "Blimey. Are you OK?",
      "Oh dear. Is there anything I can do?",
    ],
    formal: ["I'm very sorry to hear that. What happened?", "How dreadful. Are you all right?"],
    blunt: ["That's rubbish. What happened?", "Bad luck. You alright?"],
    chatty: ["Oh no no no. What happened? Tell me everything!", "Oh my goodness, are you alright?!"],
    sarcastic: ["Well, that's the universe for you. You alright, though?", "Course it is. Seriously though, you OK?"],
    warm: ["Oh, love. Come here. What happened?", "Oh sweetheart, I'm so sorry."],
    nervous: ["Oh no, um, are you OK? Sorry. That's awful.", "Oh gosh. Is there anything I can do?"],
  },
  gloat: { all: ["Can't say I'm crying about it.", "Shame. Well. These things happen.", "Hm. Karma, maybe.", "Oh dear. How sad."] },
  congrats: {
    all: [
      "That's brilliant!",
      "No way! Good for you.",
      "Brilliant. You deserve it.",
      "Ha! Lucky you.",
      "Get in! Well done.",
      "That's fantastic news.",
      "You jammy so-and-so!",
      "Well, that's made my day too.",
    ],
    formal: ["Congratulations. That's splendid news.", "How marvellous. Well done."],
    blunt: ["Nice one.", "Good. Well done."],
    chatty: ["No way! That's amazing! Oh, I'm so pleased for you!", "Shut up! Really? That's brilliant!"],
    sarcastic: ["Look at you. Practically royalty.", "Oh, well done. Don't let it go to your head."],
    warm: ["Oh, love, that's wonderful. I'm so happy for you.", "Aw, that's brilliant. You deserve it."],
    nervous: ["Oh wow, that's, um, really great! Well done!", "Oh! That's amazing. Congratulations!"],
  },
  envyReply: { all: ["Must be nice.", "Alright, no need to rub it in.", "Some of us aren't so lucky.", "Lucky you. Really.", "Wish I had your luck.", "Good for you. I suppose."] },
  tellMore: { all: ["Go on.", "What happened?", "Uh oh. What is it?", "Tell me.", "Oh? Go on then.", "I'm all ears.", "That sounds ominous."], warm: ["What is it, love?"], blunt: ["Spit it out."] },
  elaborateBad: { all: ["I'm still a bit shaken, to be honest.", "It's been one of those days.", "I don't really know what to do about it yet.", "I'll be alright. I just needed to say it out loud.", "I keep going over it in my head."] },
  elaborateGood: { all: ["I'm still buzzing.", "I keep pinching myself.", "Honestly, I needed that.", "I've been grinning all day.", "I didn't see it coming at all."] },
  comfort: {
    all: [
      "You'll get through it. You always do.",
      "Shout if you need anything. I mean it.",
      "Take it easy on yourself.",
      "That's rotten. I'm here if you want to talk.",
      "It'll look better tomorrow. It usually does.",
      "Do you want me to come with you to sort it out?",
    ],
    warm: ["Come round mine later. I'll put the kettle on.", "You know where I am, love."],
    blunt: ["It'll sort itself out.", "Don't let it beat you."],
  },
  thanks: { all: ["Thanks. I mean it.", "Cheers. That helps.", "You're a good one, you know that?", "Thank you. Really.", "Ta. That means a lot."] },

  // ------------------------------------------------- telling news
  newsAsk: { all: ["Did you hear about {about}?", "Have you heard about {about}?", "Has anyone told you about {about}?", "You've heard about {about}, right?", "Have you heard the news? About {about}?"] },
  newsNo: { all: ["No, what happened?", "No! Tell me.", "What? No.", "No. Go on.", "First I've heard of it. What happened?", "No, I've been in my own world. What?"] },
  newsBlurt: { all: ["Have you heard? {news}", "Big news: {newsLower}", "You'll never guess. {news}", "Oh, I have to tell you. {news}", "Did you know? {news}", "Guess what. {news}", "Right, so. {news}"] },
  ownNewsIntro: { all: ["I've had quite a day.", "You'll never guess what happened to me.", "Can I tell you something?", "So, my week's been eventful.", "Something happened to me, actually.", "I need to tell someone this."] },
  newsAgain: { all: ["What do you make of {about}?", "Still can't believe {about}.", "So, {about}. What a week.", "Everyone's talking about {about}.", "Did you see what happened with {about}?", "I keep thinking about {about}."] },
  concede: { all: ["Maybe you're right.", "Hm. I hadn't thought of it like that.", "Fair point, actually.", "You might have a point there.", "Alright, I'll give you that.", "Huh. When you put it like that."], formal: ["I suppose you have a point."] },
  disagree: { all: ["Each to their own.", "I don't see it that way.", "We'll have to agree to disagree.", "No, I still think I'm right.", "Nah. Not having that.", "I'm not sure about that, to be honest."] },

  // ------------------------------------------------- gossip and people
  gossipAgree: { all: ["Tell me about it.", "Doesn't surprise me one bit.", "You're not the only one.", "Oh, don't get me started.", "I've said that for ages.", "Same. Exactly the same."] },
  gossipDefend: { all: ["Really? {who}'s always been alright with me.", "Give {who} a chance.", "That's not the {who} I know.", "Hm. Maybe {who}'s just having a bad week.", "I like {who}, actually."] },
  gossipUnsure: { all: ["Hm. I don't really know {who} that well.", "Is that right?", "I wouldn't know.", "Really? Huh.", "I'll take your word for it."] },
  praiseAgree: { all: ["That's nice. {who} seems decent.", "Good to hear.", "{who}'s lovely.", "I've always liked {who}.", "Glad someone's being kind."] },
  praiseDoubt: { all: ["{who}? Not from where I'm standing.", "Hm. If you say so.", "Each to their own.", "Funny. Not my experience."] },

  // ------------------------------------------------- support and worries
  giveMoney: { all: ["Here, take {amount}. Pay me back whenever.", "Don't be daft. Take {amount} and get yourself sorted.", "I can spare {amount}. Don't argue.", "Here's {amount}. No, I insist."] },
  takeMoney: { all: ["Seriously? Thank you.", "You're a lifesaver.", "I'll pay you back, I promise.", "I don't know what to say. Thank you."] },
  kind: { all: ["That's rough. If you need anything, shout.", "Oh no. Is there anything I can do?", "That's hard. I'm sorry.", "You're not on your own with it, you know.", "We'll think of something.", "Money stuff is the worst. I'm sorry."] },
  unkind: { all: ["Maybe cut back on the café lunches, then.", "Everyone's skint. Join the club.", "We've all got bills.", "Should've saved, shouldn't you?", "Welcome to the real world."] },
  saveAdvice: { all: ["Put a bit aside every day. That's what I do now.", "Little and often. That's the trick.", "Pay yourself first. Changed my life, that.", "Keep a pot just for rent. Trust me."] },
  supportive: {
    all: ["I'm sorry. You can always talk to me.", "That sounds hard. Want to grab a drink later?", "Come here. It'll be alright.", "Thanks for telling me. Really.", "You don't have to carry that on your own.", "That's a lot to deal with. I'm here, alright?", "No wonder you're feeling it."],
    warm: ["Oh, love. Come here.", "You poor thing. Let me buy you a cuppa."],
    blunt: ["That's rough. Shout if you need a hand."],
    nervous: ["Oh no. Um, is there anything I can do?"],
  },
  dismissive: { all: ["Chin up. Could be worse.", "Hm. We've all got problems.", "You'll be fine.", "Don't dwell on it.", "Everyone's got something.", "Plenty worse off than you."], sarcastic: ["Have you tried not being sad? Works for me."] },

  // ------------------------------------------------- dreams and plans
  dreamKeen: { all: ["You should go for it.", "You'd be great at that. I mean it.", "Do it. What's stopping you?", "I can see that. I really can.", "If anyone can, you can."] },
  dreamDoubt: { all: ["Big dreams. Rent first, eh?", "Good luck with that.", "One day, maybe.", "Bit of a long shot, isn't it?"] },
  planIntro: { all: ["I've made up my mind about something.", "Can I tell you what I'm up to?", "I've got a plan, you know.", "I've been thinking about the future.", "Right, I've decided something."] },
  planGood: { all: ["Good for you. You'll do it.", "I believe in you, for what it's worth.", "Little and often. That's the trick.", "Make a plan and stick to it.", "Sounds like you've thought it through."] },
  planMeh: { all: ["Easier said than done.", "Best of luck with that.", "Hm. We'll see.", "Rather you than me."] },
  planRival: { all: ["Not if I get there first.", "We'll see about that.", "Race you, then."] },
  planSame: { all: ["Me too! We should keep each other honest.", "Same here, believe it or not.", "Snap. Same plan.", "No way, me too."] },

  // ------------------------------------------------- work
  workGood: { all: ["Good for you.", "Nice one!", "Glad to hear it.", "That's brilliant.", "Look at you go.", "Keep that up."] },
  workBad: { all: ["Hang in there.", "It'll pick up.", "Fair enough.", "That's the way it goes.", "Ah well. Onwards.", "Sounds about right.", "Something'll turn up.", "Chin up."] },

  // ------------------------------------------------- likes and gripes
  gripeSame: { all: ["Tell me about it.", "Don't. Same here.", "You and me both.", "Ugh, I know."] },
  gripeShrug: { all: ["Ha. It's not that bad.", "Could be worse.", "You'll live.", "Get over it."] },

  // ------------------------------------------------- changing the subject
  turn: { all: ["Anyway.", "Oh, before I forget.", "Speaking of which.", "Changing the subject.", "On another note.", "Oh, that reminds me.", "Right, anyway.", "Oh! I meant to say."] },

  // ------------------------------------------------- goodbyes
  bye: {
    all: [
      "Anyway, I'd better get going.",
      "Right, back to it.",
      "Nice chatting.",
      "Catch you later.",
      "Mind how you go.",
      "See you around.",
      "I'll let you get on.",
      "Right, I'm off.",
      "Good to see you.",
      "I'd better crack on.",
      "Don't let me keep you.",
      "Places to be. See you.",
      "Take it easy.",
      "Right, that's me.",
    ],
    formal: ["Well, I shan't keep you. Good {daypart}.", "It was good to speak with you."],
    blunt: ["Right. Off.", "Later."],
    chatty: ["Oh look at the time! I'd better dash. Bye bye!", "Right, I've talked your ear off. See you soon!"],
    sarcastic: ["Well, this has been riveting. See you.", "Right, I'll leave you to your exciting day."],
    warm: ["Look after yourself, love.", "Take care of yourself, won't you?"],
    nervous: ["Um, I should probably go. Sorry. Bye!", "Right, sorry, I'll let you get on."],
  },
  byeClose: { all: ["Good talking to you.", "Let's catch up properly soon.", "Right, I'd better get on. Take care.", "Don't be a stranger.", "Always a pleasure.", "Text me later.", "Same time tomorrow?", "Love you, mean it. Bye."] },
  byeBack: { all: ["See you.", "Take care.", "Bye now.", "Cheers.", "Later.", "See ya.", "Bye!", "You too.", "Mind how you go.", "Ta-ra."], formal: ["Goodbye."], warm: ["Bye, love."] },
  byeCold: { all: ["Right. I'm off.", "Anyway.", "Well. This has been fun.", "I'll leave you to it.", "Don't let me hold you up."] },
};

const ALL_STYLES = ["formal", "blunt", "chatty", "sarcastic", "warm", "nervous"] as const;

/** Fill {slots}: {me}, {you}, {daypart}/{Daypart} and any extras. */
function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

/** "morning" / "afternoon" / "evening" for a game time. */
export function daypart(t: number): string {
  const h = Math.floor((t % 1440) / 60);
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

/**
 * Something for `speaker` to say to `listener`: one of the wordings for this
 * move, in their style where there is one, avoiding what either of them has
 * said lately. Records the choice in the speaker's recent wordings.
 */
export function phrase(r: RngHolder, speaker: Citizen, listener: Citizen | null, move: keyof typeof B | string, vars: Record<string, string> = {}, now = 0): string {
  const bank = B[move];
  if (!bank) throw new Error(`no phrases for ${move}`);
  const style = speaker.personality.style;
  // Their own style's wordings come up more often than the common ones.
  const pool: { key: string; text: string; w: number }[] = [
    ...bank.all.map((text, i) => ({ key: `${move}:${i}`, text, w: 1 })),
    ...(bank[style] ?? []).map((text, i) => ({ key: `${move}:${style}:${i}`, text, w: 2.5 })),
  ];
  const mine = speaker.said ?? [];
  const theirs = (listener?.said ?? []).slice(-40);
  const fresh = pool.filter((p) => !mine.includes(p.key) && !theirs.includes(p.key));
  const from = (fresh.length ? fresh : pool).map((p) => (townSet.has(p.key) ? { ...p, w: p.w * 0.15 } : p));
  let x = rand(r) * from.reduce((s, p) => s + p.w, 0);
  let chosen = from[from.length - 1];
  for (const p of from) {
    x -= p.w;
    if (x <= 0) {
      chosen = p;
      break;
    }
  }
  remembered(speaker, chosen.key);
  heard(chosen.key);
  const dp = daypart(now);
  return fill(chosen.text, { me: speaker.name, you: listener?.name ?? "", daypart: dp, Daypart: dp[0].toUpperCase() + dp.slice(1), ...vars });
}

/** Pick from a list of wordings without repeating what this speaker said lately (for lines built from real details). */
export function choose(r: RngHolder, speaker: Citizen, key: string, options: string[]): string {
  const said = speaker.said ?? [];
  const keyed = options.map((text, i) => ({ k: `${key}#${i}`, text }));
  const fresh = keyed.filter((o) => !said.includes(o.k));
  // Fresh for this speaker, and not said around town lately, if there's any such.
  const unheard = (fresh.length ? fresh : keyed).filter((o) => !townSet.has(o.k));
  const from = unheard.length ? unheard : fresh.length ? fresh : keyed;
  const chosen = from[Math.floor(rand(r) * from.length) % from.length];
  remembered(speaker, chosen.k);
  heard(chosen.k);
  return chosen.text;
}

/** How many wordings there are for a move (all styles), for tests. */
export function wordings(move: string): number {
  const bank = B[move];
  return bank ? bank.all.length + ALL_STYLES.reduce((s, st) => s + (bank[st]?.length ?? 0), 0) : 0;
}
