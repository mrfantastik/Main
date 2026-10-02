import { createRoot } from "react-dom/client";
import { App } from "./App";
import { store } from "./net/store";
import "./styles.css";

store.connect();
createRoot(document.getElementById("root")!).render(<App />);
