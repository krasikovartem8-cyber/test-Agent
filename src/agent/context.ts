import { config } from "../config.js";
import { compactionPrompt } from "./prompts.js";
import type { LLMProvider } from "../llm/types.js";

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
  notes: string[] = [];
  task = "";
  /** Size of the context as of the last model response. */
  contextTokens = 0;
  /** Sum of prompt+completion tokens across all turns of the current task. */
  billedTokens = 0;
  turns = 0;
  compactions = 0;
  private recentCalls: string[] = [];
  private recentNames: string[] = [];

  constructor(private llm: LLMProvider) {}

  startTask(task: string): void {
    this.task = task;
    this.recentCalls = [];
    this.recentNames = [];
    this.billedTokens = 0;
    this.turns = 0;
    this.llm.addUserText(task);
  }

  reset(): void {
    this.llm.reset();
    this.notes = [];
    this.contextTokens = 0;
    this.recentCalls = [];
    this.recentNames = [];
  }

  recordUsage(contextTokens: number): void {
    this.contextTokens = contextTokens;
    // Every call re-sends the history, so this is what the provider actually bills.
    this.billedTokens += contextTokens;
    this.turns++;
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
    this.recentNames.push(name);
    if (this.recentCalls.length > 6) this.recentCalls.shift();
    if (this.recentNames.length > 6) this.recentNames.shift();

    // Three identical calls among the last six count as stuck even when the
    // agent interleaves them with observations.
    const identical = this.recentCalls.filter((s) => s === sig).length >= 3;
    // Also catch rephrased repetition: the same tool four times running, e.g.
    // asking the sub-agent the same question in slightly different words.
    const sameTool = this.recentNames.filter((t) => t === name).length >= 4;
    return identical || sameTool;
  }

  /** Summarize everything so far and restart the history from the summary. */
  async compact(currentUrl: string): Promise<string> {
    // Keep the tail: the summarizer runs on the cheaper model, which may have a
    // much smaller context (or a per-minute token budget) than the main one.
    const full = this.llm.transcript();
    const transcript = full.length > config.transcriptChars ? "…[earlier steps omitted]\n" + full.slice(-config.transcriptChars) : full;
    const summary = await this.llm.complete(compactionPrompt(this.task, this.notes), `TRANSCRIPT:\n${transcript}`, "Write the progress summary now.", "medium");

    this.compactions++;
    this.llm.reset();
    this.llm.addUserText(
      `Task: ${this.task}\n\n` +
        `[Your context was compacted (#${this.compactions}). Progress summary of your work so far:]\n${summary}\n\n` +
        `Your saved notes:\n${this.notes.length ? this.notes.map((n) => "- " + n).join("\n") : "(none)"}\n\n` +
        `The browser is still open at ${currentUrl}. Continue the task from the current state: call get_page_state first (old element refs are invalid).`,
    );
    this.contextTokens = 0;
    return summary;
  }
}
