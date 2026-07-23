const assert = require("assert");
const path = require("path");

const controllerModulePath = path.join(
  __dirname,
  "..",
  ".obsidian",
  "plugins",
  "lacan-translation-helper",
  "segment-ai",
  "interpretation-controller.js"
);
const domainModulePath = path.join(
  __dirname,
  "..",
  ".obsidian",
  "plugins",
  "lacan-translation-helper",
  "segment-ai",
  "domain.js"
);

const {
  SegmentInterpretationController,
} = require(controllerModulePath);
const {
  InterpretationPromptBuilder,
  InterpretationSessionStore,
  PROMPT_VERSION,
} = require(domainModulePath);

const makeContext = (contextHash = "a".repeat(64)) => ({
  reference: {
    seminarCode: "s8",
    seminarSlug: "s8-test",
    lessonNumber: 1,
    requestedId: "s8-01-0003",
    primaryId: "s8-01-0002",
    coveredIds: ["s8-01-0002", "s8-01-0003"],
    translationPath: "texts/s8-test/translation/Leçon-01.md",
    originalPath: "texts/s8-test/original/Leçon-01.md",
  },
  targetTranslation: {
    primaryId: "s8-01-0002",
    ids: ["s8-01-0002", "s8-01-0003"],
    visibleText: "这里讨论欲望。",
  },
  alignedOriginals: [{
    primaryId: "s8-01-0002",
    ids: ["s8-01-0002"],
    visibleText: "Le désir.",
  }],
  previousTranslation: undefined,
  nextTranslation: undefined,
  glossaryEntries: [],
  linkedNotes: [],
  availability: {
    translationAvailable: true,
    originalAvailable: true,
    glossaryAvailable: false,
    linkedNotesAvailable: false,
    warnings: [],
  },
  contextHash,
});

class RuntimeDouble {
  constructor() {
    this.runCalls = [];
    this.restoreCalls = [];
    this.interruptCalls = 0;
  }

  async runTurn(options) {
    this.runCalls.push(options);
    const number = this.runCalls.length;
    const threadId = options.threadId || `thread-${number}`;
    options.onEvent({
      type: "started",
      threadId,
      turnId: `turn-${number}`,
    });
    options.onEvent({
      type: "delta",
      delta: `回答-${number}`,
      text: `回答-${number}`,
      threadId,
      turnId: `turn-${number}`,
    });
    options.onEvent({
      type: "completed",
      status: "completed",
      text: `回答-${number}`,
      threadId,
      turnId: `turn-${number}`,
    });
    return {
      threadId,
      turnId: `turn-${number}`,
      text: `回答-${number}`,
      status: "completed",
    };
  }

  async restoreThread(options) {
    this.restoreCalls.push(options);
    return {
      threadId: options.threadId,
      text: "恢复的旧回答",
      status: "completed",
      thread: { id: options.threadId, turns: [] },
    };
  }

  async interrupt() {
    this.interruptCalls += 1;
    return true;
  }
}

const run = async () => {
  let currentContext = makeContext();
  const resolver = {
    async resolve(sourcePath, requestedId) {
      assert.strictEqual(sourcePath, currentContext.reference.translationPath);
      assert.strictEqual(requestedId, currentContext.reference.requestedId);
      return currentContext;
    },
  };
  const states = [];
  const persisted = [];
  const runtime = new RuntimeDouble();
  const store = new InterpretationSessionStore();
  const controller = new SegmentInterpretationController({
    resolver,
    promptBuilder: new InterpretationPromptBuilder(),
    sessionStore: store,
    runtime,
    onState: (state) => states.push(state),
    persistSessions: async (records) => persisted.push(records),
    now: () => new Date("2026-07-23T02:00:00.000Z"),
  });

  const first = await controller.interpret(
    currentContext.reference.translationPath,
    currentContext.reference.requestedId
  );
  assert.strictEqual(first.state, "completed");
  assert.deepStrictEqual(
    states.map((state) => state.status),
    ["resolving", "starting", "searching", "streaming", "completed"]
  );
  assert.strictEqual(states.at(-1).answer, "回答-1");
  assert.strictEqual(states.at(-1).context.reference.primaryId, "s8-01-0002");
  assert.strictEqual(runtime.runCalls.length, 1);
  assert.strictEqual(runtime.runCalls[0].threadId, undefined);
  assert.match(runtime.runCalls[0].prompt, /这里讨论欲望/);
  assert.strictEqual(store.toJSON()[0].threadId, "thread-1");
  assert.strictEqual(store.toJSON()[0].promptVersion, PROMPT_VERSION);
  assert.strictEqual(store.toJSON()[0].status, "completed");
  assert.strictEqual(store.toJSON()[0].answer, "回答-1");
  assert.ok(persisted.length > 0);

  states.length = 0;
  const restored = await controller.interpret(
    currentContext.reference.translationPath,
    currentContext.reference.requestedId
  );
  assert.strictEqual(restored.state, "completed");
  assert.strictEqual(runtime.runCalls.length, 1);
  assert.strictEqual(runtime.restoreCalls.length, 1);
  assert.strictEqual(runtime.restoreCalls[0].threadId, "thread-1");
  assert.strictEqual(states.at(-1).answer, "恢复的旧回答");
  assert.strictEqual(states.at(-1).restored, true);

  currentContext = makeContext("b".repeat(64));
  states.length = 0;
  const stale = await controller.interpret(
    currentContext.reference.translationPath,
    currentContext.reference.requestedId
  );
  assert.strictEqual(stale.state, "stale");
  assert.strictEqual(states.at(-1).status, "stale");
  assert.deepStrictEqual(states.at(-1).staleReasons, ["context"]);
  assert.strictEqual(states.at(-1).answer, "恢复的旧回答");
  assert.strictEqual(runtime.restoreCalls.length, 2);
  assert.strictEqual(runtime.runCalls.length, 1);

  states.length = 0;
  const retried = await controller.retry();
  assert.strictEqual(retried.state, "completed");
  assert.strictEqual(runtime.runCalls.length, 2);
  assert.strictEqual(runtime.runCalls[1].threadId, undefined);
  assert.strictEqual(store.toJSON()[0].threadId, "thread-2");

  states.length = 0;
  const followedUp = await controller.followUp("这里和 demande 有什么关系？");
  assert.strictEqual(followedUp.state, "completed");
  assert.strictEqual(runtime.runCalls.length, 3);
  assert.strictEqual(runtime.runCalls[2].threadId, "thread-2");
  assert.match(runtime.runCalls[2].prompt, /demande/);
  assert.ok(!runtime.runCalls[2].prompt.includes("这里讨论欲望。"));
  assert.deepStrictEqual(
    states.at(-1).conversation.map((entry) => entry.role),
    ["user", "assistant"]
  );

  assert.strictEqual(await controller.stop(), true);
  assert.strictEqual(runtime.interruptCalls, 1);

  let resolveBusyTurn;
  let signalBusyStarted;
  const busyStarted = new Promise((resolve) => {
    signalBusyStarted = resolve;
  });
  const busyStates = [];
  const busyRuntime = {
    async runTurn(options) {
      options.onEvent({
        type: "started",
        threadId: "thread-busy",
        turnId: "turn-busy",
      });
      signalBusyStarted();
      return new Promise((resolve) => {
        resolveBusyTurn = resolve;
      });
    },
    async interrupt() {
      resolveBusyTurn({
        threadId: "thread-busy",
        turnId: "turn-busy",
        text: "",
        status: "interrupted",
      });
      return true;
    },
  };
  const busyController = new SegmentInterpretationController({
    resolver,
    promptBuilder: new InterpretationPromptBuilder(),
    sessionStore: new InterpretationSessionStore(),
    runtime: busyRuntime,
    onState: (state) => busyStates.push(state),
  });
  const activeInterpretation = busyController.interpret(
    currentContext.reference.translationPath,
    currentContext.reference.requestedId
  );
  await busyStarted;
  assert.strictEqual(busyStates.at(-1).status, "searching");
  const busyResult = await busyController.interpret(
    currentContext.reference.translationPath,
    "s8-01-0099"
  );
  assert.strictEqual(busyResult.state, "busy");
  assert.strictEqual(
    busyStates.at(-1).status,
    "searching",
    "a competing segment click must keep the active generation and Stop action visible"
  );
  assert.strictEqual(
    busyStates.some((state) => state.error?.code === "TurnBusy"),
    false,
    "TurnBusy is a rejected click, not a failed active turn"
  );
  assert.strictEqual(await busyController.stop(), true);
  assert.strictEqual((await activeInterpretation).state, "interrupted");

  const followUpBusyStates = [];
  const followUpBusyRuntime = new RuntimeDouble();
  const followUpBusyController = new SegmentInterpretationController({
    resolver,
    promptBuilder: new InterpretationPromptBuilder(),
    sessionStore: new InterpretationSessionStore(),
    runtime: followUpBusyRuntime,
    onState: (state) => followUpBusyStates.push(state),
  });
  await followUpBusyController.interpret(
    currentContext.reference.translationPath,
    currentContext.reference.requestedId
  );
  let resolveFollowUp;
  let signalFollowUpStarted;
  const followUpStarted = new Promise((resolve) => {
    signalFollowUpStarted = resolve;
  });
  let followUpActive = false;
  followUpBusyRuntime.runTurn = async (options) => {
    if (followUpActive) {
      const error = new Error("busy");
      error.code = "TurnBusy";
      throw error;
    }
    followUpActive = true;
    options.onEvent({
      type: "started",
      threadId: options.threadId,
      turnId: "turn-follow-up",
    });
    signalFollowUpStarted();
    return new Promise((resolve) => {
      resolveFollowUp = resolve;
    });
  };
  followUpBusyRuntime.interrupt = async () => {
    resolveFollowUp({
      threadId: "thread-1",
      turnId: "turn-follow-up",
      text: "",
      status: "interrupted",
    });
    return true;
  };
  followUpBusyStates.length = 0;
  const activeFollowUp = followUpBusyController.followUp("第一个追问");
  await followUpStarted;
  const competingFollowUp = await followUpBusyController.followUp("第二个追问");
  assert.strictEqual(competingFollowUp.state, "busy");
  assert.strictEqual(followUpBusyStates.at(-1).status, "searching");
  assert.strictEqual(
    followUpBusyStates.some((state) => state.error?.code === "TurnBusy"),
    false,
    "a repeated follow-up must not hide the Stop action for the active follow-up"
  );
  assert.strictEqual(await followUpBusyController.stop(), true);
  assert.strictEqual((await activeFollowUp).state, "interrupted");

  const cachedStore = new InterpretationSessionStore([{
    segmentKey: `${currentContext.reference.translationPath}::${currentContext.reference.primaryId}`,
    threadId: "thread-cached",
    contextHash: currentContext.contextHash,
    promptVersion: PROMPT_VERSION,
    lastOpenedAt: "2026-07-23T02:00:00.000Z",
    status: "completed",
    answer: "缓存的完整回答。",
  }]);
  const cachedStates = [];
  const cachedController = new SegmentInterpretationController({
    resolver,
    promptBuilder: new InterpretationPromptBuilder(),
    sessionStore: cachedStore,
    runtime: {
      async restoreThread(options) {
        return {
          threadId: options.threadId,
          text: "",
          status: "interrupted",
          thread: {
            id: options.threadId,
            turns: [{ id: "turn-interrupted", status: "interrupted", items: [] }],
          },
        };
      },
    },
    onState: (state) => cachedStates.push(state),
  });
  const cachedRestore = await cachedController.interpret(
    currentContext.reference.translationPath,
    currentContext.reference.requestedId
  );
  assert.strictEqual(cachedRestore.state, "completed");
  assert.strictEqual(cachedRestore.answer, "缓存的完整回答。");
  assert.strictEqual(cachedStates.at(-1).status, "completed");
  assert.strictEqual(cachedStates.at(-1).answer, "缓存的完整回答。");

  const unavailableCacheStore = new InterpretationSessionStore([{
    segmentKey: `${currentContext.reference.translationPath}::${currentContext.reference.primaryId}`,
    threadId: "thread-unavailable-cache",
    contextHash: currentContext.contextHash,
    promptVersion: PROMPT_VERSION,
    lastOpenedAt: "2026-07-23T02:00:00.000Z",
    status: "completed",
    answer: "即使 thread 丢失也应显示的回答。",
  }]);
  const unavailableCacheStates = [];
  const unavailableCacheController = new SegmentInterpretationController({
    resolver,
    promptBuilder: new InterpretationPromptBuilder(),
    sessionStore: unavailableCacheStore,
    runtime: {
      async restoreThread() {
        const error = new Error("missing thread");
        error.code = "ThreadUnavailable";
        throw error;
      },
    },
    onState: (state) => unavailableCacheStates.push(state),
  });
  const unavailableCache = await unavailableCacheController.interpret(
    currentContext.reference.translationPath,
    currentContext.reference.requestedId
  );
  assert.strictEqual(unavailableCache.state, "failed");
  assert.strictEqual(
    unavailableCacheStates.at(-1).answer,
    "即使 thread 丢失也应显示的回答。"
  );
  assert.strictEqual(
    unavailableCacheStates.at(-1).error.code,
    "ThreadUnavailable"
  );

  const staleCacheStore = new InterpretationSessionStore([{
    segmentKey: `${currentContext.reference.translationPath}::${currentContext.reference.primaryId}`,
    threadId: "thread-stale-cache",
    contextHash: "a".repeat(64),
    promptVersion: PROMPT_VERSION,
    lastOpenedAt: "2026-07-23T02:00:00.000Z",
    status: "completed",
    answer: "源内容变化前的缓存回答。",
  }]);
  const staleCacheStates = [];
  const staleCacheController = new SegmentInterpretationController({
    resolver,
    promptBuilder: new InterpretationPromptBuilder(),
    sessionStore: staleCacheStore,
    runtime: {
      async restoreThread() {
        const error = new Error("missing thread");
        error.code = "ThreadUnavailable";
        throw error;
      },
    },
    onState: (state) => staleCacheStates.push(state),
  });
  const staleCache = await staleCacheController.interpret(
    currentContext.reference.translationPath,
    currentContext.reference.requestedId
  );
  assert.strictEqual(staleCache.state, "stale");
  assert.strictEqual(staleCache.answer, "源内容变化前的缓存回答。");
  assert.strictEqual(staleCacheStates.at(-1).answer, staleCache.answer);
  assert.strictEqual(staleCacheStates.at(-1).error.code, "ThreadUnavailable");

  const interruptedStore = new InterpretationSessionStore([{
    segmentKey: `${currentContext.reference.translationPath}::${currentContext.reference.primaryId}`,
    threadId: "thread-interrupted",
    contextHash: currentContext.contextHash,
    promptVersion: PROMPT_VERSION,
    lastOpenedAt: "2026-07-23T02:00:00.000Z",
    status: "completed",
  }]);
  const interruptedStates = [];
  const interruptedRuntime = new RuntimeDouble();
  interruptedRuntime.restoreThread = async (options) => ({
    threadId: options.threadId,
    text: "",
    status: "interrupted",
    thread: {
      id: options.threadId,
      turns: [{ id: "turn-interrupted", status: "interrupted", items: [] }],
    },
  });
  const interruptedController = new SegmentInterpretationController({
    resolver,
    promptBuilder: new InterpretationPromptBuilder(),
    sessionStore: interruptedStore,
    runtime: interruptedRuntime,
    onState: (state) => interruptedStates.push(state),
  });
  const interruptedRestore = await interruptedController.interpret(
    currentContext.reference.translationPath,
    currentContext.reference.requestedId
  );
  assert.strictEqual(interruptedRestore.state, "interrupted");
  assert.strictEqual(interruptedStates.at(-1).status, "failed");
  assert.strictEqual(interruptedStates.at(-1).error.code, "TurnInterrupted");
  assert.strictEqual(interruptedStore.toJSON()[0].status, "interrupted");
  const restartedAfterInterrupted = await interruptedController.retry();
  assert.strictEqual(restartedAfterInterrupted.state, "completed");
  assert.strictEqual(interruptedStates.at(-1).answer, "回答-1");

  const emptyRestoreStore = new InterpretationSessionStore([{
    segmentKey: `${currentContext.reference.translationPath}::${currentContext.reference.primaryId}`,
    threadId: "thread-empty-restore",
    contextHash: currentContext.contextHash,
    promptVersion: PROMPT_VERSION,
    lastOpenedAt: "2026-07-23T02:00:00.000Z",
    status: "completed",
  }]);
  const emptyRestoreStates = [];
  const emptyRestoreController = new SegmentInterpretationController({
    resolver,
    promptBuilder: new InterpretationPromptBuilder(),
    sessionStore: emptyRestoreStore,
    runtime: {
      async restoreThread(options) {
        return {
          threadId: options.threadId,
          text: "",
          status: "completed",
          thread: {
            id: options.threadId,
            turns: [{ id: "turn-empty", status: "completed", items: [] }],
          },
        };
      },
    },
    onState: (state) => emptyRestoreStates.push(state),
  });
  const emptyRestore = await emptyRestoreController.interpret(
    currentContext.reference.translationPath,
    currentContext.reference.requestedId
  );
  assert.strictEqual(emptyRestore.state, "failed");
  assert.strictEqual(emptyRestoreStates.at(-1).error.code, "EmptyAgentResponse");
  assert.strictEqual(emptyRestoreStore.toJSON()[0].status, "failed");

  const emptyStates = [];
  const emptyStore = new InterpretationSessionStore();
  const emptyController = new SegmentInterpretationController({
    resolver,
    promptBuilder: new InterpretationPromptBuilder(),
    sessionStore: emptyStore,
    runtime: {
      async runTurn() {
        return {
          threadId: "thread-empty",
          turnId: "turn-empty",
          text: "",
          status: "completed",
        };
      },
    },
    onState: (state) => emptyStates.push(state),
  });
  const emptyResult = await emptyController.interpret(
    currentContext.reference.translationPath,
    currentContext.reference.requestedId
  );
  assert.strictEqual(emptyResult.state, "failed");
  assert.strictEqual(emptyStates.at(-1).status, "failed");
  assert.strictEqual(emptyStates.at(-1).error.code, "EmptyAgentResponse");
  assert.strictEqual(emptyStore.toJSON()[0].status, "failed");

  const failingStates = [];
  const failingController = new SegmentInterpretationController({
    resolver,
    promptBuilder: new InterpretationPromptBuilder(),
    sessionStore: new InterpretationSessionStore(),
    runtime: {
      async runTurn() {
        const error = new Error("missing");
        error.code = "CodexNotFound";
        throw error;
      },
    },
    onState: (state) => failingStates.push(state),
  });
  const failed = await failingController.interpret(
    currentContext.reference.translationPath,
    currentContext.reference.requestedId
  );
  assert.strictEqual(failed.state, "failed");
  assert.strictEqual(failingStates.at(-1).status, "unavailable");
  assert.strictEqual(failingStates.at(-1).error.code, "CodexNotFound");
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
