import { SKIPS, SPEEDS } from "../../shared/protocol";
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
      <div className="brand" title="AI Hustle City">
        🏙️<span className="brand-words"> AI <span>Hustle</span> City</span>
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
      <div className="speeds skips" role="group" aria-label="Skip ahead">
        <span className="skip-icon" aria-hidden>
          ⏩
        </span>
        {SKIPS.map((k) => (
          <button key={k.minutes} title={`Skip ahead ${k.title} instantly`} aria-label={`Skip ahead ${k.title}`} disabled={!connected} onClick={() => store.send({ type: "skip", minutes: k.minutes })}>
            {k.label}
          </button>
        ))}
      </div>
      {st?.economy.mode && st.economy.mode !== "normal" && (
        <span className={`chip ${st.economy.mode === "boom" ? "good" : "bad"}`}>{st.economy.mode === "boom" ? "📈 BOOM" : "📉 CRASH"}</span>
      )}
      <div className="toolbar">
        {/* Always the same width, so the first autosave doesn't reflow the bar (and shift the map). */}
        <span className={`chip status ${connected ? "good" : "bad"}`} title={connected ? (st?.savedAt ? `Running · last autosave ${clock(st.savedAt)}` : "Running") : "Not connected"}>
          <i className="dot" style={{ background: connected ? "#2fbf71" : "#e5484d" }} />
          {!connected ? "Offline" : st?.savedAt ? <span>💾 {clock(st.savedAt)}</span> : "Live"}
        </span>
        {ai?.brain && (ai.brain.state === "off" || ai.brain.state === "error") && (
          <button
            className="tool"
            aria-label="Wake the town's brain"
            title="Wake the town's brain: an open-source AI on your computer that runs the people"
            onClick={() => {
              // No model yet (or no engine): the AI panel is where you choose one.
              if (ai.brain!.needsModel || !ai.brain!.engine) {
                if (store.getSnapshot().panel !== "ai") store.setPanel("ai");
              } else store.send({ type: "ai", brain: "load" });
            }}
          >
            🧠 Wake the brain
          </button>
        )}
        {ai && !(ai.brain && (ai.brain.state === "off" || ai.brain.state === "error")) && (
          <span className={`chip ${ai.mode === "llm" ? "llm" : ""}`} title="AI decision engine">
            {ai.brain
              ? ai.brain.state === "ready"
                ? `🧠 Town brain · ${ai.brain.device === "webgpu" ? "GPU" : "CPU"}`
                : ai.brain.state === "loading"
                  ? `🧠 Waking… ${ai.brain.total ? Math.round((ai.brain.loaded / ai.brain.total) * 100) : 0}%`
                  : "🧠 Built-in AI"
              : ai.mode === "llm"
              ? ai.free
                ? ai.connection?.connected
                  ? `🌐 Free AI · ${ai.connection.active}`
                  : ai.connection?.blocked
                    ? "🧠 Built-in AI (no internet here)"
                    : "🌐 Free AI · connecting…"
                : `🧠 Claude · $${ai.spentUsd.toFixed(3)} / $${ai.budgetUsd}`
              : "🧠 Utility AI"}
          </span>
        )}
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
