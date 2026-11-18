/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ZenUIComponent } from "resource:///modules/zen/ui/ZenUIComponent.sys.mjs";
import { STATUS_CHANGED_TOPIC, ZenGitManager } from "./ZenGitManager.sys.mjs";
import {
  STATUS,
  extractMessage,
  formatDiff,
  formatStatus,
  resolveCdTarget,
  summarize,
  tokenize,
} from "./ZenGitModel.sys.mjs";

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
  ["status", "what changed since the last commit"],
  ["diff", "URLs and moves since the last commit"],
  ["commit [-m msg]", "save the current layout"],
  ["log", "list recent commits"],
  [
    "restore [--all]",
    "send this tab (or every modified tab) back to its committed URL",
  ],
  ["branch [name]", "list branches, or make one here (-d name deletes)"],
  [
    "switch <branch>",
    "swap your tabs for that branch's layout (-c: new branch)",
  ],
  [
    "checkout <branch|hash>",
    "switch branch, or bring back an old commit's layout (-b: new branch)",
  ],
  ["stash [-m msg]", "set aside uncommitted tabs, back to the last commit"],
  ["stash pop / list / drop", "bring stashed tabs back / list / discard"],
  ["remote add origin <url>", "connect a GitHub repo"],
  ["push / pull", "sync layouts with GitHub"],
  ["git <args>", "run any git command in the layouts repo"],
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
      push: args => this.#git(["push", ...this.#pushDefaults(args)]),
      pull: args => this.#git(["pull", "--ff-only", ...args]),
      remote: args => this.#git(["remote", ...(args.length ? args : ["-v"])]),
      git: args => this.#gitCommand(args),
      branch: this.#branch,
      switch: this.#switch,
      checkout: this.#checkout,
      stash: this.#stash,
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
      default:
        this.window.openTrustedLinkIn(resolved.url, where);
    }
  }

  async #searchFor(query, where) {
    const engine = await Services.search.getDefault();
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
    const status = await ZenGitManager.refresh(this.window);
    const branch = (await ZenGitManager.repo.currentBranch()) || "main";
    this.#print(`On branch ${branch} · ${ZenGitManager.repoDir}`, "dim");
    this.#printStatusLines(formatStatus(status, ZenGitManager.hasHead));
  }

  async #diff() {
    const status = await ZenGitManager.refresh(this.window);
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
      const status = await ZenGitManager.refresh(this.window);
      message = `Layout: ${summarize(status)}`;
    }
    const hash = await ZenGitManager.commit(this.window, message);
    if (hash) {
      const branch = (await ZenGitManager.repo.currentBranch()) || "main";
      this.#print(`[${branch} ${hash}] ${message}`, "added");
    } else {
      this.#print("Nothing to commit, layout clean.", "dim");
    }
  }

  async #log(args) {
    const count =
      parseInt(args.find(a => /^-?\d+$/.test(a))?.replace("-", ""), 10) || 20;
    const entries = await ZenGitManager.repo.log(count);
    if (!entries.length) {
      this.#print("No commits yet.", "dim");
      return;
    }
    for (const { hash, when, subject } of entries) {
      this.#print(`${hash}  ${when.padEnd(16)} ${subject}`);
    }
  }

  async #restore(args) {
    const status = await ZenGitManager.refresh(this.window);
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

  #pushDefaults(args) {
    // First push: set upstream so plain `push` works afterwards.
    return args.length ? args : ["-u", "origin", "HEAD"];
  }

  /**
   * Prints what the console sees, to diagnose missing tabs or statuses.
   */
  async #debug() {
    const sidebar = ZenGitManager.collectSidebar(this.window);
    this.#print(`repo: ${ZenGitManager.repoDir}`, "dim");
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
    const status = await ZenGitManager.refresh(this.window);
    this.#print(
      `status: ${status.added.length} untracked, ${status.modified.length} modified, ${status.deleted.length} deleted; head=${ZenGitManager.hasHead}`,
      "dim"
    );
  }

  #printResult({ summary, warnings }) {
    this.#print(summary, "dim");
    for (const warning of warnings) {
      this.#print(`warning: ${warning}`, "modified");
    }
  }

  async #branch(args) {
    if (!args.length) {
      const [branches, current] = await Promise.all([
        ZenGitManager.repo.branches(),
        ZenGitManager.repo.currentBranch(),
      ]);
      if (!branches.length) {
        this.#print("No branches yet. Run `commit` first.", "dim");
        return;
      }
      for (const name of branches) {
        this.#print(
          name === current ? `* ${name}` : `  ${name}`,
          name === current ? "added" : ""
        );
      }
      return;
    }
    if (args[0].startsWith("-")) {
      // -d, -D, -m and friends behave exactly like git.
      await this.#git(["branch", ...args]);
      return;
    }
    await this.#git(["branch", args[0]]);
  }

  async #switch(args) {
    const force = args.includes("-f") || args.includes("--discard-changes");
    const rest = args.filter(a => a !== "-f" && a !== "--discard-changes");
    if (rest[0] === "-c" || rest[0] === "-b") {
      if (!rest[1]) {
        this.#print(`usage: switch -c <new-branch>`, "error");
        return;
      }
      await ZenGitManager.createBranch(rest[1]);
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
    if ((await ZenGitManager.repo.revKind(rest[0])) !== "branch") {
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
    } else {
      const branch = await ZenGitManager.repo.currentBranch();
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
        const entries = await ZenGitManager.repo.stashList();
        if (!entries.length) {
          this.#print("No stashed layouts.", "dim");
        }
        for (const { ref, when, message } of entries) {
          this.#print(`${ref}  ${when.padEnd(16)} ${message}`);
        }
        return;
      }
      case "pop":
      case "apply": {
        const force = rest.includes("-f");
        const ref = rest.find(a => a !== "-f") || "stash@{0}";
        const result = await ZenGitManager.stashPop(this.window, {
          force,
          ref,
        });
        this.#print(`Restored stashed tabs (${ref})`, "added");
        this.#printResult(result);
        return;
      }
      case "drop":
      case "clear":
        await this.#git(["stash", sub, ...rest]);
        return;
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
    const { exitCode, output } = await ZenGitManager.runGit(args);
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
