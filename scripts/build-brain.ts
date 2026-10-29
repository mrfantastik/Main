// Builds the town's brain for the standalone game:
//
//   dist/brain/worker.js        the model worker (onnxruntime-web + tokenizer + generation loop)
//   dist/artifact/brain/...     the worker, the onnxruntime WebAssembly binary and the model,
//                               split into parts under 15 MB (hosts like claude.ai artifacts
//                               cap file sizes; parts are named .wasm so they're served as
//                               plain binary), plus manifest.json describing them
//
// The model comes from BRAIN_MODEL (default models/brain), a folder holding
// config.json, tokenizer.json, tokenizer_config.json, the ONNX file and a
// brain.json: {"name": "SmolLM2 135M Instruct", "model": "onnx/model_q4.onnx", "pastType": "float32"}.
// `npm run fetch-brain` downloads one from Hugging Face. Without a model the
// worker is still built (the downloaded single-file game fetches the model
// from Hugging Face itself).
//
//   npm run build:standalone   (runs this between the Vite build and packing the page)

import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const PART = 14 * 1024 * 1024;

await build({
  entryPoints: [path.join(root, "src/client/brain/worker.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  outfile: path.join(root, "dist/brain/worker.js"),
  logLevel: "warning",
});
// A classic (non-module) copy too: it rides inside the single-file game, where a page opened
// from disk can start a classic worker from a blob but not a module worker.
await build({
  entryPoints: [path.join(root, "src/client/brain/worker.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  outfile: path.join(root, "dist/brain/worker.classic.js"),
  define: { "import.meta.url": "self.location.href" },
  logLevel: "error",
});
const worker = path.join(root, "dist/brain/worker.js");
console.log(`  🧠 dist/brain/worker.js (${Math.round(statSync(worker).size / 1024)} KB), worker.classic.js`);

/** Split a file into parts; returns their names (relative to the brain folder). */
function split(src: string, outDir: string, prefix: string): string[] {
  const buf = readFileSync(src);
  const names: string[] = [];
  for (let i = 0, n = 0; i < buf.length; i += PART, n++) {
    const name = `${prefix}-${String(n).padStart(2, "0")}.wasm`;
    writeFileSync(path.join(outDir, name), buf.subarray(i, i + PART));
    names.push(name);
  }
  return names;
}

const modelDir = path.resolve(root, process.env.BRAIN_MODEL ?? "models/brain");
const out = path.join(root, "dist/artifact/brain");
rmSync(out, { recursive: true, force: true });
if (!existsSync(path.join(modelDir, "brain.json"))) {
  console.log(`  🧠 no model in ${path.relative(root, modelDir)} (npm run fetch-brain): the published page will fetch it from Hugging Face`);
} else {
  const info = JSON.parse(readFileSync(path.join(modelDir, "brain.json"), "utf8")) as { name: string; model: string; pastType: "float32" | "float16" };
  mkdirSync(path.join(out, "parts"), { recursive: true });
  copyFileSync(worker, path.join(out, "worker.js"));
  for (const f of ["config.json", "tokenizer.json", "tokenizer_config.json"]) copyFileSync(path.join(modelDir, f), path.join(out, f));
  const ortWasm = path.join(root, "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm");
  const wasm = split(ortWasm, path.join(out, "parts"), "ort").map((n) => `parts/${n}`);
  const modelParts = split(path.join(modelDir, info.model), path.join(out, "parts"), "model").map((n) => `parts/${n}`);
  const bytes = statSync(ortWasm).size + statSync(path.join(modelDir, info.model)).size + ["config.json", "tokenizer.json", "tokenizer_config.json"].reduce((s, f) => s + statSync(path.join(modelDir, f)).size, 0);
  writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ name: info.name, model: info.model, pastType: info.pastType, wasm, shards: { [info.model]: modelParts }, bytes }, null, 1));
  console.log(`  🧠 dist/artifact/brain: ${info.name}, ${modelParts.length} model parts + ${wasm.length} runtime parts, ${Math.round(bytes / 1e6)} MB`);
  if (bytes > 250 * 1024 * 1024) console.warn(`  ⚠️  ${Math.round(bytes / 1e6)} MB is more than a claude.ai artifact can carry (256 MB in all, with the page). Pick a smaller model file.`);
}
