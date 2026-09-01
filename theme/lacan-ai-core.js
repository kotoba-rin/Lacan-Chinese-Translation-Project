(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.LacanAiCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var REQUEST_TIMEOUT_MS = 180000;
  var MAX_OUTPUT_TOKENS = 1600;
  var MAX_RESPONSE_BYTES = 1024 * 1024;
  var MAX_OUTPUT_CHARS = 200000;

  function normalize(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, "");
  }

  function searchCards(cards, query, limit) {
    var normalizedQuery = normalize(query);
    if (!normalizedQuery) {
      return [];
    }

    var byPath = new Map();
    var found = new Map();
    cards.forEach(function (card) {
      byPath.set(card.path, card);
      var title = normalize(card.title);
      var tags = normalize((card.tags || []).join(" "));
      var body = normalize(card.body);
      var score = 0;
      if (title === normalizedQuery) score += 120;
      else if (title.includes(normalizedQuery)) score += 80;
      if (tags.includes(normalizedQuery)) score += 35;
      if (body.includes(normalizedQuery)) score += 15;
      if (score > 0) {
        found.set(card.path, { card: card, score: score, reasons: ["直接命中"] });
      }
    });

    Array.from(found.values()).forEach(function (result) {
      (result.card.card_links || []).forEach(function (link) {
        var linkedCard = byPath.get(link.path);
        if (!linkedCard) return;
        var existing = found.get(link.path);
        if (existing) {
          if (!existing.reasons.includes("显式关联")) existing.reasons.push("显式关联");
          existing.score += 5;
          return;
        }
        found.set(link.path, {
          card: linkedCard,
          score: 5,
          reasons: ["显式关联"],
        });
      });
    });

    return Array.from(found.values())
      .sort(function (left, right) {
        return right.score - left.score || left.card.title.localeCompare(right.card.title, "zh-CN");
      })
      .slice(0, Math.max(1, Number(limit) || 8));
  }

  function findCardsBySegment(cards, segmentId) {
    var normalizedId = String(segmentId || "").toLowerCase();
    if (!normalizedId) return [];
    return cards.filter(function (card) {
      return (card.segment_links || []).some(function (link) {
        return String(link.id || "").toLowerCase() === normalizedId;
      });
    });
  }

  function validateEndpoint(value) {
    var endpoint;
    try {
      endpoint = new URL(String(value || "").trim());
    } catch (_error) {
      throw new Error("接口地址必须是有效的 HTTPS URL。");
    }
    var localHosts = ["localhost", "127.0.0.1", "[::1]"];
    var localHttp = endpoint.protocol === "http:" && localHosts.includes(endpoint.hostname);
    if (endpoint.protocol !== "https:" && !localHttp) {
      throw new Error("接口地址必须使用 HTTPS；仅本机 localhost 可以使用 HTTP。");
    }
    if (endpoint.username || endpoint.password) {
      throw new Error("接口地址不能包含用户名或密码。");
    }
    endpoint.hash = "";
    return endpoint.toString();
  }

  function clearLocalConfig(storage, prefix) {
    var keys = [];
    for (var index = 0; index < storage.length; index += 1) {
      var key = storage.key(index);
      if (key && key.indexOf(prefix) === 0) keys.push(key);
    }
    keys.forEach(function (key) {
      storage.removeItem(key);
    });
  }

  function usesKnowledgeWorkspace(skill) {
    return skill === "knowledge";
  }

  function clampLauncherPosition(position, viewport, launcherSize, margin) {
    var edge = Number.isFinite(Number(margin)) ? Number(margin) : 8;
    var maxLeft = Math.max(edge, Number(viewport.width) - Number(launcherSize.width) - edge);
    var maxTop = Math.max(edge, Number(viewport.height) - Number(launcherSize.height) - edge);
    var left = Number(position.left);
    var top = Number(position.top);
    if (!Number.isFinite(left)) left = maxLeft;
    if (!Number.isFinite(top)) top = maxTop;
    return {
      left: Math.min(maxLeft, Math.max(edge, left)),
      top: Math.min(maxTop, Math.max(edge, top)),
    };
  }

  function clampPanelWidth(width, minWidth, maxWidth) {
    var minimum = Math.max(0, Number(minWidth) || 0);
    var maximum = Math.max(minimum, Number(maxWidth) || minimum);
    var requested = Number(width);
    if (!Number.isFinite(requested)) requested = minimum;
    return Math.min(maximum, Math.max(minimum, requested));
  }

  function getDockedPanelWidthBounds(
    viewportWidth,
    occupiedStartWidth,
    centerMinWidth,
    panelMinWidth,
    panelMaxWidth
  ) {
    var viewport = Math.max(0, Number(viewportWidth) || 0);
    var occupiedStart = Math.max(0, Number(occupiedStartWidth) || 0);
    var centerMinimum = Math.max(0, Number(centerMinWidth) || 0);
    var panelMinimum = Math.max(0, Number(panelMinWidth) || 0);
    var panelMaximum = Math.max(panelMinimum, Number(panelMaxWidth) || panelMinimum);
    var available = Math.max(0, viewport - occupiedStart - centerMinimum);
    return {
      min: Math.min(panelMinimum, available),
      max: Math.max(
        Math.min(panelMinimum, available),
        Math.min(panelMaximum, available)
      ),
    };
  }

  function isScrollNearBottom(container, threshold) {
    container = container || {};
    var limit = Number(threshold);
    if (!Number.isFinite(limit)) limit = 48;
    limit = Math.max(0, limit);
    var distance = Number(container.scrollHeight || 0)
      - Number(container.scrollTop || 0)
      - Number(container.clientHeight || 0);
    return distance <= limit;
  }

  function captureScrollSnapshot(container, autoFollow, threshold) {
    container = container || {};
    return {
      scrollTop: Math.max(0, Number(container.scrollTop) || 0),
      nearBottom: isScrollNearBottom(container, threshold),
      autoFollow: Boolean(autoFollow),
    };
  }

  function resolveRestoredScrollTop(snapshot, container) {
    snapshot = snapshot || {};
    container = container || {};
    var maximum = Math.max(
      0,
      Number(container.scrollHeight || 0) - Number(container.clientHeight || 0)
    );
    if (snapshot.nearBottom) return maximum;
    return Math.min(maximum, Math.max(0, Number(snapshot.scrollTop) || 0));
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function safeMarkdownUrl(value) {
    var url = String(value || "").trim();
    if (/^(https?:|mailto:)/i.test(url)) return url;
    if (/^(#|\/(?!\/)|\.\.?\/)/.test(url)) return url;
    return "";
  }

  function renderInlineMarkdown(value) {
    var source = String(value || "").replace(/\u0000/g, "�");
    var tokens = [];

    function protect(html) {
      var index = tokens.push(html) - 1;
      return "\u0000" + index + "\u0000";
    }

    source = source.replace(/!\[([^\]\n]*)\]\(((?:[^()\s]+|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/g, function (_match, label) {
      return protect(
        '<span class="lacan-ai-md-image-note">[图片：'
          + escapeHtml(label || "未命名") + "]</span>"
      );
    });
    source = source.replace(/`([^`\n]+)`/g, function (_match, code) {
      return protect("<code>" + escapeHtml(code) + "</code>");
    });
    source = source.replace(/\[([^\]\n]+)\]\(((?:[^()\s]+|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/g, function (_match, label, href) {
      var safeUrl = safeMarkdownUrl(href);
      if (!safeUrl) {
        return protect('<span class="lacan-ai-md-blocked-link">' + escapeHtml(label) + "</span>");
      }
      var external = /^https?:/i.test(safeUrl);
      return protect(
        '<a href="' + escapeHtml(safeUrl) + '"'
          + (external ? ' target="_blank" rel="noopener noreferrer"' : "")
          + ">" + escapeHtml(label) + "</a>"
      );
    });

    var html = escapeHtml(source)
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
      .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
      .replace(/(^|[\s（(])\*([^*\n]+)\*(?=$|[\s，。,.！？!?)）])/g, "$1<em>$2</em>")
      .replace(/(^|[\s（(])_([^_\n]+)_(?=$|[\s，。,.！？!?)）])/g, "$1<em>$2</em>");

    return html.replace(/\u0000(\d+)\u0000/g, function (_match, index) {
      return tokens[Number(index)] || "";
    });
  }

  function splitMarkdownTableRow(line) {
    return String(line || "")
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map(function (cell) {
        return cell.trim();
      });
  }

  function isMarkdownTableDivider(line) {
    var cells = splitMarkdownTableRow(line);
    return cells.length > 0 && cells.every(function (cell) {
      return /^:?-{3,}:?$/.test(cell);
    });
  }

  function renderMarkdown(markdown) {
    var lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
    var blocks = [];
    var paragraph = [];
    var index = 0;

    function flushParagraph() {
      if (!paragraph.length) return;
      blocks.push("<p>" + renderInlineMarkdown(paragraph.join("\n")).replace(/\n/g, "<br>") + "</p>");
      paragraph = [];
    }

    while (index < lines.length) {
      var line = lines[index];
      var fence = line.match(/^\s*```\s*([A-Za-z0-9_-]*)\s*$/);
      if (fence) {
        flushParagraph();
        var language = fence[1] ? ' class="language-' + fence[1].toLowerCase() + '"' : "";
        var codeLines = [];
        index += 1;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
          codeLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        blocks.push("<pre><code" + language + ">" + escapeHtml(codeLines.join("\n")) + "</code></pre>");
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        index += 1;
        continue;
      }

      var heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        flushParagraph();
        var level = heading[1].length;
        blocks.push("<h" + level + ">" + renderInlineMarkdown(heading[2]) + "</h" + level + ">");
        index += 1;
        continue;
      }

      if (/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})\s*$/.test(line)) {
        flushParagraph();
        blocks.push("<hr>");
        index += 1;
        continue;
      }

      if (line.indexOf("|") !== -1 && index + 1 < lines.length && isMarkdownTableDivider(lines[index + 1])) {
        flushParagraph();
        var headers = splitMarkdownTableRow(line);
        var tableRows = [];
        index += 2;
        while (index < lines.length && lines[index].trim() && lines[index].indexOf("|") !== -1) {
          tableRows.push(splitMarkdownTableRow(lines[index]));
          index += 1;
        }
        blocks.push(
          "<table><thead><tr>"
            + headers.map(function (cell) {
              return "<th>" + renderInlineMarkdown(cell) + "</th>";
            }).join("")
            + "</tr></thead><tbody>"
            + tableRows.map(function (row) {
              return "<tr>" + headers.map(function (_header, cellIndex) {
                return "<td>" + renderInlineMarkdown(row[cellIndex] || "") + "</td>";
              }).join("") + "</tr>";
            }).join("")
            + "</tbody></table>"
        );
        continue;
      }

      if (/^\s{0,3}>\s?/.test(line)) {
        flushParagraph();
        var quoteLines = [];
        while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index])) {
          quoteLines.push(lines[index].replace(/^\s{0,3}>\s?/, ""));
          index += 1;
        }
        blocks.push("<blockquote>" + quoteLines.map(renderInlineMarkdown).join("<br>") + "</blockquote>");
        continue;
      }

      var unordered = line.match(/^\s{0,3}[-*+]\s+(.+)$/);
      var ordered = line.match(/^\s{0,3}\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        flushParagraph();
        var tag = unordered ? "ul" : "ol";
        var items = [];
        while (index < lines.length) {
          var itemMatch = tag === "ul"
            ? lines[index].match(/^\s{0,3}[-*+]\s+(.+)$/)
            : lines[index].match(/^\s{0,3}\d+[.)]\s+(.+)$/);
          if (!itemMatch) break;
          items.push("<li>" + renderInlineMarkdown(itemMatch[1]) + "</li>");
          index += 1;
        }
        blocks.push("<" + tag + ">" + items.join("") + "</" + tag + ">");
        continue;
      }

      paragraph.push(line);
      index += 1;
    }

    flushParagraph();
    return blocks.join("\n");
  }

  function buildInterpretationPrompt(input) {
    var card = input.card || {};
    var segmentText = (input.segments || [])
      .map(function (segment) {
        return "[" + segment.id + "]\n" + String(segment.text || "").slice(0, 4000);
      })
      .join("\n\n");
    return [
      "你正在解读拉康中文翻译项目的本地知识库。",
      "用户问题：" + String(input.question || "请解读这张知识卡。").slice(0, 1200),
      "",
      "知识卡：" + String(card.title || "未命名卡片"),
      "核实状态：" + String(card.verification || "未标注"),
      String(card.body || "").slice(0, 10000),
      "",
      "对应的本地中法分段：",
      segmentText || "未能加载对应分段。",
      "",
      "请按以下四层回答，并给出使用到的卡片标题和分段 ID：",
      "1. 知识卡片的整理结论",
      "2. 本地原文与译文直接支持的内容",
      "3. 关联材料提供的补充",
      "4. AI 的解释性推论",
      "若材料不能支持某项判断，请明确写出“证据不足”，不要补造引文。",
      "请使用 Markdown 格式输出，可使用标题、列表、引用、表格和代码块；不要输出原始 HTML。",
    ].join("\n");
  }

  function buildTranslationReviewPrompt(input) {
    input = input || {};
    var selectedText = String(input.selectedText || "").trim().slice(0, 12000);
    if (!selectedText) {
      throw new Error("请先在页面正文中用鼠标选中需要翻译校对的内容。");
    }

    var segments = (input.segments || [])
      .slice(0, 8)
      .map(function (segment) {
        return {
          id: String(segment.id || "未标注分段").trim().slice(0, 240),
          french: String(segment.french || "").trim().slice(0, 6000),
          translation: String(segment.translation || "").trim().slice(0, 6000),
        };
      })
      .filter(function (segment) {
        return segment.french && segment.translation;
      });
    if (!segments.length) {
      throw new Error("未能找到选区对应的法语原文和现有中文译文。");
    }

    var question = String(input.question || "").trim().slice(0, 1200);
    var materials = segments
      .map(function (segment) {
        return [
          "[分段 " + segment.id + "]",
          "法语原文：",
          segment.french,
          "",
          "现有中文译文：",
          segment.translation,
        ].join("\n");
      })
      .join("\n\n---\n\n");

    return [
      "你正在执行“翻译校对”。该功能只检查内容与含义是否忠实，不做单纯的文风润色。",
      "请严格依据下方本地分段材料，不要补造原文、上下文或出处。",
      "",
      "工作步骤：",
      "1. 先仅依据法语原文独立翻译，保留指代、否定、范围、逻辑关系、专名和关键术语。",
      "2. 将独立译文与现有中文译文进行比较，并重点核对用户选中的内容。",
      "3. 把结论区分为“确定的错义”“可讨论的歧义”“无需修改”；不要把个人措辞偏好报告为错误。",
      "4. 若用户提出补充问题，结合上述比较直接回答并说明依据；证据不足时明确写出“证据不足”。",
      "",
      "用户选中的内容：",
      selectedText,
      "",
      "用户补充问题：",
      question || "无；请直接完成翻译校对。",
      "",
      "对应的中法分段材料：",
      materials,
      "",
      "请按以下顺序输出：独立译文、对比结论、需要修改之处（如有）、对补充问题的回答（如有）。引用判断时标出分段 ID。",
      "请使用 Markdown 格式输出，可使用标题、列表、引用和对照表格；不要输出原始 HTML。",
    ].join("\n");
  }

  function buildSkillPrompt(skill, input) {
    var question = String(input.question || "").slice(0, 1200);
    var context = String(input.context || "").slice(0, 12000);
    var instructions = {
      "page-qa": "仅依据所给页面内容回答问题。引用关键原句；材料不足时明确说明，不要补造出处。",
    };
    if (!instructions[skill]) {
      throw new Error("未知的 AI 能力。");
    }
    return [
      instructions[skill],
      "请使用 Markdown 格式输出，可使用标题、列表、引用和表格；不要输出原始 HTML。",
      "",
      "用户要求：" + (question || "请处理所给内容。"),
      "",
      "页面内容：",
      context || "未提供页面内容。",
    ].join("\n");
  }

  function buildChatRequest(model, prompt) {
    return {
      model: model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: MAX_OUTPUT_TOKENS,
      stream: true,
      enable_thinking: false,
    };
  }

  function extractChatCompletion(payload) {
    var content = payload && payload.choices && payload.choices[0]
      && payload.choices[0].message && payload.choices[0].message.content;
    if (Array.isArray(content)) {
      content = content
        .map(function (item) {
          return typeof item === "string" ? item : item && item.text;
        })
        .filter(Boolean)
        .join("\n");
    }
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("接口没有返回有效回答。");
    }
    return content.trim();
  }

  function extractChatDelta(payload) {
    var choice = payload && payload.choices && payload.choices[0];
    var content = choice && choice.delta && choice.delta.content;
    if (typeof content === "undefined" && choice && choice.message) {
      content = choice.message.content;
    }
    if (Array.isArray(content)) {
      return content
        .map(function (item) {
          return typeof item === "string" ? item : item && item.text;
        })
        .filter(Boolean)
        .join("");
    }
    return typeof content === "string" ? content : "";
  }

  function extractReasoningDelta(payload) {
    var choice = payload && payload.choices && payload.choices[0];
    var reasoning = choice && choice.delta && choice.delta.reasoning_content;
    return typeof reasoning === "string" ? reasoning : "";
  }

  function parseSseBuffer(buffer) {
    var parts = String(buffer || "").replace(/\r\n/g, "\n").split("\n\n");
    var remainder = parts.pop() || "";
    var events = [];
    parts.forEach(function (block) {
      var data = block
        .split("\n")
        .filter(function (line) {
          return line.indexOf("data:") === 0;
        })
        .map(function (line) {
          return line.slice(5).replace(/^\s/, "");
        })
        .join("\n")
        .trim();
      if (!data) return;
      if (data === "[DONE]") {
        events.push({ done: true });
        return;
      }
      try {
        events.push({ done: false, payload: JSON.parse(data) });
      } catch (_error) {
        throw new Error("流式响应格式不正确。");
      }
    });
    return { events: events, remainder: remainder };
  }

  function positiveLimit(value, fallback) {
    var number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return Math.floor(number);
  }

  function utf8ByteLength(value) {
    var text = String(value || "");
    if (typeof TextEncoder === "function") {
      return new TextEncoder().encode(text).byteLength;
    }
    return unescape(encodeURIComponent(text)).length;
  }

  function responseLimitError(partialText) {
    var error = new Error("AI 接口返回内容超过浏览器安全上限，已停止接收。");
    error.name = "ResponseLimitError";
    error.code = "response_too_large";
    error.partialText = String(partialText || "");
    return error;
  }

  async function readBoundedResponseText(response, maxResponseBytes) {
    if (response.body && typeof response.body.getReader === "function") {
      var reader = response.body.getReader();
      var decoder = new TextDecoder("utf-8");
      var responseText = "";
      var receivedBytes = 0;
      try {
        while (true) {
          var chunk = await reader.read();
          if (chunk.done) break;
          receivedBytes += Number(chunk.value && chunk.value.byteLength) || 0;
          if (receivedBytes > maxResponseBytes) {
            throw responseLimitError("");
          }
          responseText += decoder.decode(chunk.value, { stream: true });
        }
        return responseText + decoder.decode();
      } catch (error) {
        if (typeof reader.cancel === "function") {
          try {
            await reader.cancel(error);
          } catch (_cancelError) {}
        }
        throw error;
      }
    }

    var fallbackText;
    if (typeof response.text === "function") {
      fallbackText = await response.text();
    } else {
      fallbackText = JSON.stringify(await response.json());
    }
    if (utf8ByteLength(fallbackText) > maxResponseBytes) {
      throw responseLimitError("");
    }
    return fallbackText;
  }

  async function readChatResponse(response, onUpdate, limits) {
    limits = limits || {};
    var maxResponseBytes = positiveLimit(
      limits.maxResponseBytes,
      MAX_RESPONSE_BYTES
    );
    var maxOutputChars = positiveLimit(
      limits.maxOutputChars,
      MAX_OUTPUT_CHARS
    );
    var contentType = String(response.headers && response.headers.get("content-type") || "").toLowerCase();
    var contentLength = String(
      response.headers && response.headers.get("content-length") || ""
    ).trim();
    if (contentLength && Number(contentLength) > maxResponseBytes) {
      throw responseLimitError("");
    }
    if (contentType.indexOf("text/event-stream") === -1) {
      var responseText = await readBoundedResponseText(response, maxResponseBytes);
      var payload;
      try {
        payload = JSON.parse(responseText);
      } catch (_error) {
        throw new Error("接口返回的 JSON 格式不正确。");
      }
      var answer = extractChatCompletion(payload);
      if (answer.length > maxOutputChars) {
        throw responseLimitError(answer.slice(0, maxOutputChars));
      }
      return answer;
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      throw new Error("当前浏览器无法读取流式响应。");
    }

    var reader = response.body.getReader();
    var decoder = new TextDecoder("utf-8");
    var buffer = "";
    var fullText = "";
    var streamDone = false;
    var receivedBytes = 0;

    function consume(parsed) {
      buffer = parsed.remainder;
      parsed.events.forEach(function (event) {
        if (event.done) {
          streamDone = true;
          return;
        }
        var reasoning = extractReasoningDelta(event.payload);
        if (reasoning && typeof onUpdate === "function") {
          onUpdate(fullText, "", { phase: "reasoning" });
        }
        var delta = extractChatDelta(event.payload);
        if (!delta) return;
        if (fullText.length + delta.length > maxOutputChars) {
          var remaining = Math.max(0, maxOutputChars - fullText.length);
          if (remaining) {
            var partialDelta = delta.slice(0, remaining);
            fullText += partialDelta;
            if (typeof onUpdate === "function") {
              onUpdate(fullText, partialDelta, { phase: "content" });
            }
          }
          throw responseLimitError(fullText);
        }
        fullText += delta;
        if (typeof onUpdate === "function") {
          onUpdate(fullText, delta, { phase: "content" });
        }
      });
    }

    try {
      while (!streamDone) {
        var chunk = await reader.read();
        if (chunk.done) break;
        receivedBytes += Number(chunk.value && chunk.value.byteLength) || 0;
        if (receivedBytes > maxResponseBytes) {
          throw responseLimitError(fullText);
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        consume(parseSseBuffer(buffer));
      }

      buffer += decoder.decode();
      if (buffer.trim()) consume(parseSseBuffer(buffer + "\n\n"));
    } catch (error) {
      if (typeof reader.cancel === "function") {
        try {
          await reader.cancel(error);
        } catch (_cancelError) {}
      }
      throw error;
    }
    if (!fullText.trim()) throw new Error("接口没有返回有效回答。");
    return fullText.trim();
  }

  function formatDiagnostics(details) {
    details = details || {};
    function seconds(value) {
      return (Number(value) / 1000).toFixed(1) + " 秒";
    }
    var parts = [];
    if (Number.isFinite(details.httpStatus)) parts.push("HTTP " + details.httpStatus);
    if (Number.isFinite(details.firstByteMs)) parts.push("首包 " + seconds(details.firstByteMs));
    if (Number.isFinite(details.generationMs)) parts.push("生成 " + seconds(details.generationMs));
    if (Number.isFinite(details.totalMs)) parts.push("总计 " + seconds(details.totalMs));
    if (details.traceId) parts.push("Trace " + String(details.traceId).slice(0, 160));
    if (details.streaming) parts.push("流式接收中");
    if (details.timedOut) parts.push("已超时");
    if (details.partial) parts.push("部分结果");
    return parts.join(" · ");
  }

  return {
    REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS,
    MAX_OUTPUT_TOKENS: MAX_OUTPUT_TOKENS,
    MAX_RESPONSE_BYTES: MAX_RESPONSE_BYTES,
    MAX_OUTPUT_CHARS: MAX_OUTPUT_CHARS,
    normalize: normalize,
    searchCards: searchCards,
    findCardsBySegment: findCardsBySegment,
    validateEndpoint: validateEndpoint,
    clearLocalConfig: clearLocalConfig,
    usesKnowledgeWorkspace: usesKnowledgeWorkspace,
    clampLauncherPosition: clampLauncherPosition,
    clampPanelWidth: clampPanelWidth,
    getDockedPanelWidthBounds: getDockedPanelWidthBounds,
    isScrollNearBottom: isScrollNearBottom,
    captureScrollSnapshot: captureScrollSnapshot,
    resolveRestoredScrollTop: resolveRestoredScrollTop,
    renderMarkdown: renderMarkdown,
    buildInterpretationPrompt: buildInterpretationPrompt,
    buildTranslationReviewPrompt: buildTranslationReviewPrompt,
    buildSkillPrompt: buildSkillPrompt,
    buildChatRequest: buildChatRequest,
    extractChatCompletion: extractChatCompletion,
    extractChatDelta: extractChatDelta,
    extractReasoningDelta: extractReasoningDelta,
    parseSseBuffer: parseSseBuffer,
    readChatResponse: readChatResponse,
    formatDiagnostics: formatDiagnostics,
  };
});
