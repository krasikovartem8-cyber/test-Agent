import Anthropic from "@anthropic-ai/sdk";
import { config, type Effort } from "../config.js";
import { SYSTEM_PROMPT } from "../agent/prompts.js";
import { TOOLS } from "../agent/tools.js";
import { LLMAuthError, LLMTransientError, type LLMProvider, type ToolOutcome, type TurnCallbacks, type TurnResult } from "./types.js";

/** Claude via the Anthropic Messages API (streaming, adaptive thinking, prompt caching). */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly model = config.model;
  readonly subagentModel = config.subagentModel;
  private client = new Anthropic();
  private messages: Anthropic.MessageParam[] = [];

  historyLength(): number {
    return this.messages.length;
  }

  addUserText(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  addToolResults(results: ToolOutcome[], note?: string): void {
    const content: Anthropic.ContentBlockParam[] = results.map((r) => ({
      type: "tool_result",
      tool_use_id: r.id,
      is_error: r.isError || undefined,
      content: r.image
        ? [
            { type: "text", text: r.text },
            { type: "image", source: { type: "base64", media_type: r.image.mediaType, data: r.image.base64 } },
          ]
        : r.text,
    }));
    if (note) content.push({ type: "text", text: note });
    this.messages.push({ role: "user", content });
  }

  reset(): void {
    this.messages = [];
  }

  /**
   * Not supported: a thinking block's signature covers every earlier message,
   * so rewriting a past tool result invalidates the rest of the conversation.
   * The agent falls back to compaction instead.
   */
  trimHistory(_maxCharsPerResult: number, _keepLast?: number): boolean {
    return false;
  }

  async turn(cb: TurnCallbacks): Promise<TurnResult> {
    let message: Anthropic.Message;
    try {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: 16_000,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        messages: this.messages,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: config.effort },
      });
      stream.on("text", (d) => cb.onText(d));
      stream.on("thinking", (d) => cb.onThinking(d));
      message = await stream.finalMessage();
    } catch (err) {
      throw mapError(err);
    }

    // Append the full content (thinking blocks included) - required for tool use with thinking.
    this.messages.push({ role: "assistant", content: message.content });

    const usage = message.usage;
    const contextTokens =
      usage.input_tokens +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      usage.output_tokens;

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const toolCalls = message.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));

    let stop: TurnResult["stop"] = "end_turn";
    if (message.stop_reason === "refusal") stop = "refusal";
    else if (message.stop_reason === "max_tokens") stop = "max_tokens";
    else if (toolCalls.length) stop = "tool_use";

    return {
      text,
      toolCalls,
      stop,
      refusalReason: message.stop_details?.type === "refusal" ? message.stop_details.explanation ?? undefined : undefined,
      contextTokens,
    };
  }

  transcript(): string {
    const out: string[] = [];
    const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) + ` …[${s.length - n} more chars]` : s);
    for (const m of this.messages) {
      if (typeof m.content === "string") {
        out.push(`${m.role.toUpperCase()}: ${m.content}`);
        continue;
      }
      for (const block of m.content) {
        if (block.type === "text") out.push(`${m.role.toUpperCase()}: ${trunc(block.text, 2000)}`);
        else if (block.type === "tool_use") out.push(`→ ${block.name}(${JSON.stringify(block.input)})`);
        else if (block.type === "tool_result") {
          const c = block.content;
          const text = typeof c === "string" ? c : (c ?? []).map((b) => (b.type === "text" ? b.text : "[screenshot]")).join("\n");
          out.push(`← ${block.is_error ? "ERROR: " : ""}${trunc(text, 1500)}`);
        }
      }
    }
    return out.join("\n");
  }

  async complete(system: string, doc: string, question: string, effort: Effort): Promise<string> {
    try {
      const response = await this.client.messages.create({
        model: this.subagentModel,
        max_tokens: 4000,
        system,
        output_config: { effort },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: doc, cache_control: { type: "ephemeral" } },
              { type: "text", text: question },
            ],
          },
        ],
      });
      if (response.stop_reason === "refusal") return "(model declined to answer)";
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
    } catch (err) {
      throw mapError(err);
    }
  }
}

function mapError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) return new LLMAuthError("Anthropic API authentication failed - check ANTHROPIC_API_KEY.");
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.InternalServerError) {
    return new LLMTransientError((err as Error).message.split("\n")[0]);
  }
  return err instanceof Error ? err : new Error(String(err));
}
