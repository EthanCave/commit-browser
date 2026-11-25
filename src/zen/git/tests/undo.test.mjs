/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Undo, redo and the reflog: the parts that don't touch the browser.
// Run with: node --test src/zen/git/tests/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  addToLog,
  combineUndo,
  describeRestore,
  layoutPart,
  pickRedo,
  pickUndo,
  planCheckout,
  undoEntry,
  updateEntries,
  wholeScope,
} from "../ZenGitModel.sys.mjs";

const tab = (id, url, extra = {}) => ({ id, title: id, url, pinned: false, ...extra });
const space = (id, tabs, folders = []) => ({ id, name: id.toUpperCase(), icon: null, folders, tabs });
const snapshot = (spaces, essentials = []) => ({ version: 1, essentials, spaces });

const full = snapshot(
  [
    space("work", [tab("t1", "https://a.com"), tab("t2", "https://b.com")]),
    space("home", [tab("t3", "https://c.com")]),
  ],
  [tab("e1", "https://mail.com", { pinned: true })]
);

let ids = 0;
const entry = (scope, before, extra = {}) =>
  undoEntry({
    id: `id${++ids}`,
    at: ids,
    label: `change ${ids}`,
    summary: "closed 1 tab",
    point: { scope, before: layoutPart(before, scope), branches: extra.branches || {}, names: [] },
    ...extra,
  });

test("layoutPart keeps only the spaces (and Essentials) in scope", () => {
  const part = layoutPart(full, { spaceIds: ["home"], essentials: false });
  assert.deepEqual(part.spaces.map(s => s.id), ["home"]);
  assert.deepEqual(part.essentials, []);
  const both = layoutPart(full, wholeScope(full));
  assert.deepEqual(both.spaces.map(s => s.id), ["work", "home"]);
  assert.equal(both.essentials.length, 1);
  // A space that doesn't exist yet is simply missing.
  assert.deepEqual(layoutPart(full, { spaceIds: ["new"] }).spaces, []);
});

test("undo picks the newest changes that aren't undone", () => {
  let log = [];
  const a = entry({ spaceIds: ["work"] }, full);
  const b = entry({ spaceIds: ["home"] }, full);
  log = addToLog(addToLog(log, a), b);
  assert.deepEqual(pickUndo(log).map(e => e.id), [b.id]);
  assert.deepEqual(pickUndo(log, 5).map(e => e.id), [b.id, a.id]);
  log = updateEntries(log, [b.id], { undone: true });
  assert.deepEqual(pickUndo(log).map(e => e.id), [a.id]);
  // Undo and redo entries are never undone themselves.
  log = addToLog(log, { ...entry({ spaceIds: [] }, full), kind: "undo" });
  assert.deepEqual(pickUndo(log).map(e => e.id), [a.id]);
});

test("the log keeps the newest entries", () => {
  let log = [];
  for (let i = 0; i < 40; i++) {
    log = addToLog(log, { id: i }, 30);
  }
  assert.equal(log.length, 30);
  assert.equal(log[0].id, 39);
});

test("redo reverses the newest undo until a new change happens", () => {
  const change = { id: "c", kind: "change" };
  const undo1 = { id: "u1", kind: "undo", undoes: ["c"], redone: false };
  assert.equal(pickRedo([undo1, change]), undo1);
  assert.equal(pickRedo([{ id: "r", kind: "redo" }, { ...undo1, redone: true }, change]), null);
  const undo2 = { id: "u2", kind: "undo", undoes: ["d"], redone: false };
  assert.equal(
    pickRedo([{ id: "r", kind: "redo" }, { ...undo2, redone: true }, undo1, change]),
    undo1
  );
  assert.equal(pickRedo([{ id: "new", kind: "change" }, undo1, change]), null);
  assert.equal(pickRedo([]), null);
});

test("undoing several changes restores each space from the oldest one", () => {
  const before1 = full;
  // After change 1, t2 was closed; change 2 then moved t1 to home.
  const after1 = snapshot(
    [space("work", [tab("t1", "https://a.com")]), space("home", [tab("t3", "https://c.com")])],
    full.essentials
  );
  const older = entry({ spaceIds: ["work"] }, before1);
  const newer = entry({ spaceIds: ["work", "home"] }, after1);
  const { scope, target } = combineUndo([newer, older]);
  assert.deepEqual(scope.spaceIds.sort(), ["home", "work"]);
  assert.equal(scope.essentials, false);
  const work = target.spaces.find(s => s.id === "work");
  assert.deepEqual(work.tabs.map(t => t.id), ["t1", "t2"]);
  const home = target.spaces.find(s => s.id === "home");
  assert.deepEqual(home.tabs.map(t => t.id), ["t3"]);
});

test("a space a change created is emptied, and Essentials come back", () => {
  const made = entry({ spaceIds: ["new"], essentials: true }, full);
  const { scope, target } = combineUndo([made]);
  assert.deepEqual(scope, { spaceIds: ["new"], essentials: true });
  assert.deepEqual(target.spaces, []);
  assert.deepEqual(target.essentials.map(t => t.id), ["e1"]);
});

test("branches come from the oldest change that saved one", () => {
  const older = entry({ spaceIds: ["work"] }, full, { branches: { work: "main" } });
  const newer = entry({ spaceIds: ["work"] }, full, { branches: { work: "trip" } });
  const pipe = entry({ spaceIds: ["work"] }, full);
  assert.deepEqual(combineUndo([newer, older]).branches, { work: "main" });
  assert.deepEqual(combineUndo([pipe, newer]).branches, { work: "trip" });
  assert.deepEqual(combineUndo([pipe]).branches, {});
});

test("describeRestore says what undo did", () => {
  const now = snapshot([space("work", [tab("t1", "https://a.com/x"), tab("t9", "https://z.com")])]);
  const was = snapshot([
    space("work", [tab("t1", "https://a.com"), tab("t2", "https://b.com"), tab("t3", "https://c.com", { pinned: true })]),
  ]);
  assert.equal(
    describeRestore(planCheckout(now, was)),
    "reopened 2 tabs, closed 1 tab, sent 1 tab back to their old page"
  );
  assert.equal(describeRestore(planCheckout(was, was)), "nothing needed to change");
});

test("entries are plain JSON, so the log survives a restart", () => {
  const e = entry({ spaceIds: ["work"], essentials: true }, full, { note: "hi" });
  assert.deepEqual(JSON.parse(JSON.stringify(e)), e);
  assert.equal(e.kind, "change");
  assert.equal(e.undone, false);
  assert.equal(e.note, "hi");
});
