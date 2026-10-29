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

test("a model's four files, downloaded by hand, become one model file whatever the browser called them", async () => {
  // Node has no `document`, which models.ts only touches when saving.
  const { packFromFiles, modelFiles, MODEL_CHOICES } = await import("../src/client/brain/models");
  const file = (name: string, bytes: Uint8Array | string) => new File([(typeof bytes === "string" ? enc(bytes) : bytes) as BlobPart], name);
  const cfg = { _name_or_path: "Qwen/Qwen2.5-0.5B-Instruct", model_type: "qwen2", num_hidden_layers: 24 };
  const tok = { version: "1.0", added_tokens: [{ id: 0, content: "<|im_start|>" }], model: { type: "BPE", vocab: { a: 1, "é": 2 } } };
  const tokCfg = { eos_token: "<|im_end|>", chat_template: "{{ x & y < z }}", tokenizer_class: "Qwen2Tokenizer" };
  // An ONNX model starts with byte 0x08 (its IR version), whatever it's called.
  const onnxBytes = Uint8Array.from([0x08, 0x07, ...files["onnx/model_q4.onnx"].subarray(2)]);
  const html = (j: object) =>
    `<html><head></head><body><pre style="word-wrap: break-word;">${JSON.stringify(j).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}</pre></body></html>`;
  const pack = await packFromFiles([
    file("model_q4.onnx", onnxBytes),
    file("download", html(tokCfg)), // saved as a web page, with no name
    file("config (1).json", JSON.stringify(cfg)),
    file("tokenizer.json.txt", "\uFEFF" + JSON.stringify(tok)),
  ]);
  const p = await openPack(pack);
  assert.equal(p.meta.name, "Qwen2.5 0.5B Instruct");
  assert.equal(p.meta.repo, "onnx-community/Qwen2.5-0.5B-Instruct");
  assert.equal(p.meta.model, "onnx/model_q4.onnx");
  assert.equal(p.meta.pastType, "float32");
  const back = async (n: string) => JSON.parse(new TextDecoder().decode(await p.file(n)));
  assert.deepEqual(await p.file("onnx/model_q4.onnx"), onnxBytes);
  assert.deepEqual(await back("config.json"), cfg);
  assert.deepEqual(await back("tokenizer.json"), tok);
  assert.deepEqual(await back("tokenizer_config.json"), tokCfg);
  // A model file without its .onnx name is still found, by its first byte.
  assert.equal((await openPack(await packFromFiles([file("model", onnxBytes), file("a", JSON.stringify(cfg)), file("b", JSON.stringify(tok)), file("c", JSON.stringify(tokCfg))]))).meta.model, "onnx/model_q4.onnx");
  await assert.rejects(packFromFiles([file("config.json", JSON.stringify(cfg)), file("model_q4.onnx", onnxBytes)]), /missing: tokenizer.json, tokenizer_config.json/);
  await assert.rejects(packFromFiles([file("tokenizer.json.webarchive", "bplist00...")]), /Safari web archive.*Page Source/);
  // The links point at Hugging Face's download for each of the four.
  const links = modelFiles(MODEL_CHOICES[0]);
  assert.deepEqual(links.map((l) => l.name), ["config.json", "tokenizer.json", "tokenizer_config.json", "model_q4.onnx"]);
  assert.match(links[3].url, /^https:\/\/huggingface\.co\/HuggingFaceTB\/SmolLM2-360M-Instruct\/resolve\/main\/onnx\/model_q4\.onnx\?download=true$/);
});
