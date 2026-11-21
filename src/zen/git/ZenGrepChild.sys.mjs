/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Runs in each page for the console's `grep` (snippets around each match)
// and `ask` (the page's visible text).

import { snippetAround } from "resource:///modules/zen/git/ZenGitModel.sys.mjs";

export class ZenGrepChild extends JSWindowActorChild {
  receiveMessage({ name, data }) {
    const text = this.document?.body?.innerText || "";
    switch (name) {
      case "ZenGrep:Search":
        return snippetAround(text, data.query, { max: data.max ?? 2 });
      // The whole visible text, for the console's `ask`.
      case "ZenGrep:Text":
        return text.replace(/\n{3,}/g, "\n\n").slice(0, data.max ?? 100000);
    }
    return null;
  }
}
