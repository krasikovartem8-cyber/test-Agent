import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { BrowserController } from "../browser/Browser.js";
import { formatSnapshot } from "../browser/snapshot.js";
import { ContextManager } from "./context.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { TOOLS } from "./tools.js";
import { queryPage } from "./subagent.js";
import type { AgentUI } from "../ui/types.js";

export interface TaskResult {
  status: "success" | "partial" | "failed" | "aborted";
  summary: string;
}

type ToolInput = Record<string, unknown>;
type ToolResultContent = Exclude<Anthropic.ToolResultBlockParam["content"], undefined>;

/**
 * The autonomous agent loop: model turn -> execute tool calls -> feed results
 * back -> repeat, until the model calls `finish`, asks the user, or runs out of
 * steps. There is no plan and no site knowledge here; the model decides.
 */
export class Agent {
  readonly ctx: ContextManager;

  constructor(
    private client: Anthropic,
    private browser: BrowserController,
    private ui: AgentUI,
  ) {
    this.ctx = new ContextManager(client);
  }

  async runTask(task: string): Promise<TaskResult> {
    this.ctx.startTask(task);
    let steps = 0;

    while (true) {
      if (steps >= config.maxSteps) {
        const go = await this.ui.confirm(`The agent has used ${steps} steps. Continue?`);
        if (!go) return { status: "aborted", summary: "Stopped by the user after reaching the step limit." };
        steps = 0;
      }

      const message = await this.modelTurn();
      this.ctx.recordUsage(message.usage);
      this.ctx.push({ role: "assistant", content: message.content });

      if (message.stop_reason === "refusal") {
        const why = message.stop_details?.type === "refusal" ? message.stop_details.explanation ?? "" : "";
        return { status: "failed", summary: `The model declined to continue. ${why}`.trim() };
      }
      if (message.stop_reason === "max_tokens") {
        this.ctx.push({ role: "user", content: "Your previous response was cut off. Continue with the next tool call." });
        continue;
      }

      const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) {
        // Model ended its turn with text only: treat it as the final report.
        const text = message.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        return { status: "partial", summary: text || "(no report)" };
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      let finished: TaskResult | null = null;
      let stuck = false;

      for (const tu of toolUses) {
        const input = (tu.input ?? {}) as ToolInput;
        this.ui.toolCall(tu.name, input);
        if (this.ctx.trackCall(tu.name, input)) stuck = true;

        if (tu.name === "finish") {
          finished = {
            status: (input.status as TaskResult["status"]) ?? "success",
            summary: String(input.summary ?? ""),
          };
          results.push({ type: "tool_result", tool_use_id: tu.id, content: "Task marked as finished." });
          continue;
        }

        try {
          const content = await this.execute(tu.name, input);
          const shown = typeof content === "string" ? content : content.map((c) => (c.type === "text" ? c.text : "[screenshot attached]")).join("\n");
          this.ui.toolResult(tu.name, shown, false);
          results.push({ type: "tool_result", tool_use_id: tu.id, content });
        } catch (err) {
          const msg = err instanceof Error ? err.message.split("\n").slice(0, 3).join(" ") : String(err);
          this.ui.toolResult(tu.name, msg, true);
          results.push({ type: "tool_result", tool_use_id: tu.id, content: `Error: ${msg}`, is_error: true });
        }
      }

      const userContent: Anthropic.ContentBlockParam[] = [...results];
      if (stuck) {
        userContent.push({
          type: "text",
          text: "Note: you have issued the same action three times in a row. It is not working - change your approach (scroll, keyboard, another element, query_page, a screenshot, or a different path).",
        });
      }
      this.ctx.push({ role: "user", content: userContent });
      steps++;

      if (finished) return finished;

      if (this.ctx.needsCompaction()) {
        this.ui.info(`Context is ${Math.round(this.ctx.contextTokens / 1000)}k tokens - compacting history…`);
        await this.ctx.compact(this.browser.page.url());
        this.ui.info("Context compacted; continuing from the summary.");
      }
    }
  }

  /** One streamed model turn with retries on transient API errors. */
  private async modelTurn(): Promise<Anthropic.Message> {
    let attempt = 0;
    while (true) {
      try {
        const stream = this.client.messages.stream({
          model: config.model,
          max_tokens: 16_000,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          tools: TOOLS,
          messages: this.ctx.messages,
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: config.effort },
        });
        stream.on("text", (delta) => this.ui.assistantText(delta));
        stream.on("thinking", (delta) => this.ui.thinking(delta));
        const message = await stream.finalMessage();
        this.ui.turnEnd();
        return message;
      } catch (err) {
        this.ui.turnEnd();
        if (err instanceof Anthropic.AuthenticationError) {
          throw new Error("Anthropic API authentication failed - check ANTHROPIC_API_KEY.");
        }
        const transient =
          err instanceof Anthropic.RateLimitError ||
          err instanceof Anthropic.APIConnectionError ||
          err instanceof Anthropic.InternalServerError;
        if (transient && attempt < 4) {
          attempt++;
          const delay = 3000 * attempt;
          this.ui.warn(`API error (${(err as Error).message.split("\n")[0]}); retrying in ${delay / 1000}s…`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  }

  private async execute(name: string, input: ToolInput): Promise<ToolResultContent> {
    const b = this.browser;
    switch (name) {
      case "navigate":
        return (await b.navigate(String(input.url))).message;
      case "get_page_state": {
        const snap = await b.snapshot();
        const text = formatSnapshot(snap, config.snapshotTextChars, config.snapshotMaxElements);
        if (input.include_screenshot) {
          const shot = await b.screenshot();
          return [
            { type: "text", text },
            { type: "image", source: { type: "base64", media_type: shot.mediaType, data: shot.base64 } },
          ];
        }
        return text;
      }
      case "screenshot": {
        const shot = await b.screenshot();
        return [
          { type: "text", text: `Screenshot of the viewport at ${b.page.url()}` },
          { type: "image", source: { type: "base64", media_type: shot.mediaType, data: shot.base64 } },
        ];
      }
      case "click":
        return (await b.click(Number(input.ref))).message;
      case "click_at":
        return (await b.clickAt(Number(input.x), Number(input.y))).message;
      case "type_text":
        return (
          await b.type(Number(input.ref), String(input.text), {
            clear: input.clear === undefined ? true : Boolean(input.clear),
            pressEnter: Boolean(input.press_enter),
          })
        ).message;
      case "press_key":
        return (await b.pressKey(String(input.key))).message;
      case "scroll":
        return (
          await b.scroll(
            input.direction as "up" | "down" | "left" | "right",
            input.pixels === undefined ? undefined : Number(input.pixels),
            input.ref === undefined ? undefined : Number(input.ref),
          )
        ).message;
      case "select_option":
        return (await b.selectOption(Number(input.ref), String(input.value))).message;
      case "hover":
        return (await b.hover(Number(input.ref))).message;
      case "wait":
        return (await b.wait(Number(input.seconds))).message;
      case "go_back":
        return (await b.goBack()).message;
      case "list_tabs":
        return b.listTabs();
      case "switch_tab":
        return (await b.switchTab(Number(input.index))).message;
      case "get_page_text": {
        const full = await b.pageText();
        const offset = Math.max(0, Number(input.offset ?? 0));
        const max = Math.min(20_000, Math.max(200, Number(input.max_chars ?? 6000)));
        const chunk = full.slice(offset, offset + max);
        const rest = full.length - (offset + chunk.length);
        return `[chars ${offset}-${offset + chunk.length} of ${full.length}${rest > 0 ? `, ${rest} remaining` : ""}]\n${chunk}`;
      }
      case "query_page": {
        // Always read the live page so the sub-agent sees the current state.
        const snap = await b.snapshot();
        const answer = await queryPage(this.client, String(input.question), snap);
        this.ui.subagentAnswer(answer);
        return `DOM sub-agent answer (refs refer to the page as it is right now):\n${answer}`;
      }
      case "remember":
        this.ctx.notes.push(String(input.note));
        return `Saved. You now have ${this.ctx.notes.length} note(s).`;
      case "ask_user": {
        const answer = await this.ui.askUser(String(input.question));
        return answer.trim() ? `User answered: ${answer}` : "User gave no answer. Proceed with your best judgement or finish with status partial.";
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
