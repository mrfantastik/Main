import { useEffect, useRef } from "react";
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

export function App() {
  const selection = useStore((s) => s.selection);
  const connected = useStore((s) => s.connected);
  const toasts = useStore((s) => s.toasts);
  const paused = useStore((s) => s.state?.paused ?? false);
  return (
    <div className="app">
      <TopBar />
      <aside className="side">
        {selection?.kind === "citizen" ? <CitizenPanel /> : selection?.kind === "business" ? <BusinessPanel /> : <CitizenList />}
      </aside>
      <main className="stage">
        <CityView />
        {!connected && <div className="banner">Connecting to the city server…</div>}
        {connected && paused && <div className="banner">⏸ Paused</div>}
        <Legend />
        <Overlays />
      </main>
      <aside className="side right">
        <EventFeed />
      </aside>
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
