/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Arc-style auto-archive: loose tabs you haven't looked at for a while
// (12 hours by default) close by themselves. They are closed the normal way,
// so they land in Library › History with the "Closed tabs" filter (shown as
// "Archive"), where one click puts a tab back with its history.

import { ZenUIComponent } from "resource:///modules/zen/ui/ZenUIComponent.sys.mjs";
import {
  DEFAULT_AFTER_HOURS,
  archiveAfterMs,
  isArchivable,
} from "./ZenTabArchiveModel.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

export const ENABLED_PREF = "zen.tabs.auto-archive.enabled";
export const AFTER_HOURS_PREF = "zen.tabs.auto-archive.after-hours";

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
// Give session restore time to finish before the first sweep.
const FIRST_CHECK_DELAY_MS = 60 * 1000;

const archivers = new WeakMap();

export class ZenTabArchiver extends ZenUIComponent {
  #firstCheck = null;
  #interval = null;

  /**
   * @param {Window} window
   * @returns {ZenTabArchiver|null} The archiver of a browser window.
   */
  static forWindow(window) {
    return archivers.get(window) ?? null;
  }

  static get enabled() {
    return Services.prefs.getBoolPref(ENABLED_PREF, true);
  }

  static get afterHours() {
    return Services.prefs.getIntPref(AFTER_HOURS_PREF, DEFAULT_AFTER_HOURS);
  }

  init() {
    const { window } = this;
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(window)) {
      return;
    }
    archivers.set(window, this);
    this.#firstCheck = window.setTimeout(
      () => this.archiveStaleTabs(),
      FIRST_CHECK_DELAY_MS
    );
    this.#interval = window.setInterval(
      () => this.archiveStaleTabs(),
      CHECK_INTERVAL_MS
    );
  }

  uninit() {
    this.window.clearTimeout(this.#firstCheck);
    this.window.clearInterval(this.#interval);
    archivers.delete(this.window);
  }

  /**
   * @param {MozTabbrowserTab} tab
   * @returns {object} What isArchivable needs to know about a tab.
   */
  #describe(tab) {
    return {
      lastAccessed: tab.lastAccessed,
      pinned: tab.pinned,
      essential: tab.hasAttribute("zen-essential"),
      inGroup: !!tab.group,
      inUse:
        tab.selected ||
        tab.multiselected ||
        tab.closing ||
        tab.soundPlaying ||
        tab.hasAttribute("pictureinpicture") ||
        tab.hasAttribute("sharing") ||
        tab.hasAttribute("zen-glance-tab") ||
        tab.hasAttribute("busy"),
      empty: tab.hasAttribute("zen-empty-tab"),
    };
  }

  /**
   * The tabs the next sweep would archive, ignoring whether archiving is on.
   *
   * @param {number} [now]
   * @param {number} [afterHours]
   * @returns {MozTabbrowserTab[]}
   */
  staleTabs(now = Date.now(), afterHours = ZenTabArchiver.afterHours) {
    const afterMs = archiveAfterMs(afterHours);
    return this.window.gBrowser.tabs.filter(tab =>
      isArchivable(this.#describe(tab), now, afterMs)
    );
  }

  /**
   * Closes every stale tab in this window.
   *
   * @param {object} [options]
   * @param {boolean} [options.force] - Run even when archiving is off.
   * @returns {number} How many tabs were archived.
   */
  archiveStaleTabs({ force = false } = {}) {
    if (!force && !ZenTabArchiver.enabled) {
      return 0;
    }
    const stale = this.staleTabs();
    if (!stale.length) {
      return 0;
    }
    const { gBrowser, gZenUIManager } = this.window;
    // skipPermitUnload: nobody is there to answer a "leave page?" prompt.
    // The session store keeps form data, so restoring brings it back.
    gBrowser.removeTabs(stale, {
      animate: false,
      skipPermitUnload: true,
    });
    gZenUIManager?.showToast("zen-tabs-archived-toast", {
      l10nArgs: { count: stale.length },
      descriptionId: "zen-tabs-archived-toast-description",
      timeout: 5000,
    });
    return stale.length;
  }
}
