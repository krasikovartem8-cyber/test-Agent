/**
 * Smoke test for the browser layer (no API key needed):
 *   npm run smoke -- https://example.com
 * Opens the page, prints the formatted snapshot the agent would see, and exits.
 */
import { BrowserController } from "../src/browser/Browser.js";
import { formatSnapshot } from "../src/browser/snapshot.js";
import { config } from "../src/config.js";

const url = process.argv[2] ?? "https://example.com";
const browser = new BrowserController();
await browser.launch();
console.log((await browser.navigate(url)).message);
const snap = await browser.snapshot();
console.log(formatSnapshot(snap, config.snapshotTextChars, config.snapshotMaxElements));
console.log(`\n[total interactive elements: ${snap.totalInteractive}, text length: ${snap.text.length}]`);
await browser.close();
