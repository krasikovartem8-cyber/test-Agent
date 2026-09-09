import { config } from "../config.js";
import { BrowserController, shortUrl } from "../browser/Browser.js";
import { formatSnapshot } from "../browser/snapshot.js";
import { ContextManager } from "./context.js";
import { queryPage } from "./subagent.js";
import {
  LLMAuthError,
  LLMDailyLimitError,
  LLMTooLargeError,
  LLMTransientError,
  type LLMProvider,
  type ToolOutcome,
  type TurnResult,
} from "../llm/types.js";
import type { AgentUI } from "../ui/types.js";

export interface TaskResult {
  status: "success" | "partial" | "failed" | "aborted";
  summary: string;
}

type ToolInput = Record<string, unknown>;
type ExecResult = { text: string; image?: ToolOutcome["image"] };

/**
 * The autonomous agent loop: model turn -> execute tool calls -> feed results
 * back -> repeat, until the model calls `finish`, asks the user, or runs out of
 * steps. There is no plan and no site knowledge here; the model decides.
 */
export class Agent {
  readonly ctx: ContextManager;
  private captchaPauses = 0;

  constructor(
    private llm: LLMProvider,
    private browser: BrowserController,
    private ui: AgentUI,
  ) {
    this.ctx = new ContextManager(llm);
  }

  async runTask(task: string): Promise<TaskResult> {
    this.ctx.startTask(task);
    let steps = 0;
    let emptyTurns = 0;
    let textOnlyTurns = 0;
    this.captchaPauses = 0;

    while (true) {
      if (steps >= config.maxSteps) {
        const go = await this.ui.confirm(`The agent has used ${steps} steps. Continue?`);
        if (!go) return { status: "aborted", summary: "Stopped by the user after reaching the step limit." };
        steps = 0;
      }

      const turn = await this.modelTurn();
      this.ctx.recordUsage(turn.contextTokens);

      if (turn.stop === "refusal") {
        return { status: "failed", summary: `The model declined to continue. ${turn.refusalReason ?? ""}`.trim() };
      }
      if (turn.stop === "max_tokens" && turn.toolCalls.length === 0) {
        this.llm.addUserText("Your previous response was cut off. Continue with the next tool call.");
        continue;
      }
      if (turn.toolCalls.length === 0) {
        // An empty turn (no text, no tool call) happens with some models -
        // nudge instead of silently ending the task with nothing.
        if (!turn.text) {
          if (emptyTurns++ < 3) {
            this.llm.addUserText("You returned an empty turn. Call a tool to continue the task, or call finish with your report.");
            continue;
          }
          return { status: "failed", summary: "The model stopped returning actions (three empty turns in a row)." };
        }
        // Text without a tool call. Ask once for a proper finish so the status
        // (success / partial / failed) comes from the model, not a guess.
        if (textOnlyTurns++ < 1) {
          this.llm.addUserText(
            "Answer received. Now call the finish tool with status and summary so the task is formally closed, or keep working if anything is left.",
          );
          continue;
        }
        return { status: "partial", summary: turn.text };
      }
      emptyTurns = 0;
      textOnlyTurns = 0;

      const results: ToolOutcome[] = [];
      let finished: TaskResult | null = null;
      let stuck = false;

      for (const tc of turn.toolCalls) {
        this.ui.toolCall(tc.name, tc.input);
        if (this.ctx.trackCall(tc.name, tc.input)) stuck = true;

        if (tc.name === "finish") {
          finished = {
            status: (tc.input.status as TaskResult["status"]) ?? "success",
            summary: String(tc.input.summary ?? ""),
          };
          results.push({ id: tc.id, name: tc.name, text: "Task marked as finished." });
          continue;
        }

        try {
          const res = await this.execute(tc.name, tc.input);
          this.ui.toolResult(tc.name, res.text + (res.image ? "\n[screenshot attached]" : ""), false);
          results.push({ id: tc.id, name: tc.name, text: res.text, image: res.image });
        } catch (err) {
          const msg = err instanceof Error ? err.message.split("\n").slice(0, 3).join(" ") : String(err);
          this.ui.toolResult(tc.name, msg, true);
          results.push({ id: tc.id, name: tc.name, text: msg, isError: true });
        }
      }

      const notes: string[] = [];
      if (stuck) {
        notes.push(
          "Note: you have issued the same action three times in a row. It is not working - change your approach (scroll, keyboard, another element, query_page, a screenshot, or a different path).",
        );
      }
      const captchaNote = finished ? undefined : await this.handleCaptcha();
      if (captchaNote) notes.push(captchaNote);
      this.llm.addToolResults(results, notes.length ? notes.join("\n\n") : undefined);
      steps++;

      if (finished) return finished;

      if (this.ctx.needsCompaction()) {
        this.ui.info(`Context is ${Math.round(this.ctx.contextTokens / 1000)}k tokens - compacting history…`);
        await this.ctx.compact(this.browser.page.url());
        this.ui.info("Context compacted; continuing from the summary.");
      }
    }
  }

  /**
   * Human verification (captcha, "prove you are not a robot", access blocked).
   *
   * The agent never solves these and never tries to work around bot
   * protection. It hands the browser to the person running it: the window is
   * raised, the run pauses, and after the user solves it the loop continues
   * from whatever page the site returns. Returns a note for the model, or
   * undefined when the page is normal.
   */
  private async handleCaptcha(): Promise<string | undefined> {
    const found = await this.browser.detectCaptcha();
    if (!found) return undefined;

    if (config.headless) {
      this.ui.warn(`The site is showing a verification page (${found}) and the browser is headless - nobody can solve it.`);
      return `The site is showing a human-verification page (${found}). The browser runs headless, so it cannot be solved now. Do not try to bypass it: take another route (a different entry point, a direct URL, go back), or call finish with status partial and explain this.`;
    }

    if (this.captchaPauses >= 3) {
      return `The site is still showing a human-verification page (${found}) after ${this.captchaPauses} attempts. Stop retrying this route: try a different path or finish with status partial explaining that the site blocks automated access.`;
    }

    this.captchaPauses++;
    await this.browser.focusWindow();
    await this.ui.waitForUserInBrowser(`Сайт показывает проверку «вы не робот» (${found}).`);
    await this.browser.settle(1500);

    if (await this.browser.detectCaptcha()) {
      this.ui.warn("Проверка всё ещё на экране; продолжаю, но, возможно, придётся решить её ещё раз.");
      return `The verification page is still showing (${found}). If it does not clear, take a different route or finish with status partial.`;
    }
    this.ui.info("Проверка пройдена, продолжаю работу.");
    return `The user solved the verification page for you. The browser is now at ${this.browser.page.url()}. Call get_page_state before acting: every earlier element ref is invalid.`;
  }

  /**
   * Shrink what the agent observes so requests fit a smaller model or a
   * per-minute token budget. Applied when the API rejects a request as too
   * large, so a run adapts instead of dying.
   */
  private shrinkObservations(): boolean {
    const before = config.snapshotMaxElements + config.snapshotTextChars;
    config.snapshotMaxElements = Math.max(35, Math.floor(config.snapshotMaxElements / 2));
    config.snapshotTextChars = Math.max(500, Math.floor(config.snapshotTextChars / 2));
    config.subagentTextChars = Math.max(4000, Math.floor(config.subagentTextChars / 2));
    const changed = before !== config.snapshotMaxElements + config.snapshotTextChars;
    if (changed) {
      this.ui.warn(
        `Request too large - reducing observations to ${config.snapshotMaxElements} elements / ${config.snapshotTextChars} chars of text.`,
      );
    }
    return changed;
  }

  /** One streamed model turn with retries on transient API errors. */
  private async modelTurn(): Promise<TurnResult> {
    let attempt = 0;
    let tooLarge = 0;
    while (true) {
      try {
        // Keep only the newest observations at full size: older page states are
        // stale anyway, and they are what makes long runs expensive.
        this.llm.trimHistory(400, config.keepFullObservations);
        const result = await this.llm.turn({
          onText: (d) => this.ui.assistantText(d),
          onThinking: (d) => this.ui.thinking(d),
        });
        this.ui.turnEnd();
        return result;
      } catch (err) {
        this.ui.turnEnd();
        if (err instanceof LLMAuthError) throw err;
        if (err instanceof LLMDailyLimitError) {
          const next = this.llm.switchModel();
          if (!next) {
            throw new Error(
              `${err.message}\nThe daily quota for this model is spent. Set another model in .env (OPENAI_MODEL), ` +
                `list spares in OPENAI_FALLBACK_MODELS so the agent switches by itself, or come back after the quota resets.`,
            );
          }
          this.ui.warn(`Дневной лимит модели исчерпан — переключаюсь на ${next}.`);
          continue;
        }
        if (err instanceof LLMTooLargeError && tooLarge < 3) {
          tooLarge++;
          // Shrink future observations, then squeeze the ones already recorded.
          this.shrinkObservations();
          const trimmed = this.llm.trimHistory(Math.max(600, 3000 / tooLarge));
          if (!trimmed) {
            this.ui.info("Compacting the history so the request fits…");
            await this.ctx.compact(this.browser.page.url());
          }
          continue;
        }
        if (err instanceof LLMTransientError && attempt < 4) {
          attempt++;
          // A malformed generation is worth retrying at once; rate limits and
          // network errors need to back off.
          const delay = /invalid tool-call JSON/.test(err.message) ? 500 : 3000 * attempt;
          this.ui.warn(`API error (${err.message}); retrying in ${delay / 1000}s…`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  }

  /** Actions after which the model needs to see the page again. */
  private static readonly OBSERVE_AFTER = new Set([
    "navigate",
    "click",
    "click_at",
    "type_text",
    "press_key",
    "scroll",
    "select_option",
    "hover",
    "go_back",
    "switch_tab",
    "wait",
  ]);

  /**
   * Append the resulting page state to an action's result, so one model turn
   * does "act and observe" instead of two. Halves the number of API calls -
   * and since every call re-sends the whole history, roughly halves the tokens.
   */
  private async withState(message: string): Promise<ExecResult> {
    if (!config.autoObserve) return { text: message };
    try {
      const snap = await this.browser.snapshot();
      return { text: message + "\n\n--- page state ---\n" + formatSnapshot(snap, config.snapshotTextChars, config.snapshotMaxElements) };
    } catch {
      return { text: message + "\n(could not read the page state; call get_page_state)" };
    }
  }

  private async execute(name: string, input: ToolInput): Promise<ExecResult> {
    const b = this.browser;
    if (Agent.OBSERVE_AFTER.has(name)) return this.withState(await this.act(name, input));
    return this.observeOnly(name, input);
  }

  /** Actions that change the page; they return a one-line description. */
  private async act(name: string, input: ToolInput): Promise<string> {
    const b = this.browser;
    switch (name) {
      case "navigate":
        return (await b.navigate(String(input.url))).message;
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
      case "go_back":
        return (await b.goBack()).message;
      case "switch_tab":
        return (await b.switchTab(Number(input.index))).message;
      case "wait":
        return (await b.wait(Number(input.seconds))).message;
      default:
        throw new Error(`Unknown action: ${name}`);
    }
  }

  private async observeOnly(name: string, input: ToolInput): Promise<ExecResult> {
    const b = this.browser;
    switch (name) {
      case "get_page_state": {
        const snap = await b.snapshot();
        const text = formatSnapshot(snap, config.snapshotTextChars, config.snapshotMaxElements);
        if (input.include_screenshot && config.vision) return { text, image: await b.screenshot() };
        return { text };
      }
      case "screenshot":
        if (!config.vision) return { text: "This model cannot read images. Rely on get_page_state and query_page instead." };
        return { text: `Screenshot of the viewport at ${shortUrl(b.page.url())}`, image: await b.screenshot() };
      case "list_tabs":
        return { text: b.listTabs() };
      case "get_page_text": {
        const full = await b.pageText();
        const offset = Math.max(0, Number(input.offset ?? 0));
        const max = Math.min(20_000, Math.max(200, Number(input.max_chars ?? 6000)));
        const chunk = full.slice(offset, offset + max);
        const rest = full.length - (offset + chunk.length);
        return { text: `[chars ${offset}-${offset + chunk.length} of ${full.length}${rest > 0 ? `, ${rest} remaining` : ""}]\n${chunk}` };
      }
      case "query_page": {
        // Always read the live page so the sub-agent sees the current state.
        const snap = await b.snapshot();
        const answer = await queryPage(this.llm, String(input.question), snap);
        this.ui.subagentAnswer(answer);
        return { text: `DOM sub-agent answer (refs refer to the page as it is right now):\n${answer}` };
      }
      case "remember":
        this.ctx.notes.push(String(input.note));
        return { text: `Saved. You now have ${this.ctx.notes.length} note(s).` };
      case "ask_user": {
        const answer = await this.ui.askUser(String(input.question));
        return { text: answer.trim() ? `User answered: ${answer}` : "User gave no answer. Proceed with your best judgement or finish with status partial." };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
