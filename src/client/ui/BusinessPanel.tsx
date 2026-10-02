import { store, useStore } from "../net/store";
import { gbp, KIND_LABEL, when } from "./format";
import { LineChart } from "./charts";

export function BusinessPanel() {
  const d = useStore((s) => (s.detail?.kind === "business" ? s.detail : null));
  if (!d) {
    return (
      <div className="side-body">
        <div className="empty">Loading business…</div>
      </div>
    );
  }
  const b = d.summary;
  return (
    <>
      <div className="side-head">
        <div style={{ minWidth: 0 }}>
          <div className="insp-title">{b.name}</div>
          <div className="insp-sub">
            {KIND_LABEL[b.kind]} · owned by{" "}
            <span className="who" style={{ color: "var(--accent-2)", cursor: "pointer" }} onClick={() => store.select({ kind: "citizen", id: b.ownerId })}>
              {b.ownerName}
            </span>{" "}
            · since {when(b.foundedT)}
          </div>
        </div>
        <button className="close" onClick={() => store.select(null)}>
          ✕
        </button>
      </div>
      <div className="side-body">
        {!b.open && (
          <div className="item" style={{ borderColor: "var(--bad)", marginBottom: 8 }}>
            🔒 Closed {b.closedT ? when(b.closedT) : ""} — {d.closedReason}
          </div>
        )}
        <div className="cards">
          <div className="card">
            <div className="k">Cash</div>
            <div className="v">{gbp(b.cash)}</div>
          </div>
          <div className="card">
            <div className="k">Avg profit / day</div>
            <div className={`v ${b.avgProfit >= 0 ? "pos" : "neg"}`}>{gbp(b.avgProfit)}</div>
          </div>
          <div className="card">
            <div className="k">Revenue today</div>
            <div className="v">{gbp(b.revenueToday)}</div>
          </div>
          <div className="card">
            <div className="k">Customers today</div>
            <div className="v">{b.customersToday}</div>
          </div>
          <div className="card">
            <div className="k">Total profit</div>
            <div className={`v ${d.totalProfit >= 0 ? "pos" : "neg"}`}>{gbp(d.totalProfit)}</div>
          </div>
          <div className="card">
            <div className="k">Reputation</div>
            <div className="v">{b.reputation}/100</div>
          </div>
        </div>
        {d.history.length > 1 && (
          <>
            <div className="section">Daily profit & revenue</div>
            <LineChart
              series={[
                { name: "Revenue", values: d.history.map((h) => h.revenue) },
                { name: "Profit", values: d.history.map((h) => h.profit) },
              ]}
              xLabels={d.history.map((h) => `Day ${h.day}`)}
              format={(v) => gbp(v)}
              height={150}
            />
          </>
        )}
        <div className="section">Products & prices</div>
        <table className="t">
          <thead>
            <tr>
              <th>Product</th>
              <th className="num">Stock</th>
              <th className="num">Cost</th>
              <th className="num">Price</th>
            </tr>
          </thead>
          <tbody>
            {d.inventory.map((i) => (
              <tr key={i.id}>
                <td>
                  {i.emoji} {i.name}
                </td>
                <td className="num">{i.qty}</td>
                <td className="num">{gbp(i.avgCost)}</td>
                <td className="num">
                  <b>{gbp(i.price)}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="section">Staff</div>
        {d.employees.length === 0 ? (
          <div className="empty">No employees{b.hiringWage > 0 ? ` — hiring at ${gbp(b.hiringWage)}/day` : ""}.</div>
        ) : (
          <div className="list">
            {d.employees.map((e) => (
              <div key={e.id} className="item clickable" onClick={() => store.select({ kind: "citizen", id: e.id })}>
                <b>{e.name}</b> — {gbp(e.wage)}/day <span className="meta">since {when(e.since)}</span>
              </div>
            ))}
          </div>
        )}
        {d.partners.length > 0 && (
          <>
            <div className="section">Investors / partners</div>
            <div className="list">
              {d.partners.map((p) => (
                <div key={p.id} className="item clickable" onClick={() => store.select({ kind: "citizen", id: p.id })}>
                  <b>{p.name}</b> owns {Math.round(p.share * 100)}% (invested {gbp(p.invested)})
                </div>
              ))}
            </div>
          </>
        )}
        {(d.unpaidWages > 0 || d.daysInRed > 0) && (
          <div className="item" style={{ marginTop: 8, borderColor: "var(--warn)" }}>
            ⚠️ Unpaid wages {gbp(d.unpaidWages)} · {d.daysInRed} day(s) in the red
          </div>
        )}
        <div className="section">Transactions</div>
        <div className="list">
          {d.transactions.length === 0 && <div className="empty">No transactions yet.</div>}
          {d.transactions.map((t) => {
            const incoming = t.to === `b:${b.id}`;
            return (
              <div key={t.id} className="item">
                <span className={incoming ? "pos" : "neg"}>
                  {incoming ? "+" : "−"}
                  {gbp(t.amount)}
                </span>{" "}
                {t.memo}
                <div className="meta">
                  {when(t.t)} · {incoming ? `from ${t.fromName}` : `to ${t.toName}`}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
