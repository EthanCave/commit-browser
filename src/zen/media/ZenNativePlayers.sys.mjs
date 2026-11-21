/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spotify and Apple Music (the Mac apps) in Commit: what they're playing
// shows in the sidebar's media bar next to tabs that play audio, and the
// console can play, pause and skip.
//
// macOS has no "now playing" API a browser can read, so this asks the apps
// over AppleScript every few seconds, but only apps that are already open:
// Commit never launches them on its own. The first time, macOS asks
// whether Commit may control the app.

import {
  PLAYERS,
  commandScript,
  parsePoll,
  pickPlayer,
  pollScript,
} from "resource:///modules/zen/media/ZenNativePlayersModel.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const ENABLED_PREF = "zen.media.native-players.enabled";
const PREFERRED_PREF = "zen.media.native-players.preferred";
const OSASCRIPT = "/usr/bin/osascript";
const NOT_ALLOWED = -1743;

// Poll often while something plays (to catch track changes), rarely
// otherwise (to notice when something starts).
const PLAYING_INTERVAL_MS = 3000;
const IDLE_INTERVAL_MS = 8000;

async function run(command, args) {
  const proc = await lazy.Subprocess.call({
    command,
    arguments: args,
    stderr: "stdout",
  });
  proc.stdin.close();
  let output = "";
  let chunk;
  while ((chunk = await proc.stdout.readString())) {
    output += chunk;
  }
  const { exitCode } = await proc.wait();
  return { exitCode, output: output.trim() };
}

function errorNumber(output) {
  const match = /\((-?\d+)\)\s*$/.exec(output);
  return match ? Number(match[1]) : null;
}

/**
 * One app, shaped like the MediaController the sidebar's media cards use
 * (play, pause, metadata, position and the events they listen for), so a
 * card can show it without knowing it isn't a tab.
 */
export class NativePlayer {
  #listeners = new Map();
  #positionAt = 0;
  state = { running: false, state: "stopped" };

  isNative = true;
  isBeingUsedInPIPModeOrFullscreen = false;
  supportedKeys = ["playpause", "previoustrack", "nexttrack", "seekto"];

  constructor(definition, players) {
    Object.assign(this, definition);
    this.players = players;
    const app = definition.apps[0];
    // A stand-in for the tab a card belongs to: the cards only read its
    // id, icon and mute state.
    this.browser = {
      browserId: `native-${definition.id}`,
      mIconURL: `moz-icon://file://${app}?size=32`,
      currentURI: { spec: "" },
      audioMuted: false,
    };
  }

  get isActive() {
    return (
      this.state.running &&
      !this.state.error &&
      this.state.state != "stopped" &&
      !!this.state.title
    );
  }

  get isPlaying() {
    return this.isActive && this.state.state == "playing";
  }

  getMetadata() {
    return {
      title: this.state.title || "",
      artist: this.state.artist || "",
      album: this.state.album || "",
    };
  }

  getPositionState() {
    let position = this.state.position || 0;
    if (this.isPlaying && this.#positionAt) {
      position += (Date.now() - this.#positionAt) / 1000;
    }
    return {
      position: Math.min(position, this.state.duration || position),
      duration: this.state.duration || 0,
      playbackRate: 1,
    };
  }

  addEventListener(type, listener) {
    if (!this.#listeners.has(type)) {
      this.#listeners.set(type, new Set());
    }
    this.#listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.#listeners.get(type)?.delete(listener);
  }

  #emit(type, event = {}) {
    for (const listener of [...(this.#listeners.get(type) || [])]) {
      try {
        listener(event);
      } catch (e) {
        console.error(e);
      }
    }
  }

  /**
   * Takes a new reading from the app and tells the cards what changed.
   *
   * @param {object} next - One entry from parsePoll, or not running.
   */
  update(next) {
    const before = this.state;
    const wasActive = this.isActive;
    const predicted = this.getPositionState().position;
    this.state = next;
    this.#positionAt = Date.now();
    if (!this.isActive) {
      if (wasActive) {
        this.#emit("deactivated");
      }
      return;
    }
    const trackChanged =
      before.title != next.title ||
      before.artist != next.artist ||
      before.album != next.album;
    if (trackChanged) {
      this.#emit("metadatachange");
    }
    if (before.state != next.state) {
      this.#emit("playbackstatechange");
    }
    // The cards move the progress bar on their own each second; only
    // correct them on a new track, a seek or a drift of a few seconds.
    if (
      trackChanged ||
      before.state != next.state ||
      before.duration != next.duration ||
      Math.abs(predicted - next.position) > 2
    ) {
      this.#emit("positionstatechange", this.getPositionState());
    }
    if (!wasActive) {
      this.players.onActivated(this);
    }
  }

  // Optimistic: the card shows the new state right away, and the next
  // reading confirms it.
  #setPlaying(playing) {
    if (!this.isActive) {
      return;
    }
    this.update({
      ...this.state,
      position: this.getPositionState().position,
      state: playing ? "playing" : "paused",
    });
  }

  play() {
    this.#setPlaying(true);
    return this.players.command(this.id, "play");
  }

  pause() {
    this.#setPlaying(false);
    return this.players.command(this.id, "pause");
  }

  nextTrack() {
    return this.players.command(this.id, "next");
  }

  prevTrack() {
    return this.players.command(this.id, "previous");
  }

  seekTo(seconds) {
    this.update({ ...this.state, position: seconds });
    return this.players.command(this.id, "seek", [String(seconds)]);
  }

  focus() {
    // `open` brings the app forward without an Apple event.
    run("/usr/bin/open", ["-b", this.bundleId]).catch(console.error);
  }
}

class NativePlayers {
  #players = new Map();
  #installed = null;
  #watchers = new Set();
  #timer = null;
  #polling = null;
  #denied = new Set();

  constructor() {
    for (const definition of Object.values(PLAYERS)) {
      this.#players.set(definition.id, new NativePlayer(definition, this));
    }
  }

  get enabled() {
    return (
      lazy.AppConstants.platform == "macosx" &&
      Services.prefs.getBoolPref(ENABLED_PREF, true)
    );
  }

  get players() {
    return [...this.#players.values()];
  }

  player(id) {
    return this.#players.get(id) ?? null;
  }

  /** Player ids macOS refused to let Commit control. */
  get denied() {
    return [...this.#denied];
  }

  async installed() {
    if (!this.#installed) {
      const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
      const found = [];
      for (const definition of Object.values(PLAYERS)) {
        for (const app of definition.apps) {
          const path = app.replace(/^~/, home);
          if (await IOUtils.exists(path)) {
            found.push(definition.id);
            this.#players.get(definition.id).browser.mIconURL =
              `moz-icon://file://${encodeURI(path)}?size=32`;
            break;
          }
        }
      }
      this.#installed = found;
    }
    return this.#installed;
  }

  /**
   * A window's media bar starts following the apps.
   *
   * @param {object} manager - The window's ZenMediaController.
   */
  watch(manager) {
    if (!this.enabled) {
      return;
    }
    this.#watchers.add(manager);
    for (const player of this.players) {
      if (player.isPlaying) {
        this.#show(manager, player);
      }
    }
    this.#schedule(0);
  }

  unwatch(manager) {
    this.#watchers.delete(manager);
    if (!this.#watchers.size && this.#timer) {
      lazy.clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  onActivated(player) {
    if (!player.isPlaying) {
      return;
    }
    for (const manager of this.#watchers) {
      this.#show(manager, player);
    }
  }

  #show(manager, player) {
    try {
      manager.showNativePlayer?.(player);
    } catch (e) {
      console.error(e);
    }
  }

  #schedule(delay) {
    if (this.#timer) {
      lazy.clearTimeout(this.#timer);
    }
    if (!this.#watchers.size || !this.enabled) {
      this.#timer = null;
      return;
    }
    this.#timer = lazy.setTimeout(async () => {
      this.#timer = null;
      await this.refresh();
      const playing = this.players.some(p => p.isPlaying);
      this.#schedule(playing ? PLAYING_INTERVAL_MS : IDLE_INTERVAL_MS);
    }, delay);
  }

  /**
   * Reads every open player now.
   *
   * @returns {Promise<object>} Player id → state.
   */
  refresh() {
    this.#polling ??= this.#poll().finally(() => (this.#polling = null));
    return this.#polling;
  }

  async #poll() {
    const ids = (await this.installed()).filter(id => !this.#denied.has(id));
    if (!ids.length) {
      return {};
    }
    let states = {};
    try {
      const { exitCode, output } = await run(OSASCRIPT, [
        "-e",
        pollScript(ids),
      ]);
      if (exitCode != 0) {
        console.error("Commit couldn't read the music apps:", output);
        return {};
      }
      states = parsePoll(output);
    } catch (e) {
      console.error(e);
      return {};
    }
    for (const id of ids) {
      const state = states[id];
      if (state?.error == NOT_ALLOWED) {
        // Asking again every few seconds would be pointless: macOS only
        // shows the prompt once. `play` tries again on request.
        this.#denied.add(id);
      }
      this.#players
        .get(id)
        .update(
          state && !state.error ? state : { running: !!state, state: "stopped" }
        );
    }
    return states;
  }

  /**
   * The player a command without a name should go to.
   *
   * @returns {Promise<NativePlayer|null>}
   */
  async pick() {
    const states = {};
    await this.refresh();
    for (const player of this.players) {
      states[player.id] = this.#denied.has(player.id)
        ? { error: NOT_ALLOWED }
        : player.state;
    }
    const id = pickPlayer(
      states,
      await this.installed(),
      Services.prefs.getStringPref(PREFERRED_PREF, "")
    );
    return id ? this.player(id) : null;
  }

  /**
   * Sends a player a command. Opens the app if it isn't running (only for
   * play, which is what you'd expect from a play button).
   *
   * @param {string} id
   * @param {string} action - See commandScript.
   * @param {string[]} [args]
   * @returns {Promise<string>} What the script returned.
   */
  async command(id, action, args = []) {
    this.#denied.delete(id);
    const { exitCode, output } = await run(OSASCRIPT, [
      "-e",
      commandScript(id, action),
      ...args,
    ]);
    // Show the result (new track, new state) quickly.
    this.#schedule(400);
    if (exitCode != 0) {
      const number = errorNumber(output);
      if (number == NOT_ALLOWED) {
        this.#denied.add(id);
        throw new Error(
          `Commit isn't allowed to control ${PLAYERS[id].name}. Turn it on in System Settings → Privacy & Security → Automation → Commit.`
        );
      }
      throw new Error(output || `${PLAYERS[id].name} didn't respond`);
    }
    return output;
  }

  /** Opens a URL with macOS (spotify: links open the Spotify app). */
  openExternal(url) {
    return run("/usr/bin/open", [url]);
  }
}

export const ZenNativePlayers = new NativePlayers();
