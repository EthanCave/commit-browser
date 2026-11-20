/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One history per space: model helpers, and real git with a worktree per
// space. Run with: node --test src/zen/git/tests/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ZenGitRepo } from "../ZenGitRepo.sys.mjs";
import {
  ESSENTIALS_CODEC,
  SETTINGS_CODEC,
  normalizeSettings,
  computeStatus,
  essentialsSnapshot,
  isClean,
  mergeStatuses,
  parseWorktrees,
  planCheckout,
  retargetSpace,
  spaceBranchPrefix,
  spaceCodec,
  spaceSnapshot,
} from "../ZenGitModel.sys.mjs";

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
      (error, stdout, stderr) =>
        resolve({ exitCode: error ? error.code || 1 : 0, output: stdout + stderr })
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

const tab = (id, url, extra = {}) => ({
  id,
  title: id,
  url,
  pinned: false,
  ...extra,
});

function windowSnapshot() {
  return {
    version: 1,
    essentials: [tab("e1", "https://mail.google.com/", { pinned: true })],
    spaces: [
      {
        id: "uuid-school",
        name: "School",
        icon: null,
        folders: [],
        tabs: [tab("t1", "https://canvas.rice.edu/")],
      },
      {
        id: "uuid-home",
        name: "Home",
        icon: null,
        folders: [],
        tabs: [tab("t2", "https://youtube.com/")],
      },
    ],
  };
}

function spaceOnly(name, tabs, id = `uuid-${name.toLowerCase()}`) {
  return {
    version: 1,
    essentials: [],
    spaces: [{ id, name, icon: null, folders: [], tabs }],
  };
}

test("spaceSnapshot keeps one space and drops Essentials", () => {
  const school = spaceSnapshot(windowSnapshot(), "uuid-school");
  assert.equal(school.spaces.length, 1);
  assert.equal(school.spaces[0].name, "School");
  assert.deepEqual(school.essentials, []);
  const missing = spaceSnapshot(windowSnapshot(), "uuid-new");
  assert.deepEqual(missing.spaces[0].tabs, []);
  assert.equal(missing.spaces[0].id, "uuid-new");
});

test("retargetSpace points a stored layout at the live space", () => {
  const stored = spaceOnly("School", [tab("t1", "https://a.com/")], "old-id");
  const live = { id: "new-id", name: "School", icon: null };
  const target = retargetSpace(stored, live);
  assert.equal(target.spaces[0].id, "new-id");
  // Restoring it into the live space creates no space and opens nothing new.
  const current = spaceOnly("School", [tab("t1", "https://a.com/")], "new-id");
  const plan = planCheckout(current, target);
  assert.deepEqual(plan.createSpaces, []);
  assert.deepEqual(plan.open, []);
  assert.ok(isClean(computeStatus(current, target)));
});

test("spaceCodec round-trips and reads a space out of an older commit", () => {
  const codec = spaceCodec("school");
  const snapshot = spaceOnly("School", [tab("t1", "https://a.com/")]);
  const files = codec.toFiles(snapshot);
  assert.deepEqual(Object.keys(files), ["space.json"]);
  assert.deepEqual(codec.fromFiles(files), snapshot);
  assert.equal(codec.wants("space.json"), true);
  assert.equal(codec.wants("spaces/school.json"), true);
  assert.equal(codec.wants("spaces/home.json"), false);
  const legacy = codec.fromFiles({
    "spaces/school.json": JSON.stringify({
      ...snapshot.spaces[0],
      position: 3,
    }),
  });
  assert.deepEqual(legacy, snapshot);
  assert.equal(codec.fromFiles({ "spaces/home.json": "{}" }), null);
});

test("mergeStatuses and parseWorktrees", () => {
  const a = computeStatus(spaceOnly("A", [tab("1", "https://a.com/")]), null);
  const b = computeStatus(
    spaceOnly("B", [tab("2", "https://b.com/")]),
    spaceOnly("B", [tab("2", "https://b.org/")])
  );
  const merged = mergeStatuses([a, b]);
  assert.equal(merged.tabs.get("1"), "untracked");
  assert.equal(merged.tabs.get("2"), "modified");
  assert.equal(merged.added.length, 1);
  assert.equal(merged.modified.length, 1);

  const worktrees = parseWorktrees(
    "worktree /r\nHEAD abc\nbranch refs/heads/personal\n\n" +
      "worktree /r/.spaces/school\nHEAD def\nbranch refs/heads/spaces/school/main\n"
  );
  assert.deepEqual(worktrees, [
    { path: "/r", branch: "personal" },
    { path: "/r/.spaces/school", branch: "spaces/school/main" },
  ]);
});

test("each space commits, branches and stashes in its own worktree", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zen-git-spaces-"));
  const shared = new ZenGitRepo({ dir: path.join(dir, "layouts"), exec, fs: nodeFs });
  await shared.ensureInit();
  await shared.excludeLocally(".spaces/");

  const spaceRepo = slug =>
    new ZenGitRepo({
      dir: path.join(dir, "layouts", ".spaces", slug),
      exec,
      fs: nodeFs,
      codec: spaceCodec(slug),
      branchPrefix: spaceBranchPrefix(slug),
    });
  const school = spaceRepo("school");
  const home = spaceRepo("home");
  assert.equal(
    await shared.addWorktree(school.dir, school.fullBranch("main")),
    "orphan"
  );
  await shared.addWorktree(home.dir, home.fullBranch("main"));

  const schoolV1 = spaceOnly("School", [tab("t1", "https://canvas.rice.edu/")]);
  const homeV1 = spaceOnly("Home", [tab("t2", "https://youtube.com/")]);
  assert.ok(await school.commit(schoolV1, "school"));
  assert.ok(await home.commit(homeV1, "home"));

  assert.equal(await school.currentBranch(), "main");
  assert.deepEqual(await school.readSnapshot(), schoolV1);
  assert.deepEqual(await home.readSnapshot(), homeV1);
  assert.deepEqual(
    (await school.log()).map(l => l.subject),
    ["school"],
    "a space's log only has its own commits"
  );

  // A branch in School leaves Home alone.
  await school.resetWorkingTree();
  await school.git("switch", "-q", "-c", school.fullBranch("finals"));
  const finals = spaceOnly("School", [tab("t3", "https://docs.google.com/")]);
  await school.commit(finals, "finals");
  assert.deepEqual(await school.branches(), ["finals", "main"]);
  assert.deepEqual(await home.branches(), ["main"]);
  assert.equal(await school.revKind("finals"), "branch");
  assert.equal(await home.revKind("finals"), null);
  assert.deepEqual(await school.readSnapshot("main"), schoolV1);

  // Stashes are split by space even though git keeps one list.
  const wip = spaceOnly("School", [tab("t9", "https://wip.com/")]);
  assert.equal(await school.stashPush(wip, "school wip"), true);
  const homeWip = spaceOnly("Home", [tab("t8", "https://netflix.com/")]);
  assert.equal(await home.stashPush(homeWip, "home wip"), true);
  const schoolStashes = await school.stashList();
  assert.deepEqual(
    schoolStashes.map(s => [s.message, s.branch]),
    [["school wip", "finals"]]
  );
  assert.deepEqual(
    (await home.stashList()).map(s => s.message),
    ["home wip"]
  );
  assert.deepEqual(await school.readStash(schoolStashes[0].ref), wip);

  // The shared repo's own tree stays clean of the nested worktrees.
  assert.equal((await shared.git("status", "--porcelain", "--ignored=no")).includes(".spaces"), false);
  const worktrees = await shared.worktrees();
  assert.equal(worktrees.length, 3);

  await fs.rm(dir, { recursive: true, force: true });
});

test("a space's history can start from an older whole-window commit", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zen-git-spaces-"));
  const sharedDir = path.join(dir, "layouts");
  const shared = new ZenGitRepo({ dir: sharedDir, exec, fs: nodeFs });
  await shared.commit(windowSnapshot(), "whole window");

  const legacySchool = await new ZenGitRepo({
    dir: sharedDir,
    exec,
    fs: nodeFs,
    codec: spaceCodec("school"),
  }).readSnapshot("HEAD");
  assert.equal(legacySchool.spaces[0].name, "School");
  assert.deepEqual(legacySchool.spaces[0].tabs.map(t => t.id), ["t1"]);

  const school = new ZenGitRepo({
    dir: path.join(sharedDir, ".spaces", "school"),
    exec,
    fs: nodeFs,
    codec: spaceCodec("school"),
    branchPrefix: spaceBranchPrefix("school"),
  });
  await shared.excludeLocally(".spaces/");
  await shared.addWorktree(school.dir, school.fullBranch("main"));
  await school.commit(legacySchool, "Start from the whole-window layout");
  assert.deepEqual(await school.readSnapshot(), legacySchool);
  // The older whole-window branch is untouched.
  assert.equal(await shared.currentBranch(), "main");
  assert.deepEqual(await shared.readSnapshot(), windowSnapshot());

  await fs.rm(dir, { recursive: true, force: true });
});

test("Essentials have their own snapshot and read older commits' file", () => {
  const ess = essentialsSnapshot(windowSnapshot());
  assert.deepEqual(ess.spaces, []);
  assert.deepEqual(ess.essentials.map(t => t.id), ["e1"]);
  const files = ESSENTIALS_CODEC.toFiles(ess);
  assert.deepEqual(Object.keys(files), ["essentials.json"]);
  assert.deepEqual(ESSENTIALS_CODEC.fromFiles(files), ess);
  // Older whole-window commits stored essentials.json the same way.
  assert.deepEqual(
    ESSENTIALS_CODEC.fromFiles({
      "essentials.json": JSON.stringify({ version: 1, tabs: ess.essentials }),
    }),
    ess
  );
  assert.equal(ESSENTIALS_CODEC.fromFiles({}), null);
  const status = computeStatus(ess, null);
  assert.equal(status.tabs.get("e1"), "untracked");
});

test("settings keep each space's default branch", () => {
  assert.deepEqual(normalizeSettings(null), { version: 1, defaults: {} });
  const settings = normalizeSettings({ defaults: { rice: "finals" } });
  const files = SETTINGS_CODEC.toFiles(settings);
  assert.deepEqual(Object.keys(files), ["settings.json"]);
  assert.deepEqual(SETTINGS_CODEC.fromFiles(files), settings);
  assert.equal(SETTINGS_CODEC.fromFiles({}), null);
  assert.equal(SETTINGS_CODEC.fromFiles({ "settings.json": "{oops" }), null);
});
