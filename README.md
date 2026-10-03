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

This makes `dist/ai-hustle-city.html`, a single file that runs the whole city inside your browser (no server, nothing to install for whoever opens it). It saves itself in that browser. The free AI writes conversations here too, straight from the page.

### Who does the thinking and talking

Citizens run on the built-in **utility AI** (needs, money, personality, memories, relationships). On top of that, a **free public AI** (no account, no key, no cost) writes:

- **what they say**: every chat, deal, favour and argument it has room for, written fresh from who the two people are, how they feel, what they've heard and what they remember about each other;
- **what they're thinking**: the person you're looking at first, then everyone else in turn;
- **their tough decisions**: close calls with real stakes (careers, businesses, money).

The town still decides what happens (who lends what, who gets the job, which news gets passed on), so a smaller model can't break the economy. Whatever the AI can't get to in time, or anything during a skip-ahead, the built-in AI improvises. AI-written lines have a gold border.

**Which AI:** free services come and go and rate-limit anonymous users, so several are tried in turn and the first that answers is used: [Pollinations](https://pollinations.ai) (OpenAI-style endpoint), [LLM7](https://llm7.io), then Pollinations' plain GET endpoint. If a service rejects the model name, the game asks it for its model list and picks a small chat model. In the **🧠 AI** panel you can see which services answer, test the connection, switch it off, or add **your own endpoint** (any OpenAI-style URL, e.g. a free key from a provider, or Ollama / LM Studio on your own machine). Your endpoint is tried first.

> **Playing on claude.ai?** Pages published there aren't allowed to reach the internet, so no outside AI can be called from them; the game notices, says so, and the built-in AI does all the thinking and talking. Download the game file (`npm run build:standalone` → `dist/ai-hustle-city.html`) and open it in your browser, or run `npm start`, to play with the free AI.

**What gets sent:** the made-up townsfolk's names, personalities, feelings, memories and town news (Pollinations requests are marked private, so they stay out of its public feed). Nothing about you.

| Setting (server) | Default | What it does |
|---|---|---|
| `AI_PROVIDER` | `free` | `free`: the free AI services. `claude`: Claude with an API key (below). `off`: built-in AI only. |
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
| **⚡ God Mode** | Give/take money, shortages, surpluses, set prices, assign jobs, spawn/close businesses, booms and crashes, save/export, new world |
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
                       the free AI client (freeai.ts), unscripted chats and invented events
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
    render3d/          3D views (merged static city, instanced citizens): the dreamscape
                       (dream/: sky, mirror floor, mannequins) and the retro town; effects.ts
                       draws happenings (flames, rain, festival lights…)
    net/local.ts       Standalone build: runs the sim in the browser (same messages as the server)
  shared/protocol.ts   Messages between server and browser
scripts/               Headless runner, diagnostics, soak test, standalone packer
tests/                 node:test suites
```

**Separation**: simulation engine (`sim/engine.ts`), AI decisions (`sim/ai`), memory (`sim/memory`), economy (`sim/economy`), persistence (`server/persistence`), UI (`client/ui`), rendering (`client/render`).

**Extension points** (for later — not implemented): new professions register a *work provider* and a *career target*; new actions register in the action registry; products are data (`sim/data/products.ts`); conversation topics are handlers in `social/conversation.ts`; storage is an interface (swap SQLite for Postgres); the server is authoritative and already supports many clients (multiplayer, user-owned citizens/businesses); the engine is headless so it can run continuously on a server. Balance knobs live in `sim/config.ts`.
