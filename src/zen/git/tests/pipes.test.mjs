import test from "node:test";
import assert from "node:assert/strict";
import {
  applyFilter,
  checkPipeline,
  formatItem,
  historyRange,
  isPipeline,
  splitPipeline,
} from "../ZenPipes.sys.mjs";
import { tokenize } from "../ZenGitModel.sys.mjs";

const items = [
  { kind: "tab", title: "Daft Punk - YouTube", url: "https://www.youtube.com/watch?v=1", host: "youtube.com", space: "Personal", time: 30 },
  { kind: "tab", title: "zen-browser/desktop", url: "https://github.com/zen-browser/desktop", host: "github.com", space: "Work", time: 10 },
  { kind: "tab", title: "Lo-fi beats", url: "https://www.youtube.com/watch?v=2", host: "youtube.com", space: "Work", time: 20 },
  { kind: "tab", title: "dup", url: "https://github.com/zen-browser/desktop", host: "github.com", space: "Work", time: 5 },
];

test("splitPipeline respects quotes and rejects empty stages", () => {
  assert.deepEqual(splitPipeline('ls -a | grep "a|b" | close'), ["ls -a", 'grep "a|b"', "close"]);
  assert.deepEqual(splitPipeline("ls"), ["ls"]);
  assert.throws(() => splitPipeline("ls |"));
  assert.throws(() => splitPipeline("ls || close"));
  assert.deepEqual(tokenize('grep "a|b"'), ["grep", "a|b"]);
});

test("only lines that start with a list are pipes", () => {
  assert.equal(isPipeline("ls -a | grep x"), true);
  assert.equal(isPipeline("history today | open"), true);
  assert.equal(isPipeline("git log --format=a|b"), false);
  assert.equal(isPipeline('cd "a|b"'), false);
  assert.equal(isPipeline("ls"), false);
});

test("checkPipeline catches bad shapes before anything runs", () => {
  const check = line => checkPipeline(splitPipeline(line).map(tokenize));
  assert.doesNotThrow(() => check("ls -a | grep youtube | head 3 | close"));
  assert.throws(() => check("ls | close | grep x"), /last command/);
  assert.throws(() => check("top | grep x"), /can't start a pipe/);
  assert.throws(() => check("ls | rm"), /can't be used in a pipe/);
});

test("grep: smart case, regex, -v, -u", () => {
  assert.equal(applyFilter(items, "grep", ["youtube"]).length, 2);
  assert.equal(applyFilter(items, "grep", ["YouTube"]).length, 1); // capital → case-sensitive
  assert.equal(applyFilter(items, "grep", ["-v", "youtube"]).length, 2);
  assert.equal(applyFilter(items, "grep", ["-u", "lo-fi"]).length, 0);
  assert.equal(applyFilter(items, "grep", ["daft|lo-fi"]).length, 2);
  assert.equal(applyFilter(items, "grep", ["watch?v=1"]).length, 1); // literal URL text
  assert.equal(applyFilter(items, "grep", ["youtube.com/watch"]).length, 2);
  assert.equal(applyFilter(items, "grep", ["(unclosed"]).length, 0);
  assert.throws(() => applyFilter(items, "grep", []));
});

test("head, tail, sort, uniq", () => {
  assert.equal(applyFilter(items, "head", ["2"]).length, 2);
  assert.equal(applyFilter(items, "head", ["-1"]).length, 1);
  assert.deepEqual(applyFilter(items, "tail", ["1"]), [items[3]]);
  assert.equal(applyFilter(items, "sort", ["time"])[0].time, 30);
  assert.equal(applyFilter(items, "sort", ["-r", "title"])[0].title, "zen-browser/desktop");
  assert.equal(applyFilter(items, "sort", ["space"])[0].space, "Personal");
  assert.throws(() => applyFilter(items, "sort", ["color"]));
  assert.equal(applyFilter(items, "uniq", []).length, 3);
});

test("historyRange", () => {
  const now = new Date(2026, 10, 20, 15, 0, 0);
  const midnight = new Date(2026, 10, 20).getTime();
  assert.equal(historyRange([], now).from, midnight);
  const y = historyRange(["yesterday", "recipe"], now);
  assert.equal(y.to, midnight);
  assert.equal(y.from, midnight - 86400000);
  assert.deepEqual(y.search, ["recipe"]);
  assert.equal(historyRange(["3h"], now).from, now.getTime() + 1 - 3 * 3600000);
  assert.equal(historyRange(["all"], now).from, 0);
});

test("formatItem", () => {
  assert.equal(formatItem(items[1], { showSpace: true }), "Work/ zen-browser/desktop  — github.com");
  assert.equal(
    formatItem({ kind: "page", title: "", url: "https://x.y/", host: "x.y", time: 1 }, { formatTime: () => "3:04 PM" }),
    "3:04 PM  https://x.y/  — x.y"
  );
});
