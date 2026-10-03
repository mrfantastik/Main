import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The client lives in src/client. The Node server (src/server) serves it:
// in development through Vite middleware, in production from dist/client.
//
// `vite build --mode standalone` (npm run build:standalone) instead builds a
// version that runs the whole simulation in the browser — no server needed —
// as one JavaScript bundle, which scripts/standalone.ts inlines into a single
// HTML page.
export default defineConfig(({ mode }) => {
  const standalone = mode === "standalone";
  return {
    root: "src/client",
    base: standalone ? "./" : "/",
    plugins: [react()],
    build: {
      outDir: standalone ? "../../dist/standalone" : "../../dist/client",
      emptyOutDir: true,
      ...(standalone ? { modulePreload: { polyfill: false }, rolldownOptions: { output: { codeSplitting: false } } } : {}),
    },
  };
});
