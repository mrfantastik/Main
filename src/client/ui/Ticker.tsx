import { useStore } from "../net/store";
import { gbp } from "./format";

export function Ticker() {
  const st = useStore((s) => s.state);
  if (!st) return <footer className="ticker">Waiting for the city…</footer>;
  const s = st.stats;
  return (
    <footer className="ticker">
      {s && (
        <>
          <span>
            Money in economy <b>{gbp(s.totalMoney)}</b>
          </span>
          <span>
            Avg wealth <b>{gbp(s.avgWealth)}</b>
          </span>
          <span>
            Unemployment <b>{Math.round(s.unemployment * 100)}%</b>
          </span>
          <span>
            Businesses <b>{s.businesses}</b>
          </span>
          <span>
            Transactions <b>{st.txCount.toLocaleString()}</b>
          </span>
        </>
      )}
      <span style={{ color: "#3b4a63" }}>|</span>
      {st.market.map((m) => (
        <span key={m.id} title={`${m.name}: wholesale ${gbp(m.wholesale)}, retail ${gbp(m.retail)}`}>
          {m.emoji} <b>{gbp(m.retail)}</b>{" "}
          <span className={m.trend > 1.05 ? "up" : m.trend < 0.95 ? "down" : ""}>{m.trend > 1.05 ? "▲" : m.trend < 0.95 ? "▼" : "•"}</span>
        </span>
      ))}
    </footer>
  );
}
