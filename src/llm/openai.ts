import OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import { config, type Effort } from "../config.js";
import { SYSTEM_PROMPT } from "../agent/prompts.js";
import { TOOLS } from "../agent/tools.js";
import {
  LLMAuthError,
  LLMDailyLimitError,
  LLMTooLargeError,
  LLMTransientError,
  type LLMProvider,
  type ToolOutcome,
  type TurnCallbacks,
  type TurnResult,
} from "./types.js";

type Msg = OpenAI.Chat.ChatCompletionMessageParam;

/** Convert the shared (Anthropic-style) tool definitions to OpenAI function tools. */
function toOpenAITools(tools: Anthropic.Tool[], strictSupported: boolean): OpenAI.Chat.ChatCompletionTool[] {
  return tools
    .filter((t) => config.vision || t.name !== "screenshot")
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.input_schema as Record<string, unknown>,
        ...(strictSupported && t.strict ? { strict: true } : {}),
      },
    }));
}

/** Only OpenAI's own reasoning models accept `reasoning_effort`. */
function supportsReasoning(model: string): boolean {
  return !config.openaiBaseURL && /^(gpt-5|o\d)/.test(model);
}

/**
 * Any OpenAI-compatible Chat Completions endpoint: OpenAI itself, or a
 * gateway such as Groq, OpenRouter, Google's compatibility layer, Together or
 * a local Ollama - set OPENAI_BASE_URL and the matching key. Gateways vary in
 * what they accept, so `strict` schemas and `reasoning_effort` are only sent
 * to the official endpoint.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = config.openaiBaseURL ? `openai-compatible (${new URL(config.openaiBaseURL).host})` : "openai";
  private currentModel = config.openaiModel;
  private currentSubagentModel = config.openaiSubagentModel;
  private fallbacks = [...config.openaiFallbackModels];
  private subagentFallbacks = [...config.openaiFallbackModels];
  /** Free tiers cap output tokens per minute; we discover the ceiling at runtime. */
  private maxTokens = config.maxOutputTokens;

  get model(): string {
    return this.currentModel;
  }

  get subagentModel(): string {
    return this.currentSubagentModel;
  }

  switchModel(): string | null {
    const next = this.fallbacks.shift();
    if (!next) return null;
    this.currentModel = next;
    this.maxTokens = config.maxOutputTokens; // a new model may allow more
    return next;
  }

  /** Start the streamed completion, backing off the output ceiling if the gateway caps it. */
  private async openStream() {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client.chat.completions.create({
          model: this.model,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...this.messages],
          tools: this.tools,
          stream: true,
          stream_options: { include_usage: true },
          max_completion_tokens: this.maxTokens,
          ...(supportsReasoning(this.model) ? { reasoning_effort: config.effort } : {}),
        });
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (attempt < 4 && isOutputCeilingError(err) && this.lowerOutputCeiling(msg)) continue;
        throw err;
      }
    }
  }

  /**
   * Gateways reject a request whose *requested* output size exceeds a
   * per-minute output budget ("reduce max_tokens"). Lower our ceiling to what
   * the error reports and keep it for later calls. Returns false when there is
   * no more room to give.
   */
  private lowerOutputCeiling(message: string): boolean {
    const limit = Number(/limit[: ]+(\d+)/i.exec(message)?.[1]);
    const target = Number.isFinite(limit) && limit > 0 ? Math.max(256, limit - 64) : Math.floor(this.maxTokens / 2);
    if (target >= this.maxTokens) return false;
    this.maxTokens = target;
    return this.maxTokens >= 256;
  }
  private client = new OpenAI({ baseURL: config.openaiBaseURL || undefined, timeout: 120_000 });
  private tools = toOpenAITools(TOOLS, !config.openaiBaseURL);
  private messages: Msg[] = [];

  historyLength(): number {
    return this.messages.length;
  }

  addUserText(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  addToolResults(results: ToolOutcome[], note?: string): void {
    // Chat Completions tool messages are text-only; images ride in a follow-up user message.
    const extras: OpenAI.Chat.ChatCompletionContentPart[] = [];
    for (const r of results) {
      this.messages.push({ role: "tool", tool_call_id: r.id, content: (r.isError ? "Error: " : "") + r.text });
      if (r.image) {
        extras.push({ type: "text", text: `Screenshot returned by tool ${r.name}:` });
        extras.push({ type: "image_url", image_url: { url: `data:${r.image.mediaType};base64,${r.image.base64}`, detail: "high" } });
      }
    }
    if (note) extras.push({ type: "text", text: note });
    if (extras.length) this.messages.push({ role: "user", content: extras });
  }

  reset(): void {
    this.messages = [];
  }

  /**
   * Truncate long tool results (page snapshots are by far the biggest), keeping
   * the `keepLast` most recent ones intact - those are the page the agent is
   * looking at right now.
   */
  trimHistory(maxCharsPerResult: number, keepLast = 0): boolean {
    const toolIdx = this.messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
    const cutoff = toolIdx[toolIdx.length - keepLast] ?? Infinity;
    let changed = false;
    for (let i = 0; i < this.messages.length; i++) {
      if (i >= cutoff) break;
      const m = this.messages[i];
      if (m.role !== "tool" || typeof m.content !== "string") continue;
      if (m.content.length <= maxCharsPerResult) continue;
      m.content = m.content.slice(0, maxCharsPerResult) + "\n…[older observation trimmed; call get_page_state for a fresh view]";
      changed = true;
    }
    return changed;
  }

  async turn(cb: TurnCallbacks): Promise<TurnResult> {
    let text = "";
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | null = null;
    let usage: OpenAI.CompletionUsage | undefined;

    try {
      const stream = await this.openStream();
      for await (const chunk of stream) {
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.delta.content) {
          text += choice.delta.content;
          cb.onText(choice.delta.content);
        }
        // Reasoning models behind OpenAI-compatible gateways (gpt-oss on Groq,
        // DeepSeek R1, …) stream their thinking in a non-standard field.
        const reasoning = (choice.delta as { reasoning?: string; reasoning_content?: string }).reasoning ??
          (choice.delta as { reasoning_content?: string }).reasoning_content;
        if (reasoning) cb.onThinking(reasoning);
        for (const tc of choice.delta.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(tc.index, cur);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    } catch (err) {
      throw mapError(err);
    }

    const toolCallsRaw = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    const assistant: OpenAI.Chat.ChatCompletionAssistantMessageParam = { role: "assistant", content: text || null };
    if (toolCallsRaw.length) {
      assistant.tool_calls = toolCallsRaw.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } }));
    }
    this.messages.push(assistant);

    const toolCalls = toolCallsRaw.map((c) => {
      let input: Record<string, unknown> = {};
      try {
        input = c.args ? (JSON.parse(c.args) as Record<string, unknown>) : {};
      } catch {
        input = {};
      }
      return { id: c.id, name: c.name, input };
    });

    let stop: TurnResult["stop"] = "end_turn";
    if (finish === "content_filter") stop = "refusal";
    else if (finish === "length") stop = "max_tokens";
    else if (toolCalls.length) stop = "tool_use";

    return {
      text: text.trim(),
      toolCalls,
      stop,
      contextTokens: (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
    };
  }

  transcript(): string {
    const out: string[] = [];
    const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) + ` …[${s.length - n} more chars]` : s);
    for (const m of this.messages) {
      if (m.role === "user") {
        const text = typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "[screenshot]")).join("\n");
        out.push(`USER: ${trunc(text, 2000)}`);
      } else if (m.role === "assistant") {
        if (typeof m.content === "string" && m.content) out.push(`ASSISTANT: ${trunc(m.content, 2000)}`);
        for (const tc of m.tool_calls ?? []) {
          if (tc.type === "function") out.push(`→ ${tc.function.name}(${tc.function.arguments})`);
        }
      } else if (m.role === "tool") {
        const text = typeof m.content === "string" ? m.content : m.content.map((p) => p.text).join("\n");
        out.push(`← ${trunc(text, 1500)}`);
      }
    }
    return out.join("\n");
  }

  async complete(system: string, doc: string, question: string, effort: Effort): Promise<string> {
    let maxTokens = Math.min(4000, this.maxTokens);
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.currentSubagentModel,
          messages: [
            { role: "system", content: system },
            { role: "user", content: `${doc}\n\n${question}` },
          ],
          max_completion_tokens: maxTokens,
          ...(supportsReasoning(this.currentSubagentModel) ? { reasoning_effort: effort } : {}),
        });
        return (response.choices[0]?.message.content ?? "").trim();
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (attempt < 4 && isOutputCeilingError(err)) {
          const limit = Number(/limit[: ]+(\d+)/i.exec(msg)?.[1]);
          const next = Number.isFinite(limit) && limit > 0 ? Math.max(256, limit - 64) : Math.floor(maxTokens / 2);
          if (next < maxTokens && next >= 256) {
            maxTokens = next;
            continue;
          }
        }
        // The sub-agent has its own daily quota; move it to the next spare model.
        const mapped = mapError(err);
        if (attempt < 4 && mapped instanceof LLMDailyLimitError) {
          const next = this.subagentFallbacks.shift();
          if (next && next !== this.currentSubagentModel) {
            this.currentSubagentModel = next;
            continue;
          }
        }
        throw mapped;
      }
    }
  }
}

/** "reduce max_tokens": the gateway caps how much output one request may ask for. */
function isOutputCeilingError(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  const message = (err as Error).message ?? "";
  return (status === 429 || status === 400) && /output tokens per minute|\bOTPM\b|reduce max_tokens|expected output/i.test(message);
}

function mapError(err: unknown): Error {
  if (err instanceof OpenAI.AuthenticationError) return new LLMAuthError("OpenAI API authentication failed - check OPENAI_API_KEY.");
  const status = (err as { status?: number }).status;
  const message = (err as Error).message ?? "";
  // 413 on OpenAI-compatible gateways: over the context window, or over a
  // per-minute token budget that a single request cannot satisfy.
  if (status === 413) return new LLMTooLargeError(message.split("\n")[0]);
  // Smaller models sometimes emit malformed JSON in tool call arguments and the
  // gateway rejects the generation. Nothing was added to the history, so simply
  // asking again usually produces a valid call.
  if (status === 400 && /tool[_ ]call|arguments as JSON|failed to parse/i.test(message)) {
    return new LLMTransientError("model produced invalid tool-call JSON");
  }
  // A daily quota does not free up by waiting a few seconds - the caller has to
  // switch models or come back tomorrow.
  if (status === 429 && /per day|\bTPD\b|daily|quota/i.test(message)) {
    return new LLMDailyLimitError(message.split("\n")[0]);
  }
  if (err instanceof OpenAI.RateLimitError || err instanceof OpenAI.APIConnectionError || err instanceof OpenAI.InternalServerError) {
    return new LLMTransientError((err as Error).message.split("\n")[0]);
  }
  return err instanceof Error ? err : new Error(String(err));
}
