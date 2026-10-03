// Downloads a small open-source model from Hugging Face into models/brain for
// scripts/build-brain.ts to package with the standalone game.
//
//   npm run fetch-brain                                   (SmolLM2 135M Instruct, 4-bit: fits a published page)
//   npm run fetch-brain -- --model HuggingFaceTB/SmolLM2-360M-Instruct --file onnx/model_q4f16.onnx --past float16
//
// A page published on claude.ai can carry about 256 MB in all, so the model
// (plus a 27 MB runtime) has to fit in that.

import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const model = arg("model", "HuggingFaceTB/SmolLM2-135M-Instruct");
const file = arg("file", "onnx/model_q4.onnx");
const past = arg("past", file.includes("f16") ? "float16" : "float32");
const name = arg("name", model.split("/")[1].replace(/-/g, " "));
const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "models/brain");
mkdirSync(path.join(out, path.dirname(file)), { recursive: true });

for (const f of ["config.json", "tokenizer.json", "tokenizer_config.json", file]) {
  const url = `https://huggingface.co/${model}/resolve/main/${f}`;
  process.stdout.write(`  ⬇️  ${url} … `);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(path.join(out, f)));
  console.log("done");
}
writeFileSync(path.join(out, "brain.json"), JSON.stringify({ name, model: file, pastType: past, source: `https://huggingface.co/${model}` }, null, 1));
console.log(`  🧠 models/brain: ${name} (${file}). Now: npm run build:standalone`);
