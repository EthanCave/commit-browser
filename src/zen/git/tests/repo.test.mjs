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

test("branches, switching and revKind", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zen-git-test-"));
  const repo = new ZenGitRepo({
    dir: path.join(dir, "layouts"),
    exec,
    fs: nodeFs,
  });

  await repo.commit(snapshot(["Work"]), "work");
  assert.equal(await repo.currentBranch(), "main");
  assert.equal(await repo.revKind("main"), "branch");
  assert.equal(await repo.revKind("HEAD"), "commit");
  assert.equal(await repo.revKind("nope"), null);
  assert.equal(await repo.revKind("-f"), null);

  await repo.resetWorkingTree();
  await repo.git("switch", "-q", "-c", "fun");
  await repo.commit(snapshot(["Games"]), "games");
  assert.deepEqual(await repo.branches(), ["fun", "main"]);

  await repo.resetWorkingTree();
  await repo.git("switch", "-q", "main");
  assert.deepEqual(await repo.readSnapshot(), snapshot(["Work"]));
  assert.deepEqual(await repo.readSnapshot("fun"), snapshot(["Games"]));

  await fs.rm(dir, { recursive: true, force: true });
});

test("stash saves a layout and reads it back without touching HEAD", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zen-git-test-"));
  const repo = new ZenGitRepo({
    dir: path.join(dir, "layouts"),
    exec,
    fs: nodeFs,
  });

  const committed = snapshot(["Work"]);
  await repo.commit(committed, "work");
  assert.equal(
    await repo.stashPush(committed, "nothing"),
    false,
    "matching HEAD stashes nothing"
  );

  const wip = snapshot(["Work", "Research"]);
  assert.equal(await repo.stashPush(wip, "research tabs"), true);
  assert.deepEqual(await repo.readWorkingSnapshot(), committed);

  const list = await repo.stashList();
  assert.equal(list.length, 1);
  assert.equal(list[0].message, "research tabs");

  assert.deepEqual(await repo.readStash(), wip);
  assert.deepEqual(
    await repo.readWorkingSnapshot(),
    committed,
    "reading a stash leaves the tree at HEAD"
  );
  assert.equal((await repo.stashList()).length, 1, "read does not drop");
  assert.deepEqual(await repo.readSnapshot(), committed);

  await fs.rm(dir, { recursive: true, force: true });
});
