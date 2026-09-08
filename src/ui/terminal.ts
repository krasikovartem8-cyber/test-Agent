import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import type { AgentUI } from "./types.js";

const RESULT_PREVIEW = process.env.VERBOSE === "1" ? Number.MAX_SAFE_INTEGER : 1800;

/** Terminal UI: streams the agent's thoughts, tool calls and results. */
export class TerminalUI implements AgentUI {
  private rl = readline.createInterface({ input, output });
  private textOpen = false;
  private thinkingOpen = false;

  assistantText(delta: string): void {
    this.closeThinking();
    if (!this.textOpen) {
      output.write(chalk.green("🤖 Assistant: "));
      this.textOpen = true;
    }
    output.write(delta);
  }

  thinking(delta: string): void {
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
    const args = JSON.stringify(inputObj, null, 2);
    output.write(chalk.cyan(`🔧 Using tool: ${chalk.bold(name)}\n`));
    if (args !== "{}") output.write(chalk.cyan("   Input: ") + indent(args, 3).trimStart() + "\n");
  }

  toolResult(name: string, result: string, isError: boolean): void {
    let text = result;
    if (text.length > RESULT_PREVIEW) {
      text = text.slice(0, RESULT_PREVIEW) + chalk.dim(`\n… (${result.length - RESULT_PREVIEW} more chars hidden; VERBOSE=1 to show all)`);
    }
    const label = isError ? chalk.red("   Error: ") : chalk.dim("   Result: ");
    output.write(label + indent(text, 3).trimStart() + "\n\n");
  }

  subagentAnswer(answer: string): void {
    output.write(chalk.magenta("🔍 DOM sub-agent: ") + indent(answer, 3).trimStart() + "\n");
  }

  info(message: string): void {
    this.turnEnd();
    output.write(chalk.blue(`ℹ ${message}\n`));
  }

  warn(message: string): void {
    this.turnEnd();
    output.write(chalk.yellow(`⚠ ${message}\n`));
  }

  async askUser(question: string): Promise<string> {
    this.turnEnd();
    output.write(chalk.yellowBright(`\n❓ Agent asks: ${question}\n`));
    return this.rl.question(chalk.bold("👤 You: "));
  }

  async confirm(question: string): Promise<boolean> {
    this.turnEnd();
    const a = await this.rl.question(chalk.yellowBright(`❓ ${question} [y/N] `));
    return /^(y|yes|д|да)/i.test(a.trim());
  }

  /** Prompt for the next task. */
  async prompt(): Promise<string> {
    return this.rl.question(chalk.bold("\n👤 You: "));
  }

  close(): void {
    this.rl.close();
  }
}

function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}
