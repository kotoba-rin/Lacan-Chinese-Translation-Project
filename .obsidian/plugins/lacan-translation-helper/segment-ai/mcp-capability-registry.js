const MCP_POLICY_VERSION = "2";

class McpCapabilityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "McpCapabilityError";
    this.code = code;
    Object.assign(this, details);
  }
}

class McpCapabilityRegistry {
  constructor({
    enabled = false,
    allowedServerNames = [],
  } = {}) {
    this.enabled = enabled === true;
    this.allowedServerNames = this.enabled
      ? normalizeServerNames(allowedServerNames)
      : [];
    this.allowedServerNameSet = new Set(this.allowedServerNames);
  }

  describePolicy() {
    return {
      version: MCP_POLICY_VERSION,
      mode: this.allowedServerNames.length > 0 ? "allowlist" : "disabled",
      allowedServers: [...this.allowedServerNames],
      allowedTools: this.allowedServerNames.map((name) => `${name}:*`),
    };
  }

  buildServerConfig(serverNames) {
    return Object.fromEntries(
      normalizeServerNames(serverNames).map((name) => [
        name,
        { enabled: this.allowedServerNameSet.has(name) },
      ])
    );
  }

  buildDisabledServerConfig(serverNames) {
    return Object.fromEntries(
      normalizeServerNames(serverNames).map((name) => [
        name,
        { enabled: false },
      ])
    );
  }

  assertOnlyAllowedServers(inventory) {
    const exposedServerNames = normalizeServerNames(
      (Array.isArray(inventory) ? inventory : [])
        .filter(hasRuntimeExposure)
        .map((server) => server?.name)
    );
    const disallowedServerNames = exposedServerNames.filter(
      (name) => !this.allowedServerNameSet.has(name)
    );
    if (disallowedServerNames.length > 0) {
      throw new McpCapabilityError(
        "ExternalToolsAvailable",
        "当前解读 thread 暴露了未在插件白名单中的 MCP 服务。",
        { exposedServerNames: disallowedServerNames }
      );
    }
    return {
      isolated: true,
      exposedServerNames,
    };
  }

  assertNoExposedCapabilities(inventory) {
    const exposed = (Array.isArray(inventory) ? inventory : [])
      .filter(hasRuntimeExposure);
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

const normalizeServerNames = (serverNames) => Array.from(new Set(
  (Array.isArray(serverNames) ? serverNames : [])
    .map((name) => String(name || ""))
    .filter((name) => name.trim().length > 0)
)).sort();

const hasRuntimeExposure = (server) => (
  Boolean(server?.serverInfo)
  || Object.keys(server?.tools || {}).length > 0
  || (server?.resources || []).length > 0
  || (server?.resourceTemplates || []).length > 0
);

module.exports = {
  MCP_POLICY_VERSION,
  McpCapabilityError,
  McpCapabilityRegistry,
  normalizeServerNames,
};
