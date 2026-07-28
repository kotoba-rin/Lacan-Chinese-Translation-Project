const assert = require("assert");
const path = require("path");

const contextModulePath = path.join(
  __dirname,
  "..",
  ".obsidian",
  "plugins",
  "lacan-translation-helper",
  "segment-ai",
  "context.js"
);

const { SegmentContextResolver, SegmentParser } = require(contextModulePath);

const parser = new SegmentParser();
const blocks = parser.parse([
  "<!-- id: s19b-04-0012 -->",
  "<!-- ids: s19b-04-0012 s19b-04-0013 -->",
  "",
  "[[notes/example|阅读笔记]]",
  "",
  "合并后的译文。",
  "",
  "<!-- id: s19b-04-0014 -->",
  "",
  "下一段。",
].join("\n"), "texts/s19b-example/translation/Leçon-04.md");

assert.strictEqual(blocks.length, 2);
assert.deepStrictEqual(blocks[0].ids, ["s19b-04-0012", "s19b-04-0013"]);
assert.strictEqual(blocks[0].primaryId, "s19b-04-0012");
assert.strictEqual(blocks[0].visibleText, "合并后的译文。");
assert.strictEqual(blocks[0].startLine, 0);
assert.strictEqual(blocks[0].endLine, 6);
assert.strictEqual(parser.findByRequestedId(blocks, "s19b-04-0013"), blocks[0]);
assert.throws(
  () => parser.findByRequestedId([
    {
      primaryId: "s8-01-0001",
      ids: ["s8-01-0001"],
    },
    {
      primaryId: "s8-01-0001",
      ids: ["s8-01-0001"],
    },
  ], "s8-01-0001"),
  (error) => error.code === "SegmentConflict"
);

const repeatedPrimaryGroupedBlocks = parser.parse([
  "<!-- id: s8-17-0024 -->",
  "<!-- id: s8-17-0024 s8-17-0025 id: s8-17-0026 -->",
  "",
  "合并后的译文。",
  "",
  "<!-- id: s8-17-0027 -->",
  "",
  "下一段。",
].join("\n"), "texts/s8-le-transfert/translation/Leçon-17.md");

assert.strictEqual(repeatedPrimaryGroupedBlocks.length, 2);
assert.deepStrictEqual(
  repeatedPrimaryGroupedBlocks[0].ids,
  ["s8-17-0024", "s8-17-0025", "s8-17-0026"]
);
assert.strictEqual(repeatedPrimaryGroupedBlocks[0].visibleText, "合并后的译文。");
assert.strictEqual(
  parser.findByRequestedId(repeatedPrimaryGroupedBlocks, "s8-17-0026"),
  repeatedPrimaryGroupedBlocks[0]
);

const runResolverTest = async () => {
  const translationPath = "texts/s8-test/translation/Leçon-01.md";
  const originalPath = "texts/s8-test/original/Leçon-01.md";
  const files = new Map([
    [translationPath, [
      "# Leçon 01",
      "",
      "<!-- id: s8-01-0001 -->",
      "",
      "上一段。",
      "",
      "<!-- id: s8-01-0002 -->",
      "<!-- ids: s8-01-0002 s8-01-0003 -->",
      "",
      "这里讨论欲望。",
      "",
      "[[notes/explicit|阅读笔记]]",
      "",
      "<!-- id: s8-01-0004 -->",
      "",
      "下一段。",
    ].join("\n")],
    [originalPath, [
      "# Leçon 01",
      "",
      "<!-- id: s8-01-0001 -->",
      "",
      "Avant.",
      "",
      "<!-- id: s8-01-0002 -->",
      "",
      "Le désir deux.",
      "",
      "<!-- id: s8-01-0003 -->",
      "",
      "Le désir trois.",
      "",
      "<!-- id: s8-01-0004 -->",
      "",
      "Après.",
    ].join("\n")],
    ["texts/s8-test/glossary.md", [
      "| 外文 | 统一中文译名 | 备注 |",
      "| --- | --- | --- |",
      "| désir | 欲望 | 本研讨班核心术语 |",
      "| transfert | 转移 | 未命中 |",
    ].join("\n")],
    ["texts/s8-test/notes/explicit.md", [
      "---",
      "title: 显式笔记",
      "segments:",
      "  - s8-01-0099",
      "---",
      "",
      "显式关联内容。",
    ].join("\n")],
    ["texts/s8-test/notes/related.md", [
      "---",
      "title: Frontmatter 笔记",
      "segments:",
      "  - s8-01-0003",
      "---",
      "",
      "通过分段关联。",
    ].join("\n")],
    ["texts/s8-test/notes/unrelated.md", [
      "---",
      "segments:",
      "  - s8-01-0088",
      "---",
      "",
      "无关内容。",
    ].join("\n")],
  ]);
  const resolver = new SegmentContextResolver({
    readText: async (requestedPath) => files.get(requestedPath) ?? null,
    listMarkdownPaths: async (prefix) => Array.from(files.keys())
      .filter((requestedPath) => requestedPath.startsWith(prefix) && requestedPath.endsWith(".md")),
  });

  const context = await resolver.resolve(translationPath, "s8-01-0003");

  assert.deepStrictEqual(context.reference, {
    seminarCode: "s8",
    seminarSlug: "s8-test",
    lessonNumber: 1,
    requestedId: "s8-01-0003",
    primaryId: "s8-01-0002",
    coveredIds: ["s8-01-0002", "s8-01-0003"],
    translationPath,
    originalPath,
  });
  assert.strictEqual(context.targetTranslation.visibleText, "这里讨论欲望。");
  assert.deepStrictEqual(
    context.alignedOriginals.map((block) => block.primaryId),
    ["s8-01-0002", "s8-01-0003"]
  );
  assert.strictEqual(context.previousTranslation.primaryId, "s8-01-0001");
  assert.strictEqual(context.nextTranslation.primaryId, "s8-01-0004");
  assert.deepStrictEqual(
    context.glossaryEntries.map((entry) => entry.sourceTerm),
    ["désir"]
  );
  assert.deepStrictEqual(
    context.linkedNotes.map((note) => note.path),
    [
      "texts/s8-test/notes/explicit.md",
      "texts/s8-test/notes/related.md",
    ]
  );
  assert.deepStrictEqual(context.availability.warnings, []);
  assert.match(context.contextHash, /^[a-f0-9]{64}$/);

  const repeated = await resolver.resolve(translationPath, "s8-01-0003");
  assert.strictEqual(repeated.contextHash, context.contextHash);

  const requestedPrimary = await resolver.resolve(translationPath, "s8-01-0002");
  assert.strictEqual(requestedPrimary.reference.primaryId, "s8-01-0002");
  assert.strictEqual(requestedPrimary.contextHash, context.contextHash);

  await assert.rejects(
    resolver.resolve("../outside.md", "s8-01-0002"),
    (error) => error.code === "PathOutsideVault"
  );

  const missingOriginal = new SegmentContextResolver({
    readText: async (requestedPath) => (
      requestedPath === translationPath ? files.get(translationPath) : null
    ),
  });
  await assert.rejects(
    missingOriginal.resolve(translationPath, "s8-01-0002"),
    (error) => error.code === "OriginalMissing"
  );

  const minimalFiles = new Map([
    [translationPath, [
      "<!-- id: s8-01-0002 -->",
      "",
      "<!-- untranslated -->",
    ].join("\n")],
    [originalPath, [
      "<!-- id: s8-01-0002 -->",
      "",
      "Texte original.",
    ].join("\n")],
  ]);
  const minimalResolver = new SegmentContextResolver({
    readText: async (requestedPath) => minimalFiles.get(requestedPath) ?? null,
    listMarkdownPaths: async () => [],
  });
  const minimalContext = await minimalResolver.resolve(translationPath, "s8-01-0002");
  assert.strictEqual(minimalContext.availability.translationAvailable, false);
  assert.deepStrictEqual(minimalContext.availability.warnings, [
    "当前分段没有可用中文译文，将仅依据法文原文解释。",
    "当前研讨班没有可用术语表。",
    "当前分段没有找到显式关联的阅读笔记。",
  ]);

  const mergedOriginalFiles = new Map([
    [translationPath, [
      "<!-- id: s8-01-0002 -->",
      "<!-- ids: s8-01-0002 s8-01-0003 -->",
      "",
      "合并译文。",
    ].join("\n")],
    [originalPath, [
      "<!-- id: s8-01-0002 -->",
      "<!-- ids: s8-01-0002 s8-01-0003 -->",
      "",
      "Texte original fusionné.",
    ].join("\n")],
  ]);
  const mergedOriginalResolver = new SegmentContextResolver({
    readText: async (requestedPath) => mergedOriginalFiles.get(requestedPath) ?? null,
  });
  const mergedOriginalContext = await mergedOriginalResolver.resolve(
    translationPath,
    "s8-01-0003"
  );
  assert.strictEqual(mergedOriginalContext.alignedOriginals.length, 1);
  assert.strictEqual(mergedOriginalContext.availability.originalAvailable, true);
};

runResolverTest().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
