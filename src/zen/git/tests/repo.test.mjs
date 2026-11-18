/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Runs ZenGitRepo against real git in a temporary folder.
// Run with: node --test src/zen/git/tests/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ZenGitRepo } from "../ZenGitRepo.sys.mjs";

function exec(args, cwd) {
  return new Promise(resolve => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error ? error.code || 1 : 0,
          output: stdout + stderr,
        });
      }
    );
  });
}

const nodeFs = {
  join: (...parts) => path.join(...parts),
  exists: p =>
    fs.access(p).then(
      () => true,
      () => false
    ),
  read: p => fs.readFile(p, "utf8"),
  write: async (p, text) => {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, text);
  },
  remove: p => fs.rm(p, { force: true }),
  mkdir: p => fs.mkdir(p, { recursive: true }),
  list: p => fs.readdir(p).catch(() => []),
};

function snapshot(spaces) {
  return {
    version: 1,
    essentials: [
      {
        id: "e1",
        title: "Mail",
        url: "https://mail.google.com/",
        pinned: true,
      },
    ],
    spaces: spaces.map(name => ({
      id: `id-${name}`,
      name,
      icon: null,
      folders: [],
      tabs: [
        {
          id: `tab-${name}`,
          title: name,
          url: `https://${name}.com/`,
          pinned: false,
        },
      ],
    })),
  };
}

test("commit, read back, log, and drop removed spaces", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zen-git-test-"));
  const repo = new ZenGitRepo({
    dir: path.join(dir, "layouts"),
    exec,
    fs: nodeFs,
  });

  assert.equal(await repo.hasCommits(), false);
  assert.equal(await repo.readSnapshot(), null);

  const first = snapshot(["Work", "Home"]);
  const hash = await repo.commit(first, "first layout");
  assert.match(hash, /^[0-9a-f]{7,}$/);
  assert.deepEqual(await repo.readSnapshot(), first);
  assert.equal(
    await repo.commit(first, "again"),
    null,
    "no-op commit is skipped"
  );

  const second = snapshot(["Work"]);
  await repo.commit(second, "closed home space");
  assert.deepEqual(await repo.readSnapshot(), second);
  assert.deepEqual(await repo.readSnapshot("HEAD~1"), first);
  assert.equal(
    await fs.access(path.join(dir, "layouts/spaces/home.json")).then(
      () => true,
      () => false
    ),
    false
  );

  const log = await repo.log();
  assert.deepEqual(
    log.map(l => l.subject),
    ["closed home space", "first layout"]
  );

  const ignore = await repo.readIgnoreRules();
  assert.ok(ignore.length > 0, "default .browserignore was written");

  await fs.rm(dir, { recursive: true, force: true });
});
