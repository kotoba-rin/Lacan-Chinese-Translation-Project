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
    plugin.segmentPreviewContent(
      "<!-- id: s8-11-0041 -->\n\n[[notes/s8-11-0041|阅读笔记]]\n\n这里是真正的译文。",
      "s8-11-0041"
    ),
    "这里是真正的译文。"
  );

  const source = [
    "# Leçon 01",
    "",
    "<!-- id: s8-01-0001 -->",
    "",
    "译文正文。",
  ].join("\n");
  const updated = plugin.insertReadingNoteLink(source, "s8-01-0001");
  assert.ok(updated.includes("<!-- id: s8-01-0001 -->\n\n[[notes/s8-01-0001|阅读笔记]]\n\n译文正文。"));
  assert.strictEqual(plugin.insertReadingNoteLink(updated, "s8-01-0001"), updated);

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
  const decorations = plugin.buildReadingNoteEditorDecorations(fakeView);
  assert.strictEqual(decorations.length, 1);
  assert.strictEqual(decorations[0].from, lines[0].to);

  const oldDocument = global.document;
  global.document = {
    createElement() {
      return {
        setAttribute() {},
        addEventListener() {},
      };
    },
  };
  try {
    const button = decorations[0].value.widget.toDOM();
    assert.strictEqual(button.textContent, "+创建笔记");
  } finally {
    global.document = oldDocument;
  }
} finally {
  Module._load = originalLoad;
}
