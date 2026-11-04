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

## What was built

| Piece | Where | What it does |
| --- | --- | --- |
| Agent state | `society/types.ts`, `state.ts` | Per citizen: goals (from their economic goal, values, dream, rivals), plans, an intention, things waiting for the chance, a decision log (30 kept), a line per day. Made on first use, so old saves get it. The roster: which citizens the model runs (10 by default, picked to differ in personality and line of work). |
| Proposals and checks | `society/actions.ts` | `readAction` turns a model's JSON into an action (names become people, sums are capped); `checkAction` asks the town whether it's possible (money, who they know, ownership, hiring, cooldowns, "already going to see them"); `carryOut` does it: a conversation goes on their agenda, a price is cut, a story starts, a goal changes, a plan starts. |
| The decision loop | `society/tick.ts` | Every 10 game minutes, anyone due to think (every 3 hours for roster agents, 5 for the rest, sooner after something big) decides. Roster agents ask the model through the director; if it can't take them, or its answer is no good, the built-in judgement decides. Every decision is logged with its source and settled later as done, failed, rejected or expired, with what happened. |
| The built-in judgement | `society/propose.ts` | Weighs, by personality: the next step of their plans, goals with no plan yet, friends in trouble, grudges (have it out, make up, or talk about them behind their back), rivals' prices, someone they fancy, loneliness, friends not seen for days, being out of work. It learns from setbacks: something that failed lately counts for less. |
| Decision prompts | `society/prompt.ts` | Only that person's world: who they are, how they feel, their money, goals, plans and the next step, what they've tried lately and how it went, the people in their life as they see them (with what they've heard and from whom, and how sure they are), what the town says about them. A smaller in-page model gets a numbered choice from the built-in judgement's shortlist instead. |
| Plans | `society/projects.ts` | Open a business, find a backer, get a job, win someone over, beat a rival, clear a debt, save up. Each has steps, a deadline, partners and pledges (paid in at launch, or not, and that's remembered), setbacks (scaling down to a stall, "nobody wants in"), and success or failure judged from the real town each night. |
| Negotiation | `dialogue/deal.ts` | Each side's private limits; offers, counters, acceptances and refusals turn by turn; the outcome is the agreement. |
| Groups | `dialogue/group.ts`, `social/group.ts` | The turn scheduler (above) and the town side: who comes over, who's free, who leaves, what everyone overhears and takes away. |
| Reputation and rumours | `society/reputation.ts` | Standing and tags worked out from the town; allies; lies seen through; break-ups. |
| Inspectors | `society/inspect.ts`, `client/ui/AgentTab.tsx`, `Transcript.tsx`, `AIPanel.tsx` | The agent inspector, the Agents box, per-line source and addressee. |

## Who decides what

| | Decided by the language model (roster agents, when one is connected) | Decided by rules |
| --- | --- | --- |
| **Social and economic moves** (talk to someone, ask for a job, propose a deal, lend, help, spread a story, undercut a rival, confront, make up, ask out, start a plan, change goal) | The model proposes one, from that person's own context. | The town checks it and carries it out; the built-in judgement decides for everyone else, and whenever the model can't. |
| **What people say** | Each line, written as that person from their own context, in pairs and in groups. | Who speaks next and what they mean to do (the turn planner and group scheduler); the built-in voice when there's no model or a line is rejected; checks on every line (not someone else's name, no invented sums, no assistant-speak, no repeats). |
| **Deals** | Each side's moves: propose, counter, accept, walk away, and the terms. | Each side's limits; whether a move is possible; applying the agreement (the ledger moves the money). |
| **Daily life** (sleep, eat, work, shop, walk, prices, stock, rent) | With the in-page brain: a plan for the day and the next activity, chosen from what's possible. | The utility AI scores options from needs, money and personality; the economy runs by rules. |
| **Feelings, memories, relationships, reputation, news spreading, rumours being seen through** | | Rules, from what actually happened. |
| **Thoughts and diaries** | With a model connected. | A built-in thought otherwise (never with only the AI: then nothing is shown until the AI has thought it). |
| **With only the AI on** | Every line, every thought shown, every decision: next moves, big decisions, agents' moves, an owner's answer to an applicant or an offer, prices, a trader's or reseller's move. | Checking and applying them, and running the world. Until the model decides, people wait. |

In the UI, 🧠 marks anything from the model and ⚙️ anything from the rules: decisions in the Agent tab, lines in transcripts (AI lines also have a gold edge), the AI log.

### Only the AI speaks, thinks and decides

With **Only the AI** on (`world.ai.aiOnly`; `AI_ONLY=1` on the server, a switch in the 🧠 AI panel, and what `npm run free` sets), nothing the player sees comes from the rules: every line, every thought shown and every decision is the model's. The rules keep their other job: checking what the model proposes and running the world.

**What people say:**

- A conversation only starts if the director takes it on. It's asked before anyone stops what they're doing, so when it can't, nothing happens and they try again later. No built-in draft is even prepared.
- A line the checks turn down (or a timeout, or no reply) is sent back with the reason ("too close to something already said", "you don't know anyone called X") and asked for again, up to 4 tries. Then the conversation ends where it is.
- While the model is busy or asks the game to slow down, people wait. If it's switched off, out of calls or gone, conversations end where they are. One where nobody got a word out never happened. None goes on longer than 6 game hours.
- Groups never switch to the built-in voice. A save loaded mid-conversation is picked up again by the AI, or ends where it is if no AI is connected.
- The rules still decide whose turn it is and suggest what they might do with it (the model may ignore the suggestion), check every line, and apply what was agreed. The model only ever writes the words.

**What they do and decide** (`ai/brain.ts`, `ai/choices.ts`, `ai/director.ts`):

- **What they do next.** While someone is busy, the model is asked what they'll do once they've finished. It chooses from everything that makes sense for them then (up to eight options, ordered by the town's scores, plus going to see a friend) and says why. If no pick is ready when they finish, they don't fall back on the utility AI. Instead they **wait where they are** ("Making up their mind", a `WAIT` action of 10 minutes) until it is. A pick that's no longer possible is asked for again. The ones standing waiting are asked about first, hungriest and most tired first.
- **Big decisions** (career, business, money: `ai/strategy.ts`) all go to the model, whatever the stakes. If it can't take one now, or its answer can't be used, they think it over again later.
- **Agents' moves about other people** (`society/`): everyone is an agent, and every decision is the model's. An answer the town turns down is asked again with the reason (twice), then they think again later; the built-in judgement never steps in. The built-in habits that used to start some conversations are off: chasing an overdue debt, asking a friend for help, rows between people with a grudge. Agents can do those themselves (`propose_deal` with `repayment` or `ask_help`, and `confront`).
- **Things that come up out of the blue** go to the person they come up for, through `world.choices` (saved with the world):
  - an applicant asking an owner for a job;
  - an investor's offer;
  - an owner's prices;
  - a trader's move at the Exchange (one a session);
  - which bargain a reseller buys.

  Each kind lists its options again when the model answers, so it never decides on stale facts, and checks the answer against them. One nobody decides in time lapses: the applicant never hears back, the offer goes nowhere. If only-the-AI is switched off meanwhile, whatever's still waiting is decided the usual way.
- **Thoughts.** The town's own thoughts (`setThought` from the rules) become a cue (`thoughtCue`) instead of being shown. The model puts the important ones into the person's own words, with the most important first. Moves, decisions and choices come with their reason, which is what they're shown thinking. A person shows no thought until the AI has given them one.
- **The clock.** While people stand waiting for the model, the game clock slows down (`director.pace`: 2 ÷ the number waiting, at least 10%), so a slower model can keep up; `world.ai.waitForAI = false` lets it run regardless. Instant skips are refused: the model can't think a day's worth in an instant.

**What stays with the rules:** checking every proposal; applying it (the ledger moves the money); feelings, memories, relationships and reputation, from what actually happened; and the world itself (prices at the market, CityCorp's hiring, wages, rent, chance meetings and who wanders over to a group, how a trading session's chosen trade fills). A model never changes the world directly.

**Requests:** about 730 a game day for a 20-person town, which is 2 a second at 1×:
- ~270 picks and choices (prompts of ~300 tokens);
- ~300 lines (~900 tokens);
- ~100 agent decisions (~1,000 tokens);
- ~60 thoughts (~300 tokens).

`tests/aionly.test.ts` checks that every line is the model's (with a good model and a flaky one), that a dead model leaves a quiet town with nobody stuck mid-conversation, that every kind of conversation can be spoken, and that a reloaded save carries on with the AI. `tests/aidecides.test.ts` checks:
- that over a day every decision made (next moves, big decisions, agents' moves) and every thought shown is the model's;
- that with no model answering nobody decides anything for anyone, people wait, the clock slows and nothing breaks;
- that an owner's model hires an applicant, and that an unanswered one lapses;
- the clock;
- the new agent moves;
- that free mode only ever uses models on this computer.

### Free mode

`npm run free` (and `Play-Free.bat` on Windows, which installs what's needed first) is the free way to play (`scripts/free.ts`, `src/server/free.ts`, `src/sim/ai/localai.ts`):

1. It finds Ollama (at `OLLAMA_HOST`, by default `127.0.0.1:11434`) and starts it if it's installed but not running, with `OLLAMA_NUM_PARALLEL=4` and a 4,096-token context.
2. It picks the model to use. Cloud models (`-cloud`/`:cloud`, or anything with a remote host) are never used, and nor are embedding models.
   - **Asked for one with `--model`:** that one, downloaded if need be.
   - **Already have some:** the best of the ones known to work well.
   - **None yet:** it downloads one that suits the graphics memory (or RAM on Apple Silicon).
3. It times one realistic request. If that takes more than 10 s and it chose the model itself (no `--model`, no `--keep-model`), it tries the next size down (`smallerModel`: 14B → `qwen2.5:7b`, 7–9B → `qwen2.5:3b`, 3–4B → `qwen2.5:1.5b`), downloading it if need be, and uses it if it's quicker.
4. If an answer takes 8 s or less, it times two at once: Ollama answers one at a time unless `OLLAMA_NUM_PARALLEL` says otherwise, and the tray app that starts with Windows doesn't.
5. It sets how hard to work the model (`settingsForSpeed`). The timeout allows for the requests queued ahead (one answer's time × requests at once × 6, between 90 s and 5 minutes): an answer given up on is wasted.

   | One answer takes | Requests at once | Conversations voiced at once |
   | --- | --- | --- |
   | ≤ 2.5 s | 4 (2 if it answers one at a time) | 20 (10) |
   | ≤ 8 s | 2 | 6 |
   | more | 1 | 2 |

6. It starts the server with `LOCAL_ONLY=1`, `FREE_AI_OLLAMA=1` and only the AI speaking, thinking and deciding, and opens the browser.

`LOCAL_ONLY=1` refuses:
- Claude, even with `AI_PROVIDER=claude` set;
- any endpoint that isn't on this computer or the local network;
- cloud model names;
- endpoints entered in the 🧠 AI panel.

The free client never picks a cloud model when it looks for one. It holds Ollama to the exact shape of each reply (`response_format` `json_schema`: a choice can only be one of the ids on the list), falling back to plain JSON (`json_object`) for an Ollama too old for that, and caps the length of a reply (`max_tokens`, per kind of request; not for "thinking" models, whose reasoning counts too).

**Keeping the town going with a model of your own.** Everything waits on the AI when only the AI decides, so with a model on this computer:
- one failed or slow answer never stops it for long: the endpoint rests for 2–5 s (a public service rests for minutes), and the director backs off for 1–10 s, not up to 2 minutes; a request given up on says it took too long (408), not that Ollama couldn't be reached;
- the runner hands the director the AI's answers, and lets it send the next questions, at least every 100 ms, even while the clock is slowed right down (`SimRunner.afterSteps`); otherwise the slower the clock, the slower the AI's answers were taken in;
- a line that got no answer at all is asked for again up to 6 times, a line it got wrong 4 times;
- answers are read generously (`ai/match.ts`): the id in brackets or another case, the option's label, its number on the list;
- while 3 or more people stand waiting to be told what to do, the agents' thinking about people and plans is put off (not decided for them), so the AI's time goes to the people standing there.

`AIDirector.trouble()` says when something's wrong: the AI keeps failing (with why, and what to do: start Ollama, use a smaller model, restart Ollama), or it can't keep up and 6 or more people have been waiting for over a minute. It's in the AI status (`trouble`, `answers`): the top bar shows **⚠️ The AI isn't answering** or **🐢 The AI can't keep up**, and the 🧠 AI panel says what's wrong, with **Try again now** and **Let the built-in AI fill in meanwhile**. The server prints it in its window as it starts and ends, and with a free AI prints a line a minute: answers, seconds each, failures, people waiting, the clock's pace.

## Tuning

- `src/sim/society/config.ts` (`SOCIETY`): roster size, how often agents think, how long an intention lasts, log sizes, the most an agent may give away at once.
- `src/sim/dialogue/group.ts` (`GROUP`): group size, length, how long people stay, when someone else takes the floor.
- `src/sim/ai/director.ts`: one shared model for everyone, with `maxConcurrent` requests in flight (2 by default; the in-page brain on a graphics card takes 4 at once), `minIntervalMs` between calls, `timeoutMs`, calls per game day (`AI_MAX_CALLS_PER_DAY`), budget (Claude), back-off on 429s. Whoever the player is watching comes first, live conversations take turns with decisions and plans, nobody's conversation is left waiting long, and deals get a slot of their own.
- `AI_LIVE_CHATS` / `AI_CONCURRENCY` / `FREE_AI_INTERVAL_MS` (and the same in the 🧠 AI panel's Agents box): how many conversations the model speaks at once (any conversation, not only the ones that matter), how many requests go out at once, and the gap between calls. With either this or Only the AI speaks set, conversation lines come before everything else the model is asked for.
- In the game: the 🧠 AI panel's Agents box sets how many people the AI runs; the Agent tab puts one person on or off the roster.

## Tests

`npm test` (121 tests) includes, for this work:

- `tests/society.test.ts`: a diverse roster of ten; private knowledge kept out of other agents' prompts; proposals checked and turned down with reasons (the built-in judgement stepping in); a model's decision carried out and settled; a week of ten agents with money conserved, every decision settled and logs bounded; different seeds turning out differently; save/load of agent state; lies found out; break-ups; a connected model making the roster's decisions, a broken model handing back to the rules, and requests staying within the concurrency cap.
- `tests/group.test.ts`: newcomers say hello first, each pair alternates, questions are answered, goodbyes get replies, no gossip about someone present, nobody left stuck; the same start gives the same group; everyone present hears the news; groups form on their own over days with people joining, chipping in and leaving, and fewer than 1 problem per 100 chats; a group saved mid-conversation carries on after loading.
- `tests/talk.test.ts`, `brain.test.ts`, `freeai.test.ts`: turn-taking, deals negotiated rather than decided, each line from the speaker's own context, and fallbacks, with fake models.
- `tests/sim.test.ts`, `persistence.test.ts`: determinism, money conservation, and save/load continuing exactly as if it never stopped (now including agents and groups).

`npm run agents` is the success test in one command: ten agents, a week, nobody touching anything, and a report of what happened to each of them.

## Known limits

- With only the AI deciding, the town is only as lively as the model is fast. On a processor (several seconds an answer) most people spend much of the day waiting for it, and the clock slows right down to let it catch up. A graphics card, or a smaller model, helps.

- Without a model connected, the agents run on the built-in judgement. It's personality-driven and varied, but it can't come up with anything outside its list of moves, and it often carries on with the day when nothing is pressing.
- A small in-page model chooses from the built-in judgement's shortlist rather than writing free-form proposals; a bigger model (Claude, or a decent local model through an OpenAI-compatible endpoint) gets the full prompt.
- A group is a set of pairs plus bystanders' interjections. A model writing a line sees everyone's lines, but the built-in voice's replies come from the pair's own exchange.
