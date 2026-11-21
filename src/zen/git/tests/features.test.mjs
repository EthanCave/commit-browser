/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Helpers behind time travel, grep, cherry-pick, share and focus.
// Run with: node --test src/zen/git/tests/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeShareCode,
  encodeShareCode,
  focusRules,
  formatCountdown,
  fromSharedSpace,
  isIgnored,
  looksLikeTime,
  parseDuration,
  selectTabs,
  snippetAround,
  toSharedSpace,
} from "../ZenGitModel.sys.mjs";

test("looksLikeTime tells dates from branch names", () => {
  for (const when of [
    "yesterday",
    "last tuesday",
    "3 days ago",
    "2026-11-18",
    "this morning",
    "9am",
    "noon yesterday",
  ]) {
    assert.equal(looksLikeTime(when), true, when);
  }
  for (const name of ["main", "finals", "school", "a1b2c3d", "football"]) {
    assert.equal(looksLikeTime(name), false, name);
  }
});

test("snippetAround finds every match and trims context", () => {
  const text =
    "Week 9: the Midterm covers chapters 1-4.\n\nStudy group before the midterm on Tuesday. Bring notes.";
  const found = snippetAround(text, "midterm", { width: 12 });
  assert.equal(found.count, 2);
  assert.equal(found.snippets.length, 2);
  assert.match(found.snippets[0], /Midterm covers/);
  assert.ok(found.snippets[1].startsWith("…"));
  assert.deepEqual(snippetAround(text, "physics"), { count: 0, snippets: [] });
  assert.equal(snippetAround("a a a a a", "a", { max: 2 }).snippets.length, 2);
});

test("selectTabs picks by number, text or all", () => {
  const tabs = [
    { title: "Canvas", url: "https://canvas.rice.edu/" },
    { title: "Quizlet - Bio", url: "https://quizlet.com/1" },
    { title: "Anki", url: "https://ankiweb.net/" },
  ];
  assert.deepEqual(selectTabs(tabs, ["2"]).map(t => t.title), ["Quizlet - Bio"]);
  assert.deepEqual(selectTabs(tabs, ["anki", "1"]).map(t => t.title), ["Canvas", "Anki"]);
  assert.deepEqual(selectTabs(tabs, ["rice.edu"]).map(t => t.title), ["Canvas"]);
  assert.equal(selectTabs(tabs, ["all"]).length, 3);
  assert.deepEqual(selectTabs(tabs, ["9", "nothing"]), []);
});

test("a shared space round-trips through a code with fresh ids", () => {
  const space = {
    id: "{mine}",
    name: "rice",
    icon: null,
    folders: [{ id: "f1", name: "Bio", parentId: null }],
    tabs: [
      { id: "t1", title: "Canvas", url: "https://canvas.rice.edu/?token=SECRET", pinned: true },
      { id: "t2", title: "Notes", url: "https://docs.google.com/x", pinned: true, folderId: "f1" },
      { id: "t3", title: "Local", url: "file:///Users/me/notes.txt", pinned: false },
    ],
  };
  const shared = toSharedSpace(space);
  assert.equal(JSON.stringify(shared).includes("{mine}"), false, "no local ids");
  const code = encodeShareCode(shared);
  assert.match(code, /^commit-space:[A-Za-z0-9_-]+$/);
  const back = decodeShareCode(code);
  assert.deepEqual(back, shared);
  const snapshot = fromSharedSpace(back, { id: "{friend}", name: "rice" }, "imp1");
  const [s] = snapshot.spaces;
  assert.equal(s.id, "{friend}");
  assert.equal(s.tabs.length, 2, "file: URLs are dropped");
  assert.equal(s.tabs[0].url, "https://canvas.rice.edu/", "secrets are stripped");
  assert.equal(s.tabs[1].folderId, s.folders[0].id);
  assert.ok(s.tabs.every(t => t.id.startsWith("imp1-")));
  assert.equal(decodeShareCode("hello"), null);
  assert.throws(() => fromSharedSpace({ format: "other" }, { id: "x", name: "y" }, "p"));
});

test("durations, countdowns and focus blocking", () => {
  assert.equal(parseDuration("25m"), 25 * 60000);
  assert.equal(parseDuration("1h"), 60 * 60000);
  assert.equal(parseDuration("1h30m"), 90 * 60000);
  assert.equal(parseDuration("90"), 90 * 60000);
  assert.equal(parseDuration("youtube.com"), 0);
  assert.equal(formatCountdown(24 * 60000 + 5000), "24:05");
  assert.equal(formatCountdown(65 * 60000), "1h 05m");
  const rules = focusRules(["youtube.com", "www.reddit.com", "https://x.com/home"]);
  assert.equal(isIgnored("https://www.youtube.com/watch?v=1", rules), true);
  assert.equal(isIgnored("https://m.youtube.com/", rules), true);
  assert.equal(isIgnored("https://reddit.com/r/nfl", rules), true);
  assert.equal(isIgnored("https://x.com/", rules), true);
  assert.equal(isIgnored("https://canvas.rice.edu/", rules), false);
  assert.equal(isIgnored("https://notyoutube.com/", rules), false);
});

test("processRows groups tabs by process and measures CPU", async () => {
  const { processRows, formatBytes } = await import("../ZenGitModel.sys.mjs");
  const MB = 1024 * 1024;
  const before = {
    pid: 1, memory: 300 * MB, cpuTime: 0,
    children: [
      { pid: 10, memory: 400 * MB, cpuTime: 0 },
      { pid: 11, memory: 120 * MB, cpuTime: 0 },
      { pid: 12, memory: 80 * MB, cpuTime: 0 },
    ],
  };
  const after = {
    pid: 1, memory: 310 * MB, cpuTime: 50e6,
    children: [
      { pid: 10, memory: 420 * MB, cpuTime: 250e6 },
      { pid: 11, memory: 120 * MB, cpuTime: 10e6 },
      { pid: 12, memory: 90 * MB, cpuTime: 0 },
      { pid: 13, memory: 50 * MB, cpuTime: 5e6 },
    ],
  };
  const tabsByPid = new Map([[10, [{ label: "YouTube" }]], [11, [{ label: "Canvas" }, { label: "Banner" }]]]);
  const { rows, total } = processRows(before, after, 1000, tabsByPid);
  assert.deepEqual(rows.map(r => r.tabs.length), [1, 2, 0], "biggest first, Commit itself last");
  assert.equal(Math.round(rows[0].cpu), 25);
  assert.equal(rows[2].memory, (310 + 90 + 50) * MB, "processes without tabs fold into Commit itself");
  assert.equal(total, (310 + 420 + 120 + 90 + 50) * MB);
  const byCpu = processRows(before, after, 1000, tabsByPid, { sortBy: "cpu" });
  assert.equal(byCpu.rows[0].tabs[0].label, "YouTube");
  assert.equal(formatBytes(412 * MB), "412 MB");
  assert.equal(formatBytes(1331 * MB), "1.3 GB");
});
