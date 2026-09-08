/**
 * Page snapshot: a compact, model-friendly description of the current page.
 *
 * The heavy lifting happens inside the browser (see `collectSnapshot`, which is
 * serialized by Playwright and evaluated in the page). It walks the DOM
 * (including open shadow roots), finds visible interactive elements, tags each
 * one with a `data-ba-ref` attribute and returns a numbered list. The agent
 * then acts on elements by number - it never needs CSS selectors and nothing
 * about a particular site is hardcoded.
 */

export interface SnapshotElement {
  ref: number;
  tag: string;
  role?: string;
  name: string;
  type?: string;
  href?: string;
  value?: string;
  placeholder?: string;
  checked?: boolean;
  disabled?: boolean;
  inViewport: boolean;
  box: { x: number; y: number; w: number; h: number };
}

export interface PageSnapshot {
  url: string;
  title: string;
  scroll: { y: number; pageHeight: number; viewportHeight: number };
  elements: SnapshotElement[];
  totalInteractive: number;
  /** Visible text of the page (whitespace-collapsed, capped). */
  text: string;
}

export interface SnapshotOptions {
  maxElements: number;
  maxTextChars: number;
}

/** Runs inside the browser. Must be self-contained (no closures over Node scope). */
export function collectSnapshot(opts: SnapshotOptions): PageSnapshot {
  // tsx/esbuild wraps nested functions in a `__name(fn, "name")` helper that
  // does not exist inside the page once the function is serialized. Provide it.
  const g = globalThis as unknown as { __name?: (f: unknown, n: string) => unknown };
  if (typeof g.__name !== "function") g.__name = (f: unknown) => f;

  const INTERACTIVE =
    "a[href], button, input, select, textarea, summary, label, " +
    '[role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], ' +
    '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], ' +
    '[role="combobox"], [role="textbox"], [role="searchbox"], [role="switch"], [role="slider"], ' +
    '[role="spinbutton"], [role="treeitem"], [contenteditable="true"], [contenteditable=""], ' +
    '[onclick], [tabindex]:not([tabindex="-1"])';

  const clearRefs = (root: Document | ShadowRoot) => {
    for (const el of Array.from(root.querySelectorAll("[data-ba-ref]"))) el.removeAttribute("data-ba-ref");
    for (const el of Array.from(root.querySelectorAll("*"))) if (el.shadowRoot) clearRefs(el.shadowRoot);
  };
  clearRefs(document);

  const candidates: Element[] = [];
  const collect = (root: Document | ShadowRoot) => {
    for (const el of Array.from(root.querySelectorAll(INTERACTIVE))) candidates.push(el);
    for (const el of Array.from(root.querySelectorAll("*"))) if (el.shadowRoot) collect(el.shadowRoot);
  };
  collect(document);

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const visibleRect = (el: Element): DOMRect | null => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return null;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    return rect;
  };

  const clean = (s: string | null | undefined, max = 90): string => {
    if (!s) return "";
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
  };

  const accessibleName = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (parts.trim()) return clean(parts);
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      if (el.id) {
        const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lab?.textContent?.trim()) return clean(lab.textContent);
      }
      const parentLabel = el.closest("label");
      if (parentLabel?.textContent?.trim()) return clean(parentLabel.textContent);
    }
    const text = (el as HTMLElement).innerText ?? el.textContent ?? "";
    if (text.trim()) return clean(text);
    const img = el.querySelector("img[alt], svg[aria-label], [title]");
    if (img) {
      const alt = img.getAttribute("alt") || img.getAttribute("aria-label") || img.getAttribute("title");
      if (alt) return clean(alt);
    }
    const title = el.getAttribute("title");
    if (title) return clean(title);
    if (el instanceof HTMLInputElement) {
      if (el.placeholder) return clean(el.placeholder);
      if (el.value && ["button", "submit", "reset"].includes(el.type)) return clean(el.value);
    }
    return "";
  };

  const seen = new Set<Element>();
  const elements: SnapshotElement[] = [];
  let ref = 0;

  for (const el of candidates) {
    if (seen.has(el)) continue;
    seen.add(el);
    const rect = visibleRect(el);
    if (!rect) continue;
    // A <label> that wraps a control is redundant with the control itself.
    if (el.tagName === "LABEL" && el.querySelector("input,select,textarea")) continue;

    ref++;
    el.setAttribute("data-ba-ref", String(ref));
    const tag = el.tagName.toLowerCase();
    const item: SnapshotElement = {
      ref,
      tag,
      name: accessibleName(el),
      inViewport: rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw,
      box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    };
    const role = el.getAttribute("role");
    if (role) item.role = role;
    if (el instanceof HTMLAnchorElement) {
      const href = el.getAttribute("href") ?? "";
      if (href && !href.startsWith("javascript:")) item.href = href;
    }
    if (el instanceof HTMLInputElement) {
      item.type = el.type;
      if (el.placeholder) item.placeholder = clean(el.placeholder, 60);
      if (el.type === "checkbox" || el.type === "radio") item.checked = el.checked;
      else if (el.type !== "password" && el.value) item.value = clean(el.value, 60);
    } else if (el instanceof HTMLTextAreaElement) {
      if (el.placeholder) item.placeholder = clean(el.placeholder, 60);
      if (el.value) item.value = clean(el.value, 60);
    } else if (el instanceof HTMLSelectElement) {
      const selected = el.options[el.selectedIndex];
      item.value = clean(selected?.text ?? "", 60);
      const opts = Array.from(el.options)
        .slice(0, 12)
        .map((o) => o.text.trim())
        .join(" | ");
      item.placeholder = "options: " + clean(opts, 200);
    }
    if (role === "checkbox" || role === "switch" || role === "radio" || role === "tab" || role === "option") {
      const ac = el.getAttribute("aria-checked") ?? el.getAttribute("aria-selected") ?? el.getAttribute("aria-pressed");
      if (ac !== null) item.checked = ac === "true";
    }
    if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") item.disabled = true;
    elements.push(item);
  }

  const totalInteractive = elements.length;
  // Prefer elements in the viewport, then the rest in document order.
  elements.sort((a, b) => Number(b.inViewport) - Number(a.inViewport) || a.ref - b.ref);
  const limited = elements.slice(0, opts.maxElements);

  const rawText = (document.body?.innerText ?? "")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();

  return {
    url: location.href,
    title: document.title,
    scroll: {
      y: Math.round(window.scrollY),
      pageHeight: document.documentElement.scrollHeight,
      viewportHeight: vh,
    },
    elements: limited,
    totalInteractive,
    text: rawText.slice(0, opts.maxTextChars),
  };
}

/** Renders one element as a single compact line for the model. */
export function formatElement(e: SnapshotElement): string {
  const parts: string[] = ["[" + e.ref + "]"];
  let tag = e.tag;
  if (e.role && e.role !== e.tag) tag += "/" + e.role;
  if (e.type && e.type !== "text") tag += ":" + e.type;
  parts.push("<" + tag + ">");
  if (e.name) parts.push('"' + e.name + '"');
  if (e.placeholder) parts.push('placeholder="' + e.placeholder + '"');
  if (e.value !== undefined && e.value !== "") parts.push('value="' + e.value + '"');
  if (e.href) {
    let href = e.href;
    try {
      href = decodeURIComponent(href);
    } catch {
      /* keep as is */
    }
    parts.push("href=" + (href.length > 70 ? href.slice(0, 69) + "…" : href));
  }
  if (e.checked !== undefined) parts.push(e.checked ? "[checked]" : "[unchecked]");
  if (e.disabled) parts.push("[disabled]");
  return parts.join(" ");
}

/** Renders the whole snapshot as text for the main agent. */
export function formatSnapshot(s: PageSnapshot, textChars: number, maxElements: number): string {
  const shown = s.elements.slice(0, maxElements);
  const inView = shown.filter((e) => e.inViewport);
  const outView = shown.filter((e) => !e.inViewport);
  const lines: string[] = [];
  lines.push("URL: " + s.url);
  lines.push("Title: " + s.title);
  const screens = Math.max(1, Math.ceil(s.scroll.pageHeight / Math.max(1, s.scroll.viewportHeight)));
  const cur = Math.min(screens, Math.floor(s.scroll.y / Math.max(1, s.scroll.viewportHeight)) + 1);
  lines.push(`Scroll: screen ${cur} of ~${screens} (y=${s.scroll.y}px, page height ${s.scroll.pageHeight}px)`);
  lines.push("");
  lines.push(`Interactive elements in viewport (${inView.length}):`);
  for (const e of inView) lines.push("  " + formatElement(e));
  if (outView.length) {
    lines.push("");
    lines.push(`Interactive elements outside viewport (${outView.length}, scroll to bring them into view):`);
    for (const e of outView) lines.push("  " + formatElement(e));
  }
  if (s.totalInteractive > shown.length) {
    lines.push(`  … ${s.totalInteractive - shown.length} more interactive elements not listed (use query_page to find them)`);
  }
  lines.push("");
  const text = s.text.slice(0, textChars);
  const truncated = s.text.length > text.length;
  lines.push(
    `Visible page text (${text.length} chars${truncated ? ", truncated - use query_page or get_page_text for the rest" : ""}):`,
  );
  lines.push(text);
  return lines.join("\n");
}
