import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { SUBAGENT_SYSTEM_PROMPT } from "./prompts.js";
import { formatElement, type PageSnapshot } from "../browser/snapshot.js";

/**
 * DOM sub-agent ("query_page").
 *
 * Advanced pattern: delegation. The main agent's context stays small because it
 * only ever sees a capped snapshot; when it needs to *read* a long page or find
 * one item among hundreds, it asks a question and a cheaper model reads the
 * whole page (all interactive elements + full visible text) and answers with
 * refs the main agent can act on. Repeated questions about the same page reuse
 * the cached page document (prompt caching on the page block).
 */
export async function queryPage(client: Anthropic, question: string, snapshot: PageSnapshot): Promise<string> {
  const elementLines = snapshot.elements.map((e) => (e.inViewport ? "  " : "  ~") + formatElement(e)).join("\n");
  const pageDoc =
    `URL: ${snapshot.url}\nTitle: ${snapshot.title}\n\n` +
    `INTERACTIVE ELEMENTS (${snapshot.elements.length}; lines starting with ~ are outside the viewport):\n${elementLines}\n\n` +
    `VISIBLE PAGE TEXT:\n${snapshot.text}`;

  const response = await client.messages.create({
    model: config.subagentModel,
    max_tokens: 4000,
    system: SUBAGENT_SYSTEM_PROMPT,
    output_config: { effort: "low" },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: pageDoc, cache_control: { type: "ephemeral" } },
          { type: "text", text: `Question: ${question}` },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") return "(sub-agent declined to answer)";
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
