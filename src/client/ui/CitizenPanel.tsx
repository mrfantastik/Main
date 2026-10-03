import { useState } from "react";
import type { CitizenDetail } from "../../shared/protocol";
import type { DecisionRecord } from "../../sim/types";
import { renderer } from "../App";
import { store, useStore } from "../net/store";
import { Avatar } from "./CitizenList";
import { EMOTION_UI, gbp, KIND_LABEL, OCC_COLORS, OCC_LABEL, VALUE_LABEL, when } from "./format";
import { Sparkline } from "./charts";
import { Transcript } from "./Transcript";

function Bar({ label, value, max = 100, color }: { label: string; value: number; max?: number; color: string }) {
  return (
    <div className="barrow">
      <span>{label}</span>
      <div className="bar">
        <div style={{ width: `${Math.max(0, Math.min(100, (value / max) * 100))}%`, background: color }} />
      </div>
      <span className="n">{Math.round(value)}</span>
    </div>
  );
}

/** How they feel right now: ten bars, the standout feeling highlighted. */
function Feelings({ d }: { d: CitizenDetail }) {
  return (
    <div className="feelings">
      {EMOTION_UI.map((e) => (
        <div key={e.key} className={`barrow ${d.emotion?.kind === e.key ? "standout" : ""}`} title={`${e.label} ${d.emotions[e.key]}/100`}>
          <span>
            {e.emoji} {e.label}
          </span>
          <div className="bar">
            <div style={{ width: `${d.emotions[e.key]}%`, background: e.color }} />
          </div>
          <span className="n">{d.emotions[e.key]}</span>
        </div>
      ))}
    </div>
  );
}

function Who({ d }: { d: CitizenDetail }) {
  const p = d.personality;
  return (
    <>
      <p className="backstory">{p.backstory}</p>
      <div className="muted" style={{ marginBottom: 6 }}>
        {p.summary}
      </div>
      <div className="tags" style={{ marginBottom: 6 }}>
        {p.values.map((v) => (
          <span key={v} className="chip">
            {VALUE_LABEL[v] ?? v}
          </span>
        ))}
        <span className="chip">🗣️ {p.style}</span>
        {d.archetypes.map((a) => (
          <span key={a} className="chip">
            {a}
          </span>
        ))}
      </div>
      <div className="kv">
        <span className="k">Quirks</span>
        <span>{p.quirks.join("; ") || "—"}</span>
        <span className="k">Likes</span>
        <span>{p.likes.join(", ") || "—"}</span>
        <span className="k">Dislikes</span>
        <span>{p.dislikes.join(", ") || "—"}</span>
        <span className="k">Afraid of</span>
        <span>{p.fear}</span>
        <span className="k">Dreams of</span>
        <span>{p.dream}</span>
      </div>
      <Bar label="Openness" value={p.big5.openness * 100} color="#a46cf5" />
      <Bar label="Conscientious" value={p.big5.conscientiousness * 100} color="#4f8ef7" />
      <Bar label="Extraversion" value={p.big5.extraversion * 100} color="#d65db1" />
      <Bar label="Agreeable" value={p.big5.agreeableness * 100} color="#2fbf71" />
      <Bar label="Neuroticism" value={p.big5.neuroticism * 100} color="#e5484d" />
    </>
  );
}

function Decision({ d }: { d: DecisionRecord }) {
  return (
    <details className="item decision">
      <summary>
        <div className="meta">
          {when(d.t)} · {d.kind} · {d.source === "llm" ? <span style={{ color: "var(--llm)" }}>🧠 Claude</span> : d.source === "llm-rejected" ? "Claude (rejected → fallback)" : "utility AI"}
        </div>
        <div>
          ➜ <b>{d.options.find((o) => o.id === d.chosen)?.label ?? d.chosen}</b>
        </div>
        <div className="muted" style={{ fontStyle: "italic" }}>
          “{d.thought}”
        </div>
      </summary>
      <table>
        <tbody>
          {d.options.map((o) => (
            <tr key={o.id} className={o.id === d.chosen ? "chosen" : ""}>
              <td style={{ width: "48%" }}>{o.label}</td>
              <td className="num">{o.score.toFixed(2)}</td>
              <td className="factors">
                {Object.entries(o.factors)
                  .filter(([, v]) => Math.abs(v) >= 0.05)
                  .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
                  .slice(0, 4)
                  .map(([k, v]) => (
                    <span key={k} className={v >= 0 ? "pos" : "neg"}>
                      {k} {v >= 0 ? "+" : ""}
                      {v.toFixed(2)}{" "}
                    </span>
                  ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function Overview({ d }: { d: CitizenDetail }) {
  return (
    <>
      <div className="section">💭 What is {d.name} thinking?</div>
      <div className={`thought ${d.thoughtSource === "llm" ? "llm" : ""}`}>
        {d.thought}
        <span className="src">{d.thoughtSource === "llm" ? "🧠 Reasoned by Claude" : "⚙️ From the utility AI's current decision"}</span>
      </div>
      <div className="section">
        How {d.name} feels{d.emotion ? ` — mostly ${EMOTION_UI.find((e) => e.key === d.emotion!.kind)?.label.toLowerCase()} ${d.emotion.emoji}` : " — calm"}
      </div>
      <Feelings d={d} />
      <div className="section">Goal & activity</div>
      <div className="kv">
        <span className="k">Goal</span>
        <span>🎯 {d.goal.label}</span>
        <span className="k">Doing</span>
        <span>{d.activity}</span>
        <span className="k">Location</span>
        <span>{d.location}</span>
        <span className="k">Home</span>
        <span>{d.homeless ? "🏚️ Homeless (sleeps in the park)" : d.home}</span>
      </div>
      <div className="section">Money</div>
      <div className="cards">
        <div className="card">
          <div className="k">Cash</div>
          <div className="v">{gbp(d.money)}</div>
        </div>
        <div className="card">
          <div className="k">Savings (bank)</div>
          <div className="v">{gbp(d.savings)}</div>
        </div>
        <div className="card">
          <div className="k">Net worth</div>
          <div className="v">{gbp(d.netWorth)}</div>
        </div>
        <div className="card">
          <div className="k">Debts</div>
          <div className={`v ${d.debts > 0 ? "neg" : ""}`}>{gbp(d.debts)}</div>
        </div>
        <div className="card">
          <div className="k">Income today / avg</div>
          <div className="v pos">
            {gbp(d.incomeToday)} <span className="muted" style={{ fontSize: 11 }}>/ {gbp(d.avgIncome)}</span>
          </div>
        </div>
        <div className="card">
          <div className="k">Expenses today / avg</div>
          <div className="v neg">
            {gbp(d.expensesToday)} <span className="muted" style={{ fontSize: 11 }}>/ {gbp(d.avgExpenses)}</span>
          </div>
        </div>
      </div>
      {d.financeHistory.length > 1 && (
        <>
          <div className="muted" style={{ fontSize: 11 }}>
            Net worth, last {d.financeHistory.length} days
          </div>
          <Sparkline values={d.financeHistory.map((h) => h.netWorth)} height={38} format={(v) => gbp(v)} unit=" days" />
        </>
      )}
      <div className="section">Who they are</div>
      <Who d={d} />
      <div className="section">Money habits</div>
      <Bar label="Ambition" value={d.traits.ambition * 100} color="#f2c94c" />
      <Bar label="Risk-taking" value={d.traits.risk * 100} color="#e5484d" />
      <Bar label="Diligence" value={d.traits.diligence * 100} color="#4f8ef7" />
      <Bar label="Sociability" value={d.traits.sociability * 100} color="#d65db1" />
      <Bar label="Generosity" value={d.traits.generosity * 100} color="#2fbf71" />
      <Bar label="Greed" value={d.traits.greed * 100} color="#f59e2c" />
      <Bar label="Competitive" value={d.traits.competitiveness * 100} color="#ff6f91" />
      <Bar label="Entrepreneur" value={d.traits.entrepreneurship * 100} color="#a46cf5" />
      <Bar label="Frugality" value={d.traits.frugality * 100} color="#22c3d6" />
      <div className="section">Skills</div>
      {Object.entries(d.skills).map(([k, v]) => (
        <Bar key={k} label={k[0].toUpperCase() + k.slice(1)} value={v} color="#8fb4ee" />
      ))}
      <div className="section">Needs & mood</div>
      <Bar label="Energy" value={d.needs.energy} color="#f2c94c" />
      <Bar label="Fullness" value={d.needs.hunger} color="#2fbf71" />
      <Bar label="Social" value={d.needs.social} color="#d65db1" />
      <Bar label="Fun" value={d.needs.fun} color="#22c3d6" />
      <Bar label="Mood" value={d.mood} color="#ff8066" />
      <div className="section">Inventory</div>
      {d.inventory.length === 0 ? (
        <div className="empty">Nothing in their bag.</div>
      ) : (
        <div className="tags">
          {d.inventory.map((i) => (
            <span key={i.id} className="chip" title={`avg cost ${gbp(i.avgCost)}`}>
              {i.emoji} {i.name} ×{i.qty}
            </span>
          ))}
        </div>
      )}
      <div className="section">Business</div>
      {d.businesses.length === 0 ? (
        <div className="empty">Doesn't own a business.</div>
      ) : (
        <div className="list">
          {d.businesses.map((b) => (
            <div key={b.id} className="item clickable" onClick={() => store.select({ kind: "business", id: b.id })}>
              <b>{b.name}</b> <span className="chip">{KIND_LABEL[b.kind]}</span> {!b.open && <span className="chip bad">closed</span>}
              <div className="meta">
                cash {gbp(b.cash)} · avg profit {gbp(b.avgProfit)}/day · {b.employees} staff
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Mind({ d }: { d: CitizenDetail }) {
  return (
    <>
      <div className="section">Current thought</div>
      <div className={`thought ${d.thoughtSource === "llm" ? "llm" : ""}`}>{d.thought}</div>
      <div className="section">Key insights (lessons from sleeping on it)</div>
      {d.lessons.length === 0 ? (
        <div className="empty">Nothing learned yet. They reflect on the day while they sleep.</div>
      ) : (
        <div className="list">
          {d.lessons.map((r) => (
            <div key={r.id} className="item" style={{ opacity: 0.45 + r.strength * 0.55 }}>
              {r.valence >= 0 ? "💡" : "⚠️"} {r.text} {r.source === "llm" && <span className="chip llm">Claude</span>}
              <div className="meta">
                {when(r.t)} · {r.kind}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="section">Why? — recent decisions</div>
      <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
        Each decision lists the options the agent considered, their scores, and the factors behind them. Click to expand.
      </div>
      <div className="list">
        {d.decisions.length === 0 && <div className="empty">No decisions recorded yet.</div>}
        {d.decisions.map((x, i) => (
          <Decision key={i} d={x} />
        ))}
      </div>
      <div className="section">What they believe each career earns (£/day)</div>
      <div className="kv">
        {d.beliefs
          .sort((a, b) => b.value - a.value)
          .map((b) => (
            <span key={b.occupation} style={{ display: "contents" }}>
              <span className="k">{OCC_LABEL[b.occupation]}</span>
              <span>
                {gbp(b.value)} <span className="muted">({b.source})</span>
              </span>
            </span>
          ))}
      </div>
      {d.insights.length > 0 && (
        <>
          <div className="section">Secret insights</div>
          {d.insights.map((i) => (
            <div key={i} className="item">
              🔮 {i}
            </div>
          ))}
        </>
      )}
      {d.occupation === "researcher" && (
        <>
          <div className="section">Research</div>
          <Bar label="Progress" value={d.research.points} max={d.research.threshold} color="#22c3d6" />
          <div className="muted">
            {d.research.breakthroughs} breakthroughs · patents: {d.research.patents.join(", ") || "none"}
          </div>
        </>
      )}
    </>
  );
}

function Social({ d }: { d: CitizenDetail }) {
  return (
    <>
      <div className="section">Recent conversations</div>
      <div className="list">
        {d.conversations.length === 0 && <div className="empty">Hasn't talked to anyone yet.</div>}
        {d.conversations.map((c) => (
          <Transcript key={c.id} c={c} />
        ))}
      </div>
      <div className="section">Relationships</div>
      <div className="list">
        {d.relationships.length === 0 && <div className="empty">Doesn't really know anyone yet.</div>}
        {d.relationships.map((r) => (
          <div key={r.id} className="item clickable" onClick={() => store.select({ kind: "citizen", id: r.id })}>
            <b>{r.name}</b> <span className="chip">{r.label}</span>
            <div className="barrow" style={{ gridTemplateColumns: "50px 1fr 30px" }}>
              <span className="muted">Affinity</span>
              <div className="bar">
                <div style={{ width: `${(r.affinity + 100) / 2}%`, background: r.affinity >= 0 ? "#2fbf71" : "#e5484d" }} />
              </div>
              <span className="n">{r.affinity}</span>
            </div>
            <div className="barrow" style={{ gridTemplateColumns: "50px 1fr 30px" }}>
              <span className="muted">Trust</span>
              <div className="bar">
                <div style={{ width: `${(r.trust + 100) / 2}%`, background: r.trust >= 0 ? "#4f8ef7" : "#e5484d" }} />
              </div>
              <span className="n">{r.trust}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="section">Memories</div>
      <div className="list">
        {d.memories.length === 0 && <div className="empty">Nothing memorable has happened yet.</div>}
        {d.memories.map((m) => (
          <div key={m.id} className="item" style={{ opacity: 0.45 + m.strength * 0.55 }}>
            {m.long ? "⭐ " : ""}
            {m.text}
            {m.count > 1 && <span className="chip">×{m.count}</span>}
            <div className="meta">
              {when(m.t)} · {m.kind} · importance {m.importance.toFixed(0)}/10 · {m.valence >= 0.2 ? "😊" : m.valence <= -0.2 ? "😠" : "😐"}
              {EMOTION_UI.filter((e) => (m.emotions?.[e.key] ?? 0) >= 4)
                .slice(0, 3)
                .map((e) => (
                  <span key={e.key} title={`${e.label} +${Math.round(m.emotions![e.key]!)}`}>
                    {" "}
                    {e.emoji}
                  </span>
                ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function Money({ d }: { d: CitizenDetail }) {
  return (
    <>
      <div className="kv">
        <span className="k">Credit score</span>
        <span>{d.creditScore}/100</span>
        <span className="k">Wage</span>
        <span>{d.wage ? `${gbp(d.wage)}/day` : "—"}</span>
        <span className="k">Rent arrears</span>
        <span>{gbp(d.rentArrears)}</span>
      </div>
      <div className="section">Loans</div>
      {d.loans.length === 0 ? (
        <div className="empty">No loans.</div>
      ) : (
        <div className="list">
          {d.loans.map((l) => (
            <div key={l.id} className="item">
              {l.lender} → {l.borrower}: <b>{gbp(l.principal)}</b> ({l.purpose})
              <div className="meta">
                repaid {gbp(l.paid)} of {gbp(l.totalDue)} · due {when(l.dueT)} · <b>{l.status}</b>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="section">Daily finances</div>
      {d.financeHistory.length === 0 ? (
        <div className="empty">Day 1 isn't over yet.</div>
      ) : (
        <table className="t">
          <thead>
            <tr>
              <th>Day</th>
              <th className="num">In</th>
              <th className="num">Out</th>
              <th className="num">Net worth</th>
            </tr>
          </thead>
          <tbody>
            {[...d.financeHistory].reverse().slice(0, 10).map((h) => (
              <tr key={h.day}>
                <td>{h.day}</td>
                <td className="num pos">{gbp(h.income)}</td>
                <td className="num neg">{gbp(h.expenses)}</td>
                <td className="num">{gbp(h.netWorth)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="section">Recent transactions</div>
      <div className="list">
        {d.transactions.length === 0 && <div className="empty">No transactions yet.</div>}
        {d.transactions.map((t) => {
          const incoming = t.to === `c:${d.id}`;
          return (
            <div key={t.id} className="item">
              <span className={incoming ? "pos" : "neg"}>
                {incoming ? "+" : "−"}
                {gbp(t.amount)}
              </span>{" "}
              {t.memo}
              <div className="meta">
                {when(t.t)} · {incoming ? `from ${t.fromName}` : `to ${t.toName}`} · {t.kind}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

export function CitizenPanel() {
  const d = useStore((s) => (s.detail?.kind === "citizen" ? s.detail : null));
  const follow = useStore((s) => s.followSelected);
  const summary = useStore((s) => s.state?.citizens.find((c) => c.id === s.selection?.id));
  const [tab, setTab] = useState<"overview" | "mind" | "social" | "money">("overview");
  if (!d) {
    return (
      <div className="side-body">
        <div className="empty">Loading {summary?.name ?? "citizen"}…</div>
      </div>
    );
  }
  return (
    <>
      <div className="side-head" style={{ borderBottom: 0, paddingBottom: 0 }}>
        <div className="insp-head" style={{ marginBottom: 0, width: "100%" }}>
          <Avatar name={d.name} color={d.color} ring={OCC_COLORS[d.occupation]} />
          <div>
            <div className="insp-title">
              {d.name} {d.surname}
            </div>
            <div className="insp-sub">
              {d.age} · <span style={{ color: OCC_COLORS[d.occupation] }}>{OCC_LABEL[d.occupation]}</span>
              {d.employer ? ` at ${d.employer}` : ""}
            </div>
          </div>
          <button className="close" title="Back to list" onClick={() => store.select(null)}>
            ✕
          </button>
        </div>
      </div>
      <div style={{ padding: "0 12px" }}>
        <div className="tabs">
          {(["overview", "mind", "social", "money"] as const).map((t) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {t === "overview" ? "Overview" : t === "mind" ? "🧠 Mind" : t === "social" ? "Social" : "Money"}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            className="btn"
            style={{ flex: 1 }}
            onClick={() => {
              const p = renderer?.positionOf(d.id);
              if (p) renderer?.focusOn(p.x, p.y);
              store.setFollow(!follow);
            }}
          >
            {follow ? "📌 Following" : "🎥 Follow on map"}
          </button>
        </div>
      </div>
      <div className="side-body">
        {tab === "overview" && <Overview d={d} />}
        {tab === "mind" && <Mind d={d} />}
        {tab === "social" && <Social d={d} />}
        {tab === "money" && <Money d={d} />}
      </div>
    </>
  );
}
