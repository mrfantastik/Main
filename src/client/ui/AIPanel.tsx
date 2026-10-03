import { useState } from "react";
import type { AIStatusDTO } from "../../shared/protocol";
import { store, useStore } from "../net/store";
import { when } from "./format";
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
        {ai.free ? <FreeAIBox ai={ai} /> : (
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
          <h3>{ai.free ? "Free AI" : "Claude"} call log</h3>
          {!dash?.aiLog?.length && <div className="empty">No AI calls yet.</div>}
          <div className="list">
            {dash?.aiLog?.map((l) => (
              <details key={l.id} className="item">
                <summary style={{ cursor: "pointer" }}>
                  <span className={`chip ${l.status === "ok" ? "good" : l.status === "error" ? "bad" : ""}`}>{l.status}</span> {l.kind} · {l.citizenName} · {when(l.t)}
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

/** The free AI: what it does, whether it's on, how busy it is. */
function FreeAIBox({ ai }: { ai: AIStatusDTO }) {
  const on = ai.available && ai.mode === "llm";
  return (
    <div className="box">
      <h3>Who's talking</h3>
      <p style={{ marginTop: 0 }}>
        Citizens decide what to do with the built-in <b>utility AI</b> (needs, money, personality, memories, relationships). What they{" "}
        <b>say</b> to each other is written by a <b>free public AI</b>: no account, no key, no cost. Every conversation is written fresh from who
        they are, how they feel, what they've heard and what they remember about each other.
      </p>
      <p>
        The town still decides what happens (who lends what, what news gets passed on), so the AI can't break the economy, only put it in
        their own words. It's a smaller model than Claude and it's rate limited: when it can't keep up (or you skip time), the built-in AI
        improvises the rest. Conversations it wrote have a gold border.
      </p>
      <div className="kv">
        <span className="k">Status</span>
        <span>
          {on ? <span className="chip llm">🌐 ON</span> : ai.available ? <span className="chip">Paused</span> : <span className="chip bad">Off</span>}{" "}
          <span className="muted">{ai.writer ?? ai.reason}</span>
        </span>
        <span className="k">Model</span>
        <span>{ai.model}</span>
        <span className="k">Calls</span>
        <span>
          {ai.calls} total · {ai.callsToday} today (game day) · {ai.pending} in flight
        </span>
        <span className="k">Cost</span>
        <span>Free</span>
      </div>
      <div className="god-row">
        <button className="btn" disabled={!ai.available} onClick={() => store.send({ type: "ai", mode: on ? "off" : "llm" })}>
          {on ? "⏸ Built-in AI only (nothing leaves the page)" : "▶ Let the free AI write conversations"}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 11 }}>
        Conversations are sent to text.pollinations.ai (names and details of the made-up townsfolk only). Running the server with
        AI_PROVIDER=claude and an API key uses Claude instead.
      </p>
    </div>
  );
}
