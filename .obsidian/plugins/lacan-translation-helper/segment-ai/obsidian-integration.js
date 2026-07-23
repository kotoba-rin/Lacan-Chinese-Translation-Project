const Obsidian = require("obsidian");
const {
  Component,
  ItemView,
  MarkdownRenderer,
  Menu,
  Notice,
  TFile,
  normalizePath,
} = Obsidian;
const { SegmentContextResolver } = require("./context-resolver");

const LACAN_INTERPRETATION_VIEW_TYPE = "lacan-segment-interpretation";
const AUTO_SCROLL_THRESHOLD_PX = 48;
const WORKSPACE_AUTO_SCROLL_THRESHOLD_PX = 20;
const WORKSPACE_AUTO_SCROLL_RESUME_DELAY_MS = 150;
const ACTIVE_GENERATION_STATUSES = new Set([
  "starting",
  "searching",
  "streaming",
]);

const measureStatusBarClearance = (documentRef = globalThis.document) => {
  if (!documentRef || typeof documentRef.querySelector !== "function") {
    return 0;
  }
  const statusBar = documentRef.querySelector(".status-bar");
  const height = Number(statusBar?.getBoundingClientRect?.().height || 0);
  return Number.isFinite(height) && height > 0 ? Math.ceil(height) : 0;
};

const STATUS_LABELS = {
  empty: "等待操作",
  resolving: "正在定位分段资料",
  starting: "正在启动本地 Agent",
  searching: "Agent 正在检索资料",
  streaming: "正在生成解读",
  completed: "解读完成",
  idle: "等待追问",
  interrupted: "已停止",
  stale: "源内容已变化",
  failed: "解读失败",
  unavailable: "本地 Agent 不可用",
};

const isWorkspaceState = (state) => Boolean(
  state
  && Array.isArray(state.conversations)
  && Array.isArray(state.openConversationIds)
);

const shouldSubmitFollowUpOnKeydown = (event, compositionActive = false) => (
  event?.key === "Enter"
  && event?.shiftKey !== true
  && event?.isComposing !== true
  && compositionActive !== true
  && event?.keyCode !== 229
);

const nextConversationAnchor = (
  anchors,
  currentTop,
  direction,
  tolerance = 30
) => {
  const ordered = (Array.isArray(anchors) ? anchors : [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const current = Number(currentTop || 0);
  if (direction < 0) {
    return [...ordered].reverse().find(
      (anchor) => anchor < current - tolerance
    ) ?? 0;
  }
  return ordered.find(
    (anchor) => anchor > current + tolerance
  ) ?? null;
};

const createObsidianContextResolver = (app) => new SegmentContextResolver({
  readText: async (requestedPath) => {
    const normalizedPath = normalizePath(requestedPath || "");
    const file = app.vault.getAbstractFileByPath(normalizedPath);
    if (!(file instanceof TFile)) {
      return null;
    }
    return app.vault.cachedRead(file);
  },
  listMarkdownPaths: async (prefix) => {
    const normalizedPrefix = normalizePath(prefix || "");
    return app.vault.getMarkdownFiles()
      .map((file) => normalizePath(file.path))
      .filter((filePath) => filePath.startsWith(normalizedPrefix));
  },
});

const segmentAiStateKey = (state) => {
  const reference = state?.context?.reference;
  const sourcePath = String(
    reference?.translationPath || state?.sourcePath || ""
  ).trim();
  const segmentId = String(
    reference?.requestedId
      || reference?.primaryId
      || state?.requestedId
      || ""
  ).trim();
  return sourcePath || segmentId ? `${sourcePath}::${segmentId}` : "";
};

const isNearScrollBottom = (
  scrollEl,
  threshold = AUTO_SCROLL_THRESHOLD_PX
) => {
  const scrollTop = Number(scrollEl?.scrollTop || 0);
  const scrollHeight = Number(scrollEl?.scrollHeight || 0);
  const clientHeight = Number(scrollEl?.clientHeight || 0);
  const distance = scrollHeight - clientHeight - scrollTop;
  return distance <= Math.max(0, Number(threshold || 0));
};

const shouldResetAutoScroll = (previousState, nextState) => {
  const previousKey = segmentAiStateKey(previousState);
  const nextKey = segmentAiStateKey(nextState);
  if (previousKey && nextKey && previousKey !== nextKey) {
    return true;
  }
  if (
    nextState?.status === "resolving"
    && previousState?.status !== "resolving"
  ) {
    return true;
  }
  const previousAnswer = String(previousState?.answer || "");
  const nextAnswer = String(nextState?.answer || "");
  return Boolean(
    previousAnswer
    && !nextAnswer
    && ["resolving", "starting"].includes(nextState?.status)
  );
};

const workspaceFrameKey = (state, historyOpen) => JSON.stringify({
  activeConversationId: String(state?.activeConversationId || ""),
  openConversationIds: Array.isArray(state?.openConversationIds)
    ? state.openConversationIds
    : [],
  maxOpenSessions: Number(state?.maxOpenSessions || 0),
  historyOpen: Boolean(historyOpen),
  workspaceError: state?.workspaceError
    ? {
        code: String(state.workspaceError.code || ""),
        message: String(state.workspaceError.message || ""),
      }
    : null,
  conversations: (Array.isArray(state?.conversations)
    ? state.conversations
    : [])
    .map((conversation) => [
      String(conversation?.id || ""),
      String(conversation?.title || ""),
      String(conversation?.skillProfile?.title || ""),
    ])
    .sort((left, right) => left[0].localeCompare(right[0])),
});

const workspaceConversationRenderKey = (conversation) => JSON.stringify({
  id: String(conversation?.id || ""),
  title: String(conversation?.title || ""),
  requestedId: String(conversation?.requestedId || ""),
  primaryId: String(conversation?.primaryId || ""),
  sourcePath: String(conversation?.sourcePath || ""),
  lessonTitle: String(conversation?.lessonTitle || ""),
  status: String(conversation?.status || ""),
  skillProfileTitle: String(conversation?.skillProfile?.title || ""),
  model: String(conversation?.model || ""),
  effort: String(conversation?.effort || ""),
  error: conversation?.error
    ? {
        code: String(conversation.error.code || ""),
        message: String(conversation.error.message || ""),
      }
    : null,
  messages: (Array.isArray(conversation?.messages)
    ? conversation.messages
    : []).map((message) => [
      String(message?.id || ""),
      String(message?.role || ""),
      String(message?.kind || ""),
      String(message?.status || ""),
      String(message?.content || ""),
    ]),
});

class LacanInterpretationView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.state = plugin.segmentAiState || { status: "empty" };
    this.renderToken = 0;
    this.markdownComponent = null;
    this.renderedDom = null;
    this.autoScrollEnabled = true;
    this.savedScrollTop = 0;
    this.workspaceDom = null;
    this.workspaceScrollStates = new Map();
    this.workspaceScrollResumeTimer = null;
    this.pendingWorkspacePatchFrame = null;
    this.pendingWorkspacePatch = null;
    this.pendingWorkspacePatchWaiters = [];
    this.workspacePatchRunning = false;
    this.workspaceMarkdownComponents = [];
    this.historyOpen = false;
  }

  getViewType() {
    return LACAN_INTERPRETATION_VIEW_TYPE;
  }

  getDisplayText() {
    return "Lacan AI";
  }

  getIcon() {
    return "message-square-text";
  }

  async onOpen() {
    this.state = this.plugin.segmentAiState || this.state;
    await this.render();
  }

  async onClose() {
    this.renderToken += 1;
    this.renderedDom = null;
    this.workspaceDom = null;
    this.cancelWorkspaceScrollResume();
    this.cancelWorkspaceGenerationPatch();
    this.unloadMarkdown();
    this.unloadWorkspaceMarkdown();
  }

  setState(state) {
    const nextState = state || { status: "empty" };
    if (!isWorkspaceState(nextState) && shouldResetAutoScroll(this.state, nextState)) {
      this.autoScrollEnabled = true;
      this.savedScrollTop = 0;
    }
    this.state = nextState;
    void this.render();
  }

  async render() {
    const token = ++this.renderToken;
    const state = this.state;
    const rootEl = this.contentRoot();
    if (!rootEl?.empty || !rootEl?.createDiv) {
      return;
    }
    if (isWorkspaceState(state)) {
      await this.renderWorkspace(rootEl, state, token);
      return;
    }
    this.workspaceDom = null;
    this.unloadWorkspaceMarkdown();
    const context = state.context;
    const stateKey = segmentAiStateKey(state);
    if (this.canPatchActiveGeneration(rootEl, state, stateKey)) {
      await this.patchActiveGeneration(state, token);
      return;
    }

    this.unloadMarkdown();
    this.renderedDom = null;
    rootEl.empty();
    rootEl.addClass?.("lacan-ai-view");
    rootEl.style?.setProperty?.(
      "--lacan-ai-status-bar-clearance",
      `${measureStatusBarClearance()}px`
    );
    const scrollEl = rootEl.createDiv("lacan-ai-view-scroll");
    this.bindScrollTracking(scrollEl);

    const headerEl = scrollEl.createDiv("lacan-ai-view-header");
    const titleRowEl = headerEl.createDiv("lacan-ai-title-row");
    titleRowEl.createEl("h3", { text: "Lacan AI" });
    const statusEl = titleRowEl.createSpan({
      cls: `lacan-ai-status is-${state.status || "empty"}`,
      text: segmentAiStatusLabel(state.status),
    });
    const renderedDom = {
      rootEl,
      scrollEl,
      statusEl,
      answerEl: null,
      stateKey,
      status: state.status,
    };
    this.renderedDom = renderedDom;

    if (!context) {
      this.renderContextFreeState(scrollEl, state);
      this.applyScrollPosition(scrollEl, this.savedScrollTop);
      return;
    }

    this.renderSegmentIdentity(headerEl, context);
    this.renderActions(headerEl, context, state);
    this.renderContextSummary(scrollEl, context);

    if (state.status === "stale") {
      const staleEl = scrollEl.createDiv("lacan-ai-callout is-warning");
      staleEl.createEl("strong", { text: "已有解读已过期" });
      staleEl.createEl("p", {
        text: "译文、原文、术语、关联笔记或 Prompt 规则已经变化。旧会话不会自动重新请求。",
      });
    }

    if (state.error) {
      this.renderError(scrollEl, state.error);
    }

    const answerEl = scrollEl.createDiv("lacan-ai-answer");
    renderedDom.answerEl = answerEl;
    const preparedAnswer = await this.prepareAnswerContent(
      answerEl,
      state.answer,
      context.reference.translationPath,
      state.status
    );
    if (token !== this.renderToken || this.renderedDom !== renderedDom) {
      this.discardPreparedAnswer(preparedAnswer);
      return;
    }
    const preservedScrollTop = this.savedScrollTop;
    this.commitPreparedAnswer(answerEl, preparedAnswer);

    if (state.status === "completed") {
      this.renderFollowUp(rootEl);
    }
    this.applyScrollPosition(scrollEl, preservedScrollTop);
  }

  async renderWorkspace(rootEl, state, token) {
    const activeConversation = state.conversations.find(
      (conversation) => conversation.id === state.activeConversationId
    ) || null;
    if (activeConversation) {
      const storedScroll = activeConversation.scroll || {};
      const localScroll = this.workspaceScrollStates.get(activeConversation.id);
      if (localScroll) {
        localScroll.unseenMessageCount = Math.max(
          Number(localScroll.unseenMessageCount || 0),
          Number(storedScroll.unseenMessageCount || 0)
        );
      } else {
        this.workspaceScrollStates.set(activeConversation.id, {
          followLatest: storedScroll.followLatest !== false,
          scrollTop: Number(storedScroll.scrollTop || 0),
          unseenMessageCount: Number(storedScroll.unseenMessageCount || 0),
        });
      }
    }
    if (this.canPreserveWorkspace(state, activeConversation)) {
      this.patchWorkspaceSummary(state, activeConversation);
      return;
    }
    if (this.canPatchWorkspace(activeConversation)) {
      await this.scheduleWorkspaceGenerationPatch(
        activeConversation,
        state,
        token
      );
      return;
    }

    this.cancelWorkspaceGenerationPatch();
    this.captureWorkspaceScroll();
    this.unloadMarkdown();
    this.unloadWorkspaceMarkdown();
    this.renderedDom = null;
    this.workspaceDom = null;
    rootEl.empty();
    rootEl.addClass?.("lacan-ai-view");
    rootEl.addClass?.("is-workspace");
    rootEl.style?.setProperty?.(
      "--lacan-ai-status-bar-clearance",
      `${measureStatusBarClearance()}px`
    );

    const workspaceHeader = rootEl.createDiv("lacan-ai-workspace-header");
    const titleRow = workspaceHeader.createDiv("lacan-ai-workspace-title-row");
    titleRow.createEl("h3", { text: "Lacan AI" });
    const workspaceActions = titleRow.createDiv("lacan-ai-workspace-actions");
    this.createButton(
      workspaceActions,
      this.historyOpen ? "收起历史" : "历史",
      () => {
        this.historyOpen = !this.historyOpen;
        void this.render();
      },
      "lacan-ai-quiet-button"
    );
    const capacityEl = workspaceActions.createSpan({
      cls: "lacan-ai-capacity",
      text: `${state.openConversationIds.length}/${state.maxOpenSessions}`,
    });

    const tabsEl = rootEl.createDiv("lacan-ai-tabs");
    tabsEl.setAttribute?.("role", "tablist");
    const tabRefs = new Map();
    state.openConversationIds.forEach((conversationId, index) => {
      const conversation = state.conversations.find(
        (candidate) => candidate.id === conversationId
      );
      if (!conversation) {
        return;
      }
      const tabEl = tabsEl.createEl("button", {
        cls: [
          "lacan-ai-tab",
          conversation.id === state.activeConversationId ? "is-active" : "",
          conversation.needsAttention ? "needs-attention" : "",
        ].filter(Boolean).join(" "),
        attr: {
          type: "button",
          role: "tab",
          "aria-selected": conversation.id === state.activeConversationId
            ? "true"
            : "false",
          title: conversation.title,
        },
      });
      tabEl.createSpan({
        cls: "lacan-ai-tab-index",
        text: String(index + 1),
      });
      const titleEl = tabEl.createSpan({
        cls: "lacan-ai-tab-title",
        text: conversation.title,
      });
      const stateEl = tabEl.createSpan({
        cls: `lacan-ai-tab-state is-${conversation.status}`,
        text: workspaceStatusGlyph(conversation),
      });
      const closeEl = tabEl.createEl("span", {
        cls: "lacan-ai-tab-close",
        text: "×",
        attr: {
          role: "button",
          "aria-label": `关闭会话 ${conversation.title}`,
        },
      });
      closeEl.addEventListener?.("click", (event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        if (ACTIVE_GENERATION_STATUSES.has(conversation.status)) {
          if (Notice) {
            new Notice("这个会话仍在生成，请先停止后再关闭。");
          }
          return;
        }
        void this.plugin.closeSegmentAiConversation?.(conversation.id);
      });
      tabEl.addEventListener?.("click", (event) => {
        event.preventDefault?.();
        void this.plugin.activateSegmentAiConversation?.(conversation.id);
      });
      tabRefs.set(conversation.id, {
        tabEl,
        titleEl,
        stateEl,
      });
    });

    let historyDom = null;
    if (this.historyOpen) {
      historyDom = this.renderWorkspaceHistory(rootEl, state);
    }

    if (!activeConversation) {
      if (state.workspaceError) {
        this.renderError(rootEl, state.workspaceError);
      }
      rootEl.createDiv({
        cls: "lacan-ai-empty",
        text: "在译文分段旁点击“Ф”，或从历史中打开一个会话。",
      });
      return;
    }

    const localScroll = this.workspaceScrollStates.get(activeConversation.id)
      || {
        followLatest: activeConversation.scroll?.followLatest !== false,
        scrollTop: Number(activeConversation.scroll?.scrollTop || 0),
        unseenMessageCount: Number(
          activeConversation.scroll?.unseenMessageCount || 0
        ),
      };
    this.workspaceScrollStates.set(activeConversation.id, localScroll);

    const scrollEl = rootEl.createDiv("lacan-ai-view-scroll");
    this.bindWorkspaceScroll(scrollEl, activeConversation.id);
    const conversationHeader = scrollEl.createDiv("lacan-ai-view-header");
    const conversationTitleRow = conversationHeader.createDiv("lacan-ai-title-row");
    conversationTitleRow.createEl("h4", { text: activeConversation.title });
    const statusEl = conversationTitleRow.createSpan({
      cls: `lacan-ai-status is-${activeConversation.status}`,
      text: segmentAiStatusLabel(activeConversation.status),
    });
    this.renderWorkspaceIdentity(conversationHeader, activeConversation);
    this.renderWorkspaceActions(
      conversationHeader,
      activeConversation
    );

    if (activeConversation.error) {
      this.renderError(scrollEl, activeConversation.error);
    }

    const messagesEl = scrollEl.createDiv("lacan-ai-messages");
    let latestAssistantEl = null;
    let latestAssistantComponent = null;
    const anchors = [];
    for (const [index, message] of activeConversation.messages.entries()) {
      const messageEl = messagesEl.createDiv(
        `lacan-ai-message is-${message.role} is-${message.status || "completed"}`
      );
      messageEl.setAttribute?.("data-message-id", message.id);
      if (message.role === "user") {
        messageEl.setAttribute?.("data-user-anchor", "true");
        messageEl.createDiv({
          cls: "lacan-ai-message-label",
          text: message.kind === "initial" ? "初始解读" : "继续追问",
        });
        messageEl.createEl("p", { text: message.content });
        anchors.push(Number(messageEl.offsetTop || index * 240));
      } else {
        const answerEl = messageEl.createDiv("lacan-ai-answer-content");
        if (message.content) {
          latestAssistantComponent = await this.renderWorkspaceMarkdown(
            answerEl,
            message.content,
            activeConversation.sourcePath
          );
        } else {
          answerEl.createEl("p", {
            cls: "lacan-ai-answer-placeholder",
            text: this.answerPlaceholder(activeConversation.status),
          });
        }
        latestAssistantEl = answerEl;
      }
    }
    if (activeConversation.messages.length === 0) {
      messagesEl.createEl("p", {
        cls: "lacan-ai-answer-placeholder",
        text: "这个历史会话还没有可显示的消息。",
      });
    }

    const navigatorEl = this.renderWorkspaceNavigator(
      scrollEl,
      activeConversation,
      anchors
    );
    const latestEl = scrollEl.createEl("button", {
      cls: [
        "lacan-ai-return-latest",
        localScroll.followLatest && localScroll.unseenMessageCount === 0
          ? "is-hidden"
          : "",
      ].filter(Boolean).join(" "),
      text: localScroll.unseenMessageCount > 0
        ? `回到最新 · ${localScroll.unseenMessageCount}`
        : "回到最新",
      attr: {
        type: "button",
        "aria-label": "回到最新内容",
      },
    });
    latestEl.addEventListener?.("click", () => {
      this.scrollWorkspaceTo(
        scrollEl,
        activeConversation.id,
        scrollEl.scrollHeight,
        { followLatest: true, smooth: true }
      );
      this.updateLatestControl(latestEl, activeConversation.id);
    });

    this.workspaceDom = {
      rootEl,
      scrollEl,
      statusEl,
      navigatorEl,
      conversationId: activeConversation.id,
      status: activeConversation.status,
      messageCount: activeConversation.messages.length,
      answerEl: latestAssistantEl,
      answerComponent: latestAssistantComponent,
      latestEl,
      capacityEl,
      tabRefs,
      historyDom,
      frameKey: workspaceFrameKey(state, this.historyOpen),
      activeRenderKey: workspaceConversationRenderKey(activeConversation),
    };
    this.renderWorkspaceComposer(rootEl, activeConversation, state);
    this.applyWorkspaceScroll(scrollEl, activeConversation.id);
    if (
      Number(scrollEl.scrollHeight || 0)
      <= Number(scrollEl.clientHeight || 0) + 50
    ) {
      navigatorEl.addClass?.("is-hidden");
    }
  }

  renderWorkspaceHistory(rootEl, state) {
    const historyEl = rootEl.createDiv("lacan-ai-history");
    const historyTitle = historyEl.createDiv("lacan-ai-history-heading");
    const historySummary = historyTitle.createDiv("lacan-ai-history-summary");
    historySummary.createEl("strong", { text: "历史会话" });
    const countEl = historySummary.createSpan({
      text: `${state.conversations.length} 条`,
    });
    const clearAllEl = historyTitle.createEl("button", {
      cls: "lacan-ai-history-clear",
      text: "清空全部",
      attr: {
        type: "button",
        "aria-label": "清空所有历史会话",
        title: state.runningCount > 0
          ? "仍有 AI 任务正在运行，请先停止"
          : "清空所有历史会话、打开标签和草稿",
      },
    });
    const historyDom = {
      rootEl: historyEl,
      countEl,
      clearAllEl,
      rows: new Map(),
    };
    clearAllEl.disabled =
      state.conversations.length === 0 || state.runningCount > 0;
    clearAllEl.setAttribute?.(
      "aria-disabled",
      clearAllEl.disabled ? "true" : "false"
    );
    clearAllEl.addEventListener?.("click", (event) => {
      event.preventDefault?.();
      if (clearAllEl.disabled) {
        return;
      }
      const confirmed = typeof globalThis.confirm === "function"
        ? globalThis.confirm(
            `清空全部 ${state.conversations.length} 条会话？这会删除插件保存的历史、打开标签和草稿；不会删除项目文件或 Codex 中的其他任务。`
          )
        : true;
      if (confirmed) {
        void this.plugin.clearAllSegmentAiConversations?.();
      }
    });
    const historyList = historyEl.createDiv("lacan-ai-history-list");
    if (state.conversations.length === 0) {
      historyList.createEl("p", { text: "还没有历史会话。" });
      return historyDom;
    }
    for (const conversation of state.conversations) {
      const rowEl = historyList.createDiv("lacan-ai-history-row");
      const openEl = rowEl.createEl("button", {
        cls: "lacan-ai-history-open",
        attr: { type: "button" },
      });
      const titleEl = openEl.createEl("strong", { text: conversation.title });
      const statusEl = openEl.createSpan({
        text: `${conversation.skillProfile?.title || "不附加 Skill"} · ${
          segmentAiStatusLabel(conversation.status)
        }`,
      });
      openEl.addEventListener?.("click", () => (
        this.plugin.activateSegmentAiConversation?.(conversation.id)
      ));
      const renameEl = rowEl.createEl("button", {
        cls: "lacan-ai-history-rename",
        text: "重命名",
        attr: {
          type: "button",
          "aria-label": `重命名历史会话 ${conversation.title}`,
        },
      });
      renameEl.addEventListener?.("click", () => {
        const title = typeof globalThis.prompt === "function"
          ? globalThis.prompt("新的会话标题", conversation.title)
          : null;
        if (title && title.trim() && title.trim() !== conversation.title) {
          void this.plugin.renameSegmentAiConversation?.(
            conversation.id,
            title.trim()
          );
        }
      });
      const deleteEl = rowEl.createEl("button", {
        cls: "lacan-ai-history-delete",
        text: "删除",
        attr: {
          type: "button",
          "aria-label": `删除历史会话 ${conversation.title}`,
        },
      });
      deleteEl.addEventListener?.("click", () => {
        const confirmed = typeof globalThis.confirm === "function"
          ? globalThis.confirm(
              `删除历史会话“${conversation.title}”？这个操作不会删除 Codex 的其他任务。`
            )
          : true;
        if (confirmed) {
          void this.plugin.deleteSegmentAiConversation?.(conversation.id);
        }
      });
      historyDom.rows.set(conversation.id, {
        rowEl,
        titleEl,
        statusEl,
      });
    }
    return historyDom;
  }

  renderWorkspaceIdentity(headerEl, conversation) {
    headerEl.createDiv({
      cls: "lacan-ai-segment-id",
      text: `${conversation.requestedId} · 会话归属 ${
        conversation.primaryId || conversation.requestedId
      }`,
    });
    if (conversation.lessonTitle) {
      headerEl.createDiv({
        cls: "lacan-ai-lesson-title",
        text: conversation.lessonTitle,
      });
    }
    headerEl.createDiv({
      cls: "lacan-ai-profile-line",
      text: [
        conversation.skillProfile?.title || "不附加 Skill",
        conversation.model || "Codex 默认模型",
        conversation.effort || "默认推理强度",
      ].join(" · "),
    });
  }

  renderWorkspaceActions(headerEl, conversation) {
    const actionsEl = headerEl.createDiv("lacan-ai-view-actions");
    this.createButton(actionsEl, "译文", () => (
      this.plugin.openSegmentSource?.(
        conversation.sourcePath,
        conversation.requestedId
      )
    ));
    const originalPath = conversation.sourcePath.replace(
      "/translation/",
      "/original/"
    );
    this.createButton(actionsEl, "法文", () => (
      this.plugin.openSegmentSource?.(
        originalPath,
        conversation.requestedId
      )
    ));
    if (ACTIVE_GENERATION_STATUSES.has(conversation.status)) {
      this.createButton(
        actionsEl,
        "停止",
        () => this.plugin.stopSegmentInterpretation?.(conversation.id),
        "mod-warning"
      );
    } else {
      this.createButton(
        actionsEl,
        "重新解读",
        () => this.plugin.retrySegmentInterpretation?.(conversation.id)
      );
    }
  }

  renderWorkspaceComposer(rootEl, conversation, workspaceState) {
    const formEl = rootEl.createDiv("lacan-ai-follow-up");
    const inputEl = formEl.createEl("textarea", {
      attr: {
        rows: "3",
        placeholder: "继续追问这一分段……",
        "aria-label": "继续追问这一分段",
      },
    });
    inputEl.value = conversation.draft || "";
    const conversationBusy = ACTIVE_GENERATION_STATUSES.has(
      conversation.status
    );
    const globalBusy = !conversationBusy
      && Number(workspaceState?.runningCount || 0)
        >= Number(workspaceState?.maxOpenSessions || 1);
    let composing = false;
    inputEl.addEventListener?.("compositionstart", () => {
      composing = true;
    });
    inputEl.addEventListener?.("compositionend", () => {
      composing = false;
    });
    inputEl.addEventListener?.("input", () => {
      void this.plugin.updateSegmentAiDraft?.(
        conversation.id,
        inputEl.value
      );
    });
    const submit = async () => {
      const question = String(inputEl.value || "").trim();
      if (!question || conversationBusy || globalBusy) {
        return;
      }
      await this.plugin.followUpSegmentInterpretation?.(
        conversation.id,
        question
      );
    };
    inputEl.addEventListener?.("keydown", (event) => {
      if (!shouldSubmitFollowUpOnKeydown(event, composing)) {
        return;
      }
      event.preventDefault?.();
      void submit();
    });
    const footerEl = formEl.createDiv("lacan-ai-composer-footer");
    footerEl.createSpan({
      cls: "lacan-ai-input-hint",
      text: conversationBusy
        ? "可先编辑下一问；当前回答完成后再发送"
        : globalBusy
          ? "并发任务已到上限；草稿会保留"
        : "Enter 发送 · Shift+Enter 换行",
    });
  }

  renderWorkspaceNavigator(scrollEl, conversation, anchors) {
    const navigatorEl = scrollEl.createDiv("lacan-ai-navigator");
    const items = [
      {
        label: "回到会话顶部",
        glyph: "⇈",
        action: () => this.scrollWorkspaceTo(
          scrollEl,
          conversation.id,
          0,
          { followLatest: false, smooth: true }
        ),
      },
      {
        label: "上一条提问",
        glyph: "↑",
        action: () => {
          const target = nextConversationAnchor(
            anchors,
            scrollEl.scrollTop,
            -1
          );
          this.scrollWorkspaceTo(
            scrollEl,
            conversation.id,
            target,
            { followLatest: false, smooth: true }
          );
        },
      },
      {
        label: "打开会话目录",
        glyph: "☷",
        action: (event) => this.openWorkspaceDirectoryMenu(
          event,
          scrollEl,
          conversation,
          anchors
        ),
      },
      {
        label: "下一条提问",
        glyph: "↓",
        action: () => {
          const target = nextConversationAnchor(
            anchors,
            scrollEl.scrollTop,
            1
          );
          this.scrollWorkspaceTo(
            scrollEl,
            conversation.id,
            target === null ? scrollEl.scrollHeight : target,
            {
              followLatest: target === null,
              smooth: true,
            }
          );
        },
      },
      {
        label: "回到会话底部",
        glyph: "⇊",
        action: () => this.scrollWorkspaceTo(
          scrollEl,
          conversation.id,
          scrollEl.scrollHeight,
          { followLatest: true, smooth: true }
        ),
      },
    ];
    for (const item of items) {
      const button = navigatorEl.createEl("button", {
        text: item.glyph,
        attr: {
          type: "button",
          title: item.label,
          "aria-label": item.label,
        },
      });
      button.addEventListener?.("click", item.action);
    }
    return navigatorEl;
  }

  openWorkspaceDirectoryMenu(event, scrollEl, conversation, anchors) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const menu = new Menu();
    conversation.messages
      .filter((message) => message.role === "user")
      .forEach((message, index) => {
        menu.addItem((item) => {
          item
            .setTitle(`${index + 1}. ${singleLineSummary(message.content)}`)
            .setIcon(message.kind === "initial" ? "locate-fixed" : "message-circle")
            .onClick(() => {
              this.scrollWorkspaceTo(
                scrollEl,
                conversation.id,
                anchors[index] ?? 0,
                { followLatest: false, smooth: true }
              );
            });
        });
      });
    menu.showAtMouseEvent?.(event);
  }

  canPatchWorkspace(conversation) {
    return Boolean(
      conversation
      && this.workspaceDom?.answerEl
      && this.workspaceDom.conversationId === conversation.id
      && this.workspaceDom.messageCount === conversation.messages.length
      && ACTIVE_GENERATION_STATUSES.has(this.workspaceDom.status)
      && ACTIVE_GENERATION_STATUSES.has(conversation.status)
    );
  }

  canPreserveWorkspace(state, conversation) {
    return Boolean(
      conversation
      && this.workspaceDom
      && this.workspaceDom.frameKey === workspaceFrameKey(
        state,
        this.historyOpen
      )
      && this.workspaceDom.activeRenderKey
        === workspaceConversationRenderKey(conversation)
    );
  }

  patchWorkspaceSummary(state, activeConversation) {
    const rendered = this.workspaceDom;
    if (!rendered) {
      return;
    }
    if (rendered.capacityEl) {
      rendered.capacityEl.textContent =
        `${state.openConversationIds.length}/${state.maxOpenSessions}`;
    }
    for (const conversationId of state.openConversationIds) {
      const conversation = state.conversations.find(
        (candidate) => candidate.id === conversationId
      );
      const tabRef = rendered.tabRefs?.get(conversationId);
      if (!conversation || !tabRef) {
        continue;
      }
      tabRef.tabEl.className = [
        "lacan-ai-tab",
        conversation.id === state.activeConversationId ? "is-active" : "",
        conversation.needsAttention ? "needs-attention" : "",
      ].filter(Boolean).join(" ");
      tabRef.tabEl.setAttribute?.(
        "aria-selected",
        conversation.id === state.activeConversationId ? "true" : "false"
      );
      tabRef.tabEl.setAttribute?.("title", conversation.title);
      tabRef.titleEl.textContent = conversation.title;
      tabRef.stateEl.className =
        `lacan-ai-tab-state is-${conversation.status}`;
      tabRef.stateEl.textContent = workspaceStatusGlyph(conversation);
      const historyRef = rendered.historyDom?.rows?.get(conversation.id);
      if (historyRef) {
        historyRef.titleEl.textContent = conversation.title;
        historyRef.statusEl.textContent = `${
          conversation.skillProfile?.title || "不附加 Skill"
        } · ${segmentAiStatusLabel(conversation.status)}`;
      }
    }
    const historyDom = rendered.historyDom;
    if (historyDom) {
      historyDom.countEl.textContent = `${state.conversations.length} 条`;
      historyDom.clearAllEl.disabled =
        state.conversations.length === 0 || state.runningCount > 0;
      historyDom.clearAllEl.setAttribute?.(
        "aria-disabled",
        historyDom.clearAllEl.disabled ? "true" : "false"
      );
      historyDom.clearAllEl.setAttribute?.(
        "title",
        state.runningCount > 0
          ? "仍有 AI 任务正在运行，请先停止"
          : "清空所有历史会话、打开标签和草稿"
      );
    }
    rendered.frameKey = workspaceFrameKey(state, this.historyOpen);
    rendered.activeRenderKey =
      workspaceConversationRenderKey(activeConversation);
  }

  scheduleWorkspaceGenerationPatch(conversation, state, token) {
    this.pendingWorkspacePatch = {
      conversation,
      state,
      token,
    };
    const completion = new Promise((resolve, reject) => {
      this.pendingWorkspacePatchWaiters.push({ resolve, reject });
    });
    this.queueWorkspaceGenerationPatch();
    return completion;
  }

  queueWorkspaceGenerationPatch() {
    if (
      this.pendingWorkspacePatchFrame
      || this.workspacePatchRunning
      || !this.pendingWorkspacePatch
    ) {
      return;
    }
    const scrollEl = this.workspaceDom?.scrollEl;
    const windowRef = scrollEl?.ownerDocument?.defaultView || globalThis;
    const pendingFrame = {
      id: null,
      cancel: null,
    };
    const run = () => {
      if (this.pendingWorkspacePatchFrame !== pendingFrame) {
        return;
      }
      this.pendingWorkspacePatchFrame = null;
      void this.flushWorkspaceGenerationPatch();
    };
    this.pendingWorkspacePatchFrame = pendingFrame;
    if (typeof windowRef?.requestAnimationFrame === "function") {
      pendingFrame.cancel = () => {
        windowRef.cancelAnimationFrame?.(pendingFrame.id);
      };
      pendingFrame.id = windowRef.requestAnimationFrame(run);
      return;
    }
    const setTimer = typeof windowRef?.setTimeout === "function"
      ? windowRef.setTimeout.bind(windowRef)
      : globalThis.setTimeout.bind(globalThis);
    const clearTimer = typeof windowRef?.clearTimeout === "function"
      ? windowRef.clearTimeout.bind(windowRef)
      : globalThis.clearTimeout.bind(globalThis);
    pendingFrame.cancel = () => clearTimer(pendingFrame.id);
    pendingFrame.id = setTimer(run, 0);
  }

  async flushWorkspaceGenerationPatch() {
    if (this.workspacePatchRunning) {
      return;
    }
    const pending = this.pendingWorkspacePatch;
    if (!pending) {
      this.settleWorkspacePatchWaiters();
      return;
    }
    this.pendingWorkspacePatch = null;
    this.workspacePatchRunning = true;
    let failure = null;
    try {
      await this.patchWorkspaceGeneration(
        pending.conversation,
        pending.state,
        pending.token
      );
    } catch (error) {
      failure = error;
    } finally {
      this.workspacePatchRunning = false;
    }
    if (failure) {
      this.pendingWorkspacePatch = null;
      this.settleWorkspacePatchWaiters(failure);
      return;
    }
    if (this.pendingWorkspacePatch) {
      this.queueWorkspaceGenerationPatch();
      return;
    }
    this.settleWorkspacePatchWaiters();
  }

  settleWorkspacePatchWaiters(error = null) {
    const waiters = this.pendingWorkspacePatchWaiters.splice(0);
    for (const waiter of waiters) {
      if (error) {
        waiter.reject(error);
      } else {
        waiter.resolve();
      }
    }
  }

  cancelWorkspaceGenerationPatch() {
    this.pendingWorkspacePatchFrame?.cancel?.();
    this.pendingWorkspacePatchFrame = null;
    this.pendingWorkspacePatch = null;
    this.settleWorkspacePatchWaiters();
  }

  async patchWorkspaceGeneration(conversation, state, token) {
    const rendered = this.workspaceDom;
    if (!rendered) {
      return;
    }
    const latestAssistant = [...conversation.messages].reverse().find(
      (message) => message.role === "assistant"
    );
    if (!latestAssistant) {
      return;
    }
    const detached = this.createDetachedAnswerContent(rendered.answerEl);
    let component = null;
    if (latestAssistant.content) {
      component = await this.renderMarkdown(
        detached,
        latestAssistant.content,
        conversation.sourcePath
      );
    } else {
      detached.createEl("p", {
        cls: "lacan-ai-answer-placeholder",
        text: this.answerPlaceholder(conversation.status),
      });
    }
    if (token !== this.renderToken || this.workspaceDom !== rendered) {
      component?.unload?.();
      return;
    }
    rendered.answerEl.replaceChildren(detached);
    rendered.answerComponent?.unload?.();
    rendered.answerComponent = component;
    rendered.status = conversation.status;
    rendered.statusEl.className =
      `lacan-ai-status is-${conversation.status}`;
    rendered.statusEl.textContent = segmentAiStatusLabel(conversation.status);
    this.patchWorkspaceSummary(state, conversation);
    this.updateLatestControl(rendered.latestEl, conversation.id);
    if (
      this.workspaceScrollStates.get(conversation.id)?.followLatest !== false
    ) {
      this.applyWorkspaceScroll(rendered.scrollEl, conversation.id);
    }
  }

  bindWorkspaceScroll(scrollEl, conversationId) {
    this.cancelWorkspaceScrollResume();
    scrollEl.addEventListener?.("scroll", () => {
      const nearBottom = isNearScrollBottom(
        scrollEl,
        WORKSPACE_AUTO_SCROLL_THRESHOLD_PX
      );
      const current = this.workspaceScrollStates.get(conversationId) || {};
      const next = {
        followLatest: nearBottom
          ? current.followLatest !== false
          : false,
        scrollTop: Math.max(0, Number(scrollEl.scrollTop || 0)),
        unseenMessageCount: nearBottom && current.followLatest !== false
          ? 0
          : Number(current.unseenMessageCount || 0),
      };
      this.workspaceScrollStates.set(conversationId, next);
      void this.plugin.updateSegmentAiScroll?.(conversationId, next);
      this.updateLatestControl(this.workspaceDom?.latestEl, conversationId);
      if (!nearBottom) {
        this.cancelWorkspaceScrollResume();
        return;
      }
      if (next.followLatest) {
        this.cancelWorkspaceScrollResume();
        return;
      }
      this.scheduleWorkspaceScrollResume(scrollEl, conversationId);
    }, { passive: true });
  }

  scheduleWorkspaceScrollResume(scrollEl, conversationId) {
    if (this.workspaceScrollResumeTimer) {
      return;
    }
    const windowRef = scrollEl?.ownerDocument?.defaultView || globalThis;
    const setTimer = typeof windowRef?.setTimeout === "function"
      ? windowRef.setTimeout.bind(windowRef)
      : globalThis.setTimeout.bind(globalThis);
    const clearTimer = typeof windowRef?.clearTimeout === "function"
      ? windowRef.clearTimeout.bind(windowRef)
      : globalThis.clearTimeout.bind(globalThis);
    const pending = {
      id: null,
      clearTimer,
      conversationId,
      scrollEl,
    };
    pending.id = setTimer(() => {
      if (this.workspaceScrollResumeTimer !== pending) {
        return;
      }
      this.workspaceScrollResumeTimer = null;
      if (
        this.workspaceDom?.scrollEl !== scrollEl
        || this.workspaceDom?.conversationId !== conversationId
        || !isNearScrollBottom(
          scrollEl,
          WORKSPACE_AUTO_SCROLL_THRESHOLD_PX
        )
      ) {
        return;
      }
      const current = this.workspaceScrollStates.get(conversationId) || {};
      const next = {
        followLatest: true,
        scrollTop: Math.max(0, Number(scrollEl.scrollTop || 0)),
        unseenMessageCount: 0,
      };
      this.workspaceScrollStates.set(conversationId, next);
      void this.plugin.updateSegmentAiScroll?.(conversationId, next);
      this.updateLatestControl(this.workspaceDom?.latestEl, conversationId);
    }, WORKSPACE_AUTO_SCROLL_RESUME_DELAY_MS);
    this.workspaceScrollResumeTimer = pending;
  }

  cancelWorkspaceScrollResume() {
    const pending = this.workspaceScrollResumeTimer;
    if (!pending) {
      return;
    }
    pending.clearTimer(pending.id);
    this.workspaceScrollResumeTimer = null;
  }

  applyWorkspaceScroll(scrollEl, conversationId) {
    const state = this.workspaceScrollStates.get(conversationId) || {
      followLatest: true,
      scrollTop: 0,
      unseenMessageCount: 0,
    };
    const windowRef = scrollEl?.ownerDocument?.defaultView || globalThis.window;
    const apply = () => {
      if (this.workspaceDom?.scrollEl && this.workspaceDom.scrollEl !== scrollEl) {
        return;
      }
      if (state.followLatest) {
        scrollEl.scrollTop = scrollEl.scrollHeight;
      } else {
        const maxScrollTop = Math.max(
          0,
          Number(scrollEl.scrollHeight || 0)
            - Number(scrollEl.clientHeight || 0)
        );
        scrollEl.scrollTop = Math.min(state.scrollTop, maxScrollTop);
      }
    };
    if (typeof windowRef?.requestAnimationFrame === "function") {
      windowRef.requestAnimationFrame(apply);
    } else {
      apply();
    }
  }

  scrollWorkspaceTo(
    scrollEl,
    conversationId,
    top,
    { followLatest, smooth }
  ) {
    this.cancelWorkspaceScrollResume();
    if (typeof scrollEl.scrollTo === "function") {
      scrollEl.scrollTo({
        top,
        behavior: smooth ? "smooth" : "auto",
      });
    } else {
      scrollEl.scrollTop = top;
    }
    const next = {
      followLatest,
      scrollTop: Math.max(0, Number(top || 0)),
      unseenMessageCount: followLatest ? 0 : Number(
        this.workspaceScrollStates.get(conversationId)?.unseenMessageCount || 0
      ),
    };
    this.workspaceScrollStates.set(conversationId, next);
    void this.plugin.updateSegmentAiScroll?.(conversationId, next);
    this.updateLatestControl(this.workspaceDom?.latestEl, conversationId);
  }

  updateLatestControl(element, conversationId) {
    if (!element || this.workspaceDom?.conversationId !== conversationId) {
      return;
    }
    const state = this.workspaceScrollStates.get(conversationId) || {};
    const hidden = state.followLatest !== false
      && Number(state.unseenMessageCount || 0) === 0;
    element.className = [
      "lacan-ai-return-latest",
      hidden ? "is-hidden" : "",
    ].filter(Boolean).join(" ");
    element.textContent = Number(state.unseenMessageCount || 0) > 0
      ? `回到最新 · ${state.unseenMessageCount}`
      : "回到最新";
  }

  captureWorkspaceScroll() {
    const rendered = this.workspaceDom;
    if (!rendered?.scrollEl || !rendered.conversationId) {
      return;
    }
    const current = this.workspaceScrollStates.get(rendered.conversationId) || {};
    this.workspaceScrollStates.set(rendered.conversationId, {
      followLatest: current.followLatest !== false,
      scrollTop: Number(rendered.scrollEl.scrollTop || 0),
      unseenMessageCount: Number(current.unseenMessageCount || 0),
    });
  }

  async renderWorkspaceMarkdown(element, markdown, sourcePath) {
    const component = await this.renderMarkdown(element, markdown, sourcePath);
    if (component) {
      this.workspaceMarkdownComponents.push(component);
    }
    return component;
  }

  unloadWorkspaceMarkdown() {
    for (const component of this.workspaceMarkdownComponents) {
      component?.unload?.();
    }
    this.workspaceMarkdownComponents = [];
  }

  contentRoot() {
    return this.contentEl
      || this.containerEl?.children?.[1]
      || this.containerEl;
  }

  renderContextFreeState(rootEl, state = this.state) {
    if (state.error) {
      this.renderError(rootEl, state.error);
      return;
    }
    rootEl.createDiv({
      cls: "lacan-ai-empty",
      text: "在译文任一分段旁点击“Ф”，这里会显示所选 AI 功能的结果。",
    });
  }

  renderSegmentIdentity(headerEl, context) {
    const reference = context.reference;
    const covered = reference.coveredIds.length > 1
      ? ` · 覆盖 ${reference.coveredIds.join("、")}`
      : "";
    headerEl.createDiv({
      cls: "lacan-ai-segment-id",
      text: `${reference.requestedId} · 会话归属 ${reference.primaryId}${covered}`,
    });
    if (context.lessonTitle) {
      headerEl.createDiv({
        cls: "lacan-ai-lesson-title",
        text: context.lessonTitle,
      });
    }
  }

  renderActions(headerEl, context, state = this.state) {
    const actionsEl = headerEl.createDiv("lacan-ai-view-actions");
    this.createButton(actionsEl, "译文", () => (
      this.plugin.openSegmentSource(
        context.reference.translationPath,
        context.reference.requestedId
      )
    ));
    this.createButton(actionsEl, "法文", () => (
      this.plugin.openSegmentSource(
        context.reference.originalPath,
        context.reference.requestedId
      )
    ));
    if (["stale", "failed", "unavailable", "completed"].includes(state.status)) {
      this.createButton(actionsEl, "重新解读", () => this.plugin.retrySegmentInterpretation());
    }
    if (ACTIVE_GENERATION_STATUSES.has(state.status)) {
      this.createButton(
        actionsEl,
        "停止",
        () => this.plugin.stopSegmentInterpretation(),
        "mod-warning"
      );
    }
  }

  renderContextSummary(rootEl, context) {
    const detailsEl = rootEl.createEl("details", {
      cls: "lacan-ai-context-summary",
    });
    detailsEl.createEl("summary", { text: "当前段落摘要" });
    detailsEl.createEl("p", {
      text: context.targetTranslation.visibleText || "[当前分段没有中文译文]",
    });
    if (context.availability?.warnings?.length) {
      const warningsEl = detailsEl.createEl("ul", {
        cls: "lacan-ai-context-warnings",
      });
      for (const warning of context.availability.warnings) {
        warningsEl.createEl("li", { text: warning });
      }
    }
  }

  renderError(rootEl, error) {
    const errorEl = rootEl.createDiv("lacan-ai-callout is-error");
    errorEl.createEl("strong", { text: error.message || "解读失败" });
    errorEl.createEl("div", {
      cls: "lacan-ai-error-code",
      text: `错误代码：${error.code || "Unknown"}`,
    });
    this.createButton(errorEl, "复制脱敏诊断", async () => {
      const diagnostics = this.plugin.getSegmentAiDiagnostics();
      const text = JSON.stringify(diagnostics, null, 2);
      if (globalThis.navigator?.clipboard?.writeText) {
        await globalThis.navigator.clipboard.writeText(text);
        if (Notice) {
          new Notice("已复制 AI 功能诊断。");
        }
      }
    });
  }

  renderFollowUp(rootEl) {
    const formEl = rootEl.createDiv("lacan-ai-follow-up");
    const inputEl = formEl.createEl("textarea", {
      attr: {
        rows: "3",
        placeholder: "继续追问这一分段……",
        "aria-label": "继续追问这一分段",
      },
    });
    const send = async () => {
      const question = String(inputEl.value || "").trim();
      if (!question) {
        return;
      }
      inputEl.value = "";
      await this.plugin.followUpSegmentInterpretation(question);
    };
    let composing = false;
    inputEl.addEventListener("compositionstart", () => {
      composing = true;
    });
    inputEl.addEventListener("compositionend", () => {
      composing = false;
    });
    inputEl.addEventListener("keydown", (event) => {
      if (shouldSubmitFollowUpOnKeydown(event, composing)) {
        event.preventDefault();
        void send();
      }
    });
    formEl.createSpan({
      cls: "lacan-ai-input-hint",
      text: "Enter 发送 · Shift+Enter 换行",
    });
  }

  createButton(parentEl, text, action, extraClass = "") {
    const button = parentEl.createEl("button", {
      cls: ["lacan-ai-action-button", extraClass].filter(Boolean).join(" "),
      text,
    });
    button.setAttribute("type", "button");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      void action();
    });
    return button;
  }

  answerPlaceholder(status = this.state.status) {
    switch (status) {
      case "resolving":
        return "正在读取译文、法文、术语表和关联笔记……";
      case "starting":
        return "正在启动只读本地 Agent……";
      case "streaming":
        return "Agent 正在检索本研讨班资料……";
      case "searching":
        return "Agent 正在检索本研讨班资料……";
      case "stale":
        return "请选择“重新解读”以基于当前材料创建新会话。";
      default:
        return "尚无可显示的回答。";
    }
  }

  canPatchActiveGeneration(rootEl, state, stateKey) {
    const renderedDom = this.renderedDom;
    return Boolean(
      renderedDom?.answerEl
      && renderedDom.rootEl === rootEl
      && renderedDom.stateKey === stateKey
      && ACTIVE_GENERATION_STATUSES.has(renderedDom.status)
      && ACTIVE_GENERATION_STATUSES.has(state.status)
    );
  }

  async patchActiveGeneration(state, token) {
    const renderedDom = this.renderedDom;
    if (!renderedDom?.answerEl) {
      return;
    }
    renderedDom.status = state.status;
    renderedDom.statusEl.className =
      `lacan-ai-status is-${state.status || "empty"}`;
    renderedDom.statusEl.textContent = segmentAiStatusLabel(state.status);
    const preparedAnswer = await this.prepareAnswerContent(
      renderedDom.answerEl,
      state.answer,
      state.context.reference.translationPath,
      state.status
    );
    if (token !== this.renderToken || this.renderedDom !== renderedDom) {
      this.discardPreparedAnswer(preparedAnswer);
      return;
    }
    const preservedScrollTop = this.savedScrollTop;
    this.commitPreparedAnswer(renderedDom.answerEl, preparedAnswer);
    this.applyScrollPosition(renderedDom.scrollEl, preservedScrollTop);
  }

  bindScrollTracking(scrollEl) {
    scrollEl.addEventListener?.("scroll", () => {
      this.savedScrollTop = Math.max(0, Number(scrollEl.scrollTop || 0));
      this.autoScrollEnabled = isNearScrollBottom(scrollEl);
    }, { passive: true });
  }

  applyScrollPosition(scrollEl, preservedScrollTop = this.savedScrollTop) {
    const windowRef = scrollEl?.ownerDocument?.defaultView || globalThis.window;
    const apply = () => {
      if (this.renderedDom?.scrollEl !== scrollEl) {
        return;
      }
      if (this.autoScrollEnabled) {
        scrollEl.scrollTop = scrollEl.scrollHeight;
      } else {
        const maxScrollTop = Math.max(
          0,
          Number(scrollEl.scrollHeight || 0)
            - Number(scrollEl.clientHeight || 0)
        );
        scrollEl.scrollTop = Math.min(
          Math.max(0, Number(preservedScrollTop || 0)),
          maxScrollTop
        );
      }
      this.savedScrollTop = Math.max(0, Number(scrollEl.scrollTop || 0));
    };
    if (typeof windowRef?.requestAnimationFrame === "function") {
      windowRef.requestAnimationFrame(apply);
    } else {
      apply();
    }
  }

  createDetachedAnswerContent(answerEl) {
    const contentEl = answerEl?.ownerDocument?.createElement?.("div")
      || answerEl.createDiv();
    contentEl.className = "lacan-ai-answer-content";
    return contentEl;
  }

  async prepareAnswerContent(answerEl, answer, sourcePath, status) {
    const contentEl = this.createDetachedAnswerContent(answerEl);
    if (!answer) {
      contentEl.createEl("p", {
        cls: "lacan-ai-answer-placeholder",
        text: this.answerPlaceholder(status),
      });
      return { contentEl, component: null };
    }
    const component = await this.renderMarkdown(contentEl, answer, sourcePath);
    return { contentEl, component };
  }

  commitPreparedAnswer(answerEl, preparedAnswer) {
    const previousComponent = this.markdownComponent;
    answerEl.replaceChildren(preparedAnswer.contentEl);
    this.markdownComponent = preparedAnswer.component;
    previousComponent?.unload?.();
  }

  discardPreparedAnswer(preparedAnswer) {
    preparedAnswer?.component?.unload?.();
  }

  async renderMarkdown(element, markdown, sourcePath) {
    if (!MarkdownRenderer?.render) {
      element.createEl("pre", { text: markdown });
      return null;
    }
    const component = new Component();
    component.load();
    try {
      await MarkdownRenderer.render(
        this.plugin.app,
        markdown,
        element,
        sourcePath,
        component
      );
      return component;
    } catch (error) {
      component.unload();
      throw error;
    }
  }

  unloadMarkdown() {
    if (!this.markdownComponent) {
      return;
    }
    try {
      this.markdownComponent.unload();
    } finally {
      this.markdownComponent = null;
    }
  }
}

const segmentAiStatusLabel = (status) => STATUS_LABELS[status] || STATUS_LABELS.empty;

const workspaceStatusGlyph = (conversation) => {
  if (conversation?.needsAttention) {
    return "●";
  }
  switch (conversation?.status) {
    case "resolving":
    case "starting":
    case "searching":
    case "streaming":
      return "◌";
    case "completed":
      return "✓";
    case "failed":
    case "unavailable":
      return "!";
    case "stale":
      return "△";
    case "interrupted":
      return "Ⅱ";
    default:
      return "";
  }
};

const singleLineSummary = (value, limit = 54) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

module.exports = {
  LACAN_INTERPRETATION_VIEW_TYPE,
  LacanInterpretationView,
  STATUS_LABELS,
  createObsidianContextResolver,
  isWorkspaceState,
  isNearScrollBottom,
  measureStatusBarClearance,
  nextConversationAnchor,
  segmentAiStatusLabel,
  shouldSubmitFollowUpOnKeydown,
  shouldResetAutoScroll,
  singleLineSummary,
  workspaceStatusGlyph,
};
