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
