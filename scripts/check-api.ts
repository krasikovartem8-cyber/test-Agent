/**
 * Connectivity + credentials check:  npx tsx scripts/check-api.ts
 * Says whether the API is reachable, whether the key works, and which of the
 * candidate models this account can actually use. Prints no secrets.
 */
import "dotenv/config";
import OpenAI from "openai";
import { config } from "../src/config.js";

const key = process.env.OPENAI_API_KEY ?? "";
console.log(`provider=${config.provider} · key present: ${key ? `yes (${key.length} chars)` : "NO"}`);

const client = new OpenAI({ maxRetries: 0, timeout: 30_000 });

const candidates = [config.openaiModel, config.openaiSubagentModel, "gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "gpt-5", "gpt-5-mini"];
const seen = new Set<string>();

for (const model of candidates) {
  if (seen.has(model)) continue;
  seen.add(model);
  try {
    const r = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: "ping" }],
      max_completion_tokens: 16,
    });
    console.log(`✅ ${model}: works (${r.usage?.total_tokens ?? "?"} tokens)`);
  } catch (err) {
    const e = err as { status?: number; code?: string; message?: string; cause?: { message?: string; code?: string } };
    const cause = e.cause ? ` · cause: ${e.cause.code ?? ""} ${e.cause.message ?? ""}`.trim() : "";
    console.log(`❌ ${model}: ${e.status ?? ""} ${e.code ?? ""} ${(e.message ?? "").split("\n")[0]}${cause}`);
  }
}
