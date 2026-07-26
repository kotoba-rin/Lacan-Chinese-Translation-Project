const assert = require("assert");
const Module = require("module");
const path = require("path");

const originalLoad = Module._load;

class MockPlugin {}
class MockTFile {}

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
      normalizePath(value) {
        return String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
      },
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
    "texts/s8-le-transfert/notes/s8-01-0001.md"
  );
  assert.strictEqual(plugin.isReadingNotePath("texts/s8-le-transfert/notes/s8-11-0041.md"), true);
  assert.strictEqual(plugin.isReadingNotePath("texts/s8-le-transfert/translation/Leçon-11.md"), false);

  assert.strictEqual(
    plugin.readingNoteWikiLinkForSegment("s8-01-0001"),
    "[[notes/s8-01-0001|阅读笔记]]"
  );

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
    "texts/s8-le-transfert/translation/Leçon-01.md"
  );
  assert.ok(note.includes("title: s8-01-0001 阅读笔记"));
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

  const source = [
    "# Leçon 01",
    "",
    "<!-- id: s8-01-0001 -->",
    "",
    "译文正文。",
  ].join("\n");
  const updated = plugin.insertReadingNoteLink(source, "s8-01-0001");
  assert.ok(updated.includes("<!-- id: s8-01-0001 -->\n\n译文正文。\n\n[[notes/s8-01-0001|阅读笔记]]\n\n"));
  assert.strictEqual(plugin.insertReadingNoteLink(updated, "s8-01-0001"), updated);
  const moved = plugin.insertReadingNoteLink(
    [
      "# Leçon 01",
      "",
      "<!-- id: s8-01-0001 -->",
      "",
      "[[notes/s8-01-0001|阅读笔记]]",
      "",
      "译文正文。",
      "",
      "> 译者说明。",
    ].join("\n"),
    "s8-01-0001"
  );
  assert.ok(moved.includes("<!-- id: s8-01-0001 -->\n\n译文正文。\n\n> 译者说明。\n\n[[notes/s8-01-0001|阅读笔记]]\n"));

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

  const noteOpeningSourcePath = "texts/s8-le-transfert/translation/Leçon-01.md";
  const noteOpeningSource = [
    "<!-- id: s8-01-0001 -->",
    "",
    "第一段。",
    "",
    "<!-- id: s8-01-0002 -->",
    "",
    "第二段。",
  ].join("\n");
  const createdNote = new MockTFile();
  createdNote.path = "texts/s8-le-transfert/notes/s8-01-0001.md";
  const existingNote = new MockTFile();
  existingNote.path = "texts/s8-le-transfert/notes/s8-01-0002.md";
  const noteFiles = [createdNote, existingNote];
  const openedOnRight = [];
  const originalCreateOrUpdateReadingNoteFile = plugin.createOrUpdateReadingNoteFile;
  const originalOpenReadingNoteOnRight = plugin.openReadingNoteOnRight;
  const originalOpenFile = plugin.openFile;
  plugin.app = {
    vault: {
      getAbstractFileByPath(requestedPath) {
        assert.strictEqual(requestedPath, noteOpeningSourcePath);
        return file;
      },
      async read(requestedFile) {
        assert.strictEqual(requestedFile, file);
        return noteOpeningSource;
      },
      async modify(requestedFile) {
        assert.strictEqual(requestedFile, file);
      },
    },
  };
  plugin.createOrUpdateReadingNoteFile = async () => noteFiles.shift();
  plugin.openReadingNoteOnRight = async (noteFile) => {
    openedOnRight.push(noteFile);
  };
  plugin.openFile = async () => {
    throw new Error("阅读笔记不应在当前叶窗格打开");
  };
  await plugin.createReadingNoteForSegment(noteOpeningSourcePath, "s8-01-0001");
  await plugin.createReadingNoteForSegment(noteOpeningSourcePath, "s8-01-0002");
  assert.deepStrictEqual(openedOnRight, [createdNote, existingNote]);
  plugin.createOrUpdateReadingNoteFile = originalCreateOrUpdateReadingNoteFile;
  plugin.openReadingNoteOnRight = originalOpenReadingNoteOnRight;
  plugin.openFile = originalOpenFile;

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
  rightPaneNote.path = "texts/s8-le-transfert/notes/s8-01-0001.md";
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

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
