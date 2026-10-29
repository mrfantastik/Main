# AI Hustle City as a society of agents

This document records the audit done before the agent-society upgrade, the
design that came out of it, and (at the end) what is decided by a language
model and what is decided by the game's rules.

## The files you have

The three files you play (`ai-hustle-city.html`, `hustle-brain.js` and the
`.onnx` model) are **build outputs**. Nothing in them needs to be edited or
unpacked by hand:

| File | Built from | How |
| --- | --- | --- |
| `ai-hustle-city.html` | `src/client` (React UI, 2D/3D renderers) and `src/sim` (the whole simulation) | `npm run build:three` (Vite, inlined into one page) |
| `hustle-brain.js` | `src/client/brain` (the in-page model runner) plus onnxruntime-web | `scripts/build-brain.ts` (bundled and base64-packed so it loads from `file://`) |
| `*.onnx` / model file | a public small chat model (SmolLM2-class), quantised | downloaded by `npm run fetch-brain`, packed by `scripts/build-brain.ts` |

The encoded runtime in `hustle-brain.js` is onnxruntime-web; it is never
modified. All the code worth changing is the TypeScript under `src/`.

The original project is preserved as git tag `backup/pre-agent-society`
(commit `68afb08`, which is also on GitHub in this branch's history).

## Audit: what already existed

| Requirement | What the project already had | Gap found |
| --- | --- | --- |
| 1. Independent agents | Per citizen: Big Five personality, traits, values, likes, dream, fear, backstory (`mind/personality.ts`); 11 emotions with causes (`mind/emotions.ts`); short/long memory (`memory/memory.ts`); relationships with affinity/trust/familiarity/roles; economic beliefs (`ai/beliefs.ts`); a goal (`Goal`); a character card (`mind/bot.ts`); per-citizen talk state with private facts (`dialogue/`). | No single agent record: goals were one economic goal, no intentions, no projects, no record of what the agent decided and what came of it. |
| 2. Turn-based conversations | New dialogue engine (`dialogue/`): every line is one person's turn, planned from their side, written by the model from that person's own context, validated, with a built-in voice as fallback. | Deals (loans, jobs, investments, sales) were **settled before they were spoken**: the outcome was computed by `negotiation.ts` and then voiced. |
| 3. Groups | None: every conversation had exactly two people (`a`, `b`). | Needed a conversation manager and turn scheduler for 2-5. |
| 4. Memory | Episodic memories with importance/valence/decay and merging; long-term promotion; nightly reflection into lessons; per-pair bonds (episodes, compressed history, threads, jokes); facts with source and certainty; rumours that change as they are retold. | No verified-vs-believed distinction visible to anyone; no deliberate false rumours; no periodic summary of an agent's days. |
| 5. Decisions | Utility AI over scored options (`ai/decision.ts`, `activity.ts`, `strategy.ts`); the in-page brain could pick the next activity or a strategic option; social "agendas" (`conversation.ts agendasFor`) start deal conversations. | The model could only pick from activity lists. No structured social/economic action proposals (seek work, propose a deal, lend, refuse, spread a rumour, help, compete, change goal), no record of consequences. |
| 6. World engine | Action registry with validation (`ai/actions.ts`), double-entry ledger (`economy/ledger.ts`) with money conservation tests, deal validation against limits. | Needed one validated entry point for model-proposed actions, and results reported back to the agent. |
| 7. Goals and plans | One economic goal per citizen, re-thought by strategy reviews; the brain writes a plan for the day. | No multi-day projects that recruit others, gather resources, act and react to setbacks. |
| 8. Emergent social | Friendships form from encounters; grudges from betrayals; gossip; rivalry as a goal kind. | No reputation, alliances, romance or competitive moves between rivals. |
| 9. Scheduler | `ai/director.ts`: one shared model (Claude, a free web model, or the in-page brain), bounded concurrency, minimum interval, timeouts, calls per day, budget, back-off, focus-first ordering. | No priorities between kinds of request, no roster of AI-enabled agents. |
| 10. UI | 3D/2D city, citizen panel (needs, mind, memories, relationships, decisions, chatbot), AI panel with a call log, transcript of conversations. | No live conversation inspector, no agent inspector for goals/projects/beliefs/decisions, and the source of a line or action was not always shown. |
| 11. Tests | 94 tests: determinism, money conservation, save/load continuity, long soak, coherence of thousands of chats, director/brain/free-AI behaviour with fake models. | Needed tests for the new pieces. |

## Design

The agent layer lives in `src/sim/society/` and sits between the utility AI
(still used for routine life: sleep, eat, work, shop, walk) and the language
model (used for the things that matter: what to say, what to do about
people, what to aim for).

```
                 ┌──────────────── world (authoritative rules) ────────────────┐
 events ──▶ agent decision point ──▶ proposal (JSON) ──▶ validate ──▶ apply ──▶ result
              │  (scheduler: priority,   │ from the model,     │ funds, place,    │
              │   roster, limits)        │ or the rule-based   │ ownership, time, │
              │                          │ fallback            │ relationships    ▼
              └──────────── the agent remembers what actually happened ◀────────┘
```

Every proposal, its source (model or fallback), whether the world accepted it
and what came of it is kept in the agent's decision log and shown in the
agent inspector.
