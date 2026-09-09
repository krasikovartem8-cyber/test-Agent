/**
 * Verifies captcha/blocked-page detection (no API key needed):
 *   npx tsx scripts/check-captcha.ts [url ...]
 * Prints what detectCaptcha() reports for each page. A normal page must say
 * "clean"; a verification page must be recognised.
 */
import { BrowserController } from "../src/browser/Browser.js";

const urls = process.argv.slice(2);
const targets = urls.length
  ? urls
  : [
      "https://ru.wikipedia.org",
      "https://market.yandex.ru/search?text=наушники",
      "https://www.google.com/recaptcha/api2/demo",
    ];

const browser = new BrowserController();
await browser.launch();

for (const url of targets) {
  try {
    await browser.navigate(url);
    const found = await browser.detectCaptcha();
    console.log(`${found ? "🧩 DETECTED" : "✅ clean    "}  ${url}${found ? `  →  ${found}` : ""}`);
  } catch (err) {
    console.log(`⚠ error     ${url}  →  ${(err as Error).message.split("\n")[0]}`);
  }
}

await browser.close();
