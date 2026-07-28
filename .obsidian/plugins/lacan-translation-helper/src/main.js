const Obsidian = require("obsidian");
const {
  Component,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
} = Obsidian;
const {
  DEFAULT_INTERPRETATION_PROMPT,
  InterpretationPromptBuilder,
  resolveConfiguredInterpretationPrompt,
} = require("../segment-ai/domain");
const {
  CodexAppServerRuntime,
  coerceCodexReasoningEffort,
  normalizeCodexModelCatalog,
  resolveCodexReasoningProfile,
} = require("../segment-ai/codex-app-server-runtime");
const {
  normalizeServerNames,
} = require("../segment-ai/mcp-capability-registry");
const {
  InterpretationWorkspaceController,
} = require("../segment-ai/workspace-controller");
const {
  InterpretationWorkspaceStore,
  STANDARD_SKILL_PROFILE,
  normalizeMaxOpenSessions,
} = require("../segment-ai/workspace-store");
const {
  CodexSkillCatalog,
  CustomSkillService,
  normalizeSkillMetadata,
  normalizeSkillProfiles,
} = require("../segment-ai/skill-catalog");
const {
  LACAN_INTERPRETATION_VIEW_TYPE,
  LacanInterpretationView,
  createObsidianContextResolver,
} = require("../segment-ai/obsidian-integration");
let Decoration = null;
let ViewPlugin = null;
let WidgetTypeBase = class {};
try {
  const CodeMirrorView = require("@codemirror/view");
  Decoration = CodeMirrorView.Decoration;
  ViewPlugin = CodeMirrorView.ViewPlugin;
  WidgetTypeBase = CodeMirrorView.WidgetType || WidgetTypeBase;
} catch (error) {
  console.warn("Lacan Translation Helper: CodeMirror editor widgets are unavailable.", error);
}
const ObsidianBasesView = Obsidian.BasesView || class {};
const MarkdownRenderComponent = Component || class {
  load() {}
  unload() {}
};

const LESSON_FILE_RE = /^(?:Leçon|Lecon|lesson)-(\d+)\.md$/i;
const ORIGINAL_PATH_RE = /^texts\/([^/]+)\/original\/((?:Leçon|Lecon|lesson)-\d+\.md)$/i;
const TRANSLATION_PATH_RE = /^texts\/([^/]+)\/translation\/((?:Leçon|Lecon|lesson)-\d+\.md)$/i;
const READING_NOTE_PATH_RE = /^texts\/([^/]+)\/notes\/(.+\.md)$/i;
const SEGMENT_ID_ANCHOR_LINE_RE = /<!--\s*id\s*:?\s*(s\d+[a-z]?-\d+-\d+)\s*-->/i;
const SEGMENT_ID_COMMENT_RE = /<!--\s*ids?\b\s*:?\s*([\s\S]*?)-->/gi;
const SEGMENT_ID_COMMENT_TEST_RE = /<!--\s*ids?\b\s*:?\s*[\s\S]*?\bs\d+b?-\d+-\d+\b[\s\S]*?-->/i;
const SEGMENT_ID_TOKEN_RE = /\bs\d+b?-\d+-\d+\b/gi;
const SEGMENT_ID_LINK_RE = /^s(\d+[a-z]?)-(\d+)-\d+$/i;
const SEGMENT_ID_RE = /\bs\d+b?-\d+-(\d+)\b/gi;
const SEMINAR_RE = /<!--\s*seminar:\s*([^>\s]+)\s*-->/i;
const LESSON_RE = /<!--\s*lesson:\s*([^>\s]+)\s*-->/i;
const UNTRANSLATED_RE = /<!--\s*untranslated\s*-->/gi;
const MARKDOWN_RENDER_COMPONENT_KEY = "__lacanMarkdownRenderComponent";
const LACAN_LESSON_LIST_VIEW_TYPE = "lacan-lesson-list";
const DEFAULT_REPOSITORY_URL = "https://github.com/Kotoba-Rin/Lacan-Chinese-Translation-Project.git";
const DEFAULT_GITHUB_PROXY_URL = "http://127.0.0.1:6789";
const GIT_TIMEOUT_MS = 120000;
const GIT_MAX_BUFFER = 50 * 1024 * 1024;
const REASONING_EFFORT_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "xHigh",
  max: "Max",
  ultra: "Ultra",
};

const DEFAULT_SETTINGS = {
  mode: "reader",
  repositoryUrl: DEFAULT_REPOSITORY_URL,
  repositoryBranch: "main",
  upstreamLocalBranch: "lacan-upstream/main",
  githubProxyEnabled: false,
  githubProxyUrl: DEFAULT_GITHUB_PROXY_URL,
  autoSyncOnStartup: false,
  segmentAiEnabled: false,
  segmentAiCodexPath: "",
  segmentAiModel: "",
  segmentAiReasoningEffort: "",
  segmentAiMcpEnabled: false,
  segmentAiMcpEnabledServers: [],
  segmentAiMcpServerCatalog: [],
  segmentAiMcpServerCatalogUpdatedAt: 0,
  segmentAiPrompt: DEFAULT_INTERPRETATION_PROMPT,
  segmentAiModelCatalog: [],
  segmentAiModelCatalogUpdatedAt: 0,
  segmentAiSessions: [],
  segmentAiSchemaVersion: 2,
  segmentAiMaxOpenSessions: 3,
  segmentAiConversations: [],
  segmentAiWorkspace: {
    openConversationIds: [],
    activeConversationId: null,
  },
  segmentAiSkillCatalog: [],
  segmentAiSkillCatalogUpdatedAt: 0,
  segmentAiSkillProfiles: [],
  segmentAiDefaultSkillProfileId: "standard",
  segmentAiCustomSkillRoot: ".agents/skills",
  forks: [],
};

class ReadingNoteButtonWidget extends WidgetTypeBase {
  constructor(plugin, sourcePath, segmentId) {
    super();
    this.plugin = plugin;
    this.sourcePath = sourcePath;
    this.segmentId = segmentId;
    this.aiEnabled = Boolean(plugin.settings?.segmentAiEnabled);
    this.aiProfileChoices = plugin.getSegmentAiSkillProfiles?.().length || 1;
    this.aiDefaultProfileId =
      plugin.settings?.segmentAiDefaultSkillProfileId || "standard";
  }

  eq(other) {
    return (
      other.sourcePath === this.sourcePath
      && other.segmentId === this.segmentId
      && other.aiEnabled === this.aiEnabled
      && other.aiProfileChoices === this.aiProfileChoices
      && other.aiDefaultProfileId === this.aiDefaultProfileId
    );
  }

  toDOM() {
    const actions = document.createElement("span");
    actions.className = "lacan-segment-actions";

    const noteButton = document.createElement("button");
    noteButton.className = "lacan-segment-note-button";
    noteButton.type = "button";
    noteButton.textContent = "记笔记";
    noteButton.title = `为 ${this.segmentId} 记笔记`;
    noteButton.setAttribute("aria-label", `为 ${this.segmentId} 记笔记`);
    noteButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.plugin.runWithNotice(
        () => this.plugin.createReadingNoteForSegment(this.sourcePath, this.segmentId),
        "记笔记失败"
      );
    });
    actions.appendChild(noteButton);

    if (this.aiEnabled) {
      actions.appendChild(
        this.plugin.createSegmentAiButton(this.sourcePath, this.segmentId)
      );
      if (this.plugin.hasSegmentAiProfileChoices?.()) {
        actions.appendChild(
          this.plugin.createSegmentAiProfileMenuButton(
            this.sourcePath,
            this.segmentId
          )
        );
      }
    }
    return actions;
  }

  ignoreEvent() {
    return false;
  }
}

module.exports = class LacanTranslationHelper extends Plugin {
  async onload() {
    const loadedSettings = await this.loadData() || {};
    const legacySkillProfiles = Array.isArray(
      loadedSettings.segmentAiSkillProfiles
    )
      ? loadedSettings.segmentAiSkillProfiles
      : [];
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedSettings);
    this.settings.segmentAiPrompt = resolveConfiguredInterpretationPrompt({
      storedPrompt: loadedSettings.segmentAiPrompt,
      legacyProfiles: legacySkillProfiles,
      defaultProfileId: loadedSettings.segmentAiDefaultSkillProfileId,
    });
    this.settings.forks = Array.isArray(this.settings.forks) ? this.settings.forks : [];
    this.settings.segmentAiSessions = Array.isArray(this.settings.segmentAiSessions)
      ? this.settings.segmentAiSessions
      : [];
    this.settings.segmentAiMaxOpenSessions = normalizeMaxOpenSessions(
      this.settings.segmentAiMaxOpenSessions
    );
    this.settings.segmentAiConversations = Array.isArray(
      this.settings.segmentAiConversations
    )
      ? this.settings.segmentAiConversations
      : [];
    this.settings.segmentAiWorkspace = (
      this.settings.segmentAiWorkspace
      && typeof this.settings.segmentAiWorkspace === "object"
    )
      ? this.settings.segmentAiWorkspace
      : { openConversationIds: [], activeConversationId: null };
    this.settings.segmentAiSkillProfiles = normalizeSkillProfiles(
      this.settings.segmentAiSkillProfiles
    );
    this.settings.segmentAiDefaultSkillProfileId = String(
      this.settings.segmentAiDefaultSkillProfileId || "standard"
    ).trim() || "standard";
    if (
      this.settings.segmentAiDefaultSkillProfileId !== "standard"
      && !this.settings.segmentAiSkillProfiles.some(
        (profile) => profile.id === this.settings.segmentAiDefaultSkillProfileId
      )
    ) {
      this.settings.segmentAiDefaultSkillProfileId = "standard";
    }
    this.settings.segmentAiCustomSkillRoot = [
      ".agents/skills",
      ".codex/skills",
    ].includes(this.settings.segmentAiCustomSkillRoot)
      ? this.settings.segmentAiCustomSkillRoot
      : ".agents/skills";
    this.settings.segmentAiSkillCatalog = (
      Array.isArray(this.settings.segmentAiSkillCatalog)
        ? this.settings.segmentAiSkillCatalog
        : []
    ).map(normalizeSkillMetadata).filter(Boolean);
    this.settings.segmentAiSkillCatalogUpdatedAt = Number.isFinite(
      this.settings.segmentAiSkillCatalogUpdatedAt
    )
      ? this.settings.segmentAiSkillCatalogUpdatedAt
      : 0;
    if (
      this.settings.segmentAiConversations.length === 0
      && this.settings.segmentAiSessions.length > 0
    ) {
      const migrated = InterpretationWorkspaceStore.migrateLegacy({
        legacySessions: this.settings.segmentAiSessions,
      });
      this.settings.segmentAiConversations = migrated.conversations;
      this.settings.segmentAiWorkspace = migrated.workspace;
      this.settings.segmentAiSchemaVersion = 2;
      this.settings.segmentAiSessions = [];
    }
    this.settings.segmentAiModelCatalog = normalizeCodexModelCatalog(
      this.settings.segmentAiModelCatalog
    );
    this.settings.segmentAiModel = String(
      this.settings.segmentAiModel || ""
    ).trim();
    this.settings.segmentAiReasoningEffort = coerceCodexReasoningEffort(
      this.settings.segmentAiModelCatalog,
      this.settings.segmentAiModel,
      this.settings.segmentAiReasoningEffort
    );
    this.settings.segmentAiModelCatalogUpdatedAt = Number.isFinite(
      this.settings.segmentAiModelCatalogUpdatedAt
    )
      ? this.settings.segmentAiModelCatalogUpdatedAt
      : 0;
    this.settings.segmentAiMcpEnabled =
      this.settings.segmentAiMcpEnabled === true;
    this.settings.segmentAiMcpEnabledServers = normalizeServerNames(
      this.settings.segmentAiMcpEnabledServers
    );
    this.settings.segmentAiMcpServerCatalog = normalizeServerNames(
      this.settings.segmentAiMcpServerCatalog
    );
    this.settings.segmentAiMcpServerCatalogUpdatedAt = Number.isFinite(
      this.settings.segmentAiMcpServerCatalogUpdatedAt
    )
      ? this.settings.segmentAiMcpServerCatalogUpdatedAt
      : 0;
    this.progressTimers = new Map();
    this.activeComparisonForks = new Set();
    this.expandedComparisonSegments = new Set();
    this.comparisonContentCache = new Map();
    this.comparisonSegmentIndexCache = new Map();
    this.compareRenderTimer = null;
    this.compareRenderToken = 0;
    this.compareLoadingTimer = null;
    this.comparisonPreviewObserver = null;
    this.comparisonPreviewRenderTimer = null;
    this.comparisonCacheRevision = 0;
    this.comparisonRenderRevision = 0;
    this.comparisonRenderStates = new WeakMap();
    this.syncInProgress = false;
    this.gitProcesses = new Set();
    this.startupSyncTimer = null;
    this.createdFileTimers = new Set();
    this.progressWritePaths = new Set();
    this.progressWriteSuppressTimers = new Map();
    this.segmentPreviewCache = new Map();
    this.segmentPreviewEl = null;
    this.segmentPreviewHideTimer = null;
    this.segmentPreviewRenderToken = 0;
    this.segmentAiState = {
      maxOpenSessions: this.settings.segmentAiMaxOpenSessions,
      openConversationIds: [],
      activeConversationId: null,
      conversations: [],
      runningCount: 0,
    };
    this.segmentAiRuntime = null;
    this.segmentAiController = null;
    this.segmentAiWorkspaceStore = null;
    this.segmentAiSkillCatalog = null;
    this.segmentAiCustomSkillService = null;
    this.segmentAiSkillChangeUnsubscribe = null;
    this.segmentAiModelDiscoveryPromise = null;
    this.segmentAiSkillDiscoveryPromise = null;
    this.segmentAiMcpBackgroundPromise = null;
    this.segmentAiEphemeralPersistTimer = null;

    this.registerView?.(
      LACAN_INTERPRETATION_VIEW_TYPE,
      (leaf) => new LacanInterpretationView(leaf, this)
    );
    this.initializeSegmentAi();
    this.scheduleSegmentAiMcpBackgroundCheck();
    await this.saveSettings();

    this.addSettingTab(new LacanTranslationHelperSettingTab(this.app, this));

    this.registerDomEvent(document, "click", (event) => {
      this.handleSegmentInternalLinkClick(event);
    }, { capture: true });
    this.registerDomEvent(document, "mouseover", (event) => {
      this.handleSegmentLinkPreviewEnter(event);
    }, { capture: true });
    this.registerDomEvent(document, "mouseout", (event) => {
      this.handleSegmentLinkPreviewLeave(event);
    }, { capture: true });
    this.registerDomEvent(document, "focusin", (event) => {
      this.handleSegmentLinkPreviewEnter(event);
    }, { capture: true });
    this.registerDomEvent(document, "focusout", (event) => {
      this.handleSegmentLinkPreviewLeave(event);
    }, { capture: true });

    this.registerReadingNoteEditorExtension();

    this.registerMarkdownPostProcessor((element, context) => {
      const path = normalizePath(context.sourcePath || "");
      if (!this.isReadingNotePath(path) || element.closest?.(".cm-editor, .markdown-source-view")) {
        return;
      }
      this.decorateRenderedSegmentLinks(element);
    });

    this.registerMarkdownPostProcessor((element, context) => {
      const path = normalizePath(context.sourcePath || "");
      if (!this.isTranslationLessonPath(path) || element.closest?.(".cm-editor, .markdown-source-view")) {
        return;
      }
      this.decorateRenderedReadingNoteLinks(element, path);
    });

    this.registerMarkdownPostProcessor((element, context) => {
      const path = normalizePath(context.sourcePath || "");
      if (
        !this.settings.segmentAiEnabled
        || !this.isTranslationLessonPath(path)
        || element.closest?.(".cm-editor, .markdown-source-view")
      ) {
        return;
      }
      this.renderSegmentAiPreviewActions(
        element,
        path,
        context.getSectionInfo?.(element)
      );
    });

    this.registerMarkdownPostProcessor((element, context) => {
      if (!this.hasActiveComparisonForks()) {
        return;
      }
      const path = normalizePath(context.sourcePath || "");
      if (!this.isTextMarkdownPath(path) || element.closest?.(".cm-editor, .markdown-source-view")) {
        return;
      }
      const sectionInfo = context.getSectionInfo?.(element);
      if (!this.hasSegmentIdComment(sectionInfo?.text || "")) {
        return;
      }
      this.renderInlineComparisonControls(element, context.sourcePath, {
        allowSourceFallback: false,
        sectionInfo,
      }).catch((error) => this.handleComparisonRenderError(error));
    });

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        this.handleCreatedFile(file);
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        this.handleModifiedFile(file);
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        this.addFileMenuItems(menu, file);
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.scheduleComparisonRender();
      })
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.scheduleComparisonRender();
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.scheduleComparisonRender();
      })
    );

    this.registerProjectBasesView();

    this.addCommand({
      id: "create-translation-skeleton-from-active-file",
      name: "Create translation skeleton from active lesson",
      callback: () =>
        this.runWithNotice(
          () => this.createSkeletonFromActiveFile(),
          "译文骨架生成失败"
        ),
    });

    this.addCommand({
      id: "update-all-translation-progress",
      name: "Update translation progress for all lessons",
      callback: () =>
        this.runWithNotice(
          () => this.updateAllTranslationProgress(),
          "翻译进度更新失败"
        ),
    });

    this.addCommand({
      id: "sync-configured-github-repositories",
      name: "Sync configured GitHub repositories",
      callback: () =>
        this.runWithNotice(
          () => this.syncConfiguredRepositories({ notify: true }),
          "Git 同步失败"
        ),
    });

    this.scheduleComparisonRender();

    if (this.settings.autoSyncOnStartup) {
      this.startupSyncTimer = window.setTimeout(() => {
        this.startupSyncTimer = null;
        this.runWithNotice(
          async () => {
            if (this.settings.mode === "reader" && !this.confirmReaderAutoSyncRun()) {
              new Notice("已跳过 Reader 自动同步。");
              return;
            }
            await this.syncConfiguredRepositories({ notify: true });
          },
          "Git 自动同步失败"
        );
      }, 1500);
    }
  }

  onunload() {
    if (this.startupSyncTimer) {
      window.clearTimeout(this.startupSyncTimer);
      this.startupSyncTimer = null;
    }
    for (const timer of this.createdFileTimers) {
      window.clearTimeout(timer);
    }
    this.createdFileTimers.clear();
    for (const timer of this.progressTimers.values()) {
      window.clearTimeout(timer);
    }
    this.progressTimers.clear();
    for (const timer of this.progressWriteSuppressTimers.values()) {
      window.clearTimeout(timer);
    }
    this.progressWriteSuppressTimers.clear();
    this.progressWritePaths.clear();
    this.hideSegmentPreview();
    if (this.segmentPreviewHideTimer) {
      window.clearTimeout(this.segmentPreviewHideTimer);
      this.segmentPreviewHideTimer = null;
    }
    this.segmentPreviewCache.clear();

    if (this.compareRenderTimer) {
      window.clearTimeout(this.compareRenderTimer);
      this.compareRenderTimer = null;
    }
    if (this.compareLoadingTimer) {
      window.clearTimeout(this.compareLoadingTimer);
      this.compareLoadingTimer = null;
    }
    this.disconnectComparisonPreviewWatchers();
    this.removeComparisonToolbars();
    this.segmentAiSkillChangeUnsubscribe?.();
    this.segmentAiSkillChangeUnsubscribe = null;
    if (this.segmentAiEphemeralPersistTimer) {
      clearTimeout(this.segmentAiEphemeralPersistTimer);
      this.segmentAiEphemeralPersistTimer = null;
      void this.persistSegmentAiWorkspaceSnapshot();
    }
    if (this.segmentAiRuntime) {
      void this.segmentAiRuntime.shutdown();
      this.segmentAiRuntime = null;
      this.segmentAiController = null;
    }
    for (const child of this.gitProcesses) {
      try {
        child.kill();
      } catch (error) {
        console.warn("Lacan Translation Helper: failed to stop git process.", error);
      }
    }
    this.gitProcesses.clear();
  }

  registerProjectBasesView() {
    if (typeof this.registerBasesView !== "function" || !Obsidian.BasesView) {
      console.warn("Lacan Translation Helper: Obsidian Bases view API is unavailable.");
      return;
    }

    this.registerBasesView(LACAN_LESSON_LIST_VIEW_TYPE, {
      name: "Lacan Lesson List",
      icon: "list-tree",
      factory: (controller, containerEl) => new LacanLessonListBasesView(controller, containerEl, this),
    });
  }

  initializeSegmentAi() {
    try {
      this.segmentAiWorkspaceStore = new InterpretationWorkspaceStore({
        conversations: this.settings.segmentAiConversations,
        workspace: this.settings.segmentAiWorkspace,
        maxOpenSessions: this.settings.segmentAiMaxOpenSessions,
      });
      this.segmentAiRuntime = new CodexAppServerRuntime({
        vaultRoot: this.getVaultBasePath(),
        pluginVersion: this.manifest?.version || "0.0.0",
        cliPath: this.settings.segmentAiCodexPath || "",
        defaultModel: this.settings.segmentAiModel || "",
        defaultReasoningEffort: this.settings.segmentAiReasoningEffort || "",
        mcpEnabled: this.settings.segmentAiMcpEnabled,
        enabledMcpServerNames: this.settings.segmentAiMcpEnabledServers,
      });
      this.segmentAiSkillCatalog = new CodexSkillCatalog({
        vaultRoot: this.getVaultBasePath(),
        runtime: this.segmentAiRuntime,
        initialSkills: this.settings.segmentAiSkillCatalog,
      });
      this.segmentAiSkillChangeUnsubscribe?.();
      this.segmentAiSkillChangeUnsubscribe =
        this.segmentAiRuntime.onSkillsChanged?.(() => {
          this.segmentAiSkillCatalog?.invalidate?.();
        }) || null;
      this.segmentAiCustomSkillService = new CustomSkillService({
        vaultRoot: this.getVaultBasePath(),
        adapter: this.createCustomSkillAdapter(),
      });
      this.segmentAiController = new InterpretationWorkspaceController({
        resolver: createObsidianContextResolver(this.app),
        promptBuilder: new InterpretationPromptBuilder({
          interpretationPrompt: this.settings.segmentAiPrompt,
        }),
        store: this.segmentAiWorkspaceStore,
        runtime: this.segmentAiRuntime,
        skillCatalog: this.segmentAiSkillCatalog,
        onState: (state) => this.updateSegmentAiState(state),
        persistWorkspace: async ({ conversations, workspace }) => {
          this.settings.segmentAiConversations = conversations;
          this.settings.segmentAiWorkspace = workspace;
          this.settings.segmentAiSchemaVersion = 2;
          await this.saveSettings();
        },
      });
      this.updateSegmentAiState(this.segmentAiWorkspaceStore.snapshot());
    } catch (error) {
      this.segmentAiRuntime = null;
      this.segmentAiController = null;
      this.updateSegmentAiState({
        maxOpenSessions: this.settings.segmentAiMaxOpenSessions,
        openConversationIds: [],
        activeConversationId: null,
        conversations: [],
        runningCount: 0,
        workspaceError: {
          code: error?.code || "AppServerIncompatible",
          message: error?.message || "当前 Vault 无法初始化本地 Agent。",
        },
      });
    }
  }

  async resetSegmentAiRuntime({ scheduleMcpCheck = true } = {}) {
    if (this.segmentAiRuntime) {
      await this.segmentAiRuntime.shutdown();
    }
    this.segmentAiSkillChangeUnsubscribe?.();
    this.segmentAiSkillChangeUnsubscribe = null;
    this.segmentAiRuntime = null;
    this.segmentAiController = null;
    this.segmentAiWorkspaceStore = null;
    this.segmentAiSkillCatalog = null;
    this.segmentAiCustomSkillService = null;
    this.segmentAiMcpBackgroundPromise = null;
    this.initializeSegmentAi();
    if (scheduleMcpCheck) {
      this.scheduleSegmentAiMcpBackgroundCheck();
    }
    this.refreshSegmentAiEntrances();
  }

  getSegmentAiMcpServerCatalog() {
    return normalizeServerNames([
      ...this.settings.segmentAiMcpServerCatalog,
      ...this.settings.segmentAiMcpEnabledServers,
    ]);
  }

  scheduleSegmentAiMcpBackgroundCheck() {
    if (!this.settings.segmentAiEnabled || !this.segmentAiRuntime) {
      return null;
    }
    const task = this.runSegmentAiMcpBackgroundCheck();
    void task.catch(() => {
      // Startup preflight is intentionally silent; diagnostics retain the code.
    });
    return task;
  }

  runSegmentAiMcpBackgroundCheck() {
    if (this.segmentAiMcpBackgroundPromise) {
      return this.segmentAiMcpBackgroundPromise;
    }
    const runtime = this.segmentAiRuntime;
    if (!runtime) {
      return Promise.reject(new Error("本地 Agent 运行时尚未初始化。"));
    }
    const task = (async () => {
      const report = await runtime.preflightMcpServers();
      if (this.segmentAiRuntime !== runtime) {
        return report;
      }
      this.settings.segmentAiMcpServerCatalog = normalizeServerNames(
        report.configuredServerNames
      );
      this.settings.segmentAiMcpServerCatalogUpdatedAt = Number(
        report.checkedAt || Date.now()
      );
      await this.saveSettings();
      return report;
    })();
    this.segmentAiMcpBackgroundPromise = task;
    const clear = () => {
      if (this.segmentAiMcpBackgroundPromise === task) {
        this.segmentAiMcpBackgroundPromise = null;
      }
    };
    task.then(clear, clear);
    return task;
  }

  async refreshSegmentAiMcpServers() {
    if (!this.settings.segmentAiEnabled) {
      throw new Error("请先启用分段 AI 功能。");
    }
    await this.resetSegmentAiRuntime({ scheduleMcpCheck: false });
    return this.runSegmentAiMcpBackgroundCheck();
  }

  getSegmentAiModelCatalog() {
    return normalizeCodexModelCatalog(this.settings.segmentAiModelCatalog);
  }

  async discoverSegmentAiModels() {
    if (this.segmentAiModelDiscoveryPromise) {
      return this.segmentAiModelDiscoveryPromise;
    }
    this.segmentAiModelDiscoveryPromise = (async () => {
      if (!this.segmentAiRuntime) {
        this.initializeSegmentAi();
      }
      if (!this.segmentAiRuntime) {
        throw new Error("本地 Agent 运行时尚未初始化。");
      }
      const models = await this.segmentAiRuntime.listModels();
      this.settings.segmentAiModelCatalog = models;
      this.settings.segmentAiReasoningEffort = coerceCodexReasoningEffort(
        models,
        this.settings.segmentAiModel,
        this.settings.segmentAiReasoningEffort
      );
      this.segmentAiRuntime.defaultReasoningEffort =
        this.settings.segmentAiReasoningEffort;
      this.settings.segmentAiModelCatalogUpdatedAt = Date.now();
      await this.saveSettings();
      return models;
    })();
    try {
      return await this.segmentAiModelDiscoveryPromise;
    } finally {
      this.segmentAiModelDiscoveryPromise = null;
    }
  }

  getSegmentAiSkillProfiles() {
    return [
      { ...STANDARD_SKILL_PROFILE },
      ...normalizeSkillProfiles(this.settings.segmentAiSkillProfiles),
    ];
  }

  getSegmentAiSkillProfile(profileId = "") {
    const requestedId = String(
      profileId || this.settings.segmentAiDefaultSkillProfileId || "standard"
    ).trim();
    return this.getSegmentAiSkillProfiles().find(
      (profile) => profile.id === requestedId
    ) || { ...STANDARD_SKILL_PROFILE };
  }

  hasSegmentAiProfileChoices() {
    return this.getSegmentAiSkillProfiles().length > 1;
  }

  async discoverSegmentAiSkills({ forceReload = true } = {}) {
    if (this.segmentAiSkillDiscoveryPromise) {
      return this.segmentAiSkillDiscoveryPromise;
    }
    this.segmentAiSkillDiscoveryPromise = (async () => {
      if (!this.segmentAiRuntime || !this.segmentAiSkillCatalog) {
        this.initializeSegmentAi();
      }
      if (!this.segmentAiSkillCatalog) {
        throw new Error("本地 Agent 的 Skill 清单尚未初始化。");
      }
      const skills = await this.segmentAiSkillCatalog.refresh({ forceReload });
      this.settings.segmentAiSkillCatalog = skills;
      this.settings.segmentAiSkillCatalogUpdatedAt = Date.now();
      await this.saveSettings();
      return skills;
    })();
    try {
      return await this.segmentAiSkillDiscoveryPromise;
    } finally {
      this.segmentAiSkillDiscoveryPromise = null;
    }
  }

  createCustomSkillAdapter() {
    return {
      exists: async (relativePath) => Boolean(
        this.app.vault.getAbstractFileByPath(normalizePath(relativePath))
      ),
      mkdir: async (relativePath) => {
        const normalized = normalizePath(relativePath);
        const parts = normalized.split("/").filter(Boolean);
        let current = "";
        for (const part of parts) {
          current = current ? `${current}/${part}` : part;
          if (!this.app.vault.getAbstractFileByPath(current)) {
            await this.app.vault.createFolder(current);
          }
        }
      },
      write: async (relativePath, content) => {
        const normalized = normalizePath(relativePath);
        if (this.app.vault.getAbstractFileByPath(normalized)) {
          throw Object.assign(
            new Error("目标 SKILL.md 已经存在。"),
            { code: "SkillAlreadyExists" }
          );
        }
        await this.app.vault.create(normalized, content);
      },
    };
  }

  async createSegmentAiCustomSkill(options) {
    if (!this.segmentAiCustomSkillService) {
      this.initializeSegmentAi();
    }
    const created = await this.segmentAiCustomSkillService.create(options);
    const skills = await this.discoverSegmentAiSkills({ forceReload: true });
    const expectedAbsolutePath = normalizePath(
      `${this.getVaultBasePath().replace(/\/+$/, "")}/${created.path}`
    );
    const verified = skills.find((skill) => (
      skill.name === created.name
      && skill.scope === "repo"
      && (
        normalizePath(skill.path) === expectedAbsolutePath
        || normalizePath(skill.path) === normalizePath(created.path)
      )
    ));
    if (!verified) {
      throw Object.assign(
        new Error("文件已经写入，但 Codex 尚未发现这个 Skill。请检查内容后刷新。"),
        { code: "SkillUnavailable" }
      );
    }
    const profileId = `skill-${created.name}`;
    if (!this.settings.segmentAiSkillProfiles.some(
      (profile) => profile.id === profileId
    )) {
      this.settings.segmentAiSkillProfiles.push({
        id: profileId,
        title: created.name,
        primarySkill: {
          name: verified.name,
          scope: verified.scope,
          pathHint: verified.path,
        },
        supportingSkills: [],
      });
      this.settings.segmentAiSkillProfiles = normalizeSkillProfiles(
        this.settings.segmentAiSkillProfiles
      );
      await this.saveSettings();
    }
    return { ...created, profileId };
  }

  updateSegmentAiState(state) {
    this.segmentAiState = state || { status: "empty" };
    const leaves = this.app.workspace?.getLeavesOfType?.(LACAN_INTERPRETATION_VIEW_TYPE) || [];
    for (const leaf of leaves) {
      leaf.view?.setState?.(this.segmentAiState);
    }
  }

  async openSegmentInterpretationView() {
    let leaf = this.app.workspace.getLeavesOfType?.(LACAN_INTERPRETATION_VIEW_TYPE)?.[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf?.(false)
        || this.app.workspace.getLeaf?.("split", "vertical");
      if (!leaf) {
        throw new Error("无法打开右侧 Lacan AI 栏。");
      }
      await leaf.setViewState({
        type: LACAN_INTERPRETATION_VIEW_TYPE,
        active: true,
      });
    }
    leaf.view?.setState?.(this.segmentAiState);
    await this.app.workspace.revealLeaf?.(leaf);
    return leaf;
  }

  async interpretSegment(sourcePath, segmentId, {
    skillProfileId = "",
    forceNew = false,
  } = {}) {
    if (!this.settings.segmentAiEnabled) {
      new Notice("AI 功能尚未启用，可在 Lacan Translation Helper 的“AI 功能”设置中打开。");
      return { state: "disabled" };
    }
    try {
      await this.openSegmentInterpretationView();
      if (!this.segmentAiController) {
        this.initializeSegmentAi();
      }
      if (!this.segmentAiController) {
        return {
          state: "failed",
          error: this.segmentAiState.error || {
            code: "AppServerIncompatible",
            message: "本地 Agent 初始化失败。",
          },
        };
      }
      const result = await this.segmentAiController.interpret(
        normalizePath(sourcePath || ""),
        String(segmentId || "").trim().toLowerCase(),
        {
          skillProfile: this.getSegmentAiSkillProfile(skillProfileId),
          model: this.settings.segmentAiModel || "",
          effort: this.settings.segmentAiReasoningEffort || "",
          forceNew,
        }
      );
      if (result?.state === "failed" && !result.conversationId) {
        new Notice(`AI 功能未启动：${result.error?.message || "未知错误"}`);
      }
      return result;
    } catch (error) {
      const normalizedError = {
        code: error?.code || "Unknown",
        message: error?.message || "无法运行分段 AI 功能。",
      };
      this.updateSegmentAiState({
        ...(this.segmentAiState || {}),
        workspaceError: normalizedError,
      });
      new Notice(`AI 功能失败：${normalizedError.message}`);
      return { state: "failed", error: normalizedError };
    }
  }

  activeSegmentAiConversationId() {
    return this.segmentAiState?.activeConversationId || null;
  }

  async retrySegmentInterpretation(conversationId = this.activeSegmentAiConversationId()) {
    if (!this.segmentAiController) {
      return { state: "failed" };
    }
    return this.segmentAiController.retry(conversationId);
  }

  async followUpSegmentInterpretation(conversationId, question) {
    if (!this.segmentAiController) {
      return { state: "failed" };
    }
    if (question === undefined) {
      question = conversationId;
      conversationId = this.activeSegmentAiConversationId();
    }
    const result = await this.segmentAiController.followUp(
      conversationId,
      question
    );
    if (["busy", "empty"].includes(result?.state)) {
      new Notice(result.error?.message || "当前问题尚未发送。");
    }
    return result;
  }

  async stopSegmentInterpretation(
    conversationId = this.activeSegmentAiConversationId()
  ) {
    return this.segmentAiController?.stop?.(conversationId) || false;
  }

  async activateSegmentAiConversation(conversationId) {
    if (!this.segmentAiController) {
      return null;
    }
    return this.runSegmentAiConversationAction(
      () => this.segmentAiController.activate(conversationId),
      "无法打开会话"
    );
  }

  async closeSegmentAiConversation(conversationId) {
    return this.runSegmentAiConversationAction(
      () => this.segmentAiController?.close?.(conversationId) || false,
      "无法关闭会话"
    );
  }

  async deleteSegmentAiConversation(conversationId) {
    return this.runSegmentAiConversationAction(
      () => this.segmentAiController?.delete?.(conversationId) || false,
      "无法删除会话"
    );
  }

  async clearAllSegmentAiConversations() {
    return this.runSegmentAiConversationAction(
      () => this.segmentAiController?.clearAll?.() || 0,
      "无法清空全部会话"
    );
  }

  async renameSegmentAiConversation(conversationId, title) {
    return this.runSegmentAiConversationAction(
      () => this.segmentAiController?.rename?.(conversationId, title) || null,
      "无法重命名会话"
    );
  }

  async runSegmentAiConversationAction(action, label) {
    try {
      return await action();
    } catch (error) {
      new Notice(`${label}：${error?.message || "未知错误"}`);
      return {
        state: "failed",
        error: {
          code: error?.code || "Unknown",
          message: error?.message || label,
        },
      };
    }
  }

  updateSegmentAiDraft(conversationId, draft) {
    this.segmentAiWorkspaceStore?.updateDraft?.(conversationId, draft);
    this.scheduleSegmentAiWorkspacePersist();
  }

  updateSegmentAiScroll(conversationId, scroll) {
    this.segmentAiWorkspaceStore?.updateScroll?.(conversationId, scroll);
    this.scheduleSegmentAiWorkspacePersist();
  }

  scheduleSegmentAiWorkspacePersist() {
    if (this.segmentAiEphemeralPersistTimer) {
      clearTimeout(this.segmentAiEphemeralPersistTimer);
    }
    this.segmentAiEphemeralPersistTimer = setTimeout(() => {
      this.segmentAiEphemeralPersistTimer = null;
      void this.persistSegmentAiWorkspaceSnapshot();
    }, 450);
  }

  async persistSegmentAiWorkspaceSnapshot() {
    if (!this.segmentAiWorkspaceStore) {
      return;
    }
    const { conversations, workspace } =
      this.segmentAiWorkspaceStore.serialize();
    this.settings.segmentAiConversations = conversations;
    this.settings.segmentAiWorkspace = workspace;
    this.settings.segmentAiSchemaVersion = 2;
    await this.saveSettings();
  }

  getSegmentAiDiagnostics() {
    const activeConversation = this.segmentAiState?.conversations?.find(
      (conversation) => (
        conversation.id === this.segmentAiState.activeConversationId
      )
    );
    return {
      pluginId: this.manifest?.id || "lacan-translation-helper",
      pluginVersion: this.manifest?.version || "unknown",
      enabled: Boolean(this.settings.segmentAiEnabled),
      status: activeConversation?.status || "empty",
      errorCode: activeConversation?.error?.code || null,
      openConversationCount:
        this.segmentAiState?.openConversationIds?.length || 0,
      runningTurnCount: this.segmentAiState?.runningCount || 0,
      segment: activeConversation
        ? {
            requestedId: activeConversation.requestedId,
            primaryId: activeConversation.primaryId,
            contextHash: activeConversation.contextHash,
          }
        : null,
      runtime: this.segmentAiRuntime?.getDiagnostics?.() || null,
    };
  }

  async openSegmentSource(sourcePath, segmentId) {
    return this.openSegmentId(segmentId, sourcePath);
  }

  renderSegmentAiPreviewActions(containerEl, sourcePath, sectionInfo = null) {
    if (!this.settings.segmentAiEnabled || !containerEl) {
      return 0;
    }
    const path = normalizePath(sourcePath || "");
    const markers = this.extractSegmentMarkers(sectionInfo?.text || "");
    if (markers.length === 0) {
      return this.renderCommentAnchoredSegmentAiActions(containerEl, path);
    }

    const existingIds = new Set(
      Array.from(containerEl.querySelectorAll?.(
        ".lacan-segment-ai-control[data-segment-id]"
      ) || []).map((element) => element.dataset.segmentId)
    );
    const uniqueMarkers = markers.filter((marker, index) => (
      markers.findIndex((candidate) => candidate.id === marker.id) === index
    ));
    if (uniqueMarkers.length === 1) {
      const marker = uniqueMarkers[0];
      if (!existingIds.has(marker.id)) {
        containerEl.prepend(this.createSegmentAiPreviewControl(path, marker.id));
      }
      return 1;
    }

    let inserted = 0;
    const usedAnchors = new Set();
    const anchorIndex = this.buildRenderedAnchorIndex(containerEl);
    const lineOffset = this.sectionLineOffset(sectionInfo);
    for (const marker of uniqueMarkers) {
      if (existingIds.has(marker.id)) {
        inserted += 1;
        continue;
      }
      const adjustedMarker = {
        ...marker,
        line: marker.line + lineOffset,
        nextLine: marker.nextLine === null ? null : marker.nextLine + lineOffset,
      };
      const anchorEl = this.findRenderedSegmentAnchor(
        containerEl,
        adjustedMarker,
        usedAnchors,
        anchorIndex
      );
      if (!anchorEl?.parentNode) {
        continue;
      }
      const controlEl = this.createSegmentAiPreviewControl(path, marker.id);
      anchorEl.parentNode.insertBefore(controlEl, anchorEl);
      usedAnchors.add(anchorEl);
      inserted += 1;
    }
    return inserted;
  }

  renderCommentAnchoredSegmentAiActions(containerEl, sourcePath) {
    if (
      typeof document === "undefined"
      || typeof document.createTreeWalker !== "function"
      || typeof NodeFilter === "undefined"
    ) {
      return 0;
    }
    const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_COMMENT);
    let inserted = 0;
    let commentNode;
    while ((commentNode = walker.nextNode()) !== null) {
      const segmentId = this.segmentIdFromComment(commentNode.nodeValue);
      if (!segmentId || !commentNode.parentNode) {
        continue;
      }
      const exists = Array.from(containerEl.querySelectorAll?.(
        ".lacan-segment-ai-control[data-segment-id]"
      ) || []).some((element) => element.dataset.segmentId === segmentId);
      if (exists) {
        continue;
      }
      commentNode.parentNode.insertBefore(
        this.createSegmentAiPreviewControl(sourcePath, segmentId),
        commentNode.nextSibling
      );
      inserted += 1;
    }
    return inserted;
  }

  createSegmentAiPreviewControl(sourcePath, segmentId) {
    const controlEl = document.createElement("div");
    controlEl.className = "lacan-segment-ai-control";
    controlEl.dataset.segmentId = segmentId;
    controlEl.appendChild(this.createSegmentAiButton(sourcePath, segmentId, {
      includeSegmentId: true,
    }));
    if (this.hasSegmentAiProfileChoices()) {
      controlEl.appendChild(
        this.createSegmentAiProfileMenuButton(sourcePath, segmentId)
      );
    }
    return controlEl;
  }

  createSegmentAiButton(sourcePath, segmentId, { includeSegmentId = false } = {}) {
    const button = document.createElement("button");
    const defaultProfile = this.getSegmentAiSkillProfile();
    button.className = `lacan-segment-ai-button${
      includeSegmentId ? " has-segment-id" : ""
    }`;
    button.type = "button";
    button.textContent = includeSegmentId ? `【${segmentId}】 Ф` : "Ф";
    button.title = `运行“${defaultProfile.title}” · ${segmentId}`;
    button.setAttribute(
      "aria-label",
      `为 ${segmentId} 运行 AI 功能“${defaultProfile.title}”`
    );
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.interpretSegment(sourcePath, segmentId);
    });
    return button;
  }

  createSegmentAiProfileMenuButton(sourcePath, segmentId) {
    const button = document.createElement("button");
    button.className = "lacan-segment-ai-profile-button";
    button.type = "button";
    button.textContent = "▾";
    button.title = `选择 ${segmentId} 的 Skill 方案`;
    button.setAttribute("aria-label", `选择 ${segmentId} 的 Skill 方案`);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openSegmentAiProfileMenu(event, sourcePath, segmentId);
    });
    return button;
  }

  openSegmentAiProfileMenu(event, sourcePath, segmentId) {
    if (!Menu) {
      void this.interpretSegment(sourcePath, segmentId);
      return;
    }
    const menu = new Menu();
    const defaultProfileId =
      this.settings.segmentAiDefaultSkillProfileId || "standard";
    for (const profile of this.getSegmentAiSkillProfiles()) {
      menu.addItem((item) => {
        item
          .setTitle(
            profile.id === defaultProfileId
              ? `✓ ${profile.title}`
              : profile.title
          )
          .setIcon(profile.id === "standard" ? "message-square-text" : "book-open")
          .onClick(() => this.interpretSegment(sourcePath, segmentId, {
            skillProfileId: profile.id,
          }));
      });
    }
    menu.addSeparator?.();
    menu.addItem((item) => {
      item
        .setTitle("刷新 Skills")
        .setIcon("refresh-cw")
        .onClick(async () => {
          try {
            const skills = await this.discoverSegmentAiSkills({
              forceReload: true,
            });
            new Notice(`已从 Codex 获取 ${skills.length} 个可用 Skill。`);
          } catch (error) {
            new Notice(`Skill 刷新失败：${error?.message || "未知错误"}`);
          }
        });
    });
    menu.showAtMouseEvent?.(event);
  }

  refreshSegmentAiEntrances() {
    const rootEl = this.app.workspace?.containerEl || document.body;
    if (!this.settings.segmentAiEnabled) {
      rootEl.querySelectorAll?.(".lacan-segment-ai-control").forEach((element) => element.remove());
    }
    this.app.workspace?.updateOptions?.();
    this.app.workspace?.iterateAllLeaves?.((leaf) => {
      leaf.view?.previewMode?.rerender?.(true);
    });
  }

  async handleCreatedFile(file) {
    if (!(file instanceof TFile) || !this.isTranslationLessonPath(file.path)) {
      return;
    }

    // Let Obsidian finish the unresolved-link creation write before we inspect it.
    const timer = window.setTimeout(async () => {
      this.createdFileTimers.delete(timer);
      await this.runWithNotice(
        () => this.fillTranslationIfEmpty(file, { openAfterCreate: false, notify: false, updateProgress: true }),
        "译文骨架生成失败"
      );
    }, 100);
    this.createdFileTimers.add(timer);
  }

  handleModifiedFile(file) {
    if (!(file instanceof TFile)) {
      return;
    }

    if (file.path.startsWith("texts/") && file.extension === "md") {
      this.comparisonSegmentIndexCache.delete(file.path);
      this.segmentPreviewCache.clear();
      const activeFile = this.app.workspace.getActiveFile();
      if (
        this.hasActiveComparisonForks() &&
        activeFile instanceof TFile &&
        normalizePath(activeFile.path) === normalizePath(file.path)
      ) {
        this.bumpComparisonRenderRevision();
        this.scheduleComparisonRender(350);
      }
    }

    if (!this.isTranslationLessonPath(file.path)) {
      return;
    }

    if (!this.progressWritePaths.has(normalizePath(file.path))) {
      this.scheduleProgressUpdate(file.path);
    }
  }

  addFileMenuItems(menu, file) {
    if (!(file instanceof TFile)) {
      return;
    }

    if (this.isOriginalLessonPath(file.path)) {
      menu.addItem((item) => {
        item
          .setTitle("生成译文骨架")
          .setIcon("languages")
          .onClick(async () => {
            await this.runWithNotice(
              () => this.createTranslationForOriginal(file, { openAfterCreate: true, notify: true }),
              "译文骨架生成失败"
            );
          });
      });
      return;
    }

    if (this.isTranslationLessonPath(file.path)) {
      menu.addItem((item) => {
        item
          .setTitle("为空译文填充分段骨架")
          .setIcon("list-plus")
          .onClick(async () => {
            await this.runWithNotice(
              () => this.fillTranslationIfEmpty(file, { openAfterCreate: true, notify: true }),
              "译文骨架生成失败"
            );
          });
      });
    }
  }

  async createSkeletonFromActiveFile() {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) {
      new Notice("没有活动的课文文件。");
      return;
    }

    if (this.isOriginalLessonPath(file.path)) {
      await this.createTranslationForOriginal(file, { openAfterCreate: true, notify: true, updateProgress: true });
      return;
    }

    if (this.isTranslationLessonPath(file.path)) {
      await this.fillTranslationIfEmpty(file, {
        openAfterCreate: true,
        notify: true,
        notifyExisting: true,
        updateProgress: true,
      });
      return;
    }

    new Notice("当前文件不是 texts/*/original 或 texts/*/translation 下的 Leçon 文件。");
  }

  async runWithNotice(action, prefix) {
    try {
      return await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Lacan Translation Helper: ${prefix}`, error);
      new Notice(`${prefix}：${message}`);
      return null;
    }
  }

  registerReadingNoteEditorExtension() {
    if (!Decoration || !ViewPlugin || typeof this.registerEditorExtension !== "function") {
      return;
    }
    this.registerEditorExtension(this.createReadingNoteEditorExtension());
  }

  createReadingNoteEditorExtension() {
    const plugin = this;
    return ViewPlugin.fromClass(class {
      constructor(view) {
        this.decorations = plugin.buildReadingNoteEditorDecorations(view);
      }

      update(update) {
        if (update.docChanged || update.viewportChanged || update.focusChanged) {
          this.decorations = plugin.buildReadingNoteEditorDecorations(update.view);
        }
      }
    }, {
      decorations: (value) => value.decorations,
    });
  }

  buildReadingNoteEditorDecorations(view) {
    const sourcePath = this.editorPathFromCodeMirrorView(view);
    if (!this.isTranslationLessonPath(sourcePath)) {
      return Decoration.none;
    }

    const ranges = [];
    const visibleRanges = view.visibleRanges?.length
      ? view.visibleRanges
      : [{ from: 0, to: view.state.doc.length }];
    const seenLines = new Set();

    for (const range of visibleRanges) {
      let position = range.from;
      while (position <= range.to) {
        const line = view.state.doc.lineAt(position);
        if (!seenLines.has(line.number)) {
          seenLines.add(line.number);
          const match = line.text.match(SEGMENT_ID_ANCHOR_LINE_RE);
          if (match) {
            ranges.push(
              Decoration.widget({
                widget: new ReadingNoteButtonWidget(this, sourcePath, match[1].toLowerCase()),
                side: 1,
              }).range(line.to)
            );
          }
        }

        if (line.to >= range.to || line.to >= view.state.doc.length) {
          break;
        }
        position = line.to + 1;
      }
    }

    return Decoration.set(ranges, true);
  }

  editorPathFromCodeMirrorView(editorView) {
    let matchedPath = "";
    this.app.workspace.iterateAllLeaves?.((leaf) => {
      if (matchedPath) {
        return;
      }
      const view = leaf?.view;
      if (view?.containerEl?.contains(editorView.dom) && view.file instanceof TFile) {
        matchedPath = normalizePath(view.file.path);
      }
    });

    if (matchedPath) {
      return matchedPath;
    }

    const activeFile = this.app.workspace.getActiveFile();
    return activeFile instanceof TFile ? normalizePath(activeFile.path) : "";
  }

  async createReadingNoteForSegment(sourcePath, segmentId) {
    const normalizedPath = normalizePath(sourcePath || "");
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    if (!this.isTranslationLessonPath(normalizedPath)) {
      throw new Error("当前文件不是译文课文。");
    }
    if (!SEGMENT_ID_LINK_RE.test(normalizedSegmentId)) {
      throw new Error(`不是有效的分段 ID：${segmentId}`);
    }

    const translationFile = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (!(translationFile instanceof TFile)) {
      throw new Error(`找不到译文文件：${normalizedPath}`);
    }

    const notePath = this.readingNotePathForSegment(normalizedPath, normalizedSegmentId);
    if (!notePath) {
      throw new Error("无法计算阅读笔记路径。");
    }

    const noteFile = await this.createOrUpdateReadingNoteFile(notePath, normalizedSegmentId, normalizedPath);
    const translationText = await this.app.vault.read(translationFile);
    const updatedTranslationText = this.insertReadingNoteLink(translationText, normalizedSegmentId);
    if (updatedTranslationText === translationText && !this.hasReadingNoteLink(translationText, normalizedSegmentId)) {
      throw new Error(`译文中没有找到分段 ID：${normalizedSegmentId}`);
    }
    if (updatedTranslationText !== translationText) {
      await this.app.vault.modify(translationFile, updatedTranslationText);
    }

    await this.openReadingNoteOnRight(noteFile);
    new Notice(`已打开阅读笔记：${normalizedSegmentId}`);
  }

  readingNotePathForSegment(sourcePath, segmentId) {
    const normalizedPath = normalizePath(sourcePath || "");
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    const match = normalizedPath.match(TRANSLATION_PATH_RE);
    if (!match || !SEGMENT_ID_LINK_RE.test(normalizedSegmentId)) {
      return "";
    }
    return `texts/${match[1]}/notes/${normalizedSegmentId}.md`;
  }

  readingNoteWikiLinkForSegment(segmentId) {
    return `[[notes/${String(segmentId || "").trim().toLowerCase()}|阅读笔记]]`;
  }

  hasReadingNoteLink(text, segmentId) {
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    const pattern = new RegExp(
      `\\[\\[\\s*notes/${this.escapeRegExp(normalizedSegmentId)}(?:\\.md)?(?:#[^\\]|]+)?(?:\\|[^\\]]*)?\\]\\]`,
      "i"
    );
    return pattern.test(String(text || ""));
  }

  insertReadingNoteLink(text, segmentId) {
    const sourceText = String(text || "");
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    const markers = this.segmentCommentMatches(sourceText);
    const markerIndex = markers.findIndex((marker) => marker.ids.includes(normalizedSegmentId));
    if (markerIndex < 0) {
      return sourceText;
    }

    const marker = markers[markerIndex];
    const nextMarker = markers[markerIndex + 1];
    const blockStart = marker.end;
    const blockEnd = nextMarker ? nextMarker.index : sourceText.length;
    const updatedBlock = this.insertReadingNoteLinkIntoSegmentBlock(
      sourceText.slice(blockStart, blockEnd),
      normalizedSegmentId
    );
    return `${sourceText.slice(0, blockStart)}${updatedBlock}${sourceText.slice(blockEnd)}`;
  }

  insertReadingNoteLinkIntoSegmentBlock(block, segmentId) {
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    const lines = String(block || "").replace(/\r\n/g, "\n").split("\n");
    const keptLines = lines.filter((line) => !this.isReadingNoteLinkLineForSegment(line, normalizedSegmentId));
    return this.formatSegmentBlockSections([
      keptLines,
      [this.readingNoteWikiLinkForSegment(normalizedSegmentId)],
    ]);
  }

  isReadingNoteLinkLineForSegment(line, segmentId) {
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    const pattern = new RegExp(
      `^\\s*\\[\\[\\s*notes/${this.escapeRegExp(normalizedSegmentId)}(?:\\.md)?(?:#[^\\]|]+)?(?:\\|[^\\]]*)?\\]\\]\\s*$`,
      "i"
    );
    return pattern.test(String(line || ""));
  }

  formatSegmentBlockSections(sections) {
    const normalizedSections = sections
      .map((lines) => this.trimBlankLines(lines))
      .filter((lines) => lines.some((line) => line.trim()));
    return `\n\n${normalizedSections.map((lines) => lines.join("\n")).join("\n\n")}\n\n`;
  }

  trimBlankLines(lines) {
    let start = 0;
    let end = lines.length;
    while (start < end && !String(lines[start] || "").trim()) {
      start += 1;
    }
    while (end > start && !String(lines[end - 1] || "").trim()) {
      end -= 1;
    }
    return lines.slice(start, end);
  }

  async createOrUpdateReadingNoteFile(notePath, segmentId, sourcePath = "") {
    await this.ensureFolder(notePath.split("/").slice(0, -1).join("/"));
    const existing = this.app.vault.getAbstractFileByPath(notePath);
    if (existing instanceof TFile) {
      await this.ensureReadingNoteSegmentFrontmatter(existing, segmentId);
      return existing;
    }
    return this.app.vault.create(notePath, this.buildReadingNoteContent(segmentId, sourcePath));
  }

  async ensureReadingNoteSegmentFrontmatter(noteFile, segmentId) {
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    await this.app.fileManager.processFrontMatter(noteFile, (frontmatter) => {
      if (!frontmatter.title) {
        frontmatter.title = `${normalizedSegmentId} 阅读笔记`;
      }

      const currentSegments = Array.isArray(frontmatter.segments)
        ? frontmatter.segments.map((value) => String(value))
        : frontmatter.segments
          ? [String(frontmatter.segments)]
          : [];
      if (!currentSegments.some((value) => value.toLowerCase() === normalizedSegmentId)) {
        currentSegments.push(normalizedSegmentId);
      }
      frontmatter.segments = currentSegments;
    });
  }

  buildReadingNoteContent(segmentId, sourcePath = "") {
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    return [
      "---",
      `title: ${normalizedSegmentId} 阅读笔记`,
      "segments:",
      `  - ${normalizedSegmentId}`,
      "---",
      "",
      `# ${normalizedSegmentId} 阅读笔记`,
      "",
      this.translationWikiLinkForSegment(sourcePath, normalizedSegmentId),
      "",
    ].join("\n");
  }

  translationWikiLinkForSegment(sourcePath, segmentId) {
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    const normalizedPath = normalizePath(sourcePath || "");
    const label = `「${normalizedSegmentId}」译文`;
    if (!normalizedPath || !SEGMENT_ID_LINK_RE.test(normalizedSegmentId)) {
      return `[[${normalizedSegmentId}|${label}]]`;
    }
    return `[[${normalizedPath}#${normalizedSegmentId}|${label}]]`;
  }

  escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async syncConfiguredRepositories({ notify = false } = {}) {
    return this.withGitSyncLock(() => this.syncConfiguredRepositoriesUnlocked({ notify }));
  }

  async syncConfiguredRepositoriesUnlocked({ notify = false } = {}) {
    this.invalidateComparisonCaches();
    if (!this.settings.repositoryUrl?.trim()) {
      throw new Error("尚未配置 Lacan-Chinese-Translation-Project 仓库地址。");
    }

    await this.ensureGitRepositoryInitialized({ notify });

    if (this.settings.mode === "reader") {
      await this.syncReaderRepository({ ensureRepository: false });
    } else {
      await this.syncEditorRepository({ ensureRepository: false });
    }

    for (const fork of this.settings.forks) {
      await this.syncForkRepository(fork, {
        refreshComparison: false,
        ensureRepository: false,
        skipLock: true,
      });
    }

    this.refreshComparisonAfterRepositorySync({ showLoading: notify });

    if (notify) {
      new Notice("Git 同步完成。");
    }
  }

  async withGitSyncLock(action) {
    if (this.syncInProgress) {
      throw new Error("已有 Git 同步正在进行，请等待完成后再试。");
    }

    this.syncInProgress = true;
    try {
      return await action();
    } finally {
      this.syncInProgress = false;
    }
  }

  async syncReaderRepository({ ensureRepository = true } = {}) {
    const url = this.settings.repositoryUrl?.trim();
    const branch = this.settings.repositoryBranch?.trim() || "main";
    if (!url) {
      throw new Error("尚未配置 Lacan-Chinese-Translation-Project 仓库地址。");
    }
    if (ensureRepository) {
      await this.ensureGitRepositoryInitialized();
    }

    await this.resetReaderRepositoryToRemote(url, branch);
  }

  async syncEditorRepository({ ensureRepository = true } = {}) {
    const url = this.settings.repositoryUrl?.trim();
    const branch = this.settings.repositoryBranch?.trim() || "main";
    const localBranch = this.settings.upstreamLocalBranch?.trim() || "lacan-upstream/main";
    if (!url) {
      throw new Error("尚未配置 Lacan-Chinese-Translation-Project 仓库地址。");
    }
    if (ensureRepository) {
      await this.ensureGitRepositoryInitialized();
    }

    await this.fetchRepositoryToLocalBranch(url, branch, localBranch);
  }

  async syncForkRepository(
    fork,
    { refreshComparison = true, ensureRepository = true, skipLock = false } = {}
  ) {
    if (!skipLock) {
      return this.withGitSyncLock(() =>
        this.syncForkRepository(fork, {
          refreshComparison,
          ensureRepository,
          skipLock: true,
        })
      );
    }

    if (!fork?.enabled) {
      return;
    }
    const url = fork.url?.trim();
    const branch = fork.remoteBranch?.trim() || "main";
    const localBranch = fork.localBranch?.trim();
    if (!url || !localBranch) {
      throw new Error(`fork 配置不完整：${fork.name || url || "未命名 fork"}`);
    }
    if (ensureRepository) {
      await this.ensureGitRepositoryInitialized({ notify: refreshComparison });
    }

    await this.fetchRepositoryToLocalBranch(url, branch, localBranch);
    if (refreshComparison) {
      this.refreshComparisonAfterRepositorySync({ showLoading: true });
    }
  }

  async fetchRepositoryToLocalBranch(url, remoteBranch, localBranch) {
    await this.execGit(["check-ref-format", "--branch", localBranch]);
    const currentBranch = (await this.execGit(["branch", "--show-current"])).trim();
    if (currentBranch && currentBranch === localBranch) {
      throw new Error(`当前分支是 ${localBranch}，为避免覆盖当前分支，已取消同步。`);
    }

    await this.execGit(["fetch", "--no-tags", url, `+${remoteBranch}:refs/heads/${localBranch}`], {
      useGithubProxy: true,
      remoteUrl: url,
    });
  }

  async execGit(args, { useGithubProxy = false, remoteUrl = "" } = {}) {
    const cwd = this.getVaultBasePath();
    const childProcess = require("child_process");
    const gitArgs = this.withGitHubProxy(args, useGithubProxy, remoteUrl);

    return new Promise((resolve, reject) => {
      const child = childProcess.execFile("git", gitArgs, {
        cwd,
        maxBuffer: GIT_MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
      }, (error, stdout, stderr) => {
        this.gitProcesses.delete(child);
        if (error) {
          const timedOut = error.killed && error.signal === "SIGTERM";
          const detail = String(stderr || stdout || error.message).trim();
          if (timedOut) {
            reject(new Error(detail || "Git 命令执行超时，已自动停止。"));
            return;
          }
          reject(new Error(detail || error.message));
          return;
        }
        resolve(String(stdout || ""));
      });
      this.gitProcesses.add(child);
      child.once("exit", () => {
        this.gitProcesses.delete(child);
      });
    });
  }

  async resetReaderRepositoryToRemote(url, branch) {
    await this.execGit(["check-ref-format", "--branch", branch]);
    await this.execGit(["fetch", "--no-tags", url, branch], {
      useGithubProxy: true,
      remoteUrl: url,
    });
    const status = await this.gitStatusPorcelain();
    if (!this.confirmReaderOverwrite(status)) {
      throw new Error("已取消 Reader 同步，当前项目未被覆盖。");
    }

    await this.discardReaderWorkTree();
    await this.execGit(["checkout", "-B", branch, "FETCH_HEAD"]);
    await this.execGit(["reset", "--hard", "FETCH_HEAD"]);
    await this.execGit(["clean", "-fd"]);
  }

  async discardReaderWorkTree() {
    if (await this.gitHasHead()) {
      await this.execGit(["reset", "--hard"]);
    }

    await this.execGit(["clean", "-fd"]);
  }

  async gitStatusPorcelain() {
    return this.execGit(["status", "--porcelain=v1", "--untracked-files=all"]);
  }

  confirmReaderOverwrite(status) {
    const changedCount = status
      .split(/\r?\n/)
      .filter((line) => line.trim()).length;
    return window.confirm(
      [
        `Reader 模式会用主仓库内容覆盖当前本地文件。`,
        changedCount > 0
          ? `检测到 ${changedCount} 个本地改动或未跟踪文件。`
          : `当前没有检测到本地改动，但同步仍会把项目直接对齐到远端。`,
        `确认后会丢弃本地改动，并删除未被 Git 跟踪的非忽略文件。`,
        `如需保留本地编辑内容，请取消同步并切换到 Editer 模式或先手动备份。`,
        `是否继续？`,
      ].join("\n")
    );
  }

  async gitHasHead() {
    try {
      await this.execGit(["rev-parse", "--verify", "HEAD"]);
      return true;
    } catch (_error) {
      return false;
    }
  }

  confirmReaderAutoSyncRun() {
    return window.confirm(
      [
        `Reader 模式的启动自动同步会在打开 Obsidian 后更新当前项目。`,
        `同步开始后仍会显示覆盖确认框；确认后本地项目会直接对齐到主仓库。`,
        `如需保留本地编辑内容，请取消本次自动同步，并在设置中关闭自动同步或切换到 Editer 模式。`,
        `是否继续本次自动同步？`,
      ].join("\n")
    );
  }

  confirmReaderAutoSyncEnable() {
    return window.confirm(
      [
        `Reader 模式下，启动时自动同步默认应保持关闭。`,
        `开启后，Obsidian 启动时会尝试同步主仓库，并可能覆盖当前项目。`,
        `如果你会在本地编辑译文，请使用 Editer 模式或保持自动同步关闭。`,
        `是否仍要开启 Reader 自动同步？`,
      ].join("\n")
    );
  }

  async ensureGitRepositoryInitialized({ notify = false } = {}) {
    if (this.hasGitRepositoryMetadata()) {
      return false;
    }

    await this.execGit(["init"]);
    if (notify) {
      new Notice("当前项目未初始化 Git，已自动执行 git init。");
    }
    return true;
  }

  hasGitRepositoryMetadata() {
    const fs = require("fs");
    const path = require("path");
    return fs.existsSync(path.join(this.getVaultBasePath(), ".git"));
  }

  invalidateComparisonCaches() {
    this.comparisonContentCache.clear();
    this.comparisonSegmentIndexCache.clear();
    this.comparisonCacheRevision += 1;
    this.bumpComparisonRenderRevision();
  }

  bumpComparisonRenderRevision() {
    this.comparisonRenderRevision += 1;
  }

  refreshComparisonAfterRepositorySync({ showLoading = false } = {}) {
    this.invalidateComparisonCaches();
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || !this.isTextMarkdownPath(file.path)) {
      return;
    }

    this.renderComparisonToolbar({
      renderSegments: true,
      showLoading,
      forcePreviewRerender: false,
    });
  }

  withGitHubProxy(args, useGithubProxy, remoteUrl) {
    const proxyUrl = this.settings.githubProxyUrl?.trim() || DEFAULT_GITHUB_PROXY_URL;
    if (
      !useGithubProxy ||
      !this.settings.githubProxyEnabled ||
      !proxyUrl ||
      !this.isGitHubRepositoryUrl(remoteUrl)
    ) {
      return args;
    }
    return ["-c", `http.proxy=${proxyUrl}`, "-c", `https.proxy=${proxyUrl}`, ...args];
  }

  isGitHubRepositoryUrl(url) {
    const normalized = String(url || "").trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return (
      /^(?:https?:\/\/|git:\/\/)github\.com[:/]/.test(normalized) ||
      /^ssh:\/\/(?:[^@]+@)?github\.com[:/]/.test(normalized) ||
      /^[^@\s]+@github\.com[:/]/.test(normalized) ||
      /^github\.com[:/]/.test(normalized)
    );
  }

  getVaultBasePath() {
    const adapter = this.app.vault.adapter;
    if (typeof adapter.getBasePath === "function") {
      return adapter.getBasePath();
    }
    throw new Error("Git 功能需要 Obsidian 桌面端本地 vault。");
  }

  scheduleComparisonRender(delay = 220) {
    if (this.compareRenderTimer) {
      window.clearTimeout(this.compareRenderTimer);
    }
    this.compareRenderTimer = window.setTimeout(() => {
      this.compareRenderTimer = null;
      this.renderComparisonToolbar();
    }, delay);
  }

  renderComparisonToolbar({ renderSegments = true, showLoading = false, forcePreviewRerender = false } = {}) {
    const file = this.app.workspace.getActiveFile();
    if (
      !(file instanceof TFile)
      || !this.isTextMarkdownPath(file.path)
    ) {
      this.removeComparisonToolbars();
      return;
    }

    const view = Obsidian.MarkdownView
      ? this.app.workspace.getActiveViewOfType(Obsidian.MarkdownView)
      : this.app.workspace.activeLeaf?.view;
    if (!view?.containerEl) {
      return;
    }

    const contentEl = view.containerEl.querySelector(".view-content");
    const toolbarMount = this.resolveComparisonToolbarMount(view);
    if (!contentEl || !toolbarMount) {
      return;
    }

    const forks = this.settings.forks.filter((fork) => fork.enabled && fork.localBranch);
    const toolbarSignature = this.comparisonToolbarSignature(file.path, forks);
    let toolbarEl = view.containerEl.querySelector(".lacan-compare-toolbar");
    if (!toolbarEl) {
      toolbarEl = document.createElement("div");
      toolbarEl.className = "lacan-compare-toolbar";
    }
    toolbarEl.classList.toggle("is-view-header", toolbarMount.location === "header");
    toolbarEl.classList.toggle("is-content-fallback", toolbarMount.location === "content");
    toolbarMount.hostEl.insertBefore(toolbarEl, toolbarMount.beforeEl);

    if (toolbarEl.dataset.toolbarSignature !== toolbarSignature) {
      this.renderComparisonToolbarContent(toolbarEl, forks);
      toolbarEl.dataset.toolbarSignature = toolbarSignature;
    }

    if (renderSegments && this.canRenderComparisonSegments(contentEl, view)) {
      this.renderInlineComparisonControlsForActiveView({ showLoading, forcePreviewRerender })
        .catch((error) => this.handleComparisonRenderError(error));
    }
  }

  resolveComparisonToolbarMount(view) {
    const viewHeaderEl = view?.containerEl?.querySelector?.(".view-header");
    if (viewHeaderEl) {
      const viewActionsEl = viewHeaderEl.querySelector?.(":scope > .view-actions")
        || viewHeaderEl.querySelector?.(".view-actions")
        || null;
      return {
        hostEl: viewHeaderEl,
        beforeEl: viewActionsEl,
        location: "header",
      };
    }

    const contentEl = view?.containerEl?.querySelector?.(".view-content");
    if (!contentEl) {
      return null;
    }
    return {
      hostEl: contentEl,
      beforeEl: contentEl.firstChild || null,
      location: "content",
    };
  }

  comparisonToolbarSignature(path, forks) {
    const forkSignature = forks
      .map((fork) => [
        fork.id,
        fork.name || "",
        fork.localBranch || "",
        this.activeComparisonForks.has(fork.id) ? "1" : "0",
      ].join(":"))
      .join("|");
    return `${normalizePath(path || "")}::${forkSignature}`;
  }

  renderComparisonToolbarContent(toolbarEl, forks) {
    toolbarEl.empty();
    const titleEl = toolbarEl.createSpan({
      cls: "lacan-compare-toolbar-title",
      text: "Fork 对照版本",
    });
    titleEl.setAttribute("aria-label", "选择要参与分段对照的 fork 版本");

    if (forks.length === 0) {
      toolbarEl.createSpan({
        cls: "lacan-compare-empty",
        text: "未配置可对照 fork",
      });
      return;
    }

    for (const fork of forks) {
      const active = this.activeComparisonForks.has(fork.id);
      const label = fork.name || fork.localBranch;
      const button = toolbarEl.createEl("button", {
        cls: active ? "lacan-compare-button is-active" : "lacan-compare-button",
        text: active ? `已选 ${label}` : `选择 ${label}`,
      });
      button.addEventListener("click", async () => {
        if (active) {
          this.activeComparisonForks.delete(fork.id);
        } else {
          this.activeComparisonForks.add(fork.id);
        }
        this.bumpComparisonRenderRevision();
        this.renderComparisonToolbar({
          renderSegments: true,
          showLoading: true,
          forcePreviewRerender: false,
        });
      });
    }
  }

  removeComparisonToolbars() {
    this.disconnectComparisonPreviewWatchers();
    const rootEl = this.app.workspace?.containerEl || document.body;
    this.removeComparisonControls(rootEl);
    rootEl.querySelectorAll(".lacan-compare-toolbar").forEach((element) => element.remove());
    rootEl.querySelectorAll(".lacan-compare-loading").forEach((element) => element.remove());
  }

  removeComparisonControls(rootEl) {
    rootEl.querySelectorAll?.(".lacan-segment-compare-control").forEach((element) => {
      this.unloadMarkdownRenderComponents(element);
      element.remove();
    });
  }

  handleComparisonRenderError(error) {
    console.warn("Lacan Translation Helper: comparison render failed.", error);
  }

  async renderInlineComparisonControlsForActiveView({
    showLoading = false,
    forcePreviewRerender = false,
  } = {}) {
    const renderToken = ++this.compareRenderToken;
    const view = Obsidian.MarkdownView
      ? this.app.workspace.getActiveViewOfType(Obsidian.MarkdownView)
      : this.app.workspace.activeLeaf?.view;
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || !view?.containerEl) {
      return;
    }

    const contentEl = view.containerEl.querySelector(".view-content");
    if (forcePreviewRerender) {
      await this.rerenderPreview(view);
    }

    const renderedEl = view.containerEl.querySelector(".markdown-preview-view");
    if (!renderedEl) {
      this.disconnectComparisonPreviewWatchers();
      return;
    }

    if (this.hasActiveComparisonForks()) {
      this.installComparisonPreviewWatchers(view, renderedEl, file.path);
    } else {
      this.disconnectComparisonPreviewWatchers();
    }

    const activeForks = this.getActiveComparisonForks();
    const state = this.getComparisonRenderState(renderedEl);
    const fullRenderSignature = this.comparisonFullRenderSignature(file.path, activeForks);
    const hasControls = Boolean(renderedEl.querySelector(".lacan-segment-compare-control"));
    if (!forcePreviewRerender && state.fullRenderSignature === fullRenderSignature) {
      return;
    }
    if (activeForks.length === 0 && !hasControls) {
      state.fullRenderSignature = fullRenderSignature;
      return;
    }

    const loadingTimer = showLoading && contentEl
      ? window.setTimeout(() => {
          if (renderToken === this.compareRenderToken) {
            this.setComparisonLoading(contentEl, true);
          }
        }, 120)
      : null;

    if (loadingTimer) {
      this.compareLoadingTimer = loadingTimer;
    }

    try {
      await this.renderInlineComparisonControls(renderedEl, file.path, {
        allowSourceFallback: true,
      });
      state.fullRenderSignature = fullRenderSignature;
    } finally {
      if (loadingTimer) {
        window.clearTimeout(loadingTimer);
        if (this.compareLoadingTimer === loadingTimer) {
          this.compareLoadingTimer = null;
        }
      }
      if (contentEl && renderToken === this.compareRenderToken) {
        this.setComparisonLoading(contentEl, false);
      }
    }
  }

  getComparisonRenderState(element) {
    let state = this.comparisonRenderStates.get(element);
    if (!state) {
      state = {};
      this.comparisonRenderStates.set(element, state);
    }
    return state;
  }

  comparisonFullRenderSignature(path, activeForks = this.getActiveComparisonForks()) {
    return [
      normalizePath(path || ""),
      this.comparisonForkSignature(activeForks),
      this.comparisonRenderRevision,
    ].join("::");
  }

  async rerenderPreview(view) {
    const rerender = view?.previewMode?.rerender;
    if (typeof rerender !== "function") {
      return;
    }

    try {
      await rerender.call(view.previewMode, true);
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    } catch (error) {
      console.warn("Lacan Translation Helper: preview rerender failed.", error);
    }
  }

  setComparisonLoading(contentEl, visible) {
    let loadingEl = contentEl.querySelector(":scope > .lacan-compare-loading");
    if (!visible) {
      loadingEl?.remove();
      return;
    }

    if (!loadingEl) {
      loadingEl = document.createElement("div");
      loadingEl.className = "lacan-compare-loading";
      const toolbarEl = contentEl.querySelector(":scope > .lacan-compare-toolbar");
      if (toolbarEl) {
        contentEl.insertBefore(loadingEl, toolbarEl.nextSibling);
      } else {
        contentEl.prepend(loadingEl);
      }
    }

    loadingEl.empty();
    loadingEl.createSpan({ cls: "lacan-compare-loading-spinner" });
    loadingEl.createSpan({ text: "正在渲染分段对照..." });
  }

  hasActiveComparisonForks() {
    return this.settings.forks.some((fork) =>
      fork.enabled && fork.localBranch && this.activeComparisonForks.has(fork.id)
    );
  }

  getActiveComparisonForks() {
    return this.settings.forks.filter((fork) =>
      fork.enabled && fork.localBranch && this.activeComparisonForks.has(fork.id)
    );
  }

  comparisonForkSignature(activeForks = this.getActiveComparisonForks()) {
    const forks = activeForks.map((fork) => `${fork.id}:${fork.localBranch}`).join("|");
    return `${this.comparisonCacheRevision}:${forks}`;
  }

  shouldRenderComparisonSegments(contentEl) {
    return (
      this.hasActiveComparisonForks() ||
      Boolean(contentEl?.querySelector?.(".lacan-segment-compare-control"))
    );
  }

  canRenderComparisonSegments(contentEl, view) {
    return this.shouldRenderComparisonSegments(contentEl) && !this.isDocumentSearchActive(view?.containerEl);
  }

  isTextMarkdownPath(path) {
    const normalized = normalizePath(path || "");
    return normalized.startsWith("texts/") && normalized.endsWith(".md");
  }

  isReadingNotePath(path) {
    return READING_NOTE_PATH_RE.test(normalizePath(path || ""));
  }

  hasSegmentIdComment(text) {
    return SEGMENT_ID_COMMENT_TEST_RE.test(String(text || ""));
  }

  installComparisonPreviewWatchers(view, previewEl, path) {
    if (
      this.comparisonObservedPreviewEl === previewEl &&
      this.comparisonObservedPath === path
    ) {
      return;
    }

    this.disconnectComparisonPreviewWatchers();
    this.comparisonObservedPreviewEl = previewEl;
    this.comparisonObservedPath = path;

    this.comparisonPreviewObserver = new MutationObserver((mutations) => {
      if (!this.hasActiveComparisonForks() || this.isDocumentSearchActive(view.containerEl)) {
        return;
      }
      const hasContentChange = this.hasMeaningfulPreviewMutation(mutations);
      if (hasContentChange) {
        this.invalidateComparisonRenderState(previewEl);
        this.schedulePreviewComparisonRender(path, 500);
      }
    });
    this.comparisonPreviewObserver.observe(previewEl, {
      childList: true,
      subtree: true,
    });
  }

  disconnectComparisonPreviewWatchers() {
    if (this.comparisonPreviewObserver) {
      this.comparisonPreviewObserver.disconnect();
      this.comparisonPreviewObserver = null;
    }
    if (this.comparisonPreviewRenderTimer) {
      window.clearTimeout(this.comparisonPreviewRenderTimer);
      this.comparisonPreviewRenderTimer = null;
    }
    this.comparisonObservedPreviewEl = null;
    this.comparisonObservedPath = "";
  }

  schedulePreviewComparisonRender(path, delay = 220) {
    if (this.comparisonPreviewRenderTimer) {
      window.clearTimeout(this.comparisonPreviewRenderTimer);
    }
    this.comparisonPreviewRenderTimer = window.setTimeout(() => {
      this.comparisonPreviewRenderTimer = null;
      const view = Obsidian.MarkdownView
        ? this.app.workspace.getActiveViewOfType(Obsidian.MarkdownView)
        : this.app.workspace.activeLeaf?.view;
      const file = this.app.workspace.getActiveFile();
      if (!(file instanceof TFile) || normalizePath(file.path) !== normalizePath(path)) {
        return;
      }
      const renderedEl = view?.containerEl?.querySelector(".markdown-preview-view");
      if (renderedEl && this.hasActiveComparisonForks() && !this.isDocumentSearchActive(view?.containerEl)) {
        this.renderInlineComparisonControls(renderedEl, path, {
          allowSourceFallback: false,
        }).catch((error) => this.handleComparisonRenderError(error));
      }
    }, delay);
  }

  invalidateComparisonRenderState(element) {
    const state = element ? this.comparisonRenderStates.get(element) : null;
    if (state) {
      state.fullRenderSignature = "";
    }
  }

  isComparisonUiNode(node) {
    if (!(node instanceof Element)) {
      return false;
    }
    return Boolean(
      node.closest?.(".lacan-segment-compare-control, .lacan-compare-toolbar, .lacan-compare-loading") ||
      node.matches?.(".lacan-segment-compare-control, .lacan-compare-toolbar, .lacan-compare-loading")
    );
  }

  hasMeaningfulPreviewMutation(mutations) {
    return mutations.some((mutation) =>
      [...mutation.addedNodes, ...mutation.removedNodes].some((node) => this.isMeaningfulPreviewNode(node))
    );
  }

  isMeaningfulPreviewNode(node) {
    return (
      node instanceof Element &&
      !this.isComparisonUiNode(node) &&
      !this.isObsidianTransientNode(node)
    );
  }

  isObsidianTransientNode(node) {
    if (!(node instanceof Element)) {
      return false;
    }

    const selector = [
      ".search-highlight",
      ".obsidian-search-match-highlight",
      ".cm-searchMatch",
      ".cm-searchMatch-selected",
      ".cm-selectionMatch",
      ".document-search-container",
      ".document-search",
      ".is-flashing",
      ".is-highlighted",
      ".mod-search-highlight",
      ".mod-highlighted",
    ].join(", ");
    if (node.matches?.(selector) || node.closest?.(selector)) {
      return true;
    }

    const className = typeof node.className === "string" ? node.className : "";
    return /(?:search|find|highlight|flashing|selectionMatch)/i.test(className);
  }

  isDocumentSearchActive(rootEl) {
    const searchEl = rootEl?.querySelector?.(".document-search-container, .document-search");
    if (!searchEl) {
      return false;
    }
    if (searchEl.matches?.(".is-hidden, .mod-hidden")) {
      return false;
    }
    return Boolean(searchEl.offsetParent || searchEl.getClientRects?.().length);
  }

  async renderInlineComparisonControls(
    containerEl,
    sourcePath,
    { allowSourceFallback = true, sectionInfo = null } = {}
  ) {
    const path = normalizePath(sourcePath || "");
    if (containerEl.closest?.(".cm-editor, .markdown-source-view")) {
      return;
    }

    if (!this.isTextMarkdownPath(path)) {
      return;
    }

    const activeForks = this.getActiveComparisonForks();
    if (activeForks.length === 0) {
      this.removeComparisonControls(containerEl);
      return;
    }
    const forkSignature = this.comparisonForkSignature(activeForks);
    const existingControls = this.getExistingComparisonControls(containerEl);

    const sectionInsertedCount = this.renderSectionAnchoredComparisonControls(
      containerEl,
      path,
      sectionInfo,
      activeForks,
      forkSignature,
      existingControls
    );
    if (sectionInsertedCount > 0) {
      return;
    }

    const insertedCount = this.renderCommentAnchoredComparisonControls(
      containerEl,
      path,
      activeForks,
      forkSignature,
      existingControls
    );
    if (insertedCount > 0 || !allowSourceFallback) {
      return;
    }

    await this.renderSourceAnchoredComparisonControls(
      containerEl,
      path,
      activeForks,
      forkSignature,
      existingControls
    );
  }

  getExistingComparisonControls(containerEl) {
    const controls = new Map();
    containerEl.querySelectorAll?.(".lacan-segment-compare-control[data-segment-id]").forEach((element) => {
      if (!controls.has(element.dataset.segmentId)) {
        controls.set(element.dataset.segmentId, element);
      }
    });
    return controls;
  }

  renderSectionAnchoredComparisonControls(
    containerEl,
    path,
    sectionInfo,
    activeForks,
    forkSignature,
    existingControls
  ) {
    const sectionText = sectionInfo?.text || "";
    const markers = this.extractSegmentMarkers(sectionText);
    if (markers.length === 0) {
      return 0;
    }

    const lineOffset = this.sectionLineOffset(sectionInfo);
    for (const marker of markers) {
      marker.line += lineOffset;
      marker.nextLine = marker.nextLine === null ? null : marker.nextLine + lineOffset;
    }

    if (markers.length === 1) {
      const segmentId = markers[0].id;
      const existing = existingControls.get(segmentId);
      if (existing) {
        this.renderSegmentComparisonControlIfNeeded(existing, path, segmentId, activeForks, forkSignature);
        return 1;
      }
      const controlEl = document.createElement("div");
      controlEl.className = "lacan-segment-compare-control";
      controlEl.dataset.segmentId = segmentId;
      containerEl.prepend(controlEl);
      existingControls.set(segmentId, controlEl);
      this.renderSegmentComparisonControl(controlEl, path, segmentId, activeForks, forkSignature);
      return 1;
    }

    let insertedCount = 0;
    const usedAnchors = new Set();
    const anchorIndex = this.buildRenderedAnchorIndex(containerEl);
    for (const marker of markers) {
      const existing = existingControls.get(marker.id);
      if (existing) {
        this.renderSegmentComparisonControlIfNeeded(existing, path, marker.id, activeForks, forkSignature);
        insertedCount += 1;
        continue;
      }
      const anchorEl = this.findRenderedSegmentAnchor(containerEl, marker, usedAnchors, anchorIndex);
      if (!anchorEl?.parentNode) {
        continue;
      }
      const controlEl = document.createElement("div");
      controlEl.className = "lacan-segment-compare-control";
      controlEl.dataset.segmentId = marker.id;
      anchorEl.parentNode.insertBefore(controlEl, anchorEl);
      usedAnchors.add(anchorEl);
      existingControls.set(marker.id, controlEl);
      this.renderSegmentComparisonControl(controlEl, path, marker.id, activeForks, forkSignature);
      insertedCount += 1;
    }

    return insertedCount;
  }

  renderCommentAnchoredComparisonControls(containerEl, path, activeForks, forkSignature, existingControls) {
    const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_COMMENT);
    const commentNodes = [];
    let node;
    while ((node = walker.nextNode()) !== null) {
      const segmentId = this.segmentIdFromComment(node.nodeValue);
      if (segmentId) {
        commentNodes.push({ node, segmentId });
      }
    }

    let insertedCount = 0;
    for (const { node: commentNode, segmentId } of commentNodes) {
      const existing = existingControls.get(segmentId);
      if (existing) {
        this.renderSegmentComparisonControlIfNeeded(existing, path, segmentId, activeForks, forkSignature);
        insertedCount += 1;
        continue;
      }
      const parent = commentNode.parentNode;
      if (!parent) {
        continue;
      }
      const controlEl = document.createElement("div");
      controlEl.className = "lacan-segment-compare-control";
      controlEl.dataset.segmentId = segmentId;
      parent.insertBefore(controlEl, commentNode.nextSibling);
      existingControls.set(segmentId, controlEl);
      this.renderSegmentComparisonControl(controlEl, path, segmentId, activeForks, forkSignature);
      insertedCount += 1;
    }

    return insertedCount;
  }

  async renderSourceAnchoredComparisonControls(containerEl, path, activeForks, forkSignature, existingControls) {
    if (!containerEl.isConnected) {
      return;
    }

    const markers = await this.getComparisonSegmentMarkers(path);
    if (markers.length === 0) {
      return;
    }

    const usedAnchors = new Set();
    const anchorIndex = this.buildRenderedAnchorIndex(containerEl);
    for (let index = 0; index < markers.length; index += 1) {
      const marker = markers[index];
      const existing = existingControls.get(marker.id);
      if (existing) {
        this.renderSegmentComparisonControlIfNeeded(existing, path, marker.id, activeForks, forkSignature);
        continue;
      }
      const anchorEl = this.findRenderedSegmentAnchor(containerEl, marker, usedAnchors, anchorIndex);
      if (!anchorEl?.parentNode) {
        continue;
      }
      const controlEl = document.createElement("div");
      controlEl.className = "lacan-segment-compare-control";
      controlEl.dataset.segmentId = marker.id;
      anchorEl.parentNode.insertBefore(controlEl, anchorEl);
      usedAnchors.add(anchorEl);
      existingControls.set(marker.id, controlEl);
      this.renderSegmentComparisonControl(controlEl, path, marker.id, activeForks, forkSignature);
    }
  }

  async getComparisonSegmentMarkers(path) {
    const normalizedPath = normalizePath(path || "");
    if (!this.comparisonSegmentIndexCache.has(normalizedPath)) {
      const file = this.app.vault.getAbstractFileByPath(normalizedPath);
      const promise = file instanceof TFile
        ? this.app.vault.cachedRead(file).then((text) => this.extractSegmentMarkers(text))
        : Promise.resolve([]);
      this.comparisonSegmentIndexCache.set(normalizedPath, promise);
    }
    return this.comparisonSegmentIndexCache.get(normalizedPath);
  }

  async loadForkFileContent(branch, path) {
    return this.execGit(["show", `${branch}:${path}`]);
  }

  renderSegmentComparisonControlIfNeeded(controlEl, path, segmentId, activeForks, forkSignature) {
    if (controlEl.dataset.forkSignature === forkSignature) {
      return;
    }
    this.renderSegmentComparisonControl(controlEl, path, segmentId, activeForks, forkSignature);
  }

  renderSegmentComparisonControl(
    controlEl,
    path,
    segmentId,
    activeForks = this.getActiveComparisonForks(),
    forkSignature = this.comparisonForkSignature(activeForks)
  ) {
    const stateKey = this.segmentComparisonKey(path, segmentId);
    const expanded = this.expandedComparisonSegments.has(stateKey);

    this.unloadMarkdownRenderComponents(controlEl);
    controlEl.dataset.segmentId = segmentId;
    controlEl.dataset.forkSignature = forkSignature;
    controlEl.empty();
    const button = controlEl.createEl("button", {
      cls: expanded ? "lacan-segment-compare-toggle is-active" : "lacan-segment-compare-toggle",
      text: expanded ? `${segmentId} 收起对照` : `${segmentId} 对照`,
    });
    button.setAttribute("type", "button");
    button.setAttribute("aria-expanded", expanded ? "true" : "false");
    button.setAttribute("aria-label", `${expanded ? "收起" : "展开"} ${segmentId} 的 fork 对照`);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.expandedComparisonSegments.has(stateKey)) {
        this.expandedComparisonSegments.delete(stateKey);
      } else {
        this.expandedComparisonSegments.add(stateKey);
      }
      this.renderSegmentComparisonControl(controlEl, path, segmentId);
    });

    if (!expanded) {
      return;
    }

    const panelEl = controlEl.createDiv("lacan-segment-compare-panel");
    for (const fork of activeForks) {
      const itemEl = panelEl.createDiv("lacan-segment-compare-item");
      itemEl.createDiv({
        cls: "lacan-segment-compare-title",
        text: `${fork.name || fork.localBranch} · ${fork.localBranch}`,
      });
      const contentEl = itemEl.createDiv({
        cls: "lacan-segment-compare-content",
        text: "加载中...",
      });

      this.loadForkSegmentContent(fork, path, segmentId)
        .then((content) => {
          if (!contentEl.isConnected) {
            return null;
          }
          return this.renderForkSegmentContent(contentEl, content, path);
        })
        .catch((error) => {
          if (contentEl.isConnected) {
            contentEl.setText(`无法读取该段对照：${error.message}`);
          }
        });
    }
  }

  async loadForkSegmentContent(fork, path, segmentId) {
    const segments = await this.loadForkSegments(fork.localBranch, path);
    return segments.get(segmentId) || "";
  }

  async loadForkSegments(branch, path) {
    const cacheKey = `${branch}:${path}`;
    if (!this.comparisonContentCache.has(cacheKey)) {
      this.comparisonContentCache.set(
        cacheKey,
        this.loadForkFileContent(branch, path).then((content) => this.extractSegmentsById(content))
      );
    }
    return this.comparisonContentCache.get(cacheKey);
  }

  async renderForkSegmentContent(contentEl, content, sourcePath) {
    this.unloadMarkdownRenderComponent(contentEl);
    contentEl.empty();
    const trimmed = String(content || "").trim();
    if (!trimmed) {
      contentEl.setText("[没有对应分段]");
      return;
    }
    const visibleText = trimmed.replace(/<!--[\s\S]*?-->/g, "").trim();
    if (!visibleText && /<!--\s*untranslated\s*-->/i.test(trimmed)) {
      contentEl.setText("[该段尚未翻译]");
      return;
    }

    if (Obsidian.MarkdownRenderer?.render) {
      const component = new MarkdownRenderComponent();
      component.load();
      contentEl[MARKDOWN_RENDER_COMPONENT_KEY] = component;
      await Obsidian.MarkdownRenderer.render(this.app, trimmed, contentEl, sourcePath, component);
      if (!contentEl.isConnected) {
        this.unloadMarkdownRenderComponent(contentEl);
      }
      return;
    }

    contentEl.createEl("pre", {
      text: trimmed,
    });
  }

  unloadMarkdownRenderComponents(rootEl) {
    if (!rootEl) {
      return;
    }
    this.unloadMarkdownRenderComponent(rootEl);
    rootEl.querySelectorAll?.(".lacan-segment-compare-content, .lacan-segment-preview-content").forEach((element) => {
      this.unloadMarkdownRenderComponent(element);
    });
  }

  unloadMarkdownRenderComponent(element) {
    const component = element?.[MARKDOWN_RENDER_COMPONENT_KEY];
    if (!component) {
      return;
    }
    try {
      component.unload();
    } catch (error) {
      console.warn("Lacan Translation Helper: failed to unload markdown renderer.", error);
    }
    element[MARKDOWN_RENDER_COMPONENT_KEY] = null;
  }

  extractSegmentsById(text) {
    const segments = new Map();
    const matches = [];
    for (const match of this.segmentCommentMatches(text)) {
      matches.push({
        id: match.id,
        ids: match.ids,
        start: match.index,
        end: match.end,
      });
    }

    for (let index = 0; index < matches.length; index += 1) {
      const current = matches[index];
      const next = matches[index + 1];
      const content = text.slice(current.end, next ? next.start : text.length).trim();
      for (const id of current.ids) {
        if (!segments.has(id)) {
          segments.set(id, content);
        }
      }
    }

    return segments;
  }

  extractSegmentMarkers(text) {
    const markers = [];
    let cursor = 0;
    let line = 0;
    for (const match of this.segmentCommentMatches(text)) {
      while (cursor < match.index) {
        if (text.charCodeAt(cursor) === 10) {
          line += 1;
        }
        cursor += 1;
      }
      markers.push({
        id: match.id,
        ids: match.ids,
        idStart: match.index,
        line,
        targetLine: line,
        contentStart: match.end,
        nextLine: null,
        text: "",
        snippet: "",
      });
    }
    for (let index = 0; index < markers.length; index += 1) {
      const current = markers[index];
      const next = markers[index + 1];
      current.nextLine = next ? next.line : null;
      current.text = text.slice(current.contentStart, next ? next.idStart : text.length);
      const visibleLineOffset = this.firstVisibleSegmentLineOffset(current.text);
      if (visibleLineOffset !== null) {
        current.targetLine = this.lineNumberAtOffset(text, current.contentStart) + visibleLineOffset;
      }
      current.snippet = this.firstVisibleSegmentSnippet(current.text);
    }
    return markers;
  }

  sectionLineOffset(sectionInfo) {
    const candidates = [
      sectionInfo?.lineStart,
      sectionInfo?.startLine,
      sectionInfo?.position?.start?.line,
    ];
    const value = candidates.find((candidate) => Number.isFinite(Number(candidate)));
    return value === undefined ? 0 : Number(value);
  }

  firstVisibleSegmentSnippet(text) {
    const withoutComments = String(text || "").replace(/<!--[\s\S]*?-->/g, "\n");
    for (const line of withoutComments.split(/\r?\n/)) {
      if (this.isSegmentHelperLine(line)) {
        continue;
      }
      const normalized = this.normalizeRenderedText(
        line
          .replace(/^\s{0,3}>\s?/, "")
          .replace(/^\s{0,3}#{1,6}\s+/, "")
          .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/, "")
          .replace(/[*_`~[\]()]/g, "")
      );
      if (normalized) {
        return normalized.slice(0, 40);
      }
    }
    return "";
  }

  firstVisibleSegmentLineOffset(text) {
    const lines = String(text || "").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!this.isSegmentHelperLine(lines[index])) {
        return index;
      }
    }
    return null;
  }

  isSegmentHelperLine(line) {
    const value = String(line || "").trim();
    return !value || /^<!--[\s\S]*-->$/.test(value) || this.isReadingNoteLinkLine(value);
  }

  isReadingNoteLinkLine(line) {
    return /^\[\[\s*notes\/[^|\]]+(?:\|[^\]]*)?\]\]$/.test(String(line || "").trim());
  }

  lineNumberAtOffset(text, offset) {
    const sourceText = String(text || "");
    const limit = Math.max(0, Math.min(Number(offset) || 0, sourceText.length));
    let line = 0;
    for (let index = 0; index < limit; index += 1) {
      if (sourceText.charCodeAt(index) === 10) {
        line += 1;
      }
    }
    return line;
  }

  normalizeRenderedText(text) {
    return String(text || "").replace(/\s+/g, "");
  }

  buildRenderedAnchorIndex(containerEl) {
    const lineAnchors = Array.from(containerEl.querySelectorAll("[data-line]"))
      .filter((element) => !element.closest(".lacan-segment-compare-control"))
      .map((element) => ({
        element,
        line: Number(element.getAttribute("data-line")),
      }))
      .filter((item) => Number.isFinite(item.line))
      .sort((a, b) => a.line - b.line);

    const blockAnchors = Array.from(
      containerEl.querySelectorAll("p, blockquote, ul, ol, pre, table, h1, h2, h3, h4, h5, h6")
    )
      .filter((element) => !element.closest(".lacan-segment-compare-control"))
      .map((element) => ({
        element,
        normalizedText: this.normalizeRenderedText(element.textContent),
      }));

    return { lineAnchors, blockAnchors, lineCursor: 0 };
  }

  findRenderedSegmentAnchor(containerEl, marker, usedAnchors, anchorIndex = null) {
    const { lineAnchors, blockAnchors } = anchorIndex || this.buildRenderedAnchorIndex(containerEl);

    const byLine = this.findLineAnchorForMarker(marker, usedAnchors, anchorIndex || { lineAnchors, lineCursor: 0 });
    if (byLine?.element) {
      return byLine.element;
    }

    if (!marker.snippet) {
      return null;
    }

    return (
      blockAnchors.find((item) => {
        if (usedAnchors.has(item.element)) {
          return false;
        }
        return (
          item.normalizedText.includes(marker.snippet) ||
          marker.snippet.includes(item.normalizedText.slice(0, 20))
        );
      })?.element || null
    );
  }

  findLineAnchorForMarker(marker, usedAnchors, anchorIndex) {
    const lineAnchors = anchorIndex?.lineAnchors || [];
    const targetLine = Number.isFinite(Number(marker.targetLine)) ? Number(marker.targetLine) : marker.line;
    let cursor = anchorIndex?.lineCursor || 0;
    while (cursor < lineAnchors.length && lineAnchors[cursor].line < targetLine) {
      cursor += 1;
    }

    for (let index = cursor; index < lineAnchors.length; index += 1) {
      const item = lineAnchors[index];
      if (marker.nextLine !== null && item.line >= marker.nextLine) {
        break;
      }
      if (!usedAnchors.has(item.element)) {
        if (anchorIndex) {
          anchorIndex.lineCursor = index + 1;
        }
        return item;
      }
    }

    if (anchorIndex) {
      anchorIndex.lineCursor = cursor;
    }
    return null;
  }

  segmentIdFromComment(commentText) {
    return this.segmentIdsFromComment(commentText)[0] || "";
  }

  segmentCommentMatches(text) {
    const rawMatches = [];
    SEGMENT_ID_COMMENT_RE.lastIndex = 0;
    let match;
    while ((match = SEGMENT_ID_COMMENT_RE.exec(text)) !== null) {
      const info = this.segmentCommentInfo(match[0]);
      if (info.ids.length === 0) {
        continue;
      }
      rawMatches.push({
        label: info.label,
        id: info.ids[0],
        ids: info.ids,
        index: match.index,
        end: SEGMENT_ID_COMMENT_RE.lastIndex,
      });
    }

    const matches = [];
    for (let index = 0; index < rawMatches.length; index += 1) {
      const current = rawMatches[index];
      if (current.label !== "id") {
        continue;
      }

      const next = rawMatches[index + 1];
      const hasOnlyWhitespaceBetween = (
        Boolean(next)
        && /^\s*$/.test(String(text || "").slice(current.end, next.index))
      );
      const hasAttachedIds = (
        next?.label === "ids"
        && hasOnlyWhitespaceBetween
      );
      const hasAttachedRepeatedPrimaryGroup = (
        next?.label === "id"
        && next.ids.length > 1
        && next.ids[0] === current.ids[0]
        && hasOnlyWhitespaceBetween
      );
      const hasAttachedGroup = hasAttachedIds || hasAttachedRepeatedPrimaryGroup;
      const ids = hasAttachedGroup
        ? this.mergeSegmentIds(current.ids, next.ids)
        : current.ids;
      matches.push({
        id: ids[0],
        ids,
        index: current.index,
        end: hasAttachedGroup ? next.end : current.end,
      });
      if (hasAttachedGroup) {
        index += 1;
      }
    }
    return matches;
  }

  segmentIdsFromComment(commentText) {
    return this.segmentCommentInfo(commentText).ids;
  }

  segmentCommentInfo(commentText) {
    const body = String(commentText || "")
      .replace(/^\s*<!--\s*/, "")
      .replace(/\s*-->\s*$/, "")
      .trim();
    const labelMatch = body.match(/^(ids?)\b\s*:?\s*([\s\S]+)$/i);
    if (!labelMatch) {
      return { label: "", ids: [] };
    }

    const ids = [];
    const seen = new Set();
    SEGMENT_ID_TOKEN_RE.lastIndex = 0;
    let match;
    while ((match = SEGMENT_ID_TOKEN_RE.exec(labelMatch[2])) !== null) {
      const id = match[0].toLowerCase();
      if (!seen.has(id)) {
        ids.push(id);
        seen.add(id);
      }
    }
    return { label: labelMatch[1].toLowerCase(), ids };
  }

  mergeSegmentIds(...groups) {
    const ids = [];
    const seen = new Set();
    for (const group of groups) {
      for (const id of group || []) {
        if (!seen.has(id)) {
          ids.push(id);
          seen.add(id);
        }
      }
    }
    return ids;
  }

  segmentComparisonKey(path, segmentId) {
    return `${path}::${segmentId}`;
  }

  decorateRenderedReadingNoteLinks(rootEl, sourcePath) {
    rootEl.querySelectorAll?.("a.internal-link").forEach((linkEl) => {
      if (String(linkEl.textContent || "").trim() !== "阅读笔记") {
        return;
      }

      const target = (
        linkEl.getAttribute?.("data-href") ||
        linkEl.getAttribute?.("href") ||
        ""
      );
      const linkpath = this.safeDecodeURIComponent(String(target).split("#", 1)[0].trim());
      if (!linkpath || /^[a-z][a-z0-9+.-]*:/i.test(linkpath)) {
        return;
      }

      const noteFile = this.app.metadataCache?.getFirstLinkpathDest?.(linkpath, sourcePath);
      if (!(noteFile instanceof TFile) || !this.isReadingNotePath(noteFile.path)) {
        return;
      }

      linkEl.textContent = this.readingNoteDisplayName(noteFile);
    });
  }

  readingNoteDisplayName(noteFile) {
    return String(noteFile.basename || noteFile.path?.split("/").pop() || "")
      .replace(/\.md$/i, "")
      .trim();
  }

  decorateRenderedSegmentLinks(rootEl) {
    rootEl.querySelectorAll?.(
      'a.lacan-segment-link, a.internal-link[data-href*="#"], a.internal-link[href*="#"]'
    ).forEach((linkEl) => {
      const segmentId = this.segmentIdFromLinkElement(linkEl);
      if (!segmentId) {
        return;
      }

      this.markRenderedSegmentLink(linkEl, segmentId, this.segmentTargetPathFromLinkElement(linkEl));
    });
  }

  markRenderedSegmentLink(linkEl, segmentId, targetPath = "") {
    linkEl.classList.remove("internal-link", "is-unresolved");
    linkEl.classList.add("lacan-segment-link");
    linkEl.dataset.lacanSegmentId = segmentId;
    if (targetPath) {
      linkEl.dataset.lacanSegmentTargetPath = targetPath;
    }
    linkEl.setAttribute("href", "#");
    linkEl.setAttribute("title", `打开「${segmentId}」${this.segmentDocumentLabel(targetPath)}`);
  }

  handleSegmentInternalLinkClick(event) {
    const linkEl = this.segmentLinkElementFromEvent(event);
    if (!linkEl) {
      return;
    }

    const segmentId = this.segmentIdFromLinkElement(linkEl);
    if (!segmentId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.runWithNotice(
      () => this.openSegmentId(segmentId, this.segmentTargetPathFromLinkElement(linkEl)),
      "打开分段失败"
    );
  }

  handleSegmentLinkPreviewEnter(event) {
    const linkEl = this.segmentLinkElementFromEvent(event);
    if (!linkEl) {
      return;
    }
    if (
      event.type === "mouseover" &&
      typeof Node !== "undefined" &&
      event.relatedTarget instanceof Node &&
      linkEl.contains(event.relatedTarget)
    ) {
      return;
    }

    const segmentId = this.segmentIdFromLinkElement(linkEl);
    if (!segmentId) {
      return;
    }

    event.stopPropagation();
    this.scheduleSegmentPreview(
      linkEl,
      segmentId,
      this.segmentTargetPathFromLinkElement(linkEl)
    );
  }

  handleSegmentLinkPreviewLeave(event) {
    const linkEl = this.segmentLinkElementFromEvent(event);
    if (!linkEl) {
      return;
    }
    const segmentId = this.segmentIdFromLinkElement(linkEl);
    if (!segmentId) {
      return;
    }

    const relatedTarget = event.relatedTarget;
    if (
      typeof Node !== "undefined" &&
      relatedTarget instanceof Node &&
      (linkEl.contains(relatedTarget) || this.segmentPreviewEl?.contains?.(relatedTarget))
    ) {
      return;
    }

    event.stopPropagation();
    this.scheduleHideSegmentPreview();
  }

  segmentLinkElementFromEvent(event) {
    const targetEl = event.target instanceof Element ? event.target : null;
    const linkEl = targetEl?.closest?.("a.lacan-segment-link, a.internal-link") || null;
    return this.isPotentialSegmentLinkElement(linkEl) ? linkEl : null;
  }

  isPotentialSegmentLinkElement(linkEl) {
    if (!linkEl) {
      return false;
    }
    if (linkEl.classList?.contains?.("lacan-segment-link")) {
      return true;
    }
    const target = (
      linkEl?.dataset?.lacanSegmentId ||
      linkEl?.getAttribute?.("data-href") ||
      linkEl?.getAttribute?.("href") ||
      ""
    );
    return String(target).includes("#");
  }

  segmentIdFromLinkElement(linkEl) {
    const datasetId = this.segmentIdFromLinkTarget(linkEl?.dataset?.lacanSegmentId || "");
    if (datasetId) {
      return datasetId;
    }

    const target = (
      linkEl?.getAttribute?.("data-href") ||
      linkEl?.getAttribute?.("href") ||
      ""
    );
    const explicitTargetId = this.segmentIdFromExplicitLinkTarget(target);
    if (explicitTargetId) {
      return explicitTargetId;
    }

    return "";
  }

  segmentTargetPathFromLinkElement(linkEl) {
    const datasetTargetPath = String(
      linkEl?.dataset?.lacanSegmentTargetPath || ""
    ).trim();
    if (datasetTargetPath) {
      return normalizePath(datasetTargetPath);
    }

    const target = (
      linkEl?.getAttribute?.("data-href") ||
      linkEl?.getAttribute?.("href") ||
      ""
    );
    return this.segmentTargetPathFromLinkTarget(target);
  }

  segmentTargetPathFromLinkTarget(target) {
    const value = String(target || "").trim();
    if (!value.includes("#")) {
      return "";
    }

    let pathPart = value.split("#")[0].trim();
    if (!pathPart) {
      return "";
    }

    if (/^app:\/\/obsidian\.md\/+/i.test(pathPart)) {
      pathPart = pathPart.replace(/^app:\/\/obsidian\.md\/+/i, "");
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(pathPart)) {
      return "";
    }

    return normalizePath(this.safeDecodeURIComponent(pathPart));
  }

  segmentDocumentLabel(targetPath = "") {
    return normalizePath(targetPath).includes("/original/") ? "原文" : "译文";
  }

  safeDecodeURIComponent(value) {
    try {
      return decodeURIComponent(value);
    } catch (_error) {
      return String(value || "");
    }
  }

  segmentIdFromExplicitLinkTarget(target) {
    const value = String(target || "").trim();
    if (!value.includes("#")) {
      return "";
    }
    return this.segmentIdFromLinkTarget(value);
  }

  segmentIdFromLinkTarget(target) {
    const value = String(target || "")
      .trim()
      .replace(/^#/, "")
      .split("#")
      .pop()
      .trim()
      .toLowerCase();
    return SEGMENT_ID_LINK_RE.test(value) ? value : "";
  }

  scheduleSegmentPreview(linkEl, segmentId, targetPath = "") {
    if (this.segmentPreviewHideTimer) {
      window.clearTimeout(this.segmentPreviewHideTimer);
      this.segmentPreviewHideTimer = null;
    }
    this.showSegmentPreview(linkEl, segmentId, targetPath);
  }

  scheduleHideSegmentPreview(delay = 180) {
    if (this.segmentPreviewHideTimer) {
      window.clearTimeout(this.segmentPreviewHideTimer);
    }
    this.segmentPreviewHideTimer = window.setTimeout(() => {
      this.segmentPreviewHideTimer = null;
      this.hideSegmentPreview();
    }, delay);
  }

  showSegmentPreview(linkEl, segmentId, targetPath = "") {
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    if (!SEGMENT_ID_LINK_RE.test(normalizedSegmentId)) {
      return;
    }
    const documentLabel = this.segmentDocumentLabel(targetPath);

    this.hideSegmentPreview({ keepHideTimer: true });
    const previewEl = document.createElement("div");
    previewEl.className = "lacan-segment-preview-popover";
    previewEl.addEventListener("mouseenter", () => {
      if (this.segmentPreviewHideTimer) {
        window.clearTimeout(this.segmentPreviewHideTimer);
        this.segmentPreviewHideTimer = null;
      }
    });
    previewEl.addEventListener("mouseleave", () => this.scheduleHideSegmentPreview(120));

    const titleEl = previewEl.createDiv
      ? previewEl.createDiv("lacan-segment-preview-title")
      : previewEl.appendChild(document.createElement("div"));
    titleEl.className = "lacan-segment-preview-title";
    titleEl.textContent = `「${normalizedSegmentId}」${documentLabel}`;

    const contentEl = previewEl.createDiv
      ? previewEl.createDiv("lacan-segment-preview-content")
      : previewEl.appendChild(document.createElement("div"));
    contentEl.className = "lacan-segment-preview-content";
    contentEl.textContent = "加载中...";

    document.body.appendChild(previewEl);
    this.positionSegmentPreview(previewEl, linkEl);
    this.segmentPreviewEl = previewEl;
    const token = ++this.segmentPreviewRenderToken;

    this.loadSegmentPreviewContent(normalizedSegmentId, targetPath)
      .then(({ content, sourcePath }) => {
        if (token !== this.segmentPreviewRenderToken || !contentEl.isConnected) {
          return null;
        }
        return this.renderForkSegmentContent(contentEl, content, sourcePath);
      })
      .catch((error) => {
        if (token === this.segmentPreviewRenderToken && contentEl.isConnected) {
          contentEl.textContent = `无法读取对应${documentLabel}段落：${error.message}`;
        }
      });
  }

  positionSegmentPreview(previewEl, anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    const margin = 10;
    const width = Math.min(520, Math.max(320, window.innerWidth - margin * 2));
    previewEl.style.width = `${width}px`;
    let left = Math.min(rect.left, window.innerWidth - width - margin);
    left = Math.max(margin, left);
    const estimatedHeight = Math.min(360, Math.max(160, previewEl.offsetHeight || 220));
    let top = rect.bottom + margin;
    if (top + estimatedHeight > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - estimatedHeight - margin);
    }
    previewEl.style.left = `${left + window.scrollX}px`;
    previewEl.style.top = `${top + window.scrollY}px`;
  }

  hideSegmentPreview({ keepHideTimer = false } = {}) {
    if (!keepHideTimer && this.segmentPreviewHideTimer) {
      window.clearTimeout(this.segmentPreviewHideTimer);
      this.segmentPreviewHideTimer = null;
    }
    if (this.segmentPreviewEl) {
      this.unloadMarkdownRenderComponents(this.segmentPreviewEl);
      this.segmentPreviewEl.remove();
      this.segmentPreviewEl = null;
      this.segmentPreviewRenderToken += 1;
    }
  }

  async loadSegmentPreviewContent(segmentId, targetPath = "") {
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    const match = normalizedSegmentId.match(SEGMENT_ID_LINK_RE);
    if (!match) {
      throw new Error(`不是有效的分段 ID：${segmentId}`);
    }

    const normalizedTargetPath = normalizePath(targetPath || "");
    const cacheKey = this.segmentComparisonKey(
      normalizedTargetPath || "auto",
      normalizedSegmentId
    );
    if (this.segmentPreviewCache.has(cacheKey)) {
      return this.segmentPreviewCache.get(cacheKey);
    }

    let file = this.fileFromSegmentTargetPath(normalizedTargetPath);
    let seminarSlug = "";
    const seminarCode = `s${match[1]}`.toLowerCase();
    const lessonNumber = Number(match[2]);
    if (!(file instanceof TFile)) {
      seminarSlug = this.findSeminarSlugForCode(seminarCode);
      if (!seminarSlug) {
        throw new Error(`找不到对应研讨班：${seminarCode}`);
      }
      file = this.findSegmentLessonFile(seminarSlug, lessonNumber);
    }
    if (!(file instanceof TFile)) {
      throw new Error(`找不到对应课文：${seminarSlug} Leçon ${String(lessonNumber).padStart(2, "0")}`);
    }

    const promise = this.app.vault.cachedRead(file).then((text) => ({
      sourcePath: file.path,
      content: this.segmentPreviewContent(text, normalizedSegmentId),
    }));
    this.segmentPreviewCache.set(cacheKey, promise);
    return promise;
  }

  segmentPreviewContent(text, segmentId) {
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    const content = this.extractSegmentsById(String(text || "")).get(normalizedSegmentId) || "";
    return content
      .split(/\r?\n/)
      .filter((line) => !this.isReadingNoteLinkLine(line))
      .join("\n")
      .trim();
  }

  async openSegmentId(segmentId, targetPath = "") {
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    const match = normalizedSegmentId.match(SEGMENT_ID_LINK_RE);
    if (!match) {
      throw new Error(`不是有效的分段 ID：${segmentId}`);
    }

    const explicitFile = this.fileFromSegmentTargetPath(targetPath);
    const file = explicitFile || this.findSegmentLessonFileForIdMatch(match);
    if (!(file instanceof TFile)) {
      const seminarCode = `s${match[1]}`.toLowerCase();
      const lessonNumber = Number(match[2]);
      throw new Error(`找不到对应课文：${seminarCode} Leçon ${String(lessonNumber).padStart(2, "0")}`);
    }

    const text = await this.app.vault.cachedRead(file);
    const location = this.findSegmentLocation(text, normalizedSegmentId);
    if (!location) {
      if (explicitFile) {
        throw new Error(`目标文件中没有找到分段：${file.path}#${normalizedSegmentId}`);
      }
      throw new Error(`已找到课文文件，但没有找到分段：${normalizedSegmentId}`);
    }

    await this.openFile(file, this.openStateForSegmentLocation(location));
    const revealed = await this.revealSegmentAfterOpen(normalizedSegmentId, file, location);
    if (!revealed) {
      new Notice(`已打开课文，但暂时无法定位分段：${normalizedSegmentId}`);
    }
  }

  findSegmentLessonFileForIdMatch(match) {
    const seminarCode = `s${match[1]}`.toLowerCase();
    const lessonNumber = Number(match[2]);
    const seminarSlug = this.findSeminarSlugForCode(seminarCode);
    if (!seminarSlug) {
      return null;
    }
    return this.findSegmentLessonFile(seminarSlug, lessonNumber);
  }

  findSegmentLocation(text, segmentId) {
    const normalizedSegmentId = String(segmentId || "").toLowerCase();
    const marker = this.extractSegmentMarkers(text).find((item) => item.ids.includes(normalizedSegmentId));
    if (!marker) {
      return null;
    }

    const line = Math.max(0, Number(marker.targetLine) || 0);
    return {
      line,
      col: 0,
      offset: this.offsetAtLine(text, line),
    };
  }

  offsetAtLine(text, lineNumber) {
    const sourceText = String(text || "");
    const targetLine = Math.max(0, Number(lineNumber) || 0);
    let line = 0;
    for (let index = 0; index < sourceText.length; index += 1) {
      if (line === targetLine) {
        return index;
      }
      if (sourceText.charCodeAt(index) === 10) {
        line += 1;
      }
    }
    return sourceText.length;
  }

  openStateForSegmentLocation(location) {
    const loc = this.normalizedLoc(location);
    return {
      active: true,
      eState: this.ephemeralStateForSegmentLocation(loc),
    };
  }

  ephemeralStateForSegmentLocation(location) {
    const loc = this.normalizedLoc(location);
    return {
      line: loc.line,
      startLoc: loc,
      endLoc: loc,
    };
  }

  normalizedLoc(location) {
    return {
      line: Math.max(0, Number(location?.line) || 0),
      col: Math.max(0, Number(location?.col) || 0),
      offset: Math.max(0, Number(location?.offset) || 0),
    };
  }

  fileFromSegmentTargetPath(targetPath) {
    const normalizedPath = normalizePath(targetPath || "");
    if (!this.isTextMarkdownPath(normalizedPath)) {
      return null;
    }

    const file = this.app.vault.getAbstractFileByPath(normalizedPath);
    return file instanceof TFile ? file : null;
  }

  findSeminarSlugForCode(seminarCode) {
    const prefix = "texts/";
    const seen = new Set();
    for (const file of this.app.vault.getAllLoadedFiles()) {
      const path = normalizePath(file.path || "");
      if (!path.startsWith(prefix)) {
        continue;
      }
      const slug = path.slice(prefix.length).split("/", 1)[0];
      if (!slug || seen.has(slug)) {
        continue;
      }
      seen.add(slug);
      if (slug.split("-", 1)[0].toLowerCase() === seminarCode) {
        return slug;
      }
    }
    return "";
  }

  findSegmentLessonFile(seminarSlug, lessonNumber) {
    const padded = String(lessonNumber).padStart(2, "0");
    const names = [`Leçon-${padded}.md`, `Lecon-${padded}.md`, `lesson-${padded}.md`];
    for (const folder of ["translation", "original"]) {
      for (const name of names) {
        const file = this.app.vault.getAbstractFileByPath(`texts/${seminarSlug}/${folder}/${name}`);
        if (file instanceof TFile) {
          return file;
        }
      }
    }
    return null;
  }

  async revealSegmentAfterOpen(segmentId, file, location) {
    const loc = this.normalizedLoc(location);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await this.nextAnimationFrame();
      if (file instanceof TFile && !this.activeFileMatches(file)) {
        await this.delay(40);
        continue;
      }

      this.applySegmentEphemeralState(loc);
      if (await this.scrollActiveEditorToLocation(loc)) {
        return true;
      }
      if (await this.scrollActivePreviewToSegment(segmentId)) {
        return true;
      }

      await this.delay(40);
    }
    return false;
  }

  applySegmentEphemeralState(location) {
    const view = Obsidian.MarkdownView
      ? this.app.workspace.getActiveViewOfType(Obsidian.MarkdownView)
      : this.app.workspace.activeLeaf?.view;
    if (typeof view?.setEphemeralState === "function") {
      view.setEphemeralState(this.ephemeralStateForSegmentLocation(location));
    }
  }

  async scrollActiveViewToSegment(segmentId, file = null) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await this.nextAnimationFrame();
      if (file instanceof TFile && !this.activeFileMatches(file)) {
        await this.delay(40);
        continue;
      }

      if (await this.scrollActiveEditorToSegment(segmentId)) {
        return true;
      }
      if (await this.scrollActivePreviewToSegment(segmentId)) {
        return true;
      }

      await this.delay(40);
    }
    return false;
  }

  activeFileMatches(file) {
    const activeFile = this.app.workspace.getActiveFile();
    return (
      activeFile instanceof TFile &&
      normalizePath(activeFile.path) === normalizePath(file.path)
    );
  }

  nextAnimationFrame() {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      return new Promise((resolve) => window.requestAnimationFrame(resolve));
    }
    return this.delay(0);
  }

  delay(milliseconds) {
    const setTimer = typeof window !== "undefined" && typeof window.setTimeout === "function"
      ? window.setTimeout.bind(window)
      : setTimeout;
    return new Promise((resolve) => setTimer(resolve, milliseconds));
  }

  async scrollActiveEditorToLocation(location) {
    const view = Obsidian.MarkdownView
      ? this.app.workspace.getActiveViewOfType(Obsidian.MarkdownView)
      : this.app.workspace.activeLeaf?.view;
    const editor = view?.editor;
    if (!editor) {
      return false;
    }

    const loc = this.normalizedLoc(location);
    const position = { line: loc.line, ch: loc.col };
    editor.setCursor(position);
    editor.scrollIntoView({ from: position, to: position }, true);
    return true;
  }

  async scrollActiveEditorToSegment(segmentId) {
    const view = Obsidian.MarkdownView
      ? this.app.workspace.getActiveViewOfType(Obsidian.MarkdownView)
      : this.app.workspace.activeLeaf?.view;
    const editor = view?.editor;
    if (!editor) {
      return false;
    }

    const line = this.findSegmentLine(editor.getValue(), segmentId);
    if (line < 0) {
      return false;
    }

    const position = { line, ch: 0 };
    editor.setCursor(position);
    editor.scrollIntoView({ from: position, to: position }, true);
    return true;
  }

  async scrollActivePreviewToSegment(segmentId) {
    const view = Obsidian.MarkdownView
      ? this.app.workspace.getActiveViewOfType(Obsidian.MarkdownView)
      : this.app.workspace.activeLeaf?.view;
    const file = this.app.workspace.getActiveFile();
    const previewEl = view?.containerEl?.querySelector?.(".markdown-preview-view");
    if (!(file instanceof TFile) || !previewEl) {
      return false;
    }

    const text = await this.app.vault.cachedRead(file);
    const normalizedSegmentId = String(segmentId || "").toLowerCase();
    const marker = this.extractSegmentMarkers(text).find((item) => item.ids.includes(normalizedSegmentId));
    if (!marker) {
      return false;
    }

    const anchorEl = this.findRenderedSegmentAnchor(previewEl, marker, new Set());
    if (!anchorEl) {
      return false;
    }
    anchorEl.scrollIntoView({ block: "center", behavior: "smooth" });
    anchorEl.classList.add("lacan-segment-target-flash");
    window.setTimeout(() => anchorEl.classList.remove("lacan-segment-target-flash"), 1600);
    return true;
  }

  findSegmentLine(text, segmentId) {
    const normalizedSegmentId = String(segmentId || "").toLowerCase();
    const marker = this.extractSegmentMarkers(text).find((item) => item.ids.includes(normalizedSegmentId));
    return marker ? marker.targetLine : -1;
  }

  async createTranslationForOriginal(originalFile, options = {}) {
    const paths = this.pathsFromOriginal(originalFile.path);
    if (!paths) {
      throw new Error("不是有效的原文课文路径。");
    }

    const existing = this.app.vault.getAbstractFileByPath(paths.translationPath);
    if (existing instanceof TFile) {
      await this.fillTranslationIfEmpty(existing, options);
      return existing;
    }

    const originalText = await this.app.vault.read(originalFile);
    const skeleton = this.buildSkeleton(originalFile.path, originalText);
    await this.ensureFolder(paths.translationFolder);
    const created = await this.app.vault.create(paths.translationPath, skeleton);
    if (options.updateProgress !== false) {
      await this.updateTranslationProgress(created);
    }

    if (options.openAfterCreate) {
      await this.openFile(created);
    }
    if (options.notify) {
      new Notice(`已创建译文骨架：${paths.translationPath}`);
    }
    return created;
  }

  async fillTranslationIfEmpty(translationFile, options = {}) {
    const paths = this.pathsFromTranslation(translationFile.path);
    if (!paths) {
      throw new Error("不是有效的译文课文路径。");
    }

    const currentText = await this.app.vault.read(translationFile);
    if (currentText.trim().length > 0) {
      if (options.updateProgress) {
        await this.updateTranslationProgress(translationFile);
      }
      if (options.openAfterCreate) {
        await this.openFile(translationFile);
      }
      if (options.notify && options.notifyExisting) {
        new Notice("译文文件已有内容，未覆盖。");
      }
      return translationFile;
    }

    const originalFile = this.app.vault.getAbstractFileByPath(paths.originalPath);
    if (!(originalFile instanceof TFile)) {
      throw new Error(`找不到对应原文：${paths.originalPath}`);
    }

    const originalText = await this.app.vault.read(originalFile);
    const skeleton = this.buildSkeleton(originalFile.path, originalText);
    await this.app.vault.modify(translationFile, skeleton);
    if (options.updateProgress !== false) {
      await this.updateTranslationProgress(translationFile);
    }

    if (options.openAfterCreate) {
      await this.openFile(translationFile);
    }
    if (options.notify) {
      new Notice(`已填充译文骨架：${translationFile.path}`);
    }
    return translationFile;
  }

  scheduleProgressUpdate(path) {
    const normalized = normalizePath(path);
    const existing = this.progressTimers.get(normalized);
    if (existing) {
      window.clearTimeout(existing);
    }

    const timer = window.setTimeout(async () => {
      this.progressTimers.delete(normalized);
      await this.runWithNotice(
        () => this.updateTranslationProgressByPath(normalized),
        "翻译进度更新失败"
      );
    }, 500);
    this.progressTimers.set(normalized, timer);
  }

  async updateTranslationProgressByPath(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return null;
    }
    return this.updateTranslationProgress(file);
  }

  async updateAllTranslationProgress() {
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => this.isTranslationLessonPath(file.path));

    let updated = 0;
    for (const file of files) {
      const changed = await this.updateTranslationProgress(file);
      if (changed) {
        updated += 1;
      }
    }

    new Notice(`已更新 ${updated}/${files.length} 个译文进度。`);
  }

  async updateTranslationProgress(translationFile) {
    const paths = this.pathsFromTranslation(translationFile.path);
    if (!paths) {
      throw new Error("不是有效的译文课文路径。");
    }

    const translationText = await this.app.vault.read(translationFile);
    const originalFile = this.app.vault.getAbstractFileByPath(paths.originalPath);
    const originalText = originalFile instanceof TFile ? await this.app.vault.read(originalFile) : "";
    const stats = this.calculateTranslationProgress(translationText, originalText);
    const values = {
      translation_progress: stats.progress,
      translation_progress_label: stats.progressLabel,
      untranslated_count: stats.untranslatedCount,
      max_segment_id: stats.maxSegmentId,
    };

    const currentFrontmatter = this.app.metadataCache.getFileCache(translationFile)?.frontmatter || {};
    if (!this.frontmatterNeedsUpdate(currentFrontmatter, values)) {
      return false;
    }

    this.suppressProgressModifyEvent(translationFile.path);
    await this.app.fileManager.processFrontMatter(translationFile, (frontmatter) => {
      for (const [key, value] of Object.entries(values)) {
        frontmatter[key] = value;
      }
    });

    return true;
  }

  suppressProgressModifyEvent(path) {
    const normalized = normalizePath(path);
    const existing = this.progressWriteSuppressTimers.get(normalized);
    if (existing) {
      window.clearTimeout(existing);
    }

    this.progressWritePaths.add(normalized);
    const timer = window.setTimeout(() => {
      this.progressWritePaths.delete(normalized);
      this.progressWriteSuppressTimers.delete(normalized);
    }, 1000);
    this.progressWriteSuppressTimers.set(normalized, timer);
  }

  calculateTranslationProgress(translationText, originalText = "") {
    const untranslatedCount = this.countMatches(translationText, UNTRANSLATED_RE);
    const maxSegmentId = Math.max(
      this.maxSegmentIdNumber(originalText),
      this.maxSegmentIdNumber(translationText)
    );
    const ratio = maxSegmentId > 0 ? 1 - untranslatedCount / maxSegmentId : 0;
    const progress = Math.max(0, Math.min(100, ratio * 100));
    const rounded = Math.round(progress * 100) / 100;

    return {
      untranslatedCount,
      maxSegmentId,
      progress: rounded,
      progressLabel: `${rounded.toFixed(2)}%`,
    };
  }

  countMatches(text, regexp) {
    regexp.lastIndex = 0;
    let count = 0;
    while (regexp.exec(text) !== null) {
      count += 1;
    }
    return count;
  }

  maxSegmentIdNumber(text) {
    SEGMENT_ID_RE.lastIndex = 0;
    let max = 0;
    let match;
    while ((match = SEGMENT_ID_RE.exec(text)) !== null) {
      max = Math.max(max, Number(match[1]));
    }
    return max;
  }

  frontmatterNeedsUpdate(frontmatter, values) {
    return Object.entries(values).some(([key, value]) => frontmatter[key] !== value);
  }

  buildSkeleton(originalPath, originalText) {
    const title = this.extractTitle(originalText) || this.fallbackTitle(originalPath);
    const seminar = this.extractCommentValue(originalText, SEMINAR_RE) || this.seminarFromPath(originalPath);
    const lesson = this.extractCommentValue(originalText, LESSON_RE) || this.lessonFromPath(originalPath);
    const ids = this.extractParagraphIds(originalText);

    if (ids.length === 0) {
      throw new Error("原文中没有找到分段 ID。");
    }

    const lines = [
      title,
      "",
      `<!-- source-original: ${originalPath} -->`,
      "",
      `<!-- seminar: ${seminar} -->`,
      "",
      `<!-- lesson: ${lesson} -->`,
      "",
    ];

    for (const id of ids) {
      lines.push(`<!-- id: ${id} -->`, "", "<!-- untranslated -->", "");
    }

    return `${lines.join("\n").replace(/\n+$/, "")}\n`;
  }

  extractTitle(text) {
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("#")) {
        return line.trim();
      }
      if (line.trim()) {
        break;
      }
    }
    return "";
  }

  extractCommentValue(text, regexp) {
    const match = regexp.exec(text);
    return match ? match[1].trim() : "";
  }

  extractParagraphIds(text) {
    const ids = [];
    const seen = new Set();
    for (const match of this.segmentCommentMatches(text)) {
      for (const id of match.ids) {
        if (!seen.has(id)) {
          ids.push(id);
          seen.add(id);
        }
      }
    }
    return ids;
  }

  fallbackTitle(path) {
    const lesson = this.lessonFromPath(path);
    return `# Leçon ${lesson}`;
  }

  seminarFromPath(path) {
    const match = path.match(/^texts\/([^/]+)\//);
    return match ? match[1].split("-")[0].toLowerCase() : "";
  }

  lessonFromPath(path) {
    const name = path.split("/").pop() || "";
    const match = name.match(LESSON_FILE_RE);
    return match ? match[1] : "";
  }

  isOriginalLessonPath(path) {
    return ORIGINAL_PATH_RE.test(normalizePath(path));
  }

  isTranslationLessonPath(path) {
    return TRANSLATION_PATH_RE.test(normalizePath(path));
  }

  pathsFromOriginal(path) {
    const normalized = normalizePath(path);
    const match = normalized.match(ORIGINAL_PATH_RE);
    if (!match) {
      return null;
    }
    const translationPath = normalized.replace("/original/", "/translation/");
    return {
      originalPath: normalized,
      translationPath,
      translationFolder: translationPath.split("/").slice(0, -1).join("/"),
    };
  }

  pathsFromTranslation(path) {
    const normalized = normalizePath(path);
    const match = normalized.match(TRANSLATION_PATH_RE);
    if (!match) {
      return null;
    }
    const originalPath = normalized.replace("/translation/", "/original/");
    return {
      originalPath,
      translationPath: normalized,
      translationFolder: normalized.split("/").slice(0, -1).join("/"),
    };
  }

  async ensureFolder(folderPath) {
    const parts = normalizePath(folderPath).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  async openFile(file, openState = undefined) {
    await this.app.workspace.getLeaf(false).openFile(file, openState);
  }

  async openReadingNoteOnRight(file) {
    const leaf = this.app.workspace.getLeaf("split", "vertical");
    await leaf.openFile(file);
    await this.app.workspace.revealLeaf?.(leaf);
  }
};

class LacanTranslationHelperSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.activeSettingsTab = "project";
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Lacan Translation Helper" });
    this.renderSettingsTabs(containerEl);

    if (this.activeSettingsTab === "ai") {
      this.renderSegmentAiSettings(containerEl);
      return;
    }

    new Setting(containerEl)
      .setName("模式")
      .setDesc("只决定同步主项目时是否更新当前文件。Fork 对照在 Reader 和 Editer 中都可使用。")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("reader", "Reader")
          .addOption("editer", "Editer")
          .setValue(this.plugin.settings.mode)
          .onChange(async (value) => {
            this.plugin.settings.mode = value;
            if (
              value === "reader"
              && this.plugin.settings.autoSyncOnStartup
              && !this.plugin.confirmReaderAutoSyncEnable()
            ) {
              this.plugin.settings.autoSyncOnStartup = false;
              new Notice("已关闭 Reader 模式启动时自动同步。");
            }
            await this.plugin.saveSettings();
            this.plugin.scheduleComparisonRender();
            this.display();
          });
      });

    const modeHelpEl = containerEl.createDiv("lacan-mode-help setting-item-description");
    modeHelpEl.createEl("p", {
      text: "Reader：同步 GitHub 主仓库的最新更新到本地当前项目，适合只阅读或查看译文的人。",
    });
    modeHelpEl.createEl("p", {
      text: "Editer：同步主仓库时只下载为对照版本，不覆盖你正在编辑的当前文件，适合参与翻译的人。",
    });
    modeHelpEl.createEl("p", {
      text: "Fork 对照：两个模式都支持。先在页面顶部选择 fork 版本，再在阅读预览层用分段旁的开关展开该段对照；不会写入 markdown 原文件。",
    });

    new Setting(containerEl)
      .setName("Lacan-Chinese-Translation-Project 仓库地址")
      .setDesc("填写主项目在 GitHub 上的地址。Reader 会更新当前本地项目；Editer 会下载为主项目对照版本。")
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_REPOSITORY_URL)
          .setValue(this.plugin.settings.repositoryUrl || "")
          .onChange(async (value) => {
            this.plugin.settings.repositoryUrl = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("启用 GitHub HTTP 代理")
      .setDesc("仅用于插件同步 GitHub 仓库，不会改变 Obsidian 其它网络操作。如 Obsidian 或系统已有可用代理，可保持关闭。")
      .addToggle((toggle) => {
        toggle
          .setValue(Boolean(this.plugin.settings.githubProxyEnabled))
          .onChange(async (value) => {
            this.plugin.settings.githubProxyEnabled = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("GitHub HTTP 代理地址")
      .setDesc("启用上面的开关后生效。输入框中的地址只是配置样例，请按自己的代理地址填写。")
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_GITHUB_PROXY_URL)
          .setValue(this.plugin.settings.githubProxyUrl || DEFAULT_GITHUB_PROXY_URL)
          .onChange(async (value) => {
            this.plugin.settings.githubProxyUrl = value.trim() || DEFAULT_GITHUB_PROXY_URL;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("上游分支")
      .setDesc("通常保持 main。不熟悉 Git 的用户不用修改。")
      .addText((text) => {
        text
          .setPlaceholder("main")
          .setValue(this.plugin.settings.repositoryBranch || "main")
          .onChange(async (value) => {
            this.plugin.settings.repositoryBranch = value.trim() || "main";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Editer 模式主项目对照名称")
      .setDesc("Editer 模式下，插件会把主项目下载为这个对照版本，用来和你正在编辑的内容比较。不了解的话保持默认。")
      .addText((text) => {
        text
          .setPlaceholder("lacan-upstream/main")
          .setValue(this.plugin.settings.upstreamLocalBranch || "lacan-upstream/main")
          .onChange(async (value) => {
            this.plugin.settings.upstreamLocalBranch = value.trim() || "lacan-upstream/main";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("启动时自动同步")
      .setDesc("打开 Obsidian 时自动同步主项目和已启用 fork。Reader 默认建议关闭；Editer 只更新主项目对照版本。")
      .addToggle((toggle) => {
        toggle
          .setValue(Boolean(this.plugin.settings.autoSyncOnStartup))
          .onChange(async (value) => {
            if (
              value
              && this.plugin.settings.mode === "reader"
              && !this.plugin.confirmReaderAutoSyncEnable()
            ) {
              this.plugin.settings.autoSyncOnStartup = false;
              await this.plugin.saveSettings();
              this.display();
              return;
            }
            this.plugin.settings.autoSyncOnStartup = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("立即同步")
      .setDesc("立即获取主项目和已启用 fork 的最新内容。当前目录未初始化 Git 时会先自动执行 git init。Reader 会更新当前文件；Editer 不覆盖当前文件。")
      .addButton((button) => {
        button
          .setButtonText("同步")
          .setCta()
          .setDisabled(this.plugin.syncInProgress)
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("同步中...");
            try {
              await this.plugin.runWithNotice(
                () => this.plugin.syncConfiguredRepositories({ notify: true }),
                "Git 同步失败"
              );
            } finally {
              button.setButtonText("同步");
              button.setDisabled(false);
            }
          });
      });

    containerEl.createEl("h3", { text: "Fork 对照版本" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Fork 是其他贡献者自己的项目副本。每个 fork 会保存为独立对照版本；查看 texts 文件时，先在顶部选择版本，再在阅读预览层的具体分段旁展开该段对照。",
    });

    this.renderForkSettings(containerEl);

    new Setting(containerEl)
      .setName("添加 fork")
      .setDesc("添加一个新的 fork 仓库配置。")
      .addButton((button) => {
        button
          .setButtonText("添加")
          .onClick(async () => {
            const nextIndex = this.plugin.settings.forks.length + 1;
            this.plugin.settings.forks.push({
              id: this.createForkId(),
              name: `fork-${nextIndex}`,
              url: "",
              remoteBranch: "main",
              localBranch: `lacan-fork/fork-${nextIndex}`,
              enabled: true,
            });
            await this.plugin.saveSettings();
            this.display();
          });
      });
  }

  renderSettingsTabs(containerEl) {
    const tabsEl = containerEl.createDiv("lacan-settings-tabs");
    tabsEl.setAttribute("role", "tablist");
    tabsEl.setAttribute("aria-label", "插件设置分类");
    const tabs = [
      { id: "project", label: "项目与同步" },
      { id: "ai", label: "AI 功能" },
    ];
    for (const tab of tabs) {
      const active = this.activeSettingsTab === tab.id;
      const button = tabsEl.createEl("button", {
        cls: `lacan-settings-tab${active ? " is-active" : ""}`,
        text: tab.label,
        attr: {
          type: "button",
          role: "tab",
          "aria-selected": active ? "true" : "false",
          tabindex: active ? "0" : "-1",
        },
      });
      button.addEventListener("click", () => {
        if (this.activeSettingsTab === tab.id) {
          return;
        }
        this.activeSettingsTab = tab.id;
        this.display();
      });
    }
  }

  renderSegmentAiSettings(containerEl) {
    containerEl.createEl("h3", { text: "AI 功能（本地 Agent）" });
    const descriptionEl = containerEl.createDiv("lacan-ai-settings-description setting-item-description");
    descriptionEl.createEl("p", {
      text: "点击译文分段旁的“Ф”，插件会按所选功能方案组合提示词、分段上下文与 Skills，并在右侧栏运行。",
    });
    descriptionEl.createEl("p", {
      text: "“Ф”只是统一入口；实际执行解读、术语分析、摘要或其他任务，取决于功能方案中的提示词与 Skills。",
    });
    descriptionEl.createEl("p", {
      text: "本地 Agent 指编排、文件检索和权限控制在本机运行，不等于使用本地模型。发送给模型的上下文和 Agent 读取的材料仍可能离开本机。",
    });
    descriptionEl.createEl("p", {
      text: "分段解读强制只读，不创建或修改笔记；每次回答必须使用内置 Web Search，外部来源只接受法语、德语或英语网页。Apps、Plugins 保持禁用；MCP 默认全部关闭，只能从下方白名单显式开启。不会自动回退到 OpenAI API。",
    });

    new Setting(containerEl)
      .setName("启用分段 AI 功能")
      .setDesc("默认关闭。关闭后不会启动 Codex App Server，也不会影响原有插件功能。")
      .addToggle((toggle) => {
        toggle
          .setValue(Boolean(this.plugin.settings.segmentAiEnabled))
          .onChange(async (value) => {
            this.plugin.settings.segmentAiEnabled = value;
            await this.plugin.saveSettings();
            await this.plugin.resetSegmentAiRuntime();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("会话上限")
      .setDesc(
        "允许同时打开和生成的会话数，范围 1–5。调低时不会关闭现有会话或停止任务。"
      )
      .addDropdown((dropdown) => {
        for (let value = 1; value <= 5; value += 1) {
          dropdown.addOption(String(value), `${value} 个`);
        }
        dropdown
          .setValue(String(this.plugin.settings.segmentAiMaxOpenSessions))
          .onChange(async (value) => {
            const normalized = normalizeMaxOpenSessions(value);
            this.plugin.settings.segmentAiMaxOpenSessions = normalized;
            this.plugin.segmentAiWorkspaceStore?.setMaxOpenSessions(normalized);
            await this.plugin.saveSettings();
            await this.plugin.segmentAiController?.publish?.({ persist: true });
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("Codex CLI 路径")
      .setDesc("可选。填写 codex 可执行文件的绝对路径；留空时从 Obsidian 进程的 PATH 中查找。插件不会自动安装 Codex。")
      .addText((text) => {
        text
          .setPlaceholder("/opt/homebrew/bin/codex")
          .setValue(this.plugin.settings.segmentAiCodexPath || "")
          .onChange(async (value) => {
            this.plugin.settings.segmentAiCodexPath = value.trim();
            await this.plugin.saveSettings();
          });
      });

    const modelCatalog = this.plugin.getSegmentAiModelCatalog();
    const selectedModel = String(this.plugin.settings.segmentAiModel || "").trim();
    const modelCatalogUpdatedAt = Number(
      this.plugin.settings.segmentAiModelCatalogUpdatedAt || 0
    );
    const modelCatalogStatus = modelCatalog.length > 0
      ? `已从本机 Codex 获取 ${modelCatalog.length} 个模型${
          modelCatalogUpdatedAt
            ? `，最近刷新：${new Date(modelCatalogUpdatedAt).toLocaleString()}`
            : ""
        }。`
      : "尚未获取模型列表。";
    new Setting(containerEl)
      .setName("Agent 模型")
      .setDesc(
        `列表由本机 Codex App Server 的 model/list 提供，不经过 Claudian。${modelCatalogStatus}`
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("", "使用 Codex 默认模型");
        for (const model of modelCatalog) {
          const label = model.displayName === model.model
            ? model.displayName
            : `${model.displayName} · ${model.model}`;
          dropdown.addOption(
            model.model,
            model.isDefault ? `${label}（Codex 默认）` : label
          );
        }
        if (
          selectedModel
          && !modelCatalog.some((model) => model.model === selectedModel)
        ) {
          dropdown.addOption(selectedModel, `${selectedModel}（已保存，当前未发现）`);
        }
        dropdown
          .setValue(selectedModel)
          .onChange(async (value) => {
            this.plugin.settings.segmentAiModel = String(value || "").trim();
            this.plugin.settings.segmentAiReasoningEffort =
              coerceCodexReasoningEffort(
                modelCatalog,
                this.plugin.settings.segmentAiModel,
                this.plugin.settings.segmentAiReasoningEffort
              );
            await this.plugin.saveSettings();
            await this.plugin.resetSegmentAiRuntime();
            this.display();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("刷新模型")
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("获取中...");
            try {
              await this.plugin.resetSegmentAiRuntime();
              const models = await this.plugin.discoverSegmentAiModels();
              new Notice(`已从 Codex 获取 ${models.length} 个可用模型。`);
            } catch (error) {
              new Notice(
                `模型列表获取失败：${error?.message || "请检查 Codex CLI 路径和登录状态。"}`
              );
            } finally {
              button.setDisabled(false);
              button.setButtonText("刷新模型");
              this.display();
            }
          });
      });

    const reasoningProfile = resolveCodexReasoningProfile(
      modelCatalog,
      selectedModel
    );
    const selectedReasoningEffort = coerceCodexReasoningEffort(
      modelCatalog,
      selectedModel,
      this.plugin.settings.segmentAiReasoningEffort
    );
    const defaultReasoningLabel = reasoningProfile?.defaultReasoningEffort
      ? REASONING_EFFORT_LABELS[reasoningProfile.defaultReasoningEffort]
        || reasoningProfile.defaultReasoningEffort
      : "";
    const reasoningDescription = reasoningProfile
      ? `${reasoningProfile.model} 支持的强度来自 model/list；留空时使用模型默认值${
          defaultReasoningLabel ? ` ${defaultReasoningLabel}` : ""
        }。所选强度会作为 turn/start 的 effort 发送。`
      : "尚未取得当前模型的推理强度目录；可先刷新模型。留空时由 Codex 选择默认值。";
    new Setting(containerEl)
      .setName("推理强度")
      .setDesc(reasoningDescription)
      .addDropdown((dropdown) => {
        dropdown.addOption(
          "",
          defaultReasoningLabel
            ? `跟随模型默认值（${defaultReasoningLabel}）`
            : "跟随模型默认值"
        );
        for (const effort of reasoningProfile?.supportedReasoningEfforts || []) {
          dropdown.addOption(
            effort.value,
            REASONING_EFFORT_LABELS[effort.value] || effort.value
          );
        }
        if (
          selectedReasoningEffort
          && !reasoningProfile?.supportedReasoningEfforts.some(
            (effort) => effort.value === selectedReasoningEffort
          )
        ) {
          dropdown.addOption(
            selectedReasoningEffort,
            `${REASONING_EFFORT_LABELS[selectedReasoningEffort]
              || selectedReasoningEffort}（已保存，待刷新验证）`
          );
        }
        dropdown
          .setValue(selectedReasoningEffort)
          .onChange(async (value) => {
            this.plugin.settings.segmentAiReasoningEffort = String(
              value || ""
            ).trim();
            await this.plugin.saveSettings();
            await this.plugin.resetSegmentAiRuntime();
            this.display();
          });
      });

    const mcpCatalog = this.plugin.getSegmentAiMcpServerCatalog();
    const mcpEnabledServerSet = new Set(
      this.plugin.settings.segmentAiMcpEnabledServers
    );
    const mcpDiagnostics =
      this.plugin.segmentAiRuntime?.getDiagnostics?.().mcpBackgroundCheck;
    const mcpStatusLabels = {
      idle: "等待后台检查",
      checking: "正在后台检查",
      disabled: "全部关闭，未连接任何 MCP",
      ready: "已完成后台检查",
      degraded: "检查完成，部分服务不可用",
      unavailable: "白名单服务未在 Codex 配置中发现",
      failed: "后台检查失败，可查看脱敏诊断",
    };
    const mcpStatus = mcpStatusLabels[mcpDiagnostics?.status]
      || "尚未执行后台检查";
    const mcpCatalogUpdatedAt = Number(
      this.plugin.settings.segmentAiMcpServerCatalogUpdatedAt || 0
    );
    containerEl.createEl("h4", { text: "MCP 服务（默认关闭）" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "核心规则：任何没有在插件白名单中同时配置并开启的外部 MCP，在插件启动和 Agent thread 中都不会建立连接。插件只保存服务名称和开关，不保存命令、URL 或凭据；后台只读取 Codex 配置名称，并且只连接、检查白名单中已开启的服务。开启一个服务会让 Agent 看见该服务当前暴露的全部工具，插件不能替服务保证这些工具只读，因此只应开启你信任的服务。",
    });
    new Setting(containerEl)
      .setName("启用 MCP 服务")
      .setDesc(
        `${mcpStatus}${
          mcpCatalogUpdatedAt
            ? `；清单刷新于 ${new Date(mcpCatalogUpdatedAt).toLocaleString()}`
            : ""
        }。总开关关闭时，即使下方保存了选择，也不会连接或检查任何 MCP。`
      )
      .addToggle((toggle) => {
        toggle
          .setValue(Boolean(this.plugin.settings.segmentAiMcpEnabled))
          .onChange(async (value) => {
            this.plugin.settings.segmentAiMcpEnabled = value;
            await this.plugin.saveSettings();
            await this.plugin.resetSegmentAiRuntime();
            this.display();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("刷新清单")
          .setDisabled(!this.plugin.settings.segmentAiEnabled)
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("后台检查中...");
            try {
              const report = await this.plugin.refreshSegmentAiMcpServers();
              new Notice(
                `已发现 ${report.configuredServerNames.length} 个 MCP；检查 ${
                  report.checkedServerNames.length
                } 个已开启服务。`
              );
            } catch (error) {
              new Notice(
                `MCP 清单刷新失败：${error?.message || "请查看脱敏诊断。"}`
              );
            } finally {
              button.setDisabled(false);
              button.setButtonText("刷新清单");
              this.display();
            }
          });
      });

    if (mcpCatalog.length === 0) {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: this.plugin.settings.segmentAiEnabled
          ? "尚未发现本机 Codex 的 MCP 配置；后台完成后重新打开此设置页，或点击“刷新清单”。"
          : "启用分段 AI 功能后，插件才会在后台读取本机 Codex 的 MCP 名称。",
      });
    }
    for (const serverName of mcpCatalog) {
      new Setting(containerEl)
        .setName(serverName)
        .setDesc("关闭时会在每个 Agent thread 的配置中明确写入 enabled=false；开启时授权该服务的全部工具。")
        .addToggle((toggle) => {
          toggle
            .setValue(mcpEnabledServerSet.has(serverName))
            .setDisabled(!this.plugin.settings.segmentAiMcpEnabled)
            .onChange(async (value) => {
              const next = new Set(
                this.plugin.settings.segmentAiMcpEnabledServers
              );
              if (value) {
                next.add(serverName);
              } else {
                next.delete(serverName);
              }
              this.plugin.settings.segmentAiMcpEnabledServers =
                normalizeServerNames([...next]);
              await this.plugin.saveSettings();
              await this.plugin.resetSegmentAiRuntime();
              this.display();
            });
        });
    }

    containerEl.createEl("h4", { text: "解读提示词与 Skills" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "默认功能：术语与符号对照 + 语境性解读。术语表只读，缺项或不一致只提示，由用户判断是否修改。",
    });
    new Setting(containerEl)
      .setName("解读提示词")
      .setDesc("这是插件唯一的可编辑解读提示词，适用于所有分段和 Skill 方案。只读、安全、本地 Vault 文件范围和外部来源语言限制仍由插件内部固定。")
      .addTextArea((text) => {
        text
          .setValue(
            this.plugin.settings.segmentAiPrompt
              || DEFAULT_INTERPRETATION_PROMPT
          )
          .setPlaceholder(DEFAULT_INTERPRETATION_PROMPT)
          .onChange(async (value) => {
            this.plugin.settings.segmentAiPrompt = String(value || "");
            this.plugin.segmentAiController?.promptBuilder
              ?.setInterpretationPrompt?.(value);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 12;
        text.inputEl.addClass("lacan-ai-global-prompt");
      })
      .addButton((button) => {
        button
          .setButtonText("恢复默认")
          .onClick(async () => {
            this.plugin.settings.segmentAiPrompt =
              DEFAULT_INTERPRETATION_PROMPT;
            this.plugin.segmentAiController?.promptBuilder
              ?.setInterpretationPrompt?.(DEFAULT_INTERPRETATION_PROMPT);
            await this.plugin.saveSettings();
            this.display();
          });
      });
    const skillCatalog = (this.plugin.settings.segmentAiSkillCatalog || [])
      .map(normalizeSkillMetadata)
      .filter(Boolean);
    const skillCatalogUpdatedAt = Number(
      this.plugin.settings.segmentAiSkillCatalogUpdatedAt || 0
    );
    new Setting(containerEl)
      .setName("Codex Skills")
      .setDesc(
        skillCatalog.length > 0
          ? `已发现 ${skillCatalog.length} 个${
              skillCatalogUpdatedAt
                ? `，最近刷新：${new Date(skillCatalogUpdatedAt).toLocaleString()}`
                : ""
            }。`
          : "尚未获取 Skill 清单。刷新只读取 Codex 对当前 Vault 实际发现的条目。"
      )
      .addButton((button) => {
        button
          .setButtonText("刷新 Skills")
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("获取中...");
            try {
              const skills = await this.plugin.discoverSegmentAiSkills({
                forceReload: true,
              });
              new Notice(`已从 Codex 获取 ${skills.length} 个 Skill。`);
            } catch (error) {
              new Notice(
                `Skill 清单获取失败：${error?.message || "请检查 Codex CLI 和登录状态。"}`
              );
            } finally {
              button.setDisabled(false);
              button.setButtonText("刷新 Skills");
              this.display();
            }
          });
      });

    const profiles = this.plugin.getSegmentAiSkillProfiles();
    new Setting(containerEl)
      .setName("默认 Skill 方案")
      .setDesc("单击“Ф”时使用；所有方案共用上面的解读提示词。")
      .addDropdown((dropdown) => {
        for (const profile of profiles) {
          dropdown.addOption(profile.id, profile.title);
        }
        dropdown
          .setValue(
            this.plugin.settings.segmentAiDefaultSkillProfileId || "standard"
          )
          .onChange(async (value) => {
            this.plugin.settings.segmentAiDefaultSkillProfileId =
              String(value || "standard");
            await this.plugin.saveSettings();
            this.plugin.refreshSegmentAiEntrances();
          });
      });

    if (this.plugin.settings.segmentAiSkillProfiles.length > 0) {
      const profileListEl = containerEl.createDiv("lacan-ai-profile-list");
      for (const profile of this.plugin.settings.segmentAiSkillProfiles) {
        const profileEl = profileListEl.createDiv("lacan-ai-profile-setting");
        const selectedSkills = [
          profile.primarySkill,
          ...(profile.supportingSkills || []),
        ].filter(Boolean);
        profileEl.createEl("strong", { text: profile.title });
        profileEl.createEl("span", {
          text: `${
            selectedSkills
              .map((skill) => `${skill.name} · ${skill.scope}`)
              .join("；")
          } · 共用全局提示词`,
        });
        const deleteButton = profileEl.createEl("button", {
          text: "删除 Skill 方案",
          attr: { type: "button" },
        });
        deleteButton.addEventListener("click", async () => {
          const confirmed = typeof globalThis.confirm === "function"
            ? globalThis.confirm(
                `删除 Skill 方案“${profile.title}”？历史会话不会被删除。`
              )
            : true;
          if (!confirmed) {
            return;
          }
          this.plugin.settings.segmentAiSkillProfiles =
            this.plugin.settings.segmentAiSkillProfiles.filter(
              (candidate) => candidate.id !== profile.id
            );
          if (
            this.plugin.settings.segmentAiDefaultSkillProfileId === profile.id
          ) {
            this.plugin.settings.segmentAiDefaultSkillProfileId = "standard";
          }
          await this.plugin.saveSettings();
          this.plugin.refreshSegmentAiEntrances();
          this.display();
        });
      }
    }

    const availableSkills = skillCatalog.filter(
      (skill) => skill.enabled && (skill.errors || []).length === 0
    );
    const profileDraft = {
      title: "",
      primary: "",
      supporting: "",
    };
    const profileEditorEl = containerEl.createDiv("lacan-ai-skill-editor");
    profileEditorEl.createEl("h5", { text: "新建 Skill 方案" });
    new Setting(profileEditorEl)
      .setName("功能名称")
      .addText((text) => {
        text
          .setPlaceholder("例如：研讨班细读、术语梳理")
          .onChange((value) => {
            profileDraft.title = value.trim();
          });
      });
    const addSkillOptions = (dropdown, includeNone = true) => {
      if (includeNone) {
        dropdown.addOption("", "不指定");
      }
      for (const skill of availableSkills) {
        dropdown.addOption(
          JSON.stringify({
            name: skill.name,
            scope: skill.scope,
            pathHint: skill.path,
          }),
          `${skill.name} · ${
            skill.scope === "repo" ? "随项目" : skill.scope
          } · ${String(skill.path || "").split("/").slice(-3, -1).join("/")}`
        );
      }
    };
    new Setting(profileEditorEl)
      .setName("主要 Skill")
      .setDesc("可选。每个方案最多一个主要 Skill。")
      .addDropdown((dropdown) => {
        addSkillOptions(dropdown);
        dropdown.onChange((value) => {
          profileDraft.primary = value;
        });
      });
    new Setting(profileEditorEl)
      .setName("辅助 Skill")
      .setDesc("第一版界面可再选一个辅助 Skill；数据模型支持最多两个。")
      .addDropdown((dropdown) => {
        addSkillOptions(dropdown);
        dropdown.onChange((value) => {
          profileDraft.supporting = value;
        });
      });
    new Setting(profileEditorEl)
      .setName("保存 Skill 方案")
      .addButton((button) => {
        button
          .setButtonText("保存")
          .setCta()
          .onClick(async () => {
            if (
              !profileDraft.title
              || !(profileDraft.primary || profileDraft.supporting)
            ) {
              new Notice("请填写功能名称，并至少选择一个 Skill。");
              return;
            }
            const selectorFromKey = (key) => {
              try {
                return JSON.parse(key);
              } catch (_error) {
                return null;
              }
            };
            const slug = profileDraft.title
              .toLowerCase()
              .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
              .replace(/^-+|-+$/g, "")
              || `profile-${Date.now()}`;
            let id = `profile-${slug}`;
            let suffix = 2;
            while (this.plugin.settings.segmentAiSkillProfiles.some(
              (profile) => profile.id === id
            )) {
              id = `profile-${slug}-${suffix}`;
              suffix += 1;
            }
            this.plugin.settings.segmentAiSkillProfiles.push({
              id,
              title: profileDraft.title,
              primarySkill: selectorFromKey(profileDraft.primary),
              supportingSkills: profileDraft.supporting
                ? [selectorFromKey(profileDraft.supporting)]
                : [],
            });
            this.plugin.settings.segmentAiSkillProfiles = normalizeSkillProfiles(
              this.plugin.settings.segmentAiSkillProfiles
            );
            await this.plugin.saveSettings();
            this.plugin.refreshSegmentAiEntrances();
            new Notice(`已保存 Skill 方案“${profileDraft.title}”。`);
            this.display();
          });
      });

    const customSkillDraft = {
      name: "",
      description: "",
      instructions: "",
      root: this.plugin.settings.segmentAiCustomSkillRoot || ".agents/skills",
    };
    const customSkillEl = containerEl.createDiv("lacan-ai-skill-editor");
    customSkillEl.createEl("h5", { text: "新建 Vault 自定义 Skill" });
    customSkillEl.createEl("p", {
      cls: "setting-item-description",
      text: "这是你在设置页明确发起的文件管理操作；Agent 解读回合本身仍保持只读。第一版只创建一个标准 SKILL.md。",
    });
    new Setting(customSkillEl)
      .setName("Skill 名称")
      .setDesc("只能使用字母、数字、短横线和下划线。")
      .addText((text) => {
        text
          .setPlaceholder("lacan-close-reading")
          .onChange((value) => {
            customSkillDraft.name = value.trim();
          });
      });
    new Setting(customSkillEl)
      .setName("说明")
      .addText((text) => {
        text
          .setPlaceholder("说明这个 Skill 在何时、如何使用")
          .onChange((value) => {
            customSkillDraft.description = value.trim();
          });
      });
    new Setting(customSkillEl)
      .setName("指令正文")
      .addTextArea((text) => {
        text
          .setPlaceholder("写明分析步骤、证据要求和输出方式。")
          .onChange((value) => {
            customSkillDraft.instructions = value.trim();
          });
      });
    new Setting(customSkillEl)
      .setName("保存位置")
      .addDropdown((dropdown) => {
        dropdown
          .addOption(".agents/skills", ".agents/skills（推荐，随项目）")
          .addOption(".codex/skills", ".codex/skills（随项目）")
          .setValue(customSkillDraft.root)
          .onChange(async (value) => {
            customSkillDraft.root = value;
            this.plugin.settings.segmentAiCustomSkillRoot = value;
            await this.plugin.saveSettings();
          });
      });
    new Setting(customSkillEl)
      .setName("创建并加入 Skill 方案")
      .addButton((button) => {
        button
          .setButtonText("创建 Skill")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            try {
              const created = await this.plugin.createSegmentAiCustomSkill(
                customSkillDraft
              );
              new Notice(
                `已创建 ${created.path}，并加入 Skill 方案列表。`
              );
              this.plugin.refreshSegmentAiEntrances();
              this.display();
            } catch (error) {
              new Notice(`创建 Skill 失败：${error?.message || "未知错误"}`);
            } finally {
              button.setDisabled(false);
            }
          });
      });

    const diagnostics = this.plugin.getSegmentAiDiagnostics();
    new Setting(containerEl)
      .setName("本地 Agent 诊断")
      .setDesc(
        diagnostics.runtime?.userAgent
          ? `${diagnostics.runtime.userAgent} · ${diagnostics.status}`
          : `尚未启动 · ${diagnostics.status}`
      )
      .addButton((button) => {
        button
          .setButtonText("应用配置并重启")
          .onClick(async () => {
            await this.plugin.resetSegmentAiRuntime();
            new Notice("已重置分段 AI 功能运行时。");
            this.display();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("复制诊断")
          .onClick(async () => {
            const text = JSON.stringify(this.plugin.getSegmentAiDiagnostics(), null, 2);
            if (globalThis.navigator?.clipboard?.writeText) {
              await globalThis.navigator.clipboard.writeText(text);
              new Notice("已复制 AI 功能诊断。");
            }
          });
      });
  }

  renderForkSettings(containerEl) {
    for (const fork of this.plugin.settings.forks) {
      const sectionEl = containerEl.createDiv("lacan-settings-fork");
      sectionEl.createEl("h4", { text: fork.name || fork.localBranch || "未命名 fork" });

      new Setting(sectionEl)
        .setName("启用")
        .setDesc("启用后会参与同步，并显示为文本对照按钮。")
        .addToggle((toggle) => {
          toggle
            .setValue(Boolean(fork.enabled))
            .onChange(async (value) => {
              fork.enabled = value;
              await this.plugin.saveSettings();
              this.plugin.scheduleComparisonRender();
            });
        });

      new Setting(sectionEl)
        .setName("名称")
        .addText((text) => {
          text
            .setPlaceholder("fork 名称")
            .setValue(fork.name || "")
            .onChange(async (value) => {
              fork.name = value.trim();
              await this.plugin.saveSettings();
              this.plugin.scheduleComparisonRender();
            });
        });

      new Setting(sectionEl)
        .setName("仓库地址")
        .addText((text) => {
          text
            .setPlaceholder("https://github.com/user/Lacan-Chinese-Translation-Project.git")
            .setValue(fork.url || "")
            .onChange(async (value) => {
              fork.url = value.trim();
              await this.plugin.saveSettings();
            });
        });

      new Setting(sectionEl)
        .setName("GitHub 上的版本")
        .addText((text) => {
          text
            .setPlaceholder("main")
            .setValue(fork.remoteBranch || "main")
            .onChange(async (value) => {
              fork.remoteBranch = value.trim() || "main";
              await this.plugin.saveSettings();
            });
        });

      new Setting(sectionEl)
        .setName("本地对照版本名称")
        .setDesc("用于保存这个 fork 的对照内容。不要设置成你正在编辑的版本名称；不了解的话保持默认。")
        .addText((text) => {
          text
            .setPlaceholder("lacan-fork/user-main")
            .setValue(fork.localBranch || "")
            .onChange(async (value) => {
              fork.localBranch = value.trim();
              await this.plugin.saveSettings();
              this.plugin.scheduleComparisonRender();
            });
        });

      new Setting(sectionEl)
        .setName("操作")
        .addButton((button) => {
          button
            .setButtonText("同步 fork")
            .setDisabled(this.plugin.syncInProgress)
            .onClick(async () => {
              button.setDisabled(true);
              button.setButtonText("同步中...");
              try {
                await this.plugin.runWithNotice(
                  async () => {
                    await this.plugin.syncForkRepository(fork);
                    new Notice(`已同步 fork：${fork.name || fork.localBranch}`);
                  },
                  "fork 同步失败"
                );
              } finally {
                button.setButtonText("同步 fork");
                button.setDisabled(false);
              }
            });
        })
        .addButton((button) => {
          button
            .setButtonText("删除")
            .setWarning()
            .onClick(async () => {
              this.plugin.settings.forks = this.plugin.settings.forks.filter((item) => item.id !== fork.id);
              this.plugin.activeComparisonForks.delete(fork.id);
              await this.plugin.saveSettings();
              this.plugin.scheduleComparisonRender();
              this.display();
            });
        });
    }
  }

  createForkId() {
    return `fork-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

class LacanLessonListBasesView extends ObsidianBasesView {
  constructor(controller, parentEl, plugin) {
    super(controller);
    this.plugin = plugin;
    this.containerEl = parentEl.createDiv("lacan-bases-list");
  }

  onDataUpdated() {
    this.containerEl.empty();
    const groups = this.data?.groupedData?.length
      ? this.data.groupedData
      : [{ entries: this.data?.entries || [] }];
    const mode = String(this.config?.get?.("mode") || "reader");

    for (const group of groups) {
      const entries = group.entries || [];
      const details = this.containerEl.createEl("details", {
        cls: "lacan-bases-group",
      });
      const summary = details.createEl("summary", {
        cls: "lacan-bases-group-summary",
      });

      summary.createSpan({
        cls: "lacan-bases-group-title",
        text: this.getGroupTitle(group),
      });
      summary.createSpan({
        cls: "lacan-bases-group-count",
        text: `${entries.length}`,
      });

      const listEl = details.createEl("ul", {
        cls: "lacan-bases-group-list",
      });

      details.addEventListener("toggle", () => {
        if (details.open && details.dataset.entriesRendered !== "true") {
          this.renderGroupEntries(listEl, entries, mode);
          details.dataset.entriesRendered = "true";
        }
      });
    }
  }

  renderGroupEntries(listEl, entries, mode) {
    for (const entry of entries) {
      this.renderEntry(listEl, entry, mode);
    }
  }

  getGroupTitle(group) {
    const value = this.valueToString(group?.value);
    if (value && value !== "[object Object]") {
      return value;
    }

    const firstEntry = group.entries?.[0];
    return this.valueToString(firstEntry?.getValue?.("formula.seminarGroup")) || "未分组";
  }

  renderEntry(listEl, entry, mode) {
    const lessonTitle = this.valueToString(entry.getValue("formula.lessonTitle"));
    const originalPath = this.valueToString(entry.getValue("formula.originalPath"));
    const translationPath = this.valueToString(entry.getValue("formula.translationPath"));
    const notesIndexPath = this.valueToString(entry.getValue("formula.notesIndexPath"));
    const progress = this.valueToString(entry.getValue("formula.translationProgressLabel")) || "0.00%";
    const untranslatedCount = this.valueToString(entry.getValue("formula.untranslatedCount"));
    const maxSegmentId = this.valueToString(entry.getValue("formula.maxSegmentId"));
    const translationFile = this.plugin.app.vault.getAbstractFileByPath(translationPath);

    const itemEl = listEl.createEl("li", {
      cls: "lacan-bases-entry",
    });
    const mainEl = itemEl.createDiv("lacan-bases-entry-main");

    mainEl.createSpan({
      cls: "lacan-bases-entry-title",
      text: lessonTitle,
    });
    this.createActionLink(mainEl, "原文", () => this.openOriginal(entry.file, originalPath));
    this.createActionLink(
      mainEl,
      translationFile instanceof TFile ? "译文" : "新建翻译",
      () => this.openOrCreateTranslation(entry.file, translationFile)
    );
    this.createActionLink(mainEl, "笔记", () => this.openOrCreateNotesIndex(notesIndexPath));
    mainEl.createSpan({
      cls: "lacan-bases-progress",
      text: progress,
    });

    if (mode === "editer") {
      const metaEl = itemEl.createDiv("lacan-bases-entry-meta");
      metaEl.createSpan({ text: `原文：${originalPath}` });
      metaEl.createSpan({ text: `译文：${translationPath}` });
      metaEl.createSpan({ text: `笔记：${notesIndexPath}` });
      metaEl.createSpan({ text: `未译：${untranslatedCount || 0}` });
      metaEl.createSpan({ text: `最大分段：${maxSegmentId || 0}` });
    }
  }

  createActionLink(parentEl, text, action) {
    const linkEl = parentEl.createEl("a", {
      cls: "lacan-bases-link",
      href: "#",
      text,
    });
    linkEl.addEventListener("click", async (event) => {
      event.preventDefault();
      await this.plugin.runWithNotice(action, "打开课文失败");
    });
  }

  async openOriginal(originalFile, originalPath) {
    if (originalFile instanceof TFile) {
      await this.plugin.openFile(originalFile);
      return;
    }

    const file = this.plugin.app.vault.getAbstractFileByPath(originalPath);
    if (file instanceof TFile) {
      await this.plugin.openFile(file);
    }
  }

  async openOrCreateTranslation(originalFile, translationFile) {
    if (translationFile instanceof TFile) {
      await this.plugin.openFile(translationFile);
      return;
    }

    if (!(originalFile instanceof TFile)) {
      throw new Error("找不到对应原文，无法创建译文。");
    }

    await this.plugin.createTranslationForOriginal(originalFile, {
      openAfterCreate: true,
      notify: true,
      updateProgress: true,
    });
  }

  async openOrCreateNotesIndex(notesIndexPath) {
    const normalized = normalizePath(notesIndexPath || "");
    if (!normalized) {
      throw new Error("找不到阅读笔记目录路径。");
    }

    const existing = this.plugin.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) {
      await this.plugin.openFile(existing);
      return;
    }

    await this.plugin.ensureFolder(normalized.split("/").slice(0, -1).join("/"));
    const created = await this.plugin.app.vault.create(
      normalized,
      "# 阅读笔记\n\n本目录用于保存本研讨班的阅读笔记和补充材料。\n"
    );
    await this.plugin.openFile(created);
  }

  valueToString(value) {
    if (!value || value.isEmpty?.()) {
      return "";
    }
    return String(value);
  }
}
