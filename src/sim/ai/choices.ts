import type { ChoiceRequest, Citizen, WorldState } from "../types";
import { newId } from "../util";
import { bestOf, cueThought, recordDecision, setThought, type Option } from "./decision";

// Decisions that come up for someone out of the blue: an applicant asking a
// business owner for a job, an investor's offer, what to charge for
// something. Normally the town's rules settle them on the spot. With only the
// AI deciding (AI-only mode) they're put to the AI instead, and wait for it:
// the applicant hasn't heard yet, the offer is still on the table. Each kind
// says what the choices are (worked out again when the AI answers, so it never
// decides on stale facts), what each choice does, and what happens if nobody
// decides in time (usually: nothing).

export interface ChoiceKind<P = unknown> {
  /** What they're deciding, in a line (for the prompt and the log). */
  title(world: WorldState, c: Citizen, req: ChoiceRequest): string;
  /** The choices as things stand (null: it no longer arises, e.g. the applicant found other work). */
  options(world: WorldState, c: Citizen, req: ChoiceRequest): Option<P>[] | null;
  /** Carry out what was chosen. */
  apply(world: WorldState, c: Citizen, req: ChoiceRequest, chosen: Option<P>, options: Option<P>[]): void;
  /** Nobody decided in time. */
  lapse?(world: WorldState, c: Citizen, req: ChoiceRequest): void;
  /** How long it can wait for the AI (game minutes). */
  wait: number;
}

const kinds = new Map<string, ChoiceKind<unknown>>();

export function registerChoice<P>(kind: string, def: ChoiceKind<P>): void {
  kinds.set(kind, def as ChoiceKind<unknown>);
}

export function choiceKind(kind: string): ChoiceKind<unknown> | undefined {
  return kinds.get(kind);
}

/** The most kept waiting at once (the oldest lapse first). */
const MAX_WAITING = 40;

const same = (a: ChoiceRequest["params"], b: ChoiceRequest["params"]) => Object.keys({ ...a, ...b }).every((k) => a[k] === b[k]);

/**
 * With only the AI deciding: put this decision to the AI (true) instead of
 * making it now. False when the town decides as usual.
 */
export function putToAI(world: WorldState, c: Citizen, kind: string, params: ChoiceRequest["params"]): boolean {
  if (!world.ai.aiOnly || !kinds.has(kind)) return false;
  const list = (world.choices ??= []);
  // The same question again: it's still the one question.
  if (list.some((x) => x.who === c.id && x.kind === kind && same(x.params, params))) return true;
  list.push({ id: newId(world), who: c.id, kind, params, t: world.time, tries: 0 });
  while (list.length > MAX_WAITING) lapseChoice(world, list[0]);
  return true;
}

/** The decisions waiting for the AI (oldest first). */
export function waitingChoices(world: WorldState): ChoiceRequest[] {
  return world.choices ?? [];
}

function drop(world: WorldState, req: ChoiceRequest): void {
  world.choices = (world.choices ?? []).filter((x) => x.id !== req.id);
}

/** Nobody decided in time: it lapses (whatever that means for this kind). */
export function lapseChoice(world: WorldState, req: ChoiceRequest): void {
  drop(world, req);
  const c = world.citizens[req.who];
  if (c) kinds.get(req.kind)?.lapse?.(world, c, req);
}

/**
 * The AI chose (`choice`: an option id, `thought`: why, in their words):
 * check it against the choices as they are now and carry it out. Returns
 * what happened, or why it couldn't be used (the request stays, to be asked
 * again).
 */
export function settleChoice(world: WorldState, req: ChoiceRequest, choice: unknown, thought: string): { ok: true; label: string } | { ok: false; error: string; gone?: boolean } {
  const c = world.citizens[req.who];
  const kind = kinds.get(req.kind);
  if (!c || !kind) {
    drop(world, req);
    return { ok: false, error: "nobody to decide", gone: true };
  }
  const options = kind.options(world, c, req);
  if (!options || options.length === 0) {
    drop(world, req);
    return { ok: false, error: "it no longer arises", gone: true };
  }
  const chosen = typeof choice === "string" ? options.find((o) => o.id === choice) : undefined;
  if (!chosen) return { ok: false, error: `"${String(choice)}" isn't one of the choices` };
  drop(world, req);
  recordDecision(world, c, "reaction", options, chosen, "llm", thought || chosen.label);
  if (thought) setThought(world, c, thought, 3, "llm");
  kind.apply(world, c, req, chosen, options);
  return { ok: true, label: chosen.label };
}

/**
 * Every hour: with only the AI deciding, decisions nobody made in time
 * lapse. Otherwise (it was switched off meanwhile) anything still waiting is
 * decided the usual way, by the town's rules.
 */
export function choicesHourly(world: WorldState): void {
  for (const req of [...(world.choices ?? [])]) {
    const c = world.citizens[req.who];
    const kind = kinds.get(req.kind);
    if (!c || !kind) {
      drop(world, req);
      continue;
    }
    if (world.ai.aiOnly) {
      if (world.time - req.t > kind.wait) lapseChoice(world, req);
      continue;
    }
    drop(world, req);
    const options = kind.options(world, c, req);
    if (!options?.length) continue;
    const chosen = bestOf(options);
    recordDecision(world, c, "reaction", options, chosen, "utility", chosen.thought);
    setThought(world, c, chosen.thought, 3);
    kind.apply(world, c, req, chosen, options);
  }
}

/** Waiting to hear back (a cue for the AI; or, without it, what they think). */
export function waitingToHear(world: WorldState, c: Citizen, text: string): void {
  if (world.ai.aiOnly) cueThought(world, c, text, 2);
  else setThought(world, c, text, 2);
}
