const { EventEmitter } = require("events");

class AppServerProtocolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AppServerProtocolError";
    this.code = code;
    Object.assign(this, details);
  }
}

class JsonLineRpcClient extends EventEmitter {
  constructor(childProcess, { requestTimeoutMs = 30000 } = {}) {
    super();
    if (!childProcess?.stdin || !childProcess?.stdout) {
      throw new TypeError("JsonLineRpcClient requires a process with stdin and stdout.");
    }
    this.process = childProcess;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.closed = false;
    this.exitHandled = false;

    this.onStdoutData = (chunk) => this.handleStdoutData(chunk);
    this.onProcessExit = (code, signal) => this.handleProcessExit(code, signal);
    this.onProcessError = (error) => this.handleProcessError(error);
    this.process.stdout.on("data", this.onStdoutData);
    this.process.on("exit", this.onProcessExit);
    this.process.on("error", this.onProcessError);
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.closed) {
      return Promise.reject(new AppServerProtocolError(
        "AppServerExited",
        "本地 Agent 进程已关闭。"
      ));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerProtocolError(
          "RequestTimeout",
          `App Server 请求超时：${method}`,
          { method }
        ));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
      try {
        this.writeMessage({ id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      throw new AppServerProtocolError("AppServerExited", "本地 Agent 进程已关闭。");
    }
    this.writeMessage({ method, params });
  }

  writeMessage(message) {
    const serialized = `${JSON.stringify(message)}\n`;
    if (!this.process.stdin.write(serialized, "utf8")) {
      this.process.stdin.once("drain", () => this.emit("drain"));
    }
  }

  handleStdoutData(chunk) {
    this.stdoutBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch (_error) {
        this.emit("protocolError", new AppServerProtocolError(
          "InvalidJson",
          "App Server 返回了无效 JSON。"
        ));
        continue;
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.emit("protocolError", new AppServerProtocolError(
        "InvalidMessage",
        "App Server 返回了无效消息。"
      ));
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.emit("protocolError", new AppServerProtocolError(
          "UnknownResponse",
          `App Server 返回了未知请求 ID：${message.id}`
        ));
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new AppServerProtocolError(
          "RpcError",
          String(message.error.message || `App Server 请求失败：${pending.method}`),
          {
            method: pending.method,
            rpcCode: message.error.code,
            rpcData: message.error.data,
          }
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method && Object.prototype.hasOwnProperty.call(message, "id")) {
      this.emit("serverRequest", message);
      this.writeMessage({
        id: message.id,
        error: {
          code: -32601,
          message: "Server requests are disabled for this read-only client.",
        },
      });
      return;
    }
    if (message.method) {
      this.emit("notification", message);
      return;
    }
    this.emit("protocolError", new AppServerProtocolError(
      "InvalidMessage",
      "App Server 返回了无法识别的消息。"
    ));
  }

  handleProcessError(error) {
    this.emit("protocolError", new AppServerProtocolError(
      "AppServerExited",
      "无法启动本地 Agent。",
      { cause: error }
    ));
    this.handleProcessExit(null, null);
  }

  handleProcessExit(code, signal) {
    if (this.exitHandled) {
      return;
    }
    this.exitHandled = true;
    this.closed = true;
    const error = new AppServerProtocolError(
      "AppServerExited",
      "本地 Agent 进程意外退出。",
      { exitCode: code, signal }
    );
    this.rejectPending(error);
    this.emit("exit", error);
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rejectPending(new AppServerProtocolError(
      "AppServerExited",
      "本地 Agent 客户端已关闭。"
    ));
    this.process.stdout.off("data", this.onStdoutData);
    this.process.off("exit", this.onProcessExit);
    this.process.off("error", this.onProcessError);
    if (typeof this.process.kill === "function") {
      this.process.kill();
    }
  }
}

module.exports = {
  AppServerProtocolError,
  JsonLineRpcClient,
};
