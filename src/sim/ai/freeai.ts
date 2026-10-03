import type { LLMClient, LLMRequest, LLMResponse } from "./llm";

// A free AI anyone can use: Pollinations' public text endpoint. No account,
// no API key, no cost; it speaks the OpenAI chat format and allows calls
// straight from a web page. It's a smaller model than Claude and it's rate
// limited, so the director spaces calls out, backs off when told to slow
// down, and the built-in AI fills in whenever it's busy or unreachable.
// Works the same in Node (the server) and in the browser (the standalone
// build): it only needs fetch.

export const FREE_AI_URL = "https://text.pollinations.ai/openai";
export const FREE_AI_NAME = "Free AI (Pollinations)";

export interface FreeAIOptions {
  url?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
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

/** Pull JSON out of a chatty reply (code fences, a sentence before it...). */
export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
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

export function createFreeAIClient(opts: FreeAIOptions = {}): LLMClient {
  const url = opts.url ?? FREE_AI_URL;
  const model = opts.model ?? "openai";
  const doFetch = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const timeoutMs = opts.timeoutMs ?? 40_000;
  let seed = Math.floor(Math.random() * 1e6);
  return {
    model,
    free: true,
    label: FREE_AI_NAME,
    async complete(req: LLMRequest): Promise<LLMResponse> {
      const system = `${req.system}\nReply with only a JSON object shaped like this example (no markdown, no commentary):\n${JSON.stringify(shapeOf(req.schema))}`;
      const ctrl = typeof AbortController === "function" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: req.user },
            ],
            response_format: { type: "json_object" },
            // Different every call, so every conversation is its own.
            seed: seed++,
            // Keep the town's chatter out of Pollinations' public feed.
            private: true,
            referrer: "ai-hustle-city",
          }),
          signal: ctrl?.signal,
        });
      } catch (err) {
        throw new FreeAIError(`Couldn't reach the free AI: ${(err as Error).message ?? err}`, 0);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new FreeAIError(`Free AI said ${res.status}${body ? `: ${body.slice(0, 120)}` : ""}`, res.status);
      }
      const data = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string } | null;
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new FreeAIError("The free AI sent back nothing", 502);
      return { json: extractJson(content), inputTokens: data?.usage?.prompt_tokens ?? 0, outputTokens: data?.usage?.completion_tokens ?? 0, model: `free:${data?.model ?? model}` };
    },
  };
}
