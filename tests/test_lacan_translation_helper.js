const assert = require("assert");
const Module = require("module");
const path = require("path");

const originalLoad = Module._load;

class MockPlugin {}
class MockTFile {}

const mockNormalizePath = (value) => {
  const normalized = String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "");
  return normalized || "/";
};

Module._load = function load(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      BasesView: class {},
      Component: class {
        load() {}
        unload() {}
      },
      Notice: class {},
      ItemView: class {
        constructor(leaf) {
          this.leaf = leaf;
          this.containerEl = leaf?.containerEl;
        }
      },
      MarkdownRenderer: {
        async render() {},
      },
      Plugin: MockPlugin,
      PluginSettingTab: class {},
      Setting: class {},
      TFile: MockTFile,
      normalizePath: mockNormalizePath,
    };
  }
  if (request === "@codemirror/view") {
    return {
      Decoration: {
        none: [],
        set(ranges) {
          return ranges;
        },
        widget(options) {
          return {
            range(from) {
              return { from, to: from, value: options };
            },
          };
        },
      },
      ViewPlugin: {
        fromClass(cls, spec) {
          return { cls, spec };
        },
      },
      WidgetType: class {},
    };
  }
  return originalLoad(request, parent, isMain);
};

const run = async () => {
try {
  const PluginClass = require(path.join(
    __dirname,
    "..",
    ".obsidian",
    "plugins",
    "lacan-translation-helper",
    "main.js"
  ));
  const plugin = Object.create(PluginClass.prototype);
  assert.strictEqual(mockNormalizePath(""), "/");

  let resolveMcpPreflight;
  let mcpPreflightCalls = 0;
  let mcpSettingsSaves = 0;
  plugin.settings = {
    segmentAiEnabled: true,
    segmentAiMcpServerCatalog: [],
    segmentAiMcpEnabledServers: [],
  };
  plugin.segmentAiRuntime = {
    preflightMcpServers() {
      mcpPreflightCalls += 1;
      return new Promise((resolve) => {
        resolveMcpPreflight = resolve;
      });
    },
  };
  plugin.saveSettings = async () => {
    mcpSettingsSaves += 1;
  };
  const scheduledMcpPreflight =
    plugin.scheduleSegmentAiMcpBackgroundCheck();
  assert.ok(
    scheduledMcpPreflight instanceof Promise,
    "plugin startup should schedule MCP preflight without awaiting it"
  );
  assert.strictEqual(mcpPreflightCalls, 1);
  resolveMcpPreflight({
    status: "disabled",
    configuredServerNames: ["server-b", "server-a"],
    enabledServerNames: [],
    checkedServerNames: [],
    unavailableServerNames: [],
    checkedAt: 1234,
  });
  await scheduledMcpPreflight;
  assert.deepStrictEqual(
    plugin.settings.segmentAiMcpServerCatalog,
    ["server-a", "server-b"]
  );
  assert.strictEqual(
    plugin.settings.segmentAiMcpServerCatalogUpdatedAt,
    1234
  );
  assert.strictEqual(mcpSettingsSaves, 1);
  plugin.settings.segmentAiEnabled = false;
  assert.strictEqual(plugin.scheduleSegmentAiMcpBackgroundCheck(), null);
  assert.strictEqual(
    mcpPreflightCalls,
    1,
    "disabling the AI feature must keep Codex and MCP preflight stopped"
  );

  const viewActionsEl = {};
  const viewHeaderEl = {
    querySelector(selector) {
      return selector === ":scope > .view-actions" ? viewActionsEl : null;
    },
  };
  const viewContentEl = {};
  const markdownView = {
    containerEl: {
      querySelector(selector) {
        if (selector === ".view-header") {
          return viewHeaderEl;
        }
        if (selector === ".view-content") {
          return viewContentEl;
        }
        return null;
      },
    },
  };
  assert.strictEqual(typeof plugin.resolveComparisonToolbarMount, "function");
  assert.deepStrictEqual(plugin.resolveComparisonToolbarMount(markdownView), {
    hostEl: viewHeaderEl,
    beforeEl: viewActionsEl,
    location: "header",
  });

  assert.strictEqual(
    plugin.readingNotePathForSegment("texts/s8-le-transfert/translation/Leçon-01.md", "s8-01-0001"),
    "texts/s8-le-transfert/notes/s8-01.md"
  );
  assert.strictEqual(plugin.isReadingNotePath("texts/s8-le-transfert/notes/s8-11-0041.md"), true);
  assert.strictEqual(plugin.isReadingNotePath("texts/s8-le-transfert/translation/Leçon-11.md"), false);

  assert.strictEqual(
    plugin.readingNoteWikiLinkForSegment("s8-01-0001"),
    "[[notes/s8-01#s8-01-0001|阅读笔记]]"
  );

  assert.strictEqual(plugin.readingNotePathForSegment("texts/s8-le-transfert/translation/Leçon-01.md", "s8-01-0002"),
    "texts/s8-le-transfert/notes/s8-01.md");
  for (const target of ["notes/s8-01#s8-01-0001", "texts/s8-le-transfert/notes/s8-01.md#s8-01-0001"]) {
    assert.strictEqual(plugin.segmentIdFromLinkElement({
      getAttribute: (name) => name === "data-href" ? target : "",
    }), "", "chapter note links must not be redirected to the translation");
  }

  const titledReadingNote = new MockTFile();
  titledReadingNote.path = "texts/s8-le-transfert/notes/爱欲的投资、占有与增值.md";
  titledReadingNote.basename = "爱欲的投资、占有与增值";
  plugin.app = {
    metadataCache: {
      getFirstLinkpathDest(linkpath, sourcePath) {
        assert.strictEqual(linkpath, "爱欲的投资、占有与增值");
        assert.strictEqual(sourcePath, "texts/s8-le-transfert/translation/Leçon-04.md");
        return titledReadingNote;
      },
      getFileCache(file) {
        assert.strictEqual(file, titledReadingNote);
        return {
          frontmatter: {
            title: "从“提携年轻人”到“老丈人爱女婿”：爱欲的投资、占有与增值",
          },
        };
      },
    },
  };
  const renderedReadingNoteLink = {
    textContent: "阅读笔记",
    getAttribute(name) {
      return name === "data-href" ? "爱欲的投资、占有与增值" : "";
    },
  };
  assert.strictEqual(typeof plugin.decorateRenderedReadingNoteLinks, "function");
  plugin.decorateRenderedReadingNoteLinks(
    {
      querySelectorAll() {
        return [renderedReadingNoteLink];
      },
    },
    "texts/s8-le-transfert/translation/Leçon-04.md"
  );
  assert.strictEqual(
    renderedReadingNoteLink.textContent,
    "爱欲的投资、占有与增值"
  );

  const note = plugin.buildReadingNoteContent(
    "s8-01-0001",
    "texts/s8-le-transfert/translation/Leçon-01.md",
    { ids: ["s8-01-0001"], original: "Bonjour.", translation: "你好。", annotations: "", commentary: "" }
  );
  assert.ok(note.includes("title: s8-01 章节笔记"));
  assert.ok(note.includes("segments:\n  - s8-01-0001"));
  assert.ok(note.includes("[[texts/s8-le-transfert/translation/Leçon-01.md#s8-01-0001|「s8-01-0001」译文]]"));
  assert.strictEqual(
    plugin.translationWikiLinkForSegment(
      "texts/s8-le-transfert/translation/Leçon-11.md",
      "s8-11-0041"
    ),
    "[[texts/s8-le-transfert/translation/Leçon-11.md#s8-11-0041|「s8-11-0041」译文]]"
  );
  assert.strictEqual(
    plugin.segmentIdFromLinkTarget("texts/s8-le-transfert/translation/Leçon-11.md#s8-11-0041"),
    "s8-11-0041"
  );
  assert.strictEqual(
    plugin.segmentIdFromLinkElement({
      dataset: {},
      getAttribute(name) {
        return name === "data-href" ? "texts/s8-le-transfert/translation/Leçon-11.md#s8-11-0041" : "";
      },
      textContent: "对应译文段落",
    }),
    "s8-11-0041"
  );
  assert.strictEqual(
    plugin.segmentIdFromLinkElement({
      dataset: {},
      getAttribute(name) {
        return name === "data-href" ? "s8-11-0041" : "";
      },
      textContent: "对应译文段落",
    }),
    ""
  );
  assert.strictEqual(
    plugin.segmentIdFromLinkElement({
      dataset: {},
      getAttribute(name) {
        return name === "data-href" ? "s8-11-0041" : "";
      },
      textContent: "「s8-11-0041」译文",
    }),
    ""
  );
  assert.strictEqual(
    plugin.segmentIdFromLinkElement({
      dataset: {},
      getAttribute(name) {
        return name === "data-href" ? "s8-11-0041" : "";
      },
      textContent: "s8-11-0041 阅读笔记",
    }),
    ""
  );
  assert.strictEqual(
    plugin.isPotentialSegmentLinkElement({
      classList: { contains() { return false; } },
      dataset: {},
      getAttribute(name) {
        return name === "data-href" ? "普通笔记" : "";
      },
    }),
    false
  );
  assert.strictEqual(
    plugin.isPotentialSegmentLinkElement({
      classList: { contains() { return false; } },
      dataset: {},
      getAttribute(name) {
        return name === "data-href" ? "texts/s8-le-transfert/translation/Leçon-11.md#s8-11-0041" : "";
      },
    }),
    true
  );
  assert.strictEqual(
    plugin.segmentTargetPathFromLinkElement({
      dataset: {},
      getAttribute(name) {
        return name === "data-href" ? "texts/s8-le-transfert/translation/Le%C3%A7on-11.md#s8-11-0041" : "";
      },
    }),
    "texts/s8-le-transfert/translation/Leçon-11.md"
  );
  assert.strictEqual(
    plugin.segmentTargetPathFromLinkElement({
      dataset: { lacanSegmentTargetPath: "texts/s8-le-transfert/translation/Leçon-11.md" },
      getAttribute() {
        return "#";
      },
    }),
    "texts/s8-le-transfert/translation/Leçon-11.md"
  );
  assert.strictEqual(
    plugin.segmentTargetPathFromLinkElement({
      dataset: {},
      getAttribute(name) {
        return name === "href"
          ? "app://obsidian.md/texts/s8-le-transfert/original/Le%C3%A7on-06.md#s8-06-0009"
          : "";
      },
    }),
    "texts/s8-le-transfert/original/Leçon-06.md"
  );
  assert.strictEqual(
    plugin.segmentDocumentLabel("texts/s8-le-transfert/original/Leçon-06.md"),
    "原文"
  );
  assert.strictEqual(
    plugin.segmentDocumentLabel("texts/s8-le-transfert/translation/Leçon-06.md"),
    "译文"
  );

  const originalPreviewFile = new MockTFile();
  originalPreviewFile.path = "texts/s8-le-transfert/original/Leçon-06.md";
  const translationPreviewFile = new MockTFile();
  translationPreviewFile.path = "texts/s8-le-transfert/translation/Leçon-06.md";
  const previewFiles = new Map([
    [originalPreviewFile.path, originalPreviewFile],
    [translationPreviewFile.path, translationPreviewFile],
  ]);
  const previewTexts = new Map([
    [
      originalPreviewFile.path,
      "<!-- id: s8-06-0009 -->\n\nTexte français.",
    ],
    [
      translationPreviewFile.path,
      "<!-- id: s8-06-0009 -->\n\n中文译文。",
    ],
  ]);
  plugin.segmentPreviewCache = new Map();
  plugin.app = {
    vault: {
      getAbstractFileByPath(filePath) {
        return previewFiles.get(filePath) || null;
      },
      getAllLoadedFiles() {
        return [...previewFiles.values()];
      },
      async cachedRead(file) {
        return previewTexts.get(file.path) || "";
      },
    },
  };
  assert.deepStrictEqual(
    await plugin.loadSegmentPreviewContent("s8-06-0009", originalPreviewFile.path),
    {
      sourcePath: originalPreviewFile.path,
      content: "Texte français.",
    }
  );
  assert.deepStrictEqual(
    await plugin.loadSegmentPreviewContent("s8-06-0009", translationPreviewFile.path),
    {
      sourcePath: translationPreviewFile.path,
      content: "中文译文。",
    }
  );
  assert.strictEqual(
    plugin.segmentPreviewContent(
      "<!-- id: s8-11-0041 -->\n\n[[notes/s8-11-0041|阅读笔记]]\n\n这里是真正的译文。",
      "s8-11-0041"
    ),
    "这里是真正的译文。"
  );
  const segmentSource = [
    "<!-- id: s8-11-0041 -->",
    "",
    "[[notes/s8-11-0041|阅读笔记]]",
    "",
    "这里是真正的译文。",
    "",
    "<!-- id: s8-11-0042 -->",
    "",
    "下一段。",
  ].join("\n");
  const firstMarker = plugin.extractSegmentMarkers(segmentSource)[0];
  assert.strictEqual(firstMarker.targetLine, 4);
  assert.strictEqual(firstMarker.snippet, "这里是真正的译文。");
  assert.strictEqual(plugin.findSegmentLine(segmentSource, "s8-11-0041"), 4);
  assert.deepStrictEqual(plugin.findSegmentLocation(segmentSource, "s8-11-0041"), {
    line: 4,
    col: 0,
    offset: segmentSource.indexOf("这里是真正的译文。"),
  });
  assert.deepStrictEqual(
    plugin.openStateForSegmentLocation(plugin.findSegmentLocation(segmentSource, "s8-11-0041")),
    {
      active: true,
      eState: {
        line: 4,
        startLoc: {
          line: 4,
          col: 0,
          offset: segmentSource.indexOf("这里是真正的译文。"),
        },
        endLoc: {
          line: 4,
          col: 0,
          offset: segmentSource.indexOf("这里是真正的译文。"),
        },
      },
    }
  );
  assert.strictEqual(plugin.segmentPreviewContent(segmentSource, "s8-11-0041"), "这里是真正的译文。");

  const groupedSegmentSource = [
    "<!-- id: s8-06-0058 -->",
    "<!-- ids: s8-06-0058 s8-06-0059 -->",
    "",
    "合并译文。",
  ].join("\n");
  assert.strictEqual(plugin.extractSegmentsById(groupedSegmentSource).get("s8-06-0059"), "合并译文。");
  assert.strictEqual(plugin.findSegmentLine(groupedSegmentSource, "s8-06-0059"), 3);

  const repeatedPrimaryGroupedSegmentSource = [
    "<!-- id: s8-17-0024 -->",
    "<!-- id: s8-17-0024 s8-17-0025 id: s8-17-0026 -->",
    "",
    "合并后的译文。",
  ].join("\n");
  const repeatedPrimaryGroupedMarkers = plugin.extractSegmentMarkers(
    repeatedPrimaryGroupedSegmentSource
  );
  assert.strictEqual(repeatedPrimaryGroupedMarkers.length, 1);
  assert.deepStrictEqual(
    repeatedPrimaryGroupedMarkers[0].ids,
    ["s8-17-0024", "s8-17-0025", "s8-17-0026"]
  );
  const repeatedPrimaryGroupedSegments = plugin.extractSegmentsById(
    repeatedPrimaryGroupedSegmentSource
  );
  assert.strictEqual(repeatedPrimaryGroupedSegments.get("s8-17-0024"), "合并后的译文。");
  assert.strictEqual(repeatedPrimaryGroupedSegments.get("s8-17-0025"), "合并后的译文。");
  assert.strictEqual(repeatedPrimaryGroupedSegments.get("s8-17-0026"), "合并后的译文。");

  const source = [
    "# Leçon 01",
    "",
    "<!-- id: s8-01-0001 -->",
    "",
    "译文正文。",
  ].join("\n");
  const updated = plugin.insertReadingNoteLink(source, "s8-01-0001");
  assert.ok(updated.includes("<!-- id: s8-01-0001 -->\n\n译文正文。\n\n[[notes/s8-01#s8-01-0001|阅读笔记]]\n\n"));
  assert.strictEqual(plugin.insertReadingNoteLink(updated, "s8-01-0001"), updated);
  const moved = plugin.insertReadingNoteLink(
    [
      "# Leçon 01",
      "",
      "<!-- id: s8-01-0001 -->",
      "",
      "[[notes/s8-01#s8-01-0001|阅读笔记]]",
      "",
      "译文正文。",
      "",
      "> 译者说明。",
    ].join("\n"),
    "s8-01-0001"
  );
  assert.ok(moved.includes("<!-- id: s8-01-0001 -->\n\n译文正文。\n\n> 译者说明。\n\n[[notes/s8-01#s8-01-0001|阅读笔记]]\n"));

  const file = new MockTFile();
  file.path = "texts/s8-le-transfert/translation/Leçon-01.md";
  plugin.app = {
    workspace: {
      iterateAllLeaves(callback) {
        callback({
          view: {
            containerEl: {
              contains() {
                return true;
              },
            },
            file,
          },
        });
      },
      getActiveFile() {
        return file;
      },
    },
  };
  const editorApp = plugin.app;
  const lines = [
    { number: 1, from: 0, to: 23, text: "<!-- id: s8-01-0001 -->" },
    { number: 2, from: 24, to: 27, text: "正文。" },
    { number: 3, from: 28, to: 51, text: "<!-- id: s8-01-0002 -->" },
  ];
  const fakeView = {
    dom: {},
    visibleRanges: [{ from: 0, to: lines[0].to }],
    state: {
      doc: {
        length: lines[2].to,
        lineAt(position) {
          return lines.find((line) => position >= line.from && position <= line.to) || lines[0];
        },
      },
    },
  };
  plugin.settings = { segmentAiEnabled: true };
  const decorations = plugin.buildReadingNoteEditorDecorations(fakeView);
  assert.strictEqual(decorations.length, 1);
  assert.strictEqual(decorations[0].from, lines[0].to);

  // Exercise the complete note workflow with an in-memory Vault, including concurrent clicks.
  const noteOpeningSourcePath = "texts/s8-le-transfert/translation/Leçon-01.md";
  const originalPath = noteOpeningSourcePath.replace("/translation/", "/original/");
  const chapterPath = "texts/s8-le-transfert/notes/s8-01.md";
  const legacyPath = "texts/s8-le-transfert/notes/s8-01-0001.md";
  const noteTexts = new Map([
    [noteOpeningSourcePath, [
      "<!-- id: s8-01-0001 -->", "", "第一段。", "",
      "> [注1] 第一条注释。", "> 注释续行。", "",
      "> <!-- 建言 -->", "> 第一条建言。", "",
      "[[notes/s8-01-0001|阅读笔记]]", "",
      "<!-- id: s8-01-0002 -->", "<!-- ids: s8-01-0002 s8-01-0003 -->", "",
      "第二、三段合并译文。", "", "> 未标记的建言。", "",
      "<!-- id: s8-01-0004 -->", "", "缺少对应法文。",
    ].join("\n")],
    [originalPath, "<!-- id: s8-01-0001 -->\nBonjour.\n<!-- id: s8-01-0002 -->\nDeux.\n<!-- id: s8-01-0003 -->\nTrois."],
    [legacyPath, "用户以前的笔记，必须保留。"],
  ]);
  const noteFiles = new Map([...noteTexts.keys()].map((path) => [path, Object.assign(new MockTFile(), { path })]));
  const openedOnRight = [];
  const originalOpenReadingNoteOnRight = plugin.openReadingNoteOnRight;
  plugin.app = {
    vault: {
      getAbstractFileByPath: (path) => noteFiles.get(path),
      read: async (file) => noteTexts.get(file.path),
      async createFolder(path) { noteFiles.set(path, { path }); },
      async create(path, text) {
        assert.ok(!noteFiles.has(path), "a chapter must only be created once");
        const file = Object.assign(new MockTFile(), { path });
        noteFiles.set(path, file);
        noteTexts.set(path, text);
        return file;
      },
      async process(file, update) { noteTexts.set(file.path, update(noteTexts.get(file.path))); },
    },
    fileManager: {
      async processFrontMatter(file, update) {
        const text = noteTexts.get(file.path);
        const header = text.match(/^---\n([\s\S]*?)\n---/)[0];
        const fm = {
          title: header.match(/title: (.*)/)[1],
          segments: [...header.matchAll(/  - (.*)/g)].map((match) => match[1]),
        };
        update(fm);
        noteTexts.set(file.path, text.replace(header, ["---", `title: ${fm.title}`, "segments:", ...fm.segments.map((id) => `  - ${id}`), "---"].join("\n")));
      },
    },
  };
  plugin.openReadingNoteOnRight = async (file) => openedOnRight.push(file.path);
  await Promise.all([
    plugin.createReadingNoteForSegment(noteOpeningSourcePath, "s8-01-0001"),
    plugin.createReadingNoteForSegment(noteOpeningSourcePath, "s8-01-0001"),
  ]);
  const firstNote = noteTexts.get(chapterPath);
  assert.ok(firstNote.includes("### 法语原文\n\nBonjour."));
  assert.ok(firstNote.includes("### 中文译文\n\n第一段。"));
  assert.ok(firstNote.includes("### 当前段落注释\n\n> [注1] 第一条注释。\n> 注释续行。"));
  assert.ok(firstNote.includes("### 当前段落建言\n\n> <!-- 建言 -->\n> 第一条建言。"));
  assert.ok(!firstNote.includes("[[notes/"), "source helper links must not enter the snapshot");
  noteTexts.set(chapterPath, firstNote.replace("Bonjour.", "用户编辑过的法文") + "\n手写分析。\n");
  const editedNote = noteTexts.get(chapterPath);
  await plugin.createReadingNoteForSegment(noteOpeningSourcePath, "s8-01-0001");
  assert.strictEqual(noteTexts.get(chapterPath), editedNote, "repeat click must preserve user edits byte for byte");
  await Promise.all([
    plugin.createReadingNoteForSegment(noteOpeningSourcePath, "s8-01-0002"),
    plugin.createReadingNoteForSegment(noteOpeningSourcePath, "s8-01-0003"),
    plugin.createReadingNoteForSegment(noteOpeningSourcePath, "s8-01-0002"),
  ]);
  const completeNote = noteTexts.get(chapterPath);
  assert.strictEqual((completeNote.match(/第二、三段合并译文。/g) || []).length, 1);
  assert.ok(completeNote.includes("Deux.\n\nTrois."));
  assert.ok(completeNote.includes("> 未标记的建言。"));
  assert.ok(completeNote.includes("手写分析。"));
  assert.ok(completeNote.includes("用户编辑过的法文"));
  assert.ok(completeNote.includes("  - s8-01-0003"));
  assert.strictEqual(noteTexts.get(legacyPath), "用户以前的笔记，必须保留。");
  assert.ok(noteTexts.get(noteOpeningSourcePath).includes("[[notes/s8-01-0001|阅读笔记]]"));
  assert.ok(noteTexts.get(noteOpeningSourcePath).includes("[[notes/s8-01#s8-01-0002|阅读笔记]]"));
  assert.deepStrictEqual(openedOnRight, Array(6).fill(chapterPath));
  assert.deepStrictEqual([...noteTexts.keys()], [noteOpeningSourcePath, originalPath, legacyPath, chapterPath]);
  const beforeFailure = new Map(noteTexts);
  await assert.rejects(plugin.createReadingNoteForSegment(noteOpeningSourcePath, "s8-01-0004"), /找不到分段/);
  await assert.rejects(plugin.createReadingNoteForSegment(noteOpeningSourcePath, "s8-01-9999"), /找不到分段/);
  assert.deepStrictEqual(noteTexts, beforeFailure, "missing sources must not create partial notes or links");
  assert.strictEqual(plugin.readingNotePathForSegment(noteOpeningSourcePath, "s8-02-0001"), "");
  assert.strictEqual(plugin.readingNotePathForSegment(noteOpeningSourcePath, "s9-01-0001"), "");
  await plugin.createReadingNoteForSegment(noteOpeningSourcePath, "s8-01-0001");
  plugin.openReadingNoteOnRight = originalOpenReadingNoteOnRight;

  const oldDocument = global.document;
  const createFakeElement = (tagName) => ({
    tagName: tagName.toUpperCase(),
    children: [],
    className: "",
    textContent: "",
    dataset: {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute() {},
    addEventListener() {},
  });
  global.document = {
    createElement(tagName) {
      return createFakeElement(tagName);
    },
  };
  try {
    const actions = decorations[0].value.widget.toDOM();
    assert.strictEqual(actions.className, "lacan-segment-actions");
    assert.deepStrictEqual(
      actions.children.map((child) => child.textContent),
      ["记笔记", "Ф"]
    );
    assert.strictEqual(actions.children[1].className, "lacan-segment-ai-button");

    plugin.settings.segmentAiEnabled = false;
    plugin.app = editorApp;
    const noteOnlyDecorations = plugin.buildReadingNoteEditorDecorations(fakeView);
    assert.strictEqual(
      decorations[0].value.widget.eq(noteOnlyDecorations[0].value.widget),
      false
    );
    const noteOnlyActions = noteOnlyDecorations[0].value.widget.toDOM();
    assert.deepStrictEqual(
      noteOnlyActions.children.map((child) => child.textContent),
      ["记笔记"]
    );

    plugin.settings.segmentAiEnabled = true;
    const previewControls = [];
    const previewContainer = {
      querySelectorAll() {
        return previewControls;
      },
      prepend(element) {
        previewControls.unshift(element);
      },
    };
    assert.strictEqual(
      plugin.renderSegmentAiPreviewActions(
        previewContainer,
        "texts/s8-le-transfert/translation/Leçon-06.md",
        {
          text: [
            "<!-- id: s8-06-0058 -->",
            "<!-- ids: s8-06-0058 s8-06-0059 -->",
            "",
            "合并译文。",
          ].join("\n"),
          lineStart: 20,
        }
      ),
      1
    );
    assert.strictEqual(previewControls.length, 1);
    assert.strictEqual(previewControls[0].dataset.segmentId, "s8-06-0058");
    assert.strictEqual(
      previewControls[0].children[0].textContent,
      "【s8-06-0058】 Ф"
    );
    assert.ok(
      previewControls[0].children[0].className.includes("has-segment-id"),
      "reading-mode AI buttons should use the wider segment label style"
    );

    const commentaryControls = [];
    const commentaryContainer = {
      querySelectorAll() {
        return commentaryControls;
      },
      prepend(element) {
        commentaryControls.unshift(element);
      },
      closest(selector) {
        return selector === "blockquote" ? this : null;
      },
    };
    assert.strictEqual(
      plugin.renderSegmentAiPreviewActions(
        commentaryContainer,
        "texts/s17-l-envers-de-la-psychanalyse/translation/Leçon-01.md",
        {
          text: [
            "<!-- id: s17-01-0001 -->",
            "",
            "亲爱的朋友们，请允许我再一次追问你们给予我的这份“到场相助”。",
          ].join("\n"),
          lineStart: 15,
        }
      ),
      0,
      "reading-mode AI controls must not be inserted inside commentary blockquotes"
    );
    assert.strictEqual(commentaryControls.length, 0);

    const anchoredPreviewControls = [];
    const blockquoteAnchor = {
      closest(selector) {
        return selector === "blockquote" ? this : null;
      },
      parentNode: {
        insertBefore(control) {
          anchoredPreviewControls.push(control);
        },
      },
    };
    const regularAnchor = {
      closest() {
        return null;
      },
      parentNode: {
        insertBefore(control) {
          anchoredPreviewControls.push(control);
        },
      },
    };
    const mixedPreviewContainer = {
      closest() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
    };
    const originalBuildRenderedAnchorIndex = plugin.buildRenderedAnchorIndex;
    const originalFindRenderedSegmentAnchor = plugin.findRenderedSegmentAnchor;
    plugin.buildRenderedAnchorIndex = () => [];
    plugin.findRenderedSegmentAnchor = (_container, marker) => (
      marker.id === "s17-01-0001" ? blockquoteAnchor : regularAnchor
    );
    try {
      assert.strictEqual(
        plugin.renderSegmentAiPreviewActions(
          mixedPreviewContainer,
          "texts/s17-l-envers-de-la-psychanalyse/translation/Leçon-01.md",
          {
            text: [
              "<!-- id: s17-01-0001 -->",
              "开头译文。",
              "<!-- id: s17-01-0067 -->",
              "后续译文。",
            ].join("\n"),
            lineStart: 0,
          }
        ),
        1,
        "reading-mode AI controls must skip concrete anchors inside commentary blockquotes"
      );
      assert.deepStrictEqual(
        anchoredPreviewControls.map((control) => control.dataset.segmentId),
        ["s17-01-0067"]
      );
    } finally {
      plugin.buildRenderedAnchorIndex = originalBuildRenderedAnchorIndex;
      plugin.findRenderedSegmentAnchor = originalFindRenderedSegmentAnchor;
    }

    const stalePreviewControl = {
      removed: false,
      remove() {
        this.removed = true;
      },
    };
    let previewRerendered = false;
    plugin.settings.segmentAiEnabled = true;
    plugin.app = {
      workspace: {
        containerEl: {
          querySelectorAll(selector) {
            assert.strictEqual(selector, ".lacan-segment-ai-control");
            return [stalePreviewControl];
          },
        },
        updateOptions() {},
        iterateAllLeaves(callback) {
          callback({
            view: {
              previewMode: {
                rerender(force) {
                  assert.strictEqual(force, true);
                  previewRerendered = true;
                },
              },
            },
          });
        },
      },
    };
    plugin.refreshSegmentAiEntrances();
    assert.strictEqual(
      stalePreviewControl.removed,
      true,
      "restarting the enabled plugin must remove stale reading-mode AI controls"
    );
    assert.strictEqual(previewRerendered, true);
  } finally {
    global.document = oldDocument;
  }

  const aiViewStates = [];
  const aiLeaf = {
    view: null,
    async setViewState(state) {
      assert.strictEqual(state.type, "lacan-segment-interpretation");
      assert.strictEqual(state.active, true);
      this.view = {
        setState(viewState) {
          aiViewStates.push(viewState);
        },
      };
    },
  };
  let aiLeafRevealed = false;
  plugin.segmentAiState = { status: "empty" };
  plugin.app = {
    workspace: {
      getLeavesOfType() {
        return [];
      },
      getRightLeaf(create) {
        assert.strictEqual(create, false);
        return aiLeaf;
      },
      async revealLeaf(leaf) {
        assert.strictEqual(leaf, aiLeaf);
        aiLeafRevealed = true;
      },
    },
  };
  assert.strictEqual(typeof plugin.openSegmentInterpretationView, "function");
  assert.strictEqual(await plugin.openSegmentInterpretationView(), aiLeaf);
  assert.strictEqual(aiLeafRevealed, true);
  assert.deepStrictEqual(aiViewStates, [{ status: "empty" }]);

  const interpretationCalls = [];
  plugin.settings = { segmentAiEnabled: true };
  plugin.segmentAiController = {
    async interpret(sourcePath, segmentId) {
      interpretationCalls.push({ sourcePath, segmentId });
      return { state: "completed" };
    },
  };
  plugin.openSegmentInterpretationView = async () => aiLeaf;
  assert.deepStrictEqual(
    await plugin.interpretSegment(
      "texts/s8-le-transfert/translation/Leçon-01.md",
      "s8-01-0001"
    ),
    { state: "completed" }
  );
  assert.deepStrictEqual(interpretationCalls, [{
    sourcePath: "texts/s8-le-transfert/translation/Leçon-01.md",
    segmentId: "s8-01-0001",
  }]);
  plugin.openSegmentInterpretationView = async () => {
    throw new Error("right leaf unavailable");
  };
  const failedInterpretation = await plugin.interpretSegment(
    "texts/s8-le-transfert/translation/Leçon-01.md",
    "s8-01-0001"
  );
  assert.strictEqual(failedInterpretation.state, "failed");
  assert.strictEqual(plugin.segmentAiState.workspaceError.code, "Unknown");

  const rightPaneNote = new MockTFile();
  rightPaneNote.path = "texts/s8-le-transfert/notes/s8-01.md";
  const rightPaneLeaf = {
    async openFile(file) {
      assert.strictEqual(file, rightPaneNote);
    },
  };
  let revealedLeaf = null;
  plugin.app = {
    workspace: {
      getLeaf(mode, direction) {
        assert.strictEqual(mode, "split");
        assert.strictEqual(direction, "vertical");
        return rightPaneLeaf;
      },
      revealLeaf(leaf) {
        revealedLeaf = leaf;
      },
    },
  };
  assert.strictEqual(typeof plugin.openReadingNoteOnRight, "function");
  await plugin.openReadingNoteOnRight(rightPaneNote);
  assert.strictEqual(revealedLeaf, rightPaneLeaf);
} finally {
  Module._load = originalLoad;
}
};

run().then(() => console.log("lacan translation helper tests passed")).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
