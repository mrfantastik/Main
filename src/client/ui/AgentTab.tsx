import { useState } from "react";
import type { CitizenDetail } from "../../shared/protocol";
import { store } from "../net/store";
import { when } from "./format";

// The agent inspector: what this person wants, what they're planning, what
// they decided (and whether the AI or the built-in judgement decided it),
// what came of it, and what they believe about other people.

/** Who came up with it: the AI, or the built-in judgement. */
export function Source({ by }: { by: "llm" | "rules" | "built-in" }) {
  return by === "llm" ? (
    <span className="chip llm" title="Proposed by the AI (a language model), then checked by the town">
      🧠 AI
    </span>
  ) : (
    <span className="chip" title="The built-in judgement (rules and scores), no language model">
      ⚙️ rules
    </span>
  );
}

const STATUS: Record<string, string> = { pending: "⏳ waiting", done: "✓ done", rejected: "✗ not allowed", failed: "✗ didn't work", expired: "⌛ never happened", active: "in progress", achieved: "✓ achieved", dropped: "dropped", abandoned: "abandoned" };
const STATUS_CLASS: Record<string, string> = { done: "good", achieved: "good", rejected: "bad", failed: "bad", expired: "", pending: "" };

export function AgentTab({ d }: { d: CitizenDetail }) {
  const a = d.society;
  const [debug, setDebug] = useState(false);
  const [all, setAll] = useState(false);
  const decisions = all ? a.decisions : a.decisions.filter((x) => x.type !== "carry_on").slice(0, 12);
  return (
    <>
      <div className="box">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <b>Decides by:</b> <Source by={a.decider} />
          <span className="muted" style={{ fontSize: 11 }}>
            {a.onRoster ? (a.decider === "llm" ? "On the AI roster: the AI proposes what they do; the town checks it." : "On the AI roster, but no AI is connected right now: the built-in judgement decides.") : "Not on the AI roster: the built-in judgement decides."}
          </span>
          <button className="btn" style={{ marginLeft: "auto" }} onClick={() => store.send({ type: "agents", id: d.id, on: !a.onRoster })}>
            {a.onRoster ? "Take off the AI roster" : "Put on the AI roster"}
          </button>
        </div>
        {a.intention && (
          <div style={{ marginTop: 6 }}>
            <b>Meaning to:</b> {a.intention.text} <Source by={a.intention.source} /> <span className="muted">{when(a.intention.t)}</span>
          </div>
        )}
        {a.intents.length > 0 && (
          <div className="muted" style={{ marginTop: 4 }}>
            Waiting for the chance: {a.intents.map((i) => `${i.what} with ${i.who}`).join(" · ")}
          </div>
        )}
      </div>

      <div className="section">What they want</div>
      {a.goals.length === 0 && <div className="empty">Nothing in particular.</div>}
      {a.goals.map((g, i) => (
        <div key={i} className="item" style={{ opacity: g.status === "active" ? 1 : 0.6 }}>
          <b>{g.text}</b> <span className={`chip ${STATUS_CLASS[g.status] ?? ""}`}>{STATUS[g.status] ?? g.status}</span> <Source by={g.source} />
          <div className="meta">
            {g.why} · matters {Math.round(g.priority * 100)}%
          </div>
        </div>
      ))}

      <div className="section">Plans (they take days)</div>
      {a.projects.length === 0 && <div className="empty">No plans on the go.</div>}
      {a.projects.map((p, i) => (
        <details key={i} className="item" open={p.status === "active" && i === 0}>
          <summary style={{ cursor: "pointer" }}>
            <b>{p.title}</b> <span className={`chip ${p.status === "done" ? "good" : p.status === "failed" ? "bad" : ""}`}>{STATUS[p.status] ?? p.status}</span> <Source by={p.source} />
            {p.need > 0 && (
              <span className="muted">
                {" "}
                · £{p.raised} of £{p.need} promised
              </span>
            )}
          </summary>
          {p.partners.length > 0 && <div className="meta">In with them: {p.partners.join(", ")}</div>}
          {p.refused.length > 0 && <div className="meta">Said no: {p.refused.join(", ")}</div>}
          {p.next && <div className="meta">Next step: {p.next}</div>}
          {p.log.map((l, j) => (
            <div key={j} className="meta" style={{ color: l.good ? undefined : "var(--bad, #e5484d)" }}>
              {when(l.t)} · {l.text}
            </div>
          ))}
        </details>
      ))}

      <div className="section" style={{ display: "flex", alignItems: "center" }}>
        <span>Decisions and what came of them</span>
        <label className="muted" style={{ marginLeft: "auto", fontSize: 11 }}>
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> include "carried on"
        </label>
      </div>
      {decisions.length === 0 && <div className="empty">No decisions yet.</div>}
      {decisions.map((x) => (
        <details key={x.id} className="item">
          <summary style={{ cursor: "pointer" }}>
            <Source by={x.source} /> {x.label} <span className={`chip ${STATUS_CLASS[x.status] ?? ""}`}>{STATUS[x.status] ?? x.status}</span> <span className="muted">{when(x.t)}</span>
            {x.result && <div className="meta">➜ {x.result}</div>}
          </summary>
          {x.error && <div className="meta">The town said no: {x.error}</div>}
          {x.why && <div className="meta">Why: {x.why}</div>}
        </details>
      ))}

      {a.days.length > 0 && (
        <>
          <div className="section">Their days</div>
          {a.days.map((x) => (
            <div key={x.day} className="item">
              <b>Day {x.day}</b> <span className="meta">{x.text}</span>
            </div>
          ))}
        </>
      )}

      <div className="section">What the town thinks of them</div>
      <div className="item">
        Standing {a.reputation.standing > 0 ? "+" : ""}
        {a.reputation.standing} · trust {a.reputation.trust} · known by {a.reputation.knownBy}
        {a.reputation.tags.length > 0 && (
          <div className="tags" style={{ marginTop: 4 }}>
            {a.reputation.tags.map((t) => (
              <span key={t} className="chip">
                {t}
              </span>
            ))}
          </div>
        )}
        {a.allies.length > 0 && <div className="meta">On their side: {a.allies.map((x) => `${x.ally} (against ${x.against})`).join(", ")}</div>}
        {a.crush && <div className="meta">Has a soft spot for {a.crush}.</div>}
      </div>

      <div className="section" style={{ display: "flex", alignItems: "center" }}>
        <span>What they believe about people</span>
        <label className="muted" style={{ marginLeft: "auto", fontSize: 11 }} title="Show whether stories going round are actually true (they don't know)">
          <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} /> show the truth
        </label>
      </div>
      {a.beliefs.length === 0 && <div className="empty">Nothing much yet.</div>}
      {a.beliefs.map((b, i) => (
        <div key={i} className="item">
          {b.text}
          <div className="meta">
            {b.source === "told" ? `${b.from ?? "someone"} told them` : b.source === "rumour" ? `a rumour${b.from ? ` (from ${b.from})` : ""}` : b.source === "saw" ? "saw it" : b.source === "work" ? "heard at work" : b.source} · {Math.round(b.certainty * 100)}% sure
            {debug && b.rumour && (
              <>
                {" "}
                · <span className={`chip ${b.rumour.truth === false ? "bad" : b.rumour.truth ? "good" : ""}`}>{b.rumour.truth === false ? `made up by ${b.rumour.origin}` : b.rumour.truth ? "true" : "nobody knows"}</span>
              </>
            )}
          </div>
        </div>
      ))}
    </>
  );
}
