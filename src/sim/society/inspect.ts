import type { AgentDecisionDTO, AgentInspectorDTO, ConversationDTO, SocietyDTO } from "../../shared/protocol";
import type { Citizen, Conversation, WorldState } from "../types";
import { nextStep } from "./projects";
import { actionLabel } from "./prompt";
import { alliesOf, reputationOf } from "./reputation";
import { onRoster, societyOf, societyWorld } from "./state";
import { modelRuns } from "./tick";

// What the UI shows of the agents: the agent inspector (one person's goals,
// plans, decisions and beliefs, each marked with whether the AI or the
// built-in judgement came up with it), the town's agents at a glance, and
// who said what to whom (and who wrote it) in a conversation.

const nameOf = (world: WorldState, id: string | null | undefined) => (id ? (world.citizens[id]?.name ?? "someone") : "");

export function societyDTO(world: WorldState): SocietyDTO {
  const sw = societyWorld(world);
  let llm = 0;
  let rules = 0;
  let rejected = 0;
  for (const id of world.citizenOrder) {
    for (const d of world.citizens[id].society?.decisions ?? []) {
      if (d.source === "llm") llm++;
      else rules++;
      if (d.status === "rejected") rejected++;
    }
  }
  return {
    size: sw.size,
    roster: sw.roster.map((id) => ({ id, name: nameOf(world, id) })),
    decisions: { llm, rules, rejected },
    groupsNow: world.conversations.filter((c) => c.group && c.group.present.length >= 3).length,
    rumours: [...sw.rumours].reverse().slice(0, 8).map((r) => ({ text: r.text, origin: nameOf(world, r.origin), about: nameOf(world, r.about), truth: r.truth, heard: r.heard, exposed: r.exposed?.length ?? 0 })),
  };
}

export function agentInspector(world: WorldState, c: Citizen): AgentInspectorDTO {
  const s = societyOf(world, c);
  const sw = societyWorld(world);
  const decisions: AgentDecisionDTO[] = [...s.decisions].reverse().map((d) => ({
    id: d.id,
    t: d.t,
    type: d.action.type,
    label: actionLabel(world, d.action),
    target: d.action.target ? nameOf(world, d.action.target) : null,
    status: d.status,
    result: d.result ?? null,
    error: d.error ?? null,
    source: d.source,
    why: d.why ?? d.action.reason ?? null,
  }));
  const beliefs = (c.talk?.facts ?? [])
    .filter((f) => f.about && f.about !== c.id)
    .sort((a, b) => b.learnedAt - a.learnedAt)
    .slice(0, 14)
    .map((f) => {
      const rm = f.rumour !== undefined ? sw.rumours.find((r) => r.id === f.rumour) : undefined;
      return {
        about: nameOf(world, f.about),
        text: f.text,
        source: f.source,
        from: f.from ? nameOf(world, f.from) : null,
        certainty: Math.round(f.certainty * 100) / 100,
        ...(rm ? { rumour: { truth: rm.truth, origin: nameOf(world, rm.origin) } } : {}),
      };
    });
  return {
    onRoster: onRoster(world, c.id),
    decider: modelRuns(world, c) ? "llm" : "rules",
    goals: s.goals.map((g) => ({ text: g.who ? `${g.text} (${nameOf(world, g.who)})` : g.text, why: g.why, priority: Math.round(g.priority * 100) / 100, status: g.status, source: g.source })),
    projects: [...s.projects].reverse().map((p) => ({
      title: p.title,
      kind: p.kind,
      status: p.status,
      need: p.need,
      raised: p.raised,
      partners: p.partners.map((id) => nameOf(world, id)),
      refused: p.refused.map((id) => nameOf(world, id)),
      next: p.status === "active" ? nextStep(world, c, p).text : null,
      log: p.log.slice(-5).reverse(),
      source: p.source,
    })),
    intention: s.intention ? { text: s.intention.text, t: s.intention.t, source: s.intention.source } : null,
    intents: s.intents.map((i) => ({ what: i.topic.replace(/_/g, " ").replace(/^activity:/, ""), who: nameOf(world, i.target), until: i.until })),
    decisions,
    days: [...s.days].reverse(),
    reputation: reputationOf(world, c),
    allies: alliesOf(world, c).map((x) => ({ ally: nameOf(world, x.ally), against: nameOf(world, x.against) })),
    beliefs,
    crush: s.crush ? nameOf(world, s.crush.who) : null,
  };
}

const MOVE_WORDS: Record<string, string> = { join: "joined", chime: "chipped in", leave: "said goodbye", farewell: "said bye" };

/** Each line of a conversation: who wrote it (the AI or the built-in voice), and in a group, who it was said to and what it did. */
export function conversationLines(world: WorldState, c: Conversation): ConversationDTO["lines"] {
  const g = c.group;
  const turns = !g && c.dlg && c.dlg.turns.length === c.lines.length ? c.dlg.turns : null;
  return c.lines.map((l, i) => {
    const by: "llm" | "built-in" = g ? g.turns[i]?.by ?? "built-in" : turns ? turns[i].by : c.source === "llm" ? "llm" : "built-in";
    const t = g?.turns[i];
    return {
      speaker: l.speaker,
      name: nameOf(world, l.speaker),
      text: l.text,
      by,
      ...(g ? { to: l.to ?? null, toName: l.to ? nameOf(world, l.to) : undefined, move: t && t.move !== "pair" ? MOVE_WORDS[t.move] : undefined } : {}),
    };
  });
}
