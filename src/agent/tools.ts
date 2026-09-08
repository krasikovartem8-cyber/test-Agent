import type Anthropic from "@anthropic-ai/sdk";

/**
 * Tool surface exposed to the model. Deliberately generic: nothing here knows
 * about any particular website. The model decides what to click, type and read.
 */
export const TOOLS: Anthropic.Tool[] = [
  {
    name: "navigate",
    description: "Open a URL in the active tab. Use for the starting site of a task or when you know the exact address.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute URL, e.g. https://example.com" } },
      required: ["url"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "get_page_state",
    description:
      "Observe the current page: URL, title, scroll position, a numbered list of visible interactive elements ([N] refs) and the beginning of the visible text. " +
      "Call it after every action that may have changed the page, and before acting on any element: refs are only valid for the most recent snapshot. " +
      "Set include_screenshot=true when layout matters (modals, maps, images, unclear state).",
    input_schema: {
      type: "object",
      properties: {
        include_screenshot: { type: "boolean", description: "Also attach a screenshot of the viewport (default false)." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "screenshot",
    description: "Take a screenshot of the current viewport (JPEG). Use it to visually verify state or when text snapshots are ambiguous.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "click",
    description: "Click an element by its [N] ref from the latest get_page_state snapshot.",
    input_schema: {
      type: "object",
      properties: { ref: { type: "integer", description: "Element ref number from the latest snapshot" } },
      required: ["ref"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "click_at",
    description: "Click at viewport coordinates (pixels). Fallback for canvases, maps or elements that have no ref; coordinates come from a screenshot (1280x800 viewport).",
    input_schema: {
      type: "object",
      properties: { x: { type: "integer" }, y: { type: "integer" } },
      required: ["x", "y"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "type_text",
    description: "Type text into an input/textarea/editable element by ref. Clears existing content by default. Optionally presses Enter afterwards (useful for search boxes).",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "integer" },
        text: { type: "string" },
        clear: { type: "boolean", description: "Clear the field first (default true)" },
        press_enter: { type: "boolean", description: "Press Enter after typing (default false)" },
      },
      required: ["ref", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "press_key",
    description: "Press a keyboard key or combination, e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown', 'Control+A'.",
    input_schema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "scroll",
    description: "Scroll the page (or a scrollable element given by ref) to reveal more content. Default amount is ~80% of the viewport.",
    input_schema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        pixels: { type: "integer", description: "Optional scroll distance in pixels" },
        ref: { type: "integer", description: "Optional ref of a scrollable container (list, modal, panel)" },
      },
      required: ["direction"],
      additionalProperties: false,
    },
  },
  {
    name: "select_option",
    description: "Choose an option in a native <select> element by its visible label (or value).",
    input_schema: {
      type: "object",
      properties: { ref: { type: "integer" }, value: { type: "string" } },
      required: ["ref", "value"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "hover",
    description: "Move the mouse over an element by ref (opens hover menus / tooltips).",
    input_schema: {
      type: "object",
      properties: { ref: { type: "integer" } },
      required: ["ref"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "wait",
    description: "Wait for N seconds (max 30) for content to load or animations to finish.",
    input_schema: {
      type: "object",
      properties: { seconds: { type: "number" } },
      required: ["seconds"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "go_back",
    description: "Navigate back in browser history.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "list_tabs",
    description: "List open browser tabs with their indexes; the active one is marked with *.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "switch_tab",
    description: "Make another tab active by index (see list_tabs).",
    input_schema: {
      type: "object",
      properties: { index: { type: "integer" } },
      required: ["index"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "get_page_text",
    description: "Read the visible text of the page directly, in chunks (offset/max_chars). Prefer query_page for long pages - it keeps your context small.",
    input_schema: {
      type: "object",
      properties: {
        offset: { type: "integer", description: "Start position (default 0)" },
        max_chars: { type: "integer", description: "Max characters to return (default 6000, max 20000)" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "query_page",
    description:
      "Ask a DOM sub-agent a question about the current page. It reads the FULL page text and the full list of interactive elements (far more than fits in your snapshot) and answers concisely, citing element refs [N] you can act on. " +
      "Use it to find things among many items (products, search results, emails, vacancies), to extract data (prices, names, dates), or to check whether something is present.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string", description: "A specific question about the page content" } },
      required: ["question"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "remember",
    description: "Save a short note to your persistent task memory (facts, IDs, prices, decisions). Notes survive context compaction, so record anything you must not forget.",
    input_schema: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "ask_user",
    description:
      "Pause and ask the user for information you genuinely cannot obtain yourself (login credentials, a choice between equally valid options with real consequences, confirmation before a payment or an irreversible action the task did not explicitly authorize). Do not use it for things you can figure out from the page.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "finish",
    description:
      "Declare the task finished. Call it only after verifying the result on the page. Provide the final report for the user: what was done, what was found, and anything left undone and why.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["success", "partial", "failed"] },
        summary: { type: "string", description: "Final report in the user's language" },
      },
      required: ["status", "summary"],
      additionalProperties: false,
    },
    strict: true,
  },
];
