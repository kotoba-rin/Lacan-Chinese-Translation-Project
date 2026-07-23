const assert = require("assert");
const { EventEmitter, once } = require("events");
const path = require("path");
const { PassThrough } = require("stream");

const rpcModulePath = path.join(
  __dirname,
  "..",
  ".obsidian",
  "plugins",
  "lacan-translation-helper",
  "segment-ai",
  "json-line-rpc.js"
);

const { JsonLineRpcClient } = require(rpcModulePath);

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.sent = [];
    this.killed = false;
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) {
          this.sent.push(JSON.parse(line));
        }
      }
    });
  }

  send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  sendRaw(value) {
    this.stdout.write(value);
  }

  kill() {
    this.killed = true;
    this.emit("exit", 0, null);
  }
}

const nextTask = () => new Promise((resolve) => setImmediate(resolve));

const run = async () => {
  const process = new FakeProcess();
  const client = new JsonLineRpcClient(process, { requestTimeoutMs: 100 });

  const initializePromise = client.request("initialize", {
    clientInfo: { name: "test", version: "1" },
  });
  await nextTask();
  assert.deepStrictEqual(process.sent[0], {
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "test", version: "1" },
    },
  });
  process.send({
    id: 1,
    result: {
      codexHome: "/tmp/codex",
      platformFamily: "unix",
      platformOs: "macos",
      userAgent: "codex-cli/0.144.5",
    },
  });
  assert.strictEqual((await initializePromise).platformOs, "macos");

  client.notify("initialized", {});
  await nextTask();
  assert.deepStrictEqual(process.sent[1], {
    method: "initialized",
    params: {},
  });

  const notificationPromise = once(client, "notification");
  process.send({
    method: "item/agentMessage/delta",
    params: {
      delta: "一段",
      itemId: "item-1",
      threadId: "thread-1",
      turnId: "turn-1",
    },
  });
  const [notification] = await notificationPromise;
  assert.strictEqual(notification.method, "item/agentMessage/delta");
  assert.strictEqual(notification.params.delta, "一段");

  const serverRequestPromise = once(client, "serverRequest");
  process.send({
    id: 99,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1" },
  });
  const [serverRequest] = await serverRequestPromise;
  assert.strictEqual(serverRequest.method, "item/commandExecution/requestApproval");
  await nextTask();
  assert.deepStrictEqual(process.sent[2], {
    id: 99,
    error: {
      code: -32601,
      message: "Server requests are disabled for this read-only client.",
    },
  });

  const protocolErrorPromise = once(client, "protocolError");
  process.sendRaw("{invalid-json}\n");
  const [protocolError] = await protocolErrorPromise;
  assert.strictEqual(protocolError.code, "InvalidJson");

  const timeoutClientProcess = new FakeProcess();
  const timeoutClient = new JsonLineRpcClient(timeoutClientProcess, {
    requestTimeoutMs: 5,
  });
  await assert.rejects(
    timeoutClient.request("never/responds", {}),
    (error) => error.code === "RequestTimeout"
  );
  timeoutClient.close();

  const exitProcess = new FakeProcess();
  const exitClient = new JsonLineRpcClient(exitProcess, {
    requestTimeoutMs: 100,
  });
  const pending = exitClient.request("thread/start", {});
  exitProcess.emit("exit", 1, null);
  await assert.rejects(
    pending,
    (error) => error.code === "AppServerExited"
  );

  client.close();
  assert.strictEqual(process.killed, true);
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
