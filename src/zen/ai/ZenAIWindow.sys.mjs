/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// "Catch me up": come back to a space after a while and a card at the top
// of the sidebar says what you were doing there, where you left off and
// what's unfinished. Built from the space's commit messages and tab titles
// (never page text). Also the console's `catchup`.

import { ZenAI } from "resource:///modules/zen/ai/ZenAI.sys.mjs";
import {
  awayFor,
  catchUpLines,
  catchUpRequest,
  checkStop,
  textOf,
} from "resource:///modules/zen/ai/ZenAIModel.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ZenGitManager: "resource:///modules/zen/git/ZenGitManager.sys.mjs",
  formatDiff: "resource:///modules/zen/git/ZenGitModel.sys.mjs",
});

const HTML_NS = "http://www.w3.org/1999/xhtml";
const ENABLED_PREF = "zen.ai.catch-up.enabled";
const AFTER_PREF = "zen.ai.catch-up.after-hours";
const SEEN_PREF = "zen.ai.catch-up.seen";

// When each space was last on screen, shared by every window and kept
// across restarts: { spaceId: ms }.
function readSeen() {
  try {
    return JSON.parse(Services.prefs.getStringPref(SEEN_PREF, "{}")) || {};
  } catch {
    return {};
  }
}

function markSeen(spaceId, at = Date.now()) {
  if (!spaceId) {
    return;
  }
  const seen = readSeen();
  seen[spaceId] = at;
  Services.prefs.setStringPref(SEEN_PREF, JSON.stringify(seen));
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Writes the three catch-up lines for the window's current space.
 *
 * @param {Window} window
 * @param {object} [options]
 * @param {number} [options.awayMs] - How long you were away, for the prompt.
 * @returns {Promise<string[]>}
 */
export async function catchUp(window, { awayMs = 0 } = {}) {
  const { ZenGitManager, formatDiff } = lazy;
  const { repo, space } = await ZenGitManager.activeSpaceRepo(window);
  const commits = (await repo.log(8)).map(e => `${e.when}: ${e.subject}`);
  const { status, hasHead } = await ZenGitManager.spaceStatus(window);
  const changes = hasHead ? formatDiff(status) : [];
  const spaces = window.gZenWorkspaces;
  const tabs = spaces.allStoredTabs
    .filter(
      tab =>
        tab.getAttribute("zen-workspace-id") == space.uuid &&
        !tab.hasAttribute("zen-essential") &&
        !tab.hasAttribute("zen-empty-tab") &&
        !tab.hasAttribute("zen-glance-tab")
    )
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
    .slice(0, 25)
    .map(tab => {
      const host = hostOf(tab.linkedBrowser?.currentURI?.spec);
      return `${tab.label}${host ? ` — ${host}` : ""}`;
    });
  if (!tabs.length && !commits.length) {
    return [];
  }
  const { message } = await ZenAI.send({
    ...catchUpRequest({
      spaceName: space.name,
      away: awayMs ? awayFor(awayMs) : "a while",
      commits,
      tabs,
      changes,
    }),
    effort: "low",
    maxTokens: 4000,
  });
  checkStop(message);
  return catchUpLines(textOf(message));
}

const STYLE = `
#zen-catch-up {
  position: fixed; z-index: 2147483000;
  display: none; flex-direction: column; gap: 4px;
  padding: 10px 12px 11px; border-radius: 12px;
  font: menu; font-size: 12px; line-height: 1.35;
  color: #f5f5f7; background: color-mix(in srgb, #1c1c1e 88%, transparent);
  backdrop-filter: blur(18px) saturate(160%);
  box-shadow: 0 8px 24px rgba(0,0,0,.32), inset 0 0 0 1px rgba(255,255,255,.08);
  cursor: default;
}
#zen-catch-up[open] { display: flex; }
#zen-catch-up .title {
  display: flex; justify-content: space-between; align-items: center;
  font-weight: 600; font-size: 11px; letter-spacing: .02em; opacity: .7;
}
#zen-catch-up .close {
  border: 0; background: none; color: inherit; font: inherit; font-size: 14px;
  line-height: 1; padding: 0 2px; cursor: pointer; opacity: .8;
}
#zen-catch-up .line { opacity: .95; }
#zen-catch-up[loading] .line { opacity: .55; font-style: italic; }
`;

export class ZenAIWindow {
  #window;
  #card = null;
  #space = null;
  #request = 0;

  static create(window) {
    return new ZenAIWindow(window);
  }

  // For the console's `catchup` (lazy getters import the class by name).
  static catchUp(window, options) {
    return catchUp(window, options);
  }

  constructor(window) {
    this.#window = window;
    const doc = window.document;
    const style = doc.createElementNS(HTML_NS, "style");
    style.textContent = STYLE;
    doc.documentElement.append(style);
    this.#card = doc.createElementNS(HTML_NS, "div");
    this.#card.id = "zen-catch-up";
    doc.documentElement.append(this.#card);

    window.addEventListener("ZenWorkspacesUIUpdate", this);
    window.addEventListener("unload", () => markSeen(this.#space), { once: true });
    // Coming back to Commit after days away counts too.
    window.setTimeout(() => this.#onSpace(), 5000);
  }

  handleEvent(event) {
    if (event.type == "ZenWorkspacesUIUpdate") {
      this.#onSpace();
    }
  }

  async #onSpace() {
    const spaces = this.#window.gZenWorkspaces;
    const current = spaces?.activeWorkspace;
    if (!current || current == this.#space) {
      return;
    }
    markSeen(this.#space);
    this.#space = current;
    this.#hide();
    const last = readSeen()[current];
    markSeen(current);
    const away = last ? Date.now() - last : 0;
    const threshold = Services.prefs.getIntPref(AFTER_PREF, 12) * 3600000;
    if (
      !last ||
      away < threshold ||
      !Services.prefs.getBoolPref(ENABLED_PREF, true) ||
      !(await ZenAI.hasKey())
    ) {
      return;
    }
    const request = ++this.#request;
    const name = spaces.getActiveWorkspaceFromCache()?.name || "this space";
    this.#show(name, ["Catching you up…"], true);
    try {
      const lines = await catchUp(this.#window, { awayMs: away });
      if (request != this.#request || spaces.activeWorkspace != current) {
        return;
      }
      if (lines.length) {
        this.#show(name, lines, false);
      } else {
        this.#hide();
      }
    } catch (e) {
      console.error("Catch-up failed:", e);
      if (request == this.#request) {
        this.#hide();
      }
    }
  }

  #show(spaceName, lines, loading) {
    const doc = this.#window.document;
    const card = this.#card;
    const title = doc.createElementNS(HTML_NS, "div");
    title.className = "title";
    const label = doc.createElementNS(HTML_NS, "span");
    label.textContent = `Catch up · ${spaceName}`;
    const close = doc.createElementNS(HTML_NS, "button");
    close.className = "close";
    close.textContent = "×";
    close.title = "Dismiss";
    close.addEventListener("click", () => this.#hide());
    title.append(label, close);
    card.replaceChildren(
      title,
      ...lines.map(text => {
        const line = doc.createElementNS(HTML_NS, "div");
        line.className = "line";
        line.textContent = text;
        return line;
      })
    );
    card.toggleAttribute("loading", loading);
    this.#place();
    card.setAttribute("open", "");
  }

  // Over the top of the sidebar's tab list, or the top left if the
  // sidebar is collapsed.
  #place() {
    const toolbox = this.#window.document.getElementById("navigator-toolbox");
    const rect = toolbox?.getBoundingClientRect();
    const style = this.#card.style;
    if (rect && rect.width >= 180) {
      style.left = `${rect.left + 8}px`;
      style.top = `${rect.top + 56}px`;
      style.width = `${rect.width - 16 - 24}px`;
    } else {
      style.left = "12px";
      style.top = "48px";
      style.width = "300px";
    }
  }

  #hide() {
    this.#request++;
    this.#card.removeAttribute("open");
  }
}
