/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  archiveAfterMs,
  formatAge,
  isArchivable,
} from "../ZenTabArchiveModel.sys.mjs";

const HOUR = 60 * 60 * 1000;
const now = 1_800_000_000_000;
const after = archiveAfterMs(12);

test("archiveAfterMs turns hours into ms and treats bad values as off", () => {
  assert.equal(after, 12 * HOUR);
  assert.equal(archiveAfterMs(0), 0);
  assert.equal(archiveAfterMs(-5), 0);
  assert.equal(archiveAfterMs("nope"), 0);
  assert.equal(archiveAfterMs(0.5), HOUR / 2);
});

test("a loose tab is archived once it has gone unseen long enough", () => {
  const tab = { lastAccessed: now - 13 * HOUR };
  assert.equal(isArchivable(tab, now, after), true);
  assert.equal(
    isArchivable({ lastAccessed: now - 11 * HOUR }, now, after),
    false
  );
  assert.equal(
    isArchivable({ lastAccessed: now - 12 * HOUR }, now, after),
    true
  );
});

test("pinned, Essentials, folders, in-use and empty tabs are kept", () => {
  const old = now - 100 * HOUR;
  for (const flag of ["pinned", "essential", "inGroup", "inUse", "empty"]) {
    assert.equal(
      isArchivable({ lastAccessed: old, [flag]: true }, now, after),
      false,
      flag
    );
  }
});

test("the selected tab and unknown ages are never archived", () => {
  assert.equal(isArchivable({ lastAccessed: Infinity }, now, after), false);
  assert.equal(isArchivable({ lastAccessed: 0 }, now, after), false);
  assert.equal(isArchivable({}, now, after), false);
});

test("nothing is archived when archiving is off", () => {
  assert.equal(
    isArchivable({ lastAccessed: now - 100 * HOUR }, now, 0),
    false
  );
});

test("formatAge", () => {
  assert.equal(formatAge(45 * 60000), "45m");
  assert.equal(formatAge(13 * HOUR), "13h");
  assert.equal(formatAge(72 * HOUR), "3d");
  assert.equal(formatAge(-5), "0m");
});
