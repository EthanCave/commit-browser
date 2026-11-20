/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Keeps the address bar's "Switch to tab" inside the space you're in. A page
// that is only open in another space shows up as a normal suggestion instead,
// so picking it opens it here rather than jumping to the other space.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  UrlbarShared: "chrome://browser/content/urlbar/UrlbarShared.mjs",
});

export const CURRENT_SPACE_ONLY_PREF = "zen.urlbar.switch-to-tab.current-space-only";

// Fields a TAB_SWITCH payload shares with a URL payload.
const URL_PAYLOAD_FIELDS = [
  "url",
  "title",
  "icon",
  "frecency",
  "lastVisit",
  "bookmarkDateMs",
  "isPinned",
  "isSponsored",
];

function spacesOf(window) {
  const spaces = window?.gZenWorkspaces;
  return spaces?.workspaceEnabled && spaces.activeWorkspace ? spaces : null;
}

/**
 * @param {Window} window
 * @param {MozTabbrowserTab} tab
 * @returns {boolean} Whether the tab shows in the window's current space.
 *   Essentials count when they show there; tabs with no space count too.
 */
export function isTabInActiveSpace(window, tab) {
  const spaces = spacesOf(window);
  if (!spaces) {
    return true;
  }
  if (
    !tab.hasAttribute("zen-workspace-id") &&
    !tab.hasAttribute("zen-essential")
  ) {
    return true;
  }
  const space = spaces.getActiveWorkspaceFromCache();
  return spaces._shouldShowTab(
    tab,
    spaces.activeWorkspace,
    space?.containerTabId,
    spaces.getWorkspaces()
  );
}

/**
 * Orders a window's browsers so tabs in the current space come first, so
 * "switch to a tab with this URL" picks the one here when there are several.
 *
 * @param {Window} window
 * @param {XULBrowserElement[]} browsers
 * @returns {XULBrowserElement[]}
 */
export function activeSpaceFirst(window, browsers) {
  if (!spacesOf(window)) {
    return browsers;
  }
  const here = [];
  const elsewhere = [];
  for (const browser of browsers) {
    const tab = window.gBrowser.getTabForBrowser(browser);
    (tab && !isTabInActiveSpace(window, tab) ? elsewhere : here).push(browser);
  }
  return [...here, ...elsewhere];
}

function isOpenInActiveSpace(window, url, userContextId) {
  for (const tab of window.gBrowser.tabs) {
    if (tab.closing || !isTabInActiveSpace(window, tab)) {
      continue;
    }
    const uri = tab.linkedBrowser?.currentURI;
    if (!uri || (uri.spec != url && uri.displaySpec != url)) {
      continue;
    }
    if (userContextId != null && (tab.userContextId || 0) != userContextId) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Called for every address bar result before it is added.
 *
 * @param {UrlbarResult} result
 * @param {Window} window - The browser window the query runs in, if known.
 * @param {object} [searchMode] - The query's search mode.
 * @returns {UrlbarResult|null} The result to use, or null to drop it.
 */
export function keepTabSwitchInSpace(result, window, searchMode) {
  const { RESULT_TYPE, RESULT_SOURCE } = lazy.UrlbarShared;
  if (
    result.type != RESULT_TYPE.TAB_SWITCH ||
    !spacesOf(window) ||
    !Services.prefs.getBoolPref(CURRENT_SPACE_ONLY_PREF, true)
  ) {
    return result;
  }
  const { payload } = result;
  if (isOpenInActiveSpace(window, payload.url, payload.userContext?.id)) {
    return result;
  }
  // In tab search mode (%) a plain page suggestion would be out of place.
  if (searchMode?.source == RESULT_SOURCE.TABS) {
    return null;
  }
  const urlPayload = {};
  for (const field of URL_PAYLOAD_FIELDS) {
    if (payload[field] != undefined) {
      urlPayload[field] = payload[field];
    }
  }
  return result.constructor.fromWire({
    ...result.toWire(),
    type: RESULT_TYPE.URL,
    source: payload.bookmarkDateMs
      ? RESULT_SOURCE.BOOKMARKS
      : RESULT_SOURCE.HISTORY,
    payload: urlPayload,
  });
}

// Lazy getters (XPCOMUtils.declareLazy / defineESModuleGetters) import the
// export whose name matches the key, so callers use this object.
export const ZenUrlbarSpaceTabs = {
  activeSpaceFirst(window, browsers) {
    try {
      return activeSpaceFirst(window, browsers);
    } catch (e) {
      console.error(e);
      return browsers;
    }
  },
  isTabInActiveSpace,
  // A bug here must never empty the address bar, so fall back to the
  // unchanged result.
  keepTabSwitchInSpace(result, window, searchMode) {
    try {
      return keepTabSwitchInSpace(result, window, searchMode);
    } catch (e) {
      console.error(e);
      return result;
    }
  },
};
