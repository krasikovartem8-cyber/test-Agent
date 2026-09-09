import "dotenv/config";

function envInt(name: string, def: number): number {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : def;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const config = {
  /** anthropic | openai | auto (auto = whichever API key is set, Anthropic first). */
  provider: (process.env.LLM_PROVIDER ?? "auto") as "anthropic" | "openai" | "auto",

  /** Anthropic: main planning/acting model and the cheaper sub-agent model. */
  model: process.env.AGENT_MODEL ?? "claude-opus-5",
  subagentModel: process.env.SUBAGENT_MODEL ?? "claude-sonnet-5",

  /** OpenAI equivalents. */
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-5.4",
  openaiSubagentModel: process.env.OPENAI_SUBAGENT_MODEL ?? "gpt-5.4-mini",
  /** Any OpenAI-compatible endpoint (Groq, OpenRouter, Gemini compat, Ollama…). */
  openaiBaseURL: process.env.OPENAI_BASE_URL ?? "",
  /** Set VISION=0 for models that cannot read images: no screenshots are sent. */
  vision: process.env.VISION !== "0",

  effort: (process.env.AGENT_EFFORT ?? "high") as Effort,
  maxSteps: envInt("MAX_STEPS", 80),
  /** When the live context exceeds this many tokens the history is compacted. */
  contextTokenLimit: envInt("CONTEXT_TOKEN_LIMIT", 150_000),
  browserChannel: (process.env.BROWSER_CHANNEL ?? "chrome") as "chrome" | "chromium",
  userDataDir: process.env.USER_DATA_DIR ?? ".browser-profile",
  headless: process.env.HEADLESS === "1",
  recordVideo: process.env.RECORD_VIDEO === "1",
  viewport: { width: 1280, height: 800 },
  /** Max interactive elements listed in one page snapshot. */
  snapshotMaxElements: envInt("SNAPSHOT_MAX_ELEMENTS", 220),
  /** Chars of visible text included directly in a snapshot. */
  snapshotTextChars: envInt("SNAPSHOT_TEXT_CHARS", 2500),
  /** Chars of page text handed to the DOM sub-agent. */
  subagentTextChars: envInt("SUBAGENT_TEXT_CHARS", 80_000),
  /** Interactive elements handed to the DOM sub-agent. */
  subagentMaxElements: envInt("SUBAGENT_MAX_ELEMENTS", 600),
  /** Chars of transcript handed to the summarizer during compaction. */
  transcriptChars: envInt("TRANSCRIPT_CHARS", 40_000),
};
