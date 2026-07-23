const assert = require("assert");
const Module = require("module");
const path = require("path");

const originalLoad = Module._load;
let markdownRenderCount = 0;

class MockTFile {
  constructor(pathname, content) {
    this.path = pathname;
    this.extension = "md";
    this.content = content;
  }
}

class MockItemView {
  constructor(leaf) {
    this.leaf = leaf;
    this.containerEl = leaf.containerEl;
  }
}

class MockMenuItem {
  setTitle(title) {
    this.title = title;
    return this;
  }

  setIcon(icon) {
    this.icon = icon;
    return this;
  }

  onClick(handler) {
    this.click = handler;
    return this;
  }
}

class MockMenu {
  static instances = [];

  constructor() {
    this.items = [];
    this.shown = false;
    MockMenu.instances.push(this);
  }

  addItem(configure) {
    const item = new MockMenuItem();
    configure(item);
    this.items.push(item);
    return this;
  }

  showAtMouseEvent(event) {
    this.event = event;
    this.shown = true;
  }
}

class MockElement {
  constructor(tag = "div", className = "") {
    this.tag = tag;
    this.className = className;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.value = "";
    this.textContent = "";
    this._scrollTop = 0;
    this.scrollTopWrites = [];
    this.scrollHeight = className.includes("lacan-ai-view-scroll") ? 1200 : 0;
    this.clientHeight = className.includes("lacan-ai-view-scroll") ? 400 : 0;
    this.ownerDocument = MockElement.ownerDocument;
    this.style = {
      setProperty() {},
    };
  }

  get scrollTop() {
    return this._scrollTop;
  }

  set scrollTop(value) {
    this._scrollTop = Number(value || 0);
    this.scrollTopWrites.push(this._scrollTop);
  }

  empty() {
    this.children = [];
  }

  addClass(className) {
    const classes = new Set(this.className.split(/\s+/).filter(Boolean));
    classes.add(className);
    this.className = Array.from(classes).join(" ");
  }

  createDiv(value = "") {
    return this.createEl("div", typeof value === "string" ? { cls: value } : value);
  }

  createSpan(value = {}) {
    return this.createEl("span", value);
  }

  createEl(tag, options = {}) {
    const child = new MockElement(tag, options.cls || "");
    child.text = options.text || "";
    child.textContent = options.text || "";
    child.attributes = { ...(options.attr || {}) };
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = children;
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  addEventListener(name, listener) {
    this.listeners[name] = listener;
  }

  hasClass(className) {
    return this.className.split(/\s+/).includes(className);
  }

  dispatch(name, event = {}) {
    this.listeners[name]?.(event);
  }
}

const descendants = (element) => element.children.flatMap(
  (child) => [child, ...descendants(child)]
);

const mockWindow = {
  requestAnimationFrame(callback) {
    callback();
    return 1;
  },
};

MockElement.ownerDocument = {
  defaultView: mockWindow,
  createElement(tag) {
    const element = new MockElement(tag);
    element.ownerDocument = this;
    return element;
  },
};

Module._load = function load(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      Component: class {
        load() {}
        unload() {}
      },
      ItemView: MockItemView,
      Menu: MockMenu,
      MarkdownRenderer: {
        async render(_app, markdown, element) {
          markdownRenderCount += 1;
          element.renderedMarkdown = markdown;
        },
      },
      TFile: MockTFile,
      normalizePath(value) {
        return String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

const run = async () => {
  try {
    const {
      LACAN_INTERPRETATION_VIEW_TYPE,
      LacanInterpretationView,
      createObsidianContextResolver,
      isNearScrollBottom,
      measureStatusBarClearance,
      nextConversationAnchor,
      segmentAiStatusLabel,
      shouldSubmitFollowUpOnKeydown,
      shouldResetAutoScroll,
    } = require(path.join(
      __dirname,
      "..",
      ".obsidian",
      "plugins",
      "lacan-translation-helper",
      "segment-ai",
      "obsidian-integration.js"
    ));

    const translationPath = "texts/s8-test/translation/Leçon-01.md";
    const originalPath = "texts/s8-test/original/Leçon-01.md";
    const files = [
      new MockTFile(translationPath, [
        "<!-- id: s8-01-0001 -->",
        "",
        "译文。",
      ].join("\n")),
      new MockTFile(originalPath, [
        "<!-- id: s8-01-0001 -->",
        "",
        "Original.",
      ].join("\n")),
      new MockTFile("texts/s8-test/glossary.md", "| original | 原文 | |"),
    ];
    const app = {
      vault: {
        getAbstractFileByPath(requestedPath) {
          return files.find((file) => file.path === requestedPath) || null;
        },
        getMarkdownFiles() {
          return files;
        },
        async cachedRead(file) {
          return file.content;
        },
      },
    };
    const resolver = createObsidianContextResolver(app);
    const context = await resolver.resolve(translationPath, "s8-01-0001");
    assert.strictEqual(context.targetTranslation.visibleText, "译文。");
    assert.strictEqual(context.alignedOriginals[0].visibleText, "Original.");

    const plugin = {
      app,
      segmentAiState: { status: "empty" },
    };
    const view = new LacanInterpretationView({
      containerEl: {
        children: [{}, {}],
      },
    }, plugin);
    assert.strictEqual(view.getViewType(), LACAN_INTERPRETATION_VIEW_TYPE);
    assert.strictEqual(view.getDisplayText(), "Lacan AI");
    assert.strictEqual(view.getIcon(), "message-square-text");

    let renderedState;
    view.render = async () => {
      renderedState = view.state;
    };
    view.setState({
      status: "streaming",
      answer: "正在回答",
    });
    assert.strictEqual(renderedState.status, "streaming");
    assert.strictEqual(view.state.answer, "正在回答");

    assert.strictEqual(segmentAiStatusLabel("resolving"), "正在定位分段资料");
    assert.strictEqual(segmentAiStatusLabel("unavailable"), "本地 Agent 不可用");
    assert.strictEqual(segmentAiStatusLabel("unknown"), "等待操作");
    assert.strictEqual(
      shouldSubmitFollowUpOnKeydown({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        keyCode: 13,
      }, false),
      true
    );
    assert.strictEqual(
      shouldSubmitFollowUpOnKeydown({
        key: "Enter",
        shiftKey: true,
        isComposing: false,
        keyCode: 13,
      }, false),
      false,
      "Shift+Enter should insert a newline"
    );
    assert.strictEqual(
      shouldSubmitFollowUpOnKeydown({
        key: "Enter",
        shiftKey: false,
        isComposing: true,
        keyCode: 229,
      }, true),
      false,
      "IME candidate confirmation must not submit"
    );
    assert.deepStrictEqual(
      nextConversationAnchor([100, 400, 900], 410, -1),
      100
    );
    assert.deepStrictEqual(
      nextConversationAnchor([100, 400, 900], 410, 1),
      900
    );
    assert.strictEqual(
      measureStatusBarClearance({
        querySelector() {
          return {
            getBoundingClientRect() {
              return { height: 32.4 };
            },
          };
        },
      }),
      33,
      "composer clearance should follow the actual Obsidian status bar height"
    );
    assert.strictEqual(measureStatusBarClearance(null), 0);
    assert.strictEqual(
      isNearScrollBottom({
        scrollTop: 751,
        scrollHeight: 1200,
        clientHeight: 400,
      }),
      false,
      "more than the threshold above the bottom should pause automatic following"
    );
    assert.strictEqual(
      isNearScrollBottom({
        scrollTop: 760,
        scrollHeight: 1200,
        clientHeight: 400,
      }),
      true,
      "returning close to the bottom should resume automatic following"
    );
    assert.strictEqual(
      shouldResetAutoScroll(
        { status: "completed", answer: "上一轮回答", context },
        { status: "starting", answer: "", context }
      ),
      true,
      "a new follow-up turn should start with automatic following enabled"
    );
    assert.strictEqual(
      shouldResetAutoScroll(
        { status: "streaming", answer: "已有内容", context },
        { status: "streaming", answer: "已有内容和新增内容", context }
      ),
      false,
      "streaming deltas in the same turn should preserve the user's scroll preference"
    );

    const streamingRoot = new MockElement();
    const streamingView = new LacanInterpretationView({
      containerEl: {
        children: [{}, streamingRoot],
      },
    }, {
      ...plugin,
      segmentAiState: {
        status: "streaming",
        context,
        answer: "第一段回答。",
      },
      stopSegmentInterpretation() {},
      openSegmentSource() {},
    });
    streamingView.contentEl = streamingRoot;
    await streamingView.render();
    const initialStreamingScroll = streamingRoot.children.find(
      (child) => child.hasClass("lacan-ai-view-scroll")
    );
    assert.strictEqual(
      initialStreamingScroll.scrollTop,
      initialStreamingScroll.scrollHeight,
      "streaming output should initially follow the latest content"
    );

    initialStreamingScroll.scrollTop = 120;
    initialStreamingScroll.dispatch("scroll");
    assert.strictEqual(
      streamingView.autoScrollEnabled,
      false,
      "scrolling upward should pause automatic following"
    );
    streamingView.setState({
      status: "streaming",
      context,
      answer: "第一段回答。\n\n第二段回答。",
    });
    await streamingView.render();
    const updatedStreamingScroll = streamingRoot.children.find(
      (child) => child.hasClass("lacan-ai-view-scroll")
    );
    assert.strictEqual(
      updatedStreamingScroll,
      initialStreamingScroll,
      "streaming updates should keep the same scroll container so the scrollbar remains draggable"
    );
    assert.strictEqual(
      updatedStreamingScroll.scrollTop,
      120,
      "streaming updates should preserve the reading position while automatic following is paused"
    );

    updatedStreamingScroll.scrollTop =
      updatedStreamingScroll.scrollHeight - updatedStreamingScroll.clientHeight;
    updatedStreamingScroll.dispatch("scroll");
    assert.strictEqual(
      streamingView.autoScrollEnabled,
      true,
      "returning to the bottom should resume automatic following"
    );
    streamingView.setState({
      status: "streaming",
      context,
      answer: "第一段回答。\n\n第二段回答。\n\n最新生成内容。",
    });
    await streamingView.render();
    assert.strictEqual(
      updatedStreamingScroll.scrollTop,
      updatedStreamingScroll.scrollHeight,
      "resumed automatic following should keep the latest generated content visible"
    );

    const completedRoot = new MockElement();
    const completedView = new LacanInterpretationView({
      containerEl: {
        children: [{}, completedRoot],
      },
    }, {
      ...plugin,
      segmentAiState: {
        status: "completed",
        context,
        answer: "## 已完成\n\n正文。",
      },
      retrySegmentInterpretation() {},
      followUpSegmentInterpretation() {},
      openSegmentSource() {},
    });
    completedView.contentEl = completedRoot;
    await completedView.render();

    const scrollRegion = completedRoot.children.find(
      (child) => child.hasClass("lacan-ai-view-scroll")
    );
    const followUp = completedRoot.children.find(
      (child) => child.hasClass("lacan-ai-follow-up")
    );
    assert.ok(scrollRegion, "answer and metadata should live in a dedicated scroll region");
    assert.ok(followUp, "completed view should render a separate follow-up footer");
    assert.ok(
      !descendants(followUp).some(
        (child) => child.tag === "button" && child.textContent === "发送"
      ),
      "follow-up composers should send with Enter and must not render a send button"
    );
    assert.ok(
      scrollRegion.children.some((child) => child.hasClass("lacan-ai-answer")),
      "answer should stay inside the scroll region"
    );
    assert.ok(
      !scrollRegion.children.includes(followUp),
      "follow-up footer must not overlap or scroll inside the answer"
    );
    assert.ok(
      completedRoot.children.indexOf(scrollRegion) < completedRoot.children.indexOf(followUp),
      "follow-up footer should follow the scroll region in DOM order"
    );

    const workspaceRoot = new MockElement();
    const followUps = [];
    const activations = [];
    let clearAllCalls = 0;
    const workspaceConversation = {
      id: "conversation-1",
      title: "s8-01-0001",
      requestedId: "s8-01-0001",
      primaryId: "s8-01-0001",
      sourcePath: translationPath,
      lessonTitle: "Leçon 1",
      status: "failed",
      answer: "失败前已经收到的内容。",
      messages: [
        {
          id: "message-1",
          role: "user",
          kind: "initial",
          status: "completed",
          content: "s8-01-0001 · 初始解读",
        },
        {
          id: "message-2",
          role: "assistant",
          kind: "initial",
          status: "failed",
          content: "失败前已经收到的内容。",
        },
      ],
      skillProfile: { id: "standard", title: "标准解读" },
      draft: "",
      scroll: {
        followLatest: true,
        scrollTop: 0,
        unseenMessageCount: 0,
      },
      error: {
        code: "TurnFailed",
        message: "本次生成失败，但其他会话仍然可用。",
      },
      needsAttention: false,
      isOpen: true,
    };
    const workspacePlugin = {
      ...plugin,
      segmentAiState: {
        maxOpenSessions: 3,
        openConversationIds: ["conversation-1"],
        activeConversationId: "conversation-1",
        conversations: [workspaceConversation],
        runningCount: 0,
      },
      activateSegmentAiConversation(id) {
        activations.push(id);
      },
      followUpSegmentInterpretation(id, question) {
        followUps.push({ id, question });
      },
      updateSegmentAiDraft() {},
      updateSegmentAiScroll() {},
      retrySegmentInterpretation() {},
      closeSegmentAiConversation() {},
      deleteSegmentAiConversation() {},
      clearAllSegmentAiConversations() {
        clearAllCalls += 1;
      },
      stopSegmentInterpretation() {},
      openSegmentSource() {},
      getSegmentAiDiagnostics() {
        return {};
      },
    };
    const workspaceView = new LacanInterpretationView({
      containerEl: {
        children: [{}, workspaceRoot],
      },
    }, workspacePlugin);
    workspaceView.contentEl = workspaceRoot;
    await workspaceView.render();
    const tabBar = workspaceRoot.children.find(
      (child) => child.hasClass("lacan-ai-tabs")
    );
    assert.ok(tabBar, "workspace mode should render the open conversation tabs");
    const activeTab = tabBar.children.find(
      (child) => child.hasClass("lacan-ai-tab")
    );
    assert.strictEqual(activeTab.attributes["aria-selected"], "true");
    activeTab.dispatch("click", { preventDefault() {} });
    assert.deepStrictEqual(activations, ["conversation-1"]);

    const workspaceComposer = workspaceRoot.children.find(
      (child) => child.hasClass("lacan-ai-follow-up")
    );
    assert.ok(
      workspaceComposer,
      "a failed conversation must keep the composer and recovery controls usable"
    );
    assert.ok(
      !descendants(workspaceComposer).some(
        (child) => child.tag === "button" && child.textContent === "发送"
      ),
      "workspace composers should send with Enter and must not render a send button"
    );
    const textarea = workspaceComposer.children.find(
      (child) => child.tag === "textarea"
    );
    textarea.value = "失败后继续追问";
    let prevented = false;
    textarea.dispatch("keydown", {
      key: "Enter",
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      isComposing: false,
      keyCode: 13,
      preventDefault() {
        prevented = true;
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(prevented, true);
    assert.deepStrictEqual(followUps, [{
      id: "conversation-1",
      question: "失败后继续追问",
    }]);

    const navigator = workspaceRoot.children
      .flatMap((child) => child.children)
      .find((child) => child.hasClass("lacan-ai-navigator"));
    assert.ok(navigator, "conversation view should expose the five Claudian-style jumps");
    assert.deepStrictEqual(
      navigator.children.map((child) => child.attributes["aria-label"]),
      ["回到会话顶部", "上一条提问", "打开会话目录", "下一条提问", "回到会话底部"]
    );
    MockMenu.instances = [];
    navigator.children[2].dispatch("click", {
      preventDefault() {},
      stopPropagation() {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(
      MockMenu.instances.length,
      1,
      "the conversation directory should use an Obsidian overlay menu"
    );
    assert.strictEqual(MockMenu.instances[0].shown, true);
    assert.deepStrictEqual(
      MockMenu.instances[0].items.map((item) => item.title),
      ["1. s8-01-0001 · 初始解读"]
    );
    const workspaceScrollForDirectory = workspaceRoot.children.find(
      (child) => child.hasClass("lacan-ai-view-scroll")
    );
    assert.ok(
      !workspaceScrollForDirectory.children.some(
        (child) => child.hasClass("lacan-ai-directory")
      ),
      "the directory must not be rendered inside the clipped answer scroller"
    );

    workspaceView.historyOpen = true;
    await workspaceView.render();
    const history = workspaceRoot.children.find(
      (child) => child.hasClass("lacan-ai-history")
    );
    assert.ok(history, "opening history should render a bounded history drawer");
    const historyList = history.children.find(
      (child) => child.hasClass("lacan-ai-history-list")
    );
    assert.ok(
      historyList,
      "history rows should scroll inside a list separate from the fixed heading"
    );
    assert.strictEqual(
      historyList.children.filter(
        (child) => child.hasClass("lacan-ai-history-row")
      ).length,
      1
    );
    const clearAllButton = descendants(history).find(
      (child) => child.tag === "button" && child.textContent === "清空全部"
    );
    assert.ok(clearAllButton, "history should expose a clear-all action");
    clearAllButton.dispatch("click", { preventDefault() {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(clearAllCalls, 1);

    const workspaceStreamingRoot = new MockElement();
    const workspaceStreamingConversation = {
      ...workspaceConversation,
      status: "streaming",
      error: null,
      messages: workspaceConversation.messages.map((message) => (
        message.role === "assistant"
          ? {
              ...message,
              status: "pending",
              content: "正在生成的第一部分。",
            }
          : { ...message }
      )),
      scroll: {
        followLatest: true,
        scrollTop: 0,
        unseenMessageCount: 0,
      },
    };
    const workspaceStreamingPlugin = {
      ...workspacePlugin,
      segmentAiState: {
        maxOpenSessions: 3,
        openConversationIds: ["conversation-1"],
        activeConversationId: "conversation-1",
        conversations: [workspaceStreamingConversation],
        runningCount: 1,
      },
    };
    const workspaceStreamingView = new LacanInterpretationView({
      containerEl: {
        children: [{}, workspaceStreamingRoot],
      },
    }, workspaceStreamingPlugin);
    workspaceStreamingView.contentEl = workspaceStreamingRoot;
    await workspaceStreamingView.render();
    const workspaceStreamingScroll = workspaceStreamingRoot.children.find(
      (child) => child.hasClass("lacan-ai-view-scroll")
    );
    assert.strictEqual(
      workspaceStreamingScroll.scrollTop,
      workspaceStreamingScroll.scrollHeight,
      "a new workspace stream should start at the latest content"
    );
    workspaceStreamingScroll.scrollTop = 120;
    workspaceStreamingScroll.dispatch("scroll");
    workspaceStreamingScroll.scrollTopWrites.length = 0;
    workspaceStreamingView.setState({
      ...workspaceStreamingPlugin.segmentAiState,
      conversations: [{
        ...workspaceStreamingConversation,
        messages: workspaceStreamingConversation.messages.map((message) => (
          message.role === "assistant"
            ? {
                ...message,
                content: "正在生成的第一部分。\n\n随后生成的第二部分。",
              }
            : { ...message }
        )),
      }],
    });
    await workspaceStreamingView.render();
    const workspaceUpdatedScroll = workspaceStreamingRoot.children.find(
      (child) => child.hasClass("lacan-ai-view-scroll")
    );
    assert.strictEqual(
      workspaceUpdatedScroll,
      workspaceStreamingScroll,
      "workspace streaming should patch the answer without replacing its scroll container"
    );
    assert.strictEqual(
      workspaceUpdatedScroll.scrollTop,
      120,
      "workspace streaming must preserve an upward reading position"
    );
    assert.deepStrictEqual(
      workspaceUpdatedScroll.scrollTopWrites,
      [],
      "streaming must not write scrollTop while the user is reading above the bottom"
    );
    const returnLatest = workspaceUpdatedScroll.children.find(
      (child) => child.hasClass("lacan-ai-return-latest")
    );
    assert.ok(
      returnLatest && !returnLatest.hasClass("is-hidden"),
      "scrolling upward should expose the return-to-latest control"
    );
    workspaceUpdatedScroll.scrollTop =
      workspaceUpdatedScroll.scrollHeight - workspaceUpdatedScroll.clientHeight;
    workspaceUpdatedScroll.dispatch("scroll");
    assert.strictEqual(
      workspaceStreamingView.workspaceScrollStates.get(
        "conversation-1"
      ).followLatest,
      false,
      "reaching the bottom while dragging should not immediately resume auto-scroll"
    );
    await new Promise((resolve) => setTimeout(resolve, 170));
    assert.strictEqual(
      workspaceStreamingView.workspaceScrollStates.get(
        "conversation-1"
      ).followLatest,
      true,
      "auto-scroll should resume after the bottom position remains stable"
    );

    const deferredFrames = [];
    const deferredFrameWindow = {
      requestAnimationFrame(callback) {
        deferredFrames.push(callback);
        return deferredFrames.length;
      },
      cancelAnimationFrame() {},
      setTimeout,
      clearTimeout,
    };
    const deferredFrameDocument = {
      defaultView: deferredFrameWindow,
      createElement(tag) {
        const element = new MockElement(tag);
        element.ownerDocument = this;
        return element;
      },
    };
    const coalescedStreamingRoot = new MockElement();
    coalescedStreamingRoot.ownerDocument = deferredFrameDocument;
    const coalescedStreamingPlugin = {
      ...workspaceStreamingPlugin,
      segmentAiState: workspaceStreamingPlugin.segmentAiState,
    };
    const coalescedStreamingView = new LacanInterpretationView({
      containerEl: {
        children: [{}, coalescedStreamingRoot],
      },
    }, coalescedStreamingPlugin);
    coalescedStreamingView.contentEl = coalescedStreamingRoot;
    await coalescedStreamingView.render();
    while (deferredFrames.length) {
      deferredFrames.shift()();
    }
    const renderCountBeforeBurst = markdownRenderCount;
    const streamingContent = (content) => ({
      ...workspaceStreamingPlugin.segmentAiState,
      conversations: [{
        ...workspaceStreamingConversation,
        messages: workspaceStreamingConversation.messages.map((message) => (
          message.role === "assistant"
            ? { ...message, content }
            : { ...message }
        )),
      }],
    });
    coalescedStreamingView.setState(
      streamingContent("同一帧的第一次流式更新。")
    );
    coalescedStreamingView.setState(
      streamingContent("同一帧的第二次流式更新，应覆盖第一次。")
    );
    assert.strictEqual(
      markdownRenderCount,
      renderCountBeforeBurst,
      "streaming Markdown should wait for the next animation frame"
    );
    assert.strictEqual(
      deferredFrames.length,
      1,
      "multiple streaming deltas in one frame should schedule one render"
    );
    deferredFrames.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(
      markdownRenderCount,
      renderCountBeforeBurst + 1,
      "multiple streaming deltas in one frame should render Markdown once"
    );
    assert.strictEqual(
      coalescedStreamingView.workspaceDom.answerEl.children[0].renderedMarkdown,
      "同一帧的第二次流式更新，应覆盖第一次。",
      "the coalesced render should commit the latest streamed content"
    );

    const backgroundStreamingRoot = new MockElement();
    const stableActiveConversation = {
      ...workspaceConversation,
      status: "completed",
      answer: "当前标签已经完成。",
      error: null,
      updatedAt: "2026-07-23T12:00:00.000Z",
      messages: workspaceConversation.messages.map((message) => ({
        ...message,
        status: "completed",
        content: message.role === "assistant"
          ? "当前标签已经完成。"
          : message.content,
      })),
    };
    const backgroundStreamingConversation = {
      ...workspaceStreamingConversation,
      id: "conversation-2",
      title: "s8-01-0002",
      requestedId: "s8-01-0002",
      primaryId: "s8-01-0002",
      updatedAt: "2026-07-23T12:01:00.000Z",
    };
    const backgroundStreamingState = {
      maxOpenSessions: 3,
      openConversationIds: ["conversation-1", "conversation-2"],
      activeConversationId: "conversation-1",
      conversations: [
        backgroundStreamingConversation,
        stableActiveConversation,
      ],
      runningCount: 1,
    };
    const backgroundStreamingView = new LacanInterpretationView({
      containerEl: {
        children: [{}, backgroundStreamingRoot],
      },
    }, {
      ...workspacePlugin,
      segmentAiState: backgroundStreamingState,
    });
    backgroundStreamingView.contentEl = backgroundStreamingRoot;
    await backgroundStreamingView.render();
    const stableActiveScroll = backgroundStreamingRoot.children.find(
      (child) => child.hasClass("lacan-ai-view-scroll")
    );
    const stableActiveComposer = backgroundStreamingRoot.children.find(
      (child) => child.hasClass("lacan-ai-follow-up")
    );

    backgroundStreamingView.setState({
      ...backgroundStreamingState,
      conversations: [
        {
          ...backgroundStreamingConversation,
          answer: "后台生成的第一部分。\n\n后台生成的第二部分。",
          updatedAt: "2026-07-23T12:01:01.000Z",
          messages: backgroundStreamingConversation.messages.map((message) => (
            message.role === "assistant"
              ? {
                  ...message,
                  content: "后台生成的第一部分。\n\n后台生成的第二部分。",
                }
              : { ...message }
          )),
        },
        stableActiveConversation,
      ],
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(
      backgroundStreamingRoot.children.find(
        (child) => child.hasClass("lacan-ai-view-scroll")
      ),
      stableActiveScroll,
      "a background stream must not rebuild the completed active conversation"
    );
    assert.strictEqual(
      backgroundStreamingRoot.children.find(
        (child) => child.hasClass("lacan-ai-follow-up")
      ),
      stableActiveComposer,
      "a background stream must keep the active composer mounted"
    );
  } finally {
    Module._load = originalLoad;
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
