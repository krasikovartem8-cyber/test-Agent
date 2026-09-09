import { config } from "../config.js";
import { SUBAGENT_SYSTEM_PROMPT } from "./prompts.js";
import { formatElement, type PageSnapshot } from "../browser/snapshot.js";
import { LLMTooLargeError, type LLMProvider } from "../llm/types.js";

/**
 * DOM sub-agent ("query_page").
 *
 * Advanced pattern: delegation. The main agent's context stays small because it
 * only ever sees a capped snapshot; when it needs to *read* a long page or find
 * one item among hundreds, it asks a question and a cheaper model reads the
 * page (interactive elements + visible text) and answers with refs the main
 * agent can act on. Repeated questions about the same page reuse the cached
 * page document where the provider supports prompt caching.
 *
 * The page document is capped, and if the model still rejects it as too large
 * (small context window, or a per-minute token budget on free tiers) the
 * document is halved and the question retried.
 */
/**
 * Some open-weight models write their reasoning into the reply inside <think>
 * tags. It is long, in the wrong language, and pure cost for the main agent.
 */
function stripReasoning(answer: string): string {
  const cleaned = answer
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "")
    .trim();
  return cleaned || answer.trim();
}

export async function queryPage(llm: LLMProvider, question: string, snapshot: PageSnapshot): Promise<string> {
  let maxElements = config.subagentMaxElements;
  let maxChars = config.subagentTextChars;

  for (let attempt = 0; ; attempt++) {
    const elements = snapshot.elements.slice(0, maxElements);
    const elementLines = elements.map((e) => (e.inViewport ? "  " : "  ~") + formatElement(e)).join("\n");
    const omitted = snapshot.elements.length - elements.length;
    const pageDoc =
      `URL: ${snapshot.url}\nTitle: ${snapshot.title}\n\n` +
      `INTERACTIVE ELEMENTS (${elements.length}${omitted > 0 ? ` of ${snapshot.elements.length}` : ""}; lines starting with ~ are outside the viewport):\n` +
      `${elementLines}\n\n` +
      `VISIBLE PAGE TEXT:\n${snapshot.text.slice(0, maxChars)}`;

    try {
      const ask = attempt === 0 ? `Question: ${question}` : `Question: ${question}\n\nAnswer directly in one or two sentences. Do not write any reasoning, and never emit <think> blocks.`;
      const answer = stripReasoning(await llm.complete(SUBAGENT_SYSTEM_PROMPT, pageDoc, ask, "low"));
      // An unclosed <think> means the reply was cut off mid-reasoning: no answer
      // came back at all, so ask again for the answer alone.
      if (/<think>/i.test(answer) && attempt < 2) continue;
      return answer.replace(/<\/?think>/gi, "").trim();
    } catch (err) {
      if (err instanceof LLMTooLargeError && attempt < 3) {
        maxElements = Math.max(60, Math.floor(maxElements / 2));
        maxChars = Math.max(2000, Math.floor(maxChars / 2));
        continue;
      }
      throw err;
    }
  }
}
