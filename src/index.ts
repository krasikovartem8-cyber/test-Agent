import { execSync } from "node:child_process";
import chalk from "chalk";
import { config } from "./config.js";
import { BrowserController } from "./browser/Browser.js";
import { Agent } from "./agent/Agent.js";
import { TerminalUI } from "./ui/terminal.js";
import { createProvider } from "./llm/index.js";

function parseArgs(argv: string[]): { task?: string; keepOpen?: boolean } {
  const out: { task?: string; keepOpen?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--record") process.env.RECORD_VIDEO = "1";
    else if (a === "--headless") process.env.HEADLESS = "1";
    else if (a === "--keep-open") out.keepOpen = true;
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

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(chalk.dim("\nClosing the browser…"));
    ui.close();
    await browser.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  const runOne = async (task: string) => {
    const started = Date.now();
    try {
      const result = await agent.runTask(task);
      const icon = result.status === "success" ? "✅" : result.status === "partial" ? "🟡" : "❌";
      console.log(chalk.bold(`\n${icon} ${result.status.toUpperCase()}`));
      console.log(result.summary);
      // The browser stays where the agent left it - say so, it is often the
      // page the user wants to look at or continue from.
      console.log(chalk.dim(`\n🌐 Браузер открыт на: ${browser.page.url()}`));
      console.log(chalk.dim("   Можно дать следующую задачу — агент продолжит с этой страницы."));
    } catch (err) {
      console.log(chalk.red(`\n❌ Agent error: ${(err as Error).message}`));
    }
    const ctx = agent.ctx;
    console.log(
      chalk.dim(
        `⏱ ${Math.round((Date.now() - started) / 1000)}s · ${ctx.turns} запросов к модели · израсходовано ${ctx.billedTokens.toLocaleString("ru-RU")} токенов · контекст ${Math.round(ctx.contextTokens / 1000)}k · сжатий ${ctx.compactions}`,
      ),
    );
  };

  if (args.task) {
    await runOne(args.task);
    if (args.keepOpen) {
      await ui.askUser("Задача завершена. Нажмите Enter, чтобы закрыть браузер, или дайте следующую задачу.");
    }
  }

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
