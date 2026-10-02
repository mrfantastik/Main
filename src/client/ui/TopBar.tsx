import { SPEEDS } from "../../shared/protocol";
import { store, useStore } from "../net/store";
import { clock, day } from "./format";

export function TopBar() {
  const st = useStore((s) => s.state);
  const panel = useStore((s) => s.panel);
  const connected = useStore((s) => s.connected);
  const t = st?.t ?? 0;
  const h = (t % 1440) / 60;
  const icon = h >= 6 && h < 18.5 ? "☀️" : h >= 18.5 && h < 21 ? "🌆" : "🌙";
  const ai = st?.ai;
  return (
    <header className="topbar">
      <div className="brand">
        🏙️ AI <span>Hustle</span> City
      </div>
      <div className="clock" title="Game time">
        <span>{icon}</span>
        <span>Day {day(t)}</span>
        <span>{clock(t)}</span>
      </div>
      <div className="speeds" role="group" aria-label="Simulation speed">
        <button className={st?.paused ? "on" : ""} title="Pause (space)" onClick={() => store.send({ type: "pause", paused: !st?.paused })}>
          ⏸
        </button>
        {SPEEDS.map((s) => (
          <button key={s} className={!st?.paused && st?.speed === s ? "on" : ""} onClick={() => store.send({ type: "speed", speed: s })}>
            {s}×
          </button>
        ))}
      </div>
      {st?.economy.mode && st.economy.mode !== "normal" && (
        <span className={`chip ${st.economy.mode === "boom" ? "good" : "bad"}`}>{st.economy.mode === "boom" ? "📈 BOOM" : "📉 CRASH"}</span>
      )}
      <div className="toolbar">
        <span className={`chip ${connected ? "good" : "bad"}`}>
          <i className="dot" style={{ background: connected ? "#2fbf71" : "#e5484d" }} />
          {connected ? "Live" : "Offline"}
        </span>
        {ai && (
          <span className={`chip ${ai.mode === "llm" ? "llm" : ""}`} title="AI decision engine">
            🧠 {ai.mode === "llm" ? `Claude · $${ai.spentUsd.toFixed(3)} / $${ai.budgetUsd}` : "Utility AI"}
          </span>
        )}
        {st?.savedAt && <span className="chip" title="Last autosave">💾 saved {clock(st.savedAt)}</span>}
        <button className={`tool ${panel === "dashboard" ? "on" : ""}`} onClick={() => store.setPanel("dashboard")}>
          📊 Dashboard
        </button>
        <button className={`tool ${panel === "god" ? "on" : ""}`} onClick={() => store.setPanel("god")}>
          ⚡ God Mode
        </button>
        <button className={`tool ${panel === "ai" ? "on" : ""}`} onClick={() => store.setPanel("ai")}>
          🧠 AI
        </button>
        <button className={`tool ${panel === "help" ? "on" : ""}`} onClick={() => store.setPanel("help")}>
          ?
        </button>
      </div>
    </header>
  );
}
