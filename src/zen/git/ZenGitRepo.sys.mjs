/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  DEFAULT_IGNORE_FILE,
  filesToSnapshot,
  parseIgnore,
  snapshotToFiles,
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

Each commit in this repository is a snapshot of my browser's sidebar:
spaces, folders, pinned tabs and open tabs.

- \`essentials.json\` holds the tabs pinned to the top grid.
- \`spaces/<name>.json\` holds one space each.
- \`.browserignore\` lists sites that are never committed.
`;

/**
 * A git repository holding committed layouts.
 *
 * Process and file access are injected so this class runs both inside the
 * browser (Subprocess + IOUtils) and under Node for tests.
 *
 * exec(args, cwd) => Promise<{exitCode: number, output: string}>
 * fs: { join(...parts), exists(path), read(path), write(path, text),
 *       remove(path), mkdir(path), list(dir) => Promise<string[]> (names) }
 */
export class ZenGitRepo {
  #dir;
  #exec;
  #fs;

  constructor({ dir, exec, fs }) {
    this.#dir = dir;
    this.#exec = exec;
    this.#fs = fs;
  }

  get dir() {
    return this.#dir;
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
    const tree = await this.tryGit("ls-tree", "-r", "--name-only", rev);
    if (tree.exitCode !== 0) {
      return null;
    }
    const files = {};
    for (const path of tree.output.split("\n")) {
      if (
        path === "essentials.json" ||
        (path.startsWith("spaces/") && path.endsWith(".json"))
      ) {
        files[path] = await this.git("show", `${rev}:${path}`);
      }
    }
    return filesToSnapshot(files);
  }

  /**
   * Writes a snapshot to the working tree, removing files for spaces that
   * no longer exist.
   *
   * @param {object} snapshot
   */
  async writeSnapshot(snapshot) {
    const files = snapshotToFiles(snapshot);
    const spacesDir = this.#path("spaces");
    await this.#fs.mkdir(spacesDir);
    for (const name of await this.#fs.list(spacesDir)) {
      if (name.endsWith(".json") && !(`spaces/${name}` in files)) {
        await this.#fs.remove(this.#fs.join(spacesDir, name));
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
    return exitCode === 0 ? output.trim() : null;
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
      "refs/heads"
    );
    return output.split("\n").filter(Boolean);
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
      `refs/heads/${rev}`
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
    const essentials = this.#path("essentials.json");
    if (await this.#fs.exists(essentials)) {
      files["essentials.json"] = await this.#fs.read(essentials);
    }
    for (const name of await this.#fs.list(this.#path("spaces"))) {
      if (name.endsWith(".json")) {
        files[`spaces/${name}`] = await this.#fs.read(
          this.#fs.join(this.#dir, "spaces", name)
        );
      }
    }
    return filesToSnapshot(files);
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
   * @returns {Promise<{ref: string, when: string, message: string}[]>}
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
        const [ref, when, message] = line.split("\x1f");
        return { ref, when, message: message.replace(/^On [^:]+: /, "") };
      });
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
