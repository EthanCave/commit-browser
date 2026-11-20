/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ZenUIComponent } from "resource:///modules/zen/ui/ZenUIComponent.sys.mjs";
import { STATUS_CHANGED_TOPIC, ZenGitManager } from "./ZenGitManager.sys.mjs";
import {
  STATUS,
  extractMessage,
  isClean,
  formatDiff,
  formatStatus,
  pickHistoryOrigin,
  resolveCdTarget,
  summarize,
  tokenize,
} from "./ZenGitModel.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ZenTabArchiver: "resource:///modules/zen/archive/ZenTabArchiver.sys.mjs",
  formatAge: "resource:///modules/zen/archive/ZenTabArchiveModel.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});

const HTML_NS = "http://www.w3.org/1999/xhtml";
const MAX_OUTPUT_LINES = 500;

// Tab events that can change a tab's status.
const TAB_EVENTS = [
  "TabOpen",
  "TabClose",
  "TabMove",
  "TabPinned",
  "TabUnpinned",
  "TabGroupUpdate",
  "TabAddedToGroup",
  "TabRemovedFromGroup",
  "ZenWorkspaceAttached",
];

const HELP = [
  [
    "cd <site|query>",
    "go to a site in this tab: cd github, cd gh/zen-browser, cd son of man painting",
  ],
  ["cd .. / cd - / cd ~", "back / previous tab / new tab"],
  ["open <site>", "same as cd, in a new tab"],
  ["g <query>", "search with your default search engine"],
  ["ls [-a]", "list tabs in this space (-a: every space) with their status"],
  ["pwd", "print and copy this tab's URL"],
  ["", "Each space has its own history. These work on the space you're in:"],
  ["status", "what changed in this space since its last commit"],
  ["diff", "URLs and moves since the last commit"],
  ["commit [-m msg]", "save this space's layout"],
  ["log", "this space's recent commits"],
  [
    "restore [--all]",
    "send this tab (or every modified tab) back to its committed URL",
  ],
  ["branch [name]", "list this space's branches, or make one (-d name deletes)"],
  [
    "default [branch]",
    "show or set this space's default branch (what `clone` loads)",
  ],
  [
    "switch <branch>",
    "swap this space's tabs for that branch's layout (-c: new branch)",
  ],
  [
    "checkout <branch|hash>",
    "switch branch, or bring back an old commit's layout (-b: new branch)",
  ],
  ["stash [-m msg]", "set this space's uncommitted tabs aside"],
  ["stash pop / list / drop", "bring stashed tabs back / list / discard"],
  [
    "essentials [log|reset]",
    "Essentials have their own history; `commit` saves them too",
  ],
  ["", "Sync (every space and Essentials at once):"],
  ["remote add origin <url>", "connect a GitHub repo"],
  ["push / pull", "sync every space, Essentials and defaults with GitHub"],
  [
    "clone [url] [-f]",
    "new computer: load Essentials and every space's default branch",
  ],
  ["git <args>", "run any git command in this space's worktree"],
  [
    "archive [now|on|off|after <hours>]",
    "auto-archive: see which old tabs will close, or close them now",
  ],
  ["clear / history / help", ""],
];

export class ZenGitConsole extends ZenUIComponent {
  #panel = null;
  #output = null;
  #input = null;
  #history = [];
  #historyIndex = -1;
  #previousTab = null;
  #currentTab = null;
  #observer = () => this.#applyDots();

  init() {
    this.addEventListener("keydown", { capture: true });
    this.addEventListener("TabSelect");
    for (const type of TAB_EVENTS) {
      this.addEventListener(type);
    }
    this.listenBrowserTabsProgress();
    Services.obs.addObserver(this.#observer, STATUS_CHANGED_TOPIC);
    this.#currentTab = this.window.gBrowser.selectedTab;
    ZenGitManager.scheduleRefresh(this.window);
  }

  uninit() {
    Services.obs.removeObserver(this.#observer, STATUS_CHANGED_TOPIC);
  }

  handleEvent(event) {
    if (TAB_EVENTS.includes(event.type)) {
      ZenGitManager.scheduleRefresh(this.window);
      return;
    }
    super.handleEvent(event);
  }

  // Tabs progress listener: a tab navigated somewhere.
  onLocationChange(aBrowser, aWebProgress) {
    if (aWebProgress?.isTopLevel) {
      ZenGitManager.scheduleRefresh(this.window);
    }
  }

  on_TabSelect(event) {
    if (event.target !== this.#currentTab) {
      this.#previousTab = this.#currentTab;
      this.#currentTab = event.target;
    }
  }

  on_keydown(event) {
    // Ctrl+` toggles the console, like a terminal in an editor.
    if (event.ctrlKey && !event.metaKey && event.code === "Backquote") {
      event.preventDefault();
      event.stopPropagation();
      this.toggle();
    }
  }

  // ---------------------------------------------------------------------
  // Status dots

  #applyDots() {
    const status = ZenGitManager.status;
    if (!status || !Services.prefs.getBoolPref("zen.git.show-dots", true)) {
      return;
    }
    for (const tab of this.window.gZenWorkspaces.allStoredTabs) {
      const state = status.tabs.get(tab.id);
      if (state === STATUS.UNTRACKED || state === STATUS.MODIFIED) {
        tab.setAttribute("zen-git-status", state);
        this.#ensureDot(tab, state);
      } else {
        tab.removeAttribute("zen-git-status");
      }
    }
  }

  #ensureDot(tab, state) {
    let dot = tab.querySelector(".zen-git-dot");
    if (!dot) {
      const content = tab.querySelector(".tab-content");
      if (!content) {
        return;
      }
      dot = this.document.createElementNS(HTML_NS, "span");
      dot.className = "zen-git-dot";
      const close = content.querySelector(".tab-close-button");
      content.insertBefore(dot, close);
    }
    dot.title =
      state === STATUS.UNTRACKED
        ? "Untracked: not in any commit"
        : "Modified since last commit";
  }

  // ---------------------------------------------------------------------
  // Panel

  #build() {
    const doc = this.document;
    const el = (tag, className) => {
      const node = doc.createElementNS(HTML_NS, tag);
      if (className) {
        node.className = className;
      }
      return node;
    };
    this.#panel = el("div");
    this.#panel.id = "zen-git-console";
    this.#panel.hidden = true;
    this.#output = el("div", "zen-git-console-output");
    const row = el("div", "zen-git-console-row");
    const prompt = el("span", "zen-git-console-prompt");
    prompt.textContent = "❯";
    this.#input = el("input", "zen-git-console-input");
    this.#input.setAttribute("spellcheck", "false");
    this.#input.setAttribute("autocomplete", "off");
    this.#input.placeholder = 'cd github · status · commit -m "…" · help';
    this.#input.addEventListener("keydown", e => this.#onInputKey(e));
    row.append(prompt, this.#input);
    this.#panel.append(this.#output, row);
    (doc.body || doc.documentElement).append(this.#panel);
  }

  toggle(force) {
    if (!this.#panel) {
      this.#build();
      this.#print(
        "Layout console. Type `help` for commands, Ctrl+` to close.",
        "dim"
      );
    }
    const show = force ?? this.#panel.hidden;
    this.#panel.hidden = !show;
    if (show) {
      this.#input.focus();
    } else {
      this.window.gBrowser.selectedBrowser.focus();
    }
  }

  #onInputKey(event) {
    switch (event.key) {
      case "Enter": {
        const line = this.#input.value;
        this.#input.value = "";
        this.#historyIndex = -1;
        if (line.trim()) {
          this.#history.unshift(line);
        }
        this.run(line).catch(e => this.#print(e.message || String(e), "error"));
        break;
      }
      case "Escape":
        this.toggle(false);
        break;
      case "ArrowUp":
      case "ArrowDown": {
        if (!this.#history.length) {
          return;
        }
        const step = event.key === "ArrowUp" ? 1 : -1;
        this.#historyIndex = Math.max(
          -1,
          Math.min(this.#history.length - 1, this.#historyIndex + step)
        );
        this.#input.value = this.#history[this.#historyIndex] ?? "";
        break;
      }
      case "Tab": {
        const value = this.#input.value;
        if (!value.includes(" ")) {
          const match = Object.keys(this.#commands).filter(c =>
            c.startsWith(value)
          );
          if (match.length === 1) {
            this.#input.value = match[0] + " ";
          } else if (match.length > 1) {
            this.#print(match.join("  "), "dim");
          }
        }
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  }

  #print(text, kind = "") {
    if (!this.#output) {
      return;
    }
    for (const line of String(text).split("\n")) {
      const node = this.document.createElementNS(HTML_NS, "div");
      node.className = `zen-git-line ${kind}`;
      node.textContent = line;
      this.#output.append(node);
    }
    while (this.#output.childElementCount > MAX_OUTPUT_LINES) {
      this.#output.firstElementChild.remove();
    }
    this.#output.scrollTop = this.#output.scrollHeight;
  }

  #printStatusLines(lines) {
    for (const line of lines) {
      const kind =
        line.startsWith("M  ") || line.startsWith("~ ")
          ? "modified"
          : line.startsWith("U  ") || line.startsWith("+ ")
            ? "added"
            : line.startsWith("D  ") || line.startsWith("- ")
              ? "deleted"
              : "";
      this.#print(line, kind);
    }
  }

  // ---------------------------------------------------------------------
  // Commands

  async run(line) {
    this.#print(`❯ ${line}`, "echo");
    const [name, ...args] = tokenize(line);
    if (!name) {
      return;
    }
    const command = this.#commands[name];
    if (!command) {
      this.#print(`${name}: command not found. Try \`help\`.`, "error");
      return;
    }
    await command.call(this, args, line);
  }

  get #commands() {
    return {
      help: this.#help,
      cd: this.#cd,
      open: this.#open,
      g: this.#search,
      search: this.#search,
      ls: this.#ls,
      pwd: this.#pwd,
      status: this.#statusCmd,
      diff: this.#diff,
      commit: this.#commit,
      log: this.#log,
      restore: this.#restore,
      push: args => this.#push(args),
      pull: args => this.#pull(args),
      remote: args =>
        this.#gitShared(["remote", ...(args.length ? args : ["-v"])]),
      git: args => this.#gitCommand(args),
      branch: this.#branch,
      switch: this.#switch,
      checkout: this.#checkout,
      stash: this.#stash,
      essentials: this.#essentials,
      default: this.#default,
      clone: this.#clone,
      setup: this.#clone,
      archive: this.#archive,
      debug: this.#debug,
      clear: () => this.#output.replaceChildren(),
      history: () =>
        this.#print(
          this.#history.slice(1).reverse().join("\n") || "(empty)",
          "dim"
        ),
    };
  }

  #help() {
    for (const [usage, text] of HELP) {
      if (!usage) {
        this.#print(text, "dim");
        continue;
      }
      this.#print(text ? `${usage.padEnd(24)} ${text}` : usage);
    }
  }

  async #navigate(target, where) {
    const resolved = resolveCdTarget(target);
    const gBrowser = this.window.gBrowser;
    switch (resolved.kind) {
      case "back":
        gBrowser.goBack();
        return;
      case "forward":
        gBrowser.goForward();
        return;
      case "previous":
        if (this.#previousTab?.isConnected) {
          gBrowser.selectedTab = this.#previousTab;
        } else {
          this.#print("cd: no previous tab", "error");
        }
        return;
      case "home":
        if (this.window.BrowserCommands?.openTab) {
          this.window.BrowserCommands.openTab();
        } else {
          this.window.openTrustedLinkIn("about:newtab", "tab");
        }
        return;
      case "search":
        await this.#searchFor(resolved.query, where);
        return;
      default: {
        let url = resolved.url;
        if (resolved.guess) {
          url = (await this.#fromHistory(resolved.guess)) || url;
        }
        this.window.openTrustedLinkIn(url, where);
      }
    }
  }

  /**
   * For a bare `cd <name>`: the site with that name you have visited, like
   * the address bar's autofill (krillion -> krillion.io), or null.
   */
  async #fromHistory({ name, path }) {
    try {
      const db = await lazy.PlacesUtils.promiseDBConnection();
      const like = name.replace(/[\\%_]/g, "\\$&");
      const rows = await db.executeCached(
        `SELECT prefix, host, frecency FROM moz_origins
         WHERE host LIKE :bare ESCAPE '\\' OR host LIKE :www ESCAPE '\\'
         ORDER BY frecency DESC LIMIT 20`,
        { bare: `${like}.%`, www: `www.${like}.%` }
      );
      const origin = pickHistoryOrigin(
        name,
        rows.map(row => ({
          prefix: row.getResultByName("prefix"),
          host: row.getResultByName("host"),
          frecency: row.getResultByName("frecency"),
        }))
      );
      return origin ? origin + path : null;
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  async #searchFor(query, where) {
    const engine = await lazy.SearchService.getDefault();
    const url = engine.getSubmission(query).uri.spec;
    this.window.openTrustedLinkIn(url, where);
  }

  async #cd(args) {
    await this.#navigate(args.join(" "), "current");
  }

  async #open(args) {
    await this.#navigate(args.join(" ") || "~", "tab");
  }

  async #search(args) {
    if (!args.length) {
      this.#print("usage: g <query>", "error");
      return;
    }
    await this.#searchFor(args.join(" "), "current");
  }

  async #ls(args) {
    const all = args.includes("-a") || args.includes("--all");
    const status = await ZenGitManager.refresh(this.window);
    const workspaces = this.window.gZenWorkspaces;
    const active = workspaces.activeWorkspace;
    const spaces = new Map(
      workspaces.getWorkspaces().map(s => [s.uuid, s.name])
    );
    const letter = { untracked: "U", modified: "M", clean: " " };
    let lastSpace = null;
    for (const tab of workspaces.allStoredTabs) {
      if (
        tab.hasAttribute("zen-empty-tab") ||
        tab.hasAttribute("zen-glance-tab")
      ) {
        continue;
      }
      const essential = tab.hasAttribute("zen-essential");
      const spaceId = essential
        ? "essentials"
        : tab.getAttribute("zen-workspace-id");
      if (!all && !essential && spaceId !== active) {
        continue;
      }
      if (spaceId !== lastSpace) {
        lastSpace = spaceId;
        this.#print(
          essential ? "essentials/" : `${spaces.get(spaceId) || "space"}/`,
          "dim"
        );
      }
      const state = status.tabs.get(tab.id);
      const mark = state ? letter[state] : "!";
      let host = "";
      try {
        host = tab.linkedBrowser.currentURI.host;
      } catch {}
      const kind =
        state === "modified"
          ? "modified"
          : state === "untracked"
            ? "added"
            : "";
      const folder = tab.group?.label ? `${tab.group.label}/` : "";
      this.#print(
        `${mark}  ${folder}${tab.label}${host ? `  — ${host}` : ""}`,
        kind
      );
    }
    this.#print(
      `(${summarize(status)})  U untracked · M modified · ! ignored`,
      "dim"
    );
  }

  #pwd() {
    const url = this.window.gBrowser.selectedBrowser.currentURI.spec;
    Cc["@mozilla.org/widget/clipboardhelper;1"]
      .getService(Ci.nsIClipboardHelper)
      .copyString(url);
    this.#print(url);
    this.#print("(copied)", "dim");
  }

  async #statusCmd() {
    const { status, hasHead, space, branch, essentials } =
      await ZenGitManager.spaceStatus(this.window);
    this.#print(`${space.name} · on branch ${branch || "main"}`, "dim");
    this.#printStatusLines(formatStatus(status, hasHead));
    if (!isClean(essentials.status)) {
      this.#print("Essentials:", "dim");
      this.#printStatusLines(formatStatus(essentials.status, true));
    }
  }

  async #essentials(args) {
    const [sub] = args;
    if (sub === "log") {
      const repo = await ZenGitManager.essentialsRepo();
      const entries = await repo.log(20);
      if (!entries.length) {
        this.#print("Essentials have no commits yet.", "dim");
      }
      for (const { hash, when, subject } of entries) {
        this.#print(`${hash}  ${when.padEnd(16)} ${subject}`);
      }
      return;
    }
    if (sub === "reset" || sub === "restore") {
      const result = await ZenGitManager.resetEssentials(this.window, {
        force: args.includes("-f"),
      });
      this.#print("Essentials match their last commit again.", "added");
      this.#printResult(result);
      return;
    }
    if (sub) {
      this.#print("usage: essentials [log | reset [-f]]", "error");
      return;
    }
    const { essentials } = await ZenGitManager.spaceStatus(this.window);
    if (!essentials.hasHead) {
      this.#print("Essentials have no commits yet. `commit` saves them.", "dim");
    }
    this.#printStatusLines(formatStatus(essentials.status, true));
  }

  async #diff() {
    const { status } = await ZenGitManager.spaceStatus(this.window);
    this.#printStatusLines(formatDiff(status));
  }

  async #commit(args) {
    let { message, rest } = extractMessage(args);
    if (rest.includes("-a") || rest.includes("--all")) {
      rest = rest.filter(a => a !== "-a" && a !== "--all");
    }
    if (rest.length) {
      this.#print(
        `commit: unknown arguments ${rest.join(" ")} (every tab is committed; use .browserignore to skip sites)`,
        "error"
      );
      return;
    }
    if (!message) {
      const { status } = await ZenGitManager.spaceStatus(this.window);
      message = `Layout: ${summarize(status)}`;
    }
    const { hash, essentialsHash, branch, space } = await ZenGitManager.commit(
      this.window,
      message
    );
    if (hash) {
      this.#print(`[${space.name}/${branch || "main"} ${hash}] ${message}`, "added");
    }
    if (essentialsHash) {
      this.#print(`[essentials ${essentialsHash}] ${message}`, "added");
    }
    if (!hash && !essentialsHash) {
      this.#print(`Nothing to commit, ${space.name} is clean.`, "dim");
    }
  }

  async #log(args) {
    const count =
      parseInt(args.find(a => /^-?\d+$/.test(a))?.replace("-", ""), 10) || 20;
    const { repo, space } = await ZenGitManager.activeSpaceRepo(this.window);
    const entries = await repo.log(count);
    if (!entries.length) {
      this.#print(`No commits in ${space.name} yet.`, "dim");
      return;
    }
    for (const { hash, when, subject } of entries) {
      this.#print(`${hash}  ${when.padEnd(16)} ${subject}`);
    }
  }

  async #restore(args) {
    const { status } = await ZenGitManager.spaceStatus(this.window);
    const all = args.includes("--all") || args.includes(".");
    const selected = this.window.gBrowser.selectedTab;
    const targets = status.modified.filter(
      ({ before, after }) =>
        before.url !== after.url && (all || after.id === selected.id)
    );
    if (!targets.length) {
      this.#print(
        all
          ? "No tabs have navigated away from their committed URL."
          : "This tab matches its committed URL.",
        "dim"
      );
      return;
    }
    for (const { before } of targets) {
      const tab = this.document.getElementById(before.id);
      if (!tab) {
        continue;
      }
      tab.linkedBrowser.fixupAndLoadURIString(before.url, {
        triggeringPrincipal:
          Services.scriptSecurityManager.getSystemPrincipal(),
      });
      this.#print(`restored ${before.title}`, "dim");
    }
  }

  async #push(args) {
    if (args.length) {
      // `push -f`, `push origin <branch>`: plain git, in this space.
      await this.#git(["push", ...args]);
      return;
    }
    const { exitCode, output } = await ZenGitManager.pushAll();
    this.#printGitResult(exitCode, output);
  }

  async #pull(args) {
    if (args.length) {
      await this.#git(["pull", "--ff-only", ...args]);
      return;
    }
    const origin = await ZenGitManager.runShared(["remote", "get-url", "origin"]);
    if (origin.exitCode) {
      this.#print(
        "No GitHub repo connected yet. Run `remote add origin <url>` first.",
        "error"
      );
      return;
    }
    const { lines } = await ZenGitManager.pullAll(this.window);
    for (const { text, kind } of lines) {
      this.#print(text, kind);
    }
  }

  /**
   * Arc-style auto-archive (src/zen/archive): shows which tabs will close,
   * runs it now, or changes when it happens.
   */
  #archive(args) {
    const { ZenTabArchiver } = lazy;
    const archiver = ZenTabArchiver.forWindow(this.window);
    if (!archiver) {
      this.#print("Auto-archive doesn't run in private windows.", "dim");
      return;
    }
    const [sub, value] = args;
    switch (sub) {
      case "now": {
        const count = archiver.archiveStaleTabs({ force: true });
        this.#print(
          count
            ? `Archived ${count} tab${count === 1 ? "" : "s"}. ` +
                "Library › History › Closed tabs has them."
            : "Nothing old enough to archive.",
          count ? "added" : "dim"
        );
        return;
      }
      case "on":
      case "off":
        Services.prefs.setBoolPref(
          "zen.tabs.auto-archive.enabled",
          sub === "on"
        );
        break;
      case "after": {
        const hours = Number.parseInt(value, 10);
        if (!(hours > 0)) {
          this.#print("usage: archive after <hours>  (e.g. 12, 24, 168)", "error");
          return;
        }
        Services.prefs.setIntPref("zen.tabs.auto-archive.after-hours", hours);
        break;
      }
      case undefined:
        break;
      default:
        this.#print("usage: archive [now|on|off|after <hours>]", "error");
        return;
    }
    const hours = ZenTabArchiver.afterHours;
    this.#print(
      `Auto-archive is ${ZenTabArchiver.enabled ? "on" : "off"}: loose tabs ` +
        `unseen for ${hours}h close by themselves. Pinned tabs, Essentials ` +
        "and folders are never archived.",
      "dim"
    );
    const now = Date.now();
    const stale = archiver.staleTabs(now);
    if (!stale.length) {
      this.#print("No tabs are old enough yet.", "dim");
      return;
    }
    this.#print(
      `${stale.length} tab${stale.length === 1 ? "" : "s"} would go now ` +
        "(`archive now` closes them):"
    );
    for (const tab of stale) {
      this.#print(
        `  ${lazy.formatAge(now - tab.lastAccessed).padStart(4)}  ${tab.label}`
      );
    }
  }

  /**
   * Prints what the console sees, to diagnose missing tabs or statuses.
   */
  async #debug() {
    const sidebar = ZenGitManager.collectSidebar(this.window);
    const { repo, space } = await ZenGitManager.activeSpaceRepo(this.window);
    this.#print(`repo: ${ZenGitManager.repoDir}`, "dim");
    this.#print(`${space.name}'s worktree: ${repo.dir}`, "dim");
    this.#print(
      `spaces: ${sidebar.spaces.map(s => `${s.name} (${s.uuid})`).join(", ") || "none"}`,
      "dim"
    );
    this.#print(`folders: ${sidebar.folders.length}`, "dim");
    this.#print(`tabs seen: ${sidebar.tabs.length}`, "dim");
    for (const t of sidebar.tabs) {
      const flags = [
        t.zenEssential && "essential",
        t.pinned && "pinned",
        t.zenIsEmpty && "EMPTY(skipped)",
        t.zenIsGlance && "GLANCE(skipped)",
      ].filter(Boolean);
      const entry = t.entries?.[(t.index || 1) - 1];
      this.#print(
        `  ${t.zenSyncId || "(no id)"} space=${t.zenWorkspace || "-"} ${flags.join(",")} ${entry?.url || "(no url)"}`,
        "dim"
      );
    }
    const snapshot = await ZenGitManager.currentSnapshot(this.window);
    const counted =
      snapshot.essentials.length +
      snapshot.spaces.reduce((n, s) => n + s.tabs.length, 0);
    this.#print(`tabs in snapshot: ${counted}`, "dim");
    const { status, hasHead } = await ZenGitManager.spaceStatus(this.window);
    this.#print(
      `${space.name}: ${status.added.length} untracked, ${status.modified.length} modified, ${status.deleted.length} deleted; head=${hasHead}`,
      "dim"
    );
  }

  #printResult({ summary, warnings }) {
    this.#print(summary, "dim");
    for (const warning of warnings) {
      this.#print(`warning: ${warning}`, "modified");
    }
  }

  async #default(args) {
    if (!args.length) {
      const { space, branch } = await ZenGitManager.defaultBranch(this.window);
      this.#print(`${space.name}'s default branch is ${branch}.`);
      this.#print("`default <branch>` changes it; `clone` loads defaults on a new computer.", "dim");
      return;
    }
    const { space, changed } = await ZenGitManager.setDefaultBranch(
      this.window,
      args[0]
    );
    this.#print(
      changed
        ? `${space.name}'s default branch is now ${args[0]}. \`push\` shares it.`
        : `${args[0]} already is ${space.name}'s default branch.`,
      changed ? "added" : "dim"
    );
  }

  async #clone(args) {
    const force = args.includes("-f") || args.includes("--force");
    const url = args.find(a => !a.startsWith("-"));
    if (url) {
      const has = await ZenGitManager.runShared(["remote", "get-url", "origin"]);
      const result = await ZenGitManager.runShared(
        has.exitCode
          ? ["remote", "add", "origin", url]
          : ["remote", "set-url", "origin", url]
      );
      if (result.exitCode) {
        this.#printGitResult(result.exitCode, result.output);
        return;
      }
    } else {
      const has = await ZenGitManager.runShared(["remote", "get-url", "origin"]);
      if (has.exitCode) {
        this.#print("usage: clone <github repo url> [-f]", "error");
        return;
      }
    }
    this.#print("Getting Essentials and every space's default branch…", "dim");
    const { lines } = await ZenGitManager.pullAll(this.window, {
      setup: true,
      force,
    });
    for (const { text, kind } of lines) {
      this.#print(text, kind);
    }
  }

  async #branch(args) {
    const { repo, space } = await ZenGitManager.activeSpaceRepo(this.window);
    if (!args.length) {
      const [branches, current, { branch: fallback }] = await Promise.all([
        repo.branches(),
        repo.currentBranch(),
        ZenGitManager.defaultBranch(this.window),
      ]);
      if (!branches.length) {
        this.#print(`${space.name} has no branches yet. Run \`commit\` first.`, "dim");
        return;
      }
      for (const name of branches) {
        const tag = name === fallback ? "  (default)" : "";
        this.#print(
          (name === current ? `* ${name}` : `  ${name}`) + tag,
          name === current ? "added" : ""
        );
      }
      return;
    }
    // -d, -D, -m and friends behave like git, on this space's branches.
    const names = args.map(a => (a.startsWith("-") ? a : repo.fullBranch(a)));
    await this.#git(["branch", ...names]);
  }

  async #switch(args) {
    const force = args.includes("-f") || args.includes("--discard-changes");
    const rest = args.filter(a => a !== "-f" && a !== "--discard-changes");
    if (rest[0] === "-c" || rest[0] === "-b") {
      if (!rest[1]) {
        this.#print(`usage: switch -c <new-branch>`, "error");
        return;
      }
      await ZenGitManager.createBranch(this.window, rest[1]);
      this.#print(
        `Switched to a new branch '${rest[1]}' (your tabs are unchanged)`,
        "added"
      );
      return;
    }
    if (!rest[0]) {
      this.#print("usage: switch <branch>  ·  switch -c <new-branch>", "error");
      return;
    }
    const { repo } = await ZenGitManager.activeSpaceRepo(this.window);
    if ((await repo.revKind(rest[0])) !== "branch") {
      this.#print(
        `switch: no branch '${rest[0]}'. Make one with \`switch -c ${rest[0]}\`.`,
        "error"
      );
      return;
    }
    await this.#checkout([rest[0], ...(force ? ["-f"] : [])]);
  }

  async #checkout(args) {
    const force = args.includes("-f") || args.includes("--force");
    const rest = args.filter(a => a !== "-f" && a !== "--force");
    if (rest[0] === "-b") {
      await this.#switch(["-c", ...rest.slice(1)]);
      return;
    }
    if (rest[0] === "--" || rest[0] === ".") {
      this.#print("To undo URL changes, use `restore --all`.", "dim");
      return;
    }
    if (!rest[0]) {
      this.#print("usage: checkout <branch|commit> [-f]", "error");
      return;
    }
    const result = await ZenGitManager.checkout(this.window, rest[0], {
      force,
    });
    if (result.kind === "branch") {
      this.#print(`Switched to branch '${rest[0]}'`, "added");
      if (result.summary === "already matched") {
        this.#print(
          `'${rest[0]}' has the same layout you already had, so no tabs changed. ` +
            "Open some tabs and `commit` on this branch to give it its own layout.",
          "dim"
        );
        return;
      }
    } else {
      const { branch } = result;
      this.#print(
        `Restored the layout from ${rest[0]}. You're still on '${branch}': ` +
          "`commit` to keep it, or `checkout -f " +
          branch +
          "` to go back.",
        "added"
      );
    }
    this.#printResult(result);
  }

  async #stash(args) {
    const [sub = "push", ...rest] = args;
    switch (sub) {
      case "list": {
        const { repo, space } = await ZenGitManager.activeSpaceRepo(this.window);
        const entries = await repo.stashList();
        if (!entries.length) {
          this.#print(`No stashed layouts in ${space.name}.`, "dim");
        }
        for (const { ref, when, message } of entries) {
          this.#print(`${ref}  ${when.padEnd(16)} ${message}`);
        }
        return;
      }
      case "pop":
      case "apply": {
        const force = rest.includes("-f");
        const ref = rest.find(a => a !== "-f") || null;
        const result = await ZenGitManager.stashPop(this.window, {
          force,
          ref,
        });
        this.#print(`Restored stashed tabs${ref ? ` (${ref})` : ""}`, "added");
        this.#printResult(result);
        return;
      }
      case "drop":
      case "clear": {
        // git has one stash list for every space; only touch this space's.
        const { repo, space } = await ZenGitManager.activeSpaceRepo(this.window);
        const entries = await repo.stashList();
        const refs =
          sub === "clear"
            ? entries.map(e => e.ref).reverse()
            : [rest[0] || entries[0]?.ref].filter(Boolean);
        if (!refs.length) {
          this.#print(`No stashed layouts in ${space.name}.`, "dim");
          return;
        }
        for (const ref of refs) {
          if (!entries.some(e => e.ref === ref)) {
            this.#print(`${ref} is not one of ${space.name}'s stashes.`, "error");
            return;
          }
          await this.#git(["stash", "drop", ref]);
        }
        return;
      }
      case "push":
      case "save":
      default: {
        // `stash -m msg` arrives with "-m" as the subcommand.
        const { message } = extractMessage(
          sub === "push" || sub === "save" ? rest : args
        );
        const result = await ZenGitManager.stash(this.window, message);
        if (!result) {
          this.#print("No local changes to stash.", "dim");
          return;
        }
        this.#print(
          "Stashed your tab changes. `stash pop` brings them back.",
          "added"
        );
        this.#printResult(result);
      }
    }
  }

  /**
   * `git <sub>` from muscle memory. Layout-aware subcommands go to the
   * console's own versions, which save the tabs before committing; the rest
   * run as plain git in the layouts repo.
   */
  async #gitCommand(args) {
    const [sub, ...rest] = args;
    if (sub === "add") {
      this.#print(
        "No need to add: `commit` saves every open tab (skip sites with .browserignore).",
        "dim"
      );
      return;
    }
    const own = [
      "status",
      "diff",
      "commit",
      "log",
      "restore",
      "push",
      "pull",
      "branch",
      "switch",
      "checkout",
      "stash",
    ];
    if (own.includes(sub)) {
      await this.#commands[sub].call(this, rest);
      return;
    }
    await this.#git(args);
  }

  async #git(args) {
    if (!args.length) {
      this.#print("usage: git <command> [args]", "error");
      return;
    }
    const { exitCode, output } = await ZenGitManager.runGit(this.window, args);
    this.#printGitResult(exitCode, output);
  }

  async #gitShared(args) {
    const { exitCode, output } = await ZenGitManager.runShared(args);
    this.#printGitResult(exitCode, output);
  }

  #printGitResult(exitCode, output) {
    if (output.trim()) {
      this.#print(output.replace(/\n$/, ""), exitCode ? "error" : "");
    } else if (!exitCode) {
      this.#print("done", "dim");
    }
    if (
      exitCode &&
      /could not read Username|Authentication failed|terminal prompts disabled/i.test(
        output
      )
    ) {
      this.#print(
        "GitHub needs a login. In Terminal run `gh auth login` and `gh auth setup-git`, then try again.",
        "dim"
      );
    }
    ZenGitManager.scheduleRefresh(this.window);
  }
}
