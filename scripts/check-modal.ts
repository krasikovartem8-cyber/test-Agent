/**
 * Regression test for modal dialogs (no API key needed):
 *   npx tsx scripts/check-modal.ts
 * Opens Ozon's "Все фильтры" dialog and checks that the snapshot switches to
 * the dialog's own controls - the price inputs must be visible to the agent
 * instead of being crowded out by the page behind the overlay.
 */
import { BrowserController } from "../src/browser/Browser.js";
import { formatSnapshot } from "../src/browser/snapshot.js";

import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = pathToFileURL(path.join(here, "fixtures", "modal.html")).href;
const url = process.argv[2] ?? fixture;
const browser = new BrowserController();
await browser.launch();

console.log((await browser.navigate(url)).message.split("\n")[0]);
let snap = await browser.snapshot();
console.log(`до открытия: элементов ${snap.totalInteractive}, модалка: ${snap.modal ?? "нет"}`);

// The button is rendered lazily further down on marketplace pages.
let opener = snap.elements.find((e) => /все фильтры/i.test(e.name));
for (let i = 0; !opener && i < 4; i++) {
  await browser.scroll("down");
  snap = await browser.snapshot();
  opener = snap.elements.find((e) => /все фильтры/i.test(e.name));
}
if (!opener) {
  console.log("⚠ кнопка «Все фильтры» не найдена (страница могла отдать защиту от ботов)");
} else {
  console.log(`\nоткрываю [${opener.ref}] "${opener.name}"`);
  await browser.click(opener.ref);
  snap = await browser.snapshot();

  console.log(`после открытия: элементов ${snap.totalInteractive}, модалка: ${snap.modal ?? "нет"}`);

  // A tall dialog scrolls inside itself; the agent can reach the rest the same way.
  for (let i = 0; i < 3 && !snap.elements.some((e) => e.tag === "input" && /^(от|до|\d)/i.test(e.value ?? e.name)); i++) {
    await browser.scroll("down");
    snap = await browser.snapshot();
    console.log(`  после прокрутки #${i + 1}: элементов ${snap.totalInteractive}, модалка: ${snap.modal ?? "нет"}`);
  }

  const inputs = snap.elements.filter((e) => e.tag === "input");
  console.log(`\nполя ввода внутри окна (${inputs.length}):`);
  for (const e of inputs.slice(0, 12)) console.log(`  [${e.ref}] "${e.name}" value="${e.value ?? ""}" ${e.placeholder ?? ""}`);

  const apply = snap.elements.find((e) => /применить/i.test(e.name));
  console.log(
    snap.modal ? "\n✅ снапшот ограничен модальным окном" : "\n❌ снапшот всё ещё показывает страницу целиком",
  );
  console.log(inputs.length >= 2 ? "✅ поля ввода цены доступны агенту" : "❌ полей ввода не видно");
  console.log(apply ? `✅ кнопка «Применить» найдена: [${apply.ref}]` : "❌ кнопки «Применить» нет");

  console.log("\n--- что увидит агент (первые строки) ---");
  console.log(formatSnapshot(snap, 300, 25).split("\n").slice(0, 18).join("\n"));
}

await browser.close();
