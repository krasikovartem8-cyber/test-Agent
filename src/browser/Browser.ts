import { chromium, type BrowserContext, type Page, type Locator } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { config } from "../config.js";
import { collectSnapshot, type PageSnapshot } from "./snapshot.js";

/** Tracking URLs on big sites run to thousands of characters; the model only needs to recognise the page. */
export function shortUrl(u: string, max = 120): string {
  return u.length > max ? u.slice(0, max) + "…" : u;
}

const ACTION_TIMEOUT = 10_000;
const NAV_TIMEOUT = 30_000;

export interface ActionOutcome {
  message: string;
  /** Set when the action caused a navigation / new tab. */
  navigated?: boolean;
}

/**
 * Thin, site-agnostic wrapper over Playwright.
 *
 * Elements are addressed by the numeric refs produced by the last snapshot
 * (`data-ba-ref` attributes). The controller knows nothing about specific
 * websites; every decision about *what* to click is made by the model.
 */
export class BrowserController {
  private context!: BrowserContext;
  private active!: Page;
  private snapshotId = 0;
  private lastSnapshot: PageSnapshot | null = null;
  private dialogMessages: string[] = [];
  private pendingNewPages: Page[] = [];

  async launch(): Promise<void> {
    const userDataDir = path.resolve(config.userDataDir);
    fs.mkdirSync(userDataDir, { recursive: true });
    const recordDir = path.resolve("recordings");
    if (config.recordVideo) fs.mkdirSync(recordDir, { recursive: true });

    const launchOpts = {
      headless: config.headless,
      viewport: config.viewport,
      locale: "ru-RU",
      args: ["--disable-blink-features=AutomationControlled"],
      ignoreDefaultArgs: ["--enable-automation"],
      recordVideo: config.recordVideo ? { dir: recordDir, size: config.viewport } : undefined,
    };

    try {
      this.context = await chromium.launchPersistentContext(userDataDir, {
        ...launchOpts,
        channel: config.browserChannel === "chrome" ? "chrome" : undefined,
      });
    } catch (err) {
      if (config.browserChannel !== "chrome") throw err;
      // Google Chrome could not be launched - say why, then try Playwright's
      // own Chromium (which may not be downloaded either).
      console.warn(`⚠ Could not launch Google Chrome: ${(err as Error).message.split("\n")[0]}`);
      console.warn("  Falling back to Playwright's Chromium…");
      try {
        this.context = await chromium.launchPersistentContext(userDataDir, launchOpts);
      } catch (fallbackErr) {
        throw new Error(
          `Neither Google Chrome nor Playwright's Chromium could start.\n` +
            `Chrome: ${(err as Error).message.split("\n")[0]}\n` +
            `Chromium: ${(fallbackErr as Error).message.split("\n")[0]}\n` +
            `Fix: close other Chrome windows using the same profile directory, or run "npx playwright install chromium".`,
        );
      }
    }

    this.context.setDefaultTimeout(ACTION_TIMEOUT);
    this.context.setDefaultNavigationTimeout(NAV_TIMEOUT);
    this.context.on("page", (p) => {
      this.pendingNewPages.push(p);
      this.attachPage(p);
    });

    const pages = this.context.pages();
    this.active = pages[0] ?? (await this.context.newPage());
    for (const p of pages) this.attachPage(p);
    this.pendingNewPages = [];
  }

  private attachPage(p: Page): void {
    p.on("dialog", async (d) => {
      this.dialogMessages.push(`${d.type()}: "${d.message()}" (auto-accepted)`);
      await d.accept().catch(() => {});
    });
  }

  get page(): Page {
    return this.active;
  }

  /** Drain events (dialogs, new tabs) that happened since the last action. */
  private drainEvents(): string {
    const notes: string[] = [];
    if (this.dialogMessages.length) {
      notes.push("Dialogs: " + this.dialogMessages.join("; "));
      this.dialogMessages = [];
    }
    const fresh = this.pendingNewPages.filter((p) => !p.isClosed());
    this.pendingNewPages = [];
    if (fresh.length) {
      // A click that opens a new tab almost always means the user wants to
      // continue there, so switch automatically and say so.
      this.active = fresh[fresh.length - 1];
      notes.push(`A new tab was opened and is now active: ${shortUrl(this.active.url())}`);
    }
    return notes.length ? "\n" + notes.join("\n") : "";
  }

  /** Wait for the page to settle after an action without blocking on infinite spinners. */
  async settle(ms = 600): Promise<void> {
    await this.active.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => {});
    await this.active.waitForLoadState("load", { timeout: 5_000 }).catch(() => {});
    await this.active.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
    await this.active.waitForTimeout(ms);
  }

  async navigate(url: string): Promise<ActionOutcome> {
    if (!/^[a-z]+:\/\//i.test(url)) url = "https://" + url;
    await this.active.goto(url, { waitUntil: "domcontentloaded" }).catch(async (err: Error) => {
      // Slow sites: still continue if the document is there.
      if (!/Timeout/i.test(err.message)) throw err;
    });
    await this.settle();
    return { message: `Navigated to ${shortUrl(this.active.url())} (title: "${await this.active.title()}")` + this.drainEvents(), navigated: true };
  }

  async goBack(): Promise<ActionOutcome> {
    await this.active.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
    await this.settle();
    return { message: `Now at ${shortUrl(this.active.url())}` + this.drainEvents(), navigated: true };
  }

  async snapshot(): Promise<PageSnapshot> {
    // Ensure the page is at least interactive; SPA content may still stream in.
    await this.active.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
    // Collect everything; the main agent sees a capped view (formatSnapshot),
    // the DOM sub-agent gets the full list. A navigation may still be in
    // flight (e.g. right after Enter in a search box) - retry a few times.
    let snap: PageSnapshot | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        snap = await this.active.evaluate(collectSnapshot, {
          maxElements: 3000,
          maxTextChars: config.subagentTextChars,
        });
        break;
      } catch (err) {
        const msg = (err as Error).message;
        if (attempt < 3 && /context was destroyed|navigation|detached/i.test(msg)) {
          await this.settle(800);
          continue;
        }
        throw err;
      }
    }
    this.snapshotId++;
    this.lastSnapshot = snap;
    return snap;
  }

  getLastSnapshot(): PageSnapshot | null {
    return this.lastSnapshot;
  }

  /** Full visible page text (fresh read, not the cached snapshot). */
  async pageText(): Promise<string> {
    return this.active.evaluate(() =>
      (document.body?.innerText ?? "").replace(/[ \t ]+/g, " ").replace(/\n\s*\n+/g, "\n").trim(),
    );
  }

  async screenshot(): Promise<{ base64: string; mediaType: "image/jpeg" }> {
    const buf = await this.active.screenshot({ type: "jpeg", quality: 60, fullPage: false });
    return { base64: buf.toString("base64"), mediaType: "image/jpeg" };
  }

  private locator(ref: number): Locator {
    if (!this.lastSnapshot) throw new Error("No page snapshot yet - call get_page_state first.");
    return this.active.locator(`[data-ba-ref="${ref}"]`).first();
  }

  private describeRef(ref: number): string {
    const el = this.lastSnapshot?.elements.find((e) => e.ref === ref);
    if (!el) return `[${ref}]`;
    return `[${ref}] <${el.tag}>${el.name ? ` "${el.name}"` : ""}`;
  }

  private async ensureRef(ref: number): Promise<Locator> {
    const loc = this.locator(ref);
    if ((await loc.count()) === 0) {
      throw new Error(
        `Element [${ref}] is not on the page anymore (the page changed since the last snapshot). Call get_page_state to get fresh element refs.`,
      );
    }
    return loc;
  }

  async click(ref: number): Promise<ActionOutcome> {
    const loc = await this.ensureRef(ref);
    const before = this.active.url();
    await loc.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
    try {
      await loc.click({ timeout: ACTION_TIMEOUT });
    } catch (err) {
      // Overlays / custom widgets: fall back to a DOM-level click.
      const msg = (err as Error).message.split("\n")[0];
      try {
        await loc.dispatchEvent("click", {}, { timeout: 3_000 });
      } catch {
        throw new Error(`Click on ${this.describeRef(ref)} failed: ${msg}`);
      }
    }
    await this.settle();
    const after = this.active.url();
    let message = `Clicked ${this.describeRef(ref)}.`;
    if (after !== before) message += ` URL changed to ${shortUrl(after)}`;
    return { message: message + this.drainEvents(), navigated: after !== before };
  }

  async clickAt(x: number, y: number): Promise<ActionOutcome> {
    const before = this.active.url();
    await this.active.mouse.click(x, y);
    await this.settle();
    const after = this.active.url();
    let message = `Clicked at (${x}, ${y}).`;
    if (after !== before) message += ` URL changed to ${shortUrl(after)}`;
    return { message: message + this.drainEvents(), navigated: after !== before };
  }

  async hover(ref: number): Promise<ActionOutcome> {
    const loc = await this.ensureRef(ref);
    await loc.hover({ timeout: ACTION_TIMEOUT });
    await this.active.waitForTimeout(400);
    return { message: `Hovered ${this.describeRef(ref)}.` + this.drainEvents() };
  }

  /**
   * Sites often expose a filter as a <label> wrapping or preceding the real
   * <input>, and the model naturally picks the labelled element. Typing into a
   * label can never work, so resolve it to the control it belongs to.
   */
  private async resolveEditable(ref: number): Promise<Locator> {
    const loc = await this.ensureRef(ref);
    const alreadyEditable = await loc.evaluate(
      (el) => el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable,
    );
    if (alreadyEditable) return loc;

    const found = await loc.evaluate((el) => {
      const editable = (c: Element | null | undefined): Element | null =>
        c && (c.tagName === "INPUT" || c.tagName === "TEXTAREA" || (c as HTMLElement).isContentEditable) ? c : null;

      let target: Element | null = null;
      if (el.tagName === "LABEL") {
        const forId = el.getAttribute("for");
        if (forId) target = editable(document.getElementById(forId));
        if (!target) target = editable(el.querySelector("input, textarea, [contenteditable='true']"));
        if (!target) target = editable(el.parentElement?.querySelector("input, textarea, [contenteditable='true']"));
      }
      if (!target) target = editable(el.querySelector("input, textarea, [contenteditable='true']"));
      if (!target) return false;
      document.querySelectorAll("[data-ba-typing]").forEach((n) => n.removeAttribute("data-ba-typing"));
      target.setAttribute("data-ba-typing", "1");
      return true;
    });
    return found ? this.active.locator('[data-ba-typing="1"]').first() : loc;
  }

  async type(ref: number, text: string, opts: { clear?: boolean; pressEnter?: boolean }): Promise<ActionOutcome> {
    const loc = await this.resolveEditable(ref);
    await loc.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
    const clear = opts.clear ?? true;
    const isEditable = await loc.evaluate((el) => {
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
    });
    try {
      if (isEditable) {
        if (clear) await loc.fill(text, { timeout: ACTION_TIMEOUT });
        else {
          await loc.click({ timeout: ACTION_TIMEOUT });
          await this.active.keyboard.type(text);
        }
      } else {
        // e.g. a wrapper element: focus it and type, letting the site handle key events.
        await loc.click({ timeout: ACTION_TIMEOUT });
        if (clear) await this.active.keyboard.press("Control+A");
        await this.active.keyboard.type(text);
      }
    } catch (err) {
      // Some custom inputs reject fill(); use real keystrokes instead.
      await loc.click({ timeout: ACTION_TIMEOUT });
      if (clear) {
        await this.active.keyboard.press("Control+A");
        await this.active.keyboard.press("Backspace");
      }
      await this.active.keyboard.type(text, { delay: 20 });
    }
    let message = `Typed "${text}" into ${this.describeRef(ref)}.`;
    if (opts.pressEnter) {
      const before = this.active.url();
      await this.active.keyboard.press("Enter");
      await this.settle();
      message += " Pressed Enter.";
      if (this.active.url() !== before) message += ` URL changed to ${shortUrl(this.active.url())}`;
    } else {
      await this.active.waitForTimeout(300);
    }
    return { message: message + this.drainEvents() };
  }

  async pressKey(key: string): Promise<ActionOutcome> {
    const before = this.active.url();
    await this.active.keyboard.press(key);
    await this.settle(300);
    let message = `Pressed ${key}.`;
    if (this.active.url() !== before) message += ` URL changed to ${shortUrl(this.active.url())}`;
    return { message: message + this.drainEvents() };
  }

  async scroll(direction: "up" | "down" | "left" | "right", pixels?: number, ref?: number): Promise<ActionOutcome> {
    const vh = config.viewport.height;
    const amount = pixels ?? Math.round(vh * 0.8);
    const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
    const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
    if (ref !== undefined) {
      const loc = await this.ensureRef(ref);
      await loc.hover({ timeout: 3_000 }).catch(() => {});
      await this.active.mouse.wheel(dx, dy);
    } else {
      await this.active.mouse.move(config.viewport.width / 2, vh / 2);
      await this.active.mouse.wheel(dx, dy);
    }
    await this.active.waitForTimeout(500);
    const pos = await this.active.evaluate(() => ({
      y: Math.round(window.scrollY),
      h: document.documentElement.scrollHeight,
      vh: window.innerHeight,
    }));
    const atBottom = pos.y + pos.vh >= pos.h - 5;
    return {
      message:
        `Scrolled ${direction} by ${amount}px. Now at y=${pos.y} of ${pos.h}px${atBottom ? " (bottom of page reached)" : ""}.` +
        this.drainEvents(),
    };
  }

  async selectOption(ref: number, value: string): Promise<ActionOutcome> {
    const loc = await this.ensureRef(ref);
    try {
      await loc.selectOption({ label: value }, { timeout: ACTION_TIMEOUT });
    } catch {
      await loc.selectOption(value, { timeout: ACTION_TIMEOUT });
    }
    await this.settle(300);
    return { message: `Selected "${value}" in ${this.describeRef(ref)}.` + this.drainEvents() };
  }

  async wait(seconds: number): Promise<ActionOutcome> {
    await this.active.waitForTimeout(Math.min(seconds, 30) * 1000);
    return { message: `Waited ${seconds}s.` + this.drainEvents() };
  }

  listTabs(): string {
    const pages = this.context.pages();
    return pages
      .map((p, i) => `${i}: ${p === this.active ? "* " : "  "}${p.url()}`)
      .join("\n");
  }

  async switchTab(index: number): Promise<ActionOutcome> {
    const pages = this.context.pages();
    const p = pages[index];
    if (!p) throw new Error(`No tab with index ${index}. Tabs:\n${this.listTabs()}`);
    this.active = p;
    await p.bringToFront();
    return { message: `Switched to tab ${index}: ${p.url()}`, navigated: true };
  }

  /**
   * Detect that the site is showing a human-verification page (captcha, "are
   * you a robot", access blocked). The agent does not try to solve these - it
   * hands the browser back to the user, who solves it and lets the run
   * continue. Returns a short description, or null when the page looks normal.
   */
  async detectCaptcha(): Promise<string | null> {
    try {
      return await this.active.evaluate(() => {
        const url = location.href;
        const text = ((document.body?.innerText ?? "") + " " + document.title).toLowerCase();

        const urlMarkers = ["showcaptcha", "/captcha", "checkcaptcha", "/sorry/", "challenge-platform", "cdn-cgi/l/chk"];
        for (const m of urlMarkers) if (url.toLowerCase().includes(m)) return `captcha page (URL contains "${m}")`;

        const phrases = [
          "подтвердите, что вы не робот",
          "подтвердите что вы не робот",
          "вы не робот",
          "я не робот",
          "введите символы",
          "доступ к сервису временно запрещён",
          "доступ к сервису ограничен",
          "показалось подозрительным",
          "слишком много запросов",
          "antibot",
          "challenge page",
          "verify you are human",
          "are you a robot",
          "i'm not a robot",
          "unusual traffic",
          "security check",
          "checking your browser",
        ];
        for (const p of phrases) if (text.includes(p)) return `verification page (text: "${p}")`;

        const frames = Array.from(document.querySelectorAll("iframe")).map((f) => f.getAttribute("src") ?? "");
        const frameMarkers = ["recaptcha", "hcaptcha", "captcha-api", "smartcaptcha", "turnstile", "funcaptcha", "arkoselabs"];
        for (const f of frames) for (const m of frameMarkers) if (f.includes(m)) return `captcha widget (${m})`;

        return null;
      });
    } catch {
      return null; // mid-navigation; the next observation will tell us
    }
  }

  /** Raise the browser window so the user can act in it. */
  async focusWindow(): Promise<void> {
    await this.active.bringToFront().catch(() => {});
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
  }
}
