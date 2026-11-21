import test from "node:test";
import assert from "node:assert/strict";
import * as AI from "../ZenAIModel.sys.mjs";

const now = Date.UTC(2026, 10, 20, 12);
const items = [
  { kind: "tab", title: "Thesis draft", url: "https://docs.google.com/d/1", space: "School", time: now - 3600000 * 3 },
  { kind: "tab", title: "Flights to Tokyo", url: "https://flights.example/tyo", space: "Personal", time: now - 86400000 * 4, folder: "Trip" },
  { kind: "tab", title: "Mail", url: "https://mail.example", space: "essentials", time: now, essential: true },
  { kind: "tab", title: "Flights to Tokyo", url: "https://flights.example/tyo", space: "Personal", time: now - 86400000 },
];

test("request body: effort, JSON schema, fallbacks only where supported", () => {
  const body = AI.buildRequest({ model: "claude-opus-5-5", system: "s", messages: [], schema: AI.FILTER_SCHEMA });
  assert.equal(body.output_config.effort, "low");
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(body.fallbacks, "default");
  assert.equal(body.max_tokens, 16000);
  assert.equal("thinking" in body, false);
  assert.equal("temperature" in body, false);
  const haiku = AI.buildRequest({ model: "claude-haiku-5-5", system: "s", messages: [], stream: true });
  assert.equal("fallbacks" in haiku, false);
  assert.equal(haiku.stream, true);
  const headers = AI.buildHeaders("k", "claude-opus-5-5");
  assert.equal(headers["anthropic-version"], "2026-10-21");
  assert.equal(headers["anthropic-beta"], AI.FALLBACK_BETA);
  assert.equal(AI.buildHeaders("k", "claude-haiku-5-5")["anthropic-beta"], undefined);
});

test("errors and stops read like sentences", () => {
  assert.match(AI.describeError(401, null), /ai key/);
  assert.match(AI.describeError(400, { error: { message: "bad thing" } }), /bad thing/);
  assert.throws(() => AI.checkStop({ stop_reason: "refusal", stop_details: { explanation: "nope" } }), /declined.*nope/);
  assert.throws(() => AI.jsonOf({ stop_reason: "end_turn", content: [{ type: "text", text: "not json" }] }), /JSON/);
  assert.deepEqual(
    AI.jsonOf({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"matches":[1]}' }] }),
    { matches: [1] }
  );
});

test("cost", () => {
  assert.equal(AI.costOf({ input_tokens: 1e6, output_tokens: 1e6 }, "claude-opus-5-5"), 24);
  // Sonnet 5.5 reads its cache at $0.10/M and writes it at 1.25× input.
  assert.ok(Math.abs(AI.costOf({ input_tokens: 0, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6, output_tokens: 0 }, "claude-sonnet-5-5") - 2.6) < 1e-9);
  assert.equal(AI.costOf({ input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 3 } }, "claude-opus-5-5"), 0.03);
  assert.equal(AI.costOf({ input_tokens: 5 }, "mystery-model"), null);
  // Haiku charges more for prompts over 100K tokens.
  assert.equal(AI.costOf({ input_tokens: 1e6, output_tokens: 0 }, "claude-haiku-5-5"), 0.5);
  assert.equal(AI.costOf({ input_tokens: 50000, output_tokens: 0 }, "claude-haiku-5-5"), 0.005);
  assert.equal(AI.formatCost(0.004), "<$0.01");
  assert.equal(AI.formatCost(0.236), "$0.24");
});

test("SSE parsing and assembling a streamed message", () => {
  const stream =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"claude-opus-5-5","content":[],"usage":{"input_tokens":10}}}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hel"}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"lo"}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  // Feed it in awkward chunks.
  const assembler = new AI.StreamAssembler();
  let buffer = "";
  let streamed = "";
  for (let i = 0; i < stream.length; i += 37) {
    const { events, rest } = AI.parseSSE(buffer + stream.slice(i, i + 37));
    buffer = rest;
    for (const event of events) {
      streamed += assembler.add(event);
    }
  }
  assert.equal(streamed, "Hello");
  assert.equal(AI.textOf(assembler.message), "Hello");
  assert.equal(assembler.message.stop_reason, "end_turn");
  assert.deepEqual(assembler.message.usage, { input_tokens: 10, output_tokens: 5 });
  assert.throws(() => assembler.add({ type: "error", error: { message: "overloaded" } }), /overloaded/);
});

test("item lines and index validation", () => {
  const lines = AI.itemLines(items, now).split("\n");
  assert.equal(lines[0], "[0] Thesis draft | https://docs.google.com/d/1 | School, used 3h ago");
  assert.match(lines[1], /folder "Trip"/);
  assert.match(lines[2], /Essential/);
  assert.deepEqual(AI.validIndices({ matches: [3, 1, 1, -1, 9, 2.5, "0"] }, 4), [1, 3]);
  assert.deepEqual(AI.validIndices(null, 4), []);
  const request = AI.filterRequest("travel", items, now);
  assert.match(request.messages[0].content, /Keep the items that are: travel/);
});

test("commit messages are one clean line", () => {
  assert.equal(AI.cleanCommitMessage('"Planning Tokyo trip: flights."\nmore'), "Planning Tokyo trip: flights");
  assert.equal(AI.cleanCommitMessage(""), "");
  assert.equal(AI.cleanCommitMessage("x".repeat(100)).length, 72);
});

test("times versus descriptions", () => {
  assert.equal(AI.isJustATime("last tuesday at 3pm"), true);
  assert.equal(AI.isJustATime("2 days ago"), true);
  assert.equal(AI.isJustATime("2026-11-18"), true);
  assert.equal(AI.isJustATime("the week I planned tokyo"), false);
  assert.equal(AI.isJustATime("when I was planning Tokyo"), false);
  assert.equal(AI.looksLikeDescription(["planning", "tokyo"]), true);
  assert.equal(AI.looksLikeDescription(["main"]), false);
});

test("fitDocs shares the budget", () => {
  const docs = AI.fitDocs(
    [
      { title: "a", text: "x".repeat(10) },
      { title: "b", text: "y".repeat(1000) },
      { title: "c", text: "z".repeat(1000) },
    ],
    310
  );
  assert.equal(docs[0].text.length, 10);
  assert.equal(docs[1].text.length, 150);
  assert.equal(docs[2].text.length, 150);
  assert.equal(docs[1].cut, true);
  assert.equal(docs[0].cut, undefined);
  const request = AI.askRequest('what "is" this', [{ title: 'Quote "x"', url: "https://a/?b&c", text: "" }]);
  assert.match(request.messages[0].content, /title="Quote &#34;x&#34;"/);
  assert.match(request.messages[0].content, /no text/);
});

test("tidy plans are cleaned before anyone sees them", () => {
  const plan = AI.cleanTidyPlan(
    {
      summary: "Group the trip",
      close: [{ tab: 3, reason: "duplicate" }, { tab: 2, reason: "essential?" }, { tab: 99, reason: "bad" }],
      move: [{ tab: 0, space: "school" }, { tab: 1, space: "Nowhere" }, { tab: 3, space: "School" }],
      folders: [{ name: "Trip", tabs: [1, 3] }, { name: "Solo", tabs: [0] }],
    },
    items,
    ["School", "Work"]
  );
  assert.deepEqual(plan.close, [{ tab: 3, reason: "duplicate" }]);
  // Tab 0 is already in School; tab 1's space doesn't exist; tab 3 is closing.
  assert.deepEqual(plan.move, []);
  // Tab 3 is taken by close, so Trip has one tab left and is dropped.
  assert.deepEqual(plan.folders, []);
  assert.equal(AI.tidyIsEmpty(plan), false);
  const lines = AI.formatTidy(
    { folders: [{ name: "Trip", tabs: [1] }], move: [{ tab: 0, space: "Work" }], close: [{ tab: 3, reason: "duplicate" }] },
    items
  );
  assert.deepEqual(lines.map(([, kind]) => kind), ["added", "", "modified", "deleted"]);
});

test("catch-up lines and away time", () => {
  assert.deepEqual(AI.catchUpLines("- one\n2. two\n\nthree\nfour"), ["one", "two", "three"]);
  assert.equal(AI.awayFor(3600000 * 14), "14 hours");
  assert.equal(AI.awayFor(86400000 * 3), "3 days");
});

test("do: read-only tools, progress and sources", () => {
  const request = AI.doRequest("find flights", "Fri Nov 20 2026", "claude-sonnet-5-5");
  assert.deepEqual(request.tools.map(t => t.type), ["web_search_20260209", "web_fetch_20260209"]);
  // Haiku only has the basic web tools.
  assert.deepEqual(AI.doTools("claude-haiku-5-5").map(t => t.type), ["web_search_20250305", "web_fetch_20250910"]);
  assert.match(request.system, /Fri Nov 20 2026/);
  const responses = [
    {
      content: [
        { type: "server_tool_use", name: "web_search", input: { query: "tokyo flights march" } },
        { type: "server_tool_use", name: "web_fetch", input: { url: "https://a.example" } },
        { type: "web_fetch_tool_result", content: { url: "https://a.example", content: { title: "A" } } },
        { type: "web_fetch_tool_result", content: { url: "https://b.example", content: { title: "B" } } },
      ],
    },
    {
      content: [
        { type: "text", text: "Cheapest is…", citations: [{ url: "https://b.example", title: "B cited" }] },
      ],
    },
  ];
  assert.deepEqual(AI.progressOf(responses[0]), ["searching: tokyo flights march", "reading: https://a.example"]);
  assert.deepEqual(AI.sourcesOf(responses), [
    { url: "https://b.example", title: "B cited" },
    { url: "https://a.example", title: "A" },
  ]);
});

test("models: Haiku fast, Sonnet smart; fallbacks only on Sonnet", () => {
  assert.deepEqual(AI.DEFAULT_MODELS, { fast: "claude-haiku-5-5", smart: "claude-sonnet-5-5" });
  assert.equal(AI.supportsFallbacks("claude-sonnet-5-5"), true);
  assert.equal(AI.supportsFallbacks("claude-haiku-5-5"), false);
});

test("local search: text, cosine, cutoff, vectors on disk", () => {
  assert.equal(AI.embeddingText("(7647) HIKARU PUNISHES BISHOP H6 - YouTube", "https://www.youtube.com/watch?v=1"),
    "title: none | text: HIKARU PUNISHES BISHOP H6 - YouTube (youtube.com)");
  assert.equal(AI.embeddingText("Planning Tokyo trip"), "title: none | text: Planning Tokyo trip");
  assert.equal(AI.queryText("about chess"), "task: search result | query: about chess");
  assert.equal(AI.cosine([1, 0], [1, 0]), 1);
  assert.equal(AI.cosine([1, 0], [0, 1]), 0);
  assert.equal(AI.cosine([0, 0], [1, 0]), 0);
  // The real scores from the EmbeddingGemma test for "about chess".
  assert.deepEqual(AI.selectByScore([0.281, 0.271, 0.147, 0.147, 0.136]), [0, 1]);
  // Nothing close enough: keep nothing rather than the least-bad.
  assert.deepEqual(AI.selectByScore([0.15, 0.12]), []);
  assert.deepEqual(AI.selectByScore([]), []);
  const v = [0.5, -1.25, 3];
  assert.deepEqual([...AI.base64ToVector(AI.vectorToBase64(v))], v);
});

test("do with Tavily: tools, formatting, sources", () => {
  for (const tool of AI.TAVILY_TOOLS) {
    assert.equal(tool.strict, true);
    assert.equal(tool.input_schema.additionalProperties, false);
  }
  const request = AI.doTavilyRequest("find flights", "Fri Nov 20 2026");
  assert.deepEqual(request.tools.map(t => t.name), ["web_search", "read_page"]);
  assert.match(request.system, /Sources:/);
  const results = AI.formatSearchResults({
    results: [{ title: "A", url: "https://a.example", content: "x ".repeat(1000) }, { url: "https://b.example", content: "" }],
  });
  assert.match(results, /^\[1\] A\nhttps:\/\/a\.example\n/);
  assert.match(results, /\[2\] \(untitled\)/);
  assert.ok(results.split("\n\n")[0].length < 900);
  assert.equal(AI.formatSearchResults({ results: [] }), "No results.");
  const page = AI.formatPage({ results: [{ title: "T", url: "https://t", raw_content: "y".repeat(20000) }] }, "https://t", 100);
  assert.match(page, /\[…cut\]$/);
  assert.match(AI.formatPage({ results: [], failed_results: [{ error: "blocked" }] }, "https://x"), /Couldn't read https:\/\/x: blocked/);
  assert.deepEqual(
    AI.sourcesFromText("Cheapest is $540 [1].\n\nSources:\n[1] https://a.example/flights.\n[2] (https://b.example)\n[3] https://a.example/flights."),
    ["https://a.example/flights", "https://b.example"]
  );
  assert.deepEqual(AI.sourcesFromText("no sources here"), []);
  assert.deepEqual(
    AI.progressOf({ content: [
      { type: "tool_use", name: "web_search", input: { query: "tokyo flights" } },
      { type: "tool_use", name: "read_page", input: { url: "https://a.example" } },
    ] }),
    ["searching: tokyo flights", "reading: https://a.example"]
  );
});

test("prompt caching for do", () => {
  assert.deepEqual(AI.buildRequest({ model: "claude-sonnet-5-5", system: "s", messages: [], cache: true }).cache_control, { type: "ephemeral" });
  assert.equal("cache_control" in AI.buildRequest({ model: "claude-sonnet-5-5", system: "s", messages: [] }), false);
  assert.equal(AI.cachedShare([{ input_tokens: 100, cache_creation_input_tokens: 900 }, { input_tokens: 100, cache_read_input_tokens: 900 }]), 0.45);
  assert.equal(AI.cachedShare([]), 0);
});

test("do knows the time and place, and asks for open-now hours", () => {
  const now = AI.describeNow(new Date(Date.UTC(2026, 10, 21, 5, 48)), "America/Chicago");
  assert.equal(now, "Friday, November 20, 2026 at 11:48 PM (America/Chicago)");
  for (const request of [
    AI.doTavilyRequest("dessert near me", now, "Houston, TX"),
    AI.doRequest("dessert near me", now, "claude-sonnet-5-5", "Houston, TX"),
  ]) {
    assert.match(request.system, /Right now it is Friday, November 20, 2026 at 11:48 PM \(America\/Chicago\)/);
    assert.match(request.system, /They are in Houston, TX; "near me"/);
    assert.match(request.system, /open now and when it closes/);
    assert.match(request.system, /no headings, tables or markdown emphasis/);
  }
  assert.doesNotMatch(AI.doTavilyRequest("x", now).system, /They are in/);
});

test("bold in console answers", () => {
  assert.deepEqual(AI.inlineSegments("- **Midnight Cravingz** (ice cream): open"), [
    { text: "- ", bold: false },
    { text: "Midnight Cravingz", bold: true },
    { text: " (ice cream): open", bold: false },
  ]);
  assert.deepEqual(AI.inlineSegments("a **b** and __c__"), [
    { text: "a ", bold: false }, { text: "b", bold: true }, { text: " and ", bold: false }, { text: "c", bold: true },
  ]);
  // Unclosed or spaced markers stay as typed (still streaming, or math).
  assert.deepEqual(AI.inlineSegments("**Midnight Cra"), [{ text: "**Midnight Cra", bold: false }]);
  assert.deepEqual(AI.inlineSegments("2 ** 3 ** 4"), [{ text: "2 ** 3 ** 4", bold: false }]);
  assert.deepEqual(AI.inlineSegments(""), []);
});
