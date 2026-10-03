import { store, useStore } from "../net/store";
import { AIPanel } from "./AIPanel";
import { Dashboard } from "./Dashboard";
import { GodPanel } from "./GodPanel";

function Shell({ title, children, drawer }: { title: string; children: React.ReactNode; drawer?: boolean }) {
  return (
    <div className={`overlay ${drawer ? "drawer" : ""}`}>
      <div className="overlay-head">
        {title}
        <button className="close" onClick={() => store.setPanel("none")}>
          ✕
        </button>
      </div>
      <div className="overlay-body">{children}</div>
    </div>
  );
}

function Help() {
  return (
    <Shell title="❓ How to watch AI Hustle City" drawer>
      <p>You are an observer. The citizens decide everything for themselves — you just watch, and occasionally interfere.</p>
      <ul>
        <li>
          <b>Pan</b>: drag the map (or WASD / arrow keys). <b>Zoom</b>: mouse wheel (or + / −).
        </li>
        <li>
          <b>Click a citizen</b> to see their money, goal, thoughts, memories and relationships. The <b>🧠 Mind</b> tab shows exactly why
          they made each decision.
        </li>
        <li>
          <b>Click a shop</b> to inspect a business.
        </li>
        <li>
          <b>Speed</b>: ⏸ 1× 5× 20× 50× in the top bar. <b>Skip ahead</b> an hour, a day or a week instantly with ⏩.
        </li>
        <li>
          <b>📊 Dashboard</b>: the whole economy. <b>⚡ God Mode</b>: interfere. <b>🧠 AI</b>: Claude usage and decision log.
        </li>
      </ul>
      <p>
        <b>Reading the map:</b> citizen colours show their occupation (legend, bottom-left); the little icon shows what they're doing; speech
        bubbles are live conversations (gold border = written by Claude); green "+£" shows money landing.
      </p>
      <p>
        <b>Persistence:</b>{" "}
        {store.standalone
          ? "the city runs and saves inside your browser. Refresh or come back later and it carries on (in the same browser)."
          : "the city lives on the server and autosaves. Refresh, close the tab or restart the server — it carries on."}
      </p>
      <p className="muted">Everything you see emerges from the simulation. Nothing is scripted.</p>
    </Shell>
  );
}

export function Overlays() {
  const panel = useStore((s) => s.panel);
  if (panel === "help") return <Help />;
  if (panel === "dashboard") return <Dashboard />;
  if (panel === "god") return <GodPanel />;
  if (panel === "ai") return <AIPanel />;
  return null;
}

export { Shell };
