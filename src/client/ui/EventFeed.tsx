import { useState } from "react";
import type { SimEvent } from "../../sim/types";
import { store, useStore } from "../net/store";
import { aiName, when } from "./format";
import { Transcript } from "./Transcript";

const FILTERS: { id: string; label: string; cats: string[] }[] = [
  { id: "all", label: "All", cats: [] },
  { id: "business", label: "🏪 Business", cats: ["business"] },
  { id: "job", label: "💼 Jobs", cats: ["job"] },
  { id: "money", label: "💷 Money", cats: ["finance"] },
  { id: "social", label: "💬 Social", cats: ["social", "conversation"] },
  { id: "market", label: "📈 Market", cats: ["market"] },
  { id: "town", label: "🗞️ Town", cats: ["town"] },
  { id: "life", label: "🏠 Life", cats: ["life"] },
  { id: "god", label: "⚡ God/AI", cats: ["god", "ai"] },
];

function EventText({ ev }: { ev: SimEvent }) {
  const citizens = useStore((s) => s.state?.citizens ?? []);
  if (ev.citizens.length === 0) return <>{ev.text}</>;
  // Make citizen names clickable.
  const names = ev.citizens.map((id) => citizens.find((c) => c.id === id)).filter(Boolean) as { id: string; name: string }[];
  const parts: (string | { id: string; name: string })[] = [ev.text];
  for (const n of names) {
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (typeof p !== "string") continue;
      const idx = p.indexOf(n.name);
      if (idx < 0) continue;
      parts.splice(i, 1, p.slice(0, idx), n, p.slice(idx + n.name.length));
      break;
    }
  }
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          <span key={i}>{p}</span>
        ) : (
          <span key={i} className="who" onClick={() => store.select({ kind: "citizen", id: p.id })}>
            {p.name}
          </span>
        ),
      )}
    </>
  );
}

function ConversationToggle({ id }: { id: number }) {
  const ai = useStore((s) => s.state?.ai);
  const conv = store.conversations.get(id);
  const [open, setOpen] = useState(false);
  if (!conv) return null;
  return (
    <div>
      <button className="chip" style={{ border: 0, marginTop: 3 }} onClick={() => setOpen(!open)}>
        {open ? "Hide" : "💬 Read"} conversation{conv.source === "llm" ? ` · ${ai?.free && !ai.brain ? "🌐" : "🧠"} ${aiName(ai)}` : ""}
      </button>
      {open && <Transcript c={conv} />}
    </div>
  );
}

export function EventFeed() {
  const events = useStore((s) => s.events);
  const [filter, setFilter] = useState("all");
  const [minImp, setMinImp] = useState(1);
  const f = FILTERS.find((x) => x.id === filter)!;
  const shown = events.filter((e) => (f.cats.length === 0 || f.cats.includes(e.cat)) && e.importance >= minImp).slice(-150).reverse();
  return (
    <>
      <div className="side-head">
        📰 Live events
        <label className="muted" style={{ marginLeft: "auto", fontSize: 11, fontWeight: 500, display: "flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" checked={minImp > 1} onChange={(e) => setMinImp(e.target.checked ? 3 : 1)} /> big news only
        </label>
      </div>
      <div className="filters">
        {FILTERS.map((x) => (
          <button key={x.id} className={filter === x.id ? "on" : ""} onClick={() => setFilter(x.id)}>
            {x.label}
          </button>
        ))}
      </div>
      <div className="side-body">
        <div className="feed">
          {shown.length === 0 && <div className="empty">Nothing yet — the city is waking up…</div>}
          {shown.map((e) => (
            <div key={e.id} className={`ev ${e.cat} i${e.importance}`}>
              <div className="time">{when(e.t)}</div>
              <div>
                <EventText ev={e} />
                {e.conversationId !== undefined && <ConversationToggle id={e.conversationId} />}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
