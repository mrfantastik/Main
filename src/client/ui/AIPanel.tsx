import { useRef, useState } from "react";
import { MODEL_CHOICES } from "../brain/models";
import type { AIStatusDTO } from "../../shared/protocol";
import { store, useStore } from "../net/store";
import { aiName, when } from "./format";
import { Shell } from "./Overlays";
import { Transcript } from "./Transcript";

export function AIPanel() {
  const ai = useStore((s) => s.state?.ai);
  const dash = useStore((s) => s.dashboard);
  const [budget, setBudget] = useState("");
  const [perDay, setPerDay] = useState("");
  if (!ai) return null;
  const pctUsed = ai.budgetUsd > 0 ? Math.min(100, (ai.spentUsd / ai.budgetUsd) * 100) : 100;
  return (
    <Shell title="🧠 AI engine">
      <div className="grid2">
        {ai.brain ? <BrainBox ai={ai} /> : ai.free ? <FreeAIBox ai={ai} /> : (
        <div className="box">
          <h3>How citizens think</h3>
          <p style={{ marginTop: 0 }}>
            Every citizen runs on a built-in <b>utility AI</b>: it scores options from needs, money, personality, beliefs, memories and
            relationships. That handles everything — walking, work, prices, deals — for free.
          </p>
          <p>
            Optionally, <b>Claude</b> is consulted only for big moments: tough career/business dilemmas and conversations about money, jobs
            and debts. The engine always sets the limits (what a lender can spare, what a worker will accept) and validates Claude's answer.
          </p>
          <div className="kv">
            <span className="k">Status</span>
            <span>
              {ai.available ? (ai.mode === "llm" ? <span className="chip llm">Claude ON</span> : <span className="chip">Claude paused</span>) : <span className="chip bad">Claude unavailable</span>}{" "}
              {!ai.available && <span className="muted">{ai.reason ?? "set ANTHROPIC_API_KEY and restart"}</span>}
            </span>
            <span className="k">Model</span>
            <span>{ai.model}</span>
            <span className="k">Spent (lifetime)</span>
            <span>
              ${ai.spentUsd.toFixed(4)} of ${ai.budgetUsd.toFixed(2)} budget
            </span>
            <span className="k">Calls</span>
            <span>
              {ai.calls} total · {ai.callsToday}/{ai.maxCallsPerDay} today (game day) · {ai.pending} in flight
            </span>
          </div>
          <div className="bar" style={{ margin: "8px 0" }}>
            <div style={{ width: `${pctUsed}%`, background: pctUsed > 85 ? "#e5484d" : "#d4a017" }} />
          </div>
          <div className="god-row">
            <button className="btn" disabled={!ai.available} onClick={() => store.send({ type: "ai", mode: ai.mode === "llm" ? "off" : "llm" })}>
              {ai.mode === "llm" ? "⏸ Pause Claude (utility AI only)" : "▶ Use Claude"}
            </button>
          </div>
          <div className="god-row">
            <input placeholder={`Budget $ (now ${ai.budgetUsd})`} value={budget} onChange={(e) => setBudget(e.target.value)} />
            <button
              className="btn"
              onClick={() => {
                const v = Number(budget);
                if (Number.isFinite(v) && v >= 0) store.send({ type: "ai", budgetUsd: v });
                setBudget("");
              }}
            >
              Set budget
            </button>
          </div>
          <div className="god-row">
            <input placeholder={`Max calls per game day (now ${ai.maxCallsPerDay})`} value={perDay} onChange={(e) => setPerDay(e.target.value)} />
            <button
              className="btn"
              onClick={() => {
                const v = Number(perDay);
                if (Number.isFinite(v) && v >= 0) store.send({ type: "ai", maxCallsPerDay: v });
                setPerDay("");
              }}
            >
              Set limit
            </button>
          </div>
          <p className="muted" style={{ fontSize: 11 }}>
            The budget is a hard cap on lifetime spend (tracked in the database, data/hustle.db). When it's reached, citizens simply carry on with the
            utility AI.
          </p>
        </div>
        )}
        <div className="box">
          <h3>{aiName(ai)} log</h3>
          {!dash?.aiLog?.length && <div className="empty">No AI calls yet.</div>}
          <div className="list">
            {dash?.aiLog?.map((l) => (
              <details key={l.id} className="item">
                <summary style={{ cursor: "pointer" }}>
                  <span className={`chip ${l.status === "ok" ? "good" : l.status === "error" ? "bad" : ""}`}>{l.status}</span> {l.kind === "plan" ? "next move" : l.kind} · {l.citizenName} · {when(l.t)}
                  {ai.free ? "" : ` · $${l.costUsd.toFixed(4)}`} · {(l.ms / 1000).toFixed(1)}s
                  <div className="meta">{l.note}</div>
                </summary>
                <div className="section">Prompt</div>
                <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, margin: 0 }}>{l.prompt}</pre>
                <div className="section">Reply</div>
                <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, margin: 0 }}>{l.response}</pre>
              </details>
            ))}
          </div>
        </div>
        <div className="box">
          <h3>Recent conversations</h3>
          {!dash?.conversations?.length && <div className="empty">No notable conversations yet.</div>}
          <div className="list">
            {dash?.conversations?.map((c) => (
              <Transcript key={c.id} c={c} />
            ))}
          </div>
        </div>
      </div>
    </Shell>
  );
}

/** The free AI: what it does, whether it can connect, and the player's own endpoint. */
function FreeAIBox({ ai }: { ai: AIStatusDTO }) {
  const on = ai.available && ai.mode === "llm";
  const conn = ai.connection;
  const [url, setUrl] = useState(ai.endpoint?.url ?? "");
  const [model, setModel] = useState(ai.endpoint?.model ?? "");
  const [key, setKey] = useState("");
  const STATE: Record<string, [string, string]> = {
    ok: ["good", "connected"],
    busy: ["", "busy (rate limited)"],
    unreachable: ["bad", "can't connect"],
    error: ["bad", "error"],
    untried: ["", "not tried yet"],
  };
  return (
    <div className="box">
      <h3>Who's thinking and talking</h3>
      <p style={{ marginTop: 0 }}>
        Citizens run on the built-in <b>utility AI</b> (needs, money, personality, memories, relationships). On top of that a <b>free public AI</b>{" "}
        (no account, no key, no cost) writes their <b>conversations</b>, their <b>thoughts</b> (whoever you're looking at first) and their{" "}
        <b>tough decisions</b>, from who they are, how they feel, what they've heard and what they remember.
      </p>
      <p>
        The town still decides what happens (who lends what, what news gets passed on), so the AI can't break the economy. Free services are slow
        and rate limited: whatever they can't get to (or anything during a skip) the built-in AI improvises. AI-written lines have a gold border.
      </p>
      {conn?.blocked && (
        <div className="item" style={{ borderColor: "#e5484d", marginBottom: 8 }}>
          <b>This page can't reach the internet.</b> Pages published on claude.ai aren't allowed to call outside services, so here the built-in AI
          does all the thinking and talking. To play with the free AI, download the game file (<code>ai-hustle-city.html</code>) and open it in
          your browser, or run the full version with <code>npm start</code>.
        </div>
      )}
      <div className="kv">
        <span className="k">Status</span>
        <span>
          {!on ? (
            <span className="chip">{ai.available ? "Paused" : "Off"}</span>
          ) : conn?.connected ? (
            <span className="chip good">🌐 Connected · {conn.active}</span>
          ) : conn?.blocked ? (
            <span className="chip bad">No internet here</span>
          ) : (
            <span className="chip">Connecting…</span>
          )}
        </span>
        <span className="k">Calls</span>
        <span>
          {ai.calls} total · {ai.callsToday} today (game day) · {ai.pending} in flight
        </span>
        <span className="k">Cost</span>
        <span>Free</span>
      </div>
      {conn && (
        <div className="list" style={{ margin: "8px 0" }}>
          {conn.providers.map((p) => (
            <div key={p.name} className="item" style={{ padding: "4px 8px" }}>
              <span className={`chip ${STATE[p.state]?.[0] ?? ""}`}>{STATE[p.state]?.[1] ?? p.state}</span> <b>{p.name}</b>
              {p.note && <div className="meta">{p.note}</div>}
            </div>
          ))}
        </div>
      )}
      <div className="god-row">
        <button className="btn" disabled={!ai.available} onClick={() => store.send({ type: "ai", mode: on ? "off" : "llm" })}>
          {on ? "⏸ Built-in AI only (nothing leaves the page)" : "▶ Use the free AI"}
        </button>
        <button className="btn" disabled={!on} onClick={() => store.send({ type: "ai", probe: true })}>
          🔄 Test connection
        </button>
      </div>
      <details>
        <summary style={{ cursor: "pointer" }}>🔌 Use your own free endpoint</summary>
        <p className="muted" style={{ fontSize: 12 }}>
          Any OpenAI-style chat endpoint works (for example a free key from a provider, or a model running on your own computer with Ollama or LM
          Studio: <code>http://localhost:11434/v1/chat/completions</code>). It's tried before the built-in list.
          {" "}The key is kept only in this browser (or on the server, until it restarts).
        </p>
        <div className="god-row">
          <input aria-label="Endpoint URL" placeholder="https://…/v1/chat/completions" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div className="god-row">
          <input aria-label="Model" placeholder="Model (e.g. llama3.2)" value={model} onChange={(e) => setModel(e.target.value)} />
          <input aria-label="Key (optional)" placeholder="Key (optional)" type="password" value={key} onChange={(e) => setKey(e.target.value)} />
        </div>
        <div className="god-row">
          <button className="btn" disabled={!url.trim()} onClick={() => store.send({ type: "ai", endpoint: { url: url.trim(), model: model.trim() || undefined, key: key.trim() || undefined } })}>
            Use it
          </button>
          {ai.endpoint && (
            <button
              className="btn"
              onClick={() => {
                setUrl("");
                setModel("");
                setKey("");
                store.send({ type: "ai", endpoint: null });
              }}
            >
              Forget it
            </button>
          )}
        </div>
      </details>
      <p className="muted" style={{ fontSize: 11 }}>
        Services tried in turn: Pollinations, LLM7, Pollinations (simple). What's sent: the made-up townsfolk's names, personalities, feelings,
        memories and town news. Running the server with AI_PROVIDER=claude and an API key uses Claude instead.
      </p>
    </div>
  );
}

const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

/** The town's brain: an open-source model running on the player's computer. */
export function BrainBox({ ai }: { ai: AIStatusDTO }) {
  const b = ai.brain!;
  const on = ai.mode === "llm";
  const pct = b.total ? Math.min(100, Math.round((b.loaded / b.total) * 100)) : 0;
  const busy = b.state === "loading" || b.state === "ready";
  return (
    <div className="box">
      <h3>The town's brain</h3>
      <p style={{ marginTop: 0 }}>
        A free, open-source AI that runs <b>here, on your computer</b>: on your graphics card if your browser has WebGPU, otherwise on your
        processor. Nothing is sent anywhere and nothing costs anything. Once it's awake, every citizen is an AI agent run by it, all the time: each
        morning it writes their <b>plan for the day</b>, it <b>chooses what they do next</b> (including going to see a friend), decides their{" "}
        <b>tough calls</b> (jobs, money, businesses), writes what they <b>say</b> and <b>think</b>, and each night their <b>diary</b>, which it reads
        back the next day. All from who they are, how they feel, what they've heard and what they remember. Whoever you're looking at comes first.
      </p>
      <p>
        The town keeps the rules: it only offers choices a person can actually make, and it settles who lends what and what news gets passed on, so
        the brain can't break the economy. Whoever it can't get to (and everyone during a skip) is looked after by the built-in AI. Its lines have a
        gold border, and its decisions are marked 🧠 in each person's panel.
      </p>
      <ThreeFiles b={b} />
      <div className="kv">
        <span className="k">Status</span>
        <span>
          {b.state === "ready" ? (
            <span className="chip good">🧠 Awake · {b.device === "webgpu" ? "graphics card" : "processor"}</span>
          ) : b.state === "loading" ? (
            <span className="chip">{b.stage === "compile" ? "Starting up…" : `Downloading ${pct}%`}</span>
          ) : b.state === "error" ? (
            <span className="chip bad">Couldn't start</span>
          ) : b.needsModel ? (
            <span className="chip bad">Needs a model</span>
          ) : (
            <span className="chip">Asleep</span>
          )}
        </span>
        {b.name && busy && (
          <>
            <span className="k">Model</span>
            <span>
              {b.name}{" "}
              {b.from === "page" ? "(comes with this page)" : b.from === "huggingface" ? "(downloading from Hugging Face)" : b.from === "file" ? "(your model file)" : ""}
            </span>
          </>
        )}
        {b.stored && (
          <>
            <span className="k">Kept here</span>
            <span>
              {b.stored} <span className="muted">(in this browser, so it wakes by itself)</span>
            </span>
          </>
        )}
        {b.state === "loading" && b.stage === "download" && b.total > 0 && (
          <>
            <span className="k">Download</span>
            <span>
              {mb(b.loaded)} of {mb(b.total)}
            </span>
          </>
        )}
        {b.state === "ready" && ai.doing && (
          <>
            <span className="k">Right now</span>
            <span>{ai.doing}</span>
          </>
        )}
        {b.state === "ready" && ai.done && (
          <>
            <span className="k">So far</span>
            <span>
              {ai.done.dayplan} day plans ({ai.done.followed} things done from them) · {ai.done.plan} other choices · {ai.done.conversation} conversations ·{" "}
              {ai.done.thought} thoughts · {ai.done.diary} diary entries
            </span>
          </>
        )}
        {b.state === "ready" && (
          <>
            <span className="k">Speed</span>
            <span>
              {b.speed ? `${b.speed.toFixed(0)} words-ish a second` : "warming up"} · {b.replies} replies so far
            </span>
          </>
        )}
        <span className="k">Cost</span>
        <span>Free, and private</span>
      </div>
      {b.state === "loading" && (
        <div className="bar" style={{ margin: "8px 0" }}>
          <div style={{ width: `${b.stage === "compile" ? 100 : pct}%`, background: "#d4a017" }} />
        </div>
      )}
      {b.state === "error" && (
        <div className="item" style={{ borderColor: "#e5484d", margin: "8px 0" }}>
          {b.error}
        </div>
      )}
      <div className="god-row">
        {busy ? (
          <button className="btn" onClick={() => store.send({ type: "ai", brain: "unload" })}>
            😴 Let it sleep (built-in AI only)
          </button>
        ) : (
          !b.needsModel &&
          b.engine && (
            <button className="btn unscripted" onClick={() => store.send({ type: "ai", brain: "load" })}>
              🧠 Wake the town's brain
            </button>
          )
        )}
        {b.state === "ready" && (
          <button className="btn" onClick={() => store.send({ type: "ai", mode: on ? "off" : "llm" })}>
            {on ? "⏸ Pause it" : "▶ Use it"}
          </button>
        )}
      </div>
      {b.engine && <ModelChooser b={b} open={b.needsModel || (!b.stored && b.state !== "ready" && b.state !== "loading")} />}
      <p className="muted" style={{ fontSize: 11 }}>
        Calls so far: {ai.calls} · {ai.pending} in progress. A graphics card makes it much quicker; on a processor each reply takes a few seconds.
      </p>
    </div>
  );
}

type Brain = NonNullable<AIStatusDTO["brain"]>;

/** The game in three parts, and which of them are here. */
function ThreeFiles({ b }: { b: Brain }) {
  const model = b.state === "ready" || b.stored ? "✅" : "➖";
  const modelText =
    b.state === "ready" ? `the model (${b.name})` : b.stored ? `the model (${b.stored}, kept in this browser)` : "the model: choose one below (downloaded free, once) or load yours";
  if (b.engine && !b.engineFile)
    return (
      <div className="item" style={{ margin: "8px 0" }}>
        This is the <b>single-file</b> game: the town and the AI engine are both in this page. The model is the one other file:
        <div className="kv" style={{ marginTop: 4 }}>
          <span className="k">{model} hustle-model.bin</span>
          <span>{modelText}</span>
        </div>
      </div>
    );
  return (
    <div className="item" style={{ margin: "8px 0" }}>
      <b>The game comes in three files</b>, kept together in one folder:
      <div className="kv" style={{ marginTop: 4 }}>
        <span className="k">✅ ai-hustle-city.html</span>
        <span>the town (this page)</span>
        <span className="k">{b.engine ? "✅" : "❌"} hustle-brain.js</span>
        <span>{b.engine ? "the AI engine (here)" : "the AI engine: not found next to the page, so the brain can't run. Put it back in the same folder and reload."}</span>
        <span className="k">{model} hustle-model.bin</span>
        <span>{modelText}</span>
      </div>
    </div>
  );
}

/** Pick a model to download (once), or load a model file from disk. */
function ModelChooser({ b, open }: { b: Brain; open: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const busy = b.state === "loading";
  return (
    <details open={open} style={{ margin: "8px 0" }}>
      <summary style={{ cursor: "pointer" }}>{b.stored || b.state === "ready" ? "Change the model" : "Choose the model"}</summary>
      <p className="muted" style={{ fontSize: 12 }}>
        Bigger models write smarter, livelier conversations and plans, but take longer to download and need more of your computer. The download comes
        straight from Hugging Face (free, Apache 2.0 licence); the game then saves it as <b>hustle-model.bin</b> in your downloads and keeps it in
        this browser. Put that file next to the other two, and next time (or on another computer) just load it.
      </p>
      {MODEL_CHOICES.map((m) => (
        <div key={m.id} className="item" style={{ display: "flex", gap: 8, alignItems: "center", margin: "6px 0" }}>
          <div style={{ flex: 1 }}>
            <b>{m.name}</b> <span className="muted">· about {m.mb >= 1000 ? `${(m.mb / 1000).toFixed(1)} GB` : `${m.mb} MB`}</span>
            <div className="muted" style={{ fontSize: 12 }}>
              {m.note}
            </div>
          </div>
          <button className="btn" disabled={busy} onClick={() => store.send({ type: "ai", brain: "get", model: m.id })}>
            ⬇ Get it
          </button>
        </div>
      ))}
      <div className="god-row">
        <button className="btn unscripted" disabled={busy} onClick={() => input.current?.click()}>
          📂 Load hustle-model.bin
        </button>
        {b.stored && (
          <button className="btn" disabled={busy} onClick={() => store.send({ type: "ai", brain: "forget" })}>
            🗑 Forget the kept copy
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept=".bin"
          aria-label="Model file"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) store.brainFile(f);
            e.target.value = "";
          }}
        />
      </div>
    </details>
  );
}
