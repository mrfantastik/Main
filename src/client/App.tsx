import { useCallback, useEffect, useRef, useState } from "react";
import { store, useStore } from "./net/store";
import { Renderer } from "./render/renderer";
import type { CityRenderer } from "./render/types";
import { Renderer3D } from "./render3d/Renderer3D";
import { BusinessPanel } from "./ui/BusinessPanel";
import { CitizenList } from "./ui/CitizenList";
import { CitizenPanel } from "./ui/CitizenPanel";
import { EventFeed } from "./ui/EventFeed";
import { Overlays } from "./ui/Overlays";
import { Ticker } from "./ui/Ticker";
import { TopBar } from "./ui/TopBar";
import { OCC_COLORS, OCC_LABEL } from "./ui/format";

export let renderer: CityRenderer | null = null;

type View = "3d" | "2d";
const VIEW_KEY = "hustle.view";

function savedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "2d" ? "2d" : "3d";
  } catch {
    return "3d";
  }
}

function CityView({ view, onFail }: { view: View; onFail: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const hello = useStore((s) => s.hello);
  useEffect(() => {
    if (!ref.current) return;
    let r: CityRenderer;
    try {
      r = view === "3d" ? new Renderer3D(ref.current) : new Renderer(ref.current);
    } catch {
      // No WebGL (old browser, blocked GPU): fall back to the flat map.
      onFail();
      return;
    }
    renderer = r;
    if (store.s.hello) r.setMap(store.s.hello.map);
    r.start();
    (window as unknown as { hustle: { renderer?: CityRenderer } }).hustle.renderer = r;
    return () => {
      r.stop();
      if (renderer === r) renderer = null;
    };
  }, [view, onFail]);
  useEffect(() => {
    if (hello && renderer) renderer.setMap(hello.map);
  }, [hello]);
  // Each view gets a fresh canvas (a canvas can't switch between WebGL and 2D).
  return (
    <div className="cityview" key={view}>
      <canvas ref={ref} />
    </div>
  );
}

/** 2D/3D switch, plus rotate and director buttons for the 3D view. */
function ViewControls({ view, setView }: { view: View; setView: (v: View) => void }) {
  const [director, setDirector] = useState(false);
  useEffect(() => setDirector(false), [view]);
  const r3d = () => (renderer instanceof Renderer3D ? renderer : null);
  return (
    <div className="view-controls">
      <div className="seg" role="group" aria-label="City view">
        {(["3d", "2d"] as const).map((v) => (
          <button key={v} className={view === v ? "on" : ""} aria-pressed={view === v} onClick={() => setView(v)}>
            {v.toUpperCase()}
          </button>
        ))}
      </div>
      {view === "3d" && (
        <>
          <button title="Rotate left (Q)" aria-label="Rotate view left" onClick={() => r3d()?.rotate(-1)}>
            ⟲
          </button>
          <button title="Rotate right (E)" aria-label="Rotate view right" onClick={() => r3d()?.rotate(1)}>
            ⟳
          </button>
          <button
            className={director ? "on" : ""}
            aria-pressed={director}
            title="Director camera: glides to deals, conversations and new businesses on its own"
            onClick={() => {
              const next = !director;
              setDirector(next);
              r3d()?.setDirector(next);
            }}
          >
            🎬 Director
          </button>
        </>
      )}
    </div>
  );
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
  const [view, setViewState] = useState<View>(savedView);
  const setView = useCallback((v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Storage blocked: the choice just won't be remembered.
    }
  }, []);
  const fallBack = useCallback(() => {
    store.toast("3D isn't available in this browser, so the city is shown in 2D.", "error");
    setViewState("2d");
  }, []);
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
        <CityView view={view} onFail={fallBack} />
        <ViewControls view={view} setView={setView} />
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
