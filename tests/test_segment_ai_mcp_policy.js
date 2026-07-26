const assert = require("assert");
const { EventEmitter } = require("events");
const path = require("path");
const { PassThrough } = require("stream");

const pluginRoot = path.join(
  __dirname,
  "..",
  ".obsidian",
  "plugins",
  "lacan-translation-helper"
);
const {
  CodexAppServerRuntime,
} = require(path.join(
  pluginRoot,
  "segment-ai",
  "codex-app-server-runtime.js"
));
const {
  MCP_POLICY_VERSION,
  McpCapabilityRegistry,
} = require(path.join(
  pluginRoot,
  "segment-ai",
  "mcp-capability-registry.js"
));

const VAULT_ROOT = "/Users/example/Lacan-Vault";
const CLI_PATH = process.execPath;

class ScriptedAppServerProcess extends EventEmitter {
  constructor(handler) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    this.killed = false;
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
        handler(message, this);
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

  kill() {
    this.killed = true;
    this.emit("exit", 0, null);
  }
}

const initializeResponse = {
  codexHome: "/Users/example/.codex",
  platformFamily: "unix",
  platformOs: "macos",
  userAgent: "codex-cli/test",
};

const accountResponse = {
  account: {
    email: "reader@example.com",
    planType: "plus",
    type: "chatgpt",
  },
  requiresOpenaiAuth: true,
};

const configuredMcpServers = {
  "allowed-server": {
    command: "allowed",
    enabled: false,
  },
  "blocked-server": {
    command: "blocked",
    enabled: true,
  },
};

const configReadResponse = {
  config: {
    mcp_servers: configuredMcpServers,
  },
  origins: {},
};

const threadResponse = (threadId) => ({
  approvalPolicy: "never",
  cwd: VAULT_ROOT,
  runtimeWorkspaceRoots: [],
  sandbox: {
    type: "readOnly",
    networkAccess: false,
  },
  thread: {
    id: threadId,
    preview: "",
    turns: [],
  },
});

const runRegistryContract = () => {
  const disabled = new McpCapabilityRegistry();
  assert.deepStrictEqual(disabled.describePolicy(), {
    version: MCP_POLICY_VERSION,
    mode: "disabled",
    allowedServers: [],
    allowedTools: [],
  });
  assert.deepStrictEqual(
    disabled.buildServerConfig([
      "blocked-server",
      "allowed-server",
      " server-with-spaces ",
    ]),
    {
      " server-with-spaces ": { enabled: false },
      "allowed-server": { enabled: false },
      "blocked-server": { enabled: false },
    },
    "server names must stay byte-for-byte exact when applying deny overrides"
  );
  assert.strictEqual(
    new McpCapabilityRegistry({
      enabled: "true",
      allowedServerNames: ["allowed-server"],
    }).describePolicy().mode,
    "disabled",
    "malformed persisted values must fail closed instead of enabling MCP"
  );

  const allowlist = new McpCapabilityRegistry({
    enabled: true,
    allowedServerNames: ["allowed-server", "allowed-server", ""],
  });
  assert.deepStrictEqual(allowlist.describePolicy(), {
    version: MCP_POLICY_VERSION,
    mode: "allowlist",
    allowedServers: ["allowed-server"],
    allowedTools: ["allowed-server:*"],
  });
  assert.deepStrictEqual(
    allowlist.buildServerConfig(["blocked-server", "allowed-server"]),
    {
      "allowed-server": { enabled: true },
      "blocked-server": { enabled: false },
    }
  );
  assert.deepStrictEqual(
    allowlist.assertOnlyAllowedServers([{
      name: "allowed-server",
      tools: {
        lookup: {
          name: "lookup",
          inputSchema: { type: "object" },
        },
      },
      resources: [],
      resourceTemplates: [],
    }]),
    {
      isolated: true,
      exposedServerNames: ["allowed-server"],
    }
  );
  assert.deepStrictEqual(
    allowlist.assertOnlyAllowedServers([{
      name: "blocked-server",
      serverInfo: null,
      tools: {},
      resources: [],
      resourceTemplates: [],
    }]),
    {
      isolated: true,
      exposedServerNames: [],
    },
    "Codex may list disabled names, but inert rows must not count as a connection"
  );
  assert.throws(
    () => allowlist.assertOnlyAllowedServers([{
      name: "blocked-server",
      tools: {
        lookup: {
          name: "lookup",
          inputSchema: { type: "object" },
        },
      },
      resources: [],
      resourceTemplates: [],
    }]),
    (error) => (
      error.code === "ExternalToolsAvailable"
      && error.exposedServerNames[0] === "blocked-server"
    )
  );
};

const runStartupNotificationContract = () => {
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    mcpEnabled: true,
    enabledMcpServerNames: ["allowed-server"],
  });
  runtime.globalMcpServerNames = ["allowed-server", "blocked-server"];
  runtime.handleNotification({
    method: "mcpServer/startupStatus/updated",
    params: {
      threadId: "thread-probe",
      name: "allowed-server",
      status: "starting",
    },
  });
  assert.doesNotThrow(
    () => runtime.assertNoUnexpectedMcpStartup("thread-probe")
  );
  runtime.handleNotification({
    method: "mcpServer/startupStatus/updated",
    params: {
      threadId: "thread-probe",
      name: "blocked-server",
      status: "starting",
    },
  });
  assert.throws(
    () => runtime.assertNoUnexpectedMcpStartup("thread-probe"),
    (error) => (
      error.code === "ExternalToolsAvailable"
      && error.exposedServerNames[0] === "blocked-server"
    ),
    "a startup event is a connection attempt and must fail closed"
  );
};

const runDefaultDenyPreflight = async () => {
  let fakeProcess;
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    mcpEnabled: false,
    enabledMcpServerNames: ["allowed-server"],
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
          case "config/read":
            process.respond(message, configReadResponse);
            break;
          case "mcpServerStatus/list":
            process.respond(message, {
              data: Object.keys(configuredMcpServers).map((name) => ({
                name,
                authStatus: "unsupported",
                tools: {},
                resources: [],
                resourceTemplates: [],
              })),
              nextCursor: null,
            });
            break;
          default:
            process.fail(message, -32601, `Unexpected method: ${message.method}`);
        }
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
  });

  const report = await runtime.preflightMcpServers();
  assert.strictEqual(report.status, "disabled");
  assert.deepStrictEqual(report.configuredServerNames, [
    "allowed-server",
    "blocked-server",
  ]);
  assert.deepStrictEqual(report.enabledServerNames, []);
  assert.deepStrictEqual(report.checkedServerNames, []);
  assert.ok(
    !JSON.stringify(report).includes("\"command\""),
    "preflight reports must not persist MCP commands, URLs, or credentials"
  );
  assert.strictEqual(
    fakeProcess.messages.filter(
      (message) => message.method === "config/read"
    ).length,
    1,
    "MCP names should come from the cheap config/read RPC"
  );
  assert.strictEqual(
    fakeProcess.messages.some(
      (message) => message.method === "mcpServerStatus/list"
    ),
    false,
    "the default-disabled policy must not connect to or inspect any MCP server"
  );
  assert.strictEqual(
    fakeProcess.messages.some(
      (message) => message.method === "thread/start"
    ),
    false,
    "no probe thread is needed when every MCP server is disabled"
  );
  await runtime.shutdown();
};

const runAllowlistedBackgroundPreflight = async () => {
  let fakeProcess;
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    mcpEnabled: true,
    enabledMcpServerNames: ["allowed-server"],
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
          case "config/read":
            process.respond(message, configReadResponse);
            break;
          case "thread/start":
            process.respond(message, threadResponse("mcp-preflight-thread"));
            break;
          case "mcpServerStatus/list":
            process.respond(message, {
              data: [
                {
                  name: "allowed-server",
                  authStatus: "unsupported",
                  serverInfo: {
                    name: "allowed",
                    version: "1.0.0",
                  },
                  tools: {
                    lookup: {
                      name: "lookup",
                      inputSchema: { type: "object" },
                    },
                  },
                  resources: [],
                  resourceTemplates: [],
                },
                {
                  name: "blocked-server",
                  authStatus: "unsupported",
                  serverInfo: null,
                  tools: {},
                  resources: [],
                  resourceTemplates: [],
                },
              ],
              nextCursor: null,
            });
            break;
          default:
            process.fail(message, -32601, `Unexpected method: ${message.method}`);
        }
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
  });

  const report = await runtime.preflightMcpServers();
  assert.strictEqual(report.status, "ready");
  assert.deepStrictEqual(report.enabledServerNames, ["allowed-server"]);
  assert.deepStrictEqual(report.checkedServerNames, ["allowed-server"]);
  assert.ok(
    !report.checkedServerNames.includes("blocked-server"),
    "a disabled name returned by Codex must never be reported as connected"
  );

  const threadStart = fakeProcess.messages.find(
    (message) => message.method === "thread/start"
  );
  assert.strictEqual(threadStart.params.ephemeral, true);
  assert.strictEqual(
    threadStart.params.config.mcp_servers["allowed-server"].enabled,
    true
  );
  assert.strictEqual(
    threadStart.params.config.mcp_servers["blocked-server"].enabled,
    false
  );

  const inventoryRequests = fakeProcess.messages.filter(
    (message) => message.method === "mcpServerStatus/list"
  );
  assert.strictEqual(inventoryRequests.length, 1);
  assert.strictEqual(
    inventoryRequests[0].params.threadId,
    "mcp-preflight-thread"
  );
  assert.strictEqual(
    inventoryRequests.some((message) => !message.params.threadId),
    false,
    "the runtime must never enumerate global MCP status without a restricted thread"
  );
  await runtime.shutdown();
};

const run = async () => {
  runRegistryContract();
  runStartupNotificationContract();
  await runDefaultDenyPreflight();
  await runAllowlistedBackgroundPreflight();
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
