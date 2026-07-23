const SEGMENT_COMMENT_RE = /<!--\s*(ids?)\b\s*:?\s*([\s\S]*?)-->/gi;
const SEGMENT_TOKEN_RE = /\bs\d+[a-z]?-\d+-\d+\b/gi;
const READING_NOTE_LINE_RE = /^\[\[\s*notes\/[^|\]]+(?:\|[^\]]*)?\]\]$/i;

class SegmentContextError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SegmentContextError";
    this.code = code;
  }
}

class SegmentParser {
  parse(text, sourcePath = "") {
    const source = String(text || "");
    const comments = this.parseComments(source);
    const blocks = [];

    for (let index = 0; index < comments.length; index += 1) {
      const comment = comments[index];
      if (comment.label !== "id") {
        continue;
      }

      const attached = comments[index + 1];
      const hasAttachedIds = (
        attached?.label === "ids"
        && /^\s*$/.test(source.slice(comment.end, attached.start))
      );
      const ids = this.mergeIds(comment.ids, hasAttachedIds ? attached.ids : []);
      const contentStart = hasAttachedIds ? attached.end : comment.end;
      const nextPrimary = comments.slice(index + (hasAttachedIds ? 2 : 1))
        .find((candidate) => candidate.label === "id");
      const contentEnd = nextPrimary ? nextPrimary.start : source.length;
      const markdown = source.slice(contentStart, contentEnd).trim();

      blocks.push({
        primaryId: ids[0],
        ids,
        markdown,
        visibleText: this.visibleText(markdown),
        sourcePath,
        startLine: this.lineAtOffset(source, comment.start),
        endLine: nextPrimary
          ? Math.max(this.lineAtOffset(source, nextPrimary.start) - 1, 0)
          : Math.max(source.split(/\r?\n/).length - 1, 0),
      });
    }

    return blocks;
  }

  findByRequestedId(blocks, requestedId) {
    const normalizedId = this.normalizeId(requestedId);
    const matches = (blocks || []).filter((block) => block.ids.includes(normalizedId));
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      throw new SegmentContextError(
        "SegmentConflict",
        `分段 ID ${normalizedId} 在文本中对应多个逻辑块。`
      );
    }
    throw new SegmentContextError("SegmentNotFound", `找不到分段 ID：${normalizedId}`);
  }

  normalizeId(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (!/^s\d+[a-z]?-\d+-\d+$/.test(normalized)) {
      throw new SegmentContextError("InvalidSegmentId", `不是有效的分段 ID：${value}`);
    }
    return normalized;
  }

  parseComments(source) {
    const comments = [];
    SEGMENT_COMMENT_RE.lastIndex = 0;
    let match;
    while ((match = SEGMENT_COMMENT_RE.exec(source)) !== null) {
      const ids = this.idsFromText(match[2]);
      if (ids.length === 0) {
        continue;
      }
      comments.push({
        label: match[1].toLowerCase(),
        ids,
        start: match.index,
        end: SEGMENT_COMMENT_RE.lastIndex,
      });
    }
    return comments;
  }

  idsFromText(value) {
    const ids = [];
    const seen = new Set();
    SEGMENT_TOKEN_RE.lastIndex = 0;
    let match;
    while ((match = SEGMENT_TOKEN_RE.exec(String(value || ""))) !== null) {
      const id = match[0].toLowerCase();
      if (!seen.has(id)) {
        ids.push(id);
        seen.add(id);
      }
    }
    return ids;
  }

  mergeIds(...groups) {
    const ids = [];
    const seen = new Set();
    for (const group of groups) {
      for (const id of group || []) {
        if (!seen.has(id)) {
          ids.push(id);
          seen.add(id);
        }
      }
    }
    return ids;
  }

  visibleText(markdown) {
    return String(markdown || "")
      .replace(/<!--[\s\S]*?-->/g, "\n")
      .split(/\r?\n/)
      .filter((line) => !READING_NOTE_LINE_RE.test(line.trim()))
      .join("\n")
      .trim();
  }

  lineAtOffset(text, offset) {
    return String(text || "").slice(0, Math.max(0, offset)).split("\n").length - 1;
  }
}

module.exports = {
  SegmentContextError,
  SegmentParser,
};
