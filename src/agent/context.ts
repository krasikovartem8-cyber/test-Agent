import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { compactionPrompt } from "./prompts.js";

/**
 * Context management for the agent loop.
 *
 * Design notes (see README, "Управление контекстом"):
 *  - The history is append-only between compactions. We never rewrite earlier
 *    turns: on current models thinking blocks are bound to the exact prefix
 *    that produced them, so editing old tool results would invalidate them.
 *  - Observations are kept small at the source instead: capped snapshots,
 *    chunked page text, and a DOM sub-agent that reads long pages out of band.
 *  - When the live context still grows past the limit, we do "simple
 *    compaction": the whole history is summarized into one message (plus the
 *    agent's explicit notes) and the conversation restarts from it.
 *  - Notes written with `remember` live outside the history and are re-injected
 *    after every compaction, so hard facts are never lost to summarization.
 */
export class ContextManager {
  messages: Anthropic.MessageParam[] = [];
  notes: string[] = [];
  task = "";
  /** Size of the context as of the last API response (input + output tokens). */
  contextTokens = 0;
  compactions = 0;
  private recentCalls: string[] = [];

  constructor(private client: Anthropic) {}

  startTask(task: string): void {
    this.task = task;
    this.recentCalls = [];
    this.messages.push({ role: "user", content: task });
  }

  push(message: Anthropic.MessageParam): void {
    this.messages.push(message);
  }

  reset(): void {
    this.messages = [];
    this.notes = [];
    this.contextTokens = 0;
    this.recentCalls = [];
  }

  recordUsage(usage: Anthropic.Usage): void {
    this.contextTokens =
      usage.input_tokens +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      usage.output_tokens;
  }

  needsCompaction(): boolean {
    return this.contextTokens > config.contextTokenLimit;
  }

  /**
   * Returns true when the same non-trivial action was issued three times in a
   * row - a sign the agent is stuck. The caller nudges it to change strategy.
   */
  trackCall(name: string, input: unknown): boolean {
    if (name === "wait" || name === "scroll" || name === "get_page_state" || name === "screenshot") return false;
    const sig = name + JSON.stringify(input);
    this.recentCalls.push(sig);
    if (this.recentCalls.length > 6) this.recentCalls.shift();
    const n = this.recentCalls.length;
    return n >= 3 && this.recentCalls[n - 1] === sig && this.recentCalls[n - 2] === sig && this.recentCalls[n - 3] === sig;
  }

  /** Human-readable transcript of the history (images dropped, long results truncated). */
  private transcript(): string {
    const out: string[] = [];
    const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) + ` …[${s.length - n} more chars]` : s);
    for (const m of this.messages) {
      if (typeof m.content === "string") {
        out.push(`${m.role.toUpperCase()}: ${m.content}`);
        continue;
      }
      for (const block of m.content) {
        switch (block.type) {
          case "text":
            out.push(`${m.role.toUpperCase()}: ${trunc(block.text, 2000)}`);
            break;
          case "tool_use":
            out.push(`→ ${block.name}(${JSON.stringify(block.input)})`);
            break;
          case "tool_result": {
            const c = block.content;
            const text =
              typeof c === "string"
                ? c
                : (c ?? [])
                    .map((b) => (b.type === "text" ? b.text : "[screenshot]"))
                    .join("\n");
            out.push(`← ${block.is_error ? "ERROR: " : ""}${trunc(text, 1500)}`);
            break;
          }
          default:
            break; // thinking, images etc.
        }
      }
    }
    return out.join("\n");
  }

  /** Summarize everything so far and restart the history from the summary. */
  async compact(currentUrl: string): Promise<string> {
    const transcript = this.transcript();
    const response = await this.client.messages.create({
      model: config.subagentModel,
      max_tokens: 4000,
      system: compactionPrompt(this.task, this.notes),
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: `TRANSCRIPT:\n${transcript}` }],
    });
    const summary = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    this.compactions++;
    this.messages = [
      {
        role: "user",
        content:
          `Task: ${this.task}\n\n` +
          `[Your context was compacted (#${this.compactions}). Progress summary of your work so far:]\n${summary}\n\n` +
          `Your saved notes:\n${this.notes.length ? this.notes.map((n) => "- " + n).join("\n") : "(none)"}\n\n` +
          `The browser is still open at ${currentUrl}. Continue the task from the current state: call get_page_state first (old element refs are invalid).`,
      },
    ];
    this.contextTokens = 0;
    return summary;
  }
}
