/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Several commands on a line, aliases and the startup file.
// Run with: node --test src/zen/git/tests/*.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  STARTUP_TEMPLATE,
  expandLine,
  formatAlias,
  parseAliasDefinition,
  removeAliasFromText,
  setAliasInText,
  splitSequence,
  startupCommands,
} from "../ZenPipes.sys.mjs";

const texts = steps => steps.map(step => step.text);
const ops = steps => steps.map(step => step.op);

test("splitSequence splits on && and ; outside quotes", () => {
  const steps = splitSequence("switch thesis && focus 50m; play music");
  assert.deepEqual(texts(steps), ["switch thesis", "focus 50m", "play music"]);
  assert.deepEqual(ops(steps), [null, "&&", ";"]);
  assert.deepEqual(texts(splitSequence("a&&b")), ["a", "b"]);
  assert.deepEqual(texts(splitSequence(`alias s='a && b; c'`)), [`alias s='a && b; c'`]);
  assert.deepEqual(texts(splitSequence(`ask "a; b" && ls`)), [`ask "a; b"`, "ls"]);
  assert.deepEqual(texts(splitSequence("archive now;")), ["archive now"]);
  assert.deepEqual(texts(splitSequence("")), [""]);
  assert.throws(() => splitSequence("a &&"), /missing/);
  assert.throws(() => splitSequence("&& b"), /missing/);
  assert.throws(() => splitSequence("a ;; b"), /missing/);
});

test("an apostrophe is not a quote", () => {
  assert.deepEqual(texts(splitSequence("ask what's due && open canvas")), [
    "ask what's due",
    "open canvas",
  ]);
  assert.deepEqual(texts(splitSequence(`alias x='it's fine' && ls`)), [
    `alias x='it's fine'`,
    "ls",
  ]);
});

test("free-text commands keep && and ; unless a command follows", () => {
  const isCommand = name => ["ls", "open", "focus"].includes(name);
  assert.deepEqual(texts(splitSequence("ask summarize this; be brief", isCommand)), [
    "ask summarize this; be brief",
  ]);
  assert.deepEqual(texts(splitSequence("do R&&D jobs && focus 25m", isCommand)), [
    "do R&&D jobs",
    "focus 25m",
  ]);
  // Other commands always split, so a typo after && is reported.
  assert.deepEqual(texts(splitSequence("switch a && fcus 5m", isCommand)), [
    "switch a",
    "fcus 5m",
  ]);
});

test("expandLine replaces aliases at the start of each command", () => {
  const aliases = new Map([
    ["study", "switch thesis && focus 50m"],
    ["yt", "ls -a | grep youtube"],
    ["gh", "open gh/$1"],
    ["both", "study; yt | close"],
  ]);
  let steps = expandLine("study; gc", aliases);
  assert.deepEqual(texts(steps), ["switch thesis", "focus 50m", "gc"]);
  assert.deepEqual(ops(steps), [null, "&&", ";"]);

  assert.deepEqual(texts(expandLine("yt | close", aliases)), ["ls -a | grep youtube | close"]);
  assert.deepEqual(texts(expandLine("gh zen-browser/desktop", aliases)), ["open gh/zen-browser/desktop"]);
  assert.deepEqual(texts(expandLine("both", aliases)), [
    "switch thesis",
    "focus 50m",
    "ls -a | grep youtube | close",
  ]);
  // Words after an alias without $1 go at the end, like a shell.
  assert.deepEqual(texts(expandLine("yt | head 3", aliases)), ["ls -a | grep youtube | head 3"]);
  // Not the first word: left alone.
  assert.deepEqual(texts(expandLine("cd study", aliases)), ["cd study"]);
});

test("aliases work after a | in a pipe", () => {
  const aliases = new Map([["noyt", "grep -v youtube"], ["kill", "close -f"]]);
  assert.deepEqual(texts(expandLine("ls -a | noyt | kill", aliases)), [
    "ls -a | grep -v youtube | close -f",
  ]);
  // Not a pipe (doesn't start with ls or history): left as typed.
  assert.deepEqual(texts(expandLine("git log --format=a|noyt", aliases)), [
    "git log --format=a|noyt",
  ]);
});

test("$1, $2 and $@ take the words typed after an alias", () => {
  const aliases = new Map([
    ["two", "cherry-pick $1 $2"],
    ["all", "ask $@ please"],
  ]);
  assert.deepEqual(texts(expandLine('two work "news site"', aliases)), [
    'cherry-pick work "news site"',
  ]);
  assert.deepEqual(texts(expandLine("all what is due", aliases)), ["ask what is due please"]);
  assert.deepEqual(texts(expandLine("two", aliases)), ["cherry-pick"]);
});

test("an alias can use its own name for the real command, and loops stop", () => {
  assert.deepEqual(texts(expandLine("ls", new Map([["ls", "ls -a"]]))), ["ls -a"]);
  const loop = new Map([["a", "b"], ["b", "a"]]);
  assert.deepEqual(texts(expandLine("a", loop)), ["a"]);
  const deep = new Map(Array.from({ length: 15 }, (_, i) => [`a${i}`, `a${i + 1}`]));
  assert.throws(() => expandLine("a0", deep), /too many/);
});

test("parseAliasDefinition reads the ways people write aliases", () => {
  assert.deepEqual(parseAliasDefinition(" study='switch thesis && focus 50m'"), {
    name: "study",
    body: "switch thesis && focus 50m",
  });
  assert.deepEqual(parseAliasDefinition(` tok="ls -a | ai 'my thesis' | mv School"`), {
    name: "tok",
    body: "ls -a | ai 'my thesis' | mv School",
  });
  assert.deepEqual(parseAliasDefinition(" gc2=gc"), { name: "gc2", body: "gc" });
  assert.deepEqual(parseAliasDefinition(" yt ls -a | grep youtube"), {
    name: "yt",
    body: "ls -a | grep youtube",
  });
  assert.deepEqual(parseAliasDefinition(" study"), { name: "study", body: null });
  assert.throws(() => parseAliasDefinition(" study="), /needs commands/);
  assert.throws(() => parseAliasDefinition(" 9lives=ls"), /can't be a name/);
  assert.throws(() => parseAliasDefinition(" help=ls"), /built-in/);
});

test("formatAlias quotes so the line reads back the same", () => {
  assert.equal(formatAlias("s", "switch a && focus 5m"), "alias s='switch a && focus 5m'");
  assert.equal(formatAlias("q", "ask what's due"), `alias q="ask what's due"`);
  for (const body of ["switch a && focus 5m", "ask what's due", `ai "x" | mv Y`]) {
    const line = formatAlias("n", body);
    assert.deepEqual(parseAliasDefinition(line.replace(/^alias/, "")), { name: "n", body });
    assert.deepEqual(texts(splitSequence(line)), [line]);
  }
});

test("startupCommands skips comments and blank lines", () => {
  const text = "# hello\n\nalias s='a && b'\n  archive after 24  \r\n#gc\n";
  assert.deepEqual(startupCommands(text), [
    { line: 3, text: "alias s='a && b'" },
    { line: 4, text: "archive after 24" },
  ]);
  assert.deepEqual(startupCommands(STARTUP_TEMPLATE), []);
});

test("saving an alias replaces its line or adds one", () => {
  let text = "# mine\nalias a='x'\ngc\n";
  text = setAliasInText(text, "a", "y z");
  assert.equal(text, "# mine\nalias a='y z'\ngc\n");
  text = setAliasInText(text, "b", "ls");
  assert.equal(text, "# mine\nalias a='y z'\ngc\nalias b='ls'\n");
  // A name that is the start of another one isn't touched.
  text = setAliasInText("alias ab='1'\n", "a", "2");
  assert.equal(text, "alias ab='1'\nalias a='2'\n");
  // Duplicates collapse into the first.
  assert.equal(setAliasInText("alias a=1\nalias a 2\n", "a", "3"), "alias a='3'\n");
  assert.equal(setAliasInText("", "a", "b"), "alias a='b'\n");
});

test("removing an alias drops its line", () => {
  assert.deepEqual(removeAliasFromText("# x\nalias a='1'\nalias ab='2'\n", "a"), {
    text: "# x\nalias ab='2'\n",
    removed: true,
  });
  assert.equal(removeAliasFromText("gc\n", "a").removed, false);
});
