/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Pure logic for the git layer: turning sidebar data into a committed
 * snapshot, comparing snapshots, and parsing console input.
 *
 * This module must not import anything from Firefox so it can be unit
 * tested with plain Node (`node --test src/zen/git/tests`).
 */

export const SNAPSHOT_VERSION = 1;

export const STATUS = Object.freeze({
  CLEAN: "clean",
  UNTRACKED: "untracked",
  MODIFIED: "modified",
});

// URL schemes that never get committed: they are either meaningless outside
// this machine or can carry private data inline.
const SKIPPED_SCHEMES = [
  "data:",
  "blob:",
  "file:",
  "javascript:",
  "view-source:",
];

// Query parameters that commonly carry secrets. They are removed from every
// committed URL, matched case-insensitively.
const SENSITIVE_PARAMS = [
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "auth",
  "authuser_token",
  "key",
  "api_key",
  "apikey",
  "code",
  "state",
  "session",
  "sessionid",
  "sid",
  "password",
  "pass",
  "pwd",
  "secret",
  "sig",
  "signature",
  "otp",
  "ticket",
  "jwt",
];
const SENSITIVE_PARAM_PREFIXES = ["x-amz-", "x-goog-"];

export const DEFAULT_IGNORE_FILE = `# Tabs on these sites are never committed, like a .gitignore.
# One pattern per line. "*" matches any part of a host name.
#
#   mail.google.com      just that host
#   *.chase.com          any subdomain of chase.com (and chase.com itself)
#   localhost            local development servers

*.chase.com
*.bankofamerica.com
*.wellsfargo.com
*.paypal.com
accounts.google.com
`;

/**
 * Parses a .browserignore file into host patterns.
 *
 * @param {string} text
 * @returns {RegExp[]}
 */
export function parseIgnore(text) {
  const rules = [];
  for (let line of (text || "").split("\n")) {
    line = line.trim().toLowerCase();
    if (!line || line.startsWith("#")) {
      continue;
    }
    let pattern = line.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "");
    let source = pattern
      .split("*")
      .map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");
    // "*.example.com" should also match "example.com" itself.
    if (pattern.startsWith("*.")) {
      source = `(?:[^/]*\\.)?${source.slice("[^/]*\\.".length)}`;
    }
    rules.push(new RegExp(`^${source}$`));
  }
  return rules;
}

/**
 * @param {string} url
 * @param {RegExp[]} ignoreRules
 * @returns {boolean} Whether the URL's host matches a .browserignore rule.
 */
export function isIgnored(url, ignoreRules) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ignoreRules.some(rule => rule.test(host));
}

/**
 * Removes secrets from a URL before it is written to the repo.
 *
 * @param {string} url
 * @returns {string|null} The cleaned URL, or null if it must not be stored.
 */
export function sanitizeUrl(url) {
  if (!url || typeof url !== "string") {
    return null;
  }
  const lower = url.toLowerCase();
  if (SKIPPED_SCHEMES.some(scheme => lower.startsWith(scheme))) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.username || parsed.password) {
    parsed.username = "";
    parsed.password = "";
  }
  for (const name of [...parsed.searchParams.keys()]) {
    const key = name.toLowerCase();
    if (
      SENSITIVE_PARAMS.includes(key) ||
      SENSITIVE_PARAM_PREFIXES.some(prefix => key.startsWith(prefix))
    ) {
      parsed.searchParams.delete(name);
    }
  }
  // OAuth implicit flows put tokens in the fragment.
  if (/(access_token|id_token|token)=/i.test(parsed.hash)) {
    parsed.hash = "";
  }
  return parsed.toString();
}

/**
 * @param {object} tabData A session store tab object.
 * @returns {{url: string, title: string}} The entry the tab is showing.
 */
export function currentEntry(tabData) {
  const entries = tabData?.entries || [];
  if (!entries.length) {
    return { url: "", title: "" };
  }
  // Session store indexes are 1-based.
  let index = (tabData.index || entries.length) - 1;
  index = Math.max(0, Math.min(index, entries.length - 1));
  return {
    url: entries[index].url || "",
    title: entries[index].title || "",
  };
}

/**
 * Builds the snapshot that gets committed, from Zen's sidebar data
 * (the same shape ZenSessionManager stores: spaces, folders, tabs).
 *
 * @param {object} sidebar
 * @param {object} [options]
 * @param {RegExp[]} [options.ignoreRules]
 * @returns {object} The snapshot.
 */
export function buildSnapshot(sidebar, { ignoreRules = [] } = {}) {
  const snapshot = {
    version: SNAPSHOT_VERSION,
    essentials: [],
    spaces: [],
  };
  const spacesById = new Map();
  for (const space of sidebar?.spaces || []) {
    const entry = {
      id: space.uuid,
      name: space.name || "Untitled space",
      icon: space.icon || null,
      folders: [],
      tabs: [],
    };
    spacesById.set(space.uuid, entry);
    snapshot.spaces.push(entry);
  }

  const folderSpace = new Map();
  for (const folder of sidebar?.folders || []) {
    if (folder.splitViewGroup || folder.isLiveFolder) {
      continue;
    }
    const space = spacesById.get(folder.workspaceId);
    if (!space) {
      continue;
    }
    folderSpace.set(folder.id, space);
    space.folders.push({
      id: folder.id,
      name: folder.name || "Untitled folder",
      parentId: folder.parentId || null,
    });
  }

  for (const tabData of sidebar?.tabs || []) {
    if (!tabData?.zenSyncId || tabData.zenIsEmpty || tabData.zenIsGlance) {
      continue;
    }
    const { url, title } = currentEntry(tabData);
    const cleanUrl = sanitizeUrl(url);
    if (!cleanUrl || isIgnored(cleanUrl, ignoreRules)) {
      continue;
    }
    const tab = {
      id: tabData.zenSyncId,
      title: tabData.zenStaticLabel || title || cleanUrl,
      url: cleanUrl,
      pinned: !!tabData.pinned,
    };
    if (tabData.zenEssential) {
      snapshot.essentials.push(tab);
      continue;
    }
    const folderId = tabData.groupId || null;
    const space =
      spacesById.get(tabData.zenWorkspace) ||
      (folderId && folderSpace.get(folderId)) ||
      snapshot.spaces[0];
    if (!space) {
      continue;
    }
    if (folderId && folderSpace.has(folderId)) {
      tab.folderId = folderId;
    }
    space.tabs.push(tab);
  }
  return snapshot;
}

/**
 * @param {string} name
 * @returns {string} A filesystem- and URL-friendly version of a name.
 */
export function slugify(name) {
  const slug = (name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "space";
}

/**
 * Splits a snapshot into the files stored in the repo. One file per space
 * keeps GitHub diffs readable.
 *
 * @param {object} snapshot
 * @returns {Object<string, string>} Map of repo path to file contents.
 */
export function snapshotToFiles(snapshot) {
  const files = {};
  const json = value => JSON.stringify(value, null, 2) + "\n";
  files["essentials.json"] = json({
    version: snapshot.version,
    tabs: snapshot.essentials,
  });
  const used = new Set();
  snapshot.spaces.forEach((space, position) => {
    let base = slugify(space.name);
    let path = `spaces/${base}.json`;
    if (used.has(path)) {
      path = `spaces/${base}-${String(space.id)
        .replace(/[^a-z0-9]/gi, "")
        .slice(0, 8)}.json`;
    }
    used.add(path);
    files[path] = json({ ...space, position });
  });
  return files;
}

/**
 * Inverse of snapshotToFiles.
 *
 * @param {Object<string, string>} files
 * @returns {object} The snapshot.
 */
export function filesToSnapshot(files) {
  const snapshot = { version: SNAPSHOT_VERSION, essentials: [], spaces: [] };
  for (const [path, text] of Object.entries(files || {})) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      continue;
    }
    if (path === "essentials.json") {
      snapshot.essentials = data.tabs || [];
    } else if (path.startsWith("spaces/") && path.endsWith(".json")) {
      snapshot.spaces.push(data);
    }
  }
  snapshot.spaces.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  for (const space of snapshot.spaces) {
    delete space.position;
  }
  return snapshot;
}

/**
 * @param {object} snapshot
 * @returns {Map<string, object>} Every tab by id, with its space and folder.
 */
export function indexTabs(snapshot) {
  const tabs = new Map();
  for (const tab of snapshot?.essentials || []) {
    tabs.set(tab.id, { ...tab, spaceId: null, essential: true });
  }
  for (const space of snapshot?.spaces || []) {
    for (const tab of space.tabs) {
      tabs.set(tab.id, {
        ...tab,
        spaceId: space.id,
        spaceName: space.name,
        essential: false,
      });
    }
  }
  return tabs;
}

/**
 * Compares the live layout with the last commit, like `git status`.
 *
 * @param {object} current Snapshot of the open tabs.
 * @param {object|null} head Snapshot from the last commit, or null.
 * @returns {{tabs: Map<string, string>, added: object[], modified: object[], deleted: object[]}}
 */
export function computeStatus(current, head) {
  const now = indexTabs(current);
  const before = indexTabs(head);
  const result = { tabs: new Map(), added: [], modified: [], deleted: [] };
  for (const [id, tab] of now) {
    const old = before.get(id);
    if (!old) {
      result.tabs.set(id, STATUS.UNTRACKED);
      result.added.push(tab);
    } else if (
      old.url !== tab.url ||
      old.spaceId !== tab.spaceId ||
      (old.folderId || null) !== (tab.folderId || null) ||
      old.essential !== tab.essential ||
      old.pinned !== tab.pinned
    ) {
      result.tabs.set(id, STATUS.MODIFIED);
      result.modified.push({ before: old, after: tab });
    } else {
      result.tabs.set(id, STATUS.CLEAN);
    }
  }
  for (const [id, tab] of before) {
    if (!now.has(id)) {
      result.deleted.push(tab);
    }
  }
  return result;
}

/**
 * @param {object} tab
 * @returns {string} Short human label for a tab in console output.
 */
function describeTab(tab) {
  const where = tab.essential ? "essentials" : tab.spaceName || "";
  const title =
    tab.title.length > 60 ? tab.title.slice(0, 57) + "..." : tab.title;
  return where ? `${title}  [${where}]` : title;
}

/**
 * @param {ReturnType<typeof computeStatus>} status
 * @param {boolean} hasHead Whether any commit exists yet.
 * @returns {string[]} Lines for the `status` command.
 */
export function formatStatus(status, hasHead) {
  const lines = [];
  if (!hasHead) {
    lines.push("No commits yet. Run `commit` to save your first layout.");
  }
  if (
    !status.added.length &&
    !status.modified.length &&
    !status.deleted.length
  ) {
    lines.push("Nothing to commit, layout clean.");
    return lines;
  }
  for (const { after } of status.modified) {
    lines.push(`M  ${describeTab(after)}`);
  }
  for (const tab of status.added) {
    lines.push(`U  ${describeTab(tab)}`);
  }
  for (const tab of status.deleted) {
    lines.push(`D  ${describeTab(tab)}`);
  }
  return lines;
}

/**
 * @param {ReturnType<typeof computeStatus>} status
 * @returns {string[]} Lines for the `diff` command.
 */
export function formatDiff(status) {
  const lines = [];
  for (const { before, after } of status.modified) {
    lines.push(`~ ${after.title}`);
    if (before.url !== after.url) {
      lines.push(`    - ${before.url}`, `    + ${after.url}`);
    }
    if (
      before.spaceId !== after.spaceId ||
      before.essential !== after.essential
    ) {
      const from = before.essential ? "essentials" : before.spaceName;
      const to = after.essential ? "essentials" : after.spaceName;
      lines.push(`    moved ${from} -> ${to}`);
    } else if ((before.folderId || null) !== (after.folderId || null)) {
      lines.push(`    moved to a different folder`);
    }
    if (before.pinned !== after.pinned) {
      lines.push(`    ${after.pinned ? "pinned" : "unpinned"}`);
    }
  }
  for (const tab of status.added) {
    lines.push(`+ ${tab.title}`, `    ${tab.url}`);
  }
  for (const tab of status.deleted) {
    lines.push(`- ${tab.title}`, `    ${tab.url}`);
  }
  return lines.length ? lines : ["No changes since the last commit."];
}

/**
 * @param {ReturnType<typeof computeStatus>} status
 * @returns {string} One-line summary, e.g. "2 modified, 1 untracked".
 */
export function summarize(status) {
  const parts = [];
  if (status.modified.length) {
    parts.push(`${status.modified.length} modified`);
  }
  if (status.added.length) {
    parts.push(`${status.added.length} untracked`);
  }
  if (status.deleted.length) {
    parts.push(`${status.deleted.length} closed`);
  }
  return parts.join(", ") || "clean";
}

/**
 * Splits console input into arguments, honoring single and double quotes.
 *
 * @param {string} input
 * @returns {string[]}
 */
export function tokenize(input) {
  const args = [];
  let current = "";
  let quote = null;
  let started = false;
  for (const char of input || "") {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }
  if (started) {
    args.push(current);
  }
  return args;
}

/**
 * Pulls `-m <message>` (or `-m<message>`, `--message`) out of arguments.
 *
 * @param {string[]} args
 * @returns {{message: string|null, rest: string[]}}
 */
export function extractMessage(args) {
  const rest = [];
  let message = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-m" || arg === "--message") {
      message = args[++i] ?? "";
    } else if (arg.startsWith("-m") && arg.length > 2) {
      message = arg.slice(2);
    } else if (arg.startsWith("--message=")) {
      message = arg.slice("--message=".length);
    } else {
      rest.push(arg);
    }
  }
  return { message, rest };
}

// Short names `cd` understands without a dot. Anything else without a dot
// becomes <name>.com.
export const SITE_SHORTCUTS = Object.freeze({
  gh: "github.com",
  yt: "youtube.com",
  gm: "mail.google.com",
  gcal: "calendar.google.com",
  gdrive: "drive.google.com",
  wiki: "en.wikipedia.org",
  reddit: "reddit.com",
  hn: "news.ycombinator.com",
  x: "x.com",
});

/**
 * Works out what `cd <target>` should open.
 *
 * @param {string} target Everything after `cd`.
 * @returns {{kind: "url", url: string} | {kind: "search", query: string} | {kind: "back"|"forward"|"previous"|"home"}}
 */
export function resolveCdTarget(target) {
  target = (target || "").trim();
  if (!target || target === "~") {
    return { kind: "home" };
  }
  if (target === "..") {
    return { kind: "back" };
  }
  if (target === "-") {
    return { kind: "previous" };
  }
  if (target === "+" || target === "./forward") {
    return { kind: "forward" };
  }
  if (/\s/.test(target)) {
    return { kind: "search", query: target };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[^/]+:\d+/.test(target)) {
    return { kind: "url", url: target };
  }
  const slash = target.indexOf("/");
  let host = slash === -1 ? target : target.slice(0, slash);
  const path = slash === -1 ? "" : target.slice(slash);
  const bareHost = host.replace(/:\d+$/, "").toLowerCase();
  const isLocal =
    bareHost === "localhost" ||
    bareHost.endsWith(".localhost") ||
    bareHost.endsWith(".test") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(bareHost);
  if (isLocal) {
    return { kind: "url", url: `http://${host}${path}` };
  }
  if (!host.includes(".")) {
    host = SITE_SHORTCUTS[host.toLowerCase()] || `${host.toLowerCase()}.com`;
  }
  return { kind: "url", url: `https://${host}${path}` };
}
