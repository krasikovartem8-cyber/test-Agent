import type { Effort } from "../config.js";

/** A tool call requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** What we send back for one tool call. */
export interface ToolOutcome {
  id: string;
  name: string;
  text: string;
  image?: { base64: string; mediaType: "image/jpeg" | "image/png" };
  isError?: boolean;
}

export interface TurnResult {
  text: string;
  toolCalls: ToolCall[];
  stop: "tool_use" | "end_turn" | "max_tokens" | "refusal";
  refusalReason?: string;
  /** Size of the context after this turn (prompt + completion tokens). */
  contextTokens: number;
}

export interface TurnCallbacks {
  onText(delta: string): void;
  onThinking(delta: string): void;
}

/** Thrown by providers for errors worth retrying (rate limit, network, 5xx). */
export class LLMTransientError extends Error {}
/** Thrown for bad credentials. */
export class LLMAuthError extends Error {}
/** The request exceeded the model's context or a per-minute token limit. */
export class LLMTooLargeError extends Error {}

/**
 * A model provider owns the conversation history in its native format, so the
 * agent loop and context manager stay provider-agnostic.
 */
export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly subagentModel: string;

  /** Number of messages in the history (excluding the system prompt). */
  historyLength(): number;
  addUserText(text: string): void;
  /** Append tool results (and an optional extra note for the model) after a tool_use turn. */
  addToolResults(results: ToolOutcome[], note?: string): void;
  /** Drop the whole history. */
  reset(): void;
  /**
   * Shrink oversized tool results already in the history so a too-large
   * request can be retried. Returns false when the provider cannot edit its
   * history safely (Anthropic binds thinking blocks to the exact prefix).
   */
  trimHistory(maxCharsPerResult: number, keepLast?: number): boolean;
  /** Run one model turn over the current history and append the assistant reply. */
  turn(cb: TurnCallbacks): Promise<TurnResult>;
  /** Plain-text transcript of the history (for compaction). */
  transcript(): string;
  /** One-shot request on the cheaper model: `doc` is a (cacheable) document, `question` the ask. */
  complete(system: string, doc: string, question: string, effort: Effort): Promise<string>;
}
