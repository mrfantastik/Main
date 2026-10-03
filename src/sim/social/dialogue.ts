import { type RngHolder } from "../rng";
import { choose } from "./talk";
import { dayOf } from "../time";
import type { Citizen, ConversationLine, WorldState } from "../types";
import { money, pct } from "../util";

// Template dialogue. Used when Claude is off or out of budget, and as the
// fallback if an AI reply is invalid. Lines are grounded in the actual
// numbers the engine negotiated, and flavoured by personality.

export const L = (speaker: Citizen, text: string): ConversationLine => ({ speaker: speaker.id, text });

function tone(c: Citizen): "warm" | "blunt" | "sly" | "plain" {
  if (c.traits.generosity > 0.65 || c.traits.sociability > 0.75) return "warm";
  if (c.traits.greed > 0.7) return "sly";
  if (c.traits.competitiveness > 0.7) return "blunt";
  return "plain";
}

export function loanDialogue(
  r: RngHolder,
  world: WorldState,
  a: Citizen,
  b: Citizen,
  terms: { requested: number; purpose: string; why: string; willing: boolean },
  outcome: { agreed: boolean; amount: number; rate: number; days: number },
): ConversationLine[] {
  const lines: ConversationLine[] = [];
  lines.push(L(a, choose(r, a, "dlg:1", [`${b.name}, I need ${money(terms.requested)} to ${terms.purpose}.`, `Could you lend me ${money(terms.requested)}? It's to ${terms.purpose}.`, `I hate to ask, ${b.name}, but I'm short ${money(terms.requested)}.`])));
  if (terms.why.includes("betrayed")) {
    lines.push(L(b, choose(r, b, "dlg:2", ["After last time? You must be joking.", "You never paid me back before. Why would I trust you now?", "No. Not after what happened."])));
    lines.push(L(a, choose(r, a, "dlg:3", ["That was different. Please.", "I've changed, I swear.", "Fine. Forget I asked."])));
    lines.push(L(b, "The answer's no."));
    return lines;
  }
  if (!terms.willing) {
    lines.push(L(b, terms.why.includes("spare") ? choose(r, b, "dlg:4", ["I'd love to help, but I'm skint myself.", "I just don't have it right now.", "Money's tight for me too, sorry.", "I'm stretched thin myself this month.", "If I had it, it'd be yours. I don't.", "I've got bills of my own, I'm afraid.", "Honestly? I'm counting coppers too."]) : choose(r, b, "dlg:5", ["Why should I lend it to you?", "I don't know you well enough for that.", "Hmm. I don't think so.", "We hardly know each other.", "That's a lot to ask of someone you barely talk to.", "I don't lend money. Nothing personal."])));
    lines.push(L(a, choose(r, a, "dlg:6", ["I'd pay you back, honestly.", "Even half would help.", "Please, I'm desperate.", "I wouldn't ask if I had any other choice.", "Just till the end of the week?", "I'll pay you interest. Whatever you want."])));
    lines.push(L(b, choose(r, b, "dlg:7", ["Sorry. Ask the bank.", "No, sorry.", "Not this time.", "I can't. I'm sorry.", "My answer's still no.", "Try the bank. Honestly.", "Ask me again next month."])));
    return lines;
  }
  const t = tone(b);
  lines.push(
    L(
      b,
      t === "warm"
        ? choose(r, b, "dlg:8", ["For you? Of course. What are the terms?", "I can help. When can you pay it back?", "Course I'll help. Just tell me when you'll pay it back.", "Go on, then. What do you need, exactly?"])
        : t === "sly"
          ? choose(r, b, "dlg:9", ["What's in it for me?", "Money isn't free, you know.", "And what do I get out of it?", "I'm not a charity. What are you offering?"])
          : choose(r, b, "dlg:10", ["Why should I lend it to you?", "How would you pay it back?", "How soon could you pay it back?", "Convince me."]),
    ),
  );
  const offerRate = Math.max(0, outcome.rate - 0.05);
  lines.push(L(a, offerRate < 0.02 ? `I'll pay you back by Day ${dayOf(world.time) + outcome.days}, I promise.` : `I'll pay you ${pct(offerRate)} interest, back by Day ${dayOf(world.time) + outcome.days}.`));
  if (!outcome.agreed) {
    lines.push(L(b, `I'd need at least ${pct(terms.willing ? outcome.rate || 0.2 : 0.3)}. That's my offer.`));
    lines.push(L(a, "That's too steep. I'll find another way."));
    return lines;
  }
  if (outcome.amount < terms.requested) {
    lines.push(L(b, `I can do ${money(outcome.amount)}${outcome.rate > 0.005 ? ` at ${pct(outcome.rate)}` : ""}. Take it or leave it.`));
  } else if (outcome.rate > offerRate + 0.01) {
    lines.push(L(b, `Make it ${pct(outcome.rate)} and you've got a deal.`));
  } else {
    lines.push(L(b, choose(r, b, "dlg:11", ["Deal. Don't let me down.", "Alright. I trust you.", "Fine — but I want it back on time.", "Go on then. Don't make me regret it.", "Done. I'm trusting you with this."])));
  }
  lines.push(L(a, choose(r, a, "dlg:12", ["Deal.", "Thank you — you're a lifesaver.", "Done. I won't forget this.", "You're a star. Thank you.", "I owe you big time."])));
  return lines;
}

export function investDialogue(
  r: RngHolder,
  a: Citizen,
  b: Citizen,
  bizName: string,
  t: { amount: number; why: string; willing: boolean },
  outcome: { agreed: boolean; amount: number; share: number },
): ConversationLine[] {
  const lines: ConversationLine[] = [];
  lines.push(L(a, choose(r, a, "dlg:13", [`${b.name}, want a piece of ${bizName}? I'm raising money to grow.`, `I'm looking for investors in ${bizName}. Interested?`])));
  if (!t.willing) {
    lines.push(L(b, t.why.includes("cash") ? "I don't have spare money to invest, sorry." : choose(r, b, "dlg:14", ["I'm not convinced it'll work.", "Too risky for me.", "I've seen too many shops go under.", "Show me a year of profits first."])));
    lines.push(L(a, "Your loss. It's going to be big."));
    return lines;
  }
  lines.push(L(b, `Maybe. ${t.why[0].toUpperCase()}${t.why.slice(1)}. What would ${money(t.amount)} get me?`));
  lines.push(L(a, `I'll give you ${pct(Math.max(0.01, outcome.share - 0.03))} of the profits.`));
  if (!outcome.agreed) {
    lines.push(L(b, "That's not enough. I'll pass."));
    return lines;
  }
  lines.push(L(b, outcome.share > 0.04 ? `Make it ${pct(outcome.share)} and I'm in.` : "Deal."));
  lines.push(L(a, "Partners, then."));
  return lines;
}

export function jobDialogue(
  r: RngHolder,
  seeker: Citizen,
  owner: Citizen,
  bizName: string,
  askedBySeeker: boolean,
  t: { willing: boolean; why: string },
  outcome: { agreed: boolean; wage: number },
): ConversationLine[] {
  const lines: ConversationLine[] = [];
  if (askedBySeeker) {
    lines.push(L(seeker, choose(r, seeker, "dlg:15", [`${owner.name}, any chance of a job at ${bizName}?`, `Are you hiring at ${bizName}? I need work.`])));
    if (!t.willing) {
      lines.push(L(owner, t.why.includes("betrayed") ? "Not after what you did." : t.why.includes("need") ? "Sorry, I've got all the help I need." : "Sorry, I can't afford staff right now."));
      lines.push(L(seeker, "Okay. Worth asking."));
      return lines;
    }
    lines.push(L(owner, outcome.agreed ? `I could use someone. ${money(outcome.wage)} a day?` : `Maybe ${money(outcome.wage)} a day, if that works.`));
  } else {
    lines.push(L(owner, choose(r, owner, "dlg:16", [`${seeker.name}, I need help at ${bizName}. ${money(outcome.wage)} a day — interested?`, `Want a job? ${bizName} pays ${money(outcome.wage)} a day.`])));
  }
  if (outcome.agreed) lines.push(L(seeker, choose(r, seeker, "dlg:17", ["Deal. When do I start?", "I'll take it!", "You've got yourself a worker.", "Yes! Thank you. Honestly.", "When can I start? Tomorrow?"])));
  else lines.push(L(seeker, choose(r, seeker, "dlg:18", ["That's not enough for me, sorry.", "I'll pass for now.", "I can earn more elsewhere.", "I'll have to think about it.", "That won't cover my rent, sorry."])));
  if (outcome.agreed) lines.push(L(owner, "Tomorrow, 9am. Don't be late."));
  return lines;
}

export function repaymentDialogue(r: RngHolder, lender: Citizen, debtor: Citizen, owed: number, result: "paid" | "partial" | "promise" | "refuse", paid: number): ConversationLine[] {
  const lines: ConversationLine[] = [];
  lines.push(L(lender, choose(r, lender, "dlg:19", [`${debtor.name}, you still owe me ${money(owed)}.`, `Where's my ${money(owed)}, ${debtor.name}?`, `It's past the due date. I need my money back.`])));
  if (result === "paid") {
    lines.push(L(debtor, "Sorry for the wait. Here — every penny."));
    lines.push(L(lender, "Thank you. That means a lot."));
  } else if (result === "partial") {
    lines.push(L(debtor, `I can give you ${money(paid)} now. The rest soon, I promise.`));
    lines.push(L(lender, "Fine. But I want the rest this week."));
  } else if (result === "promise") {
    lines.push(L(debtor, "I'm broke right now. Give me a few more days?"));
    lines.push(L(lender, choose(r, lender, "dlg:20", ["A few days. That's it.", "You're testing my patience."])));
  } else {
    lines.push(L(debtor, choose(r, debtor, "dlg:21", ["I don't owe you anything.", "You'll get it when I'm good and ready.", "Stop hassling me."])));
    lines.push(L(lender, choose(r, lender, "dlg:22", ["I'll remember this.", "Unbelievable. We're done."])));
  }
  return lines;
}

export function helpDialogue(r: RngHolder, needy: Citizen, helper: Citizen, gift: number, agreed: boolean): ConversationLine[] {
  const lines = [L(needy, choose(r, needy, "dlg:23", [`${helper.name}, I'm in a bad way. Haven't eaten properly in days.`, `I'm broke, ${helper.name}. Could you help me out?`]))];
  if (agreed) {
    lines.push(L(helper, choose(r, helper, "dlg:24", [`Here's ${money(gift)}. Don't worry about paying it back.`, `Take ${money(gift)}. Get yourself something to eat.`])));
    lines.push(L(needy, "I won't forget this. Thank you."));
  } else {
    lines.push(L(helper, choose(r, helper, "dlg:25", ["I wish I could, but I'm struggling too.", "Sorry, I can't right now.", "I've got nothing spare. I'm so sorry.", "I'm in the same boat, honestly."])));
    lines.push(L(needy, "I understand."));
  }
  return lines;
}

export function tipDialogue(r: RngHolder, a: Citizen, b: Citizen, product: string, kind: "hype" | "slump", price: number, agreed: boolean): ConversationLine[] {
  const lines = [L(a, kind === "hype" ? `Between us: ${product} demand is about to explode. My research says so.` : `Word of advice — ${product} are about to crash. Get out now.`)];
  if (price > 0) {
    lines.push(L(a, `That tip's worth ${money(price)} to you.`));
    lines.push(L(b, agreed ? "Fine, here's the money. Better be right." : "I'm not paying for gossip."));
  } else {
    lines.push(L(b, choose(r, b, "dlg:26", ["Seriously? Thanks for the heads up!", "I owe you one.", "Interesting... I'll keep that in mind."])));
  }
  return lines;
}

export function argueDialogue(r: RngHolder, a: Citizen, b: Citizen, reason: string): ConversationLine[] {
  return [
    L(a, choose(r, a, "dlg:27", [`You've got some nerve, ${b.name}. ${reason}`, `${reason} Think you can just get away with that?`])),
    L(b, choose(r, b, "dlg:28", ["It's called business. Deal with it.", "Mind your own affairs.", "You're just jealous."])),
    L(a, choose(r, a, "dlg:29", ["We'll see who's laughing at the end of the month.", "This isn't over."])),
  ];
}

export function chatDialogue(r: RngHolder, world: WorldState, a: Citizen, b: Citizen, gossip: string | null, reply: string | null): ConversationLine[] {
  const h = (world.time % 1440) / 60;
  const lines = [L(a, choose(r, a, "dlg:30", [`Alright ${b.name}? How's things?`, `${b.name}! Long day?`, h > 18 ? "Good to see a friendly face tonight." : "Busy day?"]))];
  lines.push(L(b, gossip ?? choose(r, b, "dlg:31", ["Can't complain. You?", "Same old, same old.", "Getting by."])));
  lines.push(L(a, reply ?? choose(r, a, "dlg:32", ["Ha. Good for you.", "Isn't that the truth.", "Well, keep at it."])));
  return lines;
}
