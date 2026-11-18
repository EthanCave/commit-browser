/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Run with: node --test src/zen/git/tests/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSnapshot,
  computeStatus,
  extractMessage,
  filesToSnapshot,
  formatStatus,
  isIgnored,
  parseIgnore,
  resolveCdTarget,
  sanitizeUrl,
  snapshotToFiles,
  STATUS,
  summarize,
  tokenize,
} from "../ZenGitModel.sys.mjs";

function tab(id, url, extra = {}) {
  return {
    zenSyncId: id,
    entries: [{ url, title: `Title ${id}` }],
    index: 1,
    zenWorkspace: "space-work",
    ...extra,
  };
}

const sidebar = {
  spaces: [
    { uuid: "space-work", name: "Work", icon: "💼" },
    { uuid: "space-home", name: "Home" },
  ],
  folders: [
    { id: "folder-1", name: "Research", workspaceId: "space-work" },
    { id: "split-1", splitViewGroup: true, workspaceId: "space-work" },
  ],
  tabs: [
    tab("t1", "https://github.com/zen-browser/desktop"),
    tab("t2", "https://mail.google.com/mail/u/0", {
      zenEssential: true,
      pinned: true,
    }),
    tab("t3", "https://en.wikipedia.org/wiki/The_Son_of_Man", {
      groupId: "folder-1",
    }),
    tab("t4", "https://www.chase.com/accounts"),
    tab("t5", "about:blank", { zenIsEmpty: true }),
    tab("t6", "https://youtube.com/watch?v=abc", {
      zenWorkspace: "space-home",
    }),
  ],
};

test("buildSnapshot groups tabs by space, folder and essentials", () => {
  const snap = buildSnapshot(sidebar, {
    ignoreRules: parseIgnore("*.chase.com"),
  });
  assert.equal(snap.essentials.length, 1);
  assert.equal(snap.essentials[0].id, "t2");
  const work = snap.spaces.find(s => s.id === "space-work");
  assert.deepEqual(
    work.tabs.map(t => t.id),
    ["t1", "t3"],
    "ignored and empty tabs are skipped"
  );
  assert.equal(work.tabs[1].folderId, "folder-1");
  assert.equal(work.folders.length, 1, "split view groups are not folders");
  assert.equal(snap.spaces[1].tabs[0].id, "t6");
});

test("snapshot survives a round trip through repo files", () => {
  const snap = buildSnapshot(sidebar);
  const files = snapshotToFiles(snap);
  assert.ok(files["spaces/work.json"]);
  assert.ok(files["spaces/home.json"]);
  assert.ok(files["essentials.json"]);
  assert.deepEqual(filesToSnapshot(files), snap);
});

test("duplicate space names get distinct files", () => {
  const files = snapshotToFiles({
    version: 1,
    essentials: [],
    spaces: [
      { id: "aaaa1111", name: "Work", folders: [], tabs: [] },
      { id: "bbbb2222", name: "work", folders: [], tabs: [] },
    ],
  });
  assert.deepEqual(Object.keys(files).sort(), [
    "essentials.json",
    "spaces/work-bbbb2222.json",
    "spaces/work.json",
  ]);
});

test("computeStatus reports untracked, modified, clean and closed tabs", () => {
  const head = buildSnapshot(sidebar);
  const changed = structuredClone(sidebar);
  changed.tabs[0].entries.push({
    url: "https://github.com/settings",
    title: "S",
  });
  changed.tabs[0].index = 2;
  changed.tabs.splice(5, 1); // close t6
  changed.tabs.push(tab("t7", "https://news.ycombinator.com"));
  const status = computeStatus(buildSnapshot(changed), head);
  assert.equal(status.tabs.get("t1"), STATUS.MODIFIED);
  assert.equal(status.tabs.get("t3"), STATUS.CLEAN);
  assert.equal(status.tabs.get("t7"), STATUS.UNTRACKED);
  assert.deepEqual(
    status.deleted.map(t => t.id),
    ["t6"]
  );
  assert.equal(summarize(status), "1 modified, 1 untracked, 1 closed");
  const lines = formatStatus(status, true);
  assert.ok(lines.some(l => l.startsWith("M  ")));
  assert.ok(lines.some(l => l.startsWith("U  ")));
  assert.ok(lines.some(l => l.startsWith("D  ")));
});

test("everything is untracked before the first commit", () => {
  const status = computeStatus(buildSnapshot(sidebar), null);
  assert.ok([...status.tabs.values()].every(s => s === STATUS.UNTRACKED));
});

test("moving a tab to another folder marks it modified", () => {
  const head = buildSnapshot(sidebar);
  const moved = structuredClone(sidebar);
  delete moved.tabs[2].groupId;
  const status = computeStatus(buildSnapshot(moved), head);
  assert.equal(status.tabs.get("t3"), STATUS.MODIFIED);
});

test("sanitizeUrl strips secrets and refuses local-only schemes", () => {
  assert.equal(
    sanitizeUrl("https://example.com/cb?code=abc&page=2&X-Amz-Signature=zz"),
    "https://example.com/cb?page=2"
  );
  assert.equal(
    sanitizeUrl("https://app.example.com/#access_token=abc"),
    "https://app.example.com/"
  );
  assert.equal(
    sanitizeUrl("https://user:pw@example.com/"),
    "https://example.com/"
  );
  assert.equal(
    sanitizeUrl("https://youtube.com/watch?v=abc"),
    "https://youtube.com/watch?v=abc"
  );
  assert.equal(sanitizeUrl("file:///Users/me/secret.pdf"), null);
  assert.equal(sanitizeUrl("data:text/html,hi"), null);
});

test(".browserignore patterns match hosts", () => {
  const rules = parseIgnore(
    `# comment\n*.chase.com\nmail.google.com\n\nlocalhost\n`
  );
  assert.ok(isIgnored("https://chase.com/", rules));
  assert.ok(isIgnored("https://secure.chase.com/x", rules));
  assert.ok(isIgnored("https://mail.google.com/mail", rules));
  assert.ok(isIgnored("http://localhost:3000/", rules));
  assert.ok(!isIgnored("https://notchase.com/", rules));
  assert.ok(!isIgnored("https://google.com/", rules));
});

test("tokenize and extractMessage handle quoted commit messages", () => {
  assert.deepEqual(tokenize(`commit -m "thesis research" now`), [
    "commit",
    "-m",
    "thesis research",
    "now",
  ]);
  assert.deepEqual(tokenize(`echo ''`), ["echo", ""]);
  assert.deepEqual(extractMessage(["-m", "hello world"]), {
    message: "hello world",
    rest: [],
  });
  assert.deepEqual(extractMessage(["-mquick", "x"]), {
    message: "quick",
    rest: ["x"],
  });
});

test("resolveCdTarget turns shell-style targets into URLs", () => {
  assert.deepEqual(resolveCdTarget("github"), {
    kind: "url",
    url: "https://github.com",
  });
  assert.deepEqual(resolveCdTarget("github/anthropics"), {
    kind: "url",
    url: "https://github.com/anthropics",
  });
  assert.deepEqual(resolveCdTarget("gh/zen-browser"), {
    kind: "url",
    url: "https://github.com/zen-browser",
  });
  assert.deepEqual(resolveCdTarget("en.wikipedia.org/wiki/Magritte"), {
    kind: "url",
    url: "https://en.wikipedia.org/wiki/Magritte",
  });
  assert.deepEqual(resolveCdTarget("localhost:3000/app"), {
    kind: "url",
    url: "http://localhost:3000/app",
  });
  assert.deepEqual(resolveCdTarget("https://example.com"), {
    kind: "url",
    url: "https://example.com",
  });
  assert.deepEqual(resolveCdTarget("son of man painting"), {
    kind: "search",
    query: "son of man painting",
  });
  assert.equal(resolveCdTarget("..").kind, "back");
  assert.equal(resolveCdTarget("-").kind, "previous");
  assert.equal(resolveCdTarget("").kind, "home");
});
