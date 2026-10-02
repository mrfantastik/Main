import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The client lives in src/client. The Node server (src/server) serves it:
// in development through Vite middleware, in production from dist/client.
export default defineConfig({
  root: "src/client",
  plugins: [react()],
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
});
