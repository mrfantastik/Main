import { useEffect, useRef, useState } from "react";
import { store, useStore } from "./net/store";
import { Renderer } from "./render/renderer";
import { BusinessPanel } from "./ui/BusinessPanel";
import { CitizenList } from "./ui/CitizenList";
import { CitizenPanel } from "./ui/CitizenPanel";
import { EventFeed } from "./ui/EventFeed";
import { Overlays } from "./ui/Overlays";
import { Ticker } from "./ui/Ticker";
import { TopBar } from "./ui/TopBar";
import { OCC_COLORS, OCC_LABEL } from "./ui/format";

export let renderer: Renderer | null = null;

function CityView() {
  const ref = useRef<HTMLCanvasElement>(null);
  const hello = useStore((s) => s.hello);
  useEffect(() => {
    if (!ref.current) return;
    renderer = new Renderer(ref.current);
    renderer.start();
    (window as unknown as { hustle: { renderer?: Renderer } }).hustle.renderer = renderer;
    return () => renderer?.stop();
  }, []);
  useEffect(() => {
    if (hello && renderer) renderer.setMap(hello.map);
  }, [hello]);
  return <canvas ref={ref} />;
}

function Legend() {
  return (
    <div className="legend">
      {Object.entries(OCC_LABEL).map(([k, v]) => (
        <span key={k}>
          <i className="dot" style={{ background: OCC_COLORS[k] }} /> {v}
        </span>
      ))}
    </div>
  );
}

/** True when the window is too narrow for three columns. */
function useNarrow(): boolean {
  const query = "(max-width: 1100px)";
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

export function App() {
  const narrow = useNarrow();
  const [tab, setTab] = useState<"people" | "events">("people");
  const selection = useStore((s) => s.selection);
  // Clicking a name in the feed opens that person: show them.
  useEffect(() => {
    if (selection) setTab("people");
  }, [selection]);
  const connected = useStore((s) => s.connected);
  const toasts = useStore((s) => s.toasts);
  const paused = useStore((s) => s.state?.paused ?? false);
  return (
    <div className="app">
      <TopBar />
      <aside className="side">
        {narrow && (
          <div className="side-tabs" role="tablist">
            <button role="tab" aria-selected={tab === "people"} className={tab === "people" ? "on" : ""} onClick={() => setTab("people")}>
              👥 People
            </button>
            <button role="tab" aria-selected={tab === "events"} className={tab === "events" ? "on" : ""} onClick={() => setTab("events")}>
              📰 Live events
            </button>
          </div>
        )}
        {narrow && tab === "events" ? <EventFeed /> : selection?.kind === "citizen" ? <CitizenPanel /> : selection?.kind === "business" ? <BusinessPanel /> : <CitizenList />}
      </aside>
      <main className="stage">
        <CityView />
        {!connected && <div className="banner">{store.standalone ? "Building the city…" : "Connecting to the city server…"}</div>}
        {connected && paused && <div className="banner">⏸ Paused</div>}
        <Legend />
        <Overlays />
      </main>
      {!narrow && (
        <aside className="side right">
          <EventFeed />
        </aside>
      )}
      <Ticker />
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

export { store };
