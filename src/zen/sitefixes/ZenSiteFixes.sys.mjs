/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Small per-site style fixes for pages that look broken in Gecko but fine in
// Chrome. They are registered once as a user stylesheet, so they apply to
// every tab, and each fix is scoped to the pages it is meant for.

export const ENABLED_PREF = "zen.site-fixes.enabled";

const FIXES_CSS = `
/* Google Search / AI Mode: the logo box is position: sticky (top: 37px;
 * left: 18.5px) inside a position: fixed header. Gecko ignores the sticky
 * offsets there, so the logo sat in the page's top-left corner. Absolute
 * positioning puts it where Chrome does, next to the "AI Mode" tabs. */
@-moz-document url-prefix("https://www.google.com/search") {
  .RHL8Vb .VHYc8b {
    position: absolute !important;
  }
}
`;

const SHEET_URI = Services.io.newURI(
  "data:text/css;charset=utf-8," + encodeURIComponent(FIXES_CSS)
);

function sheetService() {
  return Cc["@mozilla.org/content/style-sheet-service;1"].getService(
    Ci.nsIStyleSheetService
  );
}

function update() {
  const sss = sheetService();
  const registered = sss.sheetRegistered(SHEET_URI, sss.USER_SHEET);
  const enabled = Services.prefs.getBoolPref(ENABLED_PREF, true);
  if (enabled && !registered) {
    sss.loadAndRegisterSheet(SHEET_URI, sss.USER_SHEET);
  } else if (!enabled && registered) {
    sss.unregisterSheet(SHEET_URI, sss.USER_SHEET);
  }
}

let initialized = false;

export const ZenSiteFixes = {
  // Called for each new browser window; only the first call does anything.
  create() {
    if (initialized) {
      return;
    }
    initialized = true;
    update();
    Services.prefs.addObserver(ENABLED_PREF, update);
  },
};
