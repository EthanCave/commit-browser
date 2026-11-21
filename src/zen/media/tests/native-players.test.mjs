import test from "node:test";
import assert from "node:assert/strict";
import {
  commandScript,
  describeTrack,
  parsePoll,
  pickPlayer,
  pollScript,
  searchURL,
} from "../ZenNativePlayersModel.sys.mjs";

const US = "\u001f";

test("poll script never tells an app that isn't running", () => {
  const script = pollScript(["spotify", "music"]);
  assert.match(script, /if application id "com.spotify.client" is running then/);
  assert.match(script, /if application id "com.apple.Music" is running then/);
  assert.match(script, /\(duration of current track\) \* 0.001/);
  assert.doesNotMatch(pollScript(["music"]), /spotify/);
});

test("parsePoll reads states, locale numbers and errors", () => {
  const out = [
    ["spotify", "playing", "Song", "Band", "LP", "12,5", "200.25"].join(US),
    ["music", "error", "-1743", "Not authorized"].join(US),
    "junk line",
  ].join("\n");
  const states = parsePoll(out);
  assert.deepEqual(states.spotify, {
    running: true,
    state: "playing",
    title: "Song",
    artist: "Band",
    album: "LP",
    position: 12.5,
    duration: 200.25,
  });
  assert.equal(states.music.error, -1743);
  assert.equal(parsePoll(["music", "kPSS", "", "", "", "0", "0"].join(US)).music.state, "stopped");
});

test("pickPlayer prefers playing, then paused, then preference, then Spotify", () => {
  const installed = ["spotify", "music"];
  assert.equal(pickPlayer({ music: { state: "playing" } }, installed), "music");
  assert.equal(pickPlayer({ music: { state: "paused", title: "x" } }, installed), "music");
  assert.equal(pickPlayer({}, installed, "music"), "music");
  assert.equal(pickPlayer({}, installed), "spotify");
  assert.equal(pickPlayer({ spotify: { error: -1743 } }, installed), "music");
  assert.equal(pickPlayer({}, []), null);
});

test("commands pass arguments through argv", () => {
  assert.equal(commandScript("spotify", "next"), 'tell application id "com.spotify.client" to next track');
  assert.match(commandScript("music", "search"), /on run argv/);
  assert.doesNotMatch(commandScript("music", "search"), /"\s*&\s*q/);
  assert.throws(() => commandScript("spotify", "search"));
  assert.throws(() => commandScript("music", "explode"));
  assert.equal(searchURL("spotify", "daft punk"), "spotify:search:daft%20punk");
  assert.equal(searchURL("music", "daft punk"), "music://music.apple.com/us/search?term=daft%20punk");
  assert.equal(
    searchURL("music", "a&b", { web: true, country: "gb" }),
    "https://music.apple.com/gb/search?term=a%26b"
  );
  assert.equal(searchURL("music", "x", { country: "419" }), "music://music.apple.com/us/search?term=x");
});

test("describeTrack", () => {
  assert.equal(
    describeTrack({ title: "One", artist: "Metallica", position: 65.4, duration: 446 }),
    "One — Metallica  1:05 / 7:26"
  );
  assert.equal(describeTrack({ title: "" }), "");
});
