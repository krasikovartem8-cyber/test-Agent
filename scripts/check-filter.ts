/**
 * Regression test for the "price filter" case (no API key needed):
 *   npx tsx scripts/check-filter.ts
 * On a Yandex Market search page the maximum-price field is exposed as a
 * <label> around an <input>. The agent used to click the label, fail to type
 * and loop. This checks that the label is no longer listed separately and that
 * typing into whatever the model picks lands in the real input.
 */
import { BrowserController } from "../src/browser/Browser.js";
import { config } from "../src/config.js";

const url = process.argv[2] ?? "https://market.yandex.ru/search?text=Huawei%20ноутбук";
const browser = new BrowserController();
await browser.launch();

console.log((await browser.navigate(url)).message.split("\n")[0]);
const snap = await browser.snapshot();

// NB: \b is ASCII-only in JS, so it never matches after a Cyrillic letter.
const isPrice = (s: string) => /^(До|От)\s/i.test(s);
const priceFields = snap.elements.filter((e) => isPrice(e.name) || isPrice(e.placeholder ?? ""));
console.log(`\nЭлементы ценового фильтра (${priceFields.length}):`);
for (const e of priceFields) console.log(`  [${e.ref}] <${e.tag}> "${e.name}"`);

const labels = priceFields.filter((e) => e.tag === "label");
console.log(labels.length ? `\n❌ подписи <label> всё ещё в списке: ${labels.length}` : "\n✅ дублирующих <label> нет");

const target = priceFields.find((e) => /^До\s/i.test(e.name) || /^До\s/i.test(e.placeholder ?? ""));
if (!target) {
  console.log("⚠ поле «До» не найдено — возможно, страница отдала капчу");
} else {
  const before = browser.page.url();
  const out = await browser.type(target.ref, "30000", { clear: true, pressEnter: true });
  console.log("\n" + out.message.split("\n")[0]);
  const value = await browser.page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input"));
    const hit = inputs.find((i) => (i.value ?? "").replace(/\s/g, "") === "30000");
    return hit ? hit.value : null;
  });
  const urlChanged = browser.page.url() !== before;
  console.log(value ? `✅ значение попало в <input>: "${value}"` : "❌ ни в одном поле нет введённого значения");
  console.log(urlChanged ? "✅ фильтр применился (URL изменился)" : "ℹ URL не изменился (фильтр мог примениться без перезагрузки)");
}

console.log(`\nвсего элементов в снапшоте: ${snap.totalInteractive}, лимит показа: ${config.snapshotMaxElements}`);
await browser.close();
