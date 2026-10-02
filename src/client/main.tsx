import { createRoot } from "react-dom/client";
import { App } from "./App";
import { store } from "./net/store";
import "./styles.css";

store.connect();
// Handy for debugging from the browser console: window.hustle.store.s
(window as unknown as { hustle: unknown }).hustle = { store };
createRoot(document.getElementById("root")!).render(<App />);
