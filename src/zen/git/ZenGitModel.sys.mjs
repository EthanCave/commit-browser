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

// ---------------------------------------------------------------------------
// One history per space
//
// Each space has its own branches, named spaces/<slug>/<branch>, checked out
// in its own git worktree. Those branches hold a single space.json. The
// whole-window format above (essentials.json + spaces/*.json) is what older
// commits used; a space can still read its part of one of those.

export const SPACE_FILE = "space.json";
export const SPACE_BRANCH_ROOT = "spaces";
export const DEFAULT_SPACE_BRANCH = "main";

/**
 * @param {string} slug A space's slug, from slugify(name).
 * @returns {string} The ref prefix for its branches, e.g. "spaces/school".
 */
export function spaceBranchPrefix(slug) {
  return `${SPACE_BRANCH_ROOT}/${slug}`;
}

/**
 * Cuts a whole-window snapshot down to one space, without Essentials (they
 * show in every space, so no single space's history owns them).
 *
 * @param {object} snapshot From buildSnapshot.
 * @param {string} spaceId
 * @returns {object} A snapshot with exactly one space.
 */
export function spaceSnapshot(snapshot, spaceId) {
  const space = (snapshot?.spaces || []).find(s => s.id === spaceId) || {
    id: spaceId,
    name: "Untitled space",
    icon: null,
    folders: [],
    tabs: [],
  };
  return {
    version: snapshot?.version ?? SNAPSHOT_VERSION,
    essentials: [],
    spaces: [space],
  };
}

/**
 * Points a stored one-space snapshot at a live space, so restoring it changes
 * tabs in that space instead of recreating the space it was saved from
 * (whose id differs on another computer, or after a space is recreated).
 *
 * @param {object} snapshot A one-space snapshot.
 * @param {{id: string, name: string, icon?: string|null}} live
 * @returns {object}
 */
export function retargetSpace(snapshot, live) {
  const stored = snapshot?.spaces?.[0] || { folders: [], tabs: [] };
  return {
    version: snapshot?.version ?? SNAPSHOT_VERSION,
    essentials: [],
    spaces: [
      {
        ...stored,
        id: live.id,
        name: live.name,
        icon: live.icon ?? stored.icon ?? null,
      },
    ],
  };
}

const toJson = value => JSON.stringify(value, null, 2) + "\n";

/**
 * How snapshots map to files, for a whole window (older commits) or for one
 * space. `fromFiles` returns null when the files hold no layout.
 */
export const WINDOW_CODEC = Object.freeze({
  wants: path =>
    path === "essentials.json" ||
    (path.startsWith("spaces/") && path.endsWith(".json")),
  toFiles: snapshot => snapshotToFiles(snapshot),
  fromFiles: files => filesToSnapshot(files),
  staleDir: "spaces",
});

/**
 * @param {string} slug The space's slug; also finds its part of an older
 *   whole-window commit (spaces/<slug>.json).
 * @returns {object} A codec for one space's branches.
 */
export function spaceCodec(slug) {
  const legacy = `spaces/${slug}.json`;
  return Object.freeze({
    wants: path => path === SPACE_FILE || path === legacy,
    toFiles: snapshot => ({
      [SPACE_FILE]: toJson({ version: snapshot.version, ...snapshot.spaces[0] }),
    }),
    fromFiles: files => {
      const text = files?.[SPACE_FILE] ?? files?.[legacy];
      if (text === undefined) {
        return null;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return null;
      }
      const { version = SNAPSHOT_VERSION, position, ...space } = data;
      return {
        version,
        essentials: [],
        spaces: [{ folders: [], tabs: [], ...space }],
      };
    },
    staleDir: null,
  });
}

// Essentials show in every space, so they have their own history on
// essentials/<branch>, in the same essentials.json format older whole-window
// commits used.
export const ESSENTIALS_BRANCH_PREFIX = "essentials";
export const ESSENTIALS_FILE = "essentials.json";

/**
 * @param {object} snapshot A whole-window snapshot.
 * @returns {object} A snapshot holding only its Essentials.
 */
export function essentialsSnapshot(snapshot) {
  return {
    version: snapshot?.version ?? SNAPSHOT_VERSION,
    essentials: [...(snapshot?.essentials || [])],
    spaces: [],
  };
}

export const ESSENTIALS_CODEC = Object.freeze({
  wants: path => path === ESSENTIALS_FILE,
  toFiles: snapshot => ({
    [ESSENTIALS_FILE]: toJson({
      version: snapshot.version,
      tabs: snapshot.essentials,
    }),
  }),
  fromFiles: files => {
    const text = files?.[ESSENTIALS_FILE];
    if (text === undefined) {
      return null;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return null;
    }
    return {
      version: data.version ?? SNAPSHOT_VERSION,
      essentials: data.tabs || [],
      spaces: [],
    };
  },
  staleDir: null,
});

// Settings every computer should share, such as each space's default branch,
// live on their own small branch, settings/main, so `push` and `pull` carry
// them.
export const SETTINGS_BRANCH_PREFIX = "settings";
export const SETTINGS_FILE = "settings.json";

/**
 * @param {object} [settings]
 * @returns {{version: number, defaults: Object<string, string>}} Settings
 *   with every field present.
 */
export function normalizeSettings(settings) {
  return {
    version: settings?.version ?? SNAPSHOT_VERSION,
    defaults: { ...(settings?.defaults || {}) },
  };
}

export const SETTINGS_CODEC = Object.freeze({
  wants: path => path === SETTINGS_FILE,
  toFiles: settings => ({
    [SETTINGS_FILE]: toJson(normalizeSettings(settings)),
  }),
  fromFiles: files => {
    const text = files?.[SETTINGS_FILE];
    if (text === undefined) {
      return null;
    }
    try {
      return normalizeSettings(JSON.parse(text));
    } catch {
      return null;
    }
  },
  staleDir: null,
});

/**
 * Combines per-space statuses, for the dots and `ls -a`.
 *
 * @param {ReturnType<typeof computeStatus>[]} statuses
 * @returns {ReturnType<typeof computeStatus>}
 */
export function mergeStatuses(statuses) {
  const merged = { tabs: new Map(), added: [], modified: [], deleted: [] };
  for (const status of statuses) {
    for (const [id, state] of status.tabs) {
      merged.tabs.set(id, state);
    }
    merged.added.push(...status.added);
    merged.modified.push(...status.modified);
    merged.deleted.push(...status.deleted);
  }
  return merged;
}

/**
 * Parses `git worktree list --porcelain`.
 *
 * @param {string} output
 * @returns {{path: string, branch: string|null}[]}
 */
export function parseWorktrees(output) {
  const worktrees = [];
  let current = null;
  for (const line of (output || "").split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null };
      worktrees.push(current);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  return worktrees;
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
 * @param {ReturnType<typeof computeStatus>} status
 * @returns {boolean} Whether the layout matches the last commit.
 */
export function isClean(status) {
  return (
    !status.added.length && !status.modified.length && !status.deleted.length
  );
}

/**
 * Works out how to turn the live layout into a committed one, like the
 * file operations behind `git checkout`. Tabs are matched by id so a tab
 * that was only moved or navigated is updated in place rather than
 * closed and reopened.
 *
 * @param {object} current Snapshot of the open tabs.
 * @param {object} target Snapshot to restore.
 * @returns {{
 *   createSpaces: {id: string, name: string, icon: string|null}[],
 *   createFolders: {id: string, name: string, parentId: string|null, spaceId: string}[],
 *   open: object[],
 *   update: {tab: object, changes: string[]}[],
 *   close: object[],
 * }} Tabs carry spaceId and essential, as from indexTabs.
 */
export function planCheckout(current, target) {
  const now = indexTabs(current);
  const goal = indexTabs(target);
  const liveSpaces = new Set((current?.spaces || []).map(s => s.id));
  const liveFolders = new Set(
    (current?.spaces || []).flatMap(s => s.folders.map(f => f.id))
  );
  const plan = {
    createSpaces: [],
    createFolders: [],
    open: [],
    update: [],
    close: [],
  };

  for (const space of target?.spaces || []) {
    if (!liveSpaces.has(space.id)) {
      plan.createSpaces.push({
        id: space.id,
        name: space.name,
        icon: space.icon || null,
      });
    }
    for (const folder of space.folders) {
      if (!liveFolders.has(folder.id)) {
        plan.createFolders.push({ ...folder, spaceId: space.id });
      }
    }
  }

  for (const [id, tab] of goal) {
    const old = now.get(id);
    if (!old) {
      plan.open.push(tab);
      continue;
    }
    const changes = [];
    if (old.url !== tab.url) {
      changes.push("url");
    }
    if (old.essential !== tab.essential) {
      changes.push("essential");
    }
    if (!tab.essential && old.spaceId !== tab.spaceId) {
      changes.push("space");
    }
    if ((old.folderId || null) !== (tab.folderId || null)) {
      changes.push("folder");
    }
    if (old.pinned !== tab.pinned) {
      changes.push("pinned");
    }
    if (changes.length) {
      plan.update.push({ tab, changes });
    }
  }

  for (const [id, tab] of now) {
    if (!goal.has(id)) {
      plan.close.push(tab);
    }
  }
  return plan;
}

/**
 * @param {ReturnType<typeof planCheckout>} plan
 * @returns {string} e.g. "opened 3, closed 1, updated 2".
 */
export function summarizePlan(plan) {
  const parts = [];
  if (plan.open.length) {
    parts.push(`opened ${plan.open.length}`);
  }
  if (plan.close.length) {
    parts.push(`closed ${plan.close.length}`);
  }
  if (plan.update.length) {
    parts.push(`updated ${plan.update.length}`);
  }
  if (plan.createSpaces.length) {
    parts.push(`added ${plan.createSpaces.length} space(s)`);
  }
  if (plan.createFolders.length) {
    parts.push(`added ${plan.createFolders.length} folder(s)`);
  }
  return parts.join(", ") || "already matched";
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

/**
 * Picks the site a bare `cd <name>` most likely means from history origins
 * (moz_origins rows): a host whose first label is the name, optionally after
 * "www.", ranked by frecency, then by being closest to <name>.<tld>.
 * "krillion" -> krillion.io, "canvas" -> canvas.rice.edu.
 *
 * @param {string} name A bare name, lowercase.
 * @param {{prefix: string, host: string, frecency: number}[]} rows
 * @returns {string|null} The origin, e.g. "https://krillion.io", or null.
 */
export function pickHistoryOrigin(name, rows) {
  const candidates = [];
  for (const { prefix, host, frecency } of rows || []) {
    if (!/^https?:\/\/$/.test(prefix)) {
      continue;
    }
    const bare = host.toLowerCase().replace(/^www\./, "");
    if (!bare.startsWith(`${name}.`)) {
      continue;
    }
    const rest = bare.slice(name.length + 1);
    const dots = rest.split(".").length - 1;
    // name.tld or name.site.tld (canvas.rice.edu), not deeper.
    if (!rest || dots > 1) {
      continue;
    }
    candidates.push({ origin: prefix + host, frecency, dots, https: prefix === "https://", length: host.length });
  }
  candidates.sort(
    (a, b) =>
      b.frecency - a.frecency ||
      a.dots - b.dots ||
      b.https - a.https ||
      a.length - b.length
  );
  return candidates[0]?.origin ?? null;
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
 * @returns {{kind: "url", url: string, guess?: {name: string, path: string}} | {kind: "search", query: string} | {kind: "back"|"forward"|"previous"|"home"}}
 *   `guess` is set when a bare name became <name>.com, which history may
 *   know better.
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
    const name = host.toLowerCase();
    if (SITE_SHORTCUTS[name]) {
      host = SITE_SHORTCUTS[name];
    } else {
      // A guess: the console first looks for a site with this name in your
      // history (krillion -> krillion.io), like the address bar's autofill.
      return {
        kind: "url",
        url: `https://${name}.com${path}`,
        guess: { name, path },
      };
    }
  }
  return { kind: "url", url: `https://${host}${path}` };
}

// ---------------------------------------------------------------------------
// Time travel, grep, cherry-pick, share and focus helpers

const TIME_WORDS =
  /\b(now|today|yesterday|tonight|morning|noon|afternoon|evening|night|midnight|ago|last|week|weeks|month|months|day|days|hour|hours|minute|minutes|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b|\d{4}-\d{2}-\d{2}|\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i;

/**
 * @param {string} text
 * @returns {boolean} Whether text reads like a moment in time ("yesterday",
 *   "last tuesday", "3 days ago", "2026-11-18", "9am"), which git's date
 *   parser understands, rather than a branch or commit.
 */
export function looksLikeTime(text) {
  return TIME_WORDS.test((text || "").trim());
}

/**
 * Finds a query in a page's text and returns short snippets around each
 * match, for `grep`.
 *
 * @param {string} text
 * @param {string} query Plain text, matched case-insensitively.
 * @param {{max?: number, width?: number}} [options]
 * @returns {{count: number, snippets: string[]}}
 */
export function snippetAround(text, query, { max = 3, width = 70 } = {}) {
  const result = { count: 0, snippets: [] };
  if (!text || !query) {
    return result;
  }
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    result.count++;
    if (result.snippets.length < max) {
      const start = Math.max(0, at - width);
      const end = Math.min(text.length, at + needle.length + width);
      let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
      if (start > 0) {
        snippet = "…" + snippet;
      }
      if (end < text.length) {
        snippet += "…";
      }
      result.snippets.push(snippet);
    }
    at = haystack.indexOf(needle, at + needle.length);
  }
  return result;
}

/**
 * Picks tabs by 1-based number or by text in their title or URL, for
 * `cherry-pick`. "all" picks every tab.
 *
 * @param {{title: string, url: string}[]} tabs
 * @param {string[]} selectors
 * @returns {object[]} The picked tabs, in list order, without duplicates.
 */
export function selectTabs(tabs, selectors) {
  if (selectors.some(s => s.toLowerCase() === "all")) {
    return [...tabs];
  }
  const picked = new Set();
  for (const selector of selectors) {
    if (/^\d+$/.test(selector)) {
      const tab = tabs[Number(selector) - 1];
      if (tab) {
        picked.add(tab);
      }
      continue;
    }
    const needle = selector.toLowerCase();
    for (const tab of tabs) {
      if (
        (tab.title || "").toLowerCase().includes(needle) ||
        (tab.url || "").toLowerCase().includes(needle)
      ) {
        picked.add(tab);
      }
    }
  }
  return tabs.filter(tab => picked.has(tab));
}

export const SHARE_FORMAT = "commit-space";
const SHARE_CODE_PREFIX = "commit-space:";

/**
 * The portable form of a space for `share`: names, folders and tabs, with
 * no ids from this computer.
 *
 * @param {object} space A space from a snapshot.
 * @returns {object}
 */
export function toSharedSpace(space) {
  const folderIndex = new Map(space.folders.map((f, i) => [f.id, i]));
  return {
    format: SHARE_FORMAT,
    version: 1,
    name: space.name,
    icon: space.icon || null,
    folders: space.folders.map(f => ({
      name: f.name,
      parent: f.parentId && folderIndex.has(f.parentId)
        ? folderIndex.get(f.parentId)
        : null,
    })),
    tabs: space.tabs.map(t => ({
      title: t.title,
      url: t.url,
      pinned: !!t.pinned,
      folder: t.folderId && folderIndex.has(t.folderId)
        ? folderIndex.get(t.folderId)
        : null,
    })),
  };
}

/**
 * Turns a shared space back into a one-space snapshot with fresh ids.
 *
 * @param {object} shared From toSharedSpace.
 * @param {{id: string, name: string, icon?: string|null}} live The space it goes into.
 * @param {string} idPrefix Makes the new tab and folder ids unique.
 * @returns {object}
 */
export function fromSharedSpace(shared, live, idPrefix) {
  if (shared?.format !== SHARE_FORMAT || !Array.isArray(shared.tabs)) {
    throw new Error("That isn't a shared Commit space.");
  }
  const folderId = i => `${idPrefix}-folder-${i}`;
  const folders = (shared.folders || []).map((f, i) => ({
    id: folderId(i),
    name: String(f.name || "Folder"),
    parentId: Number.isInteger(f.parent) ? folderId(f.parent) : null,
  }));
  const tabs = [];
  shared.tabs.forEach((t, i) => {
    const url = sanitizeUrl(String(t.url || ""));
    if (!url) {
      return;
    }
    const tab = {
      id: `${idPrefix}-tab-${i}`,
      title: String(t.title || url),
      url,
      pinned: !!t.pinned,
    };
    if (Number.isInteger(t.folder) && folders[t.folder]) {
      tab.folderId = folderId(t.folder);
    }
    tabs.push(tab);
  });
  return {
    version: SNAPSHOT_VERSION,
    essentials: [],
    spaces: [
      {
        id: live.id,
        name: live.name,
        icon: live.icon ?? shared.icon ?? null,
        folders,
        tabs,
      },
    ],
  };
}

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return new TextDecoder().decode(
    Uint8Array.from(binary, char => char.charCodeAt(0))
  );
}

/** @returns {string} A paste-able code holding a shared space. */
export function encodeShareCode(shared) {
  return SHARE_CODE_PREFIX + toBase64Url(JSON.stringify(shared));
}

/** @returns {object|null} The shared space in a code, or null. */
export function decodeShareCode(code) {
  const text = (code || "").trim();
  if (!text.startsWith(SHARE_CODE_PREFIX)) {
    return null;
  }
  try {
    return JSON.parse(fromBase64Url(text.slice(SHARE_CODE_PREFIX.length)));
  } catch {
    return null;
  }
}

/**
 * @param {string} text e.g. "25m", "1h", "1h30m", "90" (minutes).
 * @returns {number} Milliseconds, or 0 if it isn't a duration.
 */
export function parseDuration(text) {
  const value = (text || "").trim().toLowerCase();
  if (/^\d+$/.test(value)) {
    return Number(value) * 60000;
  }
  const match = /^(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?$/.exec(
    value
  );
  if (!match || (!match[1] && !match[2])) {
    return 0;
  }
  return (Number(match[1] || 0) * 60 + Number(match[2] || 0)) * 60000;
}

/**
 * @param {number} ms
 * @returns {string} "24:05" under an hour, else "1h 05m".
 */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = n => String(n).padStart(2, "0");
  return hours ? `${hours}h ${pad(minutes)}m` : `${minutes}:${pad(seconds)}`;
}

/**
 * Focus mode's blocklist: each site also covers its subdomains.
 *
 * @param {string[]} sites e.g. ["youtube.com", "reddit.com"]
 * @returns {RegExp[]}
 */
export function focusRules(sites) {
  return parseIgnore(
    sites
      .map(site => site.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, ""))
      .filter(Boolean)
      .map(site => (site.startsWith("*.") ? site : `*.${site.replace(/^www\./, "")}`))
      .join("\n")
  );
}

// ---------------------------------------------------------------------------
// top: memory and CPU by process (each site gets its own process)

/**
 * @param {number} bytes
 * @returns {string} e.g. "412 MB", "1.3 GB".
 */
export function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/**
 * Turns two ChromeUtils.requestProcInfo() samples into rows for `top`.
 * Web processes are listed with the tabs running in them; the browser
 * itself, the GPU and helper processes are summed into one "Commit" row.
 *
 * @param {object} before First sample (ParentProcInfoDictionary).
 * @param {object} after Second sample, taken elapsedMs later.
 * @param {number} elapsedMs
 * @param {Map<number, object[]>} tabsByPid Live tabs by content process.
 * @param {{sortBy?: "memory"|"cpu"}} [options]
 * @returns {{rows: {pid: number|null, memory: number, cpu: number, tabs: object[], label: string}[], total: number}}
 */
export function processRows(before, after, elapsedMs, tabsByPid, { sortBy = "memory" } = {}) {
  const earlier = new Map();
  for (const proc of [before, ...(before?.children || [])]) {
    earlier.set(proc.pid, proc.cpuTime || 0);
  }
  // cpuTime is in nanoseconds.
  const cpuOf = proc =>
    earlier.has(proc.pid) && elapsedMs > 0
      ? Math.max(0, ((proc.cpuTime || 0) - earlier.get(proc.pid)) / (elapsedMs * 1e6)) * 100
      : 0;

  const own = { pid: null, memory: after.memory || 0, cpu: cpuOf(after), tabs: [], label: "Commit itself (browser, graphics, helpers)" };
  const rows = [];
  let total = after.memory || 0;
  for (const proc of after.children || []) {
    total += proc.memory || 0;
    const tabs = tabsByPid.get(proc.pid) || [];
    if (!tabs.length) {
      own.memory += proc.memory || 0;
      own.cpu += cpuOf(proc);
      continue;
    }
    rows.push({ pid: proc.pid, memory: proc.memory || 0, cpu: cpuOf(proc), tabs, label: "" });
  }
  const key = sortBy === "cpu" ? "cpu" : "memory";
  rows.sort((a, b) => b[key] - a[key]);
  rows.push(own);
  return { rows, total };
}

// ---------------------------------------------------------------------------
// Undo and the reflog
//
// Before a command changes many tabs at once (a pipe that closes or moves
// tabs, `tidy apply`, `checkout`, `stash`, `pull`...), the console saves the
// spaces it touches. `undo` puts them back with the same code `checkout`
// uses, and `reflog` lists what was saved. The log is newest first.

/** How many changes the reflog keeps. */
export const UNDO_LIMIT = 30;

/**
 * The part of a snapshot that a change touches.
 *
 * @param {object} snapshot
 * @param {{spaceIds: string[], essentials: boolean}} scope
 * @returns {object} A snapshot with only those spaces (and Essentials).
 */
export function layoutPart(snapshot, scope) {
  const ids = new Set(scope?.spaceIds || []);
  return {
    version: snapshot?.version ?? SNAPSHOT_VERSION,
    essentials: scope?.essentials ? [...(snapshot?.essentials || [])] : [],
    spaces: (snapshot?.spaces || []).filter(space => ids.has(space.id)),
  };
}

/**
 * The scope for every space in a snapshot and Essentials.
 *
 * @param {object} snapshot
 * @returns {{spaceIds: string[], essentials: boolean}}
 */
export function wholeScope(snapshot) {
  return {
    spaceIds: (snapshot?.spaces || []).map(space => space.id),
    essentials: true,
  };
}

/**
 * Builds a reflog entry for a change.
 *
 * @param {object} options
 * @param {string} options.id
 * @param {number} options.at When it happened (ms).
 * @param {"change"|"undo"|"redo"} [options.kind]
 * @param {string} options.label What was typed, e.g. "ls -a | grep x | close".
 * @param {string} options.summary What it did, e.g. "closed 14 tabs".
 * @param {object} options.point From the manager's undoPoint():
 *   {scope, before, branches, names}.
 * @param {string|null} [options.note] Shown after undoing it.
 * @param {string[]} [options.undoes] For an undo: the ids it reversed.
 * @returns {object}
 */
export function undoEntry({
  id,
  at,
  kind = "change",
  label,
  summary,
  point,
  note = null,
  undoes = [],
}) {
  return {
    id,
    at,
    kind,
    label,
    summary,
    note,
    names: point.names || [],
    scope: {
      spaceIds: [...(point.scope?.spaceIds || [])],
      essentials: !!point.scope?.essentials,
    },
    before: point.before,
    branches: { ...(point.branches || {}) },
    undoes,
    undone: false,
    redone: false,
  };
}

/**
 * @param {object[]} log Newest first.
 * @param {object} entry
 * @param {number} [limit]
 * @returns {object[]} The log with the entry added, oldest ones dropped.
 */
export function addToLog(log, entry, limit = UNDO_LIMIT) {
  return [entry, ...(log || [])].slice(0, limit);
}

/**
 * The changes `undo [count]` reverses: the newest ones not undone yet.
 * Undos and redos are skipped; `redo` handles those.
 *
 * @param {object[]} log Newest first.
 * @param {number} [count]
 * @returns {object[]} Newest first.
 */
export function pickUndo(log, count = 1) {
  return (log || [])
    .filter(entry => entry.kind === "change" && !entry.undone)
    .slice(0, Math.max(1, count));
}

/**
 * The undo that `redo` reverses: the newest one not redone yet, as long as
 * no new change happened after it (a new change ends the redo chain, like
 * in any editor).
 *
 * @param {object[]} log Newest first.
 * @returns {object|null}
 */
export function pickRedo(log) {
  for (const entry of log || []) {
    if (entry.kind === "redo" || (entry.kind === "undo" && entry.redone)) {
      continue;
    }
    return entry.kind === "undo" ? entry : null;
  }
  return null;
}

/**
 * What undoing several changes at once restores: for each space (and
 * Essentials), the layout from before the oldest of them that touched it.
 *
 * @param {object[]} entries Newest first, from pickUndo().
 * @returns {{scope: {spaceIds: string[], essentials: boolean}, target: object, branches: object}}
 */
export function combineUndo(entries) {
  const spaces = new Map(); // id -> the space as it was, or null if it didn't exist
  const branches = {};
  let essentials = null;
  for (const entry of entries) {
    // Older entries come later and overwrite newer ones.
    for (const id of entry.scope.spaceIds) {
      spaces.set(id, entry.before.spaces.find(space => space.id === id) || null);
      if (entry.branches?.[id]) {
        branches[id] = entry.branches[id];
      }
    }
    if (entry.scope.essentials) {
      essentials = entry.before.essentials || [];
    }
  }
  return {
    scope: { spaceIds: [...spaces.keys()], essentials: essentials !== null },
    target: {
      version: SNAPSHOT_VERSION,
      essentials: essentials || [],
      spaces: [...spaces.values()].filter(Boolean),
    },
    branches,
  };
}

/**
 * @param {object[]} log
 * @param {string[]} ids
 * @param {object} changes Fields to set on those entries.
 * @returns {object[]} A new log.
 */
export function updateEntries(log, ids, changes) {
  const wanted = new Set(ids);
  return (log || []).map(entry =>
    wanted.has(entry.id) ? { ...entry, ...changes } : entry
  );
}

/**
 * @param {ReturnType<typeof planCheckout>} plan From what is open now to
 *   what a change restores.
 * @returns {string} e.g. "reopened 14 tabs, moved 2".
 */
export function describeRestore(plan) {
  const parts = [];
  const tabs = n => `${n} tab${n === 1 ? "" : "s"}`;
  if (plan.open.length) {
    parts.push(`reopened ${tabs(plan.open.length)}`);
  }
  if (plan.close.length) {
    parts.push(`closed ${tabs(plan.close.length)}`);
  }
  const moved = plan.update.filter(u => u.changes.some(c => c !== "url"));
  if (moved.length) {
    parts.push(`moved ${tabs(moved.length)}`);
  }
  const navigated = plan.update.length - moved.length;
  if (navigated) {
    parts.push(`sent ${tabs(navigated)} back to their old page`);
  }
  if (plan.createSpaces.length) {
    parts.push(`brought back ${plan.createSpaces.length} space(s)`);
  }
  if (plan.createFolders.length) {
    parts.push(`brought back ${plan.createFolders.length} folder(s)`);
  }
  return parts.join(", ") || "nothing needed to change";
}
