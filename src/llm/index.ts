import { config } from "../config.js";
import type { LLMProvider } from "./types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";

export type { LLMProvider } from "./types.js";

/**
 * Pick the provider: explicit LLM_PROVIDER wins, otherwise whichever API key
 * is present (Anthropic first).
 */
export function createProvider(): LLMProvider {
  let which = config.provider;
  if (which === "auto") {
    const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
    const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
    which = hasAnthropic ? "anthropic" : hasOpenAI ? "openai" : "anthropic";
  }
  return which === "openai" ? new OpenAIProvider() : new AnthropicProvider();
}
