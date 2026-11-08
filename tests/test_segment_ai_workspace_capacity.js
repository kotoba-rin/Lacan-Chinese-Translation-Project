const assert = require("assert");
const path = require("path");

const pluginRoot = path.join(
  __dirname,
  "..",
  ".obsidian",
  "plugins",
  "lacan-translation-helper",
  "segment-ai"
);
const {
  InterpretationWorkspaceStore,
} = require(path.join(pluginRoot, "workspace-store.js"));
const {
  InterpretationWorkspaceController,
} = require(path.join(pluginRoot, "workspace-controller.js"));
const {
  InterpretationPromptBuilder,
} = require(path.join(pluginRoot, "prompt-builder.js"));

const translationPath = "texts/s8-test/translation/Leçon-01.md";
const makeContext = (requestedId) => ({
  reference: {
    seminarCode: "s8",
    seminarSlug: "s8-test",
    lessonNumber: 1,
    requestedId,
    primaryId: requestedId,
    coveredIds: [requestedId],
    translationPath,
    originalPath: "texts/s8-test/original/Leçon-01.md",
  },
  lessonTitle: "Leçon 1 | 1 Janvier 1960",
  targetTranslation: {
    primaryId: requestedId,
    ids: [requestedId],
    visibleText: `译文 ${requestedId}`,
  },
  alignedOriginals: [{
    primaryId: requestedId,
    ids: [requestedId],
    visibleText: `Original ${requestedId}`,
  }],
  glossaryEntries: [],
  linkedNotes: [],
  availability: {
    translationAvailable: true,
    originalAvailable: true,
    glossaryAvailable: false,
    linkedNotesAvailable: false,
    warnings: [],
  },
  contextHash: `${requestedId}-hash`,
});

const makeStore = () => {
  let id = 0;
  return new InterpretationWorkspaceStore({
    maxOpenSessions: 5,
    idFactory: (prefix) => `${prefix}-capacity-${++id}`,
    now: () => new Date("2026-11-08T08:00:00.000Z"),
  });
};
const create = (store, index) => store.createConversation({
  context: makeContext(`s8-01-${String(index).padStart(4, "0")}`),
});
const fill = (store) => Array.from({ length: 5 }, (_, index) => create(store, index + 1));
const tests = [];
const test = (name, run) => tests.push({ name, run });

test("a new session closes the leftmost idle tab and preserves its entire history", () => {
  const store = makeStore();
  const opened = fill(store);
  const first = opened[0];
  store.update(first.id, {
    status: "completed",
    threadId: "saved-agent-thread",
    turnId: "saved-turn",
    answer: "已收到的回答",
  });
  store.appendMessage(first.id, { role: "user", content: "先前的问题" });
  store.appendMessage(first.id, { role: "assistant", content: "已收到的回答" });
  store.updateDraft(first.id, "尚未发送的问题");
  store.updateScroll(first.id, {
    followLatest: false,
    scrollTop: 240,
    unseenMessageCount: 2,
  });
  const saved = store.get(first.id);

  const newest = create(store, 6);

  assert.deepStrictEqual(store.snapshot().openConversationIds, [
    ...opened.slice(1).map((conversation) => conversation.id),
    newest.id,
  ]);
  assert.strictEqual(store.snapshot().activeConversationId, newest.id);
  assert.deepStrictEqual(store.get(first.id), { ...saved, isOpen: false });
  assert.strictEqual(store.listHistory().length, 6);
  const restored = new InterpretationWorkspaceStore({ ...store.serialize(), maxOpenSessions: 5 });
  assert.deepStrictEqual(restored.get(first.id), { ...saved, isOpen: false });
});

test("reopening history closes the current leftmost idle tab", () => {
  const store = makeStore();
  const opened = fill(store);
  store.close(opened[2].id);
  const newest = create(store, 6);

  store.open(opened[2].id);

  assert.deepStrictEqual(store.snapshot().openConversationIds, [
    opened[1].id,
    opened[3].id,
    opened[4].id,
    newest.id,
    opened[2].id,
  ]);
  assert.strictEqual(store.get(opened[0].id).isOpen, false);
  assert.strictEqual(store.snapshot().activeConversationId, opened[2].id);
  assert.strictEqual(store.listHistory().length, 6);
});

test("switching already open tabs at capacity never closes another tab", () => {
  const store = makeStore();
  const opened = fill(store);
  const expectedIds = opened.map((conversation) => conversation.id);

  store.open(opened[0].id);
  assert.deepStrictEqual(store.snapshot().openConversationIds, expectedIds);
  assert.strictEqual(store.snapshot().activeConversationId, opened[0].id);
  store.activate(opened[2].id);
  assert.deepStrictEqual(store.snapshot().openConversationIds, expectedIds);
  assert.strictEqual(store.snapshot().activeConversationId, opened[2].id);
  assert.ok(expectedIds.every((id) => store.get(id).isOpen));
});

test("automatic closing skips every active generation status", () => {
  const store = makeStore();
  const opened = fill(store);
  const statuses = ["resolving", "starting", "searching", "streaming"];
  statuses.forEach((status, index) => store.update(opened[index].id, { status }));

  const newest = create(store, 6);

  assert.deepStrictEqual(store.snapshot().openConversationIds, [
    ...opened.slice(0, 4).map((conversation) => conversation.id),
    newest.id,
  ]);
  statuses.forEach((status, index) => {
    assert.strictEqual(store.get(opened[index].id).status, status);
    assert.strictEqual(store.get(opened[index].id).isOpen, true);
  });
  assert.strictEqual(store.get(opened[4].id).isOpen, false);
  assert.strictEqual(store.snapshot().runningCount, 4);
});

test("all busy tabs reject both creation and history reopening without any mutation", () => {
  const store = makeStore();
  const history = create(store, 99);
  store.close(history.id);
  const opened = fill(store);
  opened.forEach((conversation) => store.update(conversation.id, { status: "streaming" }));
  const before = store.snapshot();

  assert.throws(() => create(store, 6), (error) => error.code === "OpenSessionLimit");
  assert.deepStrictEqual(store.snapshot(), before);
  assert.throws(() => store.open(history.id), (error) => error.code === "OpenSessionLimit");
  assert.deepStrictEqual(store.snapshot(), before);
});

test("after lowering the limit a new session closes enough idle tabs in display order", () => {
  const store = makeStore();
  const opened = fill(store);
  store.update(opened[0].id, { status: "streaming" });
  store.update(opened[2].id, { status: "starting" });
  store.setMaxOpenSessions(3);
  assert.strictEqual(store.snapshot().openConversationIds.length, 5);

  const newest = create(store, 6);

  assert.deepStrictEqual(store.snapshot().openConversationIds, [
    opened[0].id,
    opened[2].id,
    newest.id,
  ]);
  assert.ok([opened[1], opened[3], opened[4]].every(
    (conversation) => store.get(conversation.id).isOpen === false
  ));
  assert.strictEqual(store.listHistory().length, 6);
});

test("insufficient idle tabs after lowering the limit does not partially close tabs", () => {
  const store = makeStore();
  const history = create(store, 99);
  store.close(history.id);
  const opened = fill(store);
  [opened[0], opened[2], opened[3], opened[4]].forEach((conversation) => (
    store.update(conversation.id, { status: "streaming" })
  ));
  store.setMaxOpenSessions(3);
  const before = store.snapshot();

  assert.throws(() => create(store, 6), (error) => error.code === "OpenSessionLimit");
  assert.deepStrictEqual(store.snapshot(), before);
  assert.throws(() => store.open(history.id), (error) => error.code === "OpenSessionLimit");
  assert.deepStrictEqual(store.snapshot(), before);
});

test("invalid contexts cannot close tabs even when the workspace is full", () => {
  const store = makeStore();
  fill(store);
  const before = store.snapshot();

  assert.throws(() => store.createConversation({ context: {} }), TypeError);
  assert.deepStrictEqual(store.snapshot(), before);
});

test("controller creation and history restoration persist the automatic tab changes", async () => {
  const store = makeStore();
  const persisted = [];
  let turnCount = 0;
  const controller = new InterpretationWorkspaceController({
    resolver: {
      async resolve(_sourcePath, requestedId) {
        return makeContext(requestedId);
      },
    },
    promptBuilder: new InterpretationPromptBuilder(),
    store,
    skillCatalog: {
      async resolveProfile(profile) {
        return { profile, skillInputs: [], resolvedSkills: [] };
      },
      async resolveAvailable() {
        return { availableSkills: [] };
      },
    },
    runtime: {
      async runTurn() {
        turnCount += 1;
        return {
          threadId: `capacity-thread-${turnCount}`,
          turnId: `capacity-turn-${turnCount}`,
          text: `完整回答 ${turnCount}`,
          status: "completed",
        };
      },
    },
    async persistWorkspace(serialized) {
      persisted.push(JSON.parse(JSON.stringify(serialized)));
    },
  });
  const initialResults = [];
  for (let index = 1; index <= 5; index += 1) {
    const result = await controller.interpret(
      translationPath,
      `s8-01-${String(index).padStart(4, "0")}`
    );
    assert.strictEqual(result.state, "completed");
    initialResults.push(result);
  }
  const firstId = initialResults[0].conversationId;
  const secondId = initialResults[1].conversationId;

  const newest = await controller.interpret(translationPath, "s8-01-0006");

  assert.strictEqual(newest.state, "completed");
  assert.strictEqual(store.get(firstId).isOpen, false);
  assert.deepStrictEqual(persisted.at(-1), store.serialize());
  assert.strictEqual(persisted.at(-1).conversations.find(
    (conversation) => conversation.id === firstId
  ).isOpen, false);
  assert.strictEqual(persisted.at(-1).workspace.openConversationIds.length, 5);

  const reopened = await controller.interpret(translationPath, "s8-01-0001");

  assert.strictEqual(reopened.state, "opened");
  assert.strictEqual(reopened.conversationId, firstId);
  assert.strictEqual(turnCount, 6, "restoring history must not start another agent turn");
  assert.strictEqual(store.get(secondId).isOpen, false);
  assert.strictEqual(store.snapshot().activeConversationId, firstId);
  assert.deepStrictEqual(store.snapshot().openConversationIds, [
    ...initialResults.slice(2).map((result) => result.conversationId),
    newest.conversationId,
    firstId,
  ]);
  assert.deepStrictEqual(persisted.at(-1), store.serialize());
  const persistedStore = new InterpretationWorkspaceStore({
    ...persisted.at(-1),
    maxOpenSessions: 5,
  });
  assert.deepStrictEqual(persistedStore.snapshot().openConversationIds, store.snapshot().openConversationIds);
  assert.strictEqual(persistedStore.get(firstId).threadId, initialResults[0].threadId);
  assert.strictEqual(persistedStore.get(secondId).isOpen, false);

  const activatedHistory = await controller.activate(secondId);
  assert.strictEqual(activatedHistory.isOpen, true);
  assert.strictEqual(store.get(initialResults[2].conversationId).isOpen, false);
  assert.deepStrictEqual(store.snapshot().openConversationIds, [
    initialResults[3].conversationId,
    initialResults[4].conversationId,
    newest.conversationId,
    firstId,
    secondId,
  ]);
  assert.strictEqual(store.snapshot().activeConversationId, secondId);
  assert.deepStrictEqual(persisted.at(-1), store.serialize());
  assert.strictEqual(turnCount, 6);
});

const run = async () => {
  let failed = 0;
  for (const { name, run: runTest } of tests) {
    try {
      await runTest();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}`);
      console.error(error);
    }
  }
  if (failed > 0) {
    throw new Error(`${failed}/${tests.length} workspace capacity tests failed.`);
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
