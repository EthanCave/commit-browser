/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import { ZenGitRepo } from "./ZenGitRepo.sys.mjs";
import {
  buildSnapshot,
  computeStatus,
  isClean,
  planCheckout,
  summarize,
  summarizePlan,
} from "./ZenGitModel.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  SessionStore:
    "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
});

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "repoPathPref",
  "zen.git.repo-path",
  ""
);

// Observer topic sent to every window when tab statuses change.
export const STATUS_CHANGED_TOPIC = "zen-git-status-changed";

// GUI apps on macOS start with a minimal PATH, so add the usual places
// git, gh and credential helpers live.
const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

const ioFs = {
  join: (...parts) => PathUtils.join(...parts),
  exists: path => IOUtils.exists(path),
  read: path => IOUtils.readUTF8(path),
  async write(path, text) {
    await IOUtils.makeDirectory(PathUtils.parent(path), {
      createAncestors: true,
      ignoreExisting: true,
    });
    await IOUtils.writeUTF8(path, text);
  },
  remove: path => IOUtils.remove(path, { ignoreAbsent: true }),
  mkdir: path =>
    IOUtils.makeDirectory(path, {
      createAncestors: true,
      ignoreExisting: true,
    }),
  async list(dir) {
    if (!(await IOUtils.exists(dir))) {
      return [];
    }
    return (await IOUtils.getChildren(dir)).map(child =>
      PathUtils.filename(child)
    );
  },
};

class nsZenGitManager {
  #repo = null;
  #gitPath = null;
  #head = undefined; // undefined = not loaded yet, null = no commits
  #status = null;
  #refreshTimer = null;
  #busy = Promise.resolve();

  get repoDir() {
    return (
      lazy.repoPathPref || PathUtils.join(PathUtils.profileDir, "zen-layouts")
    );
  }

  get repo() {
    if (!this.#repo || this.#repo.dir !== this.repoDir) {
      this.#repo = new ZenGitRepo({
        dir: this.repoDir,
        exec: (args, cwd) => this.#exec(args, cwd),
        fs: ioFs,
      });
      this.#head = undefined;
    }
    return this.#repo;
  }

  /** @returns {object|null} The latest computed status, if any. */
  get status() {
    return this.#status;
  }

  get hasHead() {
    return !!this.#head;
  }

  async #findGit() {
    if (this.#gitPath) {
      return this.#gitPath;
    }
    const path = EXTRA_PATH.join(":");
    try {
      this.#gitPath = await lazy.Subprocess.pathSearch("git", {
        PATH: path,
      });
    } catch {
      throw new Error(
        "git was not found. Install it (xcode-select --install) and try again."
      );
    }
    return this.#gitPath;
  }

  async #exec(args, cwd) {
    const command = await this.#findGit();
    await IOUtils.makeDirectory(cwd, {
      createAncestors: true,
      ignoreExisting: true,
    });
    const proc = await lazy.Subprocess.call({
      command,
      arguments: args,
      workdir: cwd,
      stderr: "stdout",
      environmentAppend: true,
      environment: {
        PATH: EXTRA_PATH.join(":"),
        // Fail instead of waiting for a password prompt nobody can see.
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    proc.stdin.close();
    let output = "";
    let chunk;
    while ((chunk = await proc.stdout.readString())) {
      output += chunk;
    }
    const { exitCode } = await proc.wait();
    return { exitCode, output };
  }

  /**
   * Runs tasks one at a time so two commits never race.
   *
   * @param {Function} task
   * @returns {Promise<any>}
   */
  #serialize(task) {
    const run = this.#busy.then(task, task);
    this.#busy = run.catch(() => {});
    return run;
  }

  /**
   * Reads the live sidebar of a window in the same shape Zen's session
   * store uses, so the model can treat both alike.
   *
   * @param {Window} window
   * @returns {object}
   */
  collectSidebar(window) {
    const tabs = [];
    for (const tab of window.gZenWorkspaces.allStoredTabs) {
      let tabData = {};
      try {
        tabData = JSON.parse(lazy.SessionStore.getTabState(tab));
      } catch {
        /* fall back to what the element itself tells us */
      }
      const liveUrl = tab.linkedBrowser?.currentURI?.spec;
      // Pending (not yet loaded) tabs report about:blank; keep the stored entry.
      if (liveUrl && liveUrl !== "about:blank") {
        tabData.entries = [{ url: liveUrl, title: tab.label }];
        tabData.index = 1;
      }
      tabs.push({
        ...tabData,
        zenSyncId: tab.id,
        zenWorkspace: tab.getAttribute("zen-workspace-id"),
        zenEssential: tab.hasAttribute("zen-essential"),
        zenIsEmpty: tab.hasAttribute("zen-empty-tab"),
        zenIsGlance: tab.hasAttribute("zen-glance-tab"),
        pinned: tab.pinned,
        groupId: tab.group?.id || null,
      });
    }
    return {
      spaces: window.gZenWorkspaces.getWorkspaces(),
      folders: window.gZenFolders?.storeDataForSessionStore() || [],
      tabs,
    };
  }

  /**
   * @param {Window} window
   * @returns {Promise<object>} Snapshot of the window's current layout.
   */
  async currentSnapshot(window) {
    const ignoreRules = await this.repo.readIgnoreRules();
    return buildSnapshot(this.collectSidebar(window), { ignoreRules });
  }

  async #loadHead() {
    if (this.#head === undefined) {
      this.#head = await this.repo.readSnapshot("HEAD");
    }
    return this.#head;
  }

  /**
   * Recomputes statuses soon, coalescing bursts of tab events.
   *
   * @param {Window} window
   */
  scheduleRefresh(window) {
    if (this.#refreshTimer) {
      return;
    }
    this.#refreshTimer = window.setTimeout(() => {
      this.#refreshTimer = null;
      this.refresh(window).catch(console.error);
    }, 250);
  }

  /**
   * @param {Window} window
   * @returns {Promise<object>} The fresh status.
   */
  refresh(window) {
    return this.#serialize(() => this.#refreshNow(window));
  }

  async #refreshNow(window) {
    const head = await this.#loadHead();
    const current = await this.currentSnapshot(window);
    this.#status = computeStatus(current, head);
    Services.obs.notifyObservers(null, STATUS_CHANGED_TOPIC);
    return this.#status;
  }

  async #requireClean(window, force, what) {
    if (force) {
      return;
    }
    const status = await this.#refreshNow(window);
    if (!isClean(status)) {
      throw new Error(
        `${what}: your tabs have changes since the last commit (${summarize(status)}). ` +
          "Commit or stash them first, or add -f to discard them."
      );
    }
  }

  /**
   * Restores a branch or commit, like `git checkout`.
   *
   * A branch is switched to, so later commits land on it. A commit's layout
   * is restored onto the current branch, leaving it to be committed, which
   * avoids git's detached HEAD.
   *
   * @param {Window} window
   * @param {string} rev
   * @param {{force?: boolean}} [options]
   * @returns {Promise<{kind: string, summary: string, warnings: string[]}>}
   */
  checkout(window, rev, { force = false } = {}) {
    return this.#serialize(async () => {
      const kind = await this.repo.revKind(rev);
      if (!kind) {
        throw new Error(
          `checkout: '${rev}' is not a branch or commit. See \`branch\` and \`log\`.`
        );
      }
      await this.#requireClean(window, force, "checkout");
      let target;
      if (kind === "branch") {
        await this.repo.resetWorkingTree();
        await this.repo.git("switch", "-q", rev);
        this.#head = undefined;
        target = await this.#loadHead();
      } else {
        target = await this.repo.readSnapshot(rev);
      }
      const result = await this.#apply(window, target);
      await this.#refreshNow(window);
      return { kind, ...result };
    });
  }

  /**
   * Creates a branch at the current commit and switches to it. Tabs are
   * left as they are, like `git switch -c`.
   *
   * @param {string} name
   */
  createBranch(name) {
    return this.#serialize(async () => {
      if (!(await this.repo.hasCommits())) {
        throw new Error("Commit a layout first, then branch from it.");
      }
      await this.repo.resetWorkingTree();
      await this.repo.git("switch", "-q", "-c", name);
      this.#head = undefined;
    });
  }

  /**
   * Saves uncommitted tab changes and puts the sidebar back to the last
   * commit, like `git stash`.
   *
   * @param {Window} window
   * @param {string} [message]
   * @returns {Promise<{summary: string, warnings: string[]}|null>} null
   *   when there was nothing to stash.
   */
  stash(window, message) {
    return this.#serialize(async () => {
      const head = await this.#loadHead();
      if (!head) {
        throw new Error("stash: commit a layout first.");
      }
      const status = await this.#refreshNow(window);
      if (isClean(status)) {
        return null;
      }
      const current = await this.currentSnapshot(window);
      const label = message || `WIP: ${summarize(status)}`;
      await this.repo.resetWorkingTree();
      if (!(await this.repo.stashPush(current, label))) {
        return null;
      }
      const result = await this.#apply(window, head);
      await this.#refreshNow(window);
      return result;
    });
  }

  /**
   * Restores the newest stashed layout and drops it, like `git stash pop`.
   *
   * @param {Window} window
   * @param {{force?: boolean, ref?: string}} [options]
   */
  stashPop(window, { force = false, ref = "stash@{0}" } = {}) {
    return this.#serialize(async () => {
      if (!(await this.repo.stashList()).length) {
        throw new Error("stash pop: no stashed layouts.");
      }
      await this.#requireClean(window, force, "stash pop");
      const snapshot = await this.repo.readStash(ref);
      const result = await this.#apply(window, snapshot);
      await this.repo.git("stash", "drop", "-q", ref);
      await this.#refreshNow(window);
      return result;
    });
  }

  /**
   * Makes the window's sidebar match a snapshot.
   *
   * @param {Window} window
   * @param {object} target
   * @returns {Promise<{summary: string, warnings: string[]}>}
   */
  async #apply(window, target) {
    const { document, gBrowser, gZenWorkspaces } = window;
    const current = await this.currentSnapshot(window);
    const plan = planCheckout(current, target);
    const warnings = [];
    const principal = Services.scriptSecurityManager.getSystemPrincipal();
    const startSpace = gZenWorkspaces.activeWorkspace;

    // Spaces that no longer exist are matched by name, else recreated.
    // Recreated spaces get a new id, which shows up as a change to commit.
    const spaceIds = new Map();
    for (const space of plan.createSpaces) {
      const sameName = gZenWorkspaces
        .getWorkspaces()
        .find(live => live.name === space.name);
      if (sameName) {
        spaceIds.set(space.id, sameName.uuid);
        continue;
      }
      try {
        const created = await gZenWorkspaces.createAndSaveWorkspace(
          space.name,
          space.icon || undefined
        );
        spaceIds.set(space.id, created.uuid);
      } catch (e) {
        warnings.push(`could not recreate space "${space.name}": ${e.message}`);
      }
    }
    const spaceFor = id =>
      spaceIds.get(id) || id || gZenWorkspaces.activeWorkspace;

    for (const folder of plan.createFolders) {
      try {
        window.gZenFolders.createFolder([], {
          id: folder.id,
          label: folder.name,
          workspaceId: spaceFor(folder.spaceId),
        });
      } catch (e) {
        warnings.push(
          `could not recreate folder "${folder.name}": ${e.message}`
        );
      }
    }

    for (const tabInfo of plan.open) {
      let tab = document.getElementById(tabInfo.id);
      if (tab) {
        // Open but left out of snapshots (e.g. on an ignored site).
        this.#navigate(tab, tabInfo.url, principal);
      } else {
        tab = gBrowser.addTab(tabInfo.url, {
          triggeringPrincipal: principal,
          createLazyBrowser: true,
          skipAnimation: true,
          inBackground: true,
        });
        tab.setAttribute("id", tabInfo.id);
        try {
          gBrowser.setInitialTabTitle(tab, tabInfo.title, {
            isContentTitle: true,
          });
        } catch {
          /* the URL stays as the title until the tab loads */
        }
      }
      this.#place(window, tab, tabInfo, spaceFor, warnings);
    }

    for (const { tab: tabInfo, changes } of plan.update) {
      const tab = document.getElementById(tabInfo.id);
      if (!tab) {
        continue;
      }
      if (changes.includes("url")) {
        this.#navigate(tab, tabInfo.url, principal);
      }
      if (changes.some(c => c !== "url")) {
        this.#place(window, tab, tabInfo, spaceFor, warnings);
      }
    }

    const closing = plan.close
      .map(info => document.getElementById(info.id))
      .filter(Boolean);
    if (closing.length) {
      gBrowser.removeTabs(closing, { animate: false });
    }

    if (
      startSpace &&
      gZenWorkspaces.activeWorkspace !== startSpace &&
      gZenWorkspaces.getWorkspaces().some(s => s.uuid === startSpace)
    ) {
      await gZenWorkspaces.changeWorkspaceWithID(startSpace);
    }
    return { summary: summarizePlan(plan), warnings };
  }

  #navigate(tab, url, principal) {
    tab.linkedBrowser.fixupAndLoadURIString(url, {
      triggeringPrincipal: principal,
    });
  }

  /**
   * Puts a tab in its space, folder, essentials and pinned state.
   */
  #place(window, tab, info, spaceFor, warnings) {
    const { gBrowser, gZenWorkspaces, gZenPinnedTabManager, document } = window;
    try {
      if (info.essential) {
        if (!tab.hasAttribute("zen-essential")) {
          gZenPinnedTabManager.addToEssentials(tab);
        }
        return;
      }
      if (tab.hasAttribute("zen-essential")) {
        gZenPinnedTabManager.removeEssentials(tab, !info.pinned);
      }

      const folder = info.folderId
        ? document.getElementById(info.folderId)
        : null;
      if (info.folderId && !folder?.isZenFolder) {
        warnings.push(`"${info.title}": its folder is gone, left loose`);
      }
      if (tab.group && tab.group !== folder && tab.group.isZenFolder) {
        gBrowser.ungroupTab(tab);
      }

      // Folder tabs are always pinned in Zen.
      const wantPinned = info.pinned || !!folder?.isZenFolder;
      if (wantPinned && !tab.pinned) {
        gBrowser.pinTab(tab);
      } else if (!wantPinned && tab.pinned) {
        gBrowser.unpinTab(tab);
      }

      gZenWorkspaces.moveTabToWorkspace(tab, spaceFor(info.spaceId));
      if (folder?.isZenFolder && tab.group !== folder) {
        folder.addTabs([tab]);
      }
    } catch (e) {
      warnings.push(`"${info.title}": ${e.message}`);
    }
  }

  /**
   * @param {Window} window
   * @param {string} message
   * @returns {Promise<string|null>} Short hash, or null when nothing changed.
   */
  commit(window, message) {
    return this.#serialize(async () => {
      const snapshot = await this.currentSnapshot(window);
      const hash = await this.repo.commit(snapshot, message);
      this.#head = await this.repo.readSnapshot("HEAD");
      this.#status = computeStatus(snapshot, this.#head);
      Services.obs.notifyObservers(null, STATUS_CHANGED_TOPIC);
      return hash;
    });
  }

  /**
   * Runs an arbitrary git command in the layouts repo (push, pull, remote…).
   * The cached HEAD is dropped because the command may have moved it.
   *
   * @param {string[]} args
   * @returns {Promise<{exitCode: number, output: string}>}
   */
  runGit(args) {
    return this.#serialize(async () => {
      await this.repo.ensureInit();
      const result = await this.repo.tryGit(...args);
      this.#head = undefined;
      return result;
    });
  }

  /** @returns {Window|null} The most recently focused browser window. */
  get topWindow() {
    return lazy.BrowserWindowTracker.getTopWindow();
  }
}

export const ZenGitManager = new nsZenGitManager();
