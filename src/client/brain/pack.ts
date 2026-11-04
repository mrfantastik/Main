// The model file (hustle-model.bin): everything the town's brain needs in one
// file, so the game can come in three parts (the page, the AI engine and the
// model) and the model can be loaded from disk, with no download.
//
//   "HUSTLEMODEL1"  12 bytes
//   header length   4 bytes, little-endian
//   header          JSON: { name, model, pastType, files: { "config.json": [offset, length], ... } }
//   data            the files, one after another (offsets count from the start of the data)
//
// It's also kept in the browser (IndexedDB), so after the first time the brain
// wakes by itself.

const MAGIC = "HUSTLEMODEL1";

export interface PackMeta {
  /** Display name, e.g. "Qwen2.5 1.5B Instruct". */
  name: string;
  /** The ONNX file's name in the pack. */
  model: string;
  pastType: "float32" | "float16";
  /** Where it came from (a Hugging Face repo), for the record. */
  repo?: string;
  files: Record<string, [number, number]>;
}

/** Put the files together into one model file. */
export function makePack(meta: Omit<PackMeta, "files">, files: Record<string, Blob | Uint8Array>): Blob {
  const index: Record<string, [number, number]> = {};
  let offset = 0;
  const parts: BlobPart[] = [];
  for (const [name, f] of Object.entries(files)) {
    const size = f instanceof Blob ? f.size : f.byteLength;
    index[name] = [offset, size];
    offset += size;
    parts.push(f as BlobPart);
  }
  const header = new TextEncoder().encode(JSON.stringify({ ...meta, files: index }));
  const head = new Uint8Array(MAGIC.length + 4);
  head.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(head.buffer).setUint32(MAGIC.length, header.byteLength, true);
  return new Blob([head, header, ...parts], { type: "application/octet-stream" });
}

function parseHead(bytes: Uint8Array): { meta: PackMeta; dataStart: number } {
  if (bytes.byteLength < MAGIC.length + 4 || new TextDecoder().decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) throw new Error("that isn't a Hustle City model file (hustle-model.bin)");
  const len = new DataView(bytes.buffer, bytes.byteOffset + MAGIC.length, 4).getUint32(0, true);
  if (bytes.byteLength < MAGIC.length + 4 + len) throw new Error("the model file is incomplete");
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(MAGIC.length + 4, MAGIC.length + 4 + len))) as PackMeta;
  if (!meta.files?.[meta.model] || !meta.files["config.json"] || !meta.files["tokenizer.json"]) throw new Error("the model file is incomplete");
  return { meta, dataStart: MAGIC.length + 4 + len };
}

async function head(blob: Blob): Promise<{ meta: PackMeta; dataStart: number }> {
  const start = new Uint8Array(await blob.slice(0, MAGIC.length + 4).arrayBuffer());
  const len = start.byteLength === MAGIC.length + 4 ? new DataView(start.buffer).getUint32(MAGIC.length, true) : 0;
  return parseHead(new Uint8Array(await blob.slice(0, MAGIC.length + 4 + Math.min(len, 1 << 20)).arrayBuffer()));
}

/** Open a model file: what it is, and each file in it (read only when asked for, so a big model isn't copied twice). */
export async function openPack(blob: Blob): Promise<{ meta: PackMeta; file: (name: string) => Promise<Uint8Array> }> {
  const { meta, dataStart } = await head(blob);
  if (dataStart + Math.max(...Object.values(meta.files).map(([o, n]) => o + n)) > blob.size) throw new Error("the model file is cut short (did it finish downloading?)");
  return {
    meta,
    file: async (name) => {
      const at = meta.files[name];
      if (!at) throw new Error(`the model file has no ${name}`);
      return new Uint8Array(await blob.slice(dataStart + at[0], dataStart + at[0] + at[1]).arrayBuffer());
    },
  };
}

/** Just what a model file is (reads only its start). */
export async function packInfo(blob: Blob): Promise<PackMeta> {
  return (await head(blob)).meta;
}

// ------------------------------------------------- kept in the browser

const DB = "hustle-brain";
const STORE = "model";

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("this browser won't store the model"));
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(d.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("browser storage failed"));
    });
  } finally {
    d.close();
  }
}

/** Keep the model file in this browser. */
export async function storePack(blob: Blob): Promise<void> {
  await tx("readwrite", (s) => s.put(blob, "pack"));
}

/** The model file kept in this browser, if there is one. */
export async function storedPack(): Promise<Blob | null> {
  try {
    return ((await tx("readonly", (s) => s.get("pack"))) as Blob | undefined) ?? null;
  } catch {
    return null; // no storage here (a private window): nothing kept
  }
}

export async function forgetPack(): Promise<void> {
  try {
    await tx("readwrite", (s) => s.delete("pack"));
  } catch {
    // nothing to forget
  }
}
