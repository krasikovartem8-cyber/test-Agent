import { execSync } from "node:child_process";
import chalk from "chalk";
import { config } from "./config.js";
import { BrowserController } from "./browser/Browser.js";
import { Agent } from "./agent/Agent.js";
import { TerminalUI } from "./ui/terminal.js";
import { createProvider } from "./llm/index.js";

function parseArgs(argv: string[]): { task?: string } {
  const out: { task?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--record") process.env.RECORD_VIDEO = "1";
    else if (a === "--headless") process.env.HEADLESS = "1";
    else if (a === "--task") out.task = argv[++i];
    else if (!a.startsWith("--")) out.task = (out.task ? out.task + " " : "") + a;
  }
  return out;
}

async function main(): Promise<void> {
  // Cyrillic output in the classic Windows console needs the UTF-8 code page.
  if (process.platform === "win32") {
    try {
      execSync("chcp 65001", { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  }

  const args = parseArgs(process.argv.slice(2));
  // Flags may have changed env; re-read the two that matter at launch time.
  config.recordVideo = process.env.RECORD_VIDEO === "1";
  config.headless = process.env.HEADLESS === "1";

  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && !process.env.OPENAI_API_KEY) {
    console.log(chalk.yellow("⚠ No API key found. Put ANTHROPIC_API_KEY or OPENAI_API_KEY into .env."));
  }

  const llm = createProvider();
  const ui = new TerminalUI();
  const browser = new BrowserController();

  console.log(chalk.bold("🌐 Browser Agent"));
  console.log(
    chalk.dim(
      `provider=${llm.name} · model=${llm.model} · sub-agent=${llm.subagentModel} · effort=${config.effort} · max steps=${config.maxSteps} · context limit=${config.contextTokenLimit} tokens` +
        (config.recordVideo ? " · recording video" : ""),
    ),
  );
  console.log(chalk.dim("Type a task and press Enter. Commands: /reset (forget history), /tabs, /exit\n"));

  await browser.launch();
  const agent = new Agent(llm, browser, ui);

  const shutdown = async () => {
    ui.close();
    await browser.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());

  const runOne = async (task: string) => {
    const started = Date.now();
    try {
      const result = await agent.runTask(task);
      const icon = result.status === "success" ? "✅" : result.status === "partial" ? "🟡" : "❌";
      console.log(chalk.bold(`\n${icon} ${result.status.toUpperCase()}`));
      console.log(result.summary);
    } catch (err) {
      console.log(chalk.red(`\n❌ Agent error: ${(err as Error).message}`));
    }
    console.log(
      chalk.dim(`⏱ ${Math.round((Date.now() - started) / 1000)}s · context ${Math.round(agent.ctx.contextTokens / 1000)}k tokens · compactions ${agent.ctx.compactions}`),
    );
  };

  if (args.task) await runOne(args.task);

  while (true) {
    const line = (await ui.prompt()).trim();
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/reset") {
      agent.ctx.reset();
      console.log(chalk.dim("History cleared."));
      continue;
    }
    if (line === "/tabs") {
      console.log(browser.listTabs());
      continue;
    }
    await runOne(line);
  }
  await shutdown();
}

main().catch((err) => {
  console.error(chalk.red(err?.stack ?? String(err)));
  process.exit(1);
});
