import { createRoot } from "react-dom/client";
import { App } from "./App";
import { store } from "./net/store";
import "./styles.css";

// Handy for debugging from the browser console: window.hustle.store.s
(window as unknown as { hustle: unknown }).hustle = { store };

function start(): void {
  store.connect();
  createRoot(document.getElementById("root")!).render(<App />);
}

// When the standalone page is hosted as a claude.ai artifact, the host may
// swap in a newer version of the page while it's open: save first, and the
// new version picks the city up from browser storage.
interface HotHook {
  ready?: (fn: () => void) => void;
  snapshot?: (fn: () => unknown) => void;
}
const hot = (window as unknown as { claude?: { hot?: HotHook } }).claude?.hot;
try {
  hot?.snapshot?.(() => {
    store.saveNow();
    return {};
  });
} catch {
  // Not running inside an artifact viewer.
}
if (hot?.ready) hot.ready(start);
else start();
