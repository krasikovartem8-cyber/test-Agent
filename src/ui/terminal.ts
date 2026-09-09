import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import { config } from "../config.js";
import type { AgentUI } from "./types.js";

/**
 * Terminal UI.
 *
 * Quiet by default: one line per action ("what was asked") and one short line
 * for what came back ("what happened"). Page snapshots and model reasoning are
 * not printed - they are what makes the console unreadable. VERBOSE=1 restores
 * the full stream, including thinking and complete tool results.
 */
export class TerminalUI implements AgentUI {
  private rl = readline.createInterface({ input, output });
  private textOpen = false;
  private thinkingOpen = false;
  private closed = false;

  assistantText(delta: string): void {
    this.closeThinking();
    if (!this.textOpen) {
      output.write(chalk.green("🤖 "));
      this.textOpen = true;
    }
    output.write(delta);
  }

  thinking(delta: string): void {
    if (!config.verbose) return;
    if (!this.thinkingOpen) {
      output.write(chalk.gray("💭 "));
      this.thinkingOpen = true;
    }
    output.write(chalk.gray(delta));
  }

  turnEnd(): void {
    this.closeThinking();
    if (this.textOpen) {
      output.write("\n");
      this.textOpen = false;
    }
  }

  private closeThinking(): void {
    if (this.thinkingOpen) {
      output.write("\n");
      this.thinkingOpen = false;
    }
  }

  toolCall(name: string, inputObj: unknown): void {
    this.turnEnd();
    if (config.verbose) {
      const args = JSON.stringify(inputObj, null, 2);
      output.write(chalk.cyan(`🔧 ${chalk.bold(name)}\n`));
      if (args !== "{}") output.write(chalk.cyan(indent(args, 3)) + "\n");
      return;
    }
    output.write(chalk.cyan(`🔧 ${chalk.bold(name)}`) + chalk.dim(summarizeArgs(inputObj)) + "\n");
  }

  toolResult(name: string, result: string, isError: boolean): void {
    if (isError) {
      output.write(chalk.red("   ✗ " + firstLine(result, 160)) + "\n");
      return;
    }
    if (config.verbose) {
      output.write(chalk.dim(indent(result, 3)) + "\n\n");
      return;
    }
    output.write(chalk.dim("   → " + firstLine(result, 140)) + "\n");
  }

  subagentAnswer(answer: string): void {
    const text = config.verbose ? answer : clamp(answer, 400);
    output.write(chalk.magenta("🔍 ") + indent(text, 3).trimStart() + "\n");
  }

  info(message: string): void {
    this.turnEnd();
    output.write(chalk.blue(`ℹ ${message}\n`));
  }

  warn(message: string): void {
    this.turnEnd();
    output.write(chalk.yellow(`⚠ ${message}\n`));
  }

  /**
   * readline rejects the pending question with an AbortError when the user
   * presses Ctrl+C or the interface is closed. Treat that as "no answer"
   * instead of crashing the process with an unhandled rejection.
   */
  private async ask(prompt: string): Promise<string> {
    if (this.closed) return "";
    try {
      return await this.rl.question(prompt);
    } catch {
      this.closed = true;
      output.write("\n");
      return "";
    }
  }

  async askUser(question: string): Promise<string> {
    this.turnEnd();
    output.write(chalk.yellowBright(`\n❓ Агент спрашивает: ${question}\n`));
    return this.ask(chalk.bold("👤 You: "));
  }

  async waitForUserInBrowser(reason: string): Promise<void> {
    this.turnEnd();
    output.write(chalk.yellowBright(`\n🧩 ${reason}\n`));
    output.write(chalk.yellowBright("   Решите её в открытом окне браузера, затем вернитесь сюда и нажмите Enter.\n"));
    await this.ask(chalk.bold("👤 Нажмите Enter, когда будет готово: "));
  }

  async confirm(question: string): Promise<boolean> {
    this.turnEnd();
    const a = await this.ask(chalk.yellowBright(`❓ ${question} [y/N] `));
    return /^(y|yes|д|да)/i.test(a.trim());
  }

  /** Prompt for the next task. Returns "/exit" if input was interrupted. */
  async prompt(): Promise<string> {
    const line = await this.ask(chalk.bold("\n👤 You: "));
    return this.closed ? "/exit" : line;
  }

  /** True once stdin is gone (Ctrl+C, closed pipe). */
  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
    this.rl.close();
  }
}

/** "navigate example.com", "click [42]", "type_text [7] «запрос» ⏎". */
function summarizeArgs(inputObj: unknown): string {
  const o = (inputObj ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof o.url === "string") parts.push(" " + o.url.replace(/^https?:\/\//, "").slice(0, 60));
  if (o.ref !== undefined) parts.push(` [${o.ref}]`);
  if (typeof o.text === "string") parts.push(` «${clamp(o.text, 40)}»`);
  if (o.press_enter) parts.push(" ⏎");
  if (typeof o.key === "string") parts.push(" " + o.key);
  if (typeof o.direction === "string") parts.push(" " + o.direction);
  if (typeof o.value === "string") parts.push(` «${clamp(o.value, 30)}»`);
  if (typeof o.question === "string") parts.push(` «${clamp(o.question, 70)}»`);
  if (typeof o.note === "string") parts.push(` «${clamp(o.note, 60)}»`);
  if (typeof o.seconds === "number") parts.push(` ${o.seconds}s`);
  if (typeof o.status === "string") parts.push(" " + o.status);
  return parts.join("");
}

function clamp(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function firstLine(s: string, n: number): string {
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  const extra = s.length > line.length ? ` (+${s.length - line.length} символов)` : "";
  return clamp(line, n) + chalk.dim(extra);
}

function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}
