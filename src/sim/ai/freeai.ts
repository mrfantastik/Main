import type { LLMClient, LLMRequest, LLMResponse } from "./llm";

// Free AI anyone can use: public chat endpoints that need no account and no
// key. Several are tried in turn, because free services come and go and
// rate-limit anonymous users: Pollinations (OpenAI-style), LLM7
// (OpenAI-style), and Pollinations' plain GET endpoint as a last resort.
// The player can add their own endpoint (any OpenAI-style URL, optional key)
// and it's tried first. A service that fails is rested for a while; the one
// that works is used until it doesn't. Works in Node (the server) and in the
// browser (the downloadable game): it only needs fetch.
//
// One thing no code can fix: pages published on claude.ai aren't allowed to
// reach the internet. There every service shows as unreachable and the
// built-in AI does the talking; the downloaded game file and `npm start`
// aren't affected.

export const FREE_AI_NAME = "Free AI";

export interface FreeProvider {
  id: string;
  name: string;
  /** Chat-completions URL (OpenAI style), or the base URL of a GET endpoint. */
  url: string;
  model: string;
  key?: string;
  kind: "chat" | "get";
}

export const FREE_PROVIDERS: FreeProvider[] = [
  { id: "pollinations", name: "Pollinations", url: "https://text.pollinations.ai/openai", model: "openai", kind: "chat" },
  { id: "llm7", name: "LLM7", url: "https://api.llm7.io/v1/chat/completions", model: "default", key: "unused", kind: "chat" },
  { id: "pollinations-get", name: "Pollinations (simple)", url: "https://text.pollinations.ai/", model: "openai", kind: "get" },
];

export interface FreeAIOptions {
  /** Use only this endpoint (tests, or a server pinned to one service). */
  url?: string;
  model?: string;
  key?: string;
  /** The player's own endpoint, tried before the built-in list. */
  custom?: { url: string; model?: string; key?: string } | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type ProviderState = "untried" | "ok" | "busy" | "unreachable" | "error";

export interface FreeAIStatus {
  /** A service answered recently. */
  connected: boolean;
  /** The service in use (or last used). */
  active: string | null;
  /** Every service failed to connect at all: the page's network is blocked (e.g. on claude.ai). */
  blocked: boolean;
  providers: { name: string; state: ProviderState; note: string }[];
}

/** Things the director and hosts can ask of a free client beyond completing. */
export interface FreeAIClient extends LLMClient {
  readonly free: true;
  status(): FreeAIStatus;
  /** Try every service with a tiny request; resolves with the status afterwards. */
  probe(): Promise<FreeAIStatus>;
  /** Set (or clear) the player's own endpoint. */
  setCustom(custom: FreeAIOptions["custom"]): void;
}

/** An error the director can act on (429: slow down; 0: couldn't reach it). */
export class FreeAIError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A JSON example of the shape a schema describes (small models follow examples better than schemas). */
export function shapeOf(schema: unknown): unknown {
  const s = (schema ?? {}) as { type?: unknown; properties?: Record<string, unknown>; items?: unknown; enum?: unknown[] };
  if (Array.isArray(s.enum)) return s.enum.slice(0, 4).join(" | ");
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  if (type === "object" || s.properties) return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, shapeOf(v)]));
  if (type === "array") return [shapeOf(s.items)];
  if (type === "number" || type === "integer") return 0;
  if (type === "boolean") return true;
  return "...";
}

/** Pull JSON out of a chatty reply (code fences, a sentence before it, a <think> block...). */
export function extractJson(text: string): unknown {
  const t = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    // fall through
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      // fall through
    }
  }
  // Last resort for dialogue: "A: ..." / "B: ..." lines.
  const lines = t
    .split(/\n+/)
    .map((l) => l.match(/^\s*\**\s*(A|B)\s*\**\s*[:\-–]\s*(.+)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ speaker: m[1], text: m[2].trim() }));
  return lines.length >= 2 ? { lines } : null;
}

/** For a model list: prefer small, fast, general chat models. */
export function pickModel(ids: string[]): string | null {
  const usable = ids.filter((id) => !/embed|whisper|tts|audio|image|vision|dall|moderation|coder|guard|rerank/i.test(id));
  const preferred = [/gpt-4o-mini|gpt-4\.1-nano|gpt-4\.1-mini|gpt-oss/i, /llama.*(8b|instruct)|mistral-small|gemma|qwen.*instruct/i, /mini|nano|small|fast|flash|turbo/i];
  for (const re of preferred) {
    const hit = usable.find((id) => re.test(id) && !/r1|reason|think/i.test(id));
    if (hit) return hit;
  }
  return usable[0] ?? null;
}

const REST_MS: Record<Exclude<ProviderState, "untried" | "ok">, number> = { busy: 30_000, unreachable: 3 * 60_000, error: 2 * 60_000 };

export function createFreeAIClient(opts: FreeAIOptions = {}): FreeAIClient {
  const doFetch = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const timeoutMs = opts.timeoutMs ?? 40_000;
  const fixed: FreeProvider[] | null = opts.url ? [{ id: "custom", name: "Your endpoint", url: opts.url, model: opts.model ?? "openai", key: opts.key, kind: "chat" }] : null;
  // Each client keeps its own copies (a service's model can change after asking it what it has).
  const builtins = FREE_PROVIDERS.map((p) => ({ ...p }));
  let custom: FreeProvider | null = null;
  const state = new Map<string, { state: ProviderState; note: string; until: number; modelTried?: boolean }>();
  let active: string | null = null;
  let lastOk = 0;
  let seed = Math.floor(Math.random() * 1e6);

  const list = (): FreeProvider[] => fixed ?? [...(custom ? [custom] : []), ...builtins];
  const st = (p: FreeProvider) => state.get(p.id) ?? { state: "untried" as ProviderState, note: "", until: 0 };
  const mark = (p: FreeProvider, s: ProviderState, note: string) => {
    const prev = st(p);
    state.set(p.id, { ...prev, state: s, note, until: s === "ok" ? 0 : Date.now() + REST_MS[s as keyof typeof REST_MS] });
  };

  async function timed(url: string, init: RequestInit): Promise<Response> {
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      return await doFetch(url, { ...init, signal: ctrl?.signal });
    } catch (err) {
      throw new FreeAIError(`couldn't connect (${(err as Error).message ?? err})`, 0);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function failure(res: Response): Promise<FreeAIError> {
    const body = await res.text().catch(() => "");
    return new FreeAIError(`answered ${res.status}${body ? `: ${body.replace(/\s+/g, " ").slice(0, 140)}` : ""}`, res.status);
  }

  /** Ask an OpenAI-style service for its models and pick a sensible one. */
  async function discoverModel(p: FreeProvider): Promise<string | null> {
    const url = p.url.replace(/\/chat\/completions\/?$/, "/models").replace(/\/openai\/?$/, "/models");
    try {
      const res = await timed(url, { headers: p.key ? { Authorization: `Bearer ${p.key}` } : undefined });
      if (!res.ok) return null;
      const data = (await res.json()) as { data?: { id?: string; name?: string }[] } | { id?: string; name?: string }[];
      const items = Array.isArray(data) ? data : (data.data ?? []);
      return pickModel(items.map((m) => String(m.id ?? m.name ?? "")).filter(Boolean));
    } catch {
      return null;
    }
  }

  async function callChat(p: FreeProvider, system: string, user: string): Promise<LLMResponse> {
    const isPollinations = /pollinations\.ai/.test(p.url);
    const res = await timed(p.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(p.key ? { Authorization: `Bearer ${p.key}` } : {}) },
      body: JSON.stringify({
        model: p.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.9,
        // Different every call, so every conversation is its own.
        seed: seed++,
        // Pollinations: keep the town's chatter out of the public feed, and say who's asking.
        ...(isPollinations ? { private: true, referrer: "ai-hustle-city" } : {}),
      }),
    });
    if (!res.ok) throw await failure(res);
    const data = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string } | null;
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new FreeAIError("sent back nothing", 502);
    return { json: extractJson(content), inputTokens: data?.usage?.prompt_tokens ?? 0, outputTokens: data?.usage?.completion_tokens ?? 0, model: `free:${data?.model ?? p.model}` };
  }

  /** Pollinations' plain endpoint: a GET with the prompt in the URL (no preflight, works almost anywhere). */
  async function callGet(p: FreeProvider, system: string, user: string): Promise<LLMResponse> {
    const q = new URLSearchParams({ model: p.model, json: "true", system, seed: String(seed++), private: "true", referrer: "ai-hustle-city" });
    let prompt = user;
    // Keep the URL a sane length: trim the middle of a long prompt (the instructions are at the end).
    const budget = 6000 - q.toString().length;
    if (encodeURIComponent(prompt).length > budget) prompt = `${prompt.slice(0, Math.floor(budget / 6))}\n…\n${prompt.slice(-Math.floor(budget / 5))}`;
    const res = await timed(`${p.url}${encodeURIComponent(prompt)}?${q.toString()}`, { method: "GET" });
    if (!res.ok) throw await failure(res);
    const text = await res.text();
    if (!text.trim()) throw new FreeAIError("sent back nothing", 502);
    return { json: extractJson(text), inputTokens: 0, outputTokens: 0, model: `free:${p.model}` };
  }

  async function complete(req: LLMRequest): Promise<LLMResponse> {
    const system = `${req.system}\nReply with only a JSON object shaped like this example (no markdown, no commentary):\n${JSON.stringify(shapeOf(req.schema))}`;
    const now = Date.now();
    const all = list();
    // The one that worked last time first, then the rest in order; rested ones last (or not at all).
    const ready = all.filter((p) => st(p).until <= now);
    const order = [...ready.filter((p) => p.id === active), ...ready.filter((p) => p.id !== active)];
    let last: FreeAIError | null = null;
    for (const p of order) {
      try {
        let res: LLMResponse;
        try {
          res = p.kind === "get" ? await callGet(p, system, req.user) : await callChat(p, system, req.user);
        } catch (err) {
          // Wrong or retired model name: ask the service what it has, once.
          const e = err as FreeAIError;
          if (p.kind === "chat" && (e.status === 400 || e.status === 404 || e.status === 422) && !st(p).modelTried) {
            state.set(p.id, { ...st(p), modelTried: true });
            const m = await discoverModel(p);
            if (!m || m === p.model) throw e;
            p.model = m;
            res = await callChat(p, system, req.user);
          } else throw e;
        }
        mark(p, "ok", `connected (${p.model})`);
        active = p.id;
        lastOk = Date.now();
        return res;
      } catch (err) {
        const e = err instanceof FreeAIError ? err : new FreeAIError(String((err as Error)?.message ?? err), 0);
        mark(p, e.status === 0 ? "unreachable" : e.status === 429 || e.status === 503 || e.status === 402 ? "busy" : "error", e.message);
        last = e;
      }
    }
    if (order.length === 0) throw new FreeAIError("every free AI service is resting after errors; trying again shortly", 429);
    const allUnreachable = all.every((p) => st(p).state === "unreachable");
    throw new FreeAIError(allUnreachable ? `couldn't reach any free AI service (${last?.message ?? "no connection"})` : `no free AI service could answer (${last?.message ?? "busy"})`, allUnreachable ? 0 : (last?.status ?? 429));
  }

  const client: FreeAIClient = {
    model: fixed ? fixed[0].model : "auto",
    free: true,
    label: FREE_AI_NAME,
    complete,
    status(): FreeAIStatus {
      const all = list();
      const tried = all.filter((p) => st(p).state !== "untried");
      return {
        connected: Date.now() - lastOk < 5 * 60_000 && active !== null,
        active: all.find((p) => p.id === active)?.name ?? null,
        blocked: tried.length === all.length && all.every((p) => st(p).state === "unreachable"),
        providers: all.map((p) => ({ name: p.name, state: st(p).state, note: st(p).note })),
      };
    },
    async probe(): Promise<FreeAIStatus> {
      // Forget the rests, then try each service directly with a tiny request.
      for (const p of list()) {
        const s = st(p);
        state.set(p.id, { ...s, until: 0 });
      }
      const req = { system: "Reply with JSON.", user: 'Reply with exactly {"ok": true}', schema: { type: "object", properties: { ok: { type: "boolean" } } }, maxTokens: 20 };
      for (const p of list()) {
        try {
          if (p.kind === "get") await callGet(p, req.system, req.user);
          else await callChat(p, req.system, req.user);
          mark(p, "ok", `connected (${p.model})`);
          if (!active || st(list().find((x) => x.id === active)!).state !== "ok") active = p.id;
          lastOk = Date.now();
        } catch (err) {
          const e = err as FreeAIError;
          if (p.kind === "chat" && (e.status === 400 || e.status === 404 || e.status === 422)) {
            const m = await discoverModel(p);
            if (m && m !== p.model) {
              p.model = m;
              try {
                await callChat(p, req.system, req.user);
                mark(p, "ok", `connected (${p.model})`);
                active ??= p.id;
                lastOk = Date.now();
                continue;
              } catch {
                // fall through to the failure below
              }
            }
          }
          mark(p, e.status === 0 ? "unreachable" : e.status === 429 || e.status === 503 || e.status === 402 ? "busy" : "error", e.message ?? String(e));
        }
      }
      return this.status();
    },
    setCustom(c) {
      custom = c && c.url ? { id: "custom", name: "Your endpoint", url: c.url.trim(), model: c.model?.trim() || "openai", key: c.key?.trim() || undefined, kind: "chat" } : null;
      state.delete("custom");
      if (custom) active = "custom";
    },
  };
  if (opts.custom) client.setCustom(opts.custom);
  return client;
}
