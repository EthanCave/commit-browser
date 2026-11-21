/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The parts of the Spotify / Music integration that don't touch the browser:
// the AppleScript Commit runs and how its output is read. Kept free of
// browser APIs so they can be tested with plain node.

export const PLAYERS = {
  spotify: {
    id: "spotify",
    name: "Spotify",
    bundleId: "com.spotify.client",
    apps: ["/Applications/Spotify.app", "~/Applications/Spotify.app"],
    // Spotify reports a track's duration in milliseconds.
    durationScale: 1 / 1000,
  },
  music: {
    id: "music",
    name: "Music",
    bundleId: "com.apple.Music",
    apps: ["/System/Applications/Music.app", "/Applications/Music.app"],
    durationScale: 1,
  },
};

// Fields in the poll output are split by the ASCII unit separator, which
// can't appear in a track or artist name.
const SEP = "\u001f";

/**
 * The AppleScript that reads every installed player's state in one go.
 * `application id "…" is running` doesn't send the app an Apple event, so
 * an app that isn't open is never launched and never asked for permission.
 *
 * @param {string[]} ids - Players to include (keys of PLAYERS).
 * @returns {string}
 */
export function pollScript(ids) {
  const lines = ["set sep to character id 31", 'set out to ""'];
  for (const id of ids) {
    const { bundleId, durationScale } = PLAYERS[id];
    const duration =
      durationScale == 1
        ? "duration of current track"
        : `(duration of current track) * ${durationScale}`;
    lines.push(
      `if application id "${bundleId}" is running then`,
      `  try`,
      `    tell application id "${bundleId}"`,
      `      set s to player state as text`,
      `      set t to ""`,
      `      set a to ""`,
      `      set al to ""`,
      `      set d to 0`,
      `      set p to 0`,
      `      try`,
      `        set t to name of current track`,
      `        set a to artist of current track`,
      `        set al to album of current track`,
      `        set d to ${duration}`,
      `      end try`,
      `      try`,
      `        set p to player position`,
      `      end try`,
      `    end tell`,
      `    set out to out & "${id}" & sep & s & sep & t & sep & a & sep & al & sep & (p as text) & sep & (d as text) & linefeed`,
      `  on error msg number n`,
      `    set out to out & "${id}" & sep & "error" & sep & (n as text) & sep & msg & linefeed`,
      `  end try`,
      `end if`
    );
  }
  lines.push("return out");
  return lines.join("\n");
}

function number(text) {
  // AppleScript writes numbers in the user's locale ("12,5" in some).
  const value = Number.parseFloat(String(text ?? "").replace(",", "."));
  return Number.isFinite(value) ? value : 0;
}

/**
 * Reads pollScript's output.
 *
 * @param {string} output
 * @returns {object} Player id → { running, state, title, artist, album,
 *   position, duration } or { running, error, message } when the player
 *   refused (error -1743 means Commit isn't allowed to control it).
 */
export function parsePoll(output) {
  const states = {};
  for (const line of String(output).split(/\r?\n/)) {
    const [id, state, ...rest] = line.split(SEP);
    if (!PLAYERS[id]) {
      continue;
    }
    if (state == "error") {
      states[id] = {
        running: true,
        error: Number.parseInt(rest[0], 10) || -1,
        message: rest.slice(1).join(SEP),
      };
      continue;
    }
    const [title, artist, album, position, duration] = rest;
    states[id] = {
      running: true,
      // "kPSP" and friends show up when the app's dictionary couldn't be
      // read; treat anything unknown as stopped.
      state: ["playing", "paused", "stopped"].includes(state)
        ? state
        : "stopped",
      title: title || "",
      artist: artist || "",
      album: album || "",
      position: number(position),
      duration: number(duration),
    };
  }
  return states;
}

/**
 * Which player a command without a target should go to: the one playing,
 * then one that's paused on a track, then the preferred one, then
 * Spotify if it's installed, then Music.
 *
 * @param {object} states - From parsePoll.
 * @param {string[]} installed - Installed player ids.
 * @param {string} [preferred]
 * @returns {string|null}
 */
export function pickPlayer(states, installed, preferred = "") {
  const usable = installed.filter(id => !states[id]?.error);
  const playing = usable.find(id => states[id]?.state == "playing");
  if (playing) {
    return playing;
  }
  const paused = usable.find(
    id => states[id]?.state == "paused" && states[id].title
  );
  if (paused) {
    return paused;
  }
  if (preferred && usable.includes(preferred)) {
    return preferred;
  }
  return ["spotify", "music"].find(id => usable.includes(id)) ?? null;
}

const COMMANDS = {
  play: "play",
  pause: "pause",
  playpause: "playpause",
  next: "next track",
  previous: "previous track",
};

/**
 * AppleScript for one command. Arguments are passed with `on run argv`
 * rather than pasted into the script, so a song name can't break it.
 *
 * @param {string} id - Player id.
 * @param {string} action - play, pause, playpause, next, previous, seek,
 *   or search (Music only: plays the first library match for argv 1).
 * @returns {string}
 */
export function commandScript(id, action) {
  const { bundleId } = PLAYERS[id];
  if (action == "seek") {
    return [
      "on run argv",
      `  tell application id "${bundleId}" to set player position to (item 1 of argv as real)`,
      "end run",
    ].join("\n");
  }
  if (action == "search") {
    if (id != "music") {
      throw new Error(`${PLAYERS[id].name} can't search from a script`);
    }
    return [
      "on run argv",
      "  set q to item 1 of argv",
      `  tell application id "${bundleId}"`,
      "    set found to (every track of library playlist 1 whose name contains q)",
      "    if found is {} then set found to (every track of library playlist 1 whose artist contains q)",
      "    if found is {} then set found to (every track of library playlist 1 whose album contains q)",
      '    if found is {} then return ""',
      "    set picked to item 1 of found",
      "    play picked",
      "    return (name of picked) & (character id 31) & (artist of picked)",
      "  end tell",
      "end run",
    ].join("\n");
  }
  const verb = COMMANDS[action];
  if (!verb) {
    throw new Error(`unknown player command: ${action}`);
  }
  return `tell application id "${bundleId}" to ${verb}`;
}

/**
 * Where `play <query>` goes when the app itself can't play a search: the
 * search page inside the Spotify or Music app, or Apple Music's website
 * when the Music app can't be opened.
 *
 * @param {string} id
 * @param {string} query
 * @param {object} [options]
 * @param {boolean} [options.web] - Apple Music's website instead of the app.
 * @param {string} [options.country] - Apple Music storefront, like "us".
 * @returns {string}
 */
export function searchURL(id, query, { web = false, country = "us" } = {}) {
  const term = encodeURIComponent(query);
  if (id == "spotify") {
    return `spotify:search:${term}`;
  }
  const store = /^[a-z]{2}$/.test(country) ? country : "us";
  const scheme = web ? "https" : "music";
  return `${scheme}://music.apple.com/${store}/search?term=${term}`;
}

/**
 * One line for `np`.
 *
 * @param {object} state - One entry from parsePoll.
 * @returns {string}
 */
export function describeTrack(state) {
  if (!state?.title) {
    return "";
  }
  const by = state.artist ? ` — ${state.artist}` : "";
  const clock = seconds => {
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const time = state.duration
    ? `  ${clock(state.position)} / ${clock(state.duration)}`
    : "";
  return `${state.title}${by}${time}`;
}
