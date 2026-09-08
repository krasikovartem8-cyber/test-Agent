import { SUBAGENT_SYSTEM_PROMPT } from "./prompts.js";
import { formatElement, type PageSnapshot } from "../browser/snapshot.js";
import type { LLMProvider } from "../llm/types.js";

/**
 * DOM sub-agent ("query_page").
 *
 * Advanced pattern: delegation. The main agent's context stays small because it
 * only ever sees a capped snapshot; when it needs to *read* a long page or find
 * one item among hundreds, it asks a question and a cheaper model reads the
 * whole page (all interactive elements + full visible text) and answers with
 * refs the main agent can act on. Repeated questions about the same page reuse
 * the cached page document where the provider supports prompt caching.
 */
export async function queryPage(llm: LLMProvider, question: string, snapshot: PageSnapshot): Promise<string> {
  const elementLines = snapshot.elements.map((e) => (e.inViewport ? "  " : "  ~") + formatElement(e)).join("\n");
  const pageDoc =
    `URL: ${snapshot.url}\nTitle: ${snapshot.title}\n\n` +
    `INTERACTIVE ELEMENTS (${snapshot.elements.length}; lines starting with ~ are outside the viewport):\n${elementLines}\n\n` +
    `VISIBLE PAGE TEXT:\n${snapshot.text}`;
  return llm.complete(SUBAGENT_SYSTEM_PROMPT, pageDoc, `Question: ${question}`, "low");
}
