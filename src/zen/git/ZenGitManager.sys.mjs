/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import { ZenGitRepo } from "./ZenGitRepo.sys.mjs";
import {
  DEFAULT_SPACE_BRANCH,
  ESSENTIALS_BRANCH_PREFIX,
  ESSENTIALS_CODEC,
  SETTINGS_BRANCH_PREFIX,
  SETTINGS_CODEC,
  SPACE_BRANCH_ROOT,
  SPACE_FILE,
  buildSnapshot,
  computeStatus,
  essentialsSnapshot,
  isClean,
  mergeStatuses,
  normalizeSettings,
  planCheckout,
  retargetSpace,
  slugify,
  spaceBranchPrefix,
  spaceCodec,
  spaceSnapshot,
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

// Each space's worktree lives in <repo>/.spaces/<slug>, and Essentials' in
// <repo>/.spaces/@essentials ("@" never appears in a slug).
const WORKTREES_DIR = ".spaces";
const ESSENTIALS_KEY = "@essentials";
const SETTINGS_KEY = "@settings";

function hasContent(snapshot) {
  return !!(
    snapshot?.essentials?.length ||
    snapshot?.spaces?.some(s => s.tabs.length || s.folders.length)
  );
}

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
  #spaceRepos = new Map(); // slug -> ZenGitRepo for that space's worktree
  #ready = new Set(); // slugs whose worktree has been checked this session
  #heads = new Map(); // slug -> last committed snapshot (null: no commits)
  #slugs = null; // space uuid -> slug, kept in .git/zen-spaces.json
  #sharedReady = null; // repo dir once it is set up
  #status = null; // every space's status merged, for the dots
  #statusBySpace = new Map(); // space uuid -> status
  #essentialsStatus = null;
  #refreshTimer = null;
  #busy = Promise.resolve();

  get repoDir() {
    return (
      lazy.repoPathPref || PathUtils.join(PathUtils.profileDir, "zen-layouts")
    );
  }

  /**
   * The shared repository: remotes, .browserignore and every space's
   * branches live here. Each space works in its own worktree under
   * .spaces/<slug> (see spaceRepoFor).
   */
  get repo() {
    if (!this.#repo || this.#repo.dir !== this.repoDir) {
      this.#repo = new ZenGitRepo({
        dir: this.repoDir,
        exec: (args, cwd) => this.#exec(args, cwd),
        fs: ioFs,
      });
      this.#spaceRepos.clear();
      this.#ready.clear();
      this.#heads.clear();
      this.#slugs = null;
    }
    return this.#repo;
  }

  /** @returns {object|null} The latest status of every space, merged. */
  get status() {
    return this.#status;
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
   * @returns {Promise<object>} Snapshot of the whole window's current layout.
   */
  async currentSnapshot(window) {
    const ignoreRules = await this.repo.readIgnoreRules();
    return buildSnapshot(this.collectSidebar(window), { ignoreRules });
  }

  // -------------------------------------------------------------------------
  // Spaces and their worktrees

  /**
   * @param {Window} window
   * @returns {object} The space the window is showing (a Zen workspace).
   */
  activeSpace(window) {
    const space = window.gZenWorkspaces.getActiveWorkspaceFromCache();
    if (!space) {
      throw new Error("No space is active in this window.");
    }
    return space;
  }

  #live(space) {
    return { id: space.uuid, name: space.name, icon: space.icon ?? null };
  }

  get #slugFile() {
    return PathUtils.join(this.repoDir, ".git", "zen-spaces.json");
  }

  /**
   * A space's slug names its branches (spaces/<slug>/...) and worktree. It
   * comes from the space's name, so the same space on another computer (with
   * another id) finds the same branches, and is remembered per id here so
   * renaming a space keeps its history.
   *
   * @param {object} space
   * @returns {Promise<string>}
   */
  async #slugFor(space) {
    if (!this.#slugs) {
      try {
        this.#slugs = JSON.parse(await IOUtils.readUTF8(this.#slugFile));
      } catch {
        this.#slugs = {};
      }
    }
    if (this.#slugs[space.uuid]) {
      return this.#slugs[space.uuid];
    }
    const taken = new Set(Object.values(this.#slugs));
    let slug = slugify(space.name);
    if (taken.has(slug)) {
      slug = `${slug}-${String(space.uuid).replace(/[^a-z0-9]/gi, "").slice(0, 6)}`;
    }
    this.#slugs[space.uuid] = slug;
    await IOUtils.writeUTF8(this.#slugFile, JSON.stringify(this.#slugs, null, 2));
    return slug;
  }

  async #ensureShared() {
    const shared = this.repo;
    if (this.#sharedReady === shared.dir && (await shared.isRepo())) {
      return;
    }
    await shared.ensureInit();
    await shared.excludeLocally(`${WORKTREES_DIR}/`);
    this.#sharedReady = shared.dir;
  }

  /**
   * The repo a space commits to: its own worktree, checked out on one of
   * its branches. Created on first use, starting from the space's part of
   * the whole-window layout that was committed before (if any), or from a
   * branch pulled from GitHub.
   *
   * @param {object} space
   * @returns {Promise<{repo: ZenGitRepo, slug: string}>}
   */
  async #spaceRepo(space) {
    await this.#ensureShared();
    const slug = await this.#slugFor(space);
    const repo = await this.#tracked(slug, {
      codec: spaceCodec(slug),
      branchPrefix: spaceBranchPrefix(slug),
      branch: () => this.#defaultBranch(slug),
    });
    return { repo, slug };
  }

  /**
   * The repo shared settings commit to (settings/main), such as each space's
   * default branch.
   *
   * @returns {Promise<ZenGitRepo>}
   */
  async #settingsRepo() {
    await this.#ensureShared();
    return this.#tracked(SETTINGS_KEY, {
      codec: SETTINGS_CODEC,
      branchPrefix: SETTINGS_BRANCH_PREFIX,
    });
  }

  async #settings() {
    const repo = await this.#settingsRepo();
    if (!this.#heads.has(SETTINGS_KEY)) {
      this.#heads.set(SETTINGS_KEY, await repo.readSnapshot("HEAD"));
    }
    return normalizeSettings(this.#heads.get(SETTINGS_KEY));
  }

  /**
   * @param {string} slug
   * @returns {Promise<string>} The space's default branch ("main" unless set).
   */
  async #defaultBranch(slug) {
    return (await this.#settings()).defaults[slug] || DEFAULT_SPACE_BRANCH;
  }

  /**
   * Checks the space's default branch out in its worktree, fetching it from
   * GitHub's copy when it is not here yet.
   *
   * @returns {Promise<boolean>} Whether the worktree moved to it.
   */
  async #useDefault(repo, slug) {
    const target = await this.#defaultBranch(slug);
    if ((await repo.currentBranch()) === target) {
      return false;
    }
    const full = repo.fullBranch(target);
    const shared = this.repo;
    if (!(await shared.hasBranch(full))) {
      const remote = await shared.tryGit(
        "show-ref",
        "--verify",
        "-q",
        `refs/remotes/origin/${full}`
      );
      if (remote.exitCode) {
        return false;
      }
      await shared.git("branch", "-q", "--track", full, `origin/${full}`);
    }
    if (await repo.hasCommits()) {
      await repo.resetWorkingTree();
    }
    await repo.git("switch", "-q", full);
    this.#heads.delete(slug);
    return true;
  }

  /**
   * The repo Essentials commit to (essentials/<branch>).
   *
   * @returns {Promise<ZenGitRepo>}
   */
  async #essentialsRepo() {
    await this.#ensureShared();
    return this.#tracked(ESSENTIALS_KEY, {
      codec: ESSENTIALS_CODEC,
      branchPrefix: ESSENTIALS_BRANCH_PREFIX,
    });
  }

  async #tracked(key, { codec, branchPrefix, branch = null }) {
    let repo = this.#spaceRepos.get(key);
    if (!repo) {
      repo = new ZenGitRepo({
        dir: PathUtils.join(this.repoDir, WORKTREES_DIR, key),
        exec: (args, cwd) => this.#exec(args, cwd),
        fs: ioFs,
        codec,
        branchPrefix,
      });
      this.#spaceRepos.set(key, repo);
    }
    if (!this.#ready.has(key)) {
      await this.#ensureWorktree(
        repo,
        codec,
        branch ? await branch() : DEFAULT_SPACE_BRANCH
      );
      this.#ready.add(key);
    }
    return repo;
  }

  async #ensureWorktree(repo, codec, preferred) {
    if (await repo.isRepo()) {
      return;
    }
    const shared = this.repo;
    const exists = async name =>
      (await shared.hasBranch(name)) ||
      (
        await shared.tryGit(
          "show-ref",
          "--verify",
          "-q",
          `refs/remotes/origin/${name}`
        )
      ).exitCode === 0;
    let branch = repo.fullBranch(preferred);
    if (preferred !== DEFAULT_SPACE_BRANCH && !(await exists(branch))) {
      branch = repo.fullBranch(DEFAULT_SPACE_BRANCH);
    }
    if (!(await shared.hasBranch(branch)) && (await exists(branch))) {
      await shared.git("branch", "-q", "--track", branch, `origin/${branch}`);
    }
    const kind = await shared.addWorktree(repo.dir, branch);
    if (kind === "orphan") {
      // Start from what the older whole-window layout had for it.
      const legacy = await new ZenGitRepo({
        dir: shared.dir,
        exec: (args, cwd) => this.#exec(args, cwd),
        fs: ioFs,
        codec,
      }).readSnapshot("HEAD");
      if (hasContent(legacy)) {
        await repo.commit(legacy, "Start from the whole-window layout");
      }
    }
  }

  async #headFor(space, repo, slug) {
    if (!this.#heads.has(slug)) {
      this.#heads.set(slug, await repo.readSnapshot("HEAD"));
    }
    const head = this.#heads.get(slug);
    return head ? retargetSpace(head, this.#live(space)) : null;
  }

  async #essentialsHead(repo) {
    if (!this.#heads.has(ESSENTIALS_KEY)) {
      this.#heads.set(ESSENTIALS_KEY, await repo.readSnapshot("HEAD"));
    }
    return this.#heads.get(ESSENTIALS_KEY);
  }

  #forgetHeads() {
    this.#heads.clear();
  }

  /**
   * The active space's repo, for read-only console commands (log, branch).
   *
   * @param {Window} window
   * @returns {Promise<{repo: ZenGitRepo, space: object, slug: string}>}
   */
  activeSpaceRepo(window) {
    return this.#serialize(async () => {
      const space = this.activeSpace(window);
      return { space, ...(await this.#spaceRepo(space)) };
    });
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
   * @returns {Promise<object>} Every space's status, merged.
   */
  refresh(window) {
    return this.#serialize(() => this.#refreshNow(window));
  }

  /**
   * @param {Window} window
   * @returns {Promise<{status: object, hasHead: boolean, space: object, branch: string|null, essentials: {status: object, hasHead: boolean}}>}
   *   The active space's status, and Essentials'.
   */
  spaceStatus(window) {
    return this.#serialize(async () => {
      await this.#refreshNow(window);
      const space = this.activeSpace(window);
      const { repo, slug } = await this.#spaceRepo(space);
      const essentialsRepo = await this.#essentialsRepo();
      return {
        status: this.#statusBySpace.get(space.uuid),
        hasHead: !!(await this.#headFor(space, repo, slug)),
        space,
        branch: await repo.currentBranch(),
        essentials: {
          status: this.#essentialsStatus,
          hasHead: !!(await this.#essentialsHead(essentialsRepo)),
        },
      };
    });
  }

  async #refreshNow(window) {
    const full = await this.currentSnapshot(window);
    const statuses = new Map();
    for (const space of window.gZenWorkspaces.getWorkspaces()) {
      const { repo, slug } = await this.#spaceRepo(space);
      const head = await this.#headFor(space, repo, slug);
      statuses.set(
        space.uuid,
        computeStatus(spaceSnapshot(full, space.uuid), head)
      );
    }
    const essentialsRepo = await this.#essentialsRepo();
    this.#essentialsStatus = computeStatus(
      essentialsSnapshot(full),
      await this.#essentialsHead(essentialsRepo)
    );
    this.#statusBySpace = statuses;
    this.#status = mergeStatuses([
      ...statuses.values(),
      this.#essentialsStatus,
    ]);
    Services.obs.notifyObservers(null, STATUS_CHANGED_TOPIC);
    return this.#status;
  }

  async #activeStatus(window) {
    await this.#refreshNow(window);
    return this.#statusBySpace.get(this.activeSpace(window).uuid);
  }

  async #requireClean(window, force, what) {
    if (force) {
      return;
    }
    const status = await this.#activeStatus(window);
    if (!isClean(status)) {
      throw new Error(
        `${what}: this space has changes since its last commit (${summarize(status)}). ` +
          "Commit or stash them first, or add -f to discard them."
      );
    }
  }

  async #currentSpaceSnapshot(window, space) {
    return spaceSnapshot(await this.currentSnapshot(window), space.uuid);
  }

  /**
   * Restores one of the active space's branches or commits, like
   * `git checkout`. Other spaces are left alone.
   *
   * A branch is switched to, so later commits land on it. A commit's layout
   * is restored onto the current branch, leaving it to be committed, which
   * avoids git's detached HEAD.
   *
   * @param {Window} window
   * @param {string} rev
   * @param {{force?: boolean}} [options]
   * @returns {Promise<{kind: string, summary: string, warnings: string[], branch: string|null}>}
   */
  checkout(window, rev, { force = false } = {}) {
    return this.#serialize(async () => {
      const space = this.activeSpace(window);
      const { repo, slug } = await this.#spaceRepo(space);
      const kind = await repo.revKind(rev);
      if (!kind) {
        throw new Error(
          `checkout: '${rev}' is not a branch or commit of this space. See \`branch\` and \`log\`.`
        );
      }
      await this.#requireClean(window, force, "checkout");
      let target;
      if (kind === "branch") {
        await repo.resetWorkingTree();
        await repo.git("switch", "-q", repo.fullBranch(rev));
        this.#heads.delete(slug);
        target = await this.#headFor(space, repo, slug);
      } else {
        const stored = await repo.readSnapshot(rev);
        if (!stored) {
          throw new Error(
            `checkout: ${rev} has no layout for the space "${space.name}".`
          );
        }
        target = retargetSpace(stored, this.#live(space));
      }
      const result = await this.#apply(
        window,
        await this.#currentSpaceSnapshot(window, space),
        target
      );
      await this.#refreshNow(window);
      return { kind, ...result, branch: await repo.currentBranch() };
    });
  }

  /**
   * Creates a branch of the active space at its current commit and switches
   * to it. Tabs are left as they are, like `git switch -c`.
   *
   * @param {Window} window
   * @param {string} name
   */
  createBranch(window, name) {
    return this.#serialize(async () => {
      const space = this.activeSpace(window);
      const { repo, slug } = await this.#spaceRepo(space);
      if (!(await repo.hasCommits())) {
        throw new Error(
          `Commit "${space.name}" first, then branch from it.`
        );
      }
      await repo.resetWorkingTree();
      await repo.git("switch", "-q", "-c", repo.fullBranch(name));
      this.#heads.delete(slug);
    });
  }

  /**
   * Saves the active space's uncommitted tab changes and puts it back to its
   * last commit, like `git stash`.
   *
   * @param {Window} window
   * @param {string} [message]
   * @returns {Promise<{summary: string, warnings: string[]}|null>} null
   *   when there was nothing to stash.
   */
  stash(window, message) {
    return this.#serialize(async () => {
      const space = this.activeSpace(window);
      const { repo, slug } = await this.#spaceRepo(space);
      const head = await this.#headFor(space, repo, slug);
      if (!head) {
        throw new Error(`stash: commit "${space.name}" first.`);
      }
      const status = await this.#activeStatus(window);
      if (isClean(status)) {
        return null;
      }
      const current = await this.#currentSpaceSnapshot(window, space);
      const label = message || `WIP: ${summarize(status)}`;
      await repo.resetWorkingTree();
      if (!(await repo.stashPush(current, label))) {
        return null;
      }
      const result = await this.#apply(
        window,
        await this.#currentSpaceSnapshot(window, space),
        head
      );
      await this.#refreshNow(window);
      return result;
    });
  }

  /**
   * Restores the active space's newest stashed layout (or `ref`) and drops
   * it, like `git stash pop`.
   *
   * @param {Window} window
   * @param {{force?: boolean, ref?: string}} [options]
   */
  stashPop(window, { force = false, ref = null } = {}) {
    return this.#serialize(async () => {
      const space = this.activeSpace(window);
      const { repo } = await this.#spaceRepo(space);
      const entries = await repo.stashList();
      if (!entries.length) {
        throw new Error(`stash pop: "${space.name}" has no stashed layouts.`);
      }
      ref ||= entries[0].ref;
      if (!entries.some(entry => entry.ref === ref)) {
        throw new Error(`stash pop: ${ref} is not one of this space's stashes.`);
      }
      await this.#requireClean(window, force, "stash pop");
      const stored = await repo.readStash(ref);
      const result = await this.#apply(
        window,
        await this.#currentSpaceSnapshot(window, space),
        retargetSpace(stored, this.#live(space))
      );
      await repo.git("stash", "drop", "-q", ref);
      await this.#refreshNow(window);
      return result;
    });
  }

  /**
   * Makes part of the sidebar (one space, or Essentials) match a snapshot of
   * that same part. Tabs outside it are not touched, except a tab the
   * snapshot wants here that has since moved elsewhere, which is moved back.
   *
   * @param {Window} window
   * @param {object} current The live snapshot of that part.
   * @param {object} target
   * @returns {Promise<{summary: string, warnings: string[]}>}
   */
  async #apply(window, current, target) {
    const { document, gBrowser, gZenWorkspaces } = window;
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
   * Commits the active space, and Essentials when they changed.
   *
   * @param {Window} window
   * @param {string} message
   * @returns {Promise<{hash: string|null, essentialsHash: string|null, branch: string|null, space: object}>}
   *   A hash is null when that part had nothing to commit.
   */
  commit(window, message) {
    return this.#serialize(async () => {
      const space = this.activeSpace(window);
      const { repo, slug } = await this.#spaceRepo(space);
      const full = await this.currentSnapshot(window);
      const hash = await repo.commit(spaceSnapshot(full, space.uuid), message);
      this.#heads.delete(slug);
      const essentialsRepo = await this.#essentialsRepo();
      const essentials = essentialsSnapshot(full);
      const essentialsHead = await this.#essentialsHead(essentialsRepo);
      let essentialsHash = null;
      if (!isClean(computeStatus(essentials, essentialsHead))) {
        essentialsHash = await essentialsRepo.commit(essentials, message);
        this.#heads.delete(ESSENTIALS_KEY);
      }
      await this.#refreshNow(window);
      return { hash, essentialsHash, branch: await repo.currentBranch(), space };
    });
  }

  /**
   * @param {Window} window
   * @returns {Promise<{space: object, branch: string}>} The active space's
   *   default branch.
   */
  defaultBranch(window) {
    return this.#serialize(async () => {
      const space = this.activeSpace(window);
      const { slug } = await this.#spaceRepo(space);
      return { space, branch: await this.#defaultBranch(slug) };
    });
  }

  /**
   * Makes a branch the active space's default: the one `clone` loads on a
   * new computer. Saved to settings/main, so `push` shares it.
   *
   * @param {Window} window
   * @param {string} name
   */
  setDefaultBranch(window, name) {
    return this.#serialize(async () => {
      const space = this.activeSpace(window);
      const { repo, slug } = await this.#spaceRepo(space);
      if ((await repo.revKind(name)) !== "branch") {
        throw new Error(
          `default: "${space.name}" has no branch '${name}'. See \`branch\`.`
        );
      }
      const settings = await this.#settings();
      if (settings.defaults[slug] === name) {
        return { space, changed: false };
      }
      if (name === DEFAULT_SPACE_BRANCH) {
        delete settings.defaults[slug];
      } else {
        settings.defaults[slug] = name;
      }
      const settingsRepo = await this.#settingsRepo();
      await settingsRepo.commit(
        settings,
        `Default branch of ${space.name}: ${name}`
      );
      this.#heads.delete(SETTINGS_KEY);
      return { space, changed: true };
    });
  }

  /**
   * @returns {Promise<ZenGitRepo>} The Essentials repo, for `essentials log`.
   */
  essentialsRepo() {
    return this.#serialize(() => this.#essentialsRepo());
  }

  /**
   * Puts Essentials back to their last commit (after a pull, or to undo).
   *
   * @param {Window} window
   * @param {{force?: boolean}} [options]
   */
  resetEssentials(window, { force = false } = {}) {
    return this.#serialize(async () => {
      const repo = await this.#essentialsRepo();
      const head = await this.#essentialsHead(repo);
      if (!head) {
        throw new Error("Essentials have no commits yet. `commit` saves them.");
      }
      await this.#refreshNow(window);
      if (!force && !isClean(this.#essentialsStatus)) {
        throw new Error(
          `Essentials changed since their last commit (${summarize(this.#essentialsStatus)}). ` +
            "Commit first, or add -f to discard the changes."
        );
      }
      const current = essentialsSnapshot(await this.currentSnapshot(window));
      const result = await this.#apply(window, current, head);
      await this.#refreshNow(window);
      return result;
    });
  }

  /**
   * Runs an arbitrary git command in the active space's worktree, so log,
   * branch and friends see that space's history. Remotes and config are
   * shared by every space.
   *
   * @param {Window} window
   * @param {string[]} args
   * @returns {Promise<{exitCode: number, output: string}>}
   */
  runGit(window, args) {
    return this.#serialize(async () => {
      const { repo } = await this.#spaceRepo(this.activeSpace(window));
      const result = await repo.tryGit(...args);
      this.#forgetHeads();
      return result;
    });
  }

  /**
   * Pushes every space's branches, Essentials and settings to origin and
   * makes each track its copy there, so a later `pull` (here or on another
   * computer) finds them.
   *
   * @returns {Promise<{exitCode: number, output: string}>}
   */
  pushAll() {
    return this.#serialize(async () => {
      const shared = this.repo;
      await this.#ensureShared();
      const roots = [
        SPACE_BRANCH_ROOT,
        ESSENTIALS_BRANCH_PREFIX,
        SETTINGS_BRANCH_PREFIX,
      ].map(
        root => `refs/heads/${root}/`
      );
      const result = await shared.tryGit(
        "push",
        "origin",
        ...roots.map(root => `${root}*:${root}*`)
      );
      if (result.exitCode === 0) {
        const branches = (
          await shared.git("for-each-ref", "--format=%(refname:short)", ...roots)
        )
          .split("\n")
          .filter(Boolean);
        for (const branch of branches) {
          await shared.tryGit(
            "branch",
            "-q",
            `--set-upstream-to=origin/${branch}`,
            branch
          );
        }
      }
      return result;
    });
  }

  /**
   * Fast-forwards a repo's checked-out branch to origin's copy.
   *
   * @returns {Promise<"missing"|"same"|"updated"|"diverged">}
   */
  async #pullOne(repo) {
    const full = repo.fullBranch((await repo.currentBranch()) || "main");
    const remote = `origin/${full}`;
    const exists = await repo.tryGit(
      "show-ref",
      "--verify",
      "-q",
      `refs/remotes/${remote}`
    );
    if (exists.exitCode) {
      return { state: "missing", remote };
    }
    const result = (await repo.hasCommits())
      ? await repo.tryGit("merge", "--ff-only", remote)
      : await repo.tryGit("reset", "-q", "--hard", remote);
    await repo.tryGit("branch", "-q", `--set-upstream-to=${remote}`);
    if (result.exitCode) {
      return { state: "diverged", remote };
    }
    return {
      state: /up to date/i.test(result.output) ? "same" : "updated",
      remote,
    };
  }

  /**
   * Fetches from origin and fast-forwards every space and Essentials, like
   * running `git pull` in each. Spaces that only exist on GitHub are
   * created and empty spaces get their layout; spaces that already have
   * tabs are left alone (the dots show what differs, `checkout -f` loads it).
   *
   * With `setup` (the `clone` command, for a new computer) every space first
   * switches to its default branch, and GitHub's Essentials are added to
   * the ones here. With `force` as well, spaces that have tabs get their
   * default layout too and Essentials are replaced exactly.
   *
   * @param {Window} window
   * @param {{setup?: boolean, force?: boolean}} [options]
   * @returns {Promise<{lines: {text: string, kind: string}[]}>}
   */
  pullAll(window, { setup = false, force = false } = {}) {
    return this.#serialize(async () => {
      const shared = this.repo;
      const { gZenWorkspaces } = window;
      const startSpace = gZenWorkspaces.activeWorkspace;
      const lines = [];
      const say = (text, kind = "") => lines.push({ text, kind });

      // Set every worktree up before fetching, so a space that has never
      // committed here is told apart from one that came from GitHub.
      for (const space of gZenWorkspaces.getWorkspaces()) {
        await this.#spaceRepo(space);
      }
      const essentialsRepo = await this.#essentialsRepo();
      const essentialsHadHistory = await essentialsRepo.hasCommits();
      const settingsRepo = await this.#settingsRepo();

      const fetch = await shared.tryGit("fetch", "-q", "--prune", "origin");
      if (fetch.exitCode) {
        throw new Error(fetch.output.trim() || "git fetch failed");
      }
      // Settings first: they say which branch is each space's default.
      await this.#pullOne(settingsRepo);
      this.#heads.delete(SETTINGS_KEY);

      // Spaces that only exist on GitHub become spaces here.
      const liveSlugs = new Set();
      for (const space of gZenWorkspaces.getWorkspaces()) {
        liveSlugs.add(await this.#slugFor(space));
      }
      const refs = await shared.tryGit(
        "for-each-ref",
        "--format=%(refname:short)",
        `refs/remotes/origin/${SPACE_BRANCH_ROOT}/`
      );
      // slug -> its branches on GitHub
      const remoteSlugs = new Map();
      for (const ref of refs.output.split("\n").filter(Boolean)) {
        const [, , slug, ...rest] = ref.split("/");
        if (slug && rest.length) {
          remoteSlugs.set(slug, [...(remoteSlugs.get(slug) || []), rest.join("/")]);
        }
      }
      for (const [slug, branches] of remoteSlugs) {
        if (liveSlugs.has(slug)) {
          continue;
        }
        const preferred = await this.#defaultBranch(slug);
        const branch = branches.includes(preferred) ? preferred : branches[0];
        const ref = `origin/${spaceBranchPrefix(slug)}/${branch}`;
        let stored = {};
        try {
          stored = JSON.parse(await shared.git("show", `${ref}:${SPACE_FILE}`));
        } catch {
          /* fall back to the slug as its name */
        }
        try {
          const created = await gZenWorkspaces.createAndSaveWorkspace(
            stored.name || slug,
            stored.icon || undefined
          );
          this.#slugs[created.uuid] = slug;
          await IOUtils.writeUTF8(
            this.#slugFile,
            JSON.stringify(this.#slugs, null, 2)
          );
          say(`Added the space "${stored.name || slug}" from GitHub`, "added");
        } catch (e) {
          say(`Could not add the space "${stored.name || slug}": ${e.message}`, "error");
        }
      }

      const describe = (name, { state, remote }) => {
        switch (state) {
          case "missing":
            return [`${name}: not on GitHub yet (\`push\` sends it)`, "dim"];
          case "diverged":
            return [
              `${name}: both computers have new commits. Here, ` +
                `\`git reset --hard ${remote}\` keeps GitHub's, \`push -f\` keeps yours.`,
              "error",
            ];
          case "same":
            return [`${name}: up to date`, "dim"];
          default:
            return [`${name}: updated`, ""];
        }
      };

      const full = await this.currentSnapshot(window);
      const toLoad = [];
      for (const space of gZenWorkspaces.getWorkspaces()) {
        const { repo, slug } = await this.#spaceRepo(space);
        let label = space.name;
        if (setup) {
          await this.#useDefault(repo, slug);
          label = `${space.name} (${(await repo.currentBranch()) || "main"})`;
        }
        const result = await this.#pullOne(repo);
        say(...describe(label, result));
        this.#heads.delete(slug);
        const head = await this.#headFor(space, repo, slug);
        const current = spaceSnapshot(full, space.uuid);
        if (head && hasContent(head) && !isClean(computeStatus(current, head))) {
          if (!hasContent(current) || (setup && force)) {
            toLoad.push({ current, head, space });
          } else if (setup) {
            say(`  ${space.name} already has its own tabs, so they were left alone. \`clone -f\` replaces them.`, "dim");
          } else if (result.state === "updated") {
            const branch = (await repo.currentBranch()) || "main";
            say(`  ${space.name} has open tabs, so they were left alone. \`checkout -f ${branch}\` there loads GitHub's layout.`, "dim");
          }
        }
      }

      const essentialsResult = await this.#pullOne(essentialsRepo);
      say(...describe("Essentials", essentialsResult));
      this.#heads.delete(ESSENTIALS_KEY);
      const essentialsHead = await this.#essentialsHead(essentialsRepo);

      for (const { current, head, space } of toLoad) {
        const { summary, warnings } = await this.#apply(window, current, head);
        say(`Loaded ${space.name}: ${summary}`, "added");
        for (const warning of warnings) {
          say(`warning: ${warning}`, "modified");
        }
      }

      if (essentialsHead && setup && force) {
        const current = essentialsSnapshot(await this.currentSnapshot(window));
        const { summary } = await this.#apply(window, current, essentialsHead);
        say(`Loaded Essentials: ${summary}`, "added");
      } else if (essentialsHead && (setup || !essentialsHadHistory)) {
        // First pull of Essentials here: add GitHub's, keep any already open.
        const current = essentialsSnapshot(await this.currentSnapshot(window));
        const have = new Set(current.essentials.map(tab => tab.url));
        const merged = {
          ...current,
          essentials: [
            ...current.essentials,
            ...essentialsHead.essentials.filter(tab => !have.has(tab.url)),
          ],
        };
        const { summary } = await this.#apply(window, current, merged);
        if (summary !== "already matched") {
          say(`Loaded Essentials: ${summary}`, "added");
        }
      } else if (
        essentialsHead &&
        essentialsResult.state === "updated" &&
        !isClean(
          computeStatus(
            essentialsSnapshot(await this.currentSnapshot(window)),
            essentialsHead
          )
        )
      ) {
        say("  `essentials reset` loads the pulled Essentials.", "dim");
      }

      if (
        startSpace &&
        gZenWorkspaces.activeWorkspace !== startSpace &&
        gZenWorkspaces.getWorkspaces().some(s => s.uuid === startSpace)
      ) {
        await gZenWorkspaces.changeWorkspaceWithID(startSpace);
      }
      this.#forgetHeads();
      await this.#refreshNow(window);
      return { lines };
    });
  }

  /**
   * Runs git in the shared repo (remotes, fetch).
   *
   * @param {string[]} args
   * @returns {Promise<{exitCode: number, output: string}>}
   */
  runShared(args) {
    return this.#serialize(async () => {
      await this.#ensureShared();
      const result = await this.repo.tryGit(...args);
      this.#forgetHeads();
      return result;
    });
  }

  /** @returns {Window|null} The most recently focused browser window. */
  get topWindow() {
    return lazy.BrowserWindowTracker.getTopWindow();
  }
}

export const ZenGitManager = new nsZenGitManager();
