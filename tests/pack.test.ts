import { test } from "node:test";
import assert from "node:assert/strict";
import { makePack, openPack, packInfo } from "../src/client/brain/pack";

const enc = (s: string) => new TextEncoder().encode(s);
const files = {
  "config.json": enc('{"num_hidden_layers":2}'),
  "tokenizer.json": enc('{"model":{}}'),
  "tokenizer_config.json": enc('{"eos_token":"<|im_end|>"}'),
  "onnx/model_q4.onnx": Uint8Array.from({ length: 5000 }, (_, i) => (i * 31) % 251),
};

test("the model file holds everything, and gives each file back exactly", async () => {
  const pack = makePack({ name: "Tiny Test", model: "onnx/model_q4.onnx", pastType: "float32", repo: "x/y" }, files);
  const info = await packInfo(pack);
  assert.equal(info.name, "Tiny Test");
  assert.equal(info.model, "onnx/model_q4.onnx");
  assert.equal(info.pastType, "float32");
  const p = await openPack(pack);
  for (const [name, bytes] of Object.entries(files)) assert.deepEqual(await p.file(name), bytes, name);
  await assert.rejects(p.file("nope.json"), /no nope.json/);
});

test("a file that isn't a model file, or is cut short, is turned away", async () => {
  await assert.rejects(packInfo(new Blob([enc("<!doctype html><html>")])), /isn't a Hustle City model file/);
  await assert.rejects(packInfo(new Blob([])), /isn't a Hustle City model file/);
  const pack = makePack({ name: "Tiny Test", model: "onnx/model_q4.onnx", pastType: "float32" }, files);
  await assert.rejects(openPack(pack.slice(0, pack.size - 100)), /cut short/);
  // A model file missing its model.
  const { "onnx/model_q4.onnx": _, ...rest } = files;
  await assert.rejects(packInfo(makePack({ name: "Broken", model: "onnx/model_q4.onnx", pastType: "float32" }, rest)), /incomplete/);
});

test("a model's four files, downloaded by hand, become one model file", async () => {
  // Node has no `document`, which models.ts only touches when saving.
  const { packFromFiles, modelFiles, MODEL_CHOICES } = await import("../src/client/brain/models");
  const file = (name: string, bytes: Uint8Array) => new File([bytes as BlobPart], name);
  const cfg = enc('{"_name_or_path":"Qwen/Qwen2.5-0.5B-Instruct","model_type":"qwen2"}');
  // However the browser named them: "config (1).json" from a second download is fine.
  const pack = await packFromFiles([
    file("model_q4.onnx", files["onnx/model_q4.onnx"]),
    file("tokenizer_config.json", files["tokenizer_config.json"]),
    file("config (1).json", cfg),
    file("tokenizer.json", files["tokenizer.json"]),
  ]);
  const p = await openPack(pack);
  assert.equal(p.meta.name, "Qwen2.5 0.5B Instruct");
  assert.equal(p.meta.model, "onnx/model_q4.onnx");
  assert.equal(p.meta.pastType, "float32");
  assert.deepEqual(await p.file("onnx/model_q4.onnx"), files["onnx/model_q4.onnx"]);
  assert.deepEqual(await p.file("config.json"), cfg);
  assert.deepEqual(await p.file("tokenizer.json"), files["tokenizer.json"]);
  await assert.rejects(packFromFiles([file("config.json", cfg), file("model_q4.onnx", files["onnx/model_q4.onnx"])]), /missing: tokenizer.json, tokenizer_config.json/);
  // The links point at Hugging Face's download for each of the four.
  const links = modelFiles(MODEL_CHOICES[0]);
  assert.deepEqual(links.map((l) => l.name), ["config.json", "tokenizer.json", "tokenizer_config.json", "model_q4.onnx"]);
  assert.match(links[3].url, /^https:\/\/huggingface\.co\/HuggingFaceTB\/SmolLM2-360M-Instruct\/resolve\/main\/onnx\/model_q4\.onnx\?download=true$/);
});
