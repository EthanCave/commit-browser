/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import { ZenGitRepo } from "./ZenGitRepo.sys.mjs";
import { buildSnapshot, computeStatus } from "./ZenGitModel.sys.mjs";

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
    return this.#serialize(async () => {
      const head = await this.#loadHead();
      const current = await this.currentSnapshot(window);
      this.#status = computeStatus(current, head);
      Services.obs.notifyObservers(null, STATUS_CHANGED_TOPIC);
      return this.#status;
    });
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
