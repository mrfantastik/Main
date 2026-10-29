import { citizenAcc, transfer } from "../economy/ledger";
import { logEvent } from "../events";
import { remember } from "../memory/memory";
import { feel } from "../mind/emotions";
import { happeningById, knows, learnNews } from "../town/happenings";
import type { Conversation, Happening, WorldState } from "../types";
import { clamp, money } from "../util";
import { adjustRel } from "./relationships";

// What a conversation changes when it ends, written down as notes while it was
// planned: news passed on, minds changed, friendships warmed or strained,
// money handed over. (The conversation system now records most of this
// itself; notes are still applied for conversations saved mid-way by an
// older version, and for anything that uses them.)

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
