import "dotenv/config";

function envInt(name: string, def: number): number {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : def;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const config = {
  /** Main planning/acting model. */
  model: process.env.AGENT_MODEL ?? "claude-opus-5",
  /** Cheaper model used by the DOM sub-agent and the compaction summarizer. */
  subagentModel: process.env.SUBAGENT_MODEL ?? "claude-sonnet-5",
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
};
