const assert = require("assert");
const path = require("path");

const core = require(path.join(__dirname, "..", "theme", "lacan-ai-core.js"));

const cards = [
  {
    path: "知识库/对象a.md",
    title: "对象 a",
    tags: ["概念/对象a"],
    body: "对象 a 是欲望的原因。",
    card_links: [
      {
        path: "知识库/部分对象.md",
        title: "部分对象",
        href: "知识库/部分对象.html",
      },
    ],
    segment_links: [],
  },
  {
    path: "知识库/部分对象.md",
    title: "部分对象",
    tags: ["概念/部分对象"],
    body: "部分对象不是完整人格。",
    card_links: [],
    segment_links: [],
  },
];

const searchResults = core.searchCards(cards, "对象 a", 5);
assert.strictEqual(searchResults[0].card.title, "对象 a");
assert.ok(searchResults[0].reasons.includes("直接命中"));
assert.ok(
  searchResults.some(
    (result) => result.card.title === "部分对象" && result.reasons.includes("显式关联")
  )
);

cards[0].segment_links = [{ id: "s8-10-0045" }];
const segmentResults = core.findCardsBySegment(cards, "s8-10-0045");
assert.deepStrictEqual(segmentResults.map((card) => card.title), ["对象 a"]);

assert.strictEqual(
  core.validateEndpoint("https://api.example.com/v1/chat/completions"),
  "https://api.example.com/v1/chat/completions"
);
assert.strictEqual(
  core.validateEndpoint("http://localhost:11434/v1/chat/completions"),
  "http://localhost:11434/v1/chat/completions"
);
assert.throws(() => core.validateEndpoint("http://api.example.com/v1"), /HTTPS/);
assert.throws(() => core.validateEndpoint("javascript:alert(1)"), /HTTPS/);

const store = new Map([
  ["lacan-ai:settings", "{}"],
  ["lacan-ai:key", "secret"],
  ["unrelated", "keep"],
]);
const fakeStorage = {
  get length() {
    return store.size;
  },
  key(index) {
    return Array.from(store.keys())[index] ?? null;
  },
  removeItem(key) {
    store.delete(key);
  },
};
core.clearLocalConfig(fakeStorage, "lacan-ai:");
assert.strictEqual(store.has("lacan-ai:settings"), false);
assert.strictEqual(store.has("lacan-ai:key"), false);
assert.strictEqual(store.get("unrelated"), "keep");

const prompt = core.buildInterpretationPrompt({
  question: "如何理解对象 a？",
  card: {
    title: "对象 a",
    verification: "已核实",
    body: "对象 a 是欲望的原因。",
  },
  segments: [
    {
      id: "s8-10-0045",
      text: "法文：objet partiel。\n译文：部分对象。",
    },
  ],
});
assert.match(prompt, /知识卡片的整理结论/);
assert.match(prompt, /本地原文与译文直接支持/);
assert.match(prompt, /AI 的解释性推论/);
assert.match(prompt, /证据不足/);
assert.match(prompt, /使用 Markdown 格式输出/);

const translationReviewPrompt = core.buildTranslationReviewPrompt({
  selectedText: "这两个术语并不完全等同。",
  question: "这里的“不完全等同”是否准确？",
  segments: [
    {
      id: "s8-08-0001",
      french: "Ces deux termes ne sont pas tout à fait équivalents.",
      translation: "这两个术语并不完全等同。",
    },
  ],
});
assert.match(translationReviewPrompt, /只检查内容与含义/);
assert.match(translationReviewPrompt, /先仅依据法语原文独立翻译/);
assert.match(translationReviewPrompt, /与现有中文译文进行比较/);
assert.match(translationReviewPrompt, /确定的错义/);
assert.match(translationReviewPrompt, /可讨论的歧义/);
assert.match(translationReviewPrompt, /无需修改/);
assert.match(translationReviewPrompt, /s8-08-0001/);
assert.match(translationReviewPrompt, /Ces deux termes/);
assert.match(translationReviewPrompt, /这两个术语并不完全等同/);
assert.match(translationReviewPrompt, /这里的“不完全等同”是否准确/);
assert.match(translationReviewPrompt, /使用 Markdown 格式输出/);
assert.throws(
  () => core.buildTranslationReviewPrompt({ selectedText: "", segments: [] }),
  /请先在页面正文中用鼠标选中需要翻译校对的内容/
);

assert.throws(
  () => core.buildSkillPrompt("translation", { question: "", context: "" }),
  /未知的 AI 能力/
);
assert.throws(
  () => core.buildSkillPrompt("proofreading", { question: "", context: "" }),
  /未知的 AI 能力/
);

const answerPrompt = core.buildSkillPrompt("page-qa", {
  question: "这里的主体指什么？",
  context: "页面选中文本。",
});
assert.match(answerPrompt, /仅依据所给页面内容/);
assert.match(answerPrompt, /使用 Markdown 格式输出/);

const renderedMarkdown = core.renderMarkdown([
  "### 1. 对比结论",
  "",
  "这是 **确定的错义**，并保留 `objet a`。",
  "",
  "- 第一项",
  "- 第二项",
  "",
  "| 法语原文 | 现有译文 |",
  "| --- | --- |",
  "| désir | 欲望 |",
  "",
  "> 仅依据本地分段。",
  "",
  "```html",
  "<script>alert('xss')</script>",
  "```",
].join("\n"));
assert.match(renderedMarkdown, /<h3>1\. 对比结论<\/h3>/);
assert.match(renderedMarkdown, /<strong>确定的错义<\/strong>/);
assert.match(renderedMarkdown, /<code>objet a<\/code>/);
assert.match(renderedMarkdown, /<ul>[\s\S]*<li>第一项<\/li>/);
assert.match(renderedMarkdown, /<table>[\s\S]*<th>法语原文<\/th>/);
assert.match(renderedMarkdown, /<blockquote>[\s\S]*仅依据本地分段/);
assert.match(renderedMarkdown, /&lt;script&gt;alert\(&#39;xss&#39;\)&lt;\/script&gt;/);
assert.doesNotMatch(renderedMarkdown, /<script/i);

const safeLinks = core.renderMarkdown(
  "[项目主页](https://example.com/docs) [危险链接](javascript:alert(1)) <img src=x onerror=alert(1)>"
);
assert.match(safeLinks, /href="https:\/\/example\.com\/docs"/);
assert.match(safeLinks, /rel="noopener noreferrer"/);
assert.doesNotMatch(safeLinks, /href="javascript:/i);
assert.match(safeLinks, /<span class="lacan-ai-md-blocked-link">危险链接<\/span>/);
assert.doesNotMatch(safeLinks, /危险链接<\/span>\)/);
assert.doesNotMatch(safeLinks, /<img/i);
assert.match(safeLinks, /&lt;img src=x onerror=alert\(1\)&gt;/);

const parenthesizedLink = core.renderMarkdown(
  "[函数条目](https://example.com/wiki/Function_(mathematics))"
);
assert.match(
  parenthesizedLink,
  /href="https:\/\/example\.com\/wiki\/Function_\(mathematics\)"/
);
assert.doesNotMatch(parenthesizedLink, /<\/a>\)/);

const streamingMarkdown = core.renderMarkdown("## 流式标题\n\n```text\n尚未闭合");
assert.match(streamingMarkdown, /<h2>流式标题<\/h2>/);
assert.match(streamingMarkdown, /<pre><code class="language-text">尚未闭合<\/code><\/pre>/);

assert.strictEqual(
  core.extractChatCompletion({ choices: [{ message: { content: "回答正文" } }] }),
  "回答正文"
);
assert.throws(() => core.extractChatCompletion({ choices: [] }), /有效回答/);

assert.strictEqual(core.REQUEST_TIMEOUT_MS, 180000);
assert.strictEqual(core.MAX_OUTPUT_TOKENS, 1600);

assert.strictEqual(core.usesKnowledgeWorkspace("knowledge"), true);
assert.strictEqual(core.usesKnowledgeWorkspace("translation-review"), false);
assert.strictEqual(core.usesKnowledgeWorkspace("page-qa"), false);

assert.deepStrictEqual(
  core.clampLauncherPosition(
    { left: -40, top: 900 },
    { width: 320, height: 640 },
    { width: 52, height: 52 },
    8
  ),
  { left: 8, top: 580 }
);
assert.deepStrictEqual(
  core.clampLauncherPosition(
    { left: 120, top: 160 },
    { width: 320, height: 640 },
    { width: 52, height: 52 },
    8
  ),
  { left: 120, top: 160 }
);

assert.strictEqual(core.clampPanelWidth(260, 320, 900), 320);
assert.strictEqual(core.clampPanelWidth(1100, 320, 900), 900);
assert.strictEqual(core.clampPanelWidth(560, 320, 900), 560);
assert.strictEqual(
  core.isScrollNearBottom(
    { scrollHeight: 1000, scrollTop: 620, clientHeight: 340 },
    48
  ),
  true
);
assert.strictEqual(
  core.isScrollNearBottom(
    { scrollHeight: 1000, scrollTop: 520, clientHeight: 340 },
    48
  ),
  false
);
assert.strictEqual(typeof core.captureScrollSnapshot, "function");
assert.strictEqual(typeof core.resolveRestoredScrollTop, "function");
const bottomScrollSnapshot = core.captureScrollSnapshot(
  { scrollHeight: 1000, scrollTop: 660, clientHeight: 340 },
  true,
  48
);
assert.deepStrictEqual(bottomScrollSnapshot, {
  scrollTop: 660,
  nearBottom: true,
  autoFollow: true,
});
assert.strictEqual(
  core.resolveRestoredScrollTop(
    bottomScrollSnapshot,
    { scrollHeight: 1400, clientHeight: 340 }
  ),
  1060
);
const middleScrollSnapshot = core.captureScrollSnapshot(
  { scrollHeight: 1000, scrollTop: 320, clientHeight: 340 },
  false,
  48
);
assert.strictEqual(
  core.resolveRestoredScrollTop(
    middleScrollSnapshot,
    { scrollHeight: 1400, clientHeight: 340 }
  ),
  320
);
assert.deepStrictEqual(
  core.getDockedPanelWidthBounds(1536, 300, 360, 320, 900),
  { min: 320, max: 876 }
);
assert.deepStrictEqual(
  core.getDockedPanelWidthBounds(1024, 600, 360, 320, 900),
  { min: 64, max: 64 }
);

const streamingRequest = core.buildChatRequest(
  "Qwen/Qwen2.5-72B-Instruct",
  "有诺贝尔数学奖吗？"
);
assert.deepStrictEqual(streamingRequest, {
  model: "Qwen/Qwen2.5-72B-Instruct",
  messages: [{ role: "user", content: "有诺贝尔数学奖吗？" }],
  temperature: 0.2,
  max_tokens: 1600,
  stream: true,
  enable_thinking: false,
});

const firstStreamChunk = core.parseSseBuffer(
  'data: {"choices":[{"delta":{"content":"阿"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"伽'
);
assert.strictEqual(firstStreamChunk.events.length, 1);
assert.strictEqual(core.extractChatDelta(firstStreamChunk.events[0].payload), "阿");

const secondStreamChunk = core.parseSseBuffer(
  firstStreamChunk.remainder + '尔玛"}}]}\n\ndata: [DONE]\n\n'
);
assert.strictEqual(core.extractChatDelta(secondStreamChunk.events[0].payload), "伽尔玛");
assert.strictEqual(secondStreamChunk.events[1].done, true);
assert.strictEqual(secondStreamChunk.remainder, "");

const diagnosticText = core.formatDiagnostics({
  httpStatus: 200,
  firstByteMs: 1234,
  generationMs: 4567,
  totalMs: 5801,
  traceId: "trace-123",
  partial: true,
});
assert.match(diagnosticText, /HTTP 200/);
assert.match(diagnosticText, /首包 1\.2 秒/);
assert.match(diagnosticText, /生成 4\.6 秒/);
assert.match(diagnosticText, /总计 5\.8 秒/);
assert.match(diagnosticText, /trace-123/);
assert.match(diagnosticText, /部分结果/);

(async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"阿"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"伽尔玛"}}]}\n\ndata: [DONE]\n\n',
  ];
  const updates = [];
  const answer = await core.readChatResponse(
    {
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? "text/event-stream" : null;
        },
      },
      body: {
        getReader() {
          return {
            async read() {
              if (!chunks.length) return { done: true };
              return { done: false, value: Buffer.from(chunks.shift(), "utf8") };
            },
          };
        },
      },
    },
    (fullText) => updates.push(fullText)
  );

  assert.strictEqual(answer, "阿伽尔玛");
  assert.deepStrictEqual(updates, ["阿", "阿伽尔玛"]);

  const mixedChunks = [
    'data: {"choices":[{"delta":{"reasoning_content":"正在判断"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"没有"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"。"}}]}\n\ndata: [DONE]\n\n',
  ];
  const streamEvents = [];
  const mixedAnswer = await core.readChatResponse(
    {
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? "text/event-stream" : null;
        },
      },
      body: {
        getReader() {
          return {
            async read() {
              if (!mixedChunks.length) return { done: true };
              return { done: false, value: Buffer.from(mixedChunks.shift(), "utf8") };
            },
          };
        },
      },
    },
    (fullText, delta, event) => {
      streamEvents.push({ fullText, delta, phase: event && event.phase });
    }
  );

  assert.strictEqual(mixedAnswer, "没有。");
  assert.deepStrictEqual(streamEvents, [
    { fullText: "", delta: "", phase: "reasoning" },
    { fullText: "没有", delta: "没有", phase: "content" },
    { fullText: "没有。", delta: "。", phase: "content" },
  ]);

  async function capturedError(promise) {
    try {
      await promise;
      return null;
    } catch (error) {
      return error;
    }
  }

  var outputReaderCancelled = false;
  var outputLimitChunks = [
    "data: " + JSON.stringify({
      choices: [{ delta: { content: "x".repeat(80) } }],
    }) + "\n\ndata: [DONE]\n\n",
  ];
  const outputLimitError = await capturedError(core.readChatResponse(
    {
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? "text/event-stream" : null;
        },
      },
      body: {
        getReader() {
          return {
            async read() {
              if (!outputLimitChunks.length) return { done: true };
              return { done: false, value: Buffer.from(outputLimitChunks.shift(), "utf8") };
            },
            async cancel() {
              outputReaderCancelled = true;
            },
          };
        },
      },
    },
    null,
    { maxResponseBytes: 4096, maxOutputChars: 32 }
  ));

  var byteReaderCancelled = false;
  var byteLimitChunks = [
    "data: " + JSON.stringify({
      choices: [{ delta: { content: "ok" } }],
      padding: "x".repeat(300),
    }) + "\n\ndata: [DONE]\n\n",
  ];
  const byteLimitError = await capturedError(core.readChatResponse(
    {
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? "text/event-stream" : null;
        },
      },
      body: {
        getReader() {
          return {
            async read() {
              if (!byteLimitChunks.length) return { done: true };
              return { done: false, value: Buffer.from(byteLimitChunks.shift(), "utf8") };
            },
            async cancel() {
              byteReaderCancelled = true;
            },
          };
        },
      },
    },
    null,
    { maxResponseBytes: 128, maxOutputChars: 1000 }
  ));

  const jsonPayload = {
    choices: [{ message: { content: "y".repeat(80) } }],
  };
  const jsonText = JSON.stringify(jsonPayload);
  const jsonLimitError = await capturedError(core.readChatResponse(
    {
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? "application/json" : null;
        },
      },
      async json() {
        return jsonPayload;
      },
      async text() {
        return jsonText;
      },
    },
    null,
    { maxResponseBytes: 4096, maxOutputChars: 32 }
  ));

  var jsonByteReaderCancelled = false;
  var jsonTextCalled = false;
  var jsonByteReadCount = 0;
  var jsonByteChunks = [
    Buffer.from("{" + " ".repeat(95), "utf8"),
    Buffer.from(" ".repeat(96), "utf8"),
    Buffer.from('"choices":[]}', "utf8"),
  ];
  const jsonByteLimitError = await capturedError(core.readChatResponse(
    {
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? "application/json" : null;
        },
      },
      body: {
        getReader() {
          return {
            async read() {
              jsonByteReadCount += 1;
              if (!jsonByteChunks.length) return { done: true };
              return { done: false, value: jsonByteChunks.shift() };
            },
            async cancel() {
              jsonByteReaderCancelled = true;
            },
          };
        },
      },
      async text() {
        jsonTextCalled = true;
        return '{"choices":[{"message":{"content":"' + "z".repeat(300) + '"}}]}';
      },
    },
    null,
    { maxResponseBytes: 128, maxOutputChars: 1000 }
  ));

  assert.deepStrictEqual(
    [outputLimitError, byteLimitError, jsonLimitError, jsonByteLimitError]
      .map((error) => error && error.code),
    ["response_too_large", "response_too_large", "response_too_large", "response_too_large"]
  );
  assert.strictEqual(outputLimitError.partialText.length, 32);
  assert.strictEqual(jsonLimitError.partialText.length, 32);
  assert.strictEqual(outputReaderCancelled, true);
  assert.strictEqual(byteReaderCancelled, true);
  assert.strictEqual(jsonTextCalled, false);
  assert.strictEqual(jsonByteReadCount, 2);
  assert.strictEqual(jsonByteReaderCancelled, true);
  assert.strictEqual(core.MAX_RESPONSE_BYTES, 1024 * 1024);
  assert.strictEqual(core.MAX_OUTPUT_CHARS, 200000);
  console.log("lacan-ai-core tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
