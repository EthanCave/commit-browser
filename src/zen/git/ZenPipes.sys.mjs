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

import { tokenize } from "./ZenGitModel.sys.mjs";

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

// ---------------------------------------------------------------------------
// Several commands on a line, aliases and the startup file
//
//   switch thesis && focus 50m      the second runs if the first worked
//   archive now; gc                 the second runs either way
//   alias study='switch thesis && focus 50m && play music lofi'

/**
 * Whether a quote character at `index` starts or ends a quoted part. A `'`
 * inside a word is an apostrophe ("what's due"), not a quote: one that
 * opens has no letter before it, and one that closes has none after it.
 *
 * @param {string} line
 * @param {number} index
 * @param {boolean} open Whether we are outside quotes (so it would open).
 * @returns {boolean}
 */
function isQuote(line, index, open) {
  const char = line[index];
  if (char === '"') {
    return true;
  }
  if (char !== "'") {
    return false;
  }
  const word = /[\p{L}\p{N}]/u;
  return open
    ? !word.test(line[index - 1] || "")
    : !word.test(line[index + 1] || "");
}

/**
 * Commands that take free text (`ask summarize this; be brief`). In them,
 * && and ; only split the line when a command or alias follows.
 */
export const FREE_TEXT_COMMANDS = ["ask", "do", "g", "search", "cd", "open"];

const firstWord = text => /^\s*([^\s|;&'"]+)/.exec(text)?.[1] || "";

/**
 * Splits a line into commands joined by `&&` (run the next one only if this
 * one worked) or `;` (run it either way), except inside quotes.
 *
 * @param {string} line
 * @param {Function|null} [isCommand] name -> whether it is a command or
 *   alias; used for FREE_TEXT_COMMANDS. Without it, && and ; always split.
 * @returns {{text: string, op: "&&"|";"|null}[]} `op` joins a command to the
 *   one before it.
 * @throws When a command is missing (`a &&`, `&& b`).
 */
export function splitSequence(line, isCommand = null) {
  const text = line || "";
  const steps = [];
  let current = "";
  let quote = null;
  let op = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote && (quote === '"' || isQuote(text, i, false))) {
        quote = null;
      }
      current += char;
      continue;
    }
    if ((char === '"' || char === "'") && isQuote(text, i, true)) {
      quote = char;
      current += char;
      continue;
    }
    const and = char === "&" && text[i + 1] === "&";
    const literal =
      isCommand &&
      FREE_TEXT_COMMANDS.includes(firstWord(current)) &&
      !isCommand(firstWord(text.slice(i + (and ? 2 : 1))));
    if ((and || char === ";") && !literal) {
      steps.push({ text: current.trim(), op });
      op = and ? "&&" : ";";
      current = "";
      i += and ? 1 : 0;
      continue;
    }
    current += char;
  }
  steps.push({ text: current.trim(), op });
  // A trailing ; is fine, as in a shell.
  if (steps.length > 1 && !steps.at(-1).text && steps.at(-1).op === ";") {
    steps.pop();
  }
  if (steps.length > 1 && steps.some(step => !step.text)) {
    throw new Error("A command is missing on one side of && or ;");
  }
  return steps;
}

/** What an alias name may look like: `study`, `yt-close`, `gh2`. */
export const ALIAS_NAME = /^[A-Za-z_][\w.-]*$/;

/** Commands an alias can't replace, so aliases can always be fixed. */
export const PROTECTED_COMMANDS = ["alias", "unalias", "startup", "help"];

const quoteIfNeeded = word => (/\s/.test(word) ? `"${word}"` : word);

/**
 * Puts the words typed after an alias into its body: in place of $1..$9 and
 * $@ when the body has them, else at the end (like a shell alias).
 *
 * @param {string} body
 * @param {string} rest What was typed after the alias's name.
 * @returns {string}
 */
function withArgs(body, rest) {
  const args = rest.trim();
  if (!/\$(@|\*|[1-9])/.test(body)) {
    return args ? `${body} ${args}` : body;
  }
  const words = tokenize(args);
  return body.replace(/\$(@|\*|[1-9])/g, (_, which) =>
    which === "@" || which === "*"
      ? args
      : quoteIfNeeded(words[Number(which) - 1] ?? "")
  );
}

/**
 * Replaces the first word of a command when it is an alias.
 *
 * @param {string} text
 * @param {Map<string, string>} aliases
 * @param {Set<string>} seen Aliases already being expanded (not again).
 * @returns {{text: string, used: string|null}}
 */
function expandFirstWord(text, aliases, seen) {
  const match = /^\s*([^\s|;&'"]+)(.*)$/s.exec(text);
  const name = match?.[1];
  if (!name || !aliases.has(name) || seen.has(name)) {
    return { text, used: null };
  }
  return { text: withArgs(aliases.get(name), match[2]), used: name };
}

/**
 * In a pipe, aliases also work after a `|`: ls -a | yt | close.
 *
 * @param {string} text
 * @param {Map<string, string>} aliases
 * @param {Set<string>} seen
 * @returns {string}
 */
function expandStages(text, aliases, seen) {
  if (!isPipeline(text)) {
    return text;
  }
  return splitPipeline(text)
    .map((stage, index) => {
      if (index === 0) {
        return stage;
      }
      const used = new Set(seen);
      let current = stage;
      for (let depth = 0; depth < 10; depth++) {
        const next = expandFirstWord(current, aliases, used);
        if (!next.used) {
          break;
        }
        used.add(next.used);
        current = next.text;
      }
      return current;
    })
    .join(" | ");
}

/**
 * Splits a line into commands (see splitSequence) and expands aliases in
 * each. An alias may hold several commands, pipes and other aliases; one
 * that uses its own name runs the real command, like `alias ls='ls -a'`.
 *
 * @param {string} line
 * @param {Map<string, string>} aliases name -> body
 * @param {Function|null} [isCommand] See splitSequence.
 * @param {Set<string>} [seen] Aliases being expanded (for recursion).
 * @param {number} [depth]
 * @returns {{text: string, op: "&&"|";"|null}[]}
 */
export function expandLine(line, aliases, isCommand = null, seen = new Set(), depth = 0) {
  if (depth > 10) {
    throw new Error("alias: too many aliases inside each other");
  }
  const steps = [];
  for (const step of splitSequence(line, isCommand)) {
    const { text, used } = expandFirstWord(step.text, aliases, seen);
    if (used) {
      const inner = expandLine(text, aliases, isCommand, new Set([...seen, used]), depth + 1);
      inner[0] = { ...inner[0], op: step.op };
      steps.push(...inner);
    } else {
      steps.push({ text: expandStages(text, aliases, seen), op: step.op });
    }
  }
  return steps;
}

/**
 * Reads what follows `alias`: `name='body'`, `name=body`, `name body`, or
 * just `name` (show it).
 *
 * @param {string} text
 * @returns {{name: string, body: string|null}}
 * @throws On a bad name.
 */
export function parseAliasDefinition(text) {
  const match = /^\s*([^\s=]+)\s*(?:=\s*|\s+|$)([\s\S]*)$/.exec(text || "");
  if (!match) {
    throw new Error("usage: alias <name>='<commands>'");
  }
  const [, name, raw] = match;
  if (!ALIAS_NAME.test(name)) {
    throw new Error(
      `alias: "${name}" can't be a name (use letters, digits, - and _)`
    );
  }
  let body = raw.trim();
  const hadEquals = /^\s*[^\s=]+\s*=/.test(text);
  if (
    body.length >= 2 &&
    (body[0] === "'" || body[0] === '"') &&
    body.at(-1) === body[0]
  ) {
    body = body.slice(1, -1);
  }
  if (!body && !hadEquals) {
    return { name, body: null };
  }
  if (!body.trim()) {
    throw new Error(`alias: ${name} needs commands, e.g. alias ${name}='ls -a'`);
  }
  if (PROTECTED_COMMANDS.includes(name)) {
    throw new Error(`alias: ${name} is a built-in command and can't be replaced`);
  }
  return { name, body: body.trim() };
}

/**
 * @param {string} name
 * @param {string} body
 * @returns {string} The line that defines it: alias name='body'
 */
export function formatAlias(name, body) {
  const quote = body.includes("'") && !body.includes('"') ? '"' : "'";
  return `alias ${name}=${quote}${body}${quote}`;
}

/**
 * The commands in a startup file: one per line; blank lines and lines
 * starting with # are skipped.
 *
 * @param {string} text
 * @returns {{line: number, text: string}[]} 1-based line numbers.
 */
export function startupCommands(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, text: line.trim() }))
    .filter(({ text: line }) => line && !line.startsWith("#"));
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function aliasLinePattern(name) {
  return new RegExp(`^\\s*alias\\s+${escapeRegExp(name)}\\s*(=|\\s|$)`);
}

/**
 * Saves an alias in the startup file's text: replaces its line if it has
 * one, else adds it at the end.
 *
 * @param {string} text
 * @param {string} name
 * @param {string} body
 * @returns {string}
 */
export function setAliasInText(text, name, body) {
  const line = formatAlias(name, body);
  const lines = String(text || "").split("\n");
  const pattern = aliasLinePattern(name);
  const at = lines.findIndex(l => pattern.test(l));
  if (at >= 0) {
    lines.splice(at, 1, line);
    return lines.filter((l, i) => i <= at || !pattern.test(l)).join("\n");
  }
  while (lines.length && !lines.at(-1).trim()) {
    lines.pop();
  }
  return [...lines, line, ""].join("\n");
}

/**
 * @param {string} text
 * @param {string} name
 * @returns {{text: string, removed: boolean}}
 */
export function removeAliasFromText(text, name) {
  const pattern = aliasLinePattern(name);
  const lines = String(text || "").split("\n");
  const kept = lines.filter(l => !pattern.test(l));
  return { text: kept.join("\n"), removed: kept.length !== lines.length };
}

/** What a new startup file starts with. */
export const STARTUP_TEMPLATE = `# Commit runs this file each time it starts: one console command per line.
# Lines starting with # are skipped. \`alias\` saves aliases here too.
#
# alias study='switch thesis && focus 50m && play music lofi'
# alias yt='ls -a | grep youtube'
# archive after 24
`;
