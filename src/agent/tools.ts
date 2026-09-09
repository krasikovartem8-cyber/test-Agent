import type Anthropic from "@anthropic-ai/sdk";

/**
 * Tool surface exposed to the model. Deliberately generic: nothing here knows
 * about any particular website. The model decides what to click, type and read.
 *
 * Descriptions are kept terse on purpose - they are re-sent on every request,
 * so verbosity here is a per-turn tax on every task.
 */
export const TOOLS: Anthropic.Tool[] = [
  {
    name: "navigate",
    description: "Open a URL in the active tab.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "get_page_state",
    description:
      "Observe the page: URL, numbered interactive elements [N] and the start of the visible text. You already get this after every action, so call it only for a fresh or fuller view.",
    input_schema: {
      type: "object",
      properties: { include_screenshot: { type: "boolean" } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "screenshot",
    description: "Screenshot of the viewport. For layout, modals, maps, images.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "click",
    description: "Click element [N] from the latest page state.",
    input_schema: {
      type: "object",
      properties: { ref: { type: "integer" } },
      required: ["ref"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "click_at",
    description: "Click viewport coordinates (1280x800). Fallback for canvases and maps.",
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
    description: "Type into element [N]. Clears it first unless clear=false. press_enter submits.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "integer" },
        text: { type: "string" },
        clear: { type: "boolean" },
        press_enter: { type: "boolean" },
      },
      required: ["ref", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "press_key",
    description: "Press a key: Enter, Escape, Tab, ArrowDown, Control+A…",
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
    description: "Scroll the page, or a container given by ref, to reveal more.",
    input_schema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        pixels: { type: "integer" },
        ref: { type: "integer" },
      },
      required: ["direction"],
      additionalProperties: false,
    },
  },
  {
    name: "select_option",
    description: "Choose an option in a native <select> by visible label.",
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
    description: "Hover element [N] to open menus or tooltips.",
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
    description: "Wait N seconds (max 30) for content to load.",
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
    description: "Back in browser history.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "list_tabs",
    description: "List open tabs; the active one is marked *.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "switch_tab",
    description: "Activate another tab by index.",
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
    description: "Read the page text in chunks (offset, max_chars). Prefer query_page.",
    input_schema: {
      type: "object",
      properties: { offset: { type: "integer" }, max_chars: { type: "integer" } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "query_page",
    description:
      "Ask a sub-agent about the current page. It reads the whole page and answers briefly with element refs [N]. Use it to find one item among many (products, results, emails, vacancies) or to extract data.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "remember",
    description: "Save a short note (facts, IDs, prices). Notes survive context compaction.",
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
      "Ask the user for what you cannot get yourself: credentials, a real choice between options, confirmation before paying or anything irreversible the task did not authorize.",
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
    description: "End the task after verifying the result. Report in the user's language: what you did, concrete data found, what is left undone.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["success", "partial", "failed"] },
        summary: { type: "string" },
      },
      required: ["status", "summary"],
      additionalProperties: false,
    },
    strict: true,
  },
];
