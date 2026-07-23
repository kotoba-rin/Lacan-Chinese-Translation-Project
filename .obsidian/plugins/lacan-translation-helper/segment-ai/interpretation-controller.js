const { PROMPT_VERSION } = require("./prompt-builder");

const UNAVAILABLE_ERROR_CODES = new Set([
  "CodexNotFound",
  "CodexAuthRequired",
  "AppServerIncompatible",
  "ReadOnlyBoundaryRejected",
  "ExternalToolsAvailable",
]);

class SegmentInterpretationController {
  constructor({
    resolver,
    promptBuilder,
    sessionStore,
    runtime,
    onState = () => {},
    persistSessions = async () => {},
    now = () => new Date(),
  } = {}) {
    if (!resolver || !promptBuilder || !sessionStore || !runtime) {
      throw new TypeError("SegmentInterpretationController requires all domain services.");
    }
    this.resolver = resolver;
    this.promptBuilder = promptBuilder;
    this.sessionStore = sessionStore;
    this.runtime = runtime;
    this.onState = onState;
    this.persistSessions = persistSessions;
    this.now = now;
    this.currentContext = null;
    this.currentThreadId = null;
    this.currentAnswer = "";
    this.currentConversation = [];
    this.lastRequest = null;
    this.inFlight = null;
    this.inFlightKey = null;
  }

  interpret(sourcePath, requestedId, { forceNew = false } = {}) {
    const requestKey = `${sourcePath}::${requestedId}::${forceNew ? "new" : "reuse"}`;
    if (this.inFlight && this.inFlightKey === requestKey) {
      return this.inFlight;
    }
    if (this.inFlight) {
      return Promise.resolve(this.busyResult(
        "已有一个分段正在生成，请先等待完成或停止。"
      ));
    }
    this.inFlightKey = requestKey;
    this.inFlight = this.performInterpret(sourcePath, requestedId, { forceNew })
      .finally(() => {
        this.inFlight = null;
        this.inFlightKey = null;
      });
    return this.inFlight;
  }

  async performInterpret(sourcePath, requestedId, { forceNew }) {
    this.lastRequest = { sourcePath, requestedId };
    this.emit({
      status: "resolving",
      sourcePath,
      requestedId,
      answer: "",
    });
    try {
      const context = await this.resolver.resolve(sourcePath, requestedId);
      this.currentContext = context;
      this.currentAnswer = "";
      this.currentConversation = [];
      const evaluation = this.sessionStore.evaluate(context);

      if (!forceNew && evaluation.state === "stale") {
        return await this.restoreStaleSession(context, evaluation);
      }

      if (!forceNew && evaluation.state === "current") {
        return await this.restoreCurrentSession(context, evaluation.record);
      }

      return await this.startInitialTurn(context);
    } catch (error) {
      return this.emitFailure(error);
    }
  }

  async restoreCurrentSession(context, record) {
    this.emit({
      status: "starting",
      phase: "restoring",
      context,
      answer: "",
    });
    const cachedAnswer = String(record.answer || "");
    this.currentAnswer = cachedAnswer;
    const restored = await this.runtime.restoreThread({
      threadId: record.threadId,
      baseInstructions: this.promptBuilder.buildInitial(context).baseInstructions,
    });
    this.currentThreadId = restored.threadId;
    const runtimeStatus = String(restored.status || "").trim().toLowerCase();
    const runtimeAnswer = String(restored.text || "");
    const hasCompletedCache = record.status === "completed"
      && Boolean(cachedAnswer.trim());
    this.currentAnswer = runtimeStatus === "completed" && runtimeAnswer.trim()
      ? runtimeAnswer
      : cachedAnswer || runtimeAnswer;
    this.currentConversation = this.currentAnswer
      ? [{ role: "assistant", content: this.currentAnswer }]
      : [];
    const restoredStatus = hasCompletedCache
      ? "completed"
      : String(runtimeStatus || record.status || "").trim().toLowerCase();
    if (restoredStatus === "interrupted") {
      const error = {
        code: "TurnInterrupted",
        message: "上一次解读已停止，可以重新解读。",
      };
      this.sessionStore.upsert({
        ...record,
        lastOpenedAt: this.now().toISOString(),
        status: "interrupted",
        answer: this.currentAnswer,
      });
      await this.persist();
      this.emit({
        status: "failed",
        context,
        answer: this.currentAnswer,
        conversation: [...this.currentConversation],
        threadId: this.currentThreadId,
        restored: true,
        error,
      });
      return {
        state: "interrupted",
        context,
        threadId: this.currentThreadId,
        answer: this.currentAnswer,
        restored: true,
        error,
      };
    }
    if (!this.currentAnswer.trim()) {
      this.sessionStore.upsert({
        ...record,
        lastOpenedAt: this.now().toISOString(),
        status: "failed",
        answer: this.currentAnswer,
      });
      await this.persist();
      return this.emitFailure({
        code: "EmptyAgentResponse",
        message: "旧解读会话没有可显示的回答，请重新解读。",
      });
    }
    this.sessionStore.upsert({
      ...record,
      lastOpenedAt: this.now().toISOString(),
      status: "completed",
      answer: this.currentAnswer,
    });
    await this.persist();
    this.emit({
      status: "completed",
      context,
      answer: this.currentAnswer,
      conversation: [...this.currentConversation],
      threadId: this.currentThreadId,
      restored: true,
    });
    return {
      state: "completed",
      context,
      threadId: this.currentThreadId,
      answer: this.currentAnswer,
      restored: true,
    };
  }

  async restoreStaleSession(context, evaluation) {
    const record = evaluation.record;
    this.currentThreadId = record.threadId;
    this.emit({
      status: "starting",
      phase: "restoring-stale",
      context,
      answer: "",
      session: record,
    });
    const cachedAnswer = String(record.answer || "");
    this.currentAnswer = cachedAnswer;
    this.currentConversation = cachedAnswer
      ? [{ role: "assistant", content: cachedAnswer }]
      : [];
    let restoreError;
    try {
      const restored = await this.runtime.restoreThread({
        threadId: record.threadId,
        baseInstructions: this.promptBuilder.buildInitial(context).baseInstructions,
      });
      this.currentThreadId = restored.threadId;
      this.currentAnswer = restored.text || cachedAnswer;
      this.currentConversation = this.currentAnswer
        ? [{ role: "assistant", content: this.currentAnswer }]
        : [];
      this.sessionStore.upsert({
        ...record,
        lastOpenedAt: this.now().toISOString(),
        answer: this.currentAnswer,
      });
      await this.persist();
    } catch (error) {
      restoreError = normalizeControllerError(error);
      this.currentAnswer = cachedAnswer;
      this.currentConversation = cachedAnswer
        ? [{ role: "assistant", content: cachedAnswer }]
        : [];
    }
    this.emit({
      status: "stale",
      context,
      answer: this.currentAnswer,
      conversation: [...this.currentConversation],
      session: record,
      staleReasons: evaluation.reasons,
      threadId: this.currentThreadId,
      restored: !restoreError,
      ...(restoreError ? { error: restoreError } : {}),
    });
    return {
      state: "stale",
      context,
      session: record,
      answer: this.currentAnswer,
      ...(restoreError ? { error: restoreError } : {}),
    };
  }

  async startInitialTurn(context) {
    const builtPrompt = this.promptBuilder.buildInitial(context);
    this.emit({
      status: "starting",
      phase: "starting",
      context,
      answer: "",
    });
    const result = await this.runtime.runTurn({
      baseInstructions: builtPrompt.baseInstructions,
      prompt: builtPrompt.userPrompt,
      onEvent: (event) => this.handleRuntimeEvent(event, context),
    });
    return this.finishSuccessfulTurn({
      context,
      result,
      conversation: result.text
        ? [{ role: "assistant", content: result.text }]
        : [],
    });
  }

  followUp(question) {
    if (!this.currentContext || !this.currentThreadId) {
      return Promise.resolve(this.emitFailure({
        code: "ThreadUnavailable",
        message: "当前没有可继续追问的分段会话。",
      }));
    }
    if (this.inFlight) {
      return Promise.resolve(this.busyResult("当前回答尚未完成。"));
    }
    this.inFlightKey = `follow-up::${this.currentThreadId}`;
    this.inFlight = this.performFollowUp(question)
      .finally(() => {
        this.inFlight = null;
        this.inFlightKey = null;
      });
    return this.inFlight;
  }

  async performFollowUp(question) {
    const context = this.currentContext;
    const prompt = this.promptBuilder.buildFollowUp(context, question);
    const normalizedQuestion = String(question || "").trim();
    this.currentAnswer = "";
    this.currentConversation = [{ role: "user", content: normalizedQuestion }];
    this.emit({
      status: "starting",
      phase: "follow-up",
      context,
      answer: "",
      conversation: [...this.currentConversation],
      threadId: this.currentThreadId,
    });
    try {
      const result = await this.runtime.runTurn({
        threadId: this.currentThreadId,
        baseInstructions: this.promptBuilder.buildInitial(context).baseInstructions,
        prompt,
        onEvent: (event) => this.handleRuntimeEvent(event, context),
      });
      return await this.finishSuccessfulTurn({
        context,
        result,
        conversation: [
          { role: "user", content: normalizedQuestion },
          { role: "assistant", content: result.text },
        ],
      });
    } catch (error) {
      return this.emitFailure(error);
    }
  }

  async finishSuccessfulTurn({ context, result, conversation }) {
    this.currentThreadId = result.threadId;
    this.currentAnswer = result.text || "";
    this.currentConversation = conversation;
    const status = result.status === "interrupted" ? "interrupted" : "completed";
    if (status === "completed" && !this.currentAnswer.trim()) {
      this.sessionStore.upsert({
        segmentKey: `${context.reference.translationPath}::${context.reference.primaryId}`,
        threadId: result.threadId,
        contextHash: context.contextHash,
        promptVersion: PROMPT_VERSION,
        lastOpenedAt: this.now().toISOString(),
        status: "failed",
      });
      await this.persist();
      return this.emitFailure({
        code: "EmptyAgentResponse",
        message: "本地 Agent 已结束，但没有返回可显示的解读，请重新解读。",
      });
    }
    this.sessionStore.upsert({
      segmentKey: `${context.reference.translationPath}::${context.reference.primaryId}`,
      threadId: result.threadId,
      contextHash: context.contextHash,
      promptVersion: PROMPT_VERSION,
      lastOpenedAt: this.now().toISOString(),
      status,
      answer: this.currentAnswer,
    });
    await this.persist();
    if (status === "interrupted") {
      this.emit({
        status: "failed",
        context,
        answer: this.currentAnswer,
        conversation: [...this.currentConversation],
        threadId: this.currentThreadId,
        error: {
          code: "TurnInterrupted",
          message: "解读已停止，已保留当前收到的内容。",
        },
      });
      return { state: "interrupted", context, ...result };
    }
    this.emit({
      status: "completed",
      context,
      answer: this.currentAnswer,
      conversation: [...this.currentConversation],
      threadId: this.currentThreadId,
      restored: false,
    });
    return { state: "completed", context, ...result };
  }

  handleRuntimeEvent(event, context) {
    if (event.type === "started") {
      this.currentThreadId = event.threadId;
      this.emit({
        status: "searching",
        phase: "searching",
        context,
        answer: this.currentAnswer,
        conversation: [...this.currentConversation],
        threadId: event.threadId,
        turnId: event.turnId,
      });
      return;
    }
    if (event.type === "delta") {
      this.currentAnswer = event.text;
      this.emit({
        status: "streaming",
        phase: "answering",
        context,
        answer: event.text,
        conversation: [...this.currentConversation],
        threadId: event.threadId,
        turnId: event.turnId,
      });
    }
  }

  retry() {
    if (!this.lastRequest) {
      return Promise.resolve(this.emitFailure({
        code: "SegmentNotFound",
        message: "没有可重试的分段。",
      }));
    }
    return this.interpret(
      this.lastRequest.sourcePath,
      this.lastRequest.requestedId,
      { forceNew: true }
    );
  }

  stop() {
    return this.runtime.interrupt();
  }

  busyResult(message) {
    return {
      state: "busy",
      error: normalizeControllerError({
        code: "TurnBusy",
        message,
      }),
    };
  }

  emitFailure(error) {
    const normalized = normalizeControllerError(error);
    const status = UNAVAILABLE_ERROR_CODES.has(normalized.code)
      ? "unavailable"
      : "failed";
    this.emit({
      status,
      context: this.currentContext,
      answer: this.currentAnswer,
      conversation: [...this.currentConversation],
      threadId: this.currentThreadId,
      error: normalized,
    });
    return { state: "failed", error: normalized };
  }

  async persist() {
    await this.persistSessions(this.sessionStore.toJSON());
  }

  emit(state) {
    this.onState(state);
    return state;
  }
}

const normalizeControllerError = (error) => ({
  code: String(error?.code || "Unknown"),
  message: String(error?.message || "分段解读失败，可重试或复制诊断。"),
});

module.exports = {
  SegmentInterpretationController,
  UNAVAILABLE_ERROR_CODES,
  normalizeControllerError,
};
