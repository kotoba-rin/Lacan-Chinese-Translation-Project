const {
  STANDARD_SKILL_PROFILE,
  normalizeSkillProfile,
  skillProfileSignature,
} = require("./skill-catalog");

const ACTIVE_STATUSES = new Set([
  "resolving",
  "starting",
  "searching",
  "streaming",
]);

const normalizeMaxOpenSessions = (value) => {
  const parsed = Number.parseInt(value, 10);
  const fallback = Number.isFinite(parsed) ? parsed : 3;
  return Math.min(5, Math.max(1, fallback));
};

const clone = (value) => (
  value === undefined ? undefined : JSON.parse(JSON.stringify(value))
);

const defaultIdFactory = (prefix) => {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const normalizeScroll = (value) => ({
  followLatest: value?.followLatest !== false,
  scrollTop: Math.max(0, Number(value?.scrollTop || 0)),
  unseenMessageCount: Math.max(
    0,
    Number.parseInt(value?.unseenMessageCount, 10) || 0
  ),
});

const normalizeMessage = (value, idFactory) => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const role = value.role === "assistant" ? "assistant" : "user";
  const content = String(value.content || "");
  if (!content && value.status !== "pending") {
    return null;
  }
  return {
    id: String(value.id || idFactory("message")),
    role,
    content,
    kind: value.kind === "initial" ? "initial" : "follow-up",
    status: ["pending", "completed", "failed", "interrupted"].includes(value.status)
      ? value.status
      : "completed",
    createdAt: String(value.createdAt || new Date().toISOString()),
  };
};

const normalizeStoredProfile = (value) => {
  if (!value || value.id === "standard") {
    return { ...STANDARD_SKILL_PROFILE };
  }
  return normalizeSkillProfile(value) || { ...STANDARD_SKILL_PROFILE };
};

class InterpretationWorkspaceStore {
  constructor({
    conversations = [],
    workspace = {},
    maxOpenSessions = 3,
    idFactory = defaultIdFactory,
    now = () => new Date(),
  } = {}) {
    this.maxOpenSessions = normalizeMaxOpenSessions(maxOpenSessions);
    this.idFactory = idFactory;
    this.now = now;
    this.conversations = new Map();
    for (const value of Array.isArray(conversations) ? conversations : []) {
      const normalized = this.normalizeConversation(value);
      if (normalized) {
        this.conversations.set(normalized.id, normalized);
      }
    }
    const requestedOpenIds = Array.isArray(workspace?.openConversationIds)
      ? workspace.openConversationIds.map(String)
      : Array.from(this.conversations.values())
          .filter((conversation) => conversation.isOpen)
          .map((conversation) => conversation.id);
    this.openConversationIds = requestedOpenIds.filter(
      (id, index, list) => this.conversations.has(id) && list.indexOf(id) === index
    );
    for (const conversation of this.conversations.values()) {
      conversation.isOpen = this.openConversationIds.includes(conversation.id);
    }
    const requestedActiveId = String(workspace?.activeConversationId || "");
    this.activeConversationId = this.openConversationIds.includes(requestedActiveId)
      ? requestedActiveId
      : this.openConversationIds.at(-1) || null;
  }

  normalizeConversation(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const id = String(value.id || "").trim();
    const segmentKey = String(value.segmentKey || "").trim();
    if (!id || !segmentKey) {
      return null;
    }
    const profile = normalizeStoredProfile(value.skillProfile);
    const messages = (Array.isArray(value.messages) ? value.messages : [])
      .map((message) => normalizeMessage(message, this.idFactory))
      .filter(Boolean);
    const status = String(value.status || "completed");
    const interruptedByRestart = ACTIVE_STATUSES.has(status);
    if (interruptedByRestart) {
      for (const message of messages) {
        if (message.status === "pending") {
          message.status = "interrupted";
        }
      }
    }
    return {
      id,
      title: String(value.title || value.requestedId || segmentKey).trim(),
      segmentKey,
      sourcePath: String(value.sourcePath || segmentKey.split("::")[0] || ""),
      requestedId: String(
        value.requestedId || segmentKey.split("::")[1] || ""
      ),
      primaryId: String(value.primaryId || segmentKey.split("::")[1] || ""),
      lessonTitle: String(value.lessonTitle || ""),
      contextHash: String(value.contextHash || ""),
      promptVersion: String(value.promptVersion || ""),
      threadId: String(value.threadId || ""),
      turnId: String(value.turnId || ""),
      status: interruptedByRestart ? "interrupted" : status,
      answer: String(value.answer || ""),
      messages,
      skillProfile: profile,
      skillProfileSignature: String(
        value.skillProfileSignature || skillProfileSignature(profile)
      ),
      skillSnapshot: (Array.isArray(value.skillSnapshot)
        ? value.skillSnapshot
        : []).map((skill) => ({ ...skill })),
      model: String(value.model || ""),
      effort: String(value.effort || ""),
      draft: String(value.draft || ""),
      scroll: normalizeScroll(value.scroll),
      error: interruptedByRestart
        ? {
            code: "TurnInterrupted",
            message: "Obsidian 上次关闭时任务仍在生成；已保留收到的内容，可以重新解读。",
          }
        : value.error
          ? clone(value.error)
          : null,
      needsAttention: Boolean(value.needsAttention),
      isOpen: Boolean(value.isOpen),
      createdAt: String(value.createdAt || this.now().toISOString()),
      updatedAt: String(value.updatedAt || value.createdAt || this.now().toISOString()),
    };
  }

  snapshot() {
    return {
      maxOpenSessions: this.maxOpenSessions,
      openConversationIds: [...this.openConversationIds],
      activeConversationId: this.activeConversationId,
      conversations: Array.from(this.conversations.values())
        .map((conversation) => clone(conversation))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      runningCount: Array.from(this.conversations.values())
        .filter((conversation) => ACTIVE_STATUSES.has(conversation.status))
        .length,
    };
  }

  serialize() {
    const snapshot = this.snapshot();
    return {
      conversations: snapshot.conversations,
      workspace: {
        openConversationIds: snapshot.openConversationIds,
        activeConversationId: snapshot.activeConversationId,
      },
    };
  }

  setMaxOpenSessions(value) {
    this.maxOpenSessions = normalizeMaxOpenSessions(value);
    return this.maxOpenSessions;
  }

  get(id) {
    const conversation = this.conversations.get(String(id || ""));
    return conversation ? clone(conversation) : undefined;
  }

  getMutable(id) {
    return this.conversations.get(String(id || ""));
  }

  createConversation({
    context,
    skillProfile = STANDARD_SKILL_PROFILE,
    model = "",
    effort = "",
  } = {}) {
    if (this.openConversationIds.length >= this.maxOpenSessions) {
      throw workspaceError(
        "OpenSessionLimit",
        `同时打开的会话已达到上限 ${this.maxOpenSessions}。请先关闭一个空闲会话。`
      );
    }
    const reference = context?.reference;
    if (!reference?.translationPath || !reference?.primaryId) {
      throw new TypeError("createConversation requires a resolved segment context.");
    }
    const now = this.now().toISOString();
    const profile = normalizeStoredProfile(skillProfile);
    const conversation = {
      id: this.idFactory("conversation"),
      title: profile.id === "standard"
        ? reference.requestedId || reference.primaryId
        : `${reference.requestedId || reference.primaryId} · ${profile.title}`,
      segmentKey: `${reference.translationPath}::${reference.primaryId}`,
      sourcePath: reference.translationPath,
      requestedId: reference.requestedId,
      primaryId: reference.primaryId,
      lessonTitle: String(context.lessonTitle || ""),
      contextHash: String(context.contextHash || ""),
      promptVersion: "",
      threadId: "",
      turnId: "",
      status: "idle",
      answer: "",
      messages: [],
      skillProfile: profile,
      skillProfileSignature: skillProfileSignature(profile),
      skillSnapshot: [],
      model: String(model || ""),
      effort: String(effort || ""),
      draft: "",
      scroll: normalizeScroll(),
      error: null,
      needsAttention: false,
      isOpen: true,
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(conversation.id, conversation);
    this.openConversationIds.push(conversation.id);
    this.activeConversationId = conversation.id;
    return clone(conversation);
  }

  findLatest(segmentKey, profile) {
    const signature = skillProfileSignature(profile);
    return Array.from(this.conversations.values())
      .filter((conversation) => (
        conversation.segmentKey === segmentKey
        && conversation.skillProfileSignature === signature
      ))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  open(id, { activate = true } = {}) {
    const conversation = this.requireConversation(id);
    if (!conversation.isOpen) {
      if (this.openConversationIds.length >= this.maxOpenSessions) {
        throw workspaceError(
          "OpenSessionLimit",
          `同时打开的会话已达到上限 ${this.maxOpenSessions}。请先关闭一个空闲会话。`
        );
      }
      conversation.isOpen = true;
      this.openConversationIds.push(conversation.id);
    }
    if (activate) {
      this.activate(conversation.id);
    }
    return clone(conversation);
  }

  activate(id) {
    const conversation = this.requireConversation(id);
    if (!conversation.isOpen) {
      this.open(id, { activate: false });
    }
    this.activeConversationId = conversation.id;
    conversation.needsAttention = false;
    if (conversation.scroll.followLatest !== false) {
      conversation.scroll.unseenMessageCount = 0;
    }
    return clone(conversation);
  }

  close(id) {
    const conversation = this.requireConversation(id);
    if (ACTIVE_STATUSES.has(conversation.status)) {
      throw workspaceError(
        "ConversationRunning",
        "这个会话仍在生成，请先停止后再关闭。"
      );
    }
    conversation.isOpen = false;
    this.openConversationIds = this.openConversationIds.filter(
      (conversationId) => conversationId !== conversation.id
    );
    if (this.activeConversationId === conversation.id) {
      this.activeConversationId = this.openConversationIds.at(-1) || null;
    }
    return clone(conversation);
  }

  delete(id) {
    const conversation = this.requireConversation(id);
    if (ACTIVE_STATUSES.has(conversation.status)) {
      throw workspaceError(
        "ConversationRunning",
        "正在生成的会话不能删除，请先停止。"
      );
    }
    this.openConversationIds = this.openConversationIds.filter(
      (conversationId) => conversationId !== conversation.id
    );
    if (this.activeConversationId === conversation.id) {
      this.activeConversationId = this.openConversationIds.at(-1) || null;
    }
    return this.conversations.delete(conversation.id);
  }

  clearAll() {
    const removedCount = this.conversations.size;
    this.conversations.clear();
    this.openConversationIds = [];
    this.activeConversationId = null;
    return removedCount;
  }

  rename(id, title) {
    const normalized = String(title || "").trim();
    if (!normalized) {
      throw workspaceError("EmptyConversationTitle", "会话标题不能为空。");
    }
    return this.update(id, { title: normalized });
  }

  update(id, patch = {}) {
    const conversation = this.requireConversation(id);
    const protectedFields = new Set([
      "id",
      "segmentKey",
      "skillProfile",
      "skillProfileSignature",
      "createdAt",
      "isOpen",
      "draft",
      "scroll",
      "messages",
    ]);
    for (const [key, value] of Object.entries(patch)) {
      if (!protectedFields.has(key) && value !== undefined) {
        conversation[key] = clone(value);
      }
    }
    conversation.updatedAt = this.now().toISOString();
    return clone(conversation);
  }

  updateDraft(id, draft) {
    const conversation = this.requireConversation(id);
    conversation.draft = String(draft || "");
    return conversation.draft;
  }

  updateScroll(id, scroll) {
    const conversation = this.requireConversation(id);
    conversation.scroll = normalizeScroll({
      ...conversation.scroll,
      ...scroll,
    });
    return clone(conversation.scroll);
  }

  appendMessage(id, message) {
    const conversation = this.requireConversation(id);
    const normalized = normalizeMessage({
      ...message,
      id: message?.id || this.idFactory("message"),
      createdAt: message?.createdAt || this.now().toISOString(),
    }, this.idFactory);
    if (!normalized) {
      throw new TypeError("Invalid conversation message.");
    }
    conversation.messages.push(normalized);
    conversation.updatedAt = this.now().toISOString();
    return clone(normalized);
  }

  updateMessage(id, messageId, patch = {}) {
    const conversation = this.requireConversation(id);
    const message = conversation.messages.find(
      (candidate) => candidate.id === messageId
    );
    if (!message) {
      throw workspaceError("MessageNotFound", "找不到要更新的会话消息。");
    }
    for (const key of ["content", "status"]) {
      if (patch[key] !== undefined) {
        message[key] = String(patch[key]);
      }
    }
    conversation.updatedAt = this.now().toISOString();
    return clone(message);
  }

  removeMessage(id, messageId) {
    const conversation = this.requireConversation(id);
    const before = conversation.messages.length;
    conversation.messages = conversation.messages.filter(
      (message) => message.id !== messageId
    );
    return before !== conversation.messages.length;
  }

  markAttention(id) {
    const conversation = this.requireConversation(id);
    conversation.needsAttention = this.activeConversationId !== id;
    return conversation.needsAttention;
  }

  listHistory() {
    return Array.from(this.conversations.values())
      .map((conversation) => clone(conversation))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  requireConversation(id) {
    const conversation = this.conversations.get(String(id || ""));
    if (!conversation) {
      throw workspaceError("ConversationNotFound", "找不到这个解读会话。");
    }
    return conversation;
  }

  static migrateLegacy({
    legacySessions = [],
    idFactory = defaultIdFactory,
  } = {}) {
    const conversations = [];
    for (const record of Array.isArray(legacySessions) ? legacySessions : []) {
      if (!record?.segmentKey) {
        continue;
      }
      const [sourcePath, requestedId] = String(record.segmentKey).split("::");
      const answer = String(record.answer || "");
      const timestamp = String(record.lastOpenedAt || new Date().toISOString());
      conversations.push({
        id: idFactory("conversation"),
        title: requestedId || "旧解读",
        segmentKey: record.segmentKey,
        sourcePath: sourcePath || "",
        requestedId: requestedId || "",
        primaryId: requestedId || "",
        contextHash: String(record.contextHash || ""),
        promptVersion: String(record.promptVersion || ""),
        threadId: String(record.threadId || ""),
        status: String(record.status || "completed"),
        answer,
        messages: answer
          ? [{
              id: idFactory("message"),
              role: "assistant",
              content: answer,
              kind: "initial",
              status: "completed",
              createdAt: timestamp,
            }]
          : [],
        skillProfile: { ...STANDARD_SKILL_PROFILE },
        skillProfileSignature: "standard",
        skillSnapshot: [],
        draft: "",
        scroll: normalizeScroll(),
        error: null,
        needsAttention: false,
        isOpen: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
    return {
      conversations,
      workspace: {
        openConversationIds: [],
        activeConversationId: null,
      },
    };
  }
}

const workspaceError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

module.exports = {
  ACTIVE_STATUSES,
  InterpretationWorkspaceStore,
  STANDARD_SKILL_PROFILE,
  normalizeMaxOpenSessions,
  normalizeScroll,
  workspaceError,
};
