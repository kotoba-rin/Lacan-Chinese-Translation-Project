const assert = require("assert");
const path = require("path");

const modulePath = path.join(
  __dirname,
  "..",
  ".obsidian",
  "plugins",
  "lacan-translation-helper",
  "segment-ai",
  "mcp-capability-registry.js"
);

const {
  MCP_POLICY_VERSION,
  McpCapabilityRegistry,
} = require(modulePath);

const registry = new McpCapabilityRegistry();

assert.deepStrictEqual(registry.describePolicy(), {
  version: MCP_POLICY_VERSION,
  mode: "disabled",
  allowedServers: [],
  allowedTools: [],
});
assert.deepStrictEqual(
  registry.buildDisabledServerConfig([
    "server-b",
    "server-a",
    "server-a",
    "",
  ]),
  {
    "server-a": { enabled: false },
    "server-b": { enabled: false },
  }
);
assert.deepStrictEqual(
  registry.assertNoExposedCapabilities([
    {
      name: "disabled-server",
      tools: {},
      resources: [],
      resourceTemplates: [],
    },
  ]),
  {
    isolated: true,
    exposedServerNames: [],
  }
);
assert.throws(
  () => registry.assertNoExposedCapabilities([
    {
      name: "unsafe-server",
      tools: {
        get: {
          name: "get",
          inputSchema: { type: "object" },
        },
      },
      resources: [],
      resourceTemplates: [],
    },
  ]),
  (error) => (
    error.code === "ExternalToolsAvailable"
    && error.exposedServerNames[0] === "unsafe-server"
  )
);
