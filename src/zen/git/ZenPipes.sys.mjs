/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Pipes for the console: `ls -a | grep youtube | close`.
//
// A pipe starts with a list (tabs or history), goes through filters, and
// may end in an action. This file has the parts that don't touch the
// browser (splitting the line, the filters, printing a row), so they can be
// tested with plain node. The console supplies the lists and the actions.
//
// An item is a plain object:
//   { kind: "tab" | "page", title, url, host, space, time, ref }
// where `time` is when it was last used and `ref` is the tab (for tabs).

/** Commands that can start a pipe. */
export const PIPE_SOURCES = ["ls", "history"];

/** Filters: items in, items out. */
export const PIPE_FILTERS = ["grep", "head", "tail", "sort", "uniq", "ai", "ai!"];

/** Actions: only last in a pipe. */
export const PIPE_ACTIONS = ["close", "open", "mv", "sleep", "copy", "wc"];

/**
 * Splits a line on `|`, except inside quotes (so `grep "a|b"` works).
 *
 * @param {string} line
 * @returns {string[]} The stages, trimmed. One stage means no pipe.
 * @throws When a stage is empty (`ls |` or `ls || close`).
 */
export function splitPipeline(line) {
  const stages = [];
  let current = "";
  let quote = null;
  for (const char of line || "") {
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === "|") {
      stages.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  stages.push(current.trim());
  if (stages.length > 1 && stages.some(stage => !stage)) {
    throw new Error("pipe: a command is missing on one side of a |");
  }
  return stages;
}

/**
 * Whether a line should run as a pipe: it has a `|` outside quotes and
 * starts with a command that makes a list. Anything else (like
 * `git log --format=a|b`) runs as it always did.
 *
 * @param {string} line
 * @returns {boolean}
 */
export function isPipeline(line) {
  let stages;
  try {
    stages = splitPipeline(line);
  } catch {
    return true; // Let the pipe report the empty stage.
  }
  if (stages.length < 2) {
    return false;
  }
  const first = stages[0].split(/\s+/)[0];
  return PIPE_SOURCES.includes(first);
}

// Case-insensitive unless the pattern has a capital letter ("smart case").
// Matches the text as typed or as a regex, so both `grep watch?v=1` (a
// URL) and `grep "daft|lo-fi"` (a regex) do what you'd expect.
function matcher(pattern) {
  const caseSensitive = /[A-Z]/.test(pattern);
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  let regex = null;
  try {
    regex = new RegExp(pattern, caseSensitive ? "" : "i");
  } catch {}
  return text =>
    (caseSensitive ? text : text.toLowerCase()).includes(needle) ||
    !!regex?.test(text);
}

function count(args, fallback) {
  const value = args.find(arg => /^-?\d+$/.test(arg));
  if (value === undefined) {
    return fallback;
  }
  return Math.abs(Number.parseInt(value, 10));
}

const SORT_KEYS = {
  title: item => (item.title || "").toLowerCase(),
  url: item => item.url || "",
  host: item => item.host || "",
  space: item => (item.space || "").toLowerCase(),
  // Most recent first, like `ls -t`.
  time: item => -(item.time || 0),
};

/**
 * Runs one filter.
 *
 * @param {object[]} items
 * @param {string} name - One of PIPE_FILTERS.
 * @param {string[]} args
 * @returns {object[]}
 */
export function applyFilter(items, name, args) {
  switch (name) {
    case "grep": {
      const invert = args.includes("-v");
      const urlOnly = args.includes("-u");
      const pattern = args.filter(arg => !/^-[vu]$/.test(arg)).join(" ");
      if (!pattern) {
        throw new Error("usage: grep [-v] [-u] <text or regex>");
      }
      const matches = matcher(pattern);
      return items.filter(item => {
        const haystack = urlOnly
          ? item.url || ""
          : `${item.title || ""} ${item.url || ""}`;
        return matches(haystack) !== invert;
      });
    }
    case "head":
      return items.slice(0, count(args, 10));
    case "tail": {
      const n = count(args, 10);
      return n ? items.slice(-n) : [];
    }
    case "sort": {
      const reverse = args.includes("-r");
      const keyName = args.find(arg => !arg.startsWith("-")) || "title";
      const key = SORT_KEYS[keyName];
      if (!key) {
        throw new Error(
          `sort: can sort by ${Object.keys(SORT_KEYS).join(", ")}`
        );
      }
      const sorted = [...items].sort((a, b) => {
        const x = key(a);
        const y = key(b);
        return x < y ? -1 : x > y ? 1 : 0;
      });
      return reverse ? sorted.reverse() : sorted;
    }
    case "uniq": {
      const seen = new Set();
      return items.filter(item => {
        if (seen.has(item.url)) {
          return false;
        }
        seen.add(item.url);
        return true;
      });
    }
  }
  throw new Error(`${name}: not a filter`);
}

/**
 * Checks a pipe's shape before anything runs, so `ls | close | grep x`
 * fails without closing anything.
 *
 * @param {string[][]} stages - Each stage tokenized.
 */
export function checkPipeline(stages) {
  const [source, ...rest] = stages;
  if (!PIPE_SOURCES.includes(source[0])) {
    throw new Error(
      `${source[0]}: can't start a pipe. Start with ${PIPE_SOURCES.join(" or ")}.`
    );
  }
  rest.forEach(([name], index) => {
    const last = index == rest.length - 1;
    if (PIPE_ACTIONS.includes(name)) {
      if (!last) {
        throw new Error(`${name}: has to be the last command in a pipe`);
      }
    } else if (!PIPE_FILTERS.includes(name)) {
      throw new Error(
        `${name}: can't be used in a pipe. Filters: ${PIPE_FILTERS.join(", ")}. ` +
          `Last: ${PIPE_ACTIONS.join(", ")}.`
      );
    }
  });
}

/**
 * One row of a pipe's output.
 *
 * @param {object} item
 * @param {object} [options]
 * @param {boolean} [options.showSpace] - Prefix the space (for ls -a).
 * @param {Function} [options.formatTime] - For history rows.
 * @returns {string}
 */
export function formatItem(item, { showSpace = false, formatTime } = {}) {
  const where = showSpace && item.space ? `${item.space}/ ` : "";
  const when =
    item.kind == "page" && formatTime && item.time
      ? `${formatTime(item.time)}  `
      : "";
  const host = item.host ? `  — ${item.host}` : "";
  return `${when}${where}${item.title || item.url}${host}`;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Reads the time range for `history`: today (the default), yesterday,
 * week, all, or a span like 3d / 12h. Other words become a search.
 *
 * @param {string[]} args
 * @param {Date} [now]
 * @returns {{from: number, to: number, search: string[]}} Times in ms.
 */
export function historyRange(args, now = new Date()) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const end = now.getTime() + 1;
  let range = { from: midnight.getTime(), to: end };
  const search = [];
  for (const arg of args) {
    const span = /^(\d+)([hdw])$/i.exec(arg);
    if (arg == "today") {
      range = { from: midnight.getTime(), to: end };
    } else if (arg == "yesterday") {
      range = { from: midnight.getTime() - DAY, to: midnight.getTime() };
    } else if (arg == "week") {
      range = { from: end - 7 * DAY, to: end };
    } else if (arg == "all") {
      range = { from: 0, to: end };
    } else if (span) {
      const unit = { h: DAY / 24, d: DAY, w: 7 * DAY }[span[2].toLowerCase()];
      range = { from: end - Number(span[1]) * unit, to: end };
    } else {
      search.push(arg);
    }
  }
  return { ...range, search };
}
