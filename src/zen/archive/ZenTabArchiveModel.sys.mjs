/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Rules for Arc-style auto-archiving, kept free of browser APIs so they can
// be tested with plain Node (see tests/model.test.mjs).

export const DEFAULT_AFTER_HOURS = 12;
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * @param {number} hours - How long a tab may go unseen, from the pref.
 * @returns {number} The same in milliseconds, or 0 when archiving is off.
 */
export function archiveAfterMs(hours) {
  const value = Number(hours);
  return Number.isFinite(value) && value > 0 ? value * MS_PER_HOUR : 0;
}

/**
 * Whether a tab should be archived. Like Arc, only loose tabs go: pinned
 * tabs, Essentials and anything in a folder or split view stay put, and so
 * does a tab that is in use (selected, playing, sharing, in a Glance).
 *
 * @param {object} tab
 * @param {number} tab.lastAccessed - When it was last looked at (ms since
 *   epoch). Firefox reports Infinity for the selected tab.
 * @param {boolean} [tab.pinned]
 * @param {boolean} [tab.essential]
 * @param {boolean} [tab.inGroup] - In a folder or split view.
 * @param {boolean} [tab.inUse]
 * @param {boolean} [tab.empty] - Zen's placeholder new-tab page.
 * @param {number} now
 * @param {number} afterMs - From archiveAfterMs; 0 disables archiving.
 * @returns {boolean}
 */
export function isArchivable(tab, now, afterMs) {
  if (!afterMs) {
    return false;
  }
  if (tab.pinned || tab.essential || tab.inGroup || tab.inUse || tab.empty) {
    return false;
  }
  const { lastAccessed } = tab;
  if (!Number.isFinite(lastAccessed) || lastAccessed <= 0) {
    return false;
  }
  return now - lastAccessed >= afterMs;
}

/**
 * @param {number} ms
 * @returns {string} A short age such as "45m", "13h" or "3d".
 */
export function formatAge(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}
