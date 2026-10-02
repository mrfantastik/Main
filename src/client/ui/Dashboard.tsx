import { useState } from "react";
import type { StatPoint } from "../../sim/types";
import { store, useStore } from "../net/store";
import { BarList, LineChart, SERIES, Sparkline } from "./charts";
import { clock, day, gbp, OCC_LABEL, when } from "./format";
import { Shell } from "./Overlays";

function label(t: number, hourly: boolean): string {
  return hourly ? `D${day(t - 1)} ${clock(t - 1)}` : `Day ${day(t - 1)}`;
}

function Tile({ title, value, delta, good, spark }: { title: string; value: string; delta?: number | null; good?: "up" | "down"; spark?: number[] }) {
  const dir = delta === undefined || delta === null || Math.abs(delta) < 1e-9 ? 0 : delta > 0 ? 1 : -1;
  const isGood = good === undefined ? null : (dir > 0 && good === "up") || (dir < 0 && good === "down");
  return (
    <div className="box" style={{ padding: "8px 10px" }}>
      <div className="muted" style={{ fontSize: 11 }}>
        {title}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {delta !== undefined && delta !== null && (
        <div style={{ fontSize: 11 }} className={dir === 0 || isGood === null ? "muted" : isGood ? "pos" : "neg"}>
          {dir > 0 ? "▲" : dir < 0 ? "▼" : "•"} {Math.abs(delta) < 1 ? Math.abs(delta).toFixed(2) : Math.round(Math.abs(delta)).toLocaleString()} vs a day ago
        </div>
      )}
      {spark && spark.length > 2 && <Sparkline values={spark} height={26} color={SERIES[0]} showValue={false} />}
    </div>
  );
}

export function Dashboard() {
  const d = useStore((s) => s.dashboard);
  const st = useStore((s) => s.state);
  const [range, setRange] = useState<"hourly" | "daily">("hourly");
  if (!d || !st) {
    return (
      <Shell title="📊 Economy dashboard">
        <div className="empty">Loading the numbers…</div>
      </Shell>
    );
  }
  const hourlyPts = d.hourly.slice(-48);
  const pts: StatPoint[] = range === "hourly" ? hourlyPts : d.daily;
  const xl = pts.map((p) => label(p.t, range === "hourly"));
  const now = d.hourly[d.hourly.length - 1];
  const dayAgo = d.hourly.length > 24 ? d.hourly[d.hourly.length - 25] : null;
  const txPer = pts.map((p, i) => (i === 0 ? 0 : Math.max(0, p.txCount - pts[i - 1].txCount))).slice(1);
  const recentSpark = (f: (p: StatPoint) => number) => hourlyPts.map(f);
  const prodName = (id: string) => d.products.find((p) => p.id === id);

  return (
    <Shell title="📊 Economy dashboard">
      <div className="god-row" style={{ alignItems: "center" }}>
        <span className="muted">Range:</span>
        <button className={`btn ${range === "hourly" ? "primary" : ""}`} onClick={() => setRange("hourly")}>
          Last 48 hours
        </button>
        <button className={`btn ${range === "daily" ? "primary" : ""}`} onClick={() => setRange("daily")}>
          Every day
        </button>
        <span className="muted" style={{ marginLeft: "auto" }}>
          Economy: <b>{st.economy.mode}</b> · demand ×{st.economy.multiplier} · CityCorp {st.economy.corpEmployees}/{st.economy.corpOpenings} jobs filled · services{" "}
          {d.service.pool > 0 ? `${Math.round((d.service.supplied / d.service.pool) * 100)}% of client demand met` : "closed (night)"}
        </span>
      </div>

      {now && (
        <div className="kpis">
          <Tile title="Money in the economy" value={gbp(now.totalMoney)} delta={dayAgo ? now.totalMoney - dayAgo.totalMoney : null} good="up" spark={recentSpark((p) => p.totalMoney)} />
          <Tile title="Average net worth" value={gbp(now.avgWealth)} delta={dayAgo ? now.avgWealth - dayAgo.avgWealth : null} good="up" spark={recentSpark((p) => p.avgWealth)} />
          <Tile title="Median net worth" value={gbp(now.medianWealth)} delta={dayAgo ? now.medianWealth - dayAgo.medianWealth : null} good="up" />
          <Tile title="Unemployment" value={`${Math.round(now.unemployment * 100)}%`} delta={dayAgo ? (now.unemployment - dayAgo.unemployment) * 100 : null} good="down" />
          <Tile title="Businesses open" value={String(now.businesses)} delta={dayAgo ? now.businesses - dayAgo.businesses : null} good="up" />
          <Tile title="Transactions (total)" value={st.txCount.toLocaleString()} delta={dayAgo ? now.txCount - dayAgo.txCount : null} />
          <Tile title="Inequality (Gini)" value={now.gini.toFixed(2)} delta={dayAgo ? now.gini - dayAgo.gini : null} good="down" />
          <Tile title="Spending this hour" value={gbp(now.revenue)} />
        </div>
      )}

      <div className="grid2">
        <div className="box">
          <h3>Money in the economy</h3>
          <LineChart series={[{ name: "Total money (£)", values: pts.map((p) => p.totalMoney) }]} xLabels={xl} format={(v) => gbp(v)} />
        </div>
        <div className="box">
          <h3>Wealth: average vs median</h3>
          <LineChart
            series={[
              { name: "Average net worth", values: pts.map((p) => p.avgWealth) },
              { name: "Median net worth", values: pts.map((p) => p.medianWealth) },
            ]}
            xLabels={xl}
            format={(v) => gbp(v)}
          />
        </div>
        <div className="box">
          <h3>Unemployment</h3>
          <LineChart series={[{ name: "Unemployment %", values: pts.map((p) => p.unemployment * 100), color: SERIES[1] }]} xLabels={xl} format={(v) => `${Number.isInteger(v) ? v : v.toFixed(1)}%`} zeroBase />
        </div>
        <div className="box">
          <h3>Businesses open</h3>
          <LineChart series={[{ name: "Businesses", values: pts.map((p) => p.businesses), color: SERIES[2] }]} xLabels={xl} zeroBase />
        </div>
        <div className="box">
          <h3>Transactions per {range === "hourly" ? "hour" : "day"}</h3>
          <LineChart series={[{ name: "Transactions", values: txPer, color: SERIES[6] }]} xLabels={xl.slice(1)} zeroBase />
        </div>
        <div className="box">
          <h3>Money in vs out of town (per {range === "hourly" ? "hour" : "day"})</h3>
          <LineChart
            series={[
              { name: "Flowing in (wages, visitors, clients)", values: pts.map((p) => p.inflow) },
              { name: "Flowing out (rent, wholesale, diner)", values: pts.map((p) => p.outflow) },
            ]}
            xLabels={xl}
            format={(v) => gbp(v)}
            zeroBase
          />
        </div>
      </div>

      <div className="grid2" style={{ marginTop: 12 }}>
        <div className="box">
          <h3>Richest citizens</h3>
          <BarList rows={d.richest.map((r) => ({ label: r.name, sub: OCC_LABEL[r.occupation], value: r.netWorth, onClick: () => store.select({ kind: "citizen", id: r.id }) }))} format={(v) => gbp(v)} />
        </div>
        <div className="box">
          <h3>Poorest citizens</h3>
          <BarList rows={d.poorest.map((r) => ({ label: r.name, sub: OCC_LABEL[r.occupation], value: r.netWorth, onClick: () => store.select({ kind: "citizen", id: r.id }) }))} format={(v) => gbp(v)} color={SERIES[1]} />
        </div>
        <div className="box">
          <h3>Most profitable businesses (avg profit/day)</h3>
          {d.topBusinesses.length === 0 ? (
            <div className="empty">No businesses yet.</div>
          ) : (
            <BarList
              rows={d.topBusinesses.map((b) => ({ label: b.name, sub: `${b.ownerName}${b.open ? "" : " · closed"}`, value: b.avgProfit, onClick: () => store.select({ kind: "business", id: b.id }) }))}
              format={(v) => gbp(v)}
              color={SERIES[2]}
            />
          )}
        </div>
        <div className="box">
          <h3>Popular products (units sold, all time)</h3>
          <BarList rows={d.popular.map((p) => ({ label: `${p.emoji} ${p.name}`, value: p.sold }))} color={SERIES[3]} />
        </div>
      </div>

      <div className="box" style={{ marginTop: 12 }}>
        <h3>Market prices</h3>
        <table className="t">
          <thead>
            <tr>
              <th>Product</th>
              <th className="num">Wholesale</th>
              <th style={{ width: 150 }}>Wholesale, last 48h</th>
              <th className="num">Avg selling price</th>
              <th className="num">Demand</th>
              <th className="num">Sold today</th>
              <th className="num">Turned away</th>
              <th className="num">Sellers</th>
              <th className="num">Listed</th>
            </tr>
          </thead>
          <tbody>
            {d.market.map((m) => {
              const p = prodName(m.id);
              return (
                <tr key={m.id}>
                  <td>
                    {m.emoji} {m.name} {p?.inventorId && <span className="chip llm">invention</span>}
                  </td>
                  <td className="num">{gbp(m.wholesale, 2)}</td>
                  <td>
                    <Sparkline values={d.tapes[m.id] ?? []} height={20} color={m.trend > 1.05 ? SERIES[2] : m.trend < 0.95 ? SERIES[1] : SERIES[0]} format={(v) => gbp(v, 2)} showValue={false} />
                  </td>
                  <td className="num">{gbp(m.retail, 2)}</td>
                  <td className={`num ${m.trend > 1.05 ? "up" : m.trend < 0.95 ? "down" : ""}`}>
                    {m.trend > 1.05 ? "▲" : m.trend < 0.95 ? "▼" : "•"} ×{m.trend.toFixed(2)}
                  </td>
                  <td className="num">{m.soldToday}</td>
                  <td className="num">{m.unmetToday}</td>
                  <td className="num">{m.sellers}</td>
                  <td className="num">{m.listings}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          "Turned away" = visitors who wanted to buy but nobody in town had stock at a price they'd pay — a signal entrepreneurs notice.
        </div>
      </div>

      <div className="grid2" style={{ marginTop: 12 }}>
        <div className="box">
          <h3>Economic events</h3>
          {d.econEvents.length === 0 && <div className="empty">Nothing major yet.</div>}
          <div className="list">
            {d.econEvents.map((e) => (
              <div key={e.id} className="item">
                {e.text}
                <div className="meta">{when(e.t)}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="box">
          <h3>What people do</h3>
          <BarList
            rows={Object.entries(d.occupations)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => ({ label: OCC_LABEL[k] ?? k, value: v }))}
            color={SERIES[4]}
          />
          <h3 style={{ marginTop: 14 }}>Loans outstanding</h3>
          {d.loans.length === 0 ? (
            <div className="empty">Nobody owes anybody.</div>
          ) : (
            <table className="t">
              <tbody>
                {d.loans.map((l) => (
                  <tr key={l.id}>
                    <td>
                      {l.lender} → {l.borrower}
                    </td>
                    <td className="num">{gbp(l.totalDue - l.paid)}</td>
                    <td className="muted">due {when(l.dueT)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="box">
          <h3>Recent transactions</h3>
          <table className="t">
            <tbody>
              {d.recentTx.map((t) => (
                <tr key={t.id}>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>
                    {clock(t.t)}
                  </td>
                  <td>
                    {t.fromName} → {t.toName}
                    <div className="muted" style={{ fontSize: 11 }}>
                      {t.memo}
                    </div>
                  </td>
                  <td className="num">{gbp(t.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Shell>
  );
}
