# 🏙️ AI Hustle City

A persistent little city of 20 autonomous AI citizens trying to get ahead. They pick jobs, start businesses, undercut rivals, borrow from friends, fall out, go bust, invent things — and you watch it unfold (and occasionally play god).

Nothing is scripted. Every story comes from the systems: needs, money, personality, beliefs, memories and relationships.

---

## Quick start

You need [Node.js](https://nodejs.org) 22 or newer (20 works too, without the SQLite database).

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

That's it. The city starts at 6am on Day 1 and keeps running on the server — refresh the page, close the tab, even restart the server, and it carries on where it left off.

### No install: play in the browser

```bash
npm run build:standalone
```

A ready-made copy is published here: **https://claude.ai/artifact/ApFS3fgxqugFg2Pz6RKtwU** (private to the owner until shared).

This makes the game in **three files**, in `dist/three/`. Keep them together in one folder and open the page:

| File | What it is |
|---|---|
| `ai-hustle-city.html` | **The town**: the whole city, its people and economy, running in your browser (no server, nothing to install). Open this one. |
| `hustle-brain.js` | **The AI engine**: the town's brain (a worker that runs a language model) and the onnxruntime WebAssembly runtime it runs on, about 9 MB. Without it the town runs on its built-in AI. |
| `hustle-model.bin` | **The model**: an open-source language model and its tokenizer in one file. Swap it for a bigger one and the town gets smarter. |

You don't need to find a model: in the 🧠 AI panel, choose one (SmolLM2 360M, Qwen2.5 0.5B or Qwen2.5 1.5B, all free under Apache 2.0) and the game downloads it from Hugging Face once, saves it as `hustle-model.bin` in your downloads, and keeps it in your browser, so from then on the brain wakes by itself. Put that file next to the other two; next time, or on another computer, click **📂 Load hustle-model.bin**. If you serve the folder from a website, a `hustle-model.bin` next to the page is picked up by itself. `npm run fetch-brain -- --model onnx-community/Qwen2.5-1.5B-Instruct --name "Qwen2.5 1.5B Instruct"` before building puts the model file in `dist/three/` for you. (The format: `HUSTLEMODEL1`, a little-endian 32-bit header length, a JSON header naming each file's offset and length, then the files; see `src/client/brain/pack.ts`.)

The same build also makes `dist/ai-hustle-city.html`, the older **single-file** game (the town and the engine in one page; it fetches the runtime from a CDN and takes the same model file). Both save the town in that browser.

### Who does the thinking and talking

Citizens run on the built-in **utility AI** (needs, money, personality, memories, relationships). On top of that, in the browser game, **the town's brain**, a small open-source language model running **on your own computer**, runs the people all the time, with nothing to click:

Every citizen is an AI agent, and the brain is its mind:

- **a plan for the day**: overnight (or when they first need one), it writes each person's plan for the day from the things they could do (work, meals, shopping, the pub, meeting up with a friend), as they would plan it, with a reason for each. They follow it through the day, and their panel shows it ticked off as they go;
- **what they do next**: while someone is busy, the brain is asked what they'll do after, choosing from the things that make sense for them once they're done (eat, work, go to the pub, go and see a friend who's out and about...), from who they are, how they feel and what's on their mind. They act on it, and their reason becomes what they're thinking. If things change before they're done (they got hungrier, the shop shut), a pick that no longer makes sense is dropped;
- **a diary**: last thing at night it writes a line or two in their diary about the day, and reads it back when planning the next day and in their conversations and thoughts;
- **their tough calls**: jobs, money, starting or closing a business;
- **what they say**: chats, deals, favours and arguments, rewritten in their own voices from the scene's beats and a rough draft, with who they are, how they feel, what they've heard and what they remember;
- **what they're thinking**, in between.

**When you meddle, they react.** Take money from someone and they feel it in proportion: £5 from someone with thousands is a shrug; most of their savings is fury and fear. Their first thought is about it, and they stop what they're doing to take it in, then decide what to do (look for work, ask a friend for help...). It shows in the feed, and comes up when they talk. A suspicious sort may blame someone they already dislike, which can sour that friendship. Windfalls, a job they never applied for, a business shut down or handed to them, a crash or a boom, a shortage in what they sell: each lands the way it should. With the brain awake, it reacts first: it writes what goes through their mind, and a new plan for the rest of their day.

Whoever you're looking at comes first; then whoever is about to decide something or wake up. On a graphics card the brain writes for up to four people at once (one step costs about the same for four as for one), so it can keep up with the whole town at normal speed; on a processor it does one at a time. The brain does one thing at a time, so it can't get to everything at once: whatever it misses, the built-in utility AI does, and a day plan keeps steering them even when the brain is busy. The 🧠 AI panel shows what it's doing right now and how much it has done, and a person's panel marks what the brain chose for them with 🧠. It's all free: the model runs on your computer, and nothing is sent anywhere.

The brain is whichever model you choose: [SmolLM2 360M](https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct) (quick, runs anywhere), [Qwen2.5 0.5B](https://huggingface.co/onnx-community/Qwen2.5-0.5B-Instruct) or [Qwen2.5 1.5B](https://huggingface.co/onnx-community/Qwen2.5-1.5B-Instruct) (the smartest: livelier conversations and plans, needs a decent graphics card), all Apache 2.0, run with [onnxruntime-web](https://onnxruntime.ai): on your graphics card if your browser has WebGPU (Chrome, Edge), otherwise on your processor. Nothing is sent anywhere; it's free. Click **🧠 Wake the brain** in the top bar: the first time it takes you to the 🧠 AI panel to choose a model; after that it wakes by itself whenever you open the game. On a processor it's slower, so it only writes the conversations of whoever you're watching (it still picks people's moves and thinks for them).

Without the brain (or before it's awake), conversations come from a phrasebook of hundreds of wordings, matched to who's talking (warm or cold, a friend or a stranger, at the pub or the market), what's happened to them, the news and their last chat together. Nobody repeats a line they've said lately, and the town avoids lines it's heard lately, so two chats rarely go the same way; replies answer what was actually said.

The town keeps the rules (it only offers choices a person can actually make, and decides who lends what, who gets the job, which news gets passed on), so a small model can't break the economy. Whatever it can't get to in time, or anything during a skip-ahead, the built-in AI improvises. AI-written lines have a gold border.

**Where the model comes from:**
- **The three-file game** (`dist/three/`, opened from disk): `hustle-model.bin`, which you load once (or the game downloads for you); after that it's kept in your browser.
- **The single-file game** (`dist/ai-hustle-city.html`): the same model file.
- **A published copy** (e.g. on claude.ai, where pages can't reach the internet): the model has to be published with the page. `npm run fetch-brain` downloads it into `models/brain`, and `npm run build:standalone` then splits it into parts under 15 MB in `dist/artifact/brain/` (with the onnxruntime WebAssembly binary and a manifest). A page published on claude.ai can carry about 256 MB, so the model has to fit in that.

**The server version** (`npm start`) can't use the in-page brain; there, free web AI services write the conversations instead (no account or key: Pollinations, then LLM7, tried in turn; or any OpenAI-style endpoint you add in the 🧠 AI panel, such as Ollama on your machine). What gets sent there: the made-up townsfolk's names, personalities, feelings, memories and town news.

| Setting (server) | Default | What it does |
|---|---|---|
| `AI_PROVIDER` | `free` | `free`: the free web AI services. `claude`: Claude with an API key (below). `off`: built-in AI only. |
| `FREE_AI_URL` | *(the built-in list)* | Use only this OpenAI-style endpoint. |
| `FREE_AI_INTERVAL_MS` | `2500` | Minimum gap between calls. |

### Using Claude instead (optional)

With `AI_PROVIDER=claude` and an API key, Claude voices the *big moments* instead: tough career/business dilemmas and conversations about money, jobs and debts.

1. Get an API key from [console.anthropic.com](https://console.anthropic.com) (API usage is billed separately from a Claude.ai subscription).
2. Copy `.env.example` to `.env` and set `AI_PROVIDER=claude` and `ANTHROPIC_API_KEY=...`
3. `npm start`

**Cost controls (all on by default):**

| Setting | Default | What it does |
|---|---|---|
| `AI_BUDGET_USD` | `2` | Hard cap on **lifetime** spend, stored in `data/hustle.db` (survives restarts and resets). When reached, citizens just carry on with the utility AI. |
| `AI_MAX_CALLS_PER_DAY` | `12` (Claude), `5000` (free) | Max AI calls per *game* day. |
| `AI_MODEL` | `claude-opus-5-5` | `claude-haiku-4-5` is ~4× cheaper per token if you want the budget to stretch further. |

In practice the city makes **~2–3 Claude calls per game day** (≈ $0.03/day with Opus 5.5), because only genuine dilemmas and money talk qualify. Walking, working, buying, pricing, small talk etc. never touch the LLM. You can pause Claude, change the budget and read every prompt/response in the **🧠 AI** panel.

---

## How to watch

| | |
|---|---|
| **3D / Retro / 2D** | Switch views top-right of the map. **3D** is the dreamscape (glossy mannequins on a mirror-like hex floor among marble columns, under a purple sky); **Retro** is the warm low-poly town; **2D** the flat map. Your choice is remembered |
| **👁 Ground** | (3D) drop to street level: behind whoever you've selected, or slowly looking round town |
| **Pan / zoom / rotate** | Drag the map / mouse wheel or pinch (or WASD + `+`/`-`); in 3D, `Q`/`E` or ⟲ ⟳ turn the view 90° |
| **🎬 Director** | (3D) the camera glides to deals, conversations, new businesses and big money moments on its own |
| **Inspect a citizen** | Click them on the map or in the list. Tabs: Overview (who they are, backstory, how they feel), 🧠 Mind (why they did things, lessons learned), Social (relationships, memories and the feelings attached, conversations), Money. Strong feelings show as an emoji next to people on the map and in the list |
| **Inspect a business** | Click a shop |
| **Speed** | ⏸ 1× 5× 20× 50× (1× = one game hour every 15 s) |
| **Skip ahead** | ⏩ +1h, +1d, +1w: jumps instantly (same result as watching it; the AI is paused during a skip) |
| **📊 Dashboard** | Money supply, wealth, inequality, unemployment, businesses, prices, richest/poorest, top businesses… |
| **⚡ God Mode** | Give/take money, shortages, surpluses, set prices, assign jobs, spawn/close businesses, booms and crashes, save/export, new world. People react to whatever you do to them (see below) |
| **🧠 AI** | Who's writing conversations, on/off, call log (every prompt and reply), recent conversations |
| **Town news** | Chips over the map for what's going on (a fire, a festival, a storm…); click one to see who or where |
| **📰 Live events** | Everything happening, filterable; click names; "Read conversation" opens transcripts |

---

## What's simulated

- **City**: houses, shops, marketplace, CityCorp offices, cowork hub, bank & exchange, pub, diner, park, research lab, wholesale depot. Day/night cycle. Citizens walk the roads. Shown as a 3D dreamscape (three.js: reflective floor, cloud sky, mannequin citizens, a ground-level camera), the retro low-poly town, or the original flat 2D map.
- **Citizens**: name, age, archetypes (ambitious, risk-taking, conservative, lazy, friendly, competitive, entrepreneurial, greedy, generous, frugal, curious), skills that improve with practice, needs (energy, hunger, social, fun), money, savings, credit score, inventory, home, goal, thoughts.
- **Personality**: Big Five scores built from those archetypes, 2–3 core values (family, status, freedom, security, fairness, wealth, community, knowledge), quirks and habits, a speaking style (formal, blunt, chatty, sarcastic, warm, nervous), likes and dislikes, a fear, a dream and a short backstory. Generated from the seed, so the same city always has the same people.
- **Feelings**: joy, sadness, anger, fear, pride, shame, envy, gratitude, loneliness and love (0–100). Events push them (getting paid, losing a deal, being helped or cheated, rent arrears, a rival's good day, a good or bad conversation); each drifts back towards a target set by personality and circumstances at its own speed (anger cools in hours, love lingers). Neurotic people take bad news harder; extraverts get more joy from company. Mood is worked out from the feelings. They nudge behaviour within limits: anger means tougher terms and arguments, fear means saving and avoiding risk, loneliness means going out, envy means competitive moves, gratitude means generous terms for whoever helped, sadness means getting less done.
- **Emotional memory and reflection**: memories keep the feelings they caused, and meeting that person again brings them back (grudges, loyalty). Each night people sleep on their day and keep one or two lessons ("Ethan can't be trusted", "Selling groceries works for me") that shift trust and beliefs. With Claude on, at most one lesson per game day (from someone having a strongly emotional day) is reworded by Claude in that citizen's own voice, from the same budget and paused during skip-ahead.
- **Town happenings**: fires, break-ins, lottery wins, celebrity visits, food poisoning, storms, power cuts, rent rises, festivals, birthday parties and mysterious columns in the park, every day or two. They have real effects (a fire shuts the shop and burns stock; a storm keeps shoppers home; a celebrity visit brings a queue; a burglary or lottery win moves real money), and they show on the map. News spreads the way it does in a small town: witnesses, the morning paper, and word of mouth. Each person takes it their own way (sorry, secretly glad, envious), and generous friends sometimes chip in to help.
- **Jobs**: employee (CityCorp or citizen businesses), freelancer, shopkeeper, reseller, trader, entrepreneur, researcher, unemployed — each behaves differently.
- **Economy** (all virtual £): wholesale market with volatility and demand shocks, a marketplace with listings and clearance lots, shops/stalls/cafés/agencies competing on price, reputation and staffing, rent, wages, owner draws, dividends, bank savings & loans, peer loans, equity investments, bankruptcies, evictions, inventions with royalties.
- **Memory**: short-term and long-term memories, importance-weighted, merging repeats, fading over time, each carrying the feelings it caused.
- **Relationships**: affinity, trust, familiarity and roles (family, friend, rival, employer, partner, creditor…). They change through encounters, deals, favours and betrayals — and they change decisions.
- **Conversations**: loans, investment pitches, job requests/offers, debt collection, asking for help, sharing/selling research tips, arguments, and plenty of chat. The engine sets each side's real limits and outcomes move real money. Chats are planned from what's actually on their minds: news one of them hasn't heard, gossip about someone they both know, money worries, how they really feel, plans and dreams, a lesson learned the hard way, prices, shared interests, the weather. The listener answers from their own view and may be persuaded or not; news passed on, minds changed and friendships warmed or strained all take effect when the chat ends. The free AI writes the words when it can; otherwise the built-in AI improvises them in each citizen's style and mood, with real shared history ("After what you did on Day 12? No chance.").

---

## Debugging: why did they do that?

Every decision records the options considered, their scores and the factors behind them.

- In the app: click a citizen → **🧠 Mind** tab → expand any decision.
- From the terminal (same engine, AI off, reproducible):

```bash
npm run sim -- --days 10 --seed 42                 # run 10 days, print the story
npm run sim -- --days 5 --seed 42 --explain Jake   # every decision Jake made, and why
npm run diagnose -- --days 20 --seed 42            # money flows, businesses, earnings by job
npm test                                           # determinism, money conservation, systems
npm run soak -- --days 365 --seeds 42,7,2024       # play whole years, checking dozens of rules every game hour
npm run soak -- --days 150 --god                   # …while randomly using God Mode
```

The soak test checks, every game hour: money only enters or leaves town through recorded flows; nobody has negative or NaN money; jobs, businesses, homes and loans agree with each other; nobody is stuck doing one thing. Every day it checks the whole world for NaN and builds every UI panel. Every 30 days it saves, reloads and checks both copies play out identically.

The same seed always produces the same story (with the AI off), so bugs are reproducible. In the browser console, `hustle.store.s` holds everything the UI knows.

---

## Data

- `data/hustle.db` — SQLite: world snapshots (last 5), full event and transaction history, Claude spend (if you use Claude).
- **⚡ God Mode → 💾 Save now / ⬇️ Download world / 📂 Load a save** for manual saves, exports and imports (saves move between the server and browser versions). `GET /api/history?limit=100` returns older events.
- To start fresh: God Mode → *Start over*, or delete the `data` folder.
- `npm run serve` builds the client and runs in production mode.

---

## Architecture

```
src/
  sim/                 The simulation — pure TypeScript, no I/O, runs anywhere
    engine.ts          Fixed 1-minute ticks: movement, activities, hourly & daily systems
    world.ts setup.ts  World creation (city, citizens, starting economy)
    types.ts           All state is plain JSON-serialisable data
    city/              Map generation, A* pathfinding
    ai/                Decision system: actions, activity & strategy options, utility
                       scoring, beliefs, careers, thoughts, AI director, LLM prompts,
                       the free AI client (freeai.ts), small-model prompts (small.ts),
                       invented events
    economy/           Ledger (all money moves here), market, businesses, bank,
                       jobs, services, trading, reselling, research, housing, shopping
    memory/            Memory system
    town/              Happenings (fires, festivals, storms…) and how news spreads
    mind/              Personality, emotions, nightly reflection, behaviour tilts, speaking voice
    social/            Relationships, encounters, conversations, negotiation, dialogue,
                       improvised chats (improv.ts)
    god.ts             God Mode commands + macro economy
    stats.ts           Economy statistics
    snapshot.ts        World → UI messages
  server/              Node server: runs the sim, WebSocket streaming, persistence
    persistence/       SQLite store (node:sqlite) with JSON-file fallback
    anthropic.ts       Claude client (structured JSON output, AI_PROVIDER=claude)
  client/              Browser: React panels + city views
    render/            2D canvas view, shared interpolation and overlay text
    brain/             The town's brain: a small open-source model in a Web Worker
                       (onnxruntime-web + tokenizer + generation loop), its page-side client,
                       the model file format (pack.ts) and the models to choose from (models.ts)
    render3d/          3D views (merged static city, instanced citizens): the dreamscape
                       (dream/: sky, mirror floor, mannequins) and the retro town; effects.ts
                       draws happenings (flames, rain, festival lights…)
    net/local.ts       Standalone build: runs the sim in the browser (same messages as the server)
  shared/protocol.ts   Messages between server and browser
scripts/               Headless runner, diagnostics, soak test, standalone and three-file packers
tests/                 node:test suites
```

**Separation**: simulation engine (`sim/engine.ts`), AI decisions (`sim/ai`), memory (`sim/memory`), economy (`sim/economy`), persistence (`server/persistence`), UI (`client/ui`), rendering (`client/render`).

**Extension points** (for later — not implemented): new professions register a *work provider* and a *career target*; new actions register in the action registry; products are data (`sim/data/products.ts`); conversation topics are handlers in `social/conversation.ts`; storage is an interface (swap SQLite for Postgres); the server is authoritative and already supports many clients (multiplayer, user-owned citizens/businesses); the engine is headless so it can run continuously on a server. Balance knobs live in `sim/config.ts`.
