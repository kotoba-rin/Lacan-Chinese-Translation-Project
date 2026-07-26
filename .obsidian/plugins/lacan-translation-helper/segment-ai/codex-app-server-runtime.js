const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  AppServerProtocolError,
  JsonLineRpcClient,
} = require("./json-line-rpc");
const { McpCapabilityRegistry } = require("./mcp-capability-registry");

const READ_ONLY_SANDBOX_POLICY = Object.freeze({
  type: "readOnly",
  networkAccess: false,
});

const DISABLED_FEATURES = Object.freeze([
  "apps",
  "plugins",
  "multi_agent",
  "standalone_web_search",
  "browser_use",
  "in_app_browser",
  "computer_use",
]);

class CodexRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodexRuntimeError";
    this.code = code;
    Object.assign(this, details);
  }
}

class CodexAppServerRuntime {
  constructor({
    vaultRoot,
    pluginVersion = "0.0.0",
    cliPath = "",
    defaultModel = "",
    defaultReasoningEffort = "",
    spawnProcess = spawn,
    requestTimeoutMs = 30000,
    turnTimeoutMs = 10 * 60 * 1000,
    environment = process.env,
    mcpCapabilityRegistry = new McpCapabilityRegistry(),
  } = {}) {
    if (!path.isAbsolute(String(vaultRoot || ""))) {
      throw new TypeError("CodexAppServerRuntime requires an absolute vaultRoot.");
    }
    this.vaultRoot = path.resolve(vaultRoot);
    this.pluginVersion = String(pluginVersion || "0.0.0");
    this.configuredCliPath = String(cliPath || "").trim();
    this.defaultModel = String(defaultModel || "").trim();
    this.defaultReasoningEffort = String(defaultReasoningEffort || "").trim();
    this.spawnProcess = spawnProcess;
    this.requestTimeoutMs = requestTimeoutMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.environment = environment;
    this.mcpCapabilityRegistry = mcpCapabilityRegistry;
    this.childProcess = null;
    this.client = null;
    this.startupPromise = null;
    this.activeTurns = new Map();
    this.earlyTurnEvents = new Map();
    this.skillChangeListeners = new Set();
    this.capabilityCheckQueue = Promise.resolve();
    this.threadPreparationQueue = Promise.resolve();
    this.globalMcpServerNames = [];
    this.diagnostics = {
      cliPath: null,
      userAgent: null,
      platform: null,
      initialized: false,
      authenticated: false,
      disallowedCapabilitiesIsolated: false,
      webSearchMode: "live",
      mcpPolicy: this.mcpCapabilityRegistry.describePolicy(),
      lastErrorCode: null,
    };
  }

  async ensureServer() {
    if (this.startupPromise) {
      return this.startupPromise;
    }
    if (
      this.client
      && !this.client.closed
      && this.diagnostics.initialized
      && this.diagnostics.authenticated
    ) {
      return;
    }
    this.startupPromise = this.startServer();
    try {
      await this.startupPromise;
    } finally {
      this.startupPromise = null;
    }
  }

  async startServer() {
    const cliPath = resolveCodexCli(this.configuredCliPath, this.environment);
    this.diagnostics.cliPath = cliPath;
    const args = buildAppServerArgs();
    let childProcess;
    try {
      childProcess = this.spawnProcess(cliPath, args, {
        cwd: this.vaultRoot,
        env: buildCodexProcessEnvironment(this.environment, cliPath),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      throw this.rememberError(new CodexRuntimeError(
        "CodexNotFound",
        "无法启动本地 Codex，请检查“AI 功能”设置中的 CLI 路径。",
        { cause: error }
      ));
    }
    this.childProcess = childProcess;
    this.client = new JsonLineRpcClient(childProcess, {
      requestTimeoutMs: this.requestTimeoutMs,
    });
    this.client.on("notification", (message) => this.handleNotification(message));
    this.client.on("serverRequest", (message) => this.handleServerRequest(message));
    this.client.on("protocolError", (error) => {
      this.diagnostics.lastErrorCode = error.code;
    });
    this.client.on("exit", (error) => this.handleRuntimeExit(error));

    try {
      const initialize = await this.client.request("initialize", {
        clientInfo: {
          name: "lacan-translation-helper",
          title: "Lacan AI",
          version: this.pluginVersion,
        },
        capabilities: {
          experimentalApi: true,
          mcpServerOpenaiFormElicitation: false,
          requestAttestation: false,
        },
      });
      validateInitializeResponse(initialize);
      this.diagnostics.userAgent = initialize.userAgent;
      this.diagnostics.platform = initialize.platformOs;
      this.diagnostics.initialized = true;
      this.client.notify("initialized", {});

      const account = await this.client.request("account/read", {
        refreshToken: false,
      });
      if (account?.requiresOpenaiAuth && !account.account) {
        throw new CodexRuntimeError(
          "CodexAuthRequired",
          "Codex 尚未登录，请先在终端完成 Codex 登录。"
        );
      }
      this.diagnostics.authenticated = Boolean(account?.account)
        || account?.requiresOpenaiAuth === false;

      const inventory = await this.listMcpInventory();
      this.globalMcpServerNames = Array.from(new Set(
        inventory.map((server) => String(server?.name || "")).filter(Boolean)
      )).sort();
    } catch (error) {
      const mapped = this.mapProtocolError(error, "AppServerIncompatible");
      this.closeProcess();
      throw this.rememberError(mapped);
    }
  }

  async runTurn({
    threadId,
    baseInstructions,
    prompt,
    skillInputs = [],
    model,
    effort,
    onEvent = () => {},
  } = {}) {
    const normalizedPrompt = String(prompt || "").trim();
    const normalizedSkillInputs = normalizeSkillInputs(skillInputs);
    const effectiveModel = String(model || this.defaultModel || "").trim();
    const effectiveReasoningEffort = String(
      effort || this.defaultReasoningEffort || ""
    ).trim();
    if (!normalizedPrompt) {
      throw new CodexRuntimeError("EmptyPrompt", "没有可发送的解读请求。");
    }
    await this.ensureServer();

    const prepared = await this.prepareRestrictedThread({
      threadId: String(threadId || "").trim(),
      baseInstructions,
      model: effectiveModel,
    });
    const activeThreadId = prepared.thread.id;
    let response;
    try {
      response = await this.client.request("turn/start", {
        threadId: activeThreadId,
        input: [
          ...normalizedSkillInputs,
          { type: "text", text: normalizedPrompt },
        ],
        approvalPolicy: "never",
        cwd: this.vaultRoot,
        environments: [],
        runtimeWorkspaceRoots: [this.vaultRoot],
        sandboxPolicy: { ...READ_ONLY_SANDBOX_POLICY },
        ...(effectiveModel ? { model: effectiveModel } : {}),
        ...(effectiveReasoningEffort ? { effort: effectiveReasoningEffort } : {}),
      });
    } catch (error) {
      throw this.rememberError(this.mapProtocolError(error, "TurnFailed"));
    }
    const turnId = response?.turn?.id;
    if (!turnId) {
      throw this.rememberError(new CodexRuntimeError(
        "AppServerIncompatible",
        "App Server 未返回有效的 turn ID。"
      ));
    }

    return new Promise((resolve, reject) => {
      const key = turnEventKey(activeThreadId, turnId);
      const timeout = setTimeout(() => {
        if (!this.activeTurns.has(key)) {
          return;
        }
        this.activeTurns.delete(key);
        reject(this.rememberError(new CodexRuntimeError(
          "TurnTimeout",
          "本地 Agent 生成超时，可重试该分段。"
        )));
      }, this.turnTimeoutMs);
      this.activeTurns.set(key, {
        key,
        threadId: activeThreadId,
        turnId,
        text: "",
        onEvent,
        resolve,
        reject,
        timeout,
      });
      onEvent({
        type: "started",
        threadId: activeThreadId,
        turnId,
      });
      this.replayEarlyTurnEvents(activeThreadId, turnId);
    });
  }

  async startThread({ baseInstructions, model } = {}) {
    try {
      const response = await this.client.request("thread/start", {
        approvalPolicy: "never",
        baseInstructions: String(baseInstructions || ""),
        config: this.restrictedThreadConfig(),
        cwd: this.vaultRoot,
        dynamicTools: [],
        environments: [],
        runtimeWorkspaceRoots: [this.vaultRoot],
        sandbox: "read-only",
        selectedCapabilityRoots: [],
        ...(model ? { model } : {}),
      });
      validateRestrictedThread(response, this.vaultRoot);
      return response;
    } catch (error) {
      throw this.rememberError(this.mapProtocolError(error, "AppServerIncompatible"));
    }
  }

  async resumeThread(threadId, { baseInstructions, model } = {}) {
    let response;
    try {
      response = await this.client.request("thread/resume", {
        threadId,
        approvalPolicy: "never",
        baseInstructions: String(baseInstructions || ""),
        config: this.restrictedThreadConfig(),
        cwd: this.vaultRoot,
        runtimeWorkspaceRoots: [this.vaultRoot],
        sandbox: "read-only",
        ...(model ? { model } : {}),
      });
    } catch (error) {
      throw this.rememberError(new CodexRuntimeError(
        "ThreadUnavailable",
        "旧解读会话无法恢复，可以新建会话重新解读。",
        { cause: error }
      ));
    }
    validateRestrictedThread(response, this.vaultRoot);
    return response;
  }

  async restoreThread({ threadId, baseInstructions, model } = {}) {
    await this.ensureServer();
    const response = await this.prepareRestrictedThread({
      threadId,
      baseInstructions,
      model,
    });
    return {
      threadId: response.thread.id,
      text: extractLatestAgentText(response.thread),
      status: extractLatestTurnStatus(response.thread),
      thread: response.thread,
    };
  }

  prepareRestrictedThread({ threadId, baseInstructions, model } = {}) {
    const prepare = this.threadPreparationQueue.then(async () => {
      const response = String(threadId || "").trim()
        ? await this.resumeThread(String(threadId).trim(), {
            baseInstructions,
            model,
          })
        : await this.startThread({ baseInstructions, model });
      await this.assertDisallowedCapabilitiesIsolated(response.thread.id);
      return response;
    }, async () => {
      const response = String(threadId || "").trim()
        ? await this.resumeThread(String(threadId).trim(), {
            baseInstructions,
            model,
          })
        : await this.startThread({ baseInstructions, model });
      await this.assertDisallowedCapabilitiesIsolated(response.thread.id);
      return response;
    });
    this.threadPreparationQueue = prepare.catch(() => {});
    return prepare;
  }

  restrictedThreadConfig() {
    const disabledMcpServers = this.mcpCapabilityRegistry
      .buildDisabledServerConfig(this.globalMcpServerNames);
    return {
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
      features: DISABLED_FEATURES.reduce((result, feature) => {
        result[feature] = false;
        return result;
      }, {}),
      mcp_servers: disabledMcpServers,
      web_search: "live",
    };
  }

  async listModels() {
    await this.ensureServer();
    const rawModels = [];
    const seenCursors = new Set();
    let cursor = null;
    try {
      do {
        const response = await this.client.request("model/list", {
          ...(cursor ? { cursor } : {}),
          includeHidden: false,
          limit: 100,
        });
        if (!Array.isArray(response?.data)) {
          throw new CodexRuntimeError(
            "AppServerIncompatible",
            "Codex App Server 没有返回有效的模型列表。"
          );
        }
        rawModels.push(...response.data);
        const nextCursor = typeof response.nextCursor === "string"
          && response.nextCursor.trim()
          ? response.nextCursor.trim()
          : null;
        if (nextCursor && seenCursors.has(nextCursor)) {
          throw new CodexRuntimeError(
            "AppServerIncompatible",
            "Codex App Server 返回了重复的模型分页游标。"
          );
        }
        if (nextCursor) {
          seenCursors.add(nextCursor);
        }
        cursor = nextCursor;
      } while (cursor);
      return normalizeCodexModelCatalog(rawModels);
    } catch (error) {
      throw this.rememberError(this.mapProtocolError(error, "ModelDiscoveryFailed"));
    }
  }

  async listSkills({ forceReload = false } = {}) {
    await this.ensureServer();
    try {
      const response = await this.client.request("skills/list", {
        cwds: [this.vaultRoot],
        ...(forceReload ? { forceReload: true } : {}),
      });
      const groups = Array.isArray(response?.data)
        ? response.data
        : Array.isArray(response?.skills)
          ? [{ cwd: this.vaultRoot, skills: response.skills }]
          : [];
      if (groups.length === 0 && !Array.isArray(response?.data)) {
        throw new CodexRuntimeError(
          "AppServerIncompatible",
          "Codex App Server 没有返回有效的 Skill 清单。"
        );
      }
      return groups.flatMap((group) => (
        Array.isArray(group?.skills) ? group.skills : []
      )).map((skill) => ({
        ...skill,
        name: String(skill?.name || "").trim(),
        description: String(skill?.description || "").trim(),
        path: String(skill?.path || "").trim(),
        scope: String(skill?.scope || "").trim(),
        enabled: skill?.enabled !== false,
      })).filter((skill) => skill.name && skill.path && skill.scope);
    } catch (error) {
      throw this.rememberError(this.mapProtocolError(error, "SkillDiscoveryFailed"));
    }
  }

  onSkillsChanged(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }
    this.skillChangeListeners.add(listener);
    return () => this.skillChangeListeners.delete(listener);
  }

  async listMcpInventory(threadId) {
    const inventory = [];
    let cursor;
    do {
      const response = await this.client.request("mcpServerStatus/list", {
        detail: "toolsAndAuthOnly",
        limit: 100,
        ...(threadId ? { threadId } : {}),
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(response?.data)) {
        throw new CodexRuntimeError(
          "AppServerIncompatible",
          "App Server 无法提供 MCP 工具清单。"
        );
      }
      inventory.push(...response.data);
      cursor = response.nextCursor || null;
    } while (cursor);
    return inventory;
  }

  assertDisallowedCapabilitiesIsolated(threadId) {
    const check = this.capabilityCheckQueue.then(
      () => this.performDisallowedCapabilityCheck(threadId),
      () => this.performDisallowedCapabilityCheck(threadId)
    );
    this.capabilityCheckQueue = check.catch(() => {});
    return check;
  }

  async performDisallowedCapabilityCheck(threadId) {
    let inventory;
    try {
      inventory = await this.listMcpInventory(threadId);
    } catch (error) {
      throw this.rememberError(this.mapProtocolError(error, "AppServerIncompatible"));
    }
    try {
      this.mcpCapabilityRegistry.assertNoExposedCapabilities(inventory);
    } catch (error) {
      throw this.rememberError(new CodexRuntimeError(
        "ExternalToolsAvailable",
        "无法确认本次解读已隔离 MCP 工具，因此没有启动 Agent 回合。",
        {
          cause: error,
          exposedServerNames: error.exposedServerNames || [],
        }
      ));
    }

    try {
      const apps = await this.client.request("app/list", {
        threadId,
        forceRefetch: false,
        limit: 100,
      });
      const exposedApps = (apps?.data || []).filter((app) => (
        app?.isEnabled !== false && app?.isAccessible === true
      ));
      if (exposedApps.length > 0) {
        throw new CodexRuntimeError(
          "ExternalToolsAvailable",
          "无法确认本次解读已隔离 Apps，因此没有启动 Agent 回合。",
          { exposedAppIds: exposedApps.map((app) => app.id).filter(Boolean) }
        );
      }
    } catch (error) {
      if (!(error instanceof AppServerProtocolError && error.rpcCode === -32601)) {
        throw this.rememberError(this.mapProtocolError(error, "AppServerIncompatible"));
      }
    }

    this.diagnostics.disallowedCapabilitiesIsolated = true;
  }

  handleNotification(message) {
    const method = message?.method;
    const params = message?.params || {};
    if (method === "skills/changed") {
      for (const listener of this.skillChangeListeners) {
        try {
          listener(params);
        } catch (_error) {
          // Catalog invalidation must not interrupt App Server event routing.
        }
      }
      return;
    }
    if (
      method !== "item/agentMessage/delta"
      && method !== "item/completed"
      && method !== "turn/completed"
      && method !== "error"
    ) {
      return;
    }
    const threadId = params.threadId;
    const turnId = params.turnId || params.turn?.id;
    const key = threadId && turnId ? turnEventKey(threadId, turnId) : "";
    const active = key ? this.activeTurns.get(key) : null;
    if (active) {
      this.applyTurnEvent(message, active);
      return;
    }
    if (threadId && turnId) {
      const key = turnEventKey(threadId, turnId);
      const buffered = this.earlyTurnEvents.get(key) || [];
      if (buffered.length < 1000) {
        buffered.push(message);
        this.earlyTurnEvents.set(key, buffered);
      }
    }
  }

  replayEarlyTurnEvents(threadId, turnId) {
    const key = turnEventKey(threadId, turnId);
    const buffered = this.earlyTurnEvents.get(key) || [];
    this.earlyTurnEvents.delete(key);
    for (const message of buffered) {
      const active = this.activeTurns.get(key);
      if (!active) {
        break;
      }
      this.applyTurnEvent(message, active);
    }
  }

  applyTurnEvent(message, active) {
    if (!active) {
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      const delta = String(message.params?.delta || "");
      active.text += delta;
      active.onEvent({
        type: "delta",
        delta,
        text: active.text,
        threadId: active.threadId,
        turnId: active.turnId,
      });
      return;
    }
    if (
      message.method === "item/completed"
      && message.params?.item?.type === "agentMessage"
    ) {
      const completedText = String(message.params.item.text || "");
      if (completedText && completedText !== active.text) {
        const delta = completedText.startsWith(active.text)
          ? completedText.slice(active.text.length)
          : completedText;
        active.text = completedText;
        active.onEvent({
          type: "delta",
          delta,
          text: active.text,
          threadId: active.threadId,
          turnId: active.turnId,
        });
      }
      return;
    }
    if (message.method === "error" && message.params?.willRetry === false) {
      this.finishTurnWithError(active.key, new CodexRuntimeError(
        mapCodexErrorCode(message.params),
        safeTurnErrorMessage(message.params)
      ));
      return;
    }
    if (message.method === "turn/completed") {
      const status = String(message.params?.turn?.status || "failed");
      if (status === "failed") {
        this.finishTurnWithError(active.key, new CodexRuntimeError(
          mapCodexErrorCode(message.params?.turn?.error),
          safeTurnErrorMessage(message.params?.turn?.error)
        ));
        return;
      }
      if (status === "completed" && !active.text.trim()) {
        this.finishTurnWithError(active.key, new CodexRuntimeError(
          "EmptyAgentResponse",
          "本地 Agent 已结束，但没有返回可显示的解读，请重新解读。"
        ));
        return;
      }
      clearTimeout(active.timeout);
      this.activeTurns.delete(active.key);
      active.onEvent({
        type: "completed",
        status,
        text: active.text,
        threadId: active.threadId,
        turnId: active.turnId,
      });
      active.resolve({
        threadId: active.threadId,
        turnId: active.turnId,
        text: active.text,
        status,
      });
    }
  }

  handleServerRequest(message) {
    if (this.activeTurns.size === 0) {
      return;
    }
    const params = message?.params || {};
    const threadId = params.threadId;
    const turnId = params.turnId || params.turn?.id;
    const key = threadId && turnId ? turnEventKey(threadId, turnId) : "";
    const error = new CodexRuntimeError(
      "ApprovalRequested",
      "本地 Agent 请求了未授权操作，本次解读已停止。",
      { method: message?.method }
    );
    if (key && this.activeTurns.has(key)) {
      this.finishTurnWithError(key, error);
      return;
    }
    for (const activeKey of [...this.activeTurns.keys()]) {
      this.finishTurnWithError(activeKey, error);
    }
  }

  handleRuntimeExit(error) {
    for (const key of [...this.activeTurns.keys()]) {
      this.finishTurnWithError(key, new CodexRuntimeError(
        "AppServerExited",
        "本地 Agent 意外退出，可手动重试。",
        { cause: error }
      ));
    }
    this.client = null;
    this.childProcess = null;
    this.diagnostics.initialized = false;
    this.diagnostics.authenticated = false;
    this.diagnostics.disallowedCapabilitiesIsolated = false;
  }

  finishTurnWithError(key, error) {
    const active = this.activeTurns.get(key);
    if (!active) {
      return;
    }
    clearTimeout(active.timeout);
    this.activeTurns.delete(key);
    this.rememberError(error);
    active.onEvent({
      type: "failed",
      code: error.code,
      message: error.message,
      text: active.text,
      threadId: active.threadId,
      turnId: active.turnId,
    });
    active.reject(error);
  }

  async interrupt(target = {}) {
    let active;
    const threadId = String(target?.threadId || "").trim();
    const turnId = String(target?.turnId || "").trim();
    if (threadId && turnId) {
      active = this.activeTurns.get(turnEventKey(threadId, turnId));
    } else if (this.activeTurns.size === 1) {
      active = this.activeTurns.values().next().value;
    }
    if (!active || !this.client) {
      return false;
    }
    await this.client.request("turn/interrupt", {
      threadId: active.threadId,
      turnId: active.turnId,
    });
    return true;
  }

  async shutdown() {
    if (this.activeTurns.size > 0 && this.client && !this.client.closed) {
      await Promise.allSettled(
        [...this.activeTurns.values()].map((active) => this.interrupt({
          threadId: active.threadId,
          turnId: active.turnId,
        }))
      );
    }
    for (const key of [...this.activeTurns.keys()]) {
      this.finishTurnWithError(key, new CodexRuntimeError(
        "TurnInterrupted",
        "本地 Agent 已随插件关闭而停止。"
      ));
    }
    this.closeProcess();
  }

  closeProcess() {
    if (this.client) {
      this.client.close();
    } else if (this.childProcess && typeof this.childProcess.kill === "function") {
      this.childProcess.kill();
    }
    this.client = null;
    this.childProcess = null;
    this.diagnostics.initialized = false;
    this.diagnostics.disallowedCapabilitiesIsolated = false;
  }

  getDiagnostics() {
    return {
      ...this.diagnostics,
      activeTurnCount: this.activeTurns.size,
    };
  }

  rememberError(error) {
    this.diagnostics.lastErrorCode = error?.code || "Unknown";
    return error;
  }

  mapProtocolError(error, fallbackCode) {
    if (error instanceof CodexRuntimeError) {
      return error;
    }
    if (error instanceof AppServerProtocolError) {
      if (error.rpcCode === -32601 || error.rpcCode === -32602) {
        return new CodexRuntimeError(
          "AppServerIncompatible",
          "当前 Codex App Server 与插件所需协议不兼容。",
          { cause: error }
        );
      }
      if (/unauthori[sz]ed|not logged in|login/i.test(error.message)) {
        return new CodexRuntimeError(
          "CodexAuthRequired",
          "Codex 尚未登录，请先在终端完成 Codex 登录。",
          { cause: error }
        );
      }
    }
    const fallbackMessages = {
      AppServerIncompatible: "本地 Agent 初始化失败，请查看脱敏诊断后重试。",
      ModelDiscoveryFailed: "无法从本机 Codex 获取模型列表，请检查 CLI 路径和登录状态。",
      SkillDiscoveryFailed: "无法从本机 Codex 获取 Skill 清单，请检查 CLI 路径和登录状态。",
      TurnFailed: "本地 Agent 未能启动本次解读，可重试或复制脱敏诊断。",
    };
    return new CodexRuntimeError(
      fallbackCode,
      fallbackMessages[fallbackCode] || "本地 Agent 操作失败，请查看脱敏诊断后重试。",
      { cause: error }
    );
  }
}

const buildAppServerArgs = () => {
  const args = ["app-server", "--stdio"];
  for (const feature of DISABLED_FEATURES) {
    args.push("--disable", feature);
  }
  args.push(
    "-c",
    'web_search="live"',
    "-c",
    "mcp_servers={}",
    "-c",
    'shell_environment_policy.inherit="none"'
  );
  return args;
};

const buildCodexProcessEnvironment = (environment, cliPath) => {
  const source = environment && typeof environment === "object"
    ? environment
    : {};
  const pathKey = Object.keys(source).find(
    (key) => key.toLowerCase() === "path"
  ) || "PATH";
  const currentEntries = String(source[pathKey] || "")
    .split(path.delimiter)
    .filter(Boolean);
  const cliDirectory = path.dirname(path.resolve(cliPath));
  const seen = new Set();
  const entries = [cliDirectory, ...currentEntries].filter((entry) => {
    const key = process.platform === "win32" ? entry.toLowerCase() : entry;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return {
    ...source,
    [pathKey]: entries.join(path.delimiter),
  };
};

const resolveCodexCli = (configuredPath, environment = process.env) => {
  const configured = String(configuredPath || "").trim();
  if (configured) {
    if (!path.isAbsolute(configured) || !isExecutable(configured)) {
      throw new CodexRuntimeError(
        "CodexNotFound",
        "设置中的 Codex CLI 路径无效，请选择可执行文件的绝对路径。"
      );
    }
    return configured;
  }
  const pathEntries = String(environment?.PATH || "").split(path.delimiter).filter(Boolean);
  const executableNames = process.platform === "win32"
    ? ["codex.exe", "codex.cmd", "codex"]
    : ["codex"];
  for (const directory of pathEntries) {
    for (const executableName of executableNames) {
      const candidate = path.join(directory, executableName);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  throw new CodexRuntimeError(
    "CodexNotFound",
    "未找到本地 Codex。请安装 Codex CLI，或在插件设置中配置其绝对路径。"
  );
};

const isExecutable = (candidate) => {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch (_error) {
    return false;
  }
};

const validateInitializeResponse = (response) => {
  if (
    !response
    || typeof response.userAgent !== "string"
    || typeof response.platformOs !== "string"
  ) {
    throw new CodexRuntimeError(
      "AppServerIncompatible",
      "当前 Codex App Server 没有返回必要的协议能力。"
    );
  }
};

const validateRestrictedThread = (response, vaultRoot) => {
  const sandbox = response?.sandbox;
  const readOnly = sandbox === "read-only" || sandbox?.type === "readOnly";
  const roots = Array.isArray(response?.runtimeWorkspaceRoots)
    ? response.runtimeWorkspaceRoots.map((root) => path.resolve(root))
    : [];
  const rootsAreRestricted = roots.length === 0
    || (roots.length === 1 && roots[0] === vaultRoot);
  if (
    !response?.thread?.id
    || response.approvalPolicy !== "never"
    || !readOnly
    || path.resolve(String(response.cwd || "")) !== vaultRoot
    || !rootsAreRestricted
  ) {
    throw new CodexRuntimeError(
      "ReadOnlyBoundaryRejected",
      "App Server 未确认只读 Vault 边界，因此没有启动解读。"
    );
  }
};

const normalizeCodexModelCatalog = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  const models = [];
  const seen = new Set();
  for (const item of value) {
    if (!item || typeof item !== "object" || item.hidden === true) {
      continue;
    }
    const model = String(item.model || item.id || "").trim();
    if (!model || seen.has(model)) {
      continue;
    }
    seen.add(model);
    const supportedReasoningEfforts = Array.isArray(item.supportedReasoningEfforts)
      ? item.supportedReasoningEfforts
          .map((effort) => ({
            value: String(
              effort?.reasoningEffort || effort?.value || ""
            ).trim(),
            description: String(effort?.description || "").trim(),
          }))
          .filter((effort) => effort.value)
      : [];
    models.push({
      model,
      displayName: String(item.displayName || model).trim() || model,
      description: String(item.description || "").trim(),
      isDefault: item.isDefault === true,
      supportedReasoningEfforts,
      defaultReasoningEffort: String(item.defaultReasoningEffort || "").trim(),
    });
  }
  return models;
};

const resolveCodexReasoningProfile = (catalog, selectedModel = "") => {
  const models = normalizeCodexModelCatalog(catalog);
  const modelId = String(selectedModel || "").trim();
  const model = modelId
    ? models.find((entry) => entry.model === modelId)
    : models.find((entry) => entry.isDefault);
  if (!model) {
    return null;
  }
  return {
    model: model.model,
    defaultReasoningEffort: model.defaultReasoningEffort,
    supportedReasoningEfforts: model.supportedReasoningEfforts.map(
      (effort) => ({ ...effort })
    ),
  };
};

const coerceCodexReasoningEffort = (
  catalog,
  selectedModel,
  reasoningEffort
) => {
  const value = String(reasoningEffort || "").trim();
  if (!value) {
    return "";
  }
  const profile = resolveCodexReasoningProfile(catalog, selectedModel);
  if (!profile) {
    return value;
  }
  return profile.supportedReasoningEfforts.some(
    (effort) => effort.value === value
  )
    ? value
    : "";
};

const normalizeSkillInputs = (value) => {
  if (!Array.isArray(value)) {
    throw new CodexRuntimeError(
      "SkillInvocationRejected",
      "Skill 输入格式无效，请刷新 Skill 方案。"
    );
  }
  const inputs = [];
  const seen = new Set();
  for (const item of value.slice(0, 3)) {
    const name = String(item?.name || "").trim();
    const skillPath = String(item?.path || "").trim();
    if (
      item?.type !== "skill"
      || !name
      || !path.isAbsolute(skillPath)
    ) {
      throw new CodexRuntimeError(
        "SkillInvocationRejected",
        "Skill 输入无法通过安全校验，请刷新 Skill 方案。"
      );
    }
    const key = `${name}::${skillPath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    inputs.push({
      type: "skill",
      name,
      path: skillPath,
    });
  }
  return inputs;
};

const extractLatestAgentText = (thread) => {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const items = Array.isArray(turns[turnIndex]?.items) ? turns[turnIndex].items : [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        return item.text;
      }
    }
  }
  return "";
};

const extractLatestTurnStatus = (thread) => {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  return String(turns.at(-1)?.status || "");
};

const turnEventKey = (threadId, turnId) => `${threadId}::${turnId}`;

const mapCodexErrorCode = (value) => {
  const serialized = JSON.stringify(value || "");
  if (/unauthorized/i.test(serialized)) {
    return "CodexAuthRequired";
  }
  if (/sandbox/i.test(serialized)) {
    return "ReadOnlyBoundaryRejected";
  }
  return "TurnFailed";
};

const safeTurnErrorMessage = (value) => {
  const code = mapCodexErrorCode(value);
  if (code === "CodexAuthRequired") {
    return "Codex 登录已失效，请重新登录后重试。";
  }
  if (code === "ReadOnlyBoundaryRejected") {
    return "只读沙箱拒绝了本次操作；插件不会申请权限提升。";
  }
  return "本地 Agent 未能完成解读，可重试或复制脱敏诊断。";
};

module.exports = {
  CodexAppServerRuntime,
  CodexRuntimeError,
  DISABLED_FEATURES,
  READ_ONLY_SANDBOX_POLICY,
  buildAppServerArgs,
  buildCodexProcessEnvironment,
  coerceCodexReasoningEffort,
  extractLatestAgentText,
  normalizeCodexModelCatalog,
  normalizeSkillInputs,
  resolveCodexCli,
  resolveCodexReasoningProfile,
  validateRestrictedThread,
};
