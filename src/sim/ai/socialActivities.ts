import { meetOptions } from "../social/conversation";
import { makeAction } from "./actions";
import { registerActivityProvider, travelPenalty } from "./activity";

// Social activity options: go and find the person you need to talk to.

const VERB: Record<string, string> = {
  ask_loan: "ask for a loan",
  ask_help: "ask for help",
  pitch_investment: "pitch an investment",
  ask_job: "ask about a job",
  offer_job: "offer a job",
  demand_repayment: "get my money back",
  share_tip: "share a tip",
};

registerActivityProvider((world, c, s) => {
  const m = meetOptions(world, c);
  if (!m) return [];
  const { target, agenda } = m;
  const where = target.insideId!;
  return [
    {
      id: `meet:${target.id}`,
      label: `Find ${target.name} to ${VERB[agenda.topic] ?? "talk"}`,
      factors: { urgency: agenda.urgency * 1.3, pressure: s.pressure * 0.3, travel: travelPenalty(world, c, where) },
      payload: makeAction("MEET", where, 10, `Looking for ${target.name}`, { targetId: target.id, topic: agenda.topic, ...agenda.params }),
      thought: `${agenda.reason}. ${target.name} is at the ${world.map.buildings.find((b) => b.id === where)?.name ?? "usual place"} — I'll go and ${VERB[agenda.topic] ?? "talk to them"}.`,
      priority: 3,
    },
  ];
});
