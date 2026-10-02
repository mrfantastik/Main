import { useState } from "react";
import type { GodCommand } from "../../shared/protocol";
import { store, useStore } from "../net/store";
import { OCC_LABEL } from "./format";
import { Shell } from "./Overlays";

function god(command: GodCommand) {
  store.send({ type: "god", command });
}

export function GodPanel() {
  const st = useStore((s) => s.state);
  const selection = useStore((s) => s.selection);
  const citizens = [...(st?.citizens ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const products = st?.market ?? [];
  const businesses = (st?.businesses ?? []).filter((b) => b.open);
  const [cid, setCid] = useState<string>(selection?.kind === "citizen" ? selection.id : "");
  const [amount, setAmount] = useState("1000");
  const [pid, setPid] = useState("phones");
  const [price, setPrice] = useState("");
  const [occ, setOcc] = useState("entrepreneur");
  const [kind, setKind] = useState("shop");
  const [bid, setBid] = useState("");
  const [seed, setSeed] = useState("");
  const citizen = cid || citizens[0]?.id || "";
  const business = bid || businesses[0]?.id || "";

  return (
    <Shell title="⚡ God Mode" drawer>
      <p className="muted" style={{ marginTop: 0 }}>
        Interfere with the world. Citizens notice — and react in their own way.
      </p>

      <div className="god-section">
        <h4>💰 Money</h4>
        <div className="god-row">
          <select value={citizen} onChange={(e) => setCid(e.target.value)}>
            {citizens.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({OCC_LABEL[c.occupation]}, £{Math.round(c.money)})
              </option>
            ))}
          </select>
          <input style={{ maxWidth: 90 }} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="god-row">
          <button className="btn good" onClick={() => god({ cmd: "give_money", citizenId: citizen, amount: Number(amount) || 1000 })}>
            🎁 Give £{Number(amount) || 1000}
          </button>
          <button className="btn danger" onClick={() => god({ cmd: "take_money", citizenId: citizen, amount: Number(amount) || 1000 })}>
            💸 Take money
          </button>
        </div>
      </div>

      <div className="god-section">
        <h4>💼 Jobs</h4>
        <div className="god-row">
          <select value={occ} onChange={(e) => setOcc(e.target.value)}>
            {Object.entries(OCC_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => god({ cmd: "set_job", citizenId: citizen, occupation: occ as never })}>
            Give {citizens.find((c) => c.id === citizen)?.name ?? "them"} this job
          </button>
        </div>
      </div>

      <div className="god-section">
        <h4>📦 Markets</h4>
        <div className="god-row">
          <select value={pid} onChange={(e) => setPid(e.target.value)}>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.emoji} {p.name} (wholesale £{p.wholesale.toFixed(2)})
              </option>
            ))}
          </select>
        </div>
        <div className="god-row">
          <button className="btn" onClick={() => god({ cmd: "shortage", productId: pid })}>
            🚫 Shortage
          </button>
          <button className="btn" onClick={() => god({ cmd: "surplus", productId: pid })}>
            📦 Surplus
          </button>
          <button className="btn" onClick={() => god({ cmd: "hype", productId: pid })}>
            🔥 Make it trend
          </button>
        </div>
        <div className="god-row">
          <input placeholder="New wholesale price £" value={price} onChange={(e) => setPrice(e.target.value)} />
          <button
            className="btn"
            onClick={() => {
              const v = Number(price);
              if (v > 0) god({ cmd: "set_price", productId: pid, price: v });
              setPrice("");
            }}
          >
            Set price
          </button>
        </div>
      </div>

      <div className="god-section">
        <h4>🏪 Businesses</h4>
        <div className="god-row">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="shop">Shop</option>
            <option value="stall">Market stall</option>
            <option value="cafe">Café</option>
            <option value="agency">Agency</option>
          </select>
          <button className="btn good" onClick={() => god({ cmd: "spawn_business", citizenId: citizen, kind, productId: pid })}>
            ✨ Spawn for {citizens.find((c) => c.id === citizen)?.name ?? "them"}
          </button>
        </div>
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
          Uses the citizen and product selected above. Heaven provides £250 start-up capital.
        </div>
        <div className="god-row">
          <select value={business} onChange={(e) => setBid(e.target.value)}>
            {businesses.length === 0 && <option value="">No open businesses</option>}
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.ownerName})
              </option>
            ))}
          </select>
          <button className="btn danger" disabled={!business} onClick={() => god({ cmd: "close_business", businessId: business })}>
            🔒 Close
          </button>
        </div>
      </div>

      <div className="god-section">
        <h4>🌍 Economy</h4>
        <div className="god-row">
          <button className="btn good" onClick={() => god({ cmd: "boom" })}>
            📈 Trigger boom
          </button>
          <button className="btn danger" onClick={() => god({ cmd: "crash" })}>
            📉 Trigger crash
          </button>
        </div>
        {st && st.economy.mode !== "normal" && (
          <div className="muted">
            Currently: <b>{st.economy.mode}</b> (demand ×{st.economy.multiplier})
          </div>
        )}
      </div>

      <div className="god-section">
        <h4>💾 Save</h4>
        <div className="god-row">
          <button className="btn" onClick={() => store.send({ type: "save" })}>
            💾 Save now
          </button>
          <a className="btn" href="/api/export" download style={{ textDecoration: "none" }}>
            ⬇️ Download world (JSON)
          </a>
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          The world autosaves every 30 seconds and when the server stops. Restart the server and it carries on where it left off.
        </div>
      </div>

      <div className="god-section">
        <h4>🔄 New world</h4>
        <div className="god-row">
          <input placeholder="Seed (optional)" value={seed} onChange={(e) => setSeed(e.target.value)} />
          <button
            className="btn danger"
            onClick={() => {
              if (confirm("Start a brand-new city? The current one will be replaced.")) store.send({ type: "reset", seed: seed ? Number(seed) : undefined });
            }}
          >
            Start over
          </button>
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          The same seed always produces the same city and the same story (with Claude switched off).
        </div>
      </div>
    </Shell>
  );
}
