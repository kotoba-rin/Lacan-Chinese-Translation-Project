const Obsidian = require("obsidian");
const { Component, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath } = Obsidian;
const ObsidianBasesView = Obsidian.BasesView || class {};
const MarkdownRenderComponent = Component || class {
  load() {}
  unload() {}
};

const LESSON_FILE_RE = /^(?:Leçon|Lecon|lesson)-(\d+)\.md$/i;
const ORIGINAL_PATH_RE = /^texts\/([^/]+)\/original\/((?:Leçon|Lecon|lesson)-\d+\.md)$/i;
const TRANSLATION_PATH_RE = /^texts\/([^/]+)\/translation\/((?:Leçon|Lecon|lesson)-\d+\.md)$/i;
const SEGMENT_ID_COMMENT_RE = /<!--\s*ids?\b\s*:?\s*([\s\S]*?)-->/gi;
const SEGMENT_ID_COMMENT_TEST_RE = /<!--\s*ids?\b\s*:?\s*[\s\S]*?\bs\d+b?-\d+-\d+\b[\s\S]*?-->/i;
const SEGMENT_ID_TOKEN_RE = /\bs\d+b?-\d+-\d+\b/gi;
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

const DEFAULT_SETTINGS = {
  mode: "reader",
  repositoryUrl: DEFAULT_REPOSITORY_URL,
  repositoryBranch: "main",
  upstreamLocalBranch: "lacan-upstream/main",
  githubProxyEnabled: false,
  githubProxyUrl: DEFAULT_GITHUB_PROXY_URL,
  autoSyncOnStartup: false,
  forks: [],
};

module.exports = class LacanTranslationHelper extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.forks = Array.isArray(this.settings.forks) ? this.settings.forks : [];
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

    this.addSettingTab(new LacanTranslationHelperSettingTab(this.app, this));

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
    if (!contentEl) {
      return;
    }

    const forks = this.settings.forks.filter((fork) => fork.enabled && fork.localBranch);
    const toolbarSignature = this.comparisonToolbarSignature(file.path, forks);
    let toolbarEl = contentEl.querySelector(":scope > .lacan-compare-toolbar");
    if (!toolbarEl) {
      toolbarEl = contentEl.createDiv("lacan-compare-toolbar");
      contentEl.prepend(toolbarEl);
    }

    if (toolbarEl.dataset.toolbarSignature !== toolbarSignature) {
      this.renderComparisonToolbarContent(toolbarEl, forks);
      toolbarEl.dataset.toolbarSignature = toolbarSignature;
    }

    if (renderSegments && this.canRenderComparisonSegments(contentEl, view)) {
      this.renderInlineComparisonControlsForActiveView({ showLoading, forcePreviewRerender })
        .catch((error) => this.handleComparisonRenderError(error));
    }
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
      contentEl.setText("[该 fork 中没有对应分段]");
      return;
    }
    const visibleText = trimmed.replace(/<!--[\s\S]*?-->/g, "").trim();
    if (!visibleText && /<!--\s*untranslated\s*-->/i.test(trimmed)) {
      contentEl.setText("[该 fork 中该段尚未翻译]");
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
    rootEl.querySelectorAll?.(".lacan-segment-compare-content").forEach((element) => {
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
        start: match.index,
        end: match.end,
      });
    }

    for (let index = 0; index < matches.length; index += 1) {
      const current = matches[index];
      const next = matches[index + 1];
      const content = text.slice(current.end, next ? next.start : text.length).trim();
      if (!segments.has(current.id)) {
        segments.set(current.id, content);
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
        idStart: match.index,
        line,
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
      current.text = text.slice(current.contentStart, next ? next.idStart : text.length).trim();
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
    let cursor = anchorIndex?.lineCursor || 0;
    while (cursor < lineAnchors.length && lineAnchors[cursor].line <= marker.line) {
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
    const matches = [];
    SEGMENT_ID_COMMENT_RE.lastIndex = 0;
    let match;
    while ((match = SEGMENT_ID_COMMENT_RE.exec(text)) !== null) {
      const ids = this.segmentIdsFromComment(match[0]);
      if (ids.length === 0) {
        continue;
      }
      matches.push({
        id: ids[0],
        ids,
        index: match.index,
        end: SEGMENT_ID_COMMENT_RE.lastIndex,
      });
    }
    return matches;
  }

  segmentIdsFromComment(commentText) {
    const body = String(commentText || "")
      .replace(/^\s*<!--\s*/, "")
      .replace(/\s*-->\s*$/, "")
      .trim();
    const labelMatch = body.match(/^ids?\b\s*:?\s*([\s\S]+)$/i);
    if (!labelMatch) {
      return [];
    }

    const ids = [];
    const seen = new Set();
    SEGMENT_ID_TOKEN_RE.lastIndex = 0;
    let match;
    while ((match = SEGMENT_ID_TOKEN_RE.exec(labelMatch[1])) !== null) {
      const id = match[0].toLowerCase();
      if (!seen.has(id)) {
        ids.push(id);
        seen.add(id);
      }
    }
    return ids;
  }

  segmentComparisonKey(path, segmentId) {
    return `${path}::${segmentId}`;
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

  async openFile(file) {
    await this.app.workspace.getLeaf(false).openFile(file);
  }
};

class LacanTranslationHelperSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Lacan Translation Helper" });

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
    mainEl.createSpan({
      cls: "lacan-bases-progress",
      text: progress,
    });

    if (mode === "editer") {
      const metaEl = itemEl.createDiv("lacan-bases-entry-meta");
      metaEl.createSpan({ text: `原文：${originalPath}` });
      metaEl.createSpan({ text: `译文：${translationPath}` });
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

  valueToString(value) {
    if (!value || value.isEmpty?.()) {
      return "";
    }
    return String(value);
  }
}
