/**
 * Exercises the agent loop end-to-end with a scripted fake model (no API key):
 *   npx tsx scripts/mock-run.ts
 * The fake model navigates to Wikipedia, observes, searches via the search box,
 * queries the page, remembers a fact and finishes. Verifies tool wiring,
 * tool_use/tool_result pairing, loop detection and the finish flow.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { BrowserController } from "../src/browser/Browser.js";
import { Agent } from "../src/agent/Agent.js";
import { TerminalUI } from "../src/ui/terminal.js";

type Step = { text?: string; tools?: Array<{ name: string; input: Record<string, unknown> }> };

// The scripted "brain". Real runs are driven by the model; this only tests plumbing.
const script: Step[] = [
  { text: "Открываю Википедию.", tools: [{ name: "navigate", input: { url: "https://ru.wikipedia.org" } }] },
  { tools: [{ name: "get_page_state", input: {} }] },
  { tools: [{ name: "query_page", input: { question: "Где поле поиска? Дай ref." }, }] },
  { tools: [{ name: "type_text", input: { ref: 3, text: "Playwright", press_enter: true } }] },
  { tools: [{ name: "get_page_state", input: { include_screenshot: true } }] },
  { tools: [{ name: "remember", input: { note: "Поиск в Википедии работает через поле [3]" } }] },
  // Three identical clicks on a non-existent ref -> error results + stuck nudge.
  { tools: [{ name: "click", input: { ref: 99999 } }] },
  { tools: [{ name: "click", input: { ref: 99999 } }] },
  { tools: [{ name: "click", input: { ref: 99999 } }] },
  { tools: [{ name: "finish", input: { status: "success", summary: "Мок-прогон завершён." } }] },
];

let step = 0;
let ids = 0;

function fakeMessage(s: Step): Anthropic.Message {
  const content: Anthropic.ContentBlock[] = [];
  if (s.text) content.push({ type: "text", text: s.text, citations: null });
  for (const t of s.tools ?? [])
    content.push({ type: "tool_use", id: `toolu_${++ids}`, name: t.name, input: t.input } as unknown as Anthropic.ToolUseBlock);
  return {
    id: "msg_mock",
    type: "message",
    role: "assistant",
    model: "mock",
    content,
    stop_reason: s.tools?.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 1000 * (step + 1), output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as Anthropic.Usage,
  } as Anthropic.Message;
}

const fakeClient = {
  messages: {
    stream: (params: Anthropic.MessageStreamParams) => {
      // Validate tool_use / tool_result pairing like the API would.
      const msgs = params.messages;
      for (let i = 0; i < msgs.length - 1; i++) {
        const a = msgs[i];
        if (a.role !== "assistant" || typeof a.content === "string") continue;
        const uses = a.content.filter((b) => b.type === "tool_use").map((b) => (b as Anthropic.ToolUseBlock).id);
        const next = msgs[i + 1];
        const results =
          typeof next.content === "string" ? [] : next.content.filter((b) => b.type === "tool_result").map((b) => (b as Anthropic.ToolResultBlockParam).tool_use_id);
        for (const id of uses) if (!results.includes(id)) throw new Error(`tool_use ${id} has no tool_result`);
      }
      const s = script[step++] ?? { text: "Script exhausted." };
      const msg = fakeMessage(s);
      return {
        on(event: string, cb: (d: string) => void) {
          if (event === "text" && s.text) cb(s.text);
          return this;
        },
        finalMessage: async () => msg,
      };
    },
    create: async (params: Anthropic.MessageCreateParamsNonStreaming) => {
      // Sub-agent / compaction stub: echo the size of what it received.
      const size = JSON.stringify(params.messages).length;
      return {
        content: [{ type: "text", text: `(mock sub-agent) received ${size} chars of page context; поле поиска — [3] "Искать в Википедии"` }],
        stop_reason: "end_turn",
      } as unknown as Anthropic.Message;
    },
  },
} as unknown as Anthropic;

process.env.HEADLESS ??= "1";
process.env.USER_DATA_DIR ??= ".smoke-profile";
const { config } = await import("../src/config.js");
config.headless = process.env.HEADLESS === "1";

const ui = new TerminalUI();
const browser = new BrowserController();
await browser.launch();
const agent = new Agent(fakeClient, browser, ui);
const result = await agent.runTask("Найди статью про Playwright в Википедии");
console.log("\nRESULT:", result);
console.log("notes:", agent.ctx.notes);
console.log("messages in history:", agent.ctx.messages.length);
const last = agent.ctx.messages[agent.ctx.messages.length - 3];
const stuckNudge = JSON.stringify(last).includes("three times in a row");
console.log("stuck nudge injected:", stuckNudge);
await browser.close();
ui.close();
process.exit(result.status === "success" && stuckNudge ? 0 : 1);
