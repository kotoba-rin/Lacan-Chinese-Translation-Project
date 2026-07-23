const {
  ACTIVE_STATUSES,
  STANDARD_SKILL_PROFILE,
  workspaceError,
} = require("./workspace-store");
const {
  skillProfileSignature,
  skillSnapshotsEqual,
} = require("./skill-catalog");
const { normalizeControllerError } = require("./interpretation-controller");

class InterpretationWorkspaceController {
  constructor({
    resolver,
    promptBuilder,
    store,
    runtime,
    skillCatalog,
    onState = () => {},
    persistWorkspace = async () => {},
  } = {}) {
    if (
      !resolver
      || !promptBuilder
      || !store
      || !runtime
      || !skillCatalog
    ) {
      throw new TypeError(
        "InterpretationWorkspaceController requires all domain services."
      );
    }
    this.resolver = resolver;
    this.promptBuilder = promptBuilder;
    this.store = store;
    this.runtime = runtime;
    this.skillCatalog = skillCatalog;
    this.onState = onState;
    this.persistWorkspace = persistWorkspace;
    this.runningTurns = new Map();
    this.pendingInterpretations = new Map();
    this.contexts = new Map();
  }

  snapshot() {
    return this.store.snapshot();
  }

  runningCount() {
    return this.runningTurns.size;
  }

  interpret(
    sourcePath,
    requestedId,
    {
      skillProfile = STANDARD_SKILL_PROFILE,
      model = "",
      effort = "",
      forceNew = false,
    } = {}
  ) {
    const normalizedSourcePath = String(sourcePath || "").trim();
    const normalizedRequestedId = String(requestedId || "").trim().toLowerCase();
    const requestKey = [
      normalizedSourcePath,
      normalizedRequestedId,
      skillProfileSignature(skillProfile),
      forceNew ? "new" : "reuse",
    ].join("::");
    if (this.pendingInterpretations.has(requestKey)) {
      return this.pendingInterpretations.get(requestKey);
    }
    const operation = this.performInterpret(
      normalizedSourcePath,
      normalizedRequestedId,
      { skillProfile, model, effort, forceNew }
    ).finally(() => {
      this.pendingInterpretations.delete(requestKey);
    });
    this.pendingInterpretations.set(requestKey, operation);
    return operation;
  }

  async performInterpret(
    sourcePath,
    requestedId,
    { skillProfile, model, effort, forceNew }
  ) {
    let conversation;
    try {
      const context = await this.resolver.resolve(sourcePath, requestedId);
      const builtPrompt = this.promptBuilder.buildInitial(context);
      const segmentKey = `${context.reference.translationPath}::${context.reference.primaryId}`;
      if (!forceNew) {
        const existing = this.store.findLatest(segmentKey, skillProfile);
        if (existing) {
          this.store.open(existing.id);
          this.contexts.set(existing.id, context);
          let staleError = null;
          if (
            existing.contextHash
            && existing.contextHash !== context.contextHash
          ) {
            staleError = {
              code: "ContextChanged",
              message: "分段或相关资料已经变化，可重新解读以使用当前内容。",
            };
          } else if (
            String(existing.promptVersion || "") !== builtPrompt.promptVersion
          ) {
            staleError = {
              code: "PromptChanged",
              message: "全局解读提示词已经变化，请重新解读以使用新提示词。",
            };
          }
          if (staleError && !ACTIVE_STATUSES.has(existing.status)) {
            this.store.update(existing.id, {
              status: "stale",
              error: staleError,
            });
          }
          if (
            existing.contextHash === context.contextHash
            && existing.promptVersion === builtPrompt.promptVersion
            && !String(existing.answer || "").trim()
            && existing.messages.length === 0
          ) {
            return await this.restoreEmptyConversation(existing.id, context);
          }
          await this.publish({ persist: true });
          return {
            state: "opened",
            conversationId: existing.id,
            conversation: this.store.get(existing.id),
          };
        }
      }
      conversation = this.store.createConversation({
        context,
        skillProfile,
        model,
        effort,
      });
      this.contexts.set(conversation.id, context);
      this.store.appendMessage(conversation.id, {
        role: "user",
        kind: "initial",
        status: "completed",
        content: `${context.reference.requestedId} · 初始解读`,
      });
      this.store.update(conversation.id, {
        status: "starting",
        promptVersion: builtPrompt.promptVersion,
      });
      await this.publish({ persist: true });
      return await this.startInitialTurn(
        conversation.id,
        context,
        builtPrompt
      );
    } catch (error) {
      if (conversation) {
        this.store.update(conversation.id, {
          status: "failed",
          error: normalizeControllerError(error),
        });
        await this.publish({ persist: true });
        return {
          state: "failed",
          conversationId: conversation.id,
          error: normalizeControllerError(error),
        };
      }
      return {
        state: "failed",
        error: normalizeControllerError(error),
      };
    }
  }

  async restoreEmptyConversation(conversationId, context) {
    const conversation = this.store.get(conversationId);
    if (!conversation?.threadId || typeof this.runtime.restoreThread !== "function") {
      const error = normalizeControllerError(workspaceError(
        "EmptyAgentResponse",
        "旧会话没有可显示的回答，请重新解读。"
      ));
      this.store.update(conversationId, {
        status: "failed",
        error,
      });
      await this.publish({ persist: true });
      return { state: "failed", conversationId, error };
    }
    this.store.update(conversationId, {
      status: "starting",
      error: null,
    });
    await this.publish({ persist: true });
    try {
      const built = applySkillProfileToPrompt(
        this.promptBuilder.buildInitial(context),
        conversation.skillProfile
      );
      const restored = await this.runtime.restoreThread({
        threadId: conversation.threadId,
        baseInstructions: built.baseInstructions,
        model: conversation.model,
      });
      const text = String(restored.text || "");
      if (!text.trim()) {
        throw workspaceError(
          "EmptyAgentResponse",
          "旧会话没有可显示的回答，请重新解读。"
        );
      }
      this.store.appendMessage(conversationId, {
        role: "user",
        kind: "initial",
        status: "completed",
        content: `${context.reference.requestedId} · 初始解读`,
      });
      this.store.appendMessage(conversationId, {
        role: "assistant",
        kind: "initial",
        status: restored.status === "interrupted"
          ? "interrupted"
          : "completed",
        content: text,
      });
      const status = restored.status === "interrupted"
        ? "interrupted"
        : "completed";
      this.store.update(conversationId, {
        threadId: restored.threadId,
        status,
        answer: text,
        error: status === "interrupted"
          ? {
              code: "TurnInterrupted",
              message: "旧会话曾被停止，已恢复当时收到的内容。",
            }
          : null,
      });
      await this.publish({ persist: true });
      return {
        state: status,
        conversationId,
        threadId: restored.threadId,
        text,
      };
    } catch (error) {
      const normalized = normalizeControllerError(error);
      this.store.update(conversationId, {
        status: "failed",
        error: normalized,
      });
      await this.publish({ persist: true });
      return {
        state: "failed",
        conversationId,
        error: normalized,
      };
    }
  }

  async startInitialTurn(conversationId, context, builtPrompt = null) {
    const conversation = this.store.get(conversationId);
    const resolvedProfile = await this.skillCatalog.resolveProfile(
      conversation.skillProfile
    );
    this.store.update(conversationId, {
      skillSnapshot: compactSkillSnapshot(resolvedProfile.resolvedSkills),
    });
    const built = applySkillProfileToPrompt(
      builtPrompt || this.promptBuilder.buildInitial(context),
      resolvedProfile.profile
    );
    return this.executeTurn({
      conversationId,
      context,
      baseInstructions: built.baseInstructions,
      prompt: built.userPrompt,
      skillInputs: resolvedProfile.skillInputs,
      threadId: "",
      kind: "initial",
    });
  }

  async followUp(conversationId, question) {
    const conversation = this.store.get(conversationId);
    if (!conversation) {
      return {
        state: "failed",
        error: normalizeControllerError(
          workspaceError("ConversationNotFound", "找不到这个解读会话。")
        ),
      };
    }
    if (this.runningTurns.has(conversationId)) {
      return {
        state: "busy",
        conversationId,
        error: normalizeControllerError(workspaceError(
          "TurnBusy",
          "这个会话仍在生成，问题草稿已经保留。"
        )),
      };
    }
    if (this.runningTurns.size >= this.store.maxOpenSessions) {
      return {
        state: "busy",
        conversationId,
        error: normalizeControllerError(workspaceError(
          "ConcurrencyLimit",
          `当前已有 ${this.runningTurns.size} 个任务在生成，问题草稿已经保留。`
        )),
      };
    }
    const normalizedQuestion = String(
      question === undefined ? conversation.draft : question
    ).trim();
    if (!normalizedQuestion) {
      return {
        state: "empty",
        conversationId,
        error: normalizeControllerError(workspaceError(
          "EmptyFollowUp",
          "请输入继续追问的内容。"
        )),
      };
    }
    try {
      const context = await this.resolveConversationContext(conversation);
      const resolvedProfile = await this.skillCatalog.resolveProfile(
        conversation.skillProfile
      );
      const currentSkillSnapshot = compactSkillSnapshot(
        resolvedProfile.resolvedSkills
      );
      if (
        conversation.skillSnapshot?.length > 0
        && !skillSnapshotsEqual(
          conversation.skillSnapshot,
          currentSkillSnapshot
        )
      ) {
        throw workspaceError(
          "SkillChanged",
          "这个会话使用的 Skill 已经更新。请重新解读，以保留旧结果并用新版创建新会话。"
        );
      }
      if (
        (!conversation.skillSnapshot || conversation.skillSnapshot.length === 0)
        && currentSkillSnapshot.length > 0
      ) {
        this.store.update(conversationId, {
          skillSnapshot: currentSkillSnapshot,
        });
      }
      const initialPrompt = applySkillProfileToPrompt(
        this.promptBuilder.buildInitial(context),
        resolvedProfile.profile
      );
      if (
        String(conversation.promptVersion || "")
        !== initialPrompt.promptVersion
      ) {
        throw workspaceError(
          "PromptChanged",
          "全局解读提示词已经变化。请重新解读后再继续追问。"
        );
      }
      const prompt = this.promptBuilder.buildFollowUp(context, normalizedQuestion);
      const userMessage = this.store.appendMessage(conversationId, {
        role: "user",
        kind: "follow-up",
        status: "completed",
        content: normalizedQuestion,
      });
      this.store.update(conversationId, {
        status: "starting",
        error: null,
      });
      await this.publish({ persist: true });
      return await this.executeTurn({
        conversationId,
        context,
        baseInstructions: initialPrompt.baseInstructions,
        prompt,
        skillInputs: resolvedProfile.skillInputs,
        threadId: conversation.threadId,
        kind: "follow-up",
        acceptedDraft: normalizedQuestion,
        userMessageId: userMessage.id,
      });
    } catch (error) {
      this.store.update(conversationId, {
        status: "failed",
        error: normalizeControllerError(error),
      });
      await this.publish({ persist: true });
      return {
        state: "failed",
        conversationId,
        error: normalizeControllerError(error),
      };
    }
  }

  async executeTurn({
    conversationId,
    context,
    baseInstructions,
    prompt,
    skillInputs,
    threadId,
    kind,
    acceptedDraft,
    userMessageId,
  }) {
    if (this.runningTurns.has(conversationId)) {
      return {
        state: "busy",
        conversationId,
        error: normalizeControllerError(workspaceError(
          "TurnBusy",
          "这个会话仍在生成。"
        )),
      };
    }
    if (this.runningTurns.size >= this.store.maxOpenSessions) {
      return {
        state: "busy",
        conversationId,
        error: normalizeControllerError(workspaceError(
          "ConcurrencyLimit",
          "同时生成的任务已经达到会话上限。"
        )),
      };
    }
    const conversationBeforeTurn = this.store.get(conversationId);
    const assistantMessage = this.store.appendMessage(conversationId, {
      role: "assistant",
      kind,
      status: "pending",
      content: "",
    });
    const turnState = {
      threadId: String(threadId || ""),
      turnId: "",
      assistantMessageId: assistantMessage.id,
      userMessageId,
      accepted: false,
    };
    this.runningTurns.set(conversationId, turnState);
    try {
      const result = await this.runtime.runTurn({
        ...(threadId ? { threadId } : {}),
        baseInstructions,
        prompt,
        skillInputs,
        model: conversationBeforeTurn.model,
        effort: conversationBeforeTurn.effort,
        onEvent: (event) => {
          void this.handleRuntimeEvent(
            conversationId,
            context,
            assistantMessage.id,
            event,
            acceptedDraft
          );
        },
      });
      const status = result.status === "interrupted" ? "interrupted" : "completed";
      this.store.updateMessage(conversationId, assistantMessage.id, {
        content: result.text,
        status,
      });
      this.store.update(conversationId, {
        threadId: result.threadId,
        turnId: result.turnId,
        status,
        answer: result.text,
        error: status === "interrupted"
          ? {
              code: "TurnInterrupted",
              message: "解读已停止，已保留收到的内容。",
            }
          : null,
      });
      this.store.markAttention(conversationId);
      await this.publish({ persist: true });
      return {
        state: status,
        conversationId,
        threadId: result.threadId,
        turnId: result.turnId,
        text: result.text,
      };
    } catch (error) {
      const normalized = normalizeControllerError(error);
      const current = this.store.get(conversationId);
      const partial = current?.messages.find(
        (message) => message.id === assistantMessage.id
      )?.content || "";
      if (turnState.accepted) {
        this.store.updateMessage(conversationId, assistantMessage.id, {
          content: partial,
          status: "failed",
        });
      } else {
        this.store.removeMessage(conversationId, assistantMessage.id);
        if (userMessageId) {
          this.store.removeMessage(conversationId, userMessageId);
        }
      }
      this.store.update(conversationId, {
        status: "failed",
        answer: turnState.accepted
          ? partial || conversationBeforeTurn.answer
          : conversationBeforeTurn.answer,
        error: normalized,
      });
      this.store.markAttention(conversationId);
      await this.publish({ persist: true });
      return {
        state: "failed",
        conversationId,
        error: normalized,
      };
    } finally {
      this.runningTurns.delete(conversationId);
    }
  }

  async handleRuntimeEvent(
    conversationId,
    context,
    assistantMessageId,
    event,
    acceptedDraft
  ) {
    const active = this.runningTurns.get(conversationId);
    if (!active) {
      return;
    }
    if (event.type === "started") {
      active.accepted = true;
      active.threadId = event.threadId;
      active.turnId = event.turnId;
      const currentDraft = this.store.get(conversationId)?.draft || "";
      if (
        acceptedDraft !== undefined
        && currentDraft.trim() === String(acceptedDraft).trim()
      ) {
        this.store.updateDraft(conversationId, "");
      }
      this.store.update(conversationId, {
        threadId: event.threadId,
        turnId: event.turnId,
        status: "searching",
        error: null,
      });
      await this.publish({ persist: true });
      return;
    }
    if (event.type === "delta") {
      this.store.updateMessage(conversationId, assistantMessageId, {
        content: String(event.text || ""),
        status: "pending",
      });
      this.store.update(conversationId, {
        status: "streaming",
        answer: String(event.text || ""),
        threadId: event.threadId,
        turnId: event.turnId,
      });
      const conversation = this.store.get(conversationId);
      if (
        this.store.activeConversationId !== conversationId
        || conversation.scroll.followLatest === false
      ) {
        this.store.updateScroll(conversationId, {
          // A streamed assistant response is one unread item even if the
          // App Server delivers it in thousands of incremental deltas.
          unseenMessageCount: Math.max(
            1,
            conversation.scroll.unseenMessageCount
          ),
        });
      }
      await this.publish({ persist: false });
    }
  }

  async resolveConversationContext(conversation) {
    if (this.contexts.has(conversation.id)) {
      return this.contexts.get(conversation.id);
    }
    const context = await this.resolver.resolve(
      conversation.sourcePath,
      conversation.requestedId
    );
    this.contexts.set(conversation.id, context);
    return context;
  }

  async retry(conversationId) {
    const conversation = this.store.get(conversationId);
    if (!conversation) {
      return {
        state: "failed",
        error: normalizeControllerError(workspaceError(
          "ConversationNotFound",
          "找不到这个解读会话。"
        )),
      };
    }
    const needsCurrentSlot = conversation.isOpen
      && this.store.openConversationIds.length >= this.store.maxOpenSessions;
    if (needsCurrentSlot) {
      try {
        this.store.close(conversation.id);
        await this.publish({ persist: true });
      } catch (error) {
        return {
          state: "failed",
          conversationId,
          error: normalizeControllerError(error),
        };
      }
    }
    const result = await this.interpret(
      conversation.sourcePath,
      conversation.requestedId,
      {
      skillProfile: conversation.skillProfile,
      model: conversation.model,
      effort: conversation.effort,
      forceNew: true,
      }
    );
    if (needsCurrentSlot && result.state === "failed" && !result.conversationId) {
      this.store.open(conversation.id);
      await this.publish({ persist: true });
    }
    return result;
  }

  async stop(conversationId) {
    const active = this.runningTurns.get(String(conversationId || ""));
    if (!active) {
      return false;
    }
    return this.runtime.interrupt({
      threadId: active.threadId,
      turnId: active.turnId,
    });
  }

  async activate(conversationId) {
    this.store.activate(conversationId);
    await this.publish({ persist: true });
    return this.store.get(conversationId);
  }

  async close(conversationId) {
    this.store.close(conversationId);
    await this.publish({ persist: true });
    return true;
  }

  async delete(conversationId) {
    const removed = this.store.delete(conversationId);
    await this.publish({ persist: true });
    return removed;
  }

  async clearAll() {
    if (this.runningTurns.size > 0 || this.pendingInterpretations.size > 0) {
      throw workspaceError(
        "ConversationClearBusy",
        "仍有 AI 任务正在运行，请先停止并等待任务结束后再清空全部会话。"
      );
    }
    const removedCount = this.store.clearAll();
    this.contexts.clear();
    await this.publish({ persist: true });
    return removedCount;
  }

  async rename(conversationId, title) {
    const conversation = this.store.rename(conversationId, title);
    await this.publish({ persist: true });
    return conversation;
  }

  async updateDraft(conversationId, draft) {
    this.store.updateDraft(conversationId, draft);
    await this.publish({ persist: false });
  }

  async updateScroll(conversationId, scroll) {
    this.store.updateScroll(conversationId, scroll);
    await this.publish({ persist: false });
  }

  async publish({ persist = false } = {}) {
    const snapshot = this.store.snapshot();
    this.onState(snapshot);
    if (persist) {
      await this.persistWorkspace(this.store.serialize());
    }
    return snapshot;
  }
}

const applySkillProfileToPrompt = (built) => ({ ...built });

const compactSkillSnapshot = (skills) => (
  Array.isArray(skills) ? skills : []
).map((skill) => ({
  name: String(skill?.name || ""),
  scope: String(skill?.scope || ""),
  path: String(skill?.path || ""),
  fingerprint: String(skill?.fingerprint || ""),
}));

module.exports = {
  InterpretationWorkspaceController,
  applySkillProfileToPrompt,
  compactSkillSnapshot,
};
