/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Focus mode (`focus 25m` in the console): until the timer runs out,
// distracting sites are blocked, you stay in the space you started in, and a
// pill counts down. The state lives in prefs, so it survives a restart and
// every window follows it.

import {
  focusRules,
  formatCountdown,
  isIgnored,
} from "resource:///modules/zen/git/ZenGitModel.sys.mjs";

const UNTIL_PREF = "zen.focus.until"; // ms since epoch, as a string
const SPACE_PREF = "zen.focus.space";
const SITES_PREF = "zen.focus.sites"; // this session's list
const BLOCKLIST_PREF = "zen.focus.blocklist"; // the default list
const DEFAULT_BLOCKLIST =
  "youtube.com, instagram.com, reddit.com, netflix.com, x.com, tiktok.com, twitch.tv, facebook.com";
const HTML_NS = "http://www.w3.org/1999/xhtml";

const splitSites = text =>
  (text || "")
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean);

export const ZenFocus = {
  get until() {
    return Number(Services.prefs.getStringPref(UNTIL_PREF, "0")) || 0;
  },

  get active() {
    return this.until > Date.now();
  },

  get spaceId() {
    return Services.prefs.getStringPref(SPACE_PREF, "");
  },

  get defaultSites() {
    return splitSites(
      Services.prefs.getStringPref(BLOCKLIST_PREF, DEFAULT_BLOCKLIST)
    );
  },

  get sites() {
    const session = splitSites(Services.prefs.getStringPref(SITES_PREF, ""));
    return session.length ? session : this.defaultSites;
  },

  /**
   * @param {string} spaceId The space to stay in.
   * @param {number} ms How long.
   * @param {string[]} [sites] Sites to block instead of the default list.
   */
  start(spaceId, ms, sites = []) {
    Services.prefs.setStringPref(SITES_PREF, sites.join(", "));
    Services.prefs.setStringPref(SPACE_PREF, spaceId);
    Services.prefs.setStringPref(UNTIL_PREF, String(Date.now() + ms));
  },

  stop() {
    Services.prefs.setStringPref(UNTIL_PREF, "0");
  },

  /** @returns {boolean} Whether focus mode blocks this URL right now. */
  blocks(url) {
    return this.active && isIgnored(url, focusRules(this.sites));
  },
};

function blockedPage(url, until) {
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {}
  const time = new Date(until).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const esc = s => String(s).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><meta charset="utf-8"><title>Focusing</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; height: 100vh; display: grid; place-items: center;
    font: 15px -apple-system, system-ui, sans-serif;
    background: light-dark(#f5f5f7, #161618); color: light-dark(#1d1d1f, #f5f5f7); }
  .card { text-align: center; }
  .pill { display: inline-block; padding: 4px 12px; border-radius: 999px;
    background: light-dark(#e8e8ed, #2c2c2e); font-size: 12px; opacity: .8; }
  h1 { font-size: 28px; font-weight: 600; margin: 14px 0 6px; }
  p { margin: 0; opacity: .7; }
</style>
<div class="card"><span class="pill">Focus mode</span>
<h1>${esc(host)} can wait.</h1>
<p>It's blocked until ${esc(time)}. <code>focus off</code> in the console ends it early.</p></div>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

const STYLE = `
#zen-focus-pill {
  position: fixed; bottom: 14px; right: 16px; z-index: 2147483000;
  display: none; align-items: center; gap: 8px;
  padding: 6px 12px; border-radius: 999px;
  font: menu; font-size: 12px; font-variant-numeric: tabular-nums;
  color: #f5f5f7; background: color-mix(in srgb, #1c1c1e 82%, transparent);
  backdrop-filter: blur(18px) saturate(160%);
  box-shadow: 0 6px 18px rgba(0,0,0,.3), inset 0 0 0 1px rgba(255,255,255,.08);
  pointer-events: none;
}
#zen-focus-pill::before {
  content: ""; width: 7px; height: 7px; border-radius: 50%;
  background: #ff9f0a; box-shadow: 0 0 6px #ff9f0a;
}
:root[zen-focus] #zen-focus-pill { display: flex; }
:root[zen-focus] #zen-workspaces-button { opacity: 0.35; pointer-events: none; }
`;

export class ZenFocusWindow {
  #window;
  #pill = null;
  #ticker = null;
  #nudgeUntil = 0;

  static create(window) {
    return new ZenFocusWindow(window);
  }

  constructor(window) {
    this.#window = window;
    const doc = window.document;
    const style = doc.createElementNS(HTML_NS, "style");
    style.textContent = STYLE;
    doc.documentElement.append(style);
    this.#pill = doc.createElementNS(HTML_NS, "div");
    this.#pill.id = "zen-focus-pill";
    doc.documentElement.append(this.#pill);

    Services.prefs.addObserver("zen.focus.", this);
    window.gBrowser.addTabsProgressListener(this);
    window.gBrowser.tabContainer.addEventListener("TabSelect", this);
    window.addEventListener("ZenWorkspacesUIUpdate", this);
    window.addEventListener("unload", () => this.#uninit(), { once: true });
    this.#update();
  }

  #uninit() {
    Services.prefs.removeObserver("zen.focus.", this);
    this.#window.clearInterval(this.#ticker);
  }

  observe() {
    this.#update();
  }

  #update() {
    const root = this.#window.document.documentElement;
    if (!ZenFocus.active) {
      root.removeAttribute("zen-focus");
      this.#window.clearInterval(this.#ticker);
      this.#ticker = null;
      return;
    }
    root.setAttribute("zen-focus", "true");
    this.#tick();
    this.#ticker ??= this.#window.setInterval(() => this.#tick(), 1000);
    this.#checkBrowser(this.#window.gBrowser.selectedBrowser);
    this.#stayInSpace();
  }

  #tick() {
    const left = ZenFocus.until - Date.now();
    if (left <= 0) {
      ZenFocus.stop();
      return;
    }
    const nudging = Date.now() < this.#nudgeUntil;
    this.#pill.textContent = nudging
      ? `Stay focused · ${formatCountdown(left)} left`
      : `Focus · ${formatCountdown(left)}`;
  }

  #checkBrowser(browser) {
    const url = browser?.currentURI?.spec;
    if (url && ZenFocus.blocks(url)) {
      browser.fixupAndLoadURIString(blockedPage(url, ZenFocus.until), {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
    }
  }

  #stayInSpace() {
    const spaces = this.#window.gZenWorkspaces;
    const target = ZenFocus.spaceId;
    if (
      target &&
      spaces?.activeWorkspace &&
      spaces.activeWorkspace !== target &&
      spaces.getWorkspaces().some(s => s.uuid === target)
    ) {
      this.#nudgeUntil = Date.now() + 3000;
      spaces.changeWorkspaceWithID(target).catch(console.error);
      this.#tick();
    }
  }

  // Tabs progress listener
  onLocationChange(browser, webProgress, request, location) {
    if (webProgress?.isTopLevel && ZenFocus.blocks(location?.spec)) {
      this.#checkBrowser(browser);
    }
  }

  handleEvent(event) {
    if (!ZenFocus.active) {
      return;
    }
    if (event.type === "TabSelect") {
      this.#checkBrowser(event.target.linkedBrowser);
    } else if (event.type === "ZenWorkspacesUIUpdate") {
      this.#stayInSpace();
    }
  }
}
