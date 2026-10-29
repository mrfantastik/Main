// Packs the standalone build into the game in three parts, kept together in one folder:
//
//   dist/three/ai-hustle-city.html   the town: the page you open (from disk is fine)
//   dist/three/hustle-brain.js       the AI engine: the brain's worker and the onnxruntime
//                                    WebAssembly runtime it runs the model with
//   dist/three/hustle-model.bin      the model: an open-source language model with its
//                                    tokenizer, in one file (see src/client/brain/pack.ts)
//
// The model comes from BRAIN_MODEL (default models/brain, `npm run fetch-brain`).
// Without one, the folder has the first two files and the game makes the third:
// the player picks a model in the 🧠 AI panel, it downloads from Hugging Face
// once and is saved as hustle-model.bin (and kept in that browser).
//
//   npm run build:three   (after the Vite build and scripts/build-brain.ts)

import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { makePack } from "../src/client/brain/pack";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "dist/three");
const assets = path.join(root, "dist/standalone/assets");
const js = readdirSync(assets).filter((f) => f.endsWith(".js"));
const css = readdirSync(assets).filter((f) => f.endsWith(".css"));
if (js.length !== 1) throw new Error(`expected one JS bundle, found ${js.join(", ") || "none"}`);
const workerPath = path.join(root, "dist/brain/worker.classic.js");
if (!existsSync(workerPath)) throw new Error("no dist/brain/worker.classic.js: run scripts/build-brain.ts first");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. The page: the game itself, which loads the engine from the file next to it.
const script = readFileSync(path.join(assets, js[0]), "utf8").replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
const style = css.map((f) => readFileSync(path.join(assets, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🏙️</text></svg>" />
<title>AI Hustle City</title>
<style>
${style}
</style>
</head>
<body>
<div id="root"></div>
<!-- The AI engine (the second file). Without it the town runs on its built-in AI. -->
<script src="hustle-brain.js"></script>
<script type="module">
${script}
</script>
</body>
</html>
`;
writeFileSync(path.join(out, "ai-hustle-city.html"), page);
// The same page without the <html>/<head> shell, for hosts that add their own (a claude.ai
// artifact, published with hustle-brain.js as a file next to it).
const bare = page.slice(page.indexOf("<title>"), page.indexOf("</head>")) + page.slice(page.indexOf("<body>") + 6, page.lastIndexOf("</body>"));
mkdirSync(path.join(root, "dist/artifact-three"), { recursive: true });
writeFileSync(path.join(root, "dist/artifact-three/index.html"), bare);

// 2. The engine: the worker (started from a blob, which works for pages opened from disk)
// and the runtime, gzipped (the page unpacks it with DecompressionStream).
const ortWasm = readFileSync(path.join(root, "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm"));
const engine =
  "// AI Hustle City: the AI engine. Keep this file next to ai-hustle-city.html.\n" +
  "// The town's brain (a worker that runs an open-source language model with onnxruntime-web, MIT licence)\n" +
  "// and the onnxruntime WebAssembly runtime, gzipped.\n" +
  `globalThis.__HUSTLE_BRAIN__ = "${readFileSync(workerPath).toString("base64")}";\n` +
  `globalThis.__HUSTLE_ORT__ = "${gzipSync(ortWasm, { level: 9 }).toString("base64")}";\n`;
writeFileSync(path.join(out, "hustle-brain.js"), engine);
writeFileSync(path.join(root, "dist/artifact-three/hustle-brain.js"), engine);

// 3. The model, when there's one to pack.
const modelDir = path.resolve(root, process.env.BRAIN_MODEL ?? "models/brain");
let model = "";
if (existsSync(path.join(modelDir, "brain.json"))) {
  const info = JSON.parse(readFileSync(path.join(modelDir, "brain.json"), "utf8")) as { name: string; model: string; pastType: "float32" | "float16"; repo?: string };
  const files: Record<string, Uint8Array> = {};
  for (const f of ["config.json", "tokenizer.json", "tokenizer_config.json", info.model]) files[f] = readFileSync(path.join(modelDir, f));
  const pack = makePack({ name: info.name, model: info.model, pastType: info.pastType, ...(info.repo ? { repo: info.repo } : {}) }, files);
  const dest = createWriteStream(path.join(out, "hustle-model.bin"));
  for await (const chunk of pack.stream()) if (!dest.write(chunk)) await new Promise((r) => dest.once("drain", r));
  await new Promise<void>((resolve, reject) => dest.end((err?: Error | null) => (err ? reject(err) : resolve())));
  model = info.name;
}

const size = (f: string) => {
  const n = statSync(path.join(out, f)).size;
  return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
};
console.log(`\n  📁 dist/three/ — the game in three files, keep them together:`);
console.log(`     ai-hustle-city.html  ${size("ai-hustle-city.html")}  the town (open this)`);
console.log(`     hustle-brain.js      ${size("hustle-brain.js")}  the AI engine`);
if (model) console.log(`     hustle-model.bin     ${size("hustle-model.bin")}  the model (${model})\n`);
else console.log(`     hustle-model.bin     (made by the game: choose a model in the 🧠 AI panel; no model in ${path.relative(root, modelDir)})\n`);
