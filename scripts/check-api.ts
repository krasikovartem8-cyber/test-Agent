/**
 * Connectivity + credentials check:  npx tsx scripts/check-api.ts
 * Tells you, for the provider that is actually configured, whether the API is
 * reachable, whether the key is accepted and which models the account can use.
 * Prints no secrets.
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { config } from "../src/config.js";

const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
const openaiKey = process.env.OPENAI_API_KEY ?? "";

let provider = config.provider;
if (provider === "auto") provider = anthropicKey ? "anthropic" : openaiKey ? "openai" : "anthropic";

console.log(`provider=${provider}${config.openaiBaseURL ? ` · base URL=${config.openaiBaseURL}` : ""}`);
console.log(`ANTHROPIC_API_KEY: ${anthropicKey ? `set (${anthropicKey.length} chars)` : "not set"}`);
console.log(`OPENAI_API_KEY: ${openaiKey ? `set (${openaiKey.length} chars)` : "not set"}`);
console.log("");

function describe(err: unknown): string {
  const e = err as { status?: number; error?: { type?: string; message?: string }; code?: string; message?: string; cause?: { code?: string; message?: string } };
  const parts = [
    e.status ? `HTTP ${e.status}` : "",
    e.code ?? e.error?.type ?? "",
    (e.error?.message ?? e.message ?? "").split("\n")[0],
    e.cause ? `cause: ${[e.cause.code, e.cause.message].filter(Boolean).join(" ")}` : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

async function ping(label: string, run: () => Promise<number | undefined>): Promise<void> {
  const started = Date.now();
  try {
    const tokens = await run();
    console.log(`✅ ${label}: works (${tokens ?? "?"} tokens, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (err) {
    console.log(`❌ ${label}: ${describe(err)}`);
  }
}

if (provider === "anthropic") {
  const client = new Anthropic({ maxRetries: 0, timeout: 60_000 });
  for (const model of [...new Set([config.model, config.subagentModel])]) {
    await ping(model, async () => {
      const r = await client.messages.create({ model, max_tokens: 16, messages: [{ role: "user", content: "ping" }] });
      return r.usage.input_tokens + r.usage.output_tokens;
    });
  }
} else {
  const client = new OpenAI({ baseURL: config.openaiBaseURL || undefined, maxRetries: 0, timeout: 60_000 });
  for (const model of [...new Set([config.openaiModel, config.openaiSubagentModel])]) {
    await ping(model, async () => {
      const r = await client.chat.completions.create({ model, max_completion_tokens: 16, messages: [{ role: "user", content: "ping" }] });
      return r.usage?.total_tokens;
    });
  }
}

console.log("\nIf every line is red:");
console.log("  · HTTP 401/403 → the key is wrong or not allowed for this model");
console.log("  · 429 credit_balance_exhausted / insufficient_quota → the account has no credits");
console.log("  · Connection error / timeout → the API is unreachable from this network (VPN, firewall, proxy)");
