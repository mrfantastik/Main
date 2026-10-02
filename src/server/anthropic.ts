import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient, LLMRequest, LLMResponse } from "../sim/ai/llm";

// Claude client for the AI director. Uses structured outputs (JSON schema)
// so replies are machine-checkable, and low effort to keep calls cheap.

/** Models that accept output_config.effort. */
function supportsEffort(model: string): boolean {
  return /opus|fable|sonnet-5|sonnet-4-6/.test(model);
}

/** Models with server-side refusal fallbacks ("default" form). */
function supportsFallbacks(model: string): boolean {
  return /^claude-(opus-5|fable-5-1|sonnet-5-5)/.test(model);
}

export function hasCredentials(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.AI_ENABLED === "1");
}

export function createClaudeClient(model: string, fetchImpl?: typeof fetch): LLMClient | null {
  if (!fetchImpl && (!hasCredentials() || process.env.AI_ENABLED === "0")) return null;
  const client = new Anthropic({ maxRetries: 1, timeout: 30_000, ...(fetchImpl ? { fetch: fetchImpl, apiKey: "test-key" } : {}) });

  return {
    model,
    async complete(req: LLMRequest): Promise<LLMResponse> {
      const format = { type: "json_schema" as const, schema: req.schema };
      let message: Anthropic.Message | Anthropic.Beta.BetaMessage;
      if (supportsFallbacks(model)) {
        message = await client.beta.messages.create({
          model,
          max_tokens: req.maxTokens,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "low", format },
          system: req.system,
          messages: [{ role: "user", content: req.user }],
        });
      } else {
        message = await client.messages.create({
          model,
          max_tokens: req.maxTokens,
          output_config: supportsEffort(model) ? { effort: "low", format } : { format },
          system: req.system,
          messages: [{ role: "user", content: req.user }],
        });
      }
      if (message.stop_reason === "refusal") throw new Error("Claude declined this request");
      let text = "";
      for (const block of message.content) if (block.type === "text") text += block.text;
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { json, inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens, model: message.model ?? model };
    },
  };
}
