/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The console's `do <task>`: Claude researches on the web and reports back.
//
// With the Tavily CLI signed in (`tvly login`), Claude asks for searches and
// pages through two tools and Commit runs them with `tvly`, so they use
// your Tavily credits and Commit never handles a Tavily key. Otherwise it
// uses Anthropic's own web search (1¢ a search). Either way it can only
// search and read.

import { ZenAI } from "resource:///modules/zen/ai/ZenAI.sys.mjs";
import {
  DO_LIMITS,
  cachedShare,
  checkStop,
  describeNow,
  doRequest,
  doTavilyRequest,
  formatPage,
  formatSearchResults,
  progressOf,
  sourcesFromText,
  sourcesOf,
  textOf,
} from "resource:///modules/zen/ai/ZenAIModel.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
});

const SEARCH_PREF = "zen.ai.do.search"; // auto | tavily | anthropic
const LOCATION_PREF = "zen.ai.location"; // optional, set with `ai location`
const TVLY_PLACES = ["/opt/homebrew/bin/tvly", "/usr/local/bin/tvly"];
// tvly is a node script (#!/usr/bin/env node), so node has to be findable.
const PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

class Tavily {
  #path = undefined;
  #signedIn = null;

  async #find() {
    if (this.#path === undefined) {
      this.#path = null;
      for (const place of TVLY_PLACES) {
        if (await IOUtils.exists(place)) {
          this.#path = place;
          break;
        }
      }
    }
    return this.#path;
  }

  async #run(args) {
    const command = await this.#find();
    if (!command) {
      throw new Error("The Tavily CLI isn't installed");
    }
    const proc = await lazy.Subprocess.call({
      command,
      arguments: [...args, "--json"],
      environment: { PATH, TAVILY_CLIENT_NAME: "commit-browser" },
      environmentAppend: true,
      stderr: "pipe",
    });
    proc.stdin.close();
    let output = "";
    let chunk;
    while ((chunk = await proc.stdout.readString())) {
      output += chunk;
    }
    await proc.wait();
    let json;
    try {
      json = JSON.parse(output);
    } catch {
      throw new Error(`tvly gave an unreadable answer: ${output.slice(0, 120)}`);
    }
    if (json.error) {
      throw new Error(`Tavily: ${String(json.error).slice(0, 200)}`);
    }
    return json;
  }

  /** @returns {Promise<{ok: boolean, reason?: string}>} */
  async ready() {
    if (!(await this.#find())) {
      return { ok: false, reason: "the Tavily CLI isn't installed" };
    }
    if (this.#signedIn === null) {
      try {
        this.#signedIn = !!(await this.#run(["auth"])).authenticated;
      } catch {
        this.#signedIn = false;
      }
    }
    return this.#signedIn ? { ok: true } : { ok: false, reason: "tvly isn't signed in (`tvly login`)" };
  }

  search(query) {
    return this.#run(["search", query, "--depth", "basic", "--max-results", "6"]);
  }

  read(url, task) {
    return this.#run(["extract", url, "--query", task, "--format", "text"]);
  }
}

export const ZenTavily = new Tavily();

class Do {
  /**
   * Which search `do` will use right now.
   *
   * @returns {Promise<{provider: "tavily"|"anthropic", note?: string}>}
   */
  async provider() {
    const choice = Services.prefs.getStringPref(SEARCH_PREF, "auto");
    if (choice == "anthropic") {
      return { provider: "anthropic" };
    }
    const tavily = await ZenTavily.ready();
    if (tavily.ok) {
      return { provider: "tavily" };
    }
    return {
      provider: "anthropic",
      note: choice == "tavily" ? `Tavily isn't available (${tavily.reason}), so this uses Claude's search.` : "",
    };
  }

  /**
   * @param {string} task
   * @param {object} [options]
   * @param {Function} [options.onProgress] - Called with "searching: …" lines.
   * @returns {Promise<{text, sources, cost, credits, provider}>}
   */
  async run(task, { onProgress = () => {} } = {}) {
    const { provider, note } = await this.provider();
    if (note) {
      onProgress(note);
    }
    // Local time and timezone, so Claude can say what's open right now.
    const now = describeNow(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone);
    const location = Services.prefs.getStringPref(LOCATION_PREF, "").trim();
    return provider == "tavily"
      ? this.#withTavily(task, now, location, onProgress)
      : this.#withAnthropic(task, now, location, onProgress);
  }

  async #withAnthropic(task, now, location, onProgress) {
    const request = doRequest(task, now, ZenAI.model("smart"), location);
    let messages = request.messages;
    const responses = [];
    let cost = 0;
    for (let turn = 0; turn < 6; turn++) {
      const result = await ZenAI.send({ ...request, messages, effort: "high", tier: "smart", cache: true });
      const { message } = result;
      responses.push(message);
      cost += result.cost || 0;
      progressOf(message).forEach(line => onProgress(line));
      if (message.stop_reason == "pause_turn") {
        messages = [...messages, { role: "assistant", content: message.content }];
        continue;
      }
      checkStop(message);
      return {
        text: textOf(message).trim(),
        sources: sourcesOf(responses),
        cost,
        credits: 0,
        cached: cachedShare(responses.map(r => r.usage)),
        provider: "anthropic",
      };
    }
    throw new Error("Claude was still searching after six rounds, so I stopped it. Try a narrower task.");
  }

  async #withTavily(task, now, location, onProgress) {
    const request = doTavilyRequest(task, now, location);
    let messages = request.messages;
    let cost = 0;
    const usages = [];
    const used = { searches: 0, reads: 0 };
    const read = new Map(); // url → title, for sources if the answer lists none
    for (let turn = 0; turn < DO_LIMITS.turns; turn++) {
      // Every turn resends the research so far; caching bills that part at
      // 5% (Sonnet). Nothing before the new turn ever changes, so it stays valid.
      const result = await ZenAI.send({ ...request, messages, effort: "high", tier: "smart", cache: true });
      const { message } = result;
      cost += result.cost || 0;
      usages.push(message.usage);
      progressOf(message).forEach(line => onProgress(line));
      if (message.stop_reason != "tool_use") {
        checkStop(message);
        const text = textOf(message).trim();
        const listed = sourcesFromText(text);
        return {
          text,
          sources: (listed.length ? listed : [...read.keys()]).map(url => ({ url, title: read.get(url) || url })),
          cost,
          credits: used.searches + used.reads,
          cached: cachedShare(usages),
          provider: "tavily",
        };
      }
      const calls = message.content.filter(block => block.type == "tool_use");
      const results = await Promise.all(calls.map(call => this.#tool(call, task, used, read)));
      // Thinking and tool blocks go back unchanged, then every result in one message.
      messages = [
        ...messages,
        { role: "assistant", content: message.content },
        { role: "user", content: results },
      ];
    }
    throw new Error(`Claude was still researching after ${DO_LIMITS.turns} rounds, so I stopped it. Try a narrower task.`);
  }

  async #tool(call, task, used, read) {
    const reply = (content, isError = false) => ({
      type: "tool_result",
      tool_use_id: call.id,
      content,
      ...(isError ? { is_error: true } : {}),
    });
    try {
      if (call.name == "web_search") {
        if (used.searches >= DO_LIMITS.searches) {
          return reply("Search limit reached for this task. Answer with what you have.", true);
        }
        used.searches++;
        return reply(formatSearchResults(await ZenTavily.search(String(call.input?.query || ""))));
      }
      if (call.name == "read_page") {
        const url = String(call.input?.url || "");
        if (!/^https?:\/\//.test(url)) {
          return reply("read_page needs an http(s) URL.", true);
        }
        if (used.reads >= DO_LIMITS.reads) {
          return reply("Page limit reached for this task. Answer with what you have.", true);
        }
        used.reads++;
        const json = await ZenTavily.read(url, task);
        read.set(url, json?.results?.[0]?.title || url);
        return reply(formatPage(json, url));
      }
      return reply(`Unknown tool ${call.name}.`, true);
    } catch (e) {
      return reply(e.message, true);
    }
  }
}

export const ZenDo = new Do();
