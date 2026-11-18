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
