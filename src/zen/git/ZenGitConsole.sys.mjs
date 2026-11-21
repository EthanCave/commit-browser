/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ZenUIComponent } from "resource:///modules/zen/ui/ZenUIComponent.sys.mjs";
import { STATUS_CHANGED_TOPIC, ZenGitManager } from "./ZenGitManager.sys.mjs";
import {
  STATUS,
  decodeShareCode,
  encodeShareCode,
  formatBytes,
  processRows,
  extractMessage,
  isClean,
  looksLikeTime,
  parseDuration,
  selectTabs,
  formatDiff,
  formatStatus,
  pickHistoryOrigin,
  resolveCdTarget,
  summarize,
  tokenize,
} from "./ZenGitModel.sys.mjs";
import {
  PIPE_ACTIONS,
  applyFilter,
  checkPipeline,
  formatItem,
  historyRange,
  isPipeline,
  splitPipeline,
} from "./ZenPipes.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ZenTabArchiver: "resource:///modules/zen/archive/ZenTabArchiver.sys.mjs",
  ZenFocus: "resource:///modules/zen/focus/ZenFocus.sys.mjs",
  SessionStore:
    "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  formatAge: "resource:///modules/zen/archive/ZenTabArchiveModel.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  ZenNativePlayers: "resource:///modules/zen/media/ZenNativePlayers.sys.mjs",
  describeTrack: "resource:///modules/zen/media/ZenNativePlayersModel.sys.mjs",
  searchURL: "resource:///modules/zen/media/ZenNativePlayersModel.sys.mjs",
  PLAYERS: "resource:///modules/zen/media/ZenNativePlayersModel.sys.mjs",
  ZenAI: "resource:///modules/zen/ai/ZenAI.sys.mjs",
  ZenAIWindow: "resource:///modules/zen/ai/ZenAIWindow.sys.mjs",
  ZenEmbeddings: "resource:///modules/zen/ai/ZenEmbeddings.sys.mjs",
  ZenDo: "resource:///modules/zen/ai/ZenDo.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "AIModel", () =>
  ChromeUtils.importESModule("resource:///modules/zen/ai/ZenAIModel.sys.mjs")
);

const HTML_NS = "http://www.w3.org/1999/xhtml";

// `ai key sk-ant-…` never shows up in the console output or its history.
function hideSecrets(line) {
  return line.replace(/^(\s*ai\s+key\s+)(?!-)\S+/, "$1••••••••");
}
const BLAME_KEY = "zen-blame";

function registerGrepActor() {
  try {
    ChromeUtils.registerWindowActor("ZenGrep", {
      parent: { esModuleURI: "resource:///modules/zen/git/ZenGrepParent.sys.mjs" },
      child: { esModuleURI: "resource:///modules/zen/git/ZenGrepChild.sys.mjs" },
      allFrames: false,
      messageManagerGroups: ["browsers"],
    });
  } catch (e) {
    if (e.name !== "NotSupportedError") {
      console.error(e);
    }
    /* already registered by another window */
  }
}

function relativeTime(at) {
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  return `${Math.round(hours / 24)} days ago`;
}
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
  ["", "Time travel (a snapshot of every space each hour):"],
  ["timeline", "this space's snapshots"],
  [
    "checkout <time>",
    "bring back this space as it was: yesterday, \"last tuesday\", \"3 days ago\"",
  ],
  ["diff <time>", "what you opened and closed since then"],
  ["", "Finding and moving tabs:"],
  ["grep [-a] <text>", "search the text of this space's tabs (-a: every space)"],
  ["go <n>", "jump to a result from grep (or click it)"],
  ["blame", "where this tab came from and when it was first committed"],
  [
    "cherry-pick <from> [n|text]",
    "copy tabs here from a branch, another space, <space>/<branch> or a time",
  ],
  ["share [-y | --code]", "share this space: preview, secret gist (-y) or a code"],
  ["import <link|code>", "add a space someone shared"],
  ["focus [25m] [sites]", "block distracting sites and stay in this space (focus off ends it)"],
  ["", "Speed:"],
  ["top [-c]", "memory and CPU by site (-c: busiest first)"],
  ["unload <n>", "put the tabs in one row of `top` to sleep"],
  ["gc", "put every background tab to sleep (they reload when you click them)"],
  ["", "Music (the Spotify and Music apps):"],
  ["np", "what's playing, in the apps and in tabs"],
  [
    "play [spotify|music] [song]",
    "play, or find a song: Music plays it from your library, Spotify opens its search",
  ],
  ["pause / next / prev", "pause, skip, previous track"],
  ["", "AI (Claude; needs an Anthropic API key: `ai key`):"],
  ["ai", "key, models, local search and what this session has cost"],
  ['… | ai "<description>"', "filter by meaning, on this Mac: ls -a | ai \"about my thesis\" | mv School"],
  ['… | ai! "<description>"', "the same filter by Claude, which knows more (Hikaru → chess)"],
  ["ask [-a] <question>", "answer from the pages open in this space (-a: every space)"],
  ["tidy [-s] / tidy apply", "propose folders, moves and closes (-s: smarter model); apply does it"],
  ["catchup", "what you were doing in this space (also shown after time away)"],
  ["do <task> / do open", "research on the web (Tavily if signed in) and report back; open the sources"],
  ["ai location <city>", "where you are, for \"near me\" in do (only this text is sent)"],
  ["commit", "with no -m, Claude writes the message from what changed"],
  ['checkout "<description>"', "find a commit by meaning: checkout \"planning Tokyo\""],
  ["", "Pipes (start with a list, filter it, end with an action):"],
  ["ls [-a] | …", "tabs in this space (-a: every space)"],
  ["history [today|yesterday|week|3d|all] [text]", ""],
  ["", "                         pages you visited (`history` alone: commands you typed here)"],
  ["| grep [-v] [-u] <text>", "keep matches in the title or URL (-v: drop them, -u: URL only)"],
  ["| head / tail [n]", "first / last n (10)"],
  ["| sort [-r] [title|url|host|space|time]", ""],
  ["| uniq", "drop repeated URLs"],
  [
    "| close / sleep / mv <space>",
    "close tabs, put them to sleep, or move them to a space",
  ],
  ["| open / copy / wc", "open as tabs, copy the URLs, or count"],
  [
    "",
    "e.g. ls -a | grep youtube | close   ·   history today | grep recipe | open",
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
  #startedAt = 0;
  #consoleOpening = null;
  #grepResults = [];
  #topRows = [];
  #grepQuery = "";

  init() {
    this.addEventListener("keydown", { capture: true });
    this.addEventListener("TabSelect");
    for (const type of TAB_EVENTS) {
      this.addEventListener(type);
    }
    this.listenBrowserTabsProgress();
    Services.obs.addObserver(this.#observer, STATUS_CHANGED_TOPIC);
    this.#currentTab = this.window.gBrowser.selectedTab;
    this.#startedAt = Date.now();
    ZenGitManager.scheduleRefresh(this.window);
    ZenGitManager.startTimeTravel();
    registerGrepActor();
  }

  uninit() {
    Services.obs.removeObserver(this.#observer, STATUS_CHANGED_TOPIC);
  }

  handleEvent(event) {
    if (event.type === "TabOpen") {
      this.#recordOrigin(event.target);
    }
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
          this.#history.unshift(hideSecrets(line));
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

  #print(text, kind = "", onClick = null) {
    if (!this.#output) {
      return;
    }
    for (const line of String(text).split("\n")) {
      const node = this.document.createElementNS(HTML_NS, "div");
      node.className = `zen-git-line ${kind}`;
      node.textContent = line;
      if (onClick) {
        node.classList.add("clickable");
        node.addEventListener("click", onClick);
      }
      this.#output.append(node);
    }
    while (this.#output.childElementCount > MAX_OUTPUT_LINES) {
      this.#output.firstElementChild.remove();
    }
    this.#output.scrollTop = this.#output.scrollHeight;
  }

  // A line of Claude's answer: `**bold**` shows as bold instead of asterisks.
  #fillRich(node, text) {
    node.replaceChildren(
      ...lazy.AIModel.inlineSegments(text).map(({ text: part, bold }) => {
        if (!bold) {
          return this.document.createTextNode(part);
        }
        const strong = this.document.createElementNS(HTML_NS, "b");
        strong.textContent = part;
        return strong;
      })
    );
  }

  #printRich(text, kind = "") {
    for (const line of String(text).split("\n")) {
      this.#print(line, kind);
      this.#fillRich(this.#output.lastElementChild, line);
    }
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
    this.#print(`❯ ${hideSecrets(line)}`, "echo");
    if (isPipeline(line)) {
      await this.#pipe(line);
      return;
    }
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
      timeline: this.#timeline,
      grep: this.#grep,
      go: this.#go,
      blame: this.#blame,
      "cherry-pick": this.#cherryPick,
      share: this.#share,
      import: this.#import,
      focus: this.#focus,
      top: this.#top,
      unload: this.#unload,
      gc: this.#gc,
      ai: this.#ai,
      ask: this.#ask,
      tidy: this.#tidy,
      catchup: this.#catchUp,
      do: this.#do,
      np: this.#nowPlaying,
      play: this.#play,
      pause: this.#pause,
      next: args => this.#skip("next", args),
      skip: args => this.#skip("next", args),
      prev: args => this.#skip("previous", args),
      setup: this.#clone,
      archive: this.#archive,
      debug: this.#debug,
      clear: () => this.#output.replaceChildren(),
      // `history` alone is what you typed here; `history today` (or
      // yesterday, week, 3d, all) is the pages you visited.
      history: (args, line) =>
        args.length
          ? this.#pipe(line)
          : this.#print(
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
        this.#openFromConsole(url, where, `${where === "tab" ? "open" : "cd"} ${target}`);
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
    this.#openFromConsole(url, where, `search "${query}"`);
  }

  #openFromConsole(url, where, label) {
    this.#consoleOpening = label;
    try {
      this.window.openTrustedLinkIn(url, where);
    } finally {
      this.window.setTimeout(() => (this.#consoleOpening = null), 0);
    }
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

  async #diff(args = []) {
    if (args.length) {
      const when = args.join(" ");
      const { status, date, space } = await ZenGitManager.diffSince(
        this.window,
        when
      );
      this.#print(`${space.name} since ${date}:`, "dim");
      this.#printStatusLines(formatDiff(status));
      return;
    }
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
      const { status, space } = await ZenGitManager.spaceStatus(this.window);
      message = `Layout: ${summarize(status)}`;
      const written = await this.#writeCommitMessage(space, status);
      if (written) {
        message = written;
      }
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

  // ---------------------------------------------------------------------
  // Time travel, grep, blame, cherry-pick, share, focus

  async #timeline() {
    const { space, entries } = await ZenGitManager.timeline(this.window);
    if (!entries.length) {
      this.#print(
        `${space.name} has no snapshots yet. One is taken every hour while Commit is open.`,
        "dim"
      );
      return;
    }
    this.#print(`${space.name}, newest first:`, "dim");
    for (const { date, ago } of entries) {
      this.#print(`  ${date.padEnd(22)} ${ago}`);
    }
    this.#print('`checkout "<time>"` brings one back, `diff <time>` compares.', "dim");
  }

  async #grep(args) {
    const all = args.includes("-a") || args.includes("--all");
    const query = args.filter(a => a !== "-a" && a !== "--all").join(" ");
    if (!query) {
      this.#print("usage: grep [-a] <text>", "error");
      return;
    }
    const { gZenWorkspaces } = this.window;
    const active = gZenWorkspaces.activeWorkspace;
    const spaces = new Map(gZenWorkspaces.getWorkspaces().map(s => [s.uuid, s.name]));
    const tabs = gZenWorkspaces.allStoredTabs.filter(
      tab =>
        !tab.hasAttribute("zen-empty-tab") &&
        !tab.hasAttribute("zen-glance-tab") &&
        (all ||
          tab.hasAttribute("zen-essential") ||
          tab.getAttribute("zen-workspace-id") === active)
    );
    const needle = query.toLowerCase();
    let unloaded = 0;
    const found = await Promise.all(
      tabs.map(async tab => {
        const url = tab.linkedBrowser?.currentURI?.spec || "";
        const inTitle =
          tab.label.toLowerCase().includes(needle) || url.toLowerCase().includes(needle);
        let page = { count: 0, snippets: [] };
        const actor = tab.linkedBrowser?.browsingContext?.currentWindowGlobal;
        if (actor && !tab.hasAttribute("pending")) {
          try {
            page = await Promise.race([
              actor.getActor("ZenGrep").sendQuery("ZenGrep:Search", { query, max: 2 }),
              new Promise(resolve => this.window.setTimeout(() => resolve(page), 2500)),
            ]);
          } catch {
            /* about: pages and the like can't be searched */
          }
        } else {
          unloaded++;
        }
        return inTitle || page?.count ? { tab, inTitle, page } : null;
      })
    );
    this.#grepResults = found.filter(Boolean).map(r => r.tab);
    this.#grepQuery = query;
    if (!this.#grepResults.length) {
      this.#print(`No tabs mention "${query}".`, "dim");
    }
    found.filter(Boolean).forEach(({ tab, page }, i) => {
      let host = "";
      try {
        host = tab.linkedBrowser.currentURI.host;
      } catch {}
      const where = all
        ? `  [${tab.hasAttribute("zen-essential") ? "essentials" : spaces.get(tab.getAttribute("zen-workspace-id")) || ""}]`
        : "";
      const count = page?.count ? `  (${page.count})` : "";
      const go = () => this.#go([String(i + 1)]);
      this.#print(`${String(i + 1).padStart(2)}  ${tab.label}${host ? ` — ${host}` : ""}${count}${where}`, "added", go);
      for (const snippet of page?.snippets || []) {
        this.#print(`      ${snippet}`, "dim", go);
      }
    });
    if (unloaded) {
      this.#print(
        `(${unloaded} tab${unloaded === 1 ? " isn't" : "s aren't"} loaded, so only ${unloaded === 1 ? "its" : "their"} titles and URLs were searched.)`,
        "dim"
      );
    }
    if (this.#grepResults.length) {
      this.#print("`go <n>` or click a result to jump there.", "dim");
    }
  }

  async #go(args) {
    const n = Number.parseInt(args[0], 10);
    const tab = this.#grepResults[n - 1];
    if (!tab?.isConnected) {
      this.#print("usage: go <n>, with a number from the last `grep`", "error");
      return;
    }
    this.window.gBrowser.selectedTab = tab;
    this.toggle(false);
    if (!this.#grepQuery) {
      return;
    }
    try {
      const findbar = await this.window.gBrowser.getFindBar(tab);
      findbar._findField.value = this.#grepQuery;
      findbar.open();
      findbar.onFindAgainCommand(false);
    } catch {
      /* the tab is shown even if highlighting fails */
    }
  }

  // Remembers where a new tab came from, for `blame`. Saved with the tab, so
  // it survives restarts; tabs restored at startup keep what they had.
  #recordOrigin(tab) {
    if (Date.now() - this.#startedAt < 15000 || tab.hasAttribute("pending")) {
      return;
    }
    const consoleLabel = this.#consoleOpening;
    this.window.setTimeout(async () => {
      try {
        if (!tab.isConnected || lazy.SessionStore.getCustomTabValue(tab, BLAME_KEY)) {
          return;
        }
        const opener = tab.openerTab;
        const space = this.window.gZenWorkspaces.getActiveWorkspaceFromCache();
        let branch = null;
        try {
          branch = await (await ZenGitManager.activeSpaceRepo(this.window)).repo.currentBranch();
        } catch {}
        const record = {
          at: Date.now(),
          how: consoleLabel ? "console" : opener ? "link" : "new tab",
          command: consoleLabel,
          from: opener
            ? { title: opener.label, url: opener.linkedBrowser?.currentURI?.spec || "" }
            : null,
          space: space?.name || null,
          branch: branch || "main",
        };
        lazy.SessionStore.setCustomTabValue(tab, BLAME_KEY, JSON.stringify(record));
      } catch (e) {
        console.error(e);
      }
    }, 0);
  }

  async #blame() {
    const tab = this.window.gBrowser.selectedTab;
    let host = "";
    try {
      host = tab.linkedBrowser.currentURI.host;
    } catch {}
    this.#print(`${tab.label}${host ? ` — ${host}` : ""}`, "added");
    let record = null;
    try {
      record = JSON.parse(lazy.SessionStore.getCustomTabValue(tab, BLAME_KEY) || "null");
    } catch {}
    const line = (label, text) => this.#print(`  ${label.padEnd(9)}${text}`);
    if (record) {
      const when = new Date(record.at);
      line(
        "opened",
        `${when.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} (${relativeTime(record.at)})`
      );
      let from = "a new tab";
      if (record.how === "link" && record.from) {
        let fromHost = "";
        try {
          fromHost = new URL(record.from.url).host;
        } catch {}
        from = `a link on "${record.from.title}"${fromHost ? ` (${fromHost})` : ""}`;
      } else if (record.how === "console") {
        from = `the console: ${record.command}`;
      }
      line("from", from);
      if (record.space) {
        line("in", `${record.space} on branch ${record.branch}`);
      }
    } else {
      line("opened", "before Commit started keeping track (tabs opened from now on are)");
    }
    try {
      const state = JSON.parse(lazy.SessionStore.getTabState(tab));
      const entries = state.entries || [];
      if (entries.length > 1) {
        line("started", `${entries[0].url}  (${entries.length} pages back, now on ${state.index || entries.length})`);
      }
    } catch {}
    const first = await ZenGitManager.firstCommitOf(this.window, tab);
    line(
      "commit",
      first
        ? `first saved in ${first.hash} "${first.subject}" (${first.ago}, on ${first.branch})`
        : "not in any commit yet"
    );
  }

  async #cherryPick(args) {
    const [source, ...selectors] = args;
    if (!source) {
      this.#print(
        "usage: cherry-pick <branch | space | space/branch | time> [n | text | all]",
        "error"
      );
      return;
    }
    const { label, tabs } = await ZenGitManager.pickSource(this.window, source);
    if (!selectors.length) {
      if (!tabs.length) {
        this.#print(`${label} has no tabs.`, "dim");
        return;
      }
      this.#print(`${label}:`, "dim");
      tabs.forEach((tab, i) => this.#print(`${String(i + 1).padStart(2)}  ${tab.title}`));
      this.#print(`\`cherry-pick ${source} 2 4\`, \`… <text>\` or \`… all\` copies them here.`, "dim");
      return;
    }
    const picked = selectTabs(tabs, selectors);
    if (!picked.length) {
      this.#print(`Nothing in ${label} matches ${selectors.join(" ")}.`, "error");
      return;
    }
    const { opened, skipped } = await ZenGitManager.cherryPick(this.window, picked);
    for (const tab of opened) {
      this.#print(`+ ${tab.title}`, "added");
    }
    for (const tab of skipped) {
      this.#print(`  ${tab.title} (already open here)`, "dim");
    }
  }

  async #share(args) {
    const { space, shared } = await ZenGitManager.sharedSpace(this.window);
    if (!shared.tabs.length) {
      this.#print(`${space.name} has no tabs to share.`, "dim");
      return;
    }
    const copy = text =>
      Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(text);
    if (args.includes("--code")) {
      const code = encodeShareCode(shared);
      copy(code);
      this.#print(`Copied a share code for ${space.name} (${shared.tabs.length} tabs). Send it to a friend; they run \`import <code>\`.`, "added");
      return;
    }
    if (args.includes("-y") || args.includes("--yes")) {
      const url = await ZenGitManager.publishGist(shared);
      copy(url);
      this.#print(`Shared ${space.name} as a secret gist (copied): ${url}`, "added");
      this.#print("Anyone with the link can see it. Delete it on gist.github.com to unshare.", "dim");
      return;
    }
    this.#print(`Sharing ${space.name} would include ${shared.tabs.length} tab(s) and ${shared.folders.length} folder(s):`, "dim");
    for (const tab of shared.tabs) {
      this.#print(`  ${tab.title}  — ${tab.url}`);
    }
    this.#print(
      "Secrets in URLs and sites in .browserignore are already left out. " +
        "`share -y` publishes it as a secret GitHub gist; `share --code` copies a code instead (nothing is uploaded).",
      "dim"
    );
  }

  async #import(args) {
    const input = args.join(" ").trim();
    if (!input) {
      this.#print("usage: import <gist link | share code>", "error");
      return;
    }
    let shared = decodeShareCode(input);
    if (!shared) {
      const id = input.match(/gist\.github(?:usercontent)?\.com\/(?:[^/]+\/)?([0-9a-f]{8,})/i)?.[1];
      if (!id) {
        this.#print("That isn't a gist link or a Commit share code.", "error");
        return;
      }
      const response = await this.window.fetch(`https://api.github.com/gists/${id}`, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!response.ok) {
        this.#print(`Couldn't open that gist (${response.status}).`, "error");
        return;
      }
      const gist = await response.json();
      for (const file of Object.values(gist.files || {})) {
        try {
          const data = JSON.parse(file.content);
          if (data?.format === "commit-space") {
            shared = data;
            break;
          }
        } catch {}
      }
      if (!shared) {
        this.#print("That gist doesn't hold a shared Commit space.", "error");
        return;
      }
    }
    const { space, summary } = await ZenGitManager.importSpace(this.window, shared);
    this.#print(`Added the space "${space.name}": ${summary}`, "added");
  }

  #focus(args) {
    const { ZenFocus } = lazy;
    if (args[0] === "off" || args[0] === "stop") {
      if (!ZenFocus.active) {
        this.#print("Focus mode isn't on.", "dim");
        return;
      }
      ZenFocus.stop();
      this.#print("Focus mode is off.", "dim");
      return;
    }
    if (!args.length && ZenFocus.active) {
      const until = new Date(ZenFocus.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      this.#print(`Focusing until ${until}. Blocked: ${ZenFocus.sites.join(", ")}`, "dim");
      return;
    }
    let ms = 25 * 60000;
    const sites = [];
    for (const arg of args) {
      const duration = parseDuration(arg);
      if (duration) {
        ms = duration;
      } else {
        sites.push(arg);
      }
    }
    ZenFocus.start(this.window.gZenWorkspaces.activeWorkspace, ms, sites);
    const until = new Date(Date.now() + ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    this.#print(`Focusing until ${until}. Blocked: ${ZenFocus.sites.join(", ")}`, "added");
    this.#print("You'll stay in this space. `focus off` ends it early.", "dim");
    this.toggle(false);
  }

  // ---------------------------------------------------------------------
  // top, unload, gc

  async #sampleProcesses(ms = 1000) {
    const before = await ChromeUtils.requestProcInfo();
    await new Promise(resolve => this.window.setTimeout(resolve, ms));
    const after = await ChromeUtils.requestProcInfo();
    return { before, after, ms };
  }

  #tabsByPid() {
    const byPid = new Map();
    for (const tab of this.window.gBrowser.tabs) {
      const pid = tab.linkedBrowser?.browsingContext?.currentWindowGlobal?.osPid;
      if (pid > 0) {
        byPid.set(pid, [...(byPid.get(pid) || []), tab]);
      }
    }
    return byPid;
  }

  async #top(args) {
    const sortBy = args.includes("-c") || args.includes("--cpu") ? "cpu" : "memory";
    this.#print("Measuring for a second…", "dim");
    const { before, after, ms } = await this.#sampleProcesses();
    const { rows, total } = processRows(before, after, ms, this.#tabsByPid(), { sortBy });
    this.#topRows = rows;
    this.#print(`  #     MEMORY    CPU   TABS`, "dim");
    rows.forEach((row, i) => {
      const n = row.pid ? String(i + 1).padStart(3) : "   ";
      const mem = formatBytes(row.memory).padStart(8);
      const cpu = `${Math.round(row.cpu)}%`.padStart(5);
      let label = row.label;
      if (row.tabs.length) {
        let host = "";
        try {
          host = row.tabs[0].linkedBrowser.currentURI.host.replace(/^www\./, "");
        } catch {}
        const more = row.tabs.length > 1 ? `  (+${row.tabs.length - 1} more)` : "";
        label = `${host || row.tabs[0].label} — ${row.tabs[0].label}${more}`;
      }
      const heavy = row.memory > 500 * 1024 * 1024 || row.cpu > 20;
      this.#print(`${n}  ${mem}  ${cpu}   ${label}`, heavy ? "modified" : "");
    });
    const asleep = this.window.gBrowser.tabs.filter(t => t.hasAttribute("pending")).length;
    this.#print(
      `Commit is using ${formatBytes(total)}${asleep ? `; ${asleep} tab${asleep === 1 ? " is" : "s are"} asleep and use none` : ""}. ` +
        "`unload <n>` puts one row to sleep, `gc` every background tab.",
      "dim"
    );
  }

  // Tabs that can sleep without you noticing: not on screen, not playing
  // audio or a picture-in-picture video, not sharing your screen.
  #canSleep(tab) {
    return (
      !tab.selected &&
      !tab.closing &&
      !tab.hasAttribute("pending") &&
      !tab.soundPlaying &&
      !tab.hasAttribute("pictureinpicture") &&
      !tab.hasAttribute("sharing") &&
      !tab.linkedBrowser?.docShellIsActive &&
      tab.linkedBrowser?.isRemoteBrowser
    );
  }

  #sleep(tabs) {
    let slept = 0;
    for (const tab of tabs) {
      try {
        if (this.#canSleep(tab) && this.window.gBrowser.discardBrowser(tab)) {
          slept++;
        }
      } catch (e) {
        console.error(e);
      }
    }
    return slept;
  }

  async #unload(args) {
    const n = Number.parseInt(args[0], 10);
    const row = this.#topRows[n - 1];
    if (!row?.pid) {
      this.#print("usage: unload <n>, with a numbered row from the last `top`", "error");
      return;
    }
    const slept = this.#sleep(row.tabs.filter(t => t.isConnected));
    const kept = row.tabs.length - slept;
    this.#print(
      slept
        ? `Put ${slept} tab${slept === 1 ? "" : "s"} to sleep.${kept ? ` ${kept} stayed awake (on screen, playing, or holding unsaved input).` : ""}`
        : "Those tabs are on screen, playing, or holding unsaved input, so they stayed awake.",
      slept ? "added" : "dim"
    );
  }

  async #gc() {
    const total = info => [info, ...(info.children || [])].reduce((n, p) => n + (p.memory || 0), 0);
    const before = total(await ChromeUtils.requestProcInfo());
    const slept = this.#sleep([...this.window.gBrowser.tabs]);
    if (!slept) {
      this.#print("Every background tab is already asleep (or busy playing or sharing).", "dim");
      return;
    }
    // Processes take a moment to exit once their last tab sleeps.
    await new Promise(resolve => this.window.setTimeout(resolve, 2000));
    const freed = before - total(await ChromeUtils.requestProcInfo());
    this.#print(
      `Put ${slept} background tab${slept === 1 ? "" : "s"} to sleep` +
        (freed > 0 ? `, freeing about ${formatBytes(freed)}.` : ".") +
        " They reload when you click them.",
      "added"
    );
  }

  // ---------------------------------------------------------------------
  // Music: the Spotify and Music apps (ZenNativePlayers)

  #trackLine(player) {
    const icon = player.isPlaying ? "▶" : "❚❚";
    const position = player.getPositionState().position;
    return `${icon} ${lazy.describeTrack({ ...player.state, position })}  (${player.name})`;
  }

  // `play spotify …` / `play music …` pick the app; otherwise the one
  // playing, then the one paused, then Spotify, then Music.
  async #targetPlayer(args) {
    const players = lazy.ZenNativePlayers;
    const named = players.player(args[0]?.toLowerCase());
    if (named) {
      if (!(await players.installed()).includes(named.id)) {
        throw new Error(`${named.name} isn't installed.`);
      }
      return { player: named, rest: args.slice(1) };
    }
    const player = await players.pick();
    if (!player) {
      throw new Error(
        lazy.ZenNativePlayers.denied.length
          ? "Commit isn't allowed to control Spotify or Music. Turn it on in System Settings → Privacy & Security → Automation → Commit."
          : "Neither Spotify nor Music is installed."
      );
    }
    return { player, rest: args };
  }

  async #afterChange(player) {
    await new Promise(resolve => this.window.setTimeout(resolve, 800));
    await lazy.ZenNativePlayers.refresh();
    if (player.isActive) {
      this.#print(this.#trackLine(player), "added");
    }
  }

  async #nowPlaying() {
    const players = lazy.ZenNativePlayers;
    await players.refresh();
    let any = false;
    for (const player of players.players) {
      if (player.isActive) {
        any = true;
        this.#print(this.#trackLine(player), player.isPlaying ? "added" : "");
      }
    }
    for (const tab of this.window.gBrowser.tabs) {
      if (tab.soundPlaying) {
        any = true;
        this.#print(`▶ ${tab.label}  (tab)`, "added", () =>
          this.window.gZenWorkspaces.switchTabIfNeeded(tab)
        );
      }
    }
    if (!any) {
      this.#print("Nothing is playing.", "dim");
    }
    for (const id of players.denied) {
      this.#print(
        `Commit isn't allowed to control ${lazy.PLAYERS[id].name}: System Settings → Privacy & Security → Automation → Commit.`,
        "modified"
      );
    }
  }

  async #play(args) {
    const players = lazy.ZenNativePlayers;
    const { player, rest } = await this.#targetPlayer(args);
    const query = rest.join(" ").trim();
    if (!query) {
      await players.command(player.id, "play");
      await this.#afterChange(player);
      return;
    }
    if (player.id == "music") {
      const found = await players.command("music", "search", [query]);
      if (found) {
        const [title, artist] = found.split("\u001f");
        this.#print(`▶ ${title}${artist ? ` — ${artist}` : ""}  (Music)`, "added");
        return;
      }
      const country = (Services.locale.regionalPrefsLocales[0] || "")
        .split("-")
        .pop()
        .toLowerCase();
      const { exitCode } = await players.openExternal(
        lazy.searchURL("music", query, { country })
      );
      if (exitCode == 0) {
        this.#print(
          `Nothing in your library matches "${query}", so I opened Apple Music's search in Music.`,
          "dim"
        );
        return;
      }
      this.#openFromConsole(
        lazy.searchURL("music", query, { country, web: true }),
        "tab",
        `play ${query}`
      );
      this.#print(
        `Nothing in your library matches "${query}", and Music didn't open the search, so here's Apple Music's website.`,
        "dim"
      );
      return;
    }
    await players.openExternal(lazy.searchURL("spotify", query));
    this.#print(
      `Opened Spotify's search for "${query}". Pick a song there: Spotify doesn't let other apps play search results.`,
      "dim"
    );
  }

  async #pause(args) {
    const { player } = await this.#targetPlayer(args);
    if (!player.isPlaying) {
      this.#print("Nothing is playing.", "dim");
      return;
    }
    await lazy.ZenNativePlayers.command(player.id, "pause");
    this.#print(`❚❚ Paused ${player.name}.`, "dim");
  }

  async #skip(action, args) {
    const { player } = await this.#targetPlayer(args);
    if (!player.isActive) {
      this.#print(`${player.name} isn't playing anything.`, "dim");
      return;
    }
    await lazy.ZenNativePlayers.command(player.id, action);
    await this.#afterChange(player);
  }

  // ---------------------------------------------------------------------
  // AI (ZenAI.sys.mjs, prompts in ZenAIModel.sys.mjs)

  #costNote(cost) {
    const text = lazy.AIModel.formatCost(cost);
    return text ? ` (${text})` : "";
  }

  async #ai(args) {
    const { ZenAI, ZenEmbeddings } = lazy;
    const [sub, ...rest] = args;
    if (sub == "key") {
      if (rest[0] == "--remove" || rest[0] == "-d") {
        await ZenAI.setKey("");
        this.#print("Removed the API key. Claude features are off; local search still works.", "dim");
        return;
      }
      let key = rest[0];
      if (!key) {
        const entered = { value: "" };
        const ok = Services.prompt.promptPassword(
          this.window,
          "Anthropic API key",
          "Paste an API key from console.anthropic.com. Commit keeps it in its password store.",
          entered,
          null,
          {}
        );
        key = ok ? entered.value.trim() : "";
        if (!key) {
          this.#print("No key entered.", "dim");
          return;
        }
      }
      await ZenAI.setKey(key);
      this.#print("Saved your API key in Commit's password store.", "added");
      if (!/^sk-ant-/.test(key)) {
        this.#print("That doesn't look like an Anthropic key (they start with sk-ant-).", "modified");
      }
      return;
    }
    if (sub == "model") {
      const [tier, id] = rest;
      if (tier != "fast" && tier != "smart") {
        this.#print("usage: ai model fast|smart [model id]", "error");
        return;
      }
      if (id) {
        ZenAI.setModel(tier, id);
      }
      this.#print(`${tier}: ${ZenAI.model(tier)}`);
      return;
    }
    if (sub == "location") {
      if (rest[0] == "--clear" || rest[0] == "-d") {
        Services.prefs.clearUserPref("zen.ai.location");
        this.#print("Cleared your location. `do` won't assume where you are.", "dim");
        return;
      }
      if (rest.length) {
        Services.prefs.setStringPref("zen.ai.location", rest.join(" "));
      }
      const place = Services.prefs.getStringPref("zen.ai.location", "");
      this.#print(
        place
          ? `Location: ${place}. \`do\` uses it for "near me" (only this text is sent).`
          : "No location set. `ai location Houston, TX` lets `do` answer \"near me\".",
        place ? "" : "dim"
      );
      return;
    }
    if (sub == "local") {
      if (rest[0] == "on" || rest[0] == "off") {
        Services.prefs.setBoolPref("zen.ai.local.enabled", rest[0] == "on");
        this.#print(`Local search is ${rest[0]}.`, "dim");
        return;
      }
      if (rest[0] == "setup") {
        this.#print(`Downloading ${ZenEmbeddings.model} (about 0.6 GB)…`, "dim");
        await ZenEmbeddings.setup();
        this.#print("Done. `ai` filters now run on this Mac.", "added");
        return;
      }
      const state = await ZenEmbeddings.ready();
      this.#print(
        state.ok ? `Local search: ready (${ZenEmbeddings.model} via Ollama)` : `Local search: not available: ${state.reason}`,
        state.ok ? "added" : "modified"
      );
      return;
    }
    const hasKey = await ZenAI.hasKey();
    this.#print(
      hasKey ? "API key: set (in Commit's password store)" : "API key: not set. Run `ai key` to add one.",
      hasKey ? "added" : "modified"
    );
    this.#print(`fast: ${ZenAI.model("fast")}   commit messages, catch-up, tidy, ai!`);
    this.#print(`smart: ${ZenAI.model("smart")}   ask, do, tidy -s`);
    this.#print("  (ai model fast|smart <id> changes them)", "dim");
    const local = await ZenEmbeddings.ready();
    this.#print(
      local.ok
        ? `local: ${ZenEmbeddings.model}   ai filters, checkout "<description>" (free, stays on this Mac)`
        : `local: not available: ${local.reason}. ai filters use Claude instead.`,
      local.ok ? "" : "modified"
    );
    const place = Services.prefs.getStringPref("zen.ai.location", "");
    this.#print(place ? `location: ${place}   (ai location changes it)` : "location: not set   (ai location <city>)", place ? "" : "dim");
    const { provider, note } = await lazy.ZenDo.provider();
    this.#print(
      provider == "tavily"
        ? "do searches with: Tavily (your tvly login and credits)"
        : `do searches with: Claude's web search (1¢ a search)${note ? `. ${note}` : ""}`
    );
    this.#print(
      `This session: ${ZenAI.calls} Claude request${ZenAI.calls == 1 ? "" : "s"}, about ${lazy.AIModel.formatCost(ZenAI.spent) || "$0.00"}`,
      "dim"
    );
  }

  async #aiFilter(items, args, { claude = false } = {}) {
    const instruction = args.join(" ").trim();
    if (!instruction) {
      throw new Error('usage: … | ai "<what to keep>"');
    }
    if (!items.length) {
      return items;
    }
    if (!claude) {
      const local = await lazy.ZenEmbeddings.ready();
      if (local.ok) {
        return this.#localFilter(items, instruction);
      }
      this.#print(`(Local search isn't available: ${local.reason}. Asking Claude instead.)`, "dim");
    }
    const { MAX_FILTER_ITEMS, filterRequest, jsonOf, validIndices } = lazy.AIModel;
    if (items.length > MAX_FILTER_ITEMS) {
      this.#print(
        `ai: looking at the first ${MAX_FILTER_ITEMS} of ${items.length}. Put | grep or | head before it to narrow it.`,
        "dim"
      );
      items = items.slice(0, MAX_FILTER_ITEMS);
    }
    this.#print(`Asking Claude about ${items.length} item${items.length == 1 ? "" : "s"}…`, "dim");
    const { message, cost } = await lazy.ZenAI.send({
      ...filterRequest(instruction, items),
      effort: "low",
    });
    const kept = validIndices(jsonOf(message), items.length).map(i => items[i]);
    this.#print(`ai! kept ${kept.length} of ${items.length}${this.#costNote(cost)}`, "dim");
    return kept;
  }

  async #localFilter(items, instruction) {
    const { embeddingText, selectByScore } = lazy.AIModel;
    const texts = items.map(item => embeddingText(item.title, item.url));
    const fresh = await lazy.ZenEmbeddings.uncached(texts);
    if (fresh > 30) {
      this.#print(`Reading ${fresh} new titles on this Mac (once; later searches are instant)…`, "dim");
    }
    const scores = await lazy.ZenEmbeddings.scores(instruction, texts);
    const kept = selectByScore(scores).map(i => items[i]);
    this.#print(
      `ai kept ${kept.length} of ${items.length} (on this Mac). If it missed something, try ai! for Claude.`,
      "dim"
    );
    return kept;
  }

  async #writeCommitMessage(space, status) {
    if (
      isClean(status) ||
      !Services.prefs.getBoolPref("zen.ai.commit-messages", true) ||
      !(await lazy.ZenAI.hasKey())
    ) {
      return "";
    }
    const { checkStop, cleanCommitMessage, commitMessageRequest, textOf } = lazy.AIModel;
    try {
      this.#print("Writing a commit message…", "dim");
      const { message } = await lazy.ZenAI.send({
        ...commitMessageRequest(space.name, formatDiff(status)),
        effort: "low",
        maxTokens: 4000,
      });
      checkStop(message);
      return cleanCommitMessage(textOf(message));
    } catch (e) {
      this.#print(`(Claude couldn't write one, so it's a plain message: ${e.message})`, "dim");
      return "";
    }
  }

  async #findCommit(repo, space, description) {
    const entries = await repo.log(300);
    if (!entries.length) {
      this.#print(`${space.name} has no commits to search yet.`, "dim");
      return null;
    }
    const found = entry => {
      this.#print(`Found ${entry.hash} (${entry.when}): ${entry.subject}`, "dim");
      return entry.hash;
    };
    const local = await lazy.ZenEmbeddings.ready();
    if (local.ok) {
      const { MIN_SCORE, embeddingText } = lazy.AIModel;
      const scores = await lazy.ZenEmbeddings.scores(
        description,
        entries.map(entry => embeddingText(entry.subject))
      );
      const best = scores.indexOf(Math.max(...scores));
      if (scores[best] >= MIN_SCORE) {
        return found(entries[best]);
      }
    }
    if (!(await lazy.ZenAI.hasKey())) {
      this.#print(
        local.ok
          ? `No commit in ${space.name} matches "${description}".`
          : `Can't search commits: ${local.reason}, and there's no API key (\`ai key\`).`,
        "dim"
      );
      return null;
    }
    const { jsonOf, pickCommitRequest } = lazy.AIModel;
    this.#print(`Asking Claude to look through ${entries.length} commits in ${space.name}…`, "dim");
    const { message, cost } = await lazy.ZenAI.send({
      ...pickCommitRequest(description, entries),
      effort: "low",
    });
    const answer = jsonOf(message);
    const entry = answer.found ? entries[answer.index] : null;
    if (!entry) {
      this.#print(`No commit in ${space.name} matches "${description}".${this.#costNote(cost)}`, "dim");
      return null;
    }
    return found(entry);
  }

  async #pageText(tab) {
    try {
      if (tab.hasAttribute("pending")) {
        return "";
      }
      const actor = tab.linkedBrowser?.browsingContext?.currentWindowGlobal?.getActor("ZenGrep");
      if (!actor) {
        return "";
      }
      const timeout = new Promise(resolve => this.window.setTimeout(() => resolve(""), 3000));
      return (await Promise.race([actor.sendQuery("ZenGrep:Text", { max: 100000 }), timeout])) || "";
    } catch {
      return "";
    }
  }

  // A console line that grows as text streams in.
  #liveText(kind = "") {
    let line = null;
    let raw = "";
    const newLine = () => {
      line = this.document.createElementNS(HTML_NS, "div");
      line.className = `zen-git-line ${kind}`;
      this.#output.append(line);
      raw = "";
    };
    newLine();
    return text => {
      const parts = text.split("\n");
      parts.forEach((part, index) => {
        if (index > 0) {
          newLine();
        }
        // Re-render the whole line, so a ** split across chunks still pairs up.
        raw += part;
        this.#fillRich(line, raw);
      });
      this.#output.scrollTop = this.#output.scrollHeight;
    };
  }

  async #ask(args) {
    const { askRequest, checkStop, fitDocs } = lazy.AIModel;
    const all = args.includes("-a");
    const question = args.filter(arg => arg != "-a").join(" ").trim();
    if (!question) {
      this.#print("usage: ask [-a] <question about your open tabs>", "error");
      return;
    }
    const MAX_TABS = 40;
    let tabs = this.#tabItems(all).filter(item => /^https?:/.test(item.url));
    if (!tabs.length) {
      this.#print("No web pages open here to ask about.", "dim");
      return;
    }
    if (tabs.length > MAX_TABS) {
      tabs = [...tabs].sort((a, b) => b.time - a.time).slice(0, MAX_TABS);
      this.#print(`Reading your ${MAX_TABS} most recently used tabs.`, "dim");
    }
    this.#print(`Reading ${tabs.length} tab${tabs.length == 1 ? "" : "s"}…`, "dim");
    const docs = await Promise.all(
      tabs.map(async item => ({ title: item.title, url: item.url, text: await this.#pageText(item.ref) }))
    );
    const asleep = docs.filter(doc => !doc.text).length;
    if (asleep) {
      this.#print(`${asleep} of them are asleep or unreadable, so Claude only sees their titles.`, "dim");
    }
    const budget = Services.prefs.getIntPref("zen.ai.ask.max-chars", 120000);
    const write = this.#liveText();
    const { message, cost } = await lazy.ZenAI.stream(
      { ...askRequest(question, fitDocs(docs, budget)), effort: "medium", tier: "smart" },
      write
    );
    checkStop(message);
    tabs.forEach((item, index) => {
      this.#print(`[${index + 1}] ${item.title}  — ${item.host}`, "dim", () =>
        item.ref.isConnected && this.window.gZenWorkspaces.switchTabIfNeeded(item.ref)
      );
    });
    this.#print(`(${tabs.length} pages${this.#costNote(cost)})`, "dim");
  }

  #tidyPlan = null;

  async #tidy(args) {
    const { cleanTidyPlan, formatTidy, jsonOf, tidyIsEmpty, tidyRequest } = lazy.AIModel;
    const workspaces = this.window.gZenWorkspaces;
    const active = workspaces.activeWorkspace;
    const spaces = workspaces.getWorkspaces();
    const here = spaces.find(s => s.uuid == active);
    if (args[0] == "apply") {
      await this.#applyTidy(active, spaces);
      return;
    }
    const items = this.#tabItems(false).filter(item => !item.essential);
    if (items.length < 3) {
      this.#print(`${here?.name || "This space"} only has ${items.length} tab${items.length == 1 ? "" : "s"}; nothing to tidy.`, "dim");
      return;
    }
    const others = spaces.filter(s => s.uuid != active).map(s => s.name);
    const tier = args.includes("-s") ? "smart" : "fast";
    this.#print(`Looking at ${items.length} tabs in ${here?.name}…`, "dim");
    const { message, cost } = await lazy.ZenAI.send({
      ...tidyRequest(here?.name || "", items, others),
      effort: "medium",
      tier,
    });
    const plan = cleanTidyPlan(jsonOf(message), items, others);
    if (tidyIsEmpty(plan)) {
      this.#tidyPlan = null;
      this.#print(`Looks tidy already.${this.#costNote(cost)}`, "dim");
      return;
    }
    this.#tidyPlan = { plan, items, spaceId: active };
    if (plan.summary) {
      this.#print(plan.summary, "dim");
    }
    for (const [text, kind] of formatTidy(plan, items)) {
      this.#print(text, kind);
    }
    this.#print(
      `Nothing has changed yet. \`tidy apply\` does it${tier == "fast" ? "; `tidy -s` asks the smarter model" : ""}${this.#costNote(cost)}.`,
      "dim"
    );
  }

  async #applyTidy(active, spaces) {
    const saved = this.#tidyPlan;
    if (!saved) {
      this.#print("Run `tidy` first to see a plan.", "error");
      return;
    }
    if (saved.spaceId != active) {
      this.#print("That plan was for another space. Switch back to it, or run `tidy` here.", "error");
      return;
    }
    this.#tidyPlan = null;
    const { plan, items } = saved;
    const live = index => {
      const tab = items[index]?.ref;
      return tab?.isConnected && !tab.closing ? tab : null;
    };
    const counts = { folders: 0, moved: 0, closed: 0 };
    for (const folder of plan.folders) {
      const tabs = folder.tabs.map(live).filter(Boolean);
      if (tabs.length >= 2) {
        this.window.gZenFolders.createFolder(tabs, { label: folder.name, workspaceId: active });
        counts.folders++;
      }
    }
    const bySpace = new Map();
    for (const { tab, space } of plan.move) {
      const target = spaces.find(s => s.name == space);
      const ref = live(tab);
      if (target && ref) {
        bySpace.set(target.uuid, [...(bySpace.get(target.uuid) || []), ref]);
      }
    }
    for (const [uuid, tabs] of bySpace) {
      this.window.gZenWorkspaces.moveTabsToWorkspace(tabs, uuid);
      counts.moved += tabs.length;
    }
    const closing = plan.close.map(({ tab }) => live(tab)).filter(Boolean);
    if (closing.length) {
      this.window.gBrowser.removeTabs(closing);
      counts.closed = closing.length;
    }
    this.#print(
      `Made ${counts.folders} folder${counts.folders == 1 ? "" : "s"}, moved ${counts.moved} tab${counts.moved == 1 ? "" : "s"}, closed ${counts.closed}. ` +
        "`checkout` or time travel brings anything back.",
      "added"
    );
  }

  async #catchUp() {
    const lines = await lazy.ZenAIWindow.catchUp(this.window, { force: true });
    if (!lines?.length) {
      this.#print("Nothing to catch up on in this space yet.", "dim");
      return;
    }
    for (const line of lines) {
      this.#print(line);
    }
  }

  #doSources = [];
  #doTask = "";

  async #do(args) {
    if (args[0] == "open" && args.length == 1) {
      await this.#openDoSources();
      return;
    }
    const task = args.join(" ").trim();
    if (!task) {
      this.#print("usage: do <task>   e.g. do find 3 flights to Tokyo under $600 in March", "error");
      return;
    }
    const { provider } = await lazy.ZenDo.provider();
    this.#print(
      `On it, searching with ${provider == "tavily" ? "Tavily" : "Claude's web search"}. ` +
        "Claude can only search and read. This can take a minute or two.",
      "dim"
    );
    const result = await lazy.ZenDo.run(task, {
      onProgress: line => this.#print(`  ${line}`, "dim"),
    });
    this.#printRich(result.text || "(no answer)");
    this.#doSources = result.sources;
    this.#doTask = task;
    result.sources.slice(0, 12).forEach((source, index) => {
      this.#print(`[${index + 1}] ${source.title}`, "dim", () =>
        this.#openFromConsole(source.url, "tab", `do ${task}`)
      );
    });
    const spent = [
      lazy.AIModel.formatCost(result.cost) || "$0.00",
      result.credits && `${result.credits} Tavily credit${result.credits == 1 ? "" : "s"}`,
    ].filter(Boolean);
    if (result.cached >= 0.05) {
      spent[0] += `, ${Math.round(result.cached * 100)}% read from cache`;
    }
    this.#print(
      `(${spent.join(" + ")}${result.sources.length ? ". `do open` opens the sources in a new space" : ""})`,
      "dim"
    );
  }

  async #openDoSources() {
    if (!this.#doSources.length) {
      this.#print("Run `do <task>` first.", "error");
      return;
    }
    const name = `do: ${this.#doTask}`.slice(0, 32);
    await this.window.gZenWorkspaces.createAndSaveWorkspace(name);
    this.#consoleOpening = `do ${this.#doTask}`;
    try {
      for (const source of this.#doSources.slice(0, 12)) {
        this.window.openTrustedLinkIn(source.url, "tab", { inBackground: true });
      }
    } finally {
      this.window.setTimeout(() => (this.#consoleOpening = null), 0);
    }
    this.#print(`Opened ${Math.min(12, this.#doSources.length)} sources in the space "${name}".`, "added");
  }

  // ---------------------------------------------------------------------
  // Pipes (ZenPipes.sys.mjs): ls -a | grep youtube | close

  async #pipe(line) {
    const stages = splitPipeline(line).map(tokenize);
    checkPipeline(stages);
    const [[source, ...sourceArgs], ...rest] = stages;
    const showSpace =
      source == "ls" && (sourceArgs.includes("-a") || sourceArgs.includes("--all"));
    let items =
      source == "ls"
        ? this.#tabItems(showSpace)
        : await this.#historyItems(sourceArgs);
    for (const [name, ...args] of rest) {
      if (PIPE_ACTIONS.includes(name)) {
        await this.#pipeAction(name, args, items, line);
        return;
      }
      items =
        name == "ai" || name == "ai!"
          ? await this.#aiFilter(items, args, { claude: name == "ai!" })
          : applyFilter(items, name, args);
    }
    this.#printItems(items, { showSpace });
  }

  #tabItems(all) {
    const workspaces = this.window.gZenWorkspaces;
    const active = workspaces.activeWorkspace;
    const spaces = new Map(
      workspaces.getWorkspaces().map(s => [s.uuid, s.name])
    );
    const items = [];
    for (const tab of workspaces.allStoredTabs) {
      if (
        tab.closing ||
        tab.hasAttribute("zen-empty-tab") ||
        tab.hasAttribute("zen-glance-tab")
      ) {
        continue;
      }
      const essential = tab.hasAttribute("zen-essential");
      const spaceId = tab.getAttribute("zen-workspace-id");
      if (!all && !essential && spaceId !== active) {
        continue;
      }
      let url = "";
      let host = "";
      try {
        url = tab.linkedBrowser.currentURI.spec;
        host = tab.linkedBrowser.currentURI.host.replace(/^www\./, "");
      } catch {}
      items.push({
        kind: "tab",
        title: tab.label,
        url,
        host,
        space: essential ? "essentials" : spaces.get(spaceId) || "",
        time: tab.selected ? Date.now() : tab.lastAccessed || 0,
        essential,
        folder: tab.group?.label || "",
        ref: tab,
      });
    }
    return items;
  }

  async #historyItems(args) {
    const { from, to, search } = historyRange(args);
    const db = await lazy.PlacesUtils.promiseDBConnection();
    const rows = await db.executeCached(
      `SELECT p.url AS url, p.title AS title, MAX(v.visit_date) AS last
       FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id
       WHERE v.visit_date >= :from AND v.visit_date < :to AND p.hidden = 0
       GROUP BY p.id ORDER BY last DESC LIMIT 2000`,
      { from: from * 1000, to: to * 1000 }
    );
    let items = rows.map(row => {
      const url = row.getResultByName("url");
      let host = "";
      try {
        host = new URL(url).host.replace(/^www\./, "");
      } catch {}
      return {
        kind: "page",
        title: row.getResultByName("title") || "",
        url,
        host,
        time: row.getResultByName("last") / 1000,
      };
    });
    if (search.length) {
      items = applyFilter(items, "grep", search);
    }
    return items;
  }

  #printItems(items, { showSpace = false } = {}) {
    if (!items.length) {
      this.#print("(nothing)", "dim");
      return;
    }
    const today = new Date().toDateString();
    const formatTime = ms => {
      const date = new Date(ms);
      return date.toDateString() == today
        ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).padStart(8)
        : date.toLocaleDateString([], { month: "short", day: "numeric" }).padStart(8);
    };
    const MAX = 200;
    for (const item of items.slice(0, MAX)) {
      const onClick =
        item.kind == "tab"
          ? () => item.ref.isConnected && this.window.gZenWorkspaces.switchTabIfNeeded(item.ref)
          : () => this.#openFromConsole(item.url, "tab", "history");
      this.#print(formatItem(item, { showSpace, formatTime }), "", onClick);
    }
    const more = items.length > MAX ? `, showing ${MAX}; add | head or | grep` : "";
    this.#print(`(${items.length} ${items[0].kind == "tab" ? "tab" : "page"}${items.length == 1 ? "" : "s"}${more})`, "dim");
  }

  // Big pipes ask for -f first, showing what they'd do.
  #needsForce(verb, list, args, line) {
    const LIMIT = 10;
    if (list.length <= LIMIT || args.includes("-f")) {
      return false;
    }
    this.#print(`This would ${verb} ${list.length}:`, "modified");
    for (const item of list.slice(0, 5)) {
      this.#print(`  ${formatItem(item)}`, "dim");
    }
    this.#print(`  …and ${list.length - 5} more`, "dim");
    this.#print(`Run it with -f to go ahead: ${line} -f`, "dim");
    return true;
  }

  async #pipeAction(name, args, items, line) {
    const tabs = items.filter(item => item.kind == "tab" && item.ref.isConnected);
    const needsTabs = ["close", "sleep", "mv"].includes(name);
    if (needsTabs && items.some(item => item.kind != "tab")) {
      throw new Error(`${name} works on tabs: start the pipe with ls`);
    }
    const plural = (n, word) => `${n} ${word}${n == 1 ? "" : "s"}`;
    switch (name) {
      case "wc":
        this.#print(String(items.length));
        return;
      case "copy": {
        const urls = items.map(item => item.url).filter(Boolean);
        Cc["@mozilla.org/widget/clipboardhelper;1"]
          .getService(Ci.nsIClipboardHelper)
          .copyString(urls.join("\n"));
        this.#print(`Copied ${plural(urls.length, "URL")}.`, "added");
        return;
      }
      case "open": {
        const list = items.filter(item => item.url);
        if (this.#needsForce("open", list, args, line)) {
          return;
        }
        this.#consoleOpening = line;
        try {
          for (const item of list) {
            this.window.openTrustedLinkIn(item.url, "tab", { inBackground: true });
          }
        } finally {
          this.window.setTimeout(() => (this.#consoleOpening = null), 0);
        }
        this.#print(`Opened ${plural(list.length, "tab")} in the background.`, "added");
        return;
      }
      case "close": {
        const force = args.includes("-f");
        // Essentials stay unless you say -f: they're meant to be permanent.
        const list = tabs.filter(item => force || !item.essential);
        const kept = tabs.length - list.length;
        if (this.#needsForce("close", list, args, line)) {
          return;
        }
        this.window.gBrowser.removeTabs(list.map(item => item.ref));
        this.#print(
          `Closed ${plural(list.length, "tab")}.` +
            (kept ? ` Kept ${plural(kept, "Essential")} (close -f closes those too).` : ""),
          list.length ? "deleted" : "dim"
        );
        return;
      }
      case "sleep": {
        const slept = this.#sleep(tabs.map(item => item.ref));
        const busy = tabs.length - slept;
        this.#print(
          `Put ${plural(slept, "tab")} to sleep.` +
            (busy ? ` ${busy} stayed awake (on screen, playing, sharing or already asleep).` : ""),
          slept ? "added" : "dim"
        );
        return;
      }
      case "mv": {
        const target = args.filter(arg => arg != "-f").join(" ").toLowerCase();
        if (!target) {
          throw new Error("usage: … | mv <space name>");
        }
        const spaces = this.window.gZenWorkspaces.getWorkspaces();
        const space =
          spaces.find(s => s.name.toLowerCase() == target) ||
          spaces.find(s => s.name.toLowerCase().startsWith(target));
        if (!space) {
          throw new Error(`mv: no space called "${target}". Spaces: ${spaces.map(s => s.name).join(", ")}`);
        }
        const list = tabs.filter(item => !item.essential);
        if (this.#needsForce(`move to ${space.name}`, list, args, line)) {
          return;
        }
        this.window.gZenWorkspaces.moveTabsToWorkspace(
          list.map(item => item.ref),
          space.uuid
        );
        this.#print(`Moved ${plural(list.length, "tab")} to ${space.name}.`, "added");
        return;
      }
    }
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
      this.#print("usage: checkout <branch|commit|time> [-f]", "error");
      return;
    }
    const when = rest.join(" ");
    const { repo, space } = await ZenGitManager.activeSpaceRepo(this.window);
    const isRev = !!(await repo.revKind(rest[0]));
    // "the week I planned Tokyo" has a time word in it but is a description.
    if (
      !isRev &&
      lazy.AIModel.looksLikeDescription(rest) &&
      !lazy.AIModel.isJustATime(when)
    ) {
      const found = await this.#findCommit(repo, space, when);
      if (!found) {
        return;
      }
      rest.splice(0, rest.length, found);
    } else if (!isRev && looksLikeTime(when)) {
      const travelled = await ZenGitManager.travel(this.window, when, { force });
      this.#print(
        `${travelled.space.name} is back the way it was on ${travelled.date}. ` +
          "`commit` keeps it, `checkout -f <branch>` goes back.",
        "added"
      );
      this.#printResult(travelled);
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
