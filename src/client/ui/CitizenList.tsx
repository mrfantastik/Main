import { store, useStore } from "../net/store";
import { gbp, OCC_COLORS, OCC_LABEL } from "./format";

export function Avatar({ name, color, ring }: { name: string; color: string; ring: string }) {
  return (
    <div className="avatar" style={{ background: color, borderColor: ring }}>
      {name.slice(0, 2)}
    </div>
  );
}

export function CitizenList() {
  const citizens = useStore((s) => s.state?.citizens ?? []);
  const sorted = [...citizens].sort((a, b) => b.netWorth - a.netWorth);
  return (
    <>
      <div className="side-head">
        👥 Citizens <span className="chip">{citizens.length}</span>
        <span className="muted" style={{ marginLeft: "auto", fontWeight: 500, fontSize: 11 }}>
          sorted by net worth
        </span>
      </div>
      <div className="side-body">
        <div className="clist">
          {sorted.map((c) => (
            <button key={c.id} className="crow" onClick={() => store.select({ kind: "citizen", id: c.id })}>
              <Avatar name={c.name} color={c.color} ring={OCC_COLORS[c.occupation]} />
              <div style={{ minWidth: 0 }}>
                <div className="name">
                  {c.name} {c.homeless && <span title="Homeless">🏚️</span>}
                  {c.awaitingAI && <span title="Thinking with Claude">🧠</span>}
                </div>
                <div className="sub">
                  <span style={{ color: OCC_COLORS[c.occupation] }}>{OCC_LABEL[c.occupation]}</span> · {c.activity}
                </div>
                <div className="sub">💭 {c.thought}</div>
              </div>
              <div className={`worth ${c.netWorth < 0 ? "neg" : ""}`}>{gbp(c.netWorth)}</div>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
