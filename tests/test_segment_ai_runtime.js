const assert = require("assert");
const { EventEmitter } = require("events");
const path = require("path");
const { PassThrough } = require("stream");

const runtimeModulePath = path.join(
  __dirname,
  "..",
  ".obsidian",
  "plugins",
  "lacan-translation-helper",
  "segment-ai",
  "codex-app-server-runtime.js"
);

const {
  CodexAppServerRuntime,
  READ_ONLY_SANDBOX_POLICY,
  coerceCodexReasoningEffort,
  normalizeCodexModelCatalog,
  resolveCodexCli,
  resolveCodexReasoningProfile,
} = require(runtimeModulePath);

const VAULT_ROOT = "/Users/example/Lacan-Vault";
const CLI_PATH = process.execPath;

assert.strictEqual(resolveCodexCli(CLI_PATH), CLI_PATH);
assert.throws(
  () => resolveCodexCli("/definitely/missing/codex"),
  (error) => error.code === "CodexNotFound"
);

class ScriptedAppServerProcess extends EventEmitter {
  constructor(handler) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    this.killed = false;
    this.handler = handler;
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const message = JSON.parse(line);
        this.messages.push(message);
        this.handler(message, this);
      }
    });
  }

  respond(request, result) {
    this.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  }

  fail(request, code, message) {
    this.stdout.write(`${JSON.stringify({
      id: request.id,
      error: { code, message },
    })}\n`);
  }

  notify(method, params) {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }

  kill() {
    this.killed = true;
    this.emit("exit", 0, null);
  }
}

const initializeResponse = {
  codexHome: "/Users/example/.codex",
  platformFamily: "unix",
  platformOs: "macos",
  userAgent: "codex-cli/0.144.5",
};

const accountResponse = {
  account: {
    email: "reader@example.com",
    planType: "plus",
    type: "chatgpt",
  },
  requiresOpenaiAuth: true,
};

const threadResponse = (threadId) => ({
  activePermissionProfile: null,
  approvalPolicy: "never",
  approvalsReviewer: "user",
  cwd: VAULT_ROOT,
  instructionSources: [],
  model: "gpt-5.6-terra",
  modelProvider: "openai",
  multiAgentMode: "explicitRequestOnly",
  reasoningEffort: null,
  runtimeWorkspaceRoots: [VAULT_ROOT],
  sandbox: {
    type: "readOnly",
    networkAccess: false,
  },
  serviceTier: null,
  thread: {
    id: threadId,
    preview: "",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    path: null,
    cwd: VAULT_ROOT,
    cliVersion: "0.144.5",
    source: "appServer",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    turns: [],
  },
});

const turn = (id, status) => ({
  id,
  items: [],
  status,
  error: null,
});

const globalMcpInventory = {
  data: [
    {
      authStatus: "unsupported",
      name: "global-server",
      resourceTemplates: [],
      resources: [],
      tools: {
        lookup: {
          name: "lookup",
          description: "A configured global tool.",
          inputSchema: { type: "object" },
        },
      },
    },
  ],
  nextCursor: null,
};

const isolatedMcpInventory = {
  data: [],
  nextCursor: null,
};

const createHappyHandler = () => (message, process) => {
  if (!Object.prototype.hasOwnProperty.call(message, "id")) {
    return;
  }
  switch (message.method) {
    case "initialize":
      process.respond(message, initializeResponse);
      break;
    case "account/read":
      process.respond(message, accountResponse);
      break;
    case "mcpServerStatus/list":
      process.respond(
        message,
        message.params.threadId ? isolatedMcpInventory : globalMcpInventory
      );
      break;
    case "thread/start":
      process.respond(message, threadResponse("thread-1"));
      break;
    case "app/list":
      process.respond(message, { data: [], nextCursor: null });
      break;
    case "turn/start":
      process.respond(message, { turn: turn("turn-1", "inProgress") });
      setImmediate(() => {
        process.notify("unknown/notification", { ignored: true });
        process.notify("item/agentMessage/delta", {
          delta: "第一段",
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
        });
        process.notify("item/agentMessage/delta", {
          delta: "第二段",
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
        });
        process.notify("turn/completed", {
          threadId: "thread-1",
          turn: turn("turn-1", "completed"),
        });
      });
      break;
    default:
      process.fail(message, -32601, `Unsupported test method: ${message.method}`);
  }
};

const runHappyPath = async () => {
  const spawnCalls = [];
  let fakeProcess;
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    pluginVersion: "0.5.0",
    cliPath: CLI_PATH,
    defaultModel: "gpt-5.6-terra",
    defaultReasoningEffort: "xhigh",
    spawnProcess: (binary, args, options) => {
      spawnCalls.push({ binary, args, options });
      fakeProcess = new ScriptedAppServerProcess(createHappyHandler());
      return fakeProcess;
    },
    requestTimeoutMs: 200,
  });
  const events = [];
  const result = await runtime.runTurn({
    baseInstructions: "只能只读解释。",
    prompt: "请解释这个分段。",
    skillInputs: [{
      type: "skill",
      name: "translate-lacan-seminars",
      path: `${VAULT_ROOT}/.agents/skills/translate-lacan-seminars/SKILL.md`,
    }],
    onEvent: (event) => events.push(event),
  });

  assert.deepStrictEqual(result, {
    threadId: "thread-1",
    turnId: "turn-1",
    text: "第一段第二段",
    status: "completed",
  });
  assert.deepStrictEqual(
    events.filter((event) => event.type === "delta").map((event) => event.delta),
    ["第一段", "第二段"]
  );

  assert.strictEqual(spawnCalls.length, 1);
  assert.strictEqual(spawnCalls[0].binary, CLI_PATH);
  assert.strictEqual(spawnCalls[0].options.cwd, VAULT_ROOT);
  assert.strictEqual(
    spawnCalls[0].options.env.PATH.split(path.delimiter)[0],
    path.dirname(CLI_PATH)
  );
  for (const feature of ["apps", "plugins", "multi_agent", "standalone_web_search"]) {
    const featureIndex = spawnCalls[0].args.indexOf(feature);
    assert.ok(featureIndex > 0);
    assert.strictEqual(spawnCalls[0].args[featureIndex - 1], "--disable");
  }
  assert.ok(spawnCalls[0].args.includes('web_search="disabled"'));

  const threadStart = fakeProcess.messages.find((message) => message.method === "thread/start");
  assert.strictEqual(threadStart.params.cwd, VAULT_ROOT);
  assert.deepStrictEqual(threadStart.params.runtimeWorkspaceRoots, [VAULT_ROOT]);
  assert.strictEqual(threadStart.params.approvalPolicy, "never");
  assert.strictEqual(threadStart.params.sandbox, "read-only");
  assert.deepStrictEqual(threadStart.params.dynamicTools, []);
  assert.deepStrictEqual(threadStart.params.environments, []);
  assert.deepStrictEqual(threadStart.params.selectedCapabilityRoots, []);
  assert.strictEqual(threadStart.params.model, "gpt-5.6-terra");
  assert.strictEqual(
    threadStart.params.config.mcp_servers["global-server"].enabled,
    false
  );
  assert.strictEqual(threadStart.params.config.apps._default.enabled, false);
  assert.strictEqual(threadStart.params.config.web_search, "disabled");

  const turnStart = fakeProcess.messages.find((message) => message.method === "turn/start");
  assert.deepStrictEqual(turnStart.params.sandboxPolicy, READ_ONLY_SANDBOX_POLICY);
  assert.strictEqual(turnStart.params.approvalPolicy, "never");
  assert.deepStrictEqual(turnStart.params.runtimeWorkspaceRoots, [VAULT_ROOT]);
  assert.deepStrictEqual(turnStart.params.environments, []);
  assert.strictEqual(turnStart.params.model, "gpt-5.6-terra");
  assert.strictEqual(turnStart.params.effort, "xhigh");
  assert.deepStrictEqual(turnStart.params.input, [
    {
      type: "skill",
      name: "translate-lacan-seminars",
      path: `${VAULT_ROOT}/.agents/skills/translate-lacan-seminars/SKILL.md`,
    },
    { type: "text", text: "请解释这个分段。" },
  ]);

  const diagnostics = runtime.getDiagnostics();
  assert.strictEqual(diagnostics.userAgent, "codex-cli/0.144.5");
  assert.strictEqual(diagnostics.externalCapabilitiesIsolated, true);
  assert.ok(!JSON.stringify(diagnostics).includes("reader@example.com"));

  await runtime.shutdown();
  assert.strictEqual(fakeProcess.killed, true);
};

const runItemCompletedFallback = async () => {
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => new ScriptedAppServerProcess((message, process) => {
      if (!Object.prototype.hasOwnProperty.call(message, "id")) {
        return;
      }
      switch (message.method) {
        case "initialize":
          process.respond(message, initializeResponse);
          break;
        case "account/read":
          process.respond(message, accountResponse);
          break;
        case "mcpServerStatus/list":
          process.respond(
            message,
            message.params.threadId ? isolatedMcpInventory : globalMcpInventory
          );
          break;
        case "thread/start":
          process.respond(message, threadResponse("thread-item-completed"));
          break;
        case "app/list":
          process.respond(message, { data: [], nextCursor: null });
          break;
        case "turn/start":
          process.respond(message, {
            turn: turn("turn-item-completed", "inProgress"),
          });
          setImmediate(() => {
            process.notify("item/completed", {
              completedAtMs: 1,
              threadId: "thread-item-completed",
              turnId: "turn-item-completed",
              item: {
                id: "item-final",
                type: "agentMessage",
                text: "只在完成事件中出现的回答。",
                phase: "final_answer",
                memoryCitation: null,
              },
            });
            process.notify("turn/completed", {
              threadId: "thread-item-completed",
              turn: turn("turn-item-completed", "completed"),
            });
          });
          break;
        default:
          process.fail(message, -32601, `Unsupported test method: ${message.method}`);
      }
    }),
    requestTimeoutMs: 200,
  });

  const events = [];
  const result = await runtime.runTurn({
    baseInstructions: "只能只读解释。",
    prompt: "请解释这个分段。",
    onEvent: (event) => events.push(event),
  });
  assert.strictEqual(result.text, "只在完成事件中出现的回答。");
  assert.strictEqual(events.at(-2).type, "delta");
  assert.strictEqual(events.at(-2).text, result.text);
  await runtime.shutdown();
};

const runEmptyCompletedFailure = async () => {
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => new ScriptedAppServerProcess((message, process) => {
      if (!Object.prototype.hasOwnProperty.call(message, "id")) {
        return;
      }
      switch (message.method) {
        case "initialize":
          process.respond(message, initializeResponse);
          break;
        case "account/read":
          process.respond(message, accountResponse);
          break;
        case "mcpServerStatus/list":
          process.respond(
            message,
            message.params.threadId ? isolatedMcpInventory : globalMcpInventory
          );
          break;
        case "thread/start":
          process.respond(message, threadResponse("thread-empty"));
          break;
        case "app/list":
          process.respond(message, { data: [], nextCursor: null });
          break;
        case "turn/start":
          process.respond(message, { turn: turn("turn-empty", "inProgress") });
          setImmediate(() => {
            process.notify("turn/completed", {
              threadId: "thread-empty",
              turn: turn("turn-empty", "completed"),
            });
          });
          break;
        default:
          process.fail(message, -32601, `Unsupported test method: ${message.method}`);
      }
    }),
    requestTimeoutMs: 200,
  });

  await assert.rejects(
    runtime.runTurn({
      baseInstructions: "只能只读解释。",
      prompt: "请解释这个分段。",
    }),
    (error) => error.code === "EmptyAgentResponse"
  );
  await runtime.shutdown();
};

const runIsolationFailure = async () => {
  let fakeProcess;
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => {
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (!Object.prototype.hasOwnProperty.call(message, "id")) {
          return;
        }
        switch (message.method) {
          case "initialize":
            process.respond(message, initializeResponse);
            break;
          case "account/read":
            process.respond(message, accountResponse);
            break;
          case "mcpServerStatus/list":
            process.respond(message, globalMcpInventory);
            break;
          case "thread/start":
            process.respond(message, threadResponse("thread-unsafe"));
            break;
          case "app/list":
            process.respond(message, { data: [], nextCursor: null });
            break;
          default:
            process.fail(message, -32601, "Not expected");
        }
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
  });

  await assert.rejects(
    runtime.runTurn({
      baseInstructions: "只读。",
      prompt: "解释。",
    }),
    (error) => error.code === "ExternalToolsAvailable"
  );
  assert.strictEqual(
    fakeProcess.messages.some((message) => message.method === "turn/start"),
    false
  );
  await runtime.shutdown();
};

const runAppIsolationFailure = async () => {
  let fakeProcess;
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => {
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (!Object.prototype.hasOwnProperty.call(message, "id")) {
          return;
        }
        switch (message.method) {
          case "initialize":
            process.respond(message, initializeResponse);
            break;
          case "account/read":
            process.respond(message, accountResponse);
            break;
          case "mcpServerStatus/list":
            process.respond(message, isolatedMcpInventory);
            break;
          case "thread/start":
            process.respond(message, threadResponse("thread-app-unsafe"));
            break;
          case "app/list":
            process.respond(message, {
              data: [{
                id: "unsafe-app",
                name: "Unsafe App",
                isAccessible: true,
                isEnabled: true,
                pluginDisplayNames: [],
              }],
              nextCursor: null,
            });
            break;
          default:
            process.fail(message, -32601, "Not expected");
        }
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
  });
  await assert.rejects(
    runtime.runTurn({
      baseInstructions: "只读。",
      prompt: "解释。",
    }),
    (error) => error.code === "ExternalToolsAvailable"
  );
  assert.strictEqual(
    fakeProcess.messages.some((message) => message.method === "turn/start"),
    false
  );
  await runtime.shutdown();
};

const runRestore = async () => {
  let fakeProcess;
  const restoredThreadResponse = threadResponse("thread-old");
  restoredThreadResponse.thread.turns = [{
    id: "turn-old",
    items: [{
      id: "item-old",
      type: "agentMessage",
      text: "已恢复的解读。",
      phase: "final_answer",
      memoryCitation: null,
    }],
    status: "completed",
    error: null,
  }];
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => {
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (!Object.prototype.hasOwnProperty.call(message, "id")) {
          return;
        }
        switch (message.method) {
          case "initialize":
            process.respond(message, initializeResponse);
            break;
          case "account/read":
            process.respond(message, accountResponse);
            break;
          case "mcpServerStatus/list":
            process.respond(message, isolatedMcpInventory);
            break;
          case "thread/resume":
            process.respond(message, restoredThreadResponse);
            break;
          case "app/list":
            process.respond(message, { data: [], nextCursor: null });
            break;
          default:
            process.fail(message, -32601, "Not expected");
        }
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
  });
  const restored = await runtime.restoreThread({
    threadId: "thread-old",
    baseInstructions: "仍然只读。",
  });
  assert.strictEqual(restored.threadId, "thread-old");
  assert.strictEqual(restored.text, "已恢复的解读。");
  assert.strictEqual(restored.status, "completed");
  const resumeMessage = fakeProcess.messages.find(
    (message) => message.method === "thread/resume"
  );
  assert.strictEqual(resumeMessage.params.approvalPolicy, "never");
  assert.strictEqual(resumeMessage.params.sandbox, "read-only");
  assert.deepStrictEqual(resumeMessage.params.runtimeWorkspaceRoots, [VAULT_ROOT]);
  assert.strictEqual(
    fakeProcess.messages.some((message) => message.method === "turn/start"),
    false
  );
  await runtime.shutdown();
};

const runModelDiscovery = async () => {
  let fakeProcess;
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => {
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (!Object.prototype.hasOwnProperty.call(message, "id")) {
          return;
        }
        switch (message.method) {
          case "initialize":
            process.respond(message, initializeResponse);
            break;
          case "account/read":
            process.respond(message, accountResponse);
            break;
          case "mcpServerStatus/list":
            process.respond(message, isolatedMcpInventory);
            break;
          case "model/list":
            if (message.params.cursor === "page-2") {
              process.respond(message, {
                data: [{
                  model: "gpt-5.6-terra",
                  displayName: "GPT-5.6-Terra",
                  description: "Balanced model.",
                  hidden: false,
                  isDefault: false,
                  supportedReasoningEfforts: [{
                    reasoningEffort: "medium",
                    description: "Balanced reasoning.",
                  }],
                  defaultReasoningEffort: "medium",
                }],
                nextCursor: null,
              });
            } else {
              process.respond(message, {
                data: [
                  {
                    id: "gpt-5.6-sol",
                    displayName: "GPT-5.6-Sol",
                    description: "Frontier model.",
                    hidden: false,
                    isDefault: true,
                    supportedReasoningEfforts: [{
                      reasoningEffort: "high",
                      description: "More reasoning.",
                    }],
                    defaultReasoningEffort: "high",
                  },
                  {
                    model: "hidden-model",
                    displayName: "Hidden",
                    hidden: true,
                  },
                ],
                nextCursor: "page-2",
              });
            }
            break;
          default:
            process.fail(message, -32601, "Not expected");
        }
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
  });

  const models = await runtime.listModels();
  assert.deepStrictEqual(models, [
    {
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      description: "Frontier model.",
      isDefault: true,
      supportedReasoningEfforts: [{
        value: "high",
        description: "More reasoning.",
      }],
      defaultReasoningEffort: "high",
    },
    {
      model: "gpt-5.6-terra",
      displayName: "GPT-5.6-Terra",
      description: "Balanced model.",
      isDefault: false,
      supportedReasoningEfforts: [{
        value: "medium",
        description: "Balanced reasoning.",
      }],
      defaultReasoningEffort: "medium",
    },
  ]);
  const reasoningCatalog = normalizeCodexModelCatalog([
    {
      model: "gpt-default",
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast." },
        { reasoningEffort: "medium", description: "Balanced." },
      ],
    },
    {
      model: "gpt-deep",
      isDefault: false,
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [
        { reasoningEffort: "high", description: "Deep." },
        { reasoningEffort: "xhigh", description: "Deeper." },
        { reasoningEffort: "max", description: "Maximum." },
      ],
    },
  ]);
  assert.deepStrictEqual(
    resolveCodexReasoningProfile(reasoningCatalog, ""),
    {
      model: "gpt-default",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { value: "low", description: "Fast." },
        { value: "medium", description: "Balanced." },
      ],
    }
  );
  assert.deepStrictEqual(
    resolveCodexReasoningProfile(reasoningCatalog, "gpt-deep"),
    {
      model: "gpt-deep",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [
        { value: "high", description: "Deep." },
        { value: "xhigh", description: "Deeper." },
        { value: "max", description: "Maximum." },
      ],
    }
  );
  assert.strictEqual(
    coerceCodexReasoningEffort(reasoningCatalog, "gpt-deep", "xhigh"),
    "xhigh"
  );
  assert.strictEqual(
    coerceCodexReasoningEffort(reasoningCatalog, "gpt-deep", "medium"),
    "",
    "model changes should clear an unsupported reasoning effort"
  );
  assert.strictEqual(
    coerceCodexReasoningEffort(reasoningCatalog, "unknown-model", "high"),
    "high",
    "a saved effort should be retained until an unknown model can be refreshed"
  );
  const requests = fakeProcess.messages.filter(
    (message) => message.method === "model/list"
  );
  assert.strictEqual(requests.length, 2);
  assert.deepStrictEqual(requests[0].params, {
    includeHidden: false,
    limit: 100,
  });
  assert.deepStrictEqual(requests[1].params, {
    cursor: "page-2",
    includeHidden: false,
    limit: 100,
  });
  await runtime.shutdown();
};

const runSkillDiscovery = async () => {
  let fakeProcess;
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => {
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (!Object.prototype.hasOwnProperty.call(message, "id")) {
          return;
        }
        switch (message.method) {
          case "initialize":
            process.respond(message, initializeResponse);
            break;
          case "account/read":
            process.respond(message, accountResponse);
            break;
          case "mcpServerStatus/list":
            process.respond(message, isolatedMcpInventory);
            break;
          case "skills/list":
            process.respond(message, {
              data: [{
                cwd: VAULT_ROOT,
                skills: [{
                  name: "translate-lacan-seminars",
                  description: "Close reading.",
                  path: `${VAULT_ROOT}/.agents/skills/translate-lacan-seminars/SKILL.md`,
                  scope: "repo",
                  enabled: true,
                }],
                errors: [],
              }],
            });
            break;
          default:
            process.fail(message, -32601, "Not expected");
        }
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
  });
  const skills = await runtime.listSkills({ forceReload: true });
  assert.deepStrictEqual(skills, [{
    name: "translate-lacan-seminars",
    description: "Close reading.",
    path: `${VAULT_ROOT}/.agents/skills/translate-lacan-seminars/SKILL.md`,
    scope: "repo",
    enabled: true,
  }]);
  const request = fakeProcess.messages.find(
    (message) => message.method === "skills/list"
  );
  assert.deepStrictEqual(request.params, {
    cwds: [VAULT_ROOT],
    forceReload: true,
  });
  await runtime.shutdown();
};

const runConcurrentStartupBarrier = async () => {
  let releaseAccountRead;
  const accountReadRequested = new Promise((resolve) => {
    releaseAccountRead = resolve;
  });
  let pendingAccountRequest;
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => new ScriptedAppServerProcess((message, process) => {
      if (!Object.prototype.hasOwnProperty.call(message, "id")) {
        return;
      }
      switch (message.method) {
        case "initialize":
          process.respond(message, initializeResponse);
          break;
        case "account/read":
          pendingAccountRequest = { message, process };
          releaseAccountRead();
          break;
        case "mcpServerStatus/list":
          process.respond(message, globalMcpInventory);
          break;
        default:
          process.fail(message, -32601, "Not expected");
      }
    }),
    requestTimeoutMs: 200,
  });
  const firstStartup = runtime.ensureServer();
  await accountReadRequested;
  let secondResolved = false;
  const secondStartup = runtime.ensureServer().then(() => {
    secondResolved = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(
    secondResolved,
    false,
    "all callers must wait for authentication and MCP inventory, not merely for stdio creation"
  );
  pendingAccountRequest.process.respond(
    pendingAccountRequest.message,
    accountResponse
  );
  await Promise.all([firstStartup, secondStartup]);
  await runtime.shutdown();
};

const runConcurrentTurns = async () => {
  let fakeProcess;
  let threadNumber = 0;
  let threadInventoryChecks = 0;
  let pendingThreadStarts = 0;
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => {
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (!Object.prototype.hasOwnProperty.call(message, "id")) {
          return;
        }
        switch (message.method) {
          case "initialize":
            process.respond(message, initializeResponse);
            break;
          case "account/read":
            process.respond(message, accountResponse);
            break;
          case "mcpServerStatus/list":
            if (!message.params.threadId) {
              process.respond(message, globalMcpInventory);
              break;
            }
            threadInventoryChecks += 1;
            setImmediate(() => {
              process.respond(
                message,
                threadInventoryChecks > 1
                  || pendingThreadStarts > 0
                  ? globalMcpInventory
                  : isolatedMcpInventory
              );
              threadInventoryChecks -= 1;
            });
            break;
          case "thread/start": {
            threadNumber += 1;
            const currentThreadNumber = threadNumber;
            pendingThreadStarts += 1;
            const respondToThreadStart = () => {
              pendingThreadStarts -= 1;
              process.respond(
                message,
                threadResponse(`thread-concurrent-${currentThreadNumber}`)
              );
            };
            if (currentThreadNumber === 1) {
              setImmediate(respondToThreadStart);
            } else {
              setTimeout(respondToThreadStart, 10);
            }
            break;
          }
          case "app/list":
            process.respond(message, { data: [], nextCursor: null });
            break;
          case "turn/start": {
            const suffix = message.params.threadId.endsWith("-1") ? "1" : "2";
            process.respond(message, {
              turn: turn(`turn-concurrent-${suffix}`, "inProgress"),
            });
            if (suffix === "1") {
              setImmediate(() => {
                process.notify("item/agentMessage/delta", {
                  delta: "回答一",
                  itemId: "item-1",
                  threadId: "thread-concurrent-1",
                  turnId: "turn-concurrent-1",
                });
                process.notify("turn/completed", {
                  threadId: "thread-concurrent-1",
                  turn: turn("turn-concurrent-1", "completed"),
                });
              });
            } else {
              setImmediate(() => {
                process.notify("item/agentMessage/delta", {
                  delta: "回答二",
                  itemId: "item-2",
                  threadId: "thread-concurrent-2",
                  turnId: "turn-concurrent-2",
                });
                process.notify("turn/completed", {
                  threadId: "thread-concurrent-2",
                  turn: turn("turn-concurrent-2", "completed"),
                });
              });
            }
            break;
          }
          case "turn/interrupt":
            process.respond(message, {});
            break;
          default:
            process.fail(message, -32601, "Not expected");
        }
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
    turnTimeoutMs: 200,
  });

  const settled = await Promise.allSettled([
    runtime.runTurn({
      baseInstructions: "只读。",
      prompt: "解释第一段。",
    }),
    runtime.runTurn({
      baseInstructions: "只读。",
      prompt: "解释第二段。",
    }),
  ]);
  assert.deepStrictEqual(
    settled.map((result) => result.status),
    ["fulfilled", "fulfilled"],
    "one App Server process should route simultaneous turns independently"
  );
  assert.deepStrictEqual(
    settled.map((result) => result.value.text).sort(),
    ["回答一", "回答二"]
  );
  assert.strictEqual(runtime.getDiagnostics().activeTurnCount, 0);
  await runtime.shutdown();
};

const runAuthFailure = async () => {
  let fakeProcess;
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => {
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (message.method === "initialize") {
          process.respond(message, initializeResponse);
        } else if (message.method === "account/read") {
          process.respond(message, {
            account: null,
            requiresOpenaiAuth: true,
          });
        }
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
  });
  await assert.rejects(
    runtime.ensureServer(),
    (error) => error.code === "CodexAuthRequired"
  );
  assert.strictEqual(fakeProcess.killed, true);
};

const runSanitizedTurnFailure = async () => {
  let fakeProcess;
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => {
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (!Object.prototype.hasOwnProperty.call(message, "id")) {
          return;
        }
        switch (message.method) {
          case "initialize":
            process.respond(message, initializeResponse);
            break;
          case "account/read":
            process.respond(message, accountResponse);
            break;
          case "mcpServerStatus/list":
            process.respond(message, isolatedMcpInventory);
            break;
          case "thread/start":
            process.respond(message, threadResponse("thread-failure"));
            break;
          case "app/list":
            process.respond(message, { data: [], nextCursor: null });
            break;
          case "turn/start":
            process.fail(message, -32000, "SECRET translated paragraph");
            break;
          default:
            process.fail(message, -32601, "Not expected");
        }
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
  });
  await assert.rejects(
    runtime.runTurn({
      baseInstructions: "只读。",
      prompt: "解释。",
    }),
    (error) => (
      error.code === "TurnFailed"
      && !error.message.includes("SECRET")
    )
  );
  await runtime.shutdown();
};

const runInterrupt = async () => {
  let fakeProcess;
  let runtimeStartedResolve;
  const runtimeStarted = new Promise((resolve) => {
    runtimeStartedResolve = resolve;
  });
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => {
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (!Object.prototype.hasOwnProperty.call(message, "id")) {
          return;
        }
        switch (message.method) {
          case "initialize":
            process.respond(message, initializeResponse);
            break;
          case "account/read":
            process.respond(message, accountResponse);
            break;
          case "mcpServerStatus/list":
            process.respond(message, isolatedMcpInventory);
            break;
          case "thread/start":
            process.respond(message, threadResponse("thread-stop"));
            break;
          case "app/list":
            process.respond(message, { data: [], nextCursor: null });
            break;
          case "turn/start":
            process.respond(message, { turn: turn("turn-stop", "inProgress") });
            break;
          case "turn/interrupt":
            process.respond(message, {});
            setImmediate(() => {
              process.notify("turn/completed", {
                threadId: "thread-stop",
                turn: turn("turn-stop", "interrupted"),
              });
            });
            break;
          default:
            process.fail(message, -32601, "Not expected");
        }
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
  });

  const resultPromise = runtime.runTurn({
    baseInstructions: "只读。",
    prompt: "解释。",
    onEvent: (event) => {
      if (event.type === "started") {
        runtimeStartedResolve();
      }
    },
  });
  await runtimeStarted;
  await runtime.interrupt();
  const result = await resultPromise;
  assert.strictEqual(result.status, "interrupted");
  const interruptMessage = fakeProcess.messages.find(
    (message) => message.method === "turn/interrupt"
  );
  assert.deepStrictEqual(interruptMessage.params, {
    threadId: "thread-stop",
    turnId: "turn-stop",
  });
  await runtime.shutdown();
};

const runShutdownActive = async () => {
  let fakeProcess;
  let runtimeStartedResolve;
  const runtimeStarted = new Promise((resolve) => {
    runtimeStartedResolve = resolve;
  });
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => {
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (!Object.prototype.hasOwnProperty.call(message, "id")) {
          return;
        }
        switch (message.method) {
          case "initialize":
            process.respond(message, initializeResponse);
            break;
          case "account/read":
            process.respond(message, accountResponse);
            break;
          case "mcpServerStatus/list":
            process.respond(message, isolatedMcpInventory);
            break;
          case "thread/start":
            process.respond(message, threadResponse("thread-shutdown"));
            break;
          case "app/list":
            process.respond(message, { data: [], nextCursor: null });
            break;
          case "turn/start":
            process.respond(message, { turn: turn("turn-shutdown", "inProgress") });
            break;
          case "turn/interrupt":
            process.respond(message, {});
            break;
          default:
            process.fail(message, -32601, "Not expected");
        }
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
    turnTimeoutMs: 100,
  });
  const resultPromise = runtime.runTurn({
    baseInstructions: "只读。",
    prompt: "解释。",
    onEvent: (event) => {
      if (event.type === "started") {
        runtimeStartedResolve();
      }
    },
  });
  await runtimeStarted;
  await runtime.shutdown();
  await assert.rejects(
    resultPromise,
    (error) => error.code === "TurnInterrupted"
  );
  assert.strictEqual(fakeProcess.killed, true);
};

const run = async () => {
  await runHappyPath();
  await runItemCompletedFallback();
  await runEmptyCompletedFailure();
  await runIsolationFailure();
  await runAppIsolationFailure();
  await runRestore();
  await runModelDiscovery();
  await runSkillDiscovery();
  await runConcurrentStartupBarrier();
  await runConcurrentTurns();
  await runAuthFailure();
  await runSanitizedTurnFailure();
  await runInterrupt();
  await runShutdownActive();
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
