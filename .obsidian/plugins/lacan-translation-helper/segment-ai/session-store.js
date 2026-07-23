const { PROMPT_VERSION } = require("./prompt-builder");

const SESSION_FIELDS = [
  "segmentKey",
  "threadId",
  "contextHash",
  "promptVersion",
  "lastOpenedAt",
  "status",
  "answer",
];

const segmentKeyFor = (context) => {
  const reference = context?.reference;
  if (!reference?.translationPath || !reference?.primaryId) {
    throw new TypeError("segmentKeyFor requires a resolved segment context.");
  }
  return `${reference.translationPath}::${reference.primaryId}`;
};

class InterpretationSessionStore {
  constructor(records = []) {
    this.records = new Map();
    for (const record of Array.isArray(records) ? records : []) {
      const normalized = normalizeRecord(record);
      if (normalized) {
        this.records.set(normalized.segmentKey, normalized);
      }
    }
  }

  find(segmentKey) {
    const record = this.records.get(String(segmentKey || ""));
    return record ? { ...record } : undefined;
  }

  evaluate(context, promptVersion = PROMPT_VERSION) {
    const segmentKey = segmentKeyFor(context);
    const record = this.find(segmentKey);
    if (!record) {
      return { state: "missing", segmentKey };
    }
    const reasons = [];
    if (record.contextHash !== context.contextHash) {
      reasons.push("context");
    }
    if (record.promptVersion !== promptVersion) {
      reasons.push("prompt");
    }
    return {
      state: reasons.length > 0 ? "stale" : "current",
      segmentKey,
      record,
      reasons,
    };
  }

  upsert(record) {
    const normalized = normalizeRecord(record);
    if (!normalized) {
      throw new TypeError("Invalid interpretation session record.");
    }
    this.records.set(normalized.segmentKey, normalized);
    return { ...normalized };
  }

  remove(segmentKey) {
    return this.records.delete(String(segmentKey || ""));
  }

  toJSON() {
    return Array.from(this.records.values())
      .map((record) => ({ ...record }))
      .sort((left, right) => left.segmentKey.localeCompare(right.segmentKey));
  }
}

const normalizeRecord = (record) => {
  if (!record || typeof record !== "object") {
    return null;
  }
  if (
    typeof record.segmentKey !== "string"
    || !record.segmentKey
    || typeof record.threadId !== "string"
    || !record.threadId
    || typeof record.contextHash !== "string"
    || !record.contextHash
    || typeof record.promptVersion !== "string"
    || !record.promptVersion
  ) {
    return null;
  }
  return SESSION_FIELDS.reduce((result, field) => {
    if (record[field] !== undefined) {
      result[field] = String(record[field]);
    }
    return result;
  }, {});
};

module.exports = {
  InterpretationSessionStore,
  SESSION_FIELDS,
  segmentKeyFor,
};
