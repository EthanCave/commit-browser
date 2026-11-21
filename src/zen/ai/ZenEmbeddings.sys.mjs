/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Local search for the console's `ai` filter and `checkout "<description>"`:
// EmbeddingGemma, run by Ollama on this Mac. Nothing leaves the computer.
//
// Each title is embedded once and kept in the profile, so later searches
// only embed the query (milliseconds). Ollama's server is started silently
// when needed (no app window), unloads the model after 5 idle minutes, and
// stops when Commit quits.

import {
  LOCAL_MODEL,
  base64ToVector,
  cosine,
  queryText,
  vectorToBase64,
} from "resource:///modules/zen/ai/ZenAIModel.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const ENABLED_PREF = "zen.ai.local.enabled";
const URL_PREF = "zen.ai.local.url";
const MODEL_PREF = "zen.ai.local.model";
const OLLAMA_SERVERS = [
  "/Applications/Ollama.app/Contents/Resources/ollama",
  "/opt/homebrew/bin/ollama",
  "/usr/local/bin/ollama",
];
const CACHE_FILE = "zen-ai-embeddings.jsonlz4";
const MAX_CACHED = 5000;
const BATCH = 64;

const sleep = ms => new Promise(resolve => lazy.setTimeout(resolve, ms));

class Embeddings {
  #cache = null; // Map: text → Float32Array, oldest first
  #saveTimer = null;
  #starting = null;
  #server = null; // the Ollama server Commit started, if any

  get enabled() {
    return Services.prefs.getBoolPref(ENABLED_PREF, true);
  }

  get model() {
    return Services.prefs.getStringPref(MODEL_PREF, "") || LOCAL_MODEL;
  }

  get #url() {
    return Services.prefs.getStringPref(URL_PREF, "") || "http://127.0.0.1:11434";
  }

  async #api(path, body = null, timeoutMs = 120000) {
    // AbortSignal.timeout() doesn't exist in browser modules; this does.
    const controller = new AbortController();
    const timer = lazy.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.#url + path, {
        method: body ? "POST" : "GET",
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const json = await response.json();
      if (!response.ok || json.error) {
        throw new Error(json.error || `Ollama said ${response.status}`);
      }
      return json;
    } finally {
      lazy.clearTimeout(timer);
    }
  }

  async #isRunning() {
    try {
      await this.#api("/api/version", null, 1500);
      return true;
    } catch {
      return false;
    }
  }

  /** The Ollama server program: the one inside the app, else Homebrew's. */
  async #serverPath() {
    for (const path of OLLAMA_SERVERS) {
      if (await IOUtils.exists(path)) {
        return path;
      }
    }
    return null;
  }

  async installed() {
    return !!(await this.#serverPath());
  }

  /**
   * Starts Ollama's server if nothing is serving yet. Only the server, not
   * the Ollama app: no window, no menu bar icon. It runs as Commit's child
   * and is stopped when Commit quits. If you have the Ollama app open,
   * Commit uses that instead.
   */
  async #ensureRunning() {
    if (await this.#isRunning()) {
      return;
    }
    const server = await this.#serverPath();
    if (!server) {
      throw new Error("Ollama isn't installed (ollama.com)");
    }
    this.#starting ??= (async () => {
      // exec, so the server itself is the child Commit can stop; its logs go
      // nowhere instead of filling a pipe nobody reads.
      this.#server = await lazy.Subprocess.call({
        command: "/bin/sh",
        arguments: ["-c", 'exec "$0" serve >/dev/null 2>&1', server],
        environment: { OLLAMA_HOST: new URL(this.#url).host },
        environmentAppend: true,
      });
      this.#server.stdin.close();
      Services.obs.addObserver(this, "quit-application");
      for (let i = 0; i < 40; i++) {
        if (await this.#isRunning()) {
          return;
        }
        await sleep(500);
      }
      throw new Error("Ollama didn't start");
    })().finally(() => (this.#starting = null));
    await this.#starting;
  }

  // Commit is quitting: stop the server it started (never the Ollama app).
  observe(subject, topic) {
    if (topic == "quit-application" && this.#server) {
      this.#server.kill(1000).catch(() => {});
      this.#server = null;
    }
  }

  async #hasModel() {
    const { models = [] } = await this.#api("/api/tags");
    const want = this.model.includes(":") ? this.model : `${this.model}:latest`;
    return models.some(m => m.name == want || m.model == want);
  }

  /**
   * Whether local search can run now, starting Ollama if needed.
   *
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async ready() {
    if (!this.enabled) {
      return { ok: false, reason: "local search is off (`ai local on`)" };
    }
    try {
      await this.#ensureRunning();
      if (!(await this.#hasModel())) {
        return { ok: false, reason: `${this.model} isn't downloaded (\`ai local setup\`, 0.6 GB)` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /** Downloads the embedding model. */
  async setup() {
    await this.#ensureRunning();
    await this.#api("/api/pull", { model: this.model, stream: false }, 30 * 60000);
  }

  async #loadCache() {
    if (this.#cache) {
      return;
    }
    this.#cache = new Map();
    try {
      const path = PathUtils.join(PathUtils.profileDir, CACHE_FILE);
      const saved = await IOUtils.readJSON(path, { decompress: true });
      if (saved?.model == this.model) {
        for (const [text, vector] of Object.entries(saved.entries || {})) {
          this.#cache.set(text, base64ToVector(vector));
        }
      }
    } catch {}
  }

  #scheduleSave() {
    if (this.#saveTimer) {
      return;
    }
    this.#saveTimer = lazy.setTimeout(async () => {
      this.#saveTimer = null;
      while (this.#cache.size > MAX_CACHED) {
        this.#cache.delete(this.#cache.keys().next().value);
      }
      const entries = {};
      for (const [text, vector] of this.#cache) {
        entries[text] = vectorToBase64(vector);
      }
      try {
        await IOUtils.writeJSON(
          PathUtils.join(PathUtils.profileDir, CACHE_FILE),
          { model: this.model, entries },
          { compress: true }
        );
      } catch (e) {
        console.error(e);
      }
    }, 2000);
  }

  /** How many of these texts still need embedding (to warn about a wait). */
  async uncached(texts) {
    await this.#loadCache();
    return new Set(texts.filter(text => !this.#cache.has(text))).size;
  }

  async #embed(texts) {
    await this.#loadCache();
    const missing = [...new Set(texts.filter(text => !this.#cache.has(text)))];
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const { embeddings } = await this.#api("/api/embed", {
        model: this.model,
        input: batch,
        keep_alive: "5m",
      });
      batch.forEach((text, j) => this.#cache.set(text, Float32Array.from(embeddings[j])));
    }
    if (missing.length) {
      this.#scheduleSave();
    }
    return texts.map(text => {
      const vector = this.#cache.get(text);
      // Most recently used last, so the oldest go first when trimming.
      this.#cache.delete(text);
      this.#cache.set(text, vector);
      return vector;
    });
  }

  /**
   * How close each text is to the query (cosine similarity).
   *
   * @param {string} query - What the person typed.
   * @param {string[]} texts - From embeddingText().
   * @returns {Promise<number[]>}
   */
  async scores(query, texts) {
    const vectors = await this.#embed(texts);
    const { embeddings } = await this.#api("/api/embed", {
      model: this.model,
      input: [queryText(query)],
      keep_alive: "5m",
    });
    return vectors.map(vector => cosine(embeddings[0], vector));
  }
}

export const ZenEmbeddings = new Embeddings();
