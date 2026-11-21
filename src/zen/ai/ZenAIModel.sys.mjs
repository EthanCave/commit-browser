/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The parts of Commit's AI features that don't touch the browser: request
// bodies, prompts, response schemas, checking what comes back, and cost.
// No browser APIs here, so all of it can be tested with plain node.
//
// Commit calls the Claude API over plain HTTP: the browser's own code has
// no package system to load the npm SDK from.

export const API_URL = "https://api.anthropic.com/v1/messages";
export const API_VERSION = "2026-10-21";
// Two tiers: a fast, cheap model for short jobs (commit messages, catch-up,
// tidy, ai! filters) and a smarter one for reading many pages (ask) and
// web research (do). Both can be changed with `ai model`.
export const DEFAULT_MODELS = {
  fast: "claude-haiku-5-5",
  smart: "claude-sonnet-5-5",
};

// When a model declines a request on safety grounds, the API re-runs it on
// a fallback model it picks ("default"), inside the same call.
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

// $ per million tokens. `cacheRead` is what a cached input token costs
// (Sonnet and Opus 5.5 read their cache at 5% of the input price); `long`
// is the higher price Haiku charges for prompts over 100K tokens. Cache
// writes cost 1.25× input. Unknown models show no cost.
export const PRICES = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, long: { input: 0.5, output: 2.5, cacheRead: 0.05 } },
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
};
const WEB_SEARCH_COST = 10 / 1000; // $10 per 1,000 searches

export function supportsFallbacks(model) {
  return /^claude-(opus-5|sonnet-5-5|fable-5)/.test(model);
}

/**
 * @param {object} options
 * @param {string} options.model
 * @param {string} options.system
 * @param {object[]} options.messages
 * @param {string} [options.effort] - low, medium, high, xhigh or max.
 * @param {number} [options.maxTokens]
 * @param {object} [options.schema] - JSON schema the answer must follow.
 * @param {object[]} [options.tools]
 * @param {boolean} [options.stream]
 * @returns {object} The request body.
 */
export function buildRequest({
  model,
  system,
  messages,
  effort = "low",
  maxTokens = 16000,
  schema = null,
  tools = null,
  stream = false,
  cache = false,
}) {
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages,
    output_config: { effort },
  };
  if (schema) {
    body.output_config.format = { type: "json_schema", schema };
  }
  if (tools) {
    body.tools = tools;
  }
  if (stream) {
    body.stream = true;
  }
  // Automatic prompt caching: for loops that resend a growing conversation
  // (`do`), each request reads everything before its new turn from cache.
  if (cache) {
    body.cache_control = { type: "ephemeral" };
  }
  if (supportsFallbacks(model)) {
    body.fallbacks = "default";
  }
  return body;
}

export function buildHeaders(key, model) {
  const headers = {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": API_VERSION,
    // Commit's requests come from a browser; this tells the API that's
    // deliberate (the key is the user's own, kept in Commit's password store).
    "anthropic-dangerous-direct-browser-access": "true",
  };
  if (supportsFallbacks(model)) {
    headers["anthropic-beta"] = FALLBACK_BETA;
  }
  return headers;
}

/**
 * Turns an API error response into a sentence for the console.
 *
 * @param {number} status
 * @param {object|null} body - The parsed error body, if any.
 * @returns {string}
 */
export function describeError(status, body) {
  const message = body?.error?.message || "";
  switch (status) {
    case 401:
      return "Your Anthropic API key didn't work. Set a new one with `ai key`.";
    case 403:
      return `The API refused this key: ${message || "permission denied"}.`;
    case 404:
      return `The API doesn't know that model or feature: ${message}`;
    case 413:
      return "That's too much text to send in one request. Try fewer tabs.";
    case 429:
      return "Rate limited by the API. Wait a moment and try again.";
    case 529:
      return "The API is overloaded right now. Try again in a minute.";
  }
  if (status >= 500) {
    return `The API had an error (${status}). Try again.`;
  }
  return `The API said no (${status}): ${message || "bad request"}`;
}

/** @returns {string} Every text block, joined. */
export function textOf(response) {
  return (response?.content || [])
    .filter(block => block.type == "text")
    .map(block => block.text)
    .join("");
}

/**
 * Throws a readable error if the response can't be used.
 *
 * @param {object} response
 */
export function checkStop(response) {
  switch (response?.stop_reason) {
    case "refusal":
      throw new Error(
        "Claude declined this one" +
          (response.stop_details?.explanation
            ? `: ${response.stop_details.explanation}`
            : ".")
      );
    case "max_tokens":
      throw new Error("Claude's answer was cut off (too long). Try asking for less.");
  }
}

/** @returns {object} The JSON answer of a structured-output request. */
export function jsonOf(response) {
  checkStop(response);
  const text = textOf(response);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Claude's answer wasn't the JSON Commit asked for.");
  }
}

/**
 * @param {object} usage - The response's usage.
 * @param {string} model
 * @returns {number|null} Dollars, or null for a model without a price.
 */
export function costOf(usage, model) {
  const price = PRICES[model];
  if (!usage || !price) {
    return null;
  }
  const prompt =
    (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0);
  const { input, output, cacheRead } = prompt > 100000 && price.long ? price.long : price;
  const tokens =
    (usage.input_tokens || 0) * input +
    (usage.cache_creation_input_tokens || 0) * input * 1.25 +
    (usage.cache_read_input_tokens || 0) * cacheRead +
    (usage.output_tokens || 0) * output;
  const searches = usage.server_tool_use?.web_search_requests || 0;
  return tokens / 1e6 + searches * WEB_SEARCH_COST;
}

export function formatCost(dollars) {
  if (dollars == null) {
    return "";
  }
  if (dollars < 0.01) {
    return "<$0.01";
  }
  return `$${dollars.toFixed(2)}`;
}

/**
 * Reads server-sent events as they arrive.
 *
 * @param {string} buffer - Text not yet parsed, plus the new chunk.
 * @returns {{events: object[], rest: string}} Parsed `data:` payloads and
 *   the unfinished tail to carry into the next call.
 */
export function parseSSE(buffer) {
  const events = [];
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop();
  for (const part of parts) {
    const data = part
      .split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart())
      .join("\n");
    if (!data) {
      continue;
    }
    try {
      events.push(JSON.parse(data));
    } catch {}
  }
  return { events, rest };
}

/**
 * Builds the final message from a stream's events, the same shape a
 * non-streaming request returns.
 */
export class StreamAssembler {
  message = null;

  add(event) {
    switch (event.type) {
      case "message_start":
        this.message = { ...event.message, content: [] };
        break;
      case "content_block_start":
        this.message.content[event.index] = { ...event.content_block };
        break;
      case "content_block_delta": {
        const block = this.message.content[event.index];
        if (event.delta.type == "text_delta") {
          block.text = (block.text || "") + event.delta.text;
          return event.delta.text;
        }
        if (event.delta.type == "citations_delta") {
          block.citations = [...(block.citations || []), event.delta.citation];
        }
        break;
      }
      case "message_delta":
        Object.assign(this.message, event.delta);
        this.message.usage = { ...this.message.usage, ...event.usage };
        break;
      case "error":
        throw new Error(event.error?.message || "The API stream failed.");
    }
    return "";
  }
}

// ---------------------------------------------------------------------------
// Lists of tabs and pages, as Claude sees them

function ago(ms, now) {
  if (!ms || !Number.isFinite(ms)) {
    return "";
  }
  const hours = (now - ms) / 3600000;
  if (hours < 1) {
    return "just now";
  }
  if (hours < 48) {
    return `${Math.round(hours)}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * One numbered line per item: what Claude reads to pick or group them.
 *
 * @param {object[]} items - Pipe items (ZenPipes.sys.mjs).
 * @param {number} [now]
 * @returns {string}
 */
export function itemLines(items, now = Date.now()) {
  return items
    .map((item, index) => {
      const details = [
        item.space,
        item.kind == "tab" ? `used ${ago(item.time, now)}` : ago(item.time, now),
        item.folder && `folder "${item.folder}"`,
        item.essential && "Essential",
      ].filter(Boolean);
      return `[${index}] ${item.title || "(untitled)"} | ${item.url}${
        details.length ? ` | ${details.join(", ")}` : ""
      }`;
    })
    .join("\n");
}

export const MAX_FILTER_ITEMS = 600;

const INDEX_LIST = {
  type: "array",
  items: { type: "integer" },
};

// --- ai (pipe filter) --------------------------------------------------------

export const FILTER_SCHEMA = {
  type: "object",
  properties: { matches: INDEX_LIST },
  required: ["matches"],
  additionalProperties: false,
};

export function filterRequest(instruction, items, now) {
  return {
    system:
      "You filter a list of browser tabs or history pages for a command-line pipe. " +
      "Each line is `[index] title | url | details`. Return the indices of the lines " +
      "that match the user's description, judged by meaning rather than exact words. " +
      "If none match, return an empty list. Don't add items that only loosely relate.",
    messages: [
      {
        role: "user",
        content: `<items>\n${itemLines(items, now)}\n</items>\n\nKeep the items that are: ${instruction}`,
      },
    ],
    schema: FILTER_SCHEMA,
  };
}

/**
 * @param {object} answer - From FILTER_SCHEMA.
 * @param {number} count - How many items were sent.
 * @returns {number[]} Valid, unique indices in list order.
 */
export function validIndices(answer, count) {
  const seen = new Set(
    (answer?.matches || []).filter(
      index => Number.isInteger(index) && index >= 0 && index < count
    )
  );
  return [...seen].sort((a, b) => a - b);
}

// --- commit messages ---------------------------------------------------------

export function commitMessageRequest(spaceName, diffLines) {
  return {
    system:
      "You write commit messages for a browser that versions its tab layout with git. " +
      "Given the tabs opened, closed and changed in a space, write one line saying what " +
      "the person was doing, like a journal entry: specific, under 60 characters, no " +
      "quotes, no trailing period, no 'Layout:' prefix. " +
      'Examples: "Planning Tokyo trip: flights and two hotels", ' +
      '"Debugging the sync bug in zen-browser/desktop".',
    messages: [
      {
        role: "user",
        content: `Space: ${spaceName}\n\nChanges since the last commit:\n${diffLines
          .slice(0, 400)
          .join("\n")}`,
      },
    ],
  };
}

export function cleanCommitMessage(text) {
  const line = String(text || "")
    .split("\n")
    .map(part => part.trim())
    .find(Boolean);
  if (!line) {
    return "";
  }
  const cleaned = line
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\.$/, "")
    .trim();
  return cleaned.length > 72 ? `${cleaned.slice(0, 71)}…` : cleaned;
}

// --- checkout by meaning -----------------------------------------------------

export const PICK_COMMIT_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    index: { type: "integer" },
  },
  required: ["found", "index"],
  additionalProperties: false,
};

/**
 * Whether `checkout <words>` should search commit messages: several words
 * that aren't a branch, a hash or a time.
 */
export function looksLikeDescription(words) {
  return words.length >= 2 || /\s/.test(words[0] || "");
}

export function pickCommitRequest(description, entries) {
  const lines = entries
    .map((entry, index) => `[${index}] ${entry.when} — ${entry.subject}`)
    .join("\n");
  return {
    system:
      "You find a commit in a browser space's history. Each line is " +
      "`[index] when — message`, newest first. Pick the single commit that best matches " +
      "the description. Set found to false (index 0) if none plausibly matches.",
    messages: [
      {
        role: "user",
        content: `<commits>\n${lines}\n</commits>\n\nFind: ${description}`,
      },
    ],
    schema: PICK_COMMIT_SCHEMA,
  };
}

// --- ask ---------------------------------------------------------------------

/**
 * Shares a character budget between pages: short pages are sent whole and
 * what they don't use goes to the long ones.
 *
 * @param {object[]} docs - { title, url, text }
 * @param {number} budget - Total characters.
 * @returns {object[]} Same docs with text cut to fit, plus `cut: true`.
 */
export function fitDocs(docs, budget) {
  const result = docs.map(doc => ({ ...doc, text: doc.text || "" }));
  let remaining = budget;
  let open = [...result].sort((a, b) => a.text.length - b.text.length);
  while (open.length) {
    const share = Math.floor(remaining / open.length);
    const doc = open[0];
    if (doc.text.length <= share) {
      remaining -= doc.text.length;
      open.shift();
      continue;
    }
    for (const rest of open) {
      rest.text = rest.text.slice(0, share);
      rest.cut = true;
    }
    break;
  }
  return result;
}

export function askRequest(question, docs) {
  const pages = docs
    .map(
      (doc, index) =>
        `<page index="${index + 1}" title="${escapeAttr(doc.title)}" url="${escapeAttr(doc.url)}">\n` +
        `${doc.text || "(no text: the tab is asleep or not a web page)"}${doc.cut ? "\n[…cut]" : ""}\n</page>`
    )
    .join("\n");
  return {
    system:
      "You answer questions about the tabs someone has open in their browser. Use only " +
      "the pages given; if they don't contain the answer, say so. Cite pages inline as " +
      "[1], [2] by their index. Answer for a narrow console: plain text, short paragraphs " +
      "or `-` bullets, and simple aligned columns instead of markdown tables. No headings.",
    messages: [
      {
        role: "user",
        content: `<pages>\n${pages}\n</pages>\n\n${question}`,
      },
    ],
  };
}

function escapeAttr(text) {
  return String(text || "").replace(/[&"<>]/g, char => `&#${char.charCodeAt(0)};`);
}

// --- tidy --------------------------------------------------------------------

export const TIDY_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    folders: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, tabs: INDEX_LIST },
        required: ["name", "tabs"],
        additionalProperties: false,
      },
    },
    move: {
      type: "array",
      items: {
        type: "object",
        properties: { tab: { type: "integer" }, space: { type: "string" } },
        required: ["tab", "space"],
        additionalProperties: false,
      },
    },
    close: {
      type: "array",
      items: {
        type: "object",
        properties: { tab: { type: "integer" }, reason: { type: "string" } },
        required: ["tab", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "folders", "move", "close"],
  additionalProperties: false,
};

export function tidyRequest(spaceName, items, otherSpaces, now) {
  return {
    system:
      "You tidy one space of a browser's tab sidebar. Propose: folders for tabs that " +
      "clearly belong together (2+ tabs, short names); moving tabs that obviously belong " +
      "in one of the other spaces listed; closing exact duplicates, empty or error pages, " +
      "login/redirect leftovers, and searches whose result was already opened. Be " +
      "conservative: when unsure, leave a tab alone. Never touch Essentials. A tab goes " +
      "in at most one action. `summary` is one short sentence.",
    messages: [
      {
        role: "user",
        content:
          `Space: ${spaceName}\nOther spaces: ${otherSpaces.join(", ") || "(none)"}\n\n` +
          `<tabs>\n${itemLines(items, now)}\n</tabs>`,
      },
    ],
    schema: TIDY_SCHEMA,
  };
}

/**
 * Drops anything in a tidy plan that can't or shouldn't be done: unknown
 * tabs, Essentials, unknown spaces, tabs in two actions (close wins, then
 * move, then folder) and folders left with fewer than two tabs.
 *
 * @returns {object} { summary, folders, move, close }
 */
export function cleanTidyPlan(plan, items, spaceNames) {
  const valid = index =>
    Number.isInteger(index) && index >= 0 && index < items.length && !items[index].essential;
  const used = new Set();
  const take = index => {
    if (!valid(index) || used.has(index)) {
      return false;
    }
    used.add(index);
    return true;
  };
  const close = (plan?.close || []).filter(({ tab }) => take(tab));
  const lowerSpaces = new Map(spaceNames.map(name => [name.toLowerCase(), name]));
  const move = (plan?.move || [])
    .map(({ tab, space }) => ({ tab, space: lowerSpaces.get(String(space).toLowerCase()) }))
    .filter(({ tab, space }) => space && space != items[tab]?.space && take(tab));
  const folders = (plan?.folders || [])
    .map(({ name, tabs }) => ({
      name: String(name || "").trim().slice(0, 40),
      tabs: (tabs || []).filter(take),
    }))
    .filter(folder => {
      if (folder.name && folder.tabs.length >= 2) {
        return true;
      }
      folder.tabs.forEach(tab => used.delete(tab));
      return false;
    });
  return { summary: String(plan?.summary || ""), folders, move, close };
}

export function tidyIsEmpty(plan) {
  return !plan.folders.length && !plan.move.length && !plan.close.length;
}

/** The plan as lines, like `git status`: [text, kind]. */
export function formatTidy(plan, items) {
  const title = index => items[index]?.title || items[index]?.url || "?";
  const lines = [];
  for (const folder of plan.folders) {
    lines.push([`+ folder "${folder.name}"`, "added"]);
    for (const tab of folder.tabs) {
      lines.push([`    ${title(tab)}`, ""]);
    }
  }
  for (const { tab, space } of plan.move) {
    lines.push([`~ ${title(tab)}  → ${space}`, "modified"]);
  }
  for (const { tab, reason } of plan.close) {
    lines.push([`- ${title(tab)}  (${reason})`, "deleted"]);
  }
  return lines;
}

// --- catch me up -------------------------------------------------------------

export function catchUpRequest({ spaceName, away, commits, tabs, changes }) {
  return {
    system:
      "Someone is coming back to a space in their browser after time away. In exactly " +
      "three short lines (under 90 characters each, no bullets or labels), tell them: " +
      "what they were working on, where they left off, and what looks unfinished. Be " +
      "concrete, using page names. Speak to them as 'you'.",
    messages: [
      {
        role: "user",
        content:
          `Space: ${spaceName}\nAway for: ${away}\n\n` +
          `Recent commits (newest first):\n${commits.join("\n") || "(none)"}\n\n` +
          `Open tabs (most recently used first):\n${tabs.join("\n") || "(none)"}\n\n` +
          `Changes since the last commit:\n${changes.slice(0, 60).join("\n") || "(none)"}`,
      },
    ],
  };
}

export function catchUpLines(text) {
  return String(text || "")
    .split("\n")
    .map(line => line.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
}

/** "3 days", "14 hours". */
export function awayFor(ms) {
  const hours = Math.round(ms / 3600000);
  if (hours < 48) {
    return `${hours} hour${hours == 1 ? "" : "s"}`;
  }
  const days = Math.round(hours / 24);
  return `${days} days`;
}

// --- do ------------------------------------------------------------------------

// Server tools: Anthropic runs the searches and fetches, so `do` can read
// the web but has no way to click, type, buy or sign in to anything. The
// newer versions (which filter results before Claude reads them) need
// Sonnet or Opus; Haiku gets the basic ones.
export function doTools(model) {
  const basic = /^claude-haiku/.test(model);
  return [
    { type: basic ? "web_search_20250305" : "web_search_20260209", name: "web_search", max_uses: 8 },
    { type: basic ? "web_fetch_20250910" : "web_fetch_20260209", name: "web_fetch", max_uses: 8 },
  ];
}

/**
 * The current moment as Claude should read it: "Friday, November 20, 2026
 * at 11:48 PM (America/Chicago)".
 *
 * @param {Date} [date]
 * @param {string} [timeZone] - IANA name; the system's when omitted.
 */
export function describeNow(date = new Date(), timeZone = undefined) {
  const text = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(date);
  return timeZone ? `${text} (${timeZone})` : text;
}

// Shared by both kinds of `do`: when and where the person is, and what to
// do with it for anything that has opening hours.
function doContext(now, location) {
  return (
    `Right now it is ${now} for the person.` +
    (location ? ` They are in ${location}; "near me" or "nearby" means there.` : "") +
    " When the task involves places or businesses, use the current time and the hours you " +
    "find to say for each one whether it is open now and when it closes (or when it opens " +
    "next), and say where the hours came from. If you can't find hours, or they may be out " +
    "of date (holidays, an old article), say so rather than guessing. "
  );
}

const CONSOLE_STYLE =
  "Plain text for a narrow console: short lines, `-` bullets, no headings, tables or " +
  "markdown emphasis.";

export function doRequest(task, now, model = DEFAULT_MODELS.smart, location = "") {
  return {
    system:
      doContext(now, location) +
      "You research a task on the web for someone and report back in a browser's console. " +
      "Search and read pages as needed, then answer with what they asked for: concrete " +
      "options with prices, dates or numbers where relevant, each with its source. You can " +
      "only read the web; if the task needs buying, booking or signing in, find the options " +
      "and say what they'd do next. " +
      CONSOLE_STYLE,
    messages: [{ role: "user", content: task }],
    tools: doTools(model),
  };
}

/**
 * What share of the input tokens across responses came from the cache.
 *
 * @returns {number} 0 to 1.
 */
export function cachedShare(usages) {
  let cached = 0;
  let total = 0;
  for (const usage of usages) {
    const read = usage?.cache_read_input_tokens || 0;
    cached += read;
    total += read + (usage?.input_tokens || 0) + (usage?.cache_creation_input_tokens || 0);
  }
  return total ? cached / total : 0;
}

/** One progress line per search or fetch in a response. */
export function progressOf(response) {
  const lines = [];
  for (const block of response?.content || []) {
    // server_tool_use: Anthropic's search; tool_use: Tavily, run by Commit.
    if (block.type != "server_tool_use" && block.type != "tool_use") {
      continue;
    }
    if (block.name == "web_search" && block.input?.query) {
      lines.push(`searching: ${block.input.query}`);
    } else if ((block.name == "web_fetch" || block.name == "read_page") && block.input?.url) {
      lines.push(`reading: ${block.input.url}`);
    }
  }
  return lines;
}

/**
 * The pages an answer relied on: cited pages first, then fetched pages.
 *
 * @returns {{title: string, url: string}[]}
 */
export function sourcesOf(responses) {
  const cited = new Map();
  const fetched = new Map();
  for (const response of responses) {
    for (const block of response?.content || []) {
      for (const citation of block.citations || []) {
        if (citation.url && !cited.has(citation.url)) {
          cited.set(citation.url, citation.title || citation.url);
        }
      }
      if (block.type == "web_fetch_tool_result") {
        const url = block.content?.url;
        if (url && !fetched.has(url)) {
          fetched.set(url, block.content?.content?.title || url);
        }
      }
    }
  }
  for (const url of cited.keys()) {
    fetched.delete(url);
  }
  return [...cited, ...fetched].map(([url, title]) => ({ url, title }));
}

const TIME_ONLY_WORDS = new Set(
  (
    "now today yesterday tonight morning noon afternoon evening night midnight ago " +
    "last next this week weeks month months year years day days hour hours minute " +
    "minutes monday tuesday wednesday thursday friday saturday sunday mon tue wed thu " +
    "fri sat sun jan feb mar apr may jun jul aug sep oct nov dec january february " +
    "march april june july august september october november december at on the in " +
    "a an of around about before after and"
  ).split(" ")
);

/**
 * Whether every word is part of a time ("last tuesday 3pm", "2 days ago"),
 * as opposed to a description that happens to contain one ("the week I
 * planned Tokyo").
 */
export function isJustATime(text) {
  const words = String(text || "")
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  return (
    words.length > 0 &&
    words.every(
      word =>
        TIME_ONLY_WORDS.has(word) ||
        /^\d+(st|nd|rd|th)?$/.test(word) ||
        /^\d{1,2}(:\d{2})?(am|pm)?$/.test(word) ||
        /^\d{4}-\d{2}-\d{2}$/.test(word)
    )
  );
}

// ---------------------------------------------------------------------------
// Local search with an embedding model (EmbeddingGemma through Ollama): the
// `ai` filter and `checkout "<description>"` run on this Mac, free and
// private. Tested on a week of real history: keeping everything within 70%
// of the best score found 10 of 11 matches with none wrong.

export const LOCAL_MODEL = "embeddinggemma";
export const KEEP_RATIO = 0.7;
// Below this, even the best match isn't really about the query.
export const MIN_SCORE = 0.19;

/** What gets embedded for a tab, page or commit: title and site. */
export function embeddingText(title, url = "") {
  const clean = String(title || "").replace(/^\(\d+\)\s*/, "").trim();
  let host = "";
  try {
    host = url ? new URL(url).host.replace(/^www\./, "") : "";
  } catch {}
  return `title: none | text: ${clean || url}${host ? ` (${host})` : ""}`;
}

export function queryText(query) {
  return `task: search result | query: ${query}`;
}

export function cosine(a, b) {
  let dot = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    x += a[i] * a[i];
    y += b[i] * b[i];
  }
  return x && y ? dot / Math.sqrt(x * y) : 0;
}

/**
 * @param {number[]} scores - One per item.
 * @param {object} [options]
 * @returns {number[]} Indices of the items to keep, in list order.
 */
export function selectByScore(scores, { ratio = KEEP_RATIO, floor = MIN_SCORE } = {}) {
  const best = Math.max(...scores, -Infinity);
  if (!(best >= floor)) {
    return [];
  }
  const cutoff = Math.max(best * ratio, floor);
  return scores.map((score, i) => (score >= cutoff ? i : -1)).filter(i => i >= 0);
}

/** Float vector ↔ base64, for keeping embeddings on disk. */
export function vectorToBase64(vector) {
  const bytes = new Uint8Array(Float32Array.from(vector).buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToVector(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer);
}

// ---------------------------------------------------------------------------
// `do` with Tavily: Claude asks for searches and pages through two tools,
// and Commit runs them with the Tavily CLI (your Tavily login, your
// credits). Still read-only: the tools can only search and read.

export const DO_LIMITS = { searches: 8, reads: 8, turns: 14 };

export const TAVILY_TOOLS = [
  {
    name: "web_search",
    description:
      "Search the web (Tavily). Returns up to 6 results, each with a title, URL and an excerpt. " +
      "Use short, specific queries; search again with different words if results are poor.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "What to search for." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_page",
    description:
      "Read the parts of a web page that matter for the task. Use it on promising URLs from " +
      "web_search when the excerpt isn't enough (prices, dates, details).",
    strict: true,
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "An http(s) URL." } },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

export function doTavilyRequest(task, now, location = "") {
  return {
    system:
      doContext(now, location) +
      "You research a task on the web for someone and report back in a browser's console, " +
      "using the web_search and read_page tools. Search, read the most promising pages, then " +
      "answer with what they asked for: concrete options with prices, dates or numbers where " +
      "relevant. You can only read the web; if the task needs buying, booking or signing in, " +
      "find the options and say what they'd do next. " +
      CONSOLE_STYLE +
      " Mark claims with [1], [2] and end with a line `Sources:` followed by one `[n] URL` per line.",
    messages: [{ role: "user", content: task }],
    tools: TAVILY_TOOLS,
  };
}

/** Search results as Claude reads them. */
export function formatSearchResults(json, max = 6) {
  const results = (json?.results || []).slice(0, max);
  if (!results.length) {
    return "No results.";
  }
  return results
    .map(
      (result, index) =>
        `[${index + 1}] ${result.title || "(untitled)"}\n${result.url}\n${String(result.content || "")
          .replace(/\s+/g, " ")
          .slice(0, 800)}`
    )
    .join("\n\n");
}

/** A page from extract as Claude reads it, cut to a sane size. */
export function formatPage(json, url, max = 12000) {
  const page = (json?.results || [])[0];
  if (!page?.raw_content) {
    const failed = (json?.failed_results || [])[0];
    return `Couldn't read ${url}${failed?.error ? `: ${failed.error}` : "."}`;
  }
  const text = page.raw_content.replace(/\n{3,}/g, "\n\n");
  return `${page.title || url}\n${page.url || url}\n\n${text.slice(0, max)}${text.length > max ? "\n[…cut]" : ""}`;
}

/** The `[n] URL` lines after "Sources:" in an answer. */
export function sourcesFromText(text) {
  const after = String(text || "").split(/\n\s*Sources:\s*\n/i)[1] || "";
  const urls = [];
  for (const line of after.split("\n")) {
    const match = /(https?:\/\/\S+)/.exec(line);
    const url = match?.[1].replace(/[).,]+$/, "");
    if (url && !urls.includes(url)) {
      urls.push(url);
    }
  }
  return urls;
}

/**
 * Splits `**bold**` (and `__bold__`) out of a line, for the console, which
 * shows text rather than markdown. An unclosed marker stays as typed.
 *
 * @returns {{text: string, bold: boolean}[]}
 */
export function inlineSegments(line) {
  const segments = [];
  const pattern = /(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g;
  let last = 0;
  for (const match of String(line).matchAll(pattern)) {
    if (match.index > last) {
      segments.push({ text: line.slice(last, match.index), bold: false });
    }
    segments.push({ text: match[2], bold: true });
    last = match.index + match[0].length;
  }
  if (last < line.length) {
    segments.push({ text: line.slice(last), bold: false });
  }
  return segments;
}
