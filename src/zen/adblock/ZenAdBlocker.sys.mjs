/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Commit's built-in ad blocker is uBlock Origin, installed from
// addons.mozilla.org on first launch (signed, and updated by Firefox like any
// add-on) rather than a home-made blocker: keeping up with filter lists and
// anti-adblock tricks is the hard part, and uBO's maintainers do it daily.
//
// It is installed once. If you remove it, it stays removed; flip
// zen.adblock.installed back to false to have it installed again.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  ExtensionPermissions: "resource://gre/modules/ExtensionPermissions.sys.mjs",
});

export const UBLOCK_ID = "uBlock0@raymondhill.net";
const UBLOCK_URL =
  "https://addons.mozilla.org/firefox/downloads/latest/ublock-origin/latest.xpi";
// CustomizableUI's id for an extension's toolbar button (see makeWidgetId).
const UBLOCK_WIDGET =
  UBLOCK_ID.toLowerCase().replace(/[^a-z0-9_-]/g, "_") + "-browser-action";

const ENABLED_PREF = "zen.adblock.enabled";
const INSTALLED_PREF = "zen.adblock.installed";
const PINNED_PREF = "zen.adblock.pinned";

let started = false;

async function allowInPrivateWindows() {
  await lazy.ExtensionPermissions.add(UBLOCK_ID, {
    permissions: ["internal:privateBrowsingAllowed"],
    origins: [],
  });
}

// Next to reload in the sidebar's top row, once; after that it's yours to
// move or hide.
function pinButton() {
  if (Services.prefs.getBoolPref(PINNED_PREF, false)) {
    return;
  }
  const { CustomizableUI } = lazy;
  if (!CustomizableUI.getPlacementOfWidget(UBLOCK_WIDGET)?.area?.startsWith("nav-bar")) {
    const reload = CustomizableUI.getPlacementOfWidget("stop-reload-button");
    CustomizableUI.addWidgetToArea(
      UBLOCK_WIDGET,
      CustomizableUI.AREA_NAVBAR,
      reload?.area === CustomizableUI.AREA_NAVBAR ? reload.position + 1 : undefined
    );
  }
  Services.prefs.setBoolPref(PINNED_PREF, true);
}

async function ensureInstalled() {
  const { AddonManager } = lazy;
  const existing = await AddonManager.getAddonByID(UBLOCK_ID);
  if (existing) {
    Services.prefs.setBoolPref(INSTALLED_PREF, true);
    pinButton();
    return;
  }
  if (Services.prefs.getBoolPref(INSTALLED_PREF, false)) {
    // Installed before and removed since: respect that.
    return;
  }
  const install = await AddonManager.getInstallForURL(UBLOCK_URL, {
    telemetryInfo: { source: "internal" },
  });
  const addon = await install.install();
  if (!addon) {
    throw new Error(`uBlock Origin install ended in state ${install.state}`);
  }
  await allowInPrivateWindows();
  if (addon.isActive) {
    // Picks up the private-window permission.
    await addon.reload();
  }
  Services.prefs.setBoolPref(INSTALLED_PREF, true);
  pinButton();
}

export const ZenAdBlocker = {
  // Called for each new browser window; only the first call does anything.
  create() {
    if (started || !Services.prefs.getBoolPref(ENABLED_PREF, true)) {
      return;
    }
    started = true;
    // A failed download (offline, say) is retried next launch.
    ensureInstalled().catch(e =>
      console.warn("Commit: could not set up uBlock Origin:", e)
    );
  },
};
