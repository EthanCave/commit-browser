/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  DEFAULT_IGNORE_FILE,
  WINDOW_CODEC,
  parseIgnore,
  parseWorktrees,
} from "./ZenGitModel.sys.mjs";

/**
 * Error thrown when a git command exits with a non-zero status.
 */
export class GitError extends Error {
  constructor(args, exitCode, output) {
    super(output.trim() || `git ${args[0]} failed with exit code ${exitCode}`);
    this.name = "GitError";
    this.args = args;
    this.exitCode = exitCode;
    this.output = output;
  }
}

const README = `# Browser layouts

Every space in my browser has its own history here.

- Branches named \`spaces/<space>/<branch>\` hold one space's layout
  (\`space.json\`: its folders, pinned tabs and open tabs).
- \`.browserignore\` lists sites that are never committed.
- Older commits (\`essentials.json\` + \`spaces/*.json\`) saved the whole
  window at once.
`;

/**
 * A git repository holding committed layouts.
 *
 * Process and file access are injected so this class runs both inside the
 * browser (Subprocess + IOUtils) and under Node for tests.
 *
 * exec(args, cwd, env?) => Promise<{exitCode: number, output: string}>
 * fs: { join(...parts), exists(path), read(path), write(path, text),
 *       remove(path), mkdir(path), list(dir) => Promise<string[]> (names) }
 *
 * codec says which files hold a layout (see WINDOW_CODEC / spaceCodec).
 * branchPrefix (e.g. "spaces/school") scopes branch names: callers use
 * "main", git sees "spaces/school/main".
 */
export class ZenGitRepo {
  #dir;
  #exec;
  #fs;
  #codec;
  #prefix;

  constructor({ dir, exec, fs, codec = WINDOW_CODEC, branchPrefix = "" }) {
    this.#dir = dir;
    this.#exec = exec;
    this.#fs = fs;
    this.#codec = codec;
    this.#prefix = branchPrefix ? branchPrefix.replace(/\/+$/, "") + "/" : "";
  }

  get dir() {
    return this.#dir;
  }

  get branchPrefix() {
    return this.#prefix;
  }

  /**
   * @param {string} name A branch name as the user types it.
   * @returns {string} The real branch name in git.
   */
  fullBranch(name) {
    return this.#prefix && !name.startsWith(this.#prefix)
      ? this.#prefix + name
      : name;
  }

  /**
   * @param {string} full A real branch name.
   * @returns {string|null} Its short name, or null if it is not ours.
   */
  shortBranch(full) {
    if (!this.#prefix) {
      return full;
    }
    return full.startsWith(this.#prefix)
      ? full.slice(this.#prefix.length)
      : null;
  }

  #path(relative) {
    return this.#fs.join(this.#dir, ...relative.split("/"));
  }

  /**
   * Runs git in the repo and returns its output, throwing on failure.
   *
   * @param {...string} args
   * @returns {Promise<string>}
   */
  async git(...args) {
    const { exitCode, output } = await this.#exec(args, this.#dir);
    if (exitCode !== 0) {
      throw new GitError(args, exitCode, output);
    }
    return output;
  }

  /**
   * Runs git and returns the result without throwing.
   *
   * @param {...string} args
   * @returns {Promise<{exitCode: number, output: string}>}
   */
  async tryGit(...args) {
    return this.#exec(args, this.#dir);
  }

  /**
   * Like git(), with extra environment variables (e.g. GIT_INDEX_FILE).
   *
   * @param {object} env
   * @param {...string} args
   * @returns {Promise<string>}
   */
  async gitWithEnv(env, ...args) {
    const { exitCode, output } = await this.#exec(args, this.#dir, env);
    if (exitCode !== 0) {
      throw new GitError(args, exitCode, output);
    }
    return output;
  }

  async isRepo() {
    return this.#fs.exists(this.#path(".git"));
  }

  /**
   * Creates the repo with a README and a default .browserignore if needed.
   *
   * @returns {Promise<boolean>} Whether a new repo was created.
   */
  async ensureInit() {
    if (await this.isRepo()) {
      return false;
    }
    await this.#fs.mkdir(this.#dir);
    const init = await this.tryGit("init", "-b", "main");
    if (init.exitCode !== 0) {
      // git older than 2.28 has no -b.
      await this.git("init");
      await this.git("symbolic-ref", "HEAD", "refs/heads/main");
    }
    if (!(await this.#fs.exists(this.#path(".browserignore")))) {
      await this.#fs.write(this.#path(".browserignore"), DEFAULT_IGNORE_FILE);
    }
    if (!(await this.#fs.exists(this.#path("README.md")))) {
      await this.#fs.write(this.#path("README.md"), README);
    }
    return true;
  }

  /**
   * @returns {Promise<RegExp[]>} Rules from the repo's .browserignore.
   */
  async readIgnoreRules() {
    const path = this.#path(".browserignore");
    if (await this.#fs.exists(path)) {
      return parseIgnore(await this.#fs.read(path));
    }
    return parseIgnore(DEFAULT_IGNORE_FILE);
  }

  async hasCommits() {
    if (!(await this.isRepo())) {
      return false;
    }
    const { exitCode } = await this.tryGit(
      "rev-parse",
      "--verify",
      "-q",
      "HEAD"
    );
    return exitCode === 0;
  }

  /**
   * Reads the snapshot stored at a revision.
   *
   * @param {string} [rev]
   * @returns {Promise<object|null>} null when the revision does not exist.
   */
  async readSnapshot(rev = "HEAD") {
    if (!(await this.isRepo())) {
      return null;
    }
    if (this.#prefix && (await this.revKind(rev)) === "branch") {
      rev = this.fullBranch(rev);
    }
    const tree = await this.tryGit("ls-tree", "-r", "--name-only", rev);
    if (tree.exitCode !== 0) {
      return null;
    }
    const files = {};
    for (const path of tree.output.split("\n")) {
      if (this.#codec.wants(path)) {
        files[path] = await this.git("show", `${rev}:${path}`);
      }
    }
    return this.#codec.fromFiles(files);
  }

  /**
   * Writes a snapshot to the working tree, removing files for spaces that
   * no longer exist.
   *
   * @param {object} snapshot
   */
  async writeSnapshot(snapshot) {
    const files = this.#codec.toFiles(snapshot);
    const { staleDir } = this.#codec;
    if (staleDir) {
      const dir = this.#path(staleDir);
      await this.#fs.mkdir(dir);
      for (const name of await this.#fs.list(dir)) {
        if (name.endsWith(".json") && !(`${staleDir}/${name}` in files)) {
          await this.#fs.remove(this.#fs.join(dir, name));
        }
      }
    }
    for (const [path, text] of Object.entries(files)) {
      await this.#fs.write(this.#path(path), text);
    }
  }

  /**
   * Commits a snapshot, like `git commit -a`.
   *
   * @param {object} snapshot
   * @param {string} message
   * @returns {Promise<string|null>} The short hash, or null if nothing changed.
   */
  async commit(snapshot, message) {
    await this.ensureInit();
    await this.writeSnapshot(snapshot);
    await this.git("add", "-A");
    const pending = await this.git("status", "--porcelain");
    if (!pending.trim()) {
      return null;
    }
    await this.git("commit", "-q", "-m", message);
    return (await this.git("rev-parse", "--short", "HEAD")).trim();
  }

  /**
   * @returns {Promise<string|null>} The checked-out branch, or null.
   */
  async currentBranch() {
    if (!(await this.isRepo())) {
      return null;
    }
    const { exitCode, output } = await this.tryGit(
      "symbolic-ref",
      "--short",
      "-q",
      "HEAD"
    );
    return exitCode === 0 ? this.shortBranch(output.trim()) : null;
  }

  /**
   * @returns {Promise<string[]>} Local branch names.
   */
  async branches() {
    if (!(await this.hasCommits())) {
      return [];
    }
    const output = await this.git(
      "for-each-ref",
      "--format=%(refname:short)",
      `refs/heads/${this.#prefix}`.replace(/\/$/, "")
    );
    return output
      .split("\n")
      .filter(Boolean)
      .map(name => this.shortBranch(name))
      .filter(Boolean);
  }

  /**
   * Tells a branch name from a commit, the way `git checkout` must.
   *
   * @param {string} rev
   * @returns {Promise<"branch"|"commit"|null>}
   */
  async revKind(rev) {
    if (!(await this.hasCommits()) || rev.startsWith("-")) {
      return null;
    }
    const branch = await this.tryGit(
      "show-ref",
      "--verify",
      "-q",
      `refs/heads/${this.fullBranch(rev)}`
    );
    if (branch.exitCode === 0) {
      return "branch";
    }
    const commit = await this.tryGit(
      "rev-parse",
      "--verify",
      "-q",
      `${rev}^{commit}`
    );
    return commit.exitCode === 0 ? "commit" : null;
  }

  /**
   * Reads the snapshot currently written in the working tree.
   *
   * @returns {Promise<object>}
   */
  async readWorkingSnapshot() {
    const files = {};
    const candidates = ["essentials.json", "space.json"];
    for (const name of await this.#fs.list(this.#path("spaces"))) {
      candidates.push(`spaces/${name}`);
    }
    for (const path of candidates) {
      if (this.#codec.wants(path) && (await this.#fs.exists(this.#path(path)))) {
        files[path] = await this.#fs.read(this.#path(path));
      }
    }
    return this.#codec.fromFiles(files);
  }

  /**
   * Puts the working tree back to HEAD. The tree only ever holds generated
   * snapshot files, so nothing of the user's is lost.
   */
  async resetWorkingTree() {
    await this.git("reset", "-q", "--hard");
    await this.git("clean", "-q", "-fd");
  }

  /**
   * Saves a snapshot as a stash entry.
   *
   * @param {object} snapshot
   * @param {string} message
   * @returns {Promise<boolean>} false when it matched HEAD.
   */
  async stashPush(snapshot, message) {
    await this.writeSnapshot(snapshot);
    await this.git("add", "-A");
    const pending = await this.git("status", "--porcelain");
    if (!pending.trim()) {
      return false;
    }
    await this.git("stash", "push", "-q", "-m", message);
    return true;
  }

  /**
   * Reads a stash entry's snapshot without dropping it.
   *
   * @param {string} [ref]
   * @returns {Promise<object>}
   */
  async readStash(ref = "stash@{0}") {
    await this.resetWorkingTree();
    try {
      await this.git("stash", "apply", "-q", ref);
      return await this.readWorkingSnapshot();
    } finally {
      await this.resetWorkingTree();
    }
  }

  /**
   * Stashes made on this repo's branches. git keeps one stash list for all
   * worktrees, but tags each entry with its branch ("On <branch>: msg").
   *
   * @returns {Promise<{ref: string, when: string, message: string, branch: string|null}[]>}
   */
  async stashList() {
    if (!(await this.hasCommits())) {
      return [];
    }
    const output = await this.git(
      "stash",
      "list",
      "--format=%gd%x1f%cr%x1f%gs"
    );
    return output
      .split("\n")
      .filter(Boolean)
      .map(line => {
        const [ref, when, subject] = line.split("\x1f");
        const match = /^(?:On|WIP on) ([^:]+): (.*)$/s.exec(subject);
        const full = match ? match[1] : null;
        return {
          ref,
          when,
          message: match ? match[2] : subject,
          branch: full === null ? null : this.shortBranch(full),
          ours: full === null ? !this.#prefix : !!this.shortBranch(full),
        };
      })
      .filter(entry => entry.ours)
      .map(({ ours, ...entry }) => entry);
  }

  // -------------------------------------------------------------------------
  // Time travel: snapshots kept on a hidden ref (refs/zen/time/...), outside
  // refs/heads so they never show up as branches or get pushed.

  /**
   * Records a snapshot as a new commit on `ref`, without touching the
   * checked-out branch or working tree. Skipped when nothing changed.
   *
   * @param {string} ref e.g. "refs/zen/time/rice"
   * @param {object} snapshot
   * @param {string} message
   * @returns {Promise<string|null>} The new commit, or null if unchanged.
   */
  async snapshotToRef(ref, snapshot, message) {
    let common = (await this.git("rev-parse", "--git-common-dir")).trim();
    if (!common.startsWith("/")) {
      common = this.#fs.join(this.#dir, common);
    }
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const index = this.#fs.join(common, `zen-time-index-${stamp}`);
    const env = { GIT_INDEX_FILE: index };
    const temps = [index];
    try {
      await this.gitWithEnv(env, "read-tree", "--empty");
      for (const [path, text] of Object.entries(this.#codec.toFiles(snapshot))) {
        const file = this.#fs.join(common, `zen-time-blob-${stamp}`);
        temps.push(file);
        await this.#fs.write(file, text);
        const blob = (await this.git("hash-object", "-w", file)).trim();
        await this.gitWithEnv(
          env,
          "update-index",
          "--add",
          "--cacheinfo",
          `100644,${blob},${path}`
        );
      }
      const tree = (await this.gitWithEnv(env, "write-tree")).trim();
      const parent = await this.tryGit("rev-parse", "-q", "--verify", `${ref}^{commit}`);
      const parentHash = parent.exitCode === 0 ? parent.output.trim() : null;
      if (parentHash) {
        const parentTree = (await this.git("rev-parse", `${parentHash}^{tree}`)).trim();
        if (parentTree === tree) {
          return null;
        }
      }
      const commit = (
        await this.git(
          "commit-tree",
          tree,
          ...(parentHash ? ["-p", parentHash] : []),
          "-m",
          message
        )
      ).trim();
      await this.git("update-ref", ref, commit);
      return commit;
    } finally {
      for (const file of temps) {
        await this.#fs.remove(file);
      }
    }
  }

  /**
   * The newest snapshot on `ref` taken at or before `when`, in any form
   * git's date parser understands ("yesterday", "last tuesday 5pm",
   * "3 days ago", "2026-11-18").
   *
   * @param {string} ref
   * @param {string} when
   * @returns {Promise<{hash: string, date: string, snapshot: object}|null>}
   */
  async snapshotAt(ref, when) {
    const found = await this.tryGit(
      "log",
      "-1",
      `--before=${when}`,
      "--format=%H%x1f%cd",
      "--date=format:%a %b %-d, %-I:%M %p",
      ref,
      "--"
    );
    const [hash, date] = found.output.trim().split("\x1f");
    if (found.exitCode !== 0 || !hash) {
      return null;
    }
    return { hash, date, snapshot: await this.readSnapshot(hash) };
  }

  /**
   * @param {string} ref
   * @param {number} [count]
   * @returns {Promise<{hash: string, date: string, ago: string}[]>} Newest first.
   */
  async timeline(ref, count = 30) {
    const result = await this.tryGit(
      "log",
      `-n${count}`,
      "--format=%h%x1f%cd%x1f%cr",
      "--date=format:%a %b %-d, %-I:%M %p",
      ref,
      "--"
    );
    if (result.exitCode !== 0) {
      return [];
    }
    return result.output
      .split("\n")
      .filter(Boolean)
      .map(line => {
        const [hash, date, ago] = line.split("\x1f");
        return { hash, date, ago };
      });
  }

  // -------------------------------------------------------------------------
  // Worktrees (used on the shared repo)

  /**
   * @returns {Promise<{path: string, branch: string|null}[]>}
   */
  async worktrees() {
    if (!(await this.isRepo())) {
      return [];
    }
    return parseWorktrees(await this.git("worktree", "list", "--porcelain"));
  }

  /**
   * @param {string} name A full branch name.
   * @returns {Promise<boolean>}
   */
  async hasBranch(name) {
    const { exitCode } = await this.tryGit(
      "show-ref",
      "--verify",
      "-q",
      `refs/heads/${name}`
    );
    return exitCode === 0;
  }

  /**
   * Checks a branch out in a new worktree, creating it as an empty (orphan)
   * branch when it does not exist yet.
   *
   * @param {string} path
   * @param {string} branch Full branch name.
   * @returns {Promise<"existing"|"orphan">}
   */
  async addWorktree(path, branch) {
    await this.tryGit("worktree", "prune");
    if (await this.hasBranch(branch)) {
      await this.git("worktree", "add", "-q", path, branch);
      return "existing";
    }
    await this.git("worktree", "add", "-q", "--orphan", "-b", branch, path);
    return "orphan";
  }

  /**
   * Keeps the shared repo from seeing the worktrees nested inside it.
   *
   * @param {string} pattern e.g. ".spaces/"
   */
  async excludeLocally(pattern) {
    const path = this.#path(".git/info/exclude");
    const text = (await this.#fs.exists(path)) ? await this.#fs.read(path) : "";
    if (!text.split("\n").includes(pattern)) {
      await this.#fs.write(
        path,
        text + (text && !text.endsWith("\n") ? "\n" : "") + pattern + "\n"
      );
    }
  }

  /**
   * @param {number} [count]
   * @returns {Promise<{hash: string, when: string, subject: string}[]>}
   */
  async log(count = 20) {
    if (!(await this.hasCommits())) {
      return [];
    }
    const output = await this.git(
      "log",
      `-n${count}`,
      "--pretty=format:%h%x1f%ar%x1f%s"
    );
    return output
      .split("\n")
      .filter(Boolean)
      .map(line => {
        const [hash, when, subject] = line.split("\x1f");
        return { hash, when, subject };
      });
  }
}
