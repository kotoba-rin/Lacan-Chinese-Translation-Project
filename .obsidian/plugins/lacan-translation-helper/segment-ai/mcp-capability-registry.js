const MCP_POLICY_VERSION = "1";

class McpCapabilityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "McpCapabilityError";
    this.code = code;
    Object.assign(this, details);
  }
}

class McpCapabilityRegistry {
  describePolicy() {
    return {
      version: MCP_POLICY_VERSION,
      mode: "disabled",
      allowedServers: [],
      allowedTools: [],
    };
  }

  buildDisabledServerConfig(serverNames) {
    const names = Array.from(new Set(
      (serverNames || []).map((name) => String(name || "")).filter(Boolean)
    )).sort();
    return names.reduce((result, name) => {
      result[name] = { enabled: false };
      return result;
    }, {});
  }

  assertNoExposedCapabilities(inventory) {
    const exposed = (Array.isArray(inventory) ? inventory : []).filter((server) => (
      Object.keys(server?.tools || {}).length > 0
      || (server?.resources || []).length > 0
      || (server?.resourceTemplates || []).length > 0
    ));
    const exposedServerNames = exposed
      .map((server) => String(server?.name || ""))
      .filter(Boolean);
    if (exposed.length > 0) {
      throw new McpCapabilityError(
        "ExternalToolsAvailable",
        "当前解读 thread 仍可见 MCP 能力。",
        { exposedServerNames }
      );
    }
    return {
      isolated: true,
      exposedServerNames: [],
    };
  }
}

module.exports = {
  MCP_POLICY_VERSION,
  McpCapabilityError,
  McpCapabilityRegistry,
};
