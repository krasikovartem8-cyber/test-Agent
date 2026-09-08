/**
 * Exercises the agent loop end-to-end with a scripted fake model (no API key):
 *   npx tsx scripts/mock-run.ts
 * The fake provider navigates to Wikipedia, observes, searches via the search
 * box, queries the page, remembers a fact, gets "stuck" and finishes. Verifies
 * tool wiring, tool-result pairing, loop detection and the finish flow.
 */
import { BrowserController } from "../src/browser/Browser.js";
import { Agent } from "../src/agent/Agent.js";
import { TerminalUI } from "../src/ui/terminal.js";
import type { Effort } from "../src/config.js";
import type { LLMProvider, ToolOutcome, TurnCallbacks, TurnResult } from "../src/llm/types.js";

type Step = { text?: string; tools?: Array<{ name: string; input: Record<string, unknown> }> };

// The scripted "brain". Real runs are driven by the model; this only tests plumbing.
const script: Step[] = [
  { text: "Открываю Википедию.", tools: [{ name: "navigate", input: { url: "https://ru.wikipedia.org" } }] },
  { tools: [{ name: "get_page_state", input: {} }] },
  { tools: [{ name: "query_page", input: { question: "Где поле поиска? Дай ref." } }] },
  { tools: [{ name: "type_text", input: { ref: 3, text: "Playwright", press_enter: true } }] },
  { tools: [{ name: "get_page_state", input: { include_screenshot: true } }] },
  { tools: [{ name: "remember", input: { note: "Поиск в Википедии работает через поле [3]" } }] },
  { tools: [{ name: "click", input: { ref: 99999 } }] },
  { tools: [{ name: "click", input: { ref: 99999 } }] },
  { tools: [{ name: "click", input: { ref: 99999 } }] },
  { tools: [{ name: "finish", input: { status: "success", summary: "Мок-прогон завершён." } }] },
];

class FakeProvider implements LLMProvider {
  readonly name = "fake";
  readonly model = "scripted";
  readonly subagentModel = "scripted-mini";
  history: string[] = [];
  pendingIds: string[] = [];
  notes: string[] = [];
  private step = 0;
  private ids = 0;

  historyLength() {
    return this.history.length;
  }
  addUserText(text: string) {
    this.history.push("USER: " + text);
  }
  addToolResults(results: ToolOutcome[], note?: string) {
    for (const r of results) {
      if (!this.pendingIds.includes(r.id)) throw new Error(`tool result for unknown call ${r.id}`);
      this.history.push(`← ${r.isError ? "ERROR " : ""}${r.text.slice(0, 80)}${r.image ? " [image]" : ""}`);
    }
    this.pendingIds = [];
    if (note) this.notes.push(note);
  }
  reset() {
    this.history = [];
  }
  async turn(cb: TurnCallbacks): Promise<TurnResult> {
    if (this.pendingIds.length) throw new Error("turn() called with unanswered tool calls");
    const s = script[this.step++] ?? { text: "Script exhausted." };
    if (s.text) cb.onText(s.text);
    const toolCalls = (s.tools ?? []).map((t) => ({ id: `call_${++this.ids}`, name: t.name, input: t.input }));
    this.pendingIds = toolCalls.map((c) => c.id);
    this.history.push("ASSISTANT: " + (s.text ?? "") + toolCalls.map((c) => ` → ${c.name}`).join(""));
    return { text: s.text ?? "", toolCalls, stop: toolCalls.length ? "tool_use" : "end_turn", contextTokens: 1000 * this.step };
  }
  transcript() {
    return this.history.join("\n");
  }
  async complete(_system: string, doc: string, _question: string, _effort: Effort) {
    return `(mock sub-agent) received ${doc.length} chars of page context; поле поиска — [3] "Искать в Википедии"`;
  }
}

process.env.HEADLESS ??= "1";
process.env.USER_DATA_DIR ??= ".smoke-profile";
const { config } = await import("../src/config.js");
config.headless = process.env.HEADLESS === "1";

const ui = new TerminalUI();
const browser = new BrowserController();
await browser.launch();
const llm = new FakeProvider();
const agent = new Agent(llm, browser, ui);
const result = await agent.runTask("Найди статью про Playwright в Википедии");
console.log("\nRESULT:", result);
console.log("notes:", agent.ctx.notes);
console.log("history entries:", llm.historyLength());
const stuckNudge = llm.notes.some((n) => n.includes("three times in a row"));
console.log("stuck nudge injected:", stuckNudge);
await browser.close();
ui.close();
process.exit(result.status === "success" && stuckNudge && agent.ctx.notes.length === 1 ? 0 : 1);
