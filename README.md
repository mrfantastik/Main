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

This makes `dist/ai-hustle-city.html`, a single file that runs the whole city inside your browser (no server, nothing to install for whoever opens it). It saves itself in that browser. It uses the built-in utility AI only, because Claude needs the API key on a server.

### Turning on Claude (optional)

Without an API key the citizens run on the built-in **utility AI** (free, and fully reproducible).
With a key, Claude voices the *big moments*: tough career/business dilemmas and conversations about money, jobs and debts.

1. Get an API key from [console.anthropic.com](https://console.anthropic.com) (API usage is billed separately from a Claude.ai subscription).
2. Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY=...`
3. `npm start`

**Cost controls (all on by default):**

| Setting | Default | What it does |
|---|---|---|
| `AI_BUDGET_USD` | `2` | Hard cap on **lifetime** spend, stored in `data/hustle.db` (survives restarts and resets). When reached, citizens just carry on with the utility AI. |
| `AI_MAX_CALLS_PER_DAY` | `12` | Max Claude calls per *game* day. |
| `AI_MODEL` | `claude-opus-5-5` | `claude-haiku-4-5` is ~4× cheaper per token if you want the budget to stretch further. |

In practice the city makes **~2–3 Claude calls per game day** (≈ $0.03/day with Opus 5.5), because only genuine dilemmas and money talk qualify. Walking, working, buying, pricing, small talk etc. never touch the LLM. You can pause Claude, change the budget and read every prompt/response in the **🧠 AI** panel.

---

## How to watch

| | |
|---|---|
| **3D / 2D** | Switch views top-right of the map (3D is the default; your choice is remembered) |
| **Pan / zoom / rotate** | Drag the map / mouse wheel or pinch (or WASD + `+`/`-`); in 3D, `Q`/`E` or ⟲ ⟳ turn the view 90° |
| **🎬 Director** | (3D) the camera glides to deals, conversations, new businesses and big money moments on its own |
| **Inspect a citizen** | Click them on the map or in the list. Tabs: Overview (who they are, backstory, how they feel), 🧠 Mind (why they did things, lessons learned), Social (relationships, memories and the feelings attached, conversations), Money. Strong feelings show as an emoji next to people on the map and in the list |
| **Inspect a business** | Click a shop |
| **Speed** | ⏸ 1× 5× 20× 50× (1× = one game hour every 15 s) |
| **Skip ahead** | ⏩ +1h, +1d, +1w: jumps instantly (same result as watching it; Claude is paused during a skip so it costs nothing) |
| **📊 Dashboard** | Money supply, wealth, inequality, unemployment, businesses, prices, richest/poorest, top businesses… |
| **⚡ God Mode** | Give/take money, shortages, surpluses, set prices, assign jobs, spawn/close businesses, booms and crashes, save/export, new world |
| **🧠 AI** | Claude status, spend, call log, recent conversations |
| **📰 Live events** | Everything happening, filterable; click names; "Read conversation" opens transcripts |

---

## What's simulated

- **City**: houses, shops, marketplace, CityCorp offices, cowork hub, bank & exchange, pub, diner, park, research lab, wholesale depot. Day/night cycle. Citizens walk the roads. Shown as a retro low-poly 3D town (three.js, rendered at ~400 px tall and scaled up pixel-sharp) or as the original flat 2D map.
- **Citizens**: name, age, archetypes (ambitious, risk-taking, conservative, lazy, friendly, competitive, entrepreneurial, greedy, generous, frugal, curious), skills that improve with practice, needs (energy, hunger, social, fun), money, savings, credit score, inventory, home, goal, thoughts.
- **Personality**: Big Five scores built from those archetypes, 2–3 core values (family, status, freedom, security, fairness, wealth, community, knowledge), quirks and habits, a speaking style (formal, blunt, chatty, sarcastic, warm, nervous), likes and dislikes, a fear, a dream and a short backstory. Generated from the seed, so the same city always has the same people.
- **Feelings**: joy, sadness, anger, fear, pride, shame, envy, gratitude, loneliness and love (0–100). Events push them (getting paid, losing a deal, being helped or cheated, rent arrears, a rival's good day, a good or bad conversation); each drifts back towards a target set by personality and circumstances at its own speed (anger cools in hours, love lingers). Neurotic people take bad news harder; extraverts get more joy from company. Mood is worked out from the feelings. They nudge behaviour within limits: anger means tougher terms and arguments, fear means saving and avoiding risk, loneliness means going out, envy means competitive moves, gratitude means generous terms for whoever helped, sadness means getting less done.
- **Emotional memory and reflection**: memories keep the feelings they caused, and meeting that person again brings them back (grudges, loyalty). Each night people sleep on their day and keep one or two lessons ("Ethan can't be trusted", "Selling groceries works for me") that shift trust and beliefs. With Claude on, at most one lesson per game day (from someone having a strongly emotional day) is reworded by Claude in that citizen's own voice, from the same budget and paused during skip-ahead.
- **Jobs**: employee (CityCorp or citizen businesses), freelancer, shopkeeper, reseller, trader, entrepreneur, researcher, unemployed — each behaves differently.
- **Economy** (all virtual £): wholesale market with volatility and demand shocks, a marketplace with listings and clearance lots, shops/stalls/cafés/agencies competing on price, reputation and staffing, rent, wages, owner draws, dividends, bank savings & loans, peer loans, equity investments, bankruptcies, evictions, inventions with royalties.
- **Memory**: short-term and long-term memories, importance-weighted, merging repeats, fading over time, each carrying the feelings it caused.
- **Relationships**: affinity, trust, familiarity and roles (family, friend, rival, employer, partner, creditor…). They change through encounters, deals, favours and betrayals — and they change decisions.
- **Conversations**: loans, investment pitches, job requests/offers, debt collection, asking for help, sharing/selling research tips, arguments, gossip. The engine sets each side's real limits; templates or Claude write the words; outcomes move real money. Template lines are spoken in each citizen's style and current mood and bring up real shared history ("After what you did on Day 12? No chance."); Claude prompts include personality, feelings, values and lessons.

---

## Debugging: why did they do that?

Every decision records the options considered, their scores and the factors behind them.

- In the app: click a citizen → **🧠 Mind** tab → expand any decision.
- From the terminal (same engine, Claude off, reproducible):

```bash
npm run sim -- --days 10 --seed 42                 # run 10 days, print the story
npm run sim -- --days 5 --seed 42 --explain Jake   # every decision Jake made, and why
npm run diagnose -- --days 20 --seed 42            # money flows, businesses, earnings by job
npm test                                           # determinism, money conservation, systems
npm run soak -- --days 365 --seeds 42,7,2024       # play whole years, checking dozens of rules every game hour
npm run soak -- --days 150 --god                   # …while randomly using God Mode
```

The soak test checks, every game hour: money only enters or leaves town through recorded flows; nobody has negative or NaN money; jobs, businesses, homes and loans agree with each other; nobody is stuck doing one thing. Every day it checks the whole world for NaN and builds every UI panel. Every 30 days it saves, reloads and checks both copies play out identically.

The same seed always produces the same story (with Claude off), so bugs are reproducible. In the browser console, `hustle.store.s` holds everything the UI knows.

---

## Data

- `data/hustle.db` — SQLite: world snapshots (last 5), full event and transaction history, Claude spend.
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
                       scoring, beliefs, careers, thoughts, AI director, LLM prompts
    economy/           Ledger (all money moves here), market, businesses, bank,
                       jobs, services, trading, reselling, research, housing, shopping
    memory/            Memory system
    mind/              Personality, emotions, nightly reflection, behaviour tilts, speaking voice
    social/            Relationships, encounters, conversations, negotiation, dialogue
    god.ts             God Mode commands + macro economy
    stats.ts           Economy statistics
    snapshot.ts        World → UI messages
  server/              Node server: runs the sim, WebSocket streaming, persistence
    persistence/       SQLite store (node:sqlite) with JSON-file fallback
    anthropic.ts       Claude client (structured JSON output)
  client/              Browser: React panels + city views
    render/            2D canvas view, shared interpolation and overlay text
    render3d/          Low-poly 3D view (merged static city, instanced citizens)
    net/local.ts       Standalone build: runs the sim in the browser (same messages as the server)
  shared/protocol.ts   Messages between server and browser
scripts/               Headless runner, diagnostics, soak test, standalone packer
tests/                 node:test suites
```

**Separation**: simulation engine (`sim/engine.ts`), AI decisions (`sim/ai`), memory (`sim/memory`), economy (`sim/economy`), persistence (`server/persistence`), UI (`client/ui`), rendering (`client/render`).

**Extension points** (for later — not implemented): new professions register a *work provider* and a *career target*; new actions register in the action registry; products are data (`sim/data/products.ts`); conversation topics are handlers in `social/conversation.ts`; storage is an interface (swap SQLite for Postgres); the server is authoritative and already supports many clients (multiplayer, user-owned citizens/businesses); the engine is headless so it can run continuously on a server. Balance knobs live in `sim/config.ts`.
