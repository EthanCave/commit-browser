/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Commit's connection to the Claude API: the key, the model, and sending
// requests. The features themselves live in the console (ZenGitConsole) and
// the catch-up card (ZenAIWindow).
//
// Nothing is sent unless a key is set. The key is kept in Commit's password
// store (Settings → Passwords), never in prefs or the console history.

import {
  API_URL,
  DEFAULT_MODELS,
  StreamAssembler,
  buildHeaders,
  buildRequest,
  costOf,
  describeError,
  parseSSE,
} from "resource:///modules/zen/ai/ZenAIModel.sys.mjs";

const MODEL_PREFS = { fast: "zen.ai.model.fast", smart: "zen.ai.model.smart" };
const KEY_ORIGIN = "chrome://commit-ai";
const KEY_REALM = "Anthropic API key";

function loginInfo(key) {
  const LoginInfo = Components.Constructor(
    "@mozilla.org/login-manager/loginInfo;1",
    Ci.nsILoginInfo,
    "init"
  );
  return new LoginInfo(KEY_ORIGIN, null, KEY_REALM, "anthropic", key, "", "");
}

function browserFetch(...args) {
  if (typeof fetch == "function") {
    return fetch(...args);
  }
  const window = Services.wm.getMostRecentWindow("navigator:browser");
  if (!window) {
    throw new Error("No browser window to send the request from.");
  }
  return window.fetch(...args);
}

class AI {
  #key = undefined;
  spent = 0;
  calls = 0;

  /**
   * @param {"fast"|"smart"} tier
   * @returns {string} The model for that tier.
   */
  model(tier = "fast") {
    return Services.prefs.getStringPref(MODEL_PREFS[tier], "") || DEFAULT_MODELS[tier];
  }

  setModel(tier, value) {
    Services.prefs.setStringPref(MODEL_PREFS[tier], value);
  }

  async #logins() {
    return Services.logins.searchLoginsAsync({
      origin: KEY_ORIGIN,
      httpRealm: KEY_REALM,
    });
  }

  /** @returns {Promise<string>} The key, or "" when none is set. */
  async key() {
    if (this.#key === undefined) {
      let stored = "";
      try {
        const [login] = await this.#logins();
        stored = login?.password || "";
      } catch (e) {
        console.error(e);
      }
      this.#key = stored || Services.env.get("ANTHROPIC_API_KEY") || "";
    }
    return this.#key;
  }

  async hasKey() {
    return !!(await this.key());
  }

  async setKey(key) {
    for (const login of await this.#logins()) {
      Services.logins.removeLogin(login);
    }
    if (key) {
      await Services.logins.addLoginAsync(loginInfo(key));
    }
    this.#key = key || "";
  }

  async #post(body, signal) {
    const key = await this.key();
    if (!key) {
      throw new Error(
        "Commit's AI features need an Anthropic API key. Run `ai key` to add one."
      );
    }
    let response;
    try {
      // zen.ai.api-url exists for testing against a local fake API.
      const url = Services.prefs.getStringPref("zen.ai.api-url", "") || API_URL;
      response = await browserFetch(url, {
        method: "POST",
        headers: buildHeaders(key, body.model),
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (e.name == "AbortError") {
        throw e;
      }
      throw new Error(`Couldn't reach the Claude API: ${e.message}`);
    }
    if (!response.ok) {
      let error = null;
      try {
        error = await response.json();
      } catch {}
      throw new Error(describeError(response.status, error));
    }
    return response;
  }

  #count(message) {
    this.calls++;
    const cost = costOf(message?.usage, message?.model);
    if (cost) {
      this.spent += cost;
    }
    return cost;
  }

  /**
   * One request, waiting for the whole answer.
   *
   * @param {object} options - See buildRequest, plus `tier` ("fast", the
   *   default, or "smart") to pick the model.
   * @param {AbortSignal} [signal]
   * @returns {Promise<{message: object, cost: number|null}>}
   */
  async send({ tier = "fast", ...options }, signal) {
    const body = buildRequest({ model: this.model(tier), ...options });
    const response = await this.#post(body, signal);
    const message = await response.json();
    return { message, cost: this.#count(message) };
  }

  /**
   * One request, calling onText with each piece of the answer as it comes.
   *
   * @returns {Promise<{message: object, cost: number|null}>}
   */
  async stream({ tier = "fast", ...options }, onText, signal) {
    const body = buildRequest({ model: this.model(tier), ...options, stream: true });
    const response = await this.#post(body, signal);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const assembler = new StreamAssembler();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSSE(buffer);
      buffer = rest;
      for (const event of events) {
        const text = assembler.add(event);
        if (text) {
          onText(text);
        }
      }
    }
    const { events } = parseSSE(buffer + "\n\n");
    for (const event of events) {
      const text = assembler.add(event);
      if (text) {
        onText(text);
      }
    }
    const message = assembler.message;
    if (!message) {
      throw new Error("The API stream ended before it started.");
    }
    return { message, cost: this.#count(message) };
  }
}

export const ZenAI = new AI();
