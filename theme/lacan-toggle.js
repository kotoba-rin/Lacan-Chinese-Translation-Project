(function () {
  "use strict";

  var toggles = {
    original: "hide-original",
    notes: "hide-notes",
    commentary: "hide-commentary",
  };

  var shareState = {
    active: false,
    selected: {},
  };

  var qrLevels = {
    1: { blocks: [19], ecc: 7, align: [] },
    2: { blocks: [34], ecc: 10, align: [6, 18] },
    3: { blocks: [55], ecc: 15, align: [6, 22] },
    4: { blocks: [80], ecc: 20, align: [6, 26] },
    5: { blocks: [108], ecc: 26, align: [6, 30] },
    6: { blocks: [68, 68], ecc: 18, align: [6, 34] },
    7: { blocks: [78, 78], ecc: 20, align: [6, 22, 38] },
    8: { blocks: [97, 97], ecc: 24, align: [6, 24, 42] },
    9: { blocks: [116, 116], ecc: 30, align: [6, 26, 46] },
    10: { blocks: [68, 68, 69, 69], ecc: 18, align: [6, 28, 50] },
  };

  var qrExp = null;
  var qrLog = null;

  function key(name) {
    return "lacan-toggle-" + name;
  }

  function isEnabled(name) {
    var stored = window.localStorage.getItem(key(name));
    return stored === null ? true : stored === "true";
  }

  function applyToggle(name, enabled) {
    document.documentElement.classList.toggle(toggles[name], !enabled);
    var controls = document.querySelectorAll('[data-lacan-toggle="' + name + '"]');
    Array.prototype.forEach.call(controls, function (control) {
      control.checked = enabled;
    });
  }

  function applyAll() {
    Object.keys(toggles).forEach(function (name) {
      applyToggle(name, isEnabled(name));
    });
  }

  function openNavigationSearch(query) {
    if (
      window.LacanNavigationSearch &&
      typeof window.LacanNavigationSearch.open === "function"
    ) {
      window.LacanNavigationSearch.open(query);
      return true;
    }
    return false;
  }

  function createSearchForm() {
    var form = document.createElement("form");
    form.className = "lacan-tool-search";
    form.setAttribute("role", "search");

    var input = document.createElement("input");
    input.className = "lacan-tool-search-input";
    input.type = "search";
    input.placeholder = "搜索标题、知识卡或段落 ID";
    input.setAttribute("aria-label", "搜索标题、知识卡或段落 ID");

    var button = document.createElement("button");
    button.className = "lacan-tool-button";
    button.type = "submit";
    button.title = "搜索";
    button.textContent = "搜索";

    form.appendChild(input);
    form.appendChild(button);
    return form;
  }

  function createBackToTopButton() {
    var button = document.createElement("button");
    button.className = "lacan-tool-button lacan-back-to-top";
    button.type = "button";
    button.title = "回到页面最上方";
    button.setAttribute("aria-label", "回到页面最上方");
    button.textContent = "↑";
    return button;
  }

  function refineThemeMenu() {
    var labels = {
      default_theme: "自动",
      light: "浅色",
      navy: "暗色",
    };

    ["rust", "coal", "ayu"].forEach(function (name) {
      var button = document.getElementById("mdbook-theme-" + name);
      if (button && button.parentElement) {
        button.parentElement.remove();
      }
    });

    Object.keys(labels).forEach(function (name) {
      var button = document.getElementById("mdbook-theme-" + name);
      if (button) {
        button.textContent = labels[name];
      }
    });
  }

  function createShareControls() {
    var actions = document.createElement("div");
    actions.className = "lacan-share-actions";

    var toggle = document.createElement("button");
    toggle.className = "lacan-tool-button lacan-share-toggle";
    toggle.type = "button";
    toggle.title = "选择片段";
    toggle.setAttribute("aria-pressed", "false");
    toggle.textContent = "分享";

    var save = document.createElement("button");
    save.className = "lacan-tool-button lacan-share-save";
    save.type = "button";
    save.title = "下载选中片段图片";
    save.disabled = true;
    save.textContent = "下载图片";

    var clear = document.createElement("button");
    clear.className = "lacan-tool-button lacan-share-clear";
    clear.type = "button";
    clear.title = "清空选择";
    clear.textContent = "清空";

    var count = document.createElement("span");
    count.className = "lacan-share-count";
    count.setAttribute("aria-live", "polite");
    count.textContent = "已选 0";

    actions.appendChild(toggle);
    actions.appendChild(save);
    actions.appendChild(clear);
    actions.appendChild(count);
    return actions;
  }

  function getParagraphIds(section) {
    var ids = (section.getAttribute("data-paragraph-ids") || "").trim();
    if (!ids) {
      return section.id ? [section.id] : [];
    }
    return ids.split(/\s+/).filter(Boolean);
  }

  function getAnchorId(section) {
    var ids = getParagraphIds(section);
    return section.id || ids[0] || "";
  }

  function ensureParagraphAnchors(section) {
    var ids = getParagraphIds(section);
    if (!ids.length) {
      return;
    }

    if (!section.id) {
      section.id = ids[0];
    }

    ids.slice(1).forEach(function (id) {
      if (document.getElementById(id)) {
        return;
      }

      var alias = document.createElement("span");
      alias.id = id;
      alias.className = "paragraph-anchor-alias";
      alias.setAttribute("aria-hidden", "true");
      section.insertBefore(alias, section.firstChild);
    });
  }

  function ensureShareCheckbox(section) {
    ensureParagraphAnchors(section);

    if (section.querySelector(".lacan-share-select")) {
      return;
    }

    var ids = getParagraphIds(section);
    var labelText = ids.length ? ids.join(", ") : "当前片段";
    var paragraphId = section.querySelector(".paragraph-id");
    if (!paragraphId) {
      return;
    }

    var label = document.createElement("label");
    label.className = "lacan-share-select";

    var input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("aria-label", "选择片段 " + labelText);

    input.addEventListener("change", function () {
      var anchorId = getAnchorId(section);
      if (!anchorId) {
        return;
      }

      if (input.checked) {
        shareState.selected[anchorId] = true;
      } else {
        delete shareState.selected[anchorId];
      }

      section.classList.toggle("lacan-share-selected", input.checked);
      updateShareControls();
    });

    label.appendChild(input);
    section.insertBefore(label, paragraphId);
  }

  function selectedSections() {
    var sections = document.querySelectorAll(".parallel-paragraph");
    var selected = [];
    Array.prototype.forEach.call(sections, function (section) {
      var anchorId = getAnchorId(section);
      if (anchorId && shareState.selected[anchorId]) {
        selected.push(section);
      }
    });
    return selected;
  }

  function selectedCount() {
    return selectedSections().length;
  }

  function updateShareControls() {
    var count = selectedCount();
    var toggle = document.querySelector(".lacan-share-toggle");
    var save = document.querySelector(".lacan-share-save");
    var clear = document.querySelector(".lacan-share-clear");
    var countLabel = document.querySelector(".lacan-share-count");

    document.documentElement.classList.toggle("lacan-share-mode", shareState.active);

    if (toggle) {
      toggle.textContent = shareState.active ? "退出分享" : "分享";
      toggle.setAttribute("aria-pressed", shareState.active ? "true" : "false");
    }

    if (save) {
      save.disabled = count === 0;
    }

    if (clear) {
      clear.disabled = count === 0;
    }

    if (countLabel) {
      countLabel.textContent = "已选 " + count;
    }
  }

  function clearShareSelection() {
    shareState.selected = {};
    var sections = document.querySelectorAll(".parallel-paragraph");
    Array.prototype.forEach.call(sections, function (section) {
      section.classList.remove("lacan-share-selected");
      var checkbox = section.querySelector(".lacan-share-select input");
      if (checkbox) {
        checkbox.checked = false;
      }
    });
    updateShareControls();
  }

  function enableShareMode() {
    var sections = document.querySelectorAll(".parallel-paragraph");
    Array.prototype.forEach.call(sections, ensureShareCheckbox);
    shareState.active = true;
    updateShareControls();
  }

  function disableShareMode() {
    shareState.active = false;
    updateShareControls();
  }

  function toggleShareMode() {
    if (shareState.active) {
      disableShareMode();
    } else {
      enableShareMode();
    }
  }

  function setupShareControls(controls) {
    var actions = controls.querySelector(".lacan-share-actions");
    if (!actions) {
      actions = createShareControls();
      controls.appendChild(actions);
    }

    var toggle = actions.querySelector(".lacan-share-toggle");
    var save = actions.querySelector(".lacan-share-save");
    var clear = actions.querySelector(".lacan-share-clear");

    if (toggle) {
      toggle.addEventListener("click", toggleShareMode);
    }

    if (save) {
      save.addEventListener("click", function () {
        var previousText = save.textContent;
        save.disabled = true;
        save.textContent = "生成中";
        Promise.resolve(saveSelectedParagraphs()).catch(function (error) {
          window.alert(error && error.message ? error.message : "保存图片失败。");
        }).finally(function () {
          save.textContent = previousText;
          updateShareControls();
        });
      });
    }

    if (clear) {
      clear.addEventListener("click", clearShareSelection);
    }

    updateShareControls();
  }

  function ensureToolPanel() {
    var controls = document.querySelector(".reading-controls");
    if (!controls) {
      return;
    }

    controls.classList.add("lacan-tool-panel");

    var searchForm = controls.querySelector(".lacan-tool-search");
    if (!searchForm) {
      searchForm = createSearchForm();
      controls.appendChild(searchForm);
    }

    var searchInput = searchForm.querySelector(".lacan-tool-search-input");
    if (searchInput) {
      searchInput.addEventListener("input", function () {
        openNavigationSearch(searchInput.value);
      });

      searchForm.addEventListener("submit", function (event) {
        event.preventDefault();
        openNavigationSearch(searchInput.value);
      });
    }

    setupShareControls(controls);

    var backToTop = controls.querySelector(".lacan-back-to-top");
    if (!backToTop) {
      backToTop = createBackToTopButton();
      controls.appendChild(backToTop);
    }

    backToTop.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function elementText(element) {
    if (!element) {
      return "";
    }
    return normalizeText(element.innerText || element.textContent || "");
  }

  function collectTexts(section, selector) {
    var parts = [];
    var nodes = section.querySelectorAll(selector);
    Array.prototype.forEach.call(nodes, function (node) {
      var text = elementText(node);
      if (text) {
        parts.push(text);
      }
    });
    return parts.join("\n\n");
  }

  function collectSnippet(section) {
    var ids = getParagraphIds(section);
    var snippet = {
      ids: ids,
      anchor: getAnchorId(section),
      url: buildParagraphUrl(section),
      blocks: [],
    };

    var translation = elementText(section.querySelector(".translation-block"));
    if (translation) {
      snippet.blocks.push({ kind: "translation", label: "译文", text: translation });
    }

    if (!document.documentElement.classList.contains("hide-notes")) {
      var notes = collectTexts(section, ".note-block:not(.original-notes)");
      if (notes) {
        snippet.blocks.push({ kind: "note", label: "注释", text: notes });
      }
    }

    if (!document.documentElement.classList.contains("hide-commentary")) {
      var commentary = collectTexts(section, ".commentary-block");
      if (commentary) {
        snippet.blocks.push({ kind: "commentary", label: "建言", text: commentary });
      }
    }

    if (!document.documentElement.classList.contains("hide-original")) {
      var original = collectTexts(section, ".original-paragraph");
      if (original) {
        snippet.blocks.push({ kind: "original", label: "原文", text: original });
      }
    }

    return snippet;
  }

  function buildParagraphUrl(section) {
    var anchor = getAnchorId(section);
    // Derive from the current reader URL so QR codes work on any domain or subpath deployment.
    var url = new URL(window.location.href);
    url.search = "";
    url.hash = anchor || "";
    return url.toString();
  }

  function safeFilename(text) {
    return String(text || "fragment")
      .replace(/[^\w\u4e00-\u9fff-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 96) || "fragment";
  }

  function parsePx(value, fallback) {
    var parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function cssValue(style, name, fallback) {
    var value = style.getPropertyValue(name).trim();
    return value || fallback;
  }

  function scaled(value, scale, fallback) {
    return Math.round(parsePx(value, fallback) * scale);
  }

  function canvasFont(style, scale, options) {
    var opts = options || {};
    var fontStyle = opts.fontStyle || style.fontStyle || "normal";
    var fontWeight = opts.fontWeight || style.fontWeight || "400";
    var fontSize = Math.round((opts.fontSize || parsePx(style.fontSize, 17)) * scale * 100) / 100;
    var family = opts.fontFamily || style.fontFamily || "serif";
    return fontStyle + " " + fontWeight + " " + fontSize + "px " + family;
  }

  function lineHeight(style, scale, fallbackMultiplier) {
    var fontSize = parsePx(style.fontSize, 17);
    var fallback = fontSize * (fallbackMultiplier || 1.85);
    return Math.round(parsePx(style.lineHeight, fallback) * scale);
  }

  function textStyleFromElement(element, scale, options) {
    var style = getComputedStyle(element || document.body);
    var opts = options || {};
    return {
      font: canvasFont(style, scale, opts),
      color: opts.color || style.color,
      lineHeight: opts.lineHeight || lineHeight(style, scale, opts.fallbackLineHeight),
      paragraphGap: opts.paragraphGap || Math.max(8, scaled(style.marginBottom, scale, 10) * 0.7),
      textIndent: opts.textIndent === undefined ? scaled(style.textIndent, scale, 0) : opts.textIndent,
    };
  }

  function fallbackElement(selector, fallback) {
    return document.querySelector(selector) || fallback || document.body;
  }

  function readShareStyles() {
    var root = document.documentElement;
    var rootStyle = getComputedStyle(root);
    var main = fallbackElement(".content main", document.body);
    var mainStyle = getComputedStyle(main);
    var mainWidth = Math.min(parsePx(mainStyle.maxWidth, 720), main.getBoundingClientRect().width || 720);
    var width = 1080;
    var height = 1440;
    var padding = 72;
    var innerWidth = width - padding * 2;
    var styleScale = Math.max(1.18, Math.min(1.34, innerWidth / Math.max(680, mainWidth || 720)));
    var paragraph = fallbackElement(".translation-block p", fallbackElement(".content main p", main));
    var paragraphStyle = getComputedStyle(paragraph);
    var monoFamily = rootStyle.getPropertyValue("--mono-font").trim() || "Menlo, Consolas, monospace";
    var sansFamily = cssValue(rootStyle, "--lacan-elegant-sans", '"PingFang SC", sans-serif');
    var serifFamily = mainStyle.fontFamily || cssValue(rootStyle, "--lacan-elegant-serif", '"Songti SC", serif');
    var fg = cssValue(rootStyle, "--fg", paragraphStyle.color || "#333333");
    var border = cssValue(rootStyle, "--table-border-color", "#e5e5e5");
    var bg = cssValue(rootStyle, "--bg", "#ffffff");
    var muted = cssValue(rootStyle, "--icons", "#777777");
    var accent = cssValue(rootStyle, "--lacan-original-accent", cssValue(rootStyle, "--links", "#8b7355"));
    var note = fallbackElement(".note-block:not(.original-notes)", main);
    var noteStyle = getComputedStyle(note);
    var commentary = fallbackElement(".commentary-block", main);
    var commentaryStyle = getComputedStyle(commentary);
    var original = fallbackElement(".original-block", main);
    var originalStyle = getComputedStyle(original);
    var originalText = fallbackElement(".original-paragraph", original);
    var summary = fallbackElement(".original-block summary", original);

    function blockFrame(elementStyle, labelColor, textElement, labelElement) {
      return {
        background: elementStyle.backgroundColor || "transparent",
        borderColor: elementStyle.borderLeftColor || border,
        borderWidth: Math.max(2, scaled(elementStyle.borderLeftWidth, styleScale, 3)),
        radius: Math.max(0, scaled(elementStyle.borderRadius, styleScale, 6)),
        paddingX: Math.max(18, scaled(elementStyle.paddingLeft, styleScale, 16)),
        paddingY: Math.max(16, scaled(elementStyle.paddingTop, styleScale, 12)),
        labelGap: Math.round(8 * styleScale),
        marginBottom: Math.round(18 * styleScale),
        label: textStyleFromElement(labelElement || textElement, styleScale, {
          color: labelColor,
          fontFamily: monoFamily,
          fontSize: 12,
          fontWeight: "500",
          lineHeight: Math.round(18 * styleScale),
          textIndent: 0,
        }),
        text: textStyleFromElement(textElement, styleScale, { textIndent: scaled(paragraphStyle.textIndent, styleScale, 0) }),
      };
    }

    return {
      canvasScale: 2,
      width: width,
      height: height,
      padding: padding,
      innerWidth: innerWidth,
      contentTop: 158,
      contentBottom: 1194,
      footerY: 1248,
      qrSize: 130,
      bg: bg,
      fg: fg,
      muted: muted,
      border: border,
      accent: accent,
      surface: cssValue(rootStyle, "--lacan-elegant-surface", cssValue(rootStyle, "--theme-popup-bg", bg)),
      header: {
        titleFont: "normal 400 " + Math.round(26 * styleScale) + "px " + serifFamily,
        metaFont: "normal 400 " + Math.round(13 * styleScale) + "px " + monoFamily,
        titleColor: fg,
        metaColor: muted,
      },
      paragraphId: textStyleFromElement(fallbackElement(".paragraph-id", main), styleScale, {
        color: accent,
        fontFamily: monoFamily,
        fontSize: 13,
        lineHeight: Math.round(21 * styleScale),
        textIndent: 0,
      }),
      translation: textStyleFromElement(paragraph, styleScale, {
        fontFamily: serifFamily,
        color: paragraphStyle.color || fg,
        textIndent: scaled(paragraphStyle.textIndent, styleScale, 0),
      }),
      placeholder: textStyleFromElement(paragraph, styleScale, {
        color: muted,
        fontFamily: serifFamily,
        textIndent: 0,
      }),
      blocks: {
        original: blockFrame(originalStyle, originalStyle.borderLeftColor || accent, originalText, summary),
        note: blockFrame(noteStyle, noteStyle.borderLeftColor || border, fallbackElement(".note-block p", note), note),
        commentary: blockFrame(commentaryStyle, commentaryStyle.borderLeftColor || cssValue(rootStyle, "--lacan-commentary-accent", accent), fallbackElement(".commentary-block p", commentary), commentary),
      },
    };
  }

  function splitParagraphs(text) {
    return normalizeText(text).split(/\n{2,}/).filter(function (paragraph) {
      return paragraph.trim();
    });
  }

  function wrapParagraph(ctx, paragraph, maxWidth, firstLineIndent) {
    var lines = [];
    var line = "";
    var indent = firstLineIndent || 0;
    var chars = paragraph.split("");

    chars.forEach(function (char) {
      var next = line + char;
      var available = maxWidth - indent;
      if (line && ctx.measureText(next).width > available) {
        lines.push({ text: line.replace(/\s+$/g, ""), indent: indent });
        line = char.replace(/^\s+/g, "");
        indent = 0;
      } else {
        line = next;
      }
    });

    if (line) {
      lines.push({ text: line.replace(/\s+$/g, ""), indent: indent });
    }

    return lines;
  }

  function buildTextFlow(ctx, text, maxWidth, style) {
    var paragraphs = splitParagraphs(text);
    var flow = [];
    ctx.font = style.font;

    paragraphs.forEach(function (paragraph, index) {
      if (index > 0) {
        flow.push({ type: "space", height: style.paragraphGap });
      }
      Array.prototype.push.apply(flow, wrapParagraph(ctx, paragraph, maxWidth, style.textIndent || 0));
    });

    return flow;
  }

  function newSharePage(styles, snippet) {
    return {
      ops: [],
      y: styles.contentTop,
      url: snippet ? snippet.url : "",
      ids: snippet ? snippet.ids.slice() : [],
    };
  }

  function includeSnippet(page, snippet) {
    if (!page.url) {
      page.url = snippet.url;
    }
    snippet.ids.forEach(function (id) {
      if (page.ids.indexOf(id) === -1) {
        page.ids.push(id);
      }
    });
  }

  function ensureSpace(pages, page, styles, height, snippet) {
    if (page.y + height <= styles.contentBottom || page.y <= styles.contentTop + 1) {
      includeSnippet(page, snippet);
      return page;
    }
    page = newSharePage(styles, snippet);
    pages.push(page);
    return page;
  }

  function addShareText(page, x, text, style) {
    page.ops.push({
      type: "text",
      x: x,
      y: page.y,
      text: text,
      font: style.font,
      color: style.color,
    });
    page.y += style.lineHeight;
  }

  function addFlowText(ctx, pages, page, styles, snippet, text, style, options) {
    var opts = options || {};
    var x = opts.x === undefined ? styles.padding : opts.x;
    var maxWidth = opts.maxWidth || styles.innerWidth;
    var flow = buildTextFlow(ctx, text, maxWidth, style);

    flow.forEach(function (item) {
      var height = item.type === "space" ? item.height : style.lineHeight;
      page = ensureSpace(pages, page, styles, height, snippet);
      if (item.type === "space") {
        page.y += height;
        return;
      }
      addShareText(page, x + (item.indent || 0), item.text, style);
    });

    return page;
  }

  function addRule(pages, page, styles, snippet) {
    page = ensureSpace(pages, page, styles, 34, snippet);
    page.ops.push({
      type: "rule",
      x: styles.padding,
      y: page.y,
      width: styles.innerWidth,
      color: styles.border,
    });
    page.y += 32;
    return page;
  }

  function openFrame(page, styles, blockStyle) {
    var frame = {
      type: "frame",
      x: styles.padding,
      y: page.y,
      width: styles.innerWidth,
      height: 0,
      fill: blockStyle.background,
      border: blockStyle.borderColor,
      borderWidth: blockStyle.borderWidth,
      radius: blockStyle.radius,
    };
    page.ops.push(frame);
    page.y += blockStyle.paddingY;
    return frame;
  }

  function closeFrame(page, frame, blockStyle) {
    page.y += blockStyle.paddingY;
    frame.height = page.y - frame.y;
    page.y += blockStyle.marginBottom;
  }

  function addFramedBlock(ctx, pages, page, styles, snippet, block) {
    var blockStyle = styles.blocks[block.kind] || styles.blocks.note;
    var textX = styles.padding + blockStyle.paddingX;
    var textWidth = styles.innerWidth - blockStyle.paddingX * 2;
    var minimumHeight = blockStyle.paddingY * 2 + blockStyle.label.lineHeight + blockStyle.labelGap + blockStyle.text.lineHeight;
    var continuation = false;
    var frame;

    function begin() {
      page = ensureSpace(pages, page, styles, minimumHeight, snippet);
      frame = openFrame(page, styles, blockStyle);
      addShareText(page, textX, continuation ? block.label + "（续）" : block.label, blockStyle.label);
      page.y += blockStyle.labelGap;
      continuation = true;
    }

    begin();
    buildTextFlow(ctx, block.text, textWidth, blockStyle.text).forEach(function (item) {
      var height = item.type === "space" ? item.height : blockStyle.text.lineHeight;
      if (page.y + height + blockStyle.paddingY > styles.contentBottom &&
          page.y > frame.y + blockStyle.paddingY + blockStyle.label.lineHeight + blockStyle.labelGap) {
        closeFrame(page, frame, blockStyle);
        page = newSharePage(styles, snippet);
        pages.push(page);
        begin();
      }

      if (item.type === "space") {
        page.y += height;
        return;
      }

      page.ops.push({
        type: "text",
        x: textX + (item.indent || 0),
        y: page.y,
        text: item.text,
        font: blockStyle.text.font,
        color: blockStyle.text.color,
      });
      page.y += blockStyle.text.lineHeight;
    });

    closeFrame(page, frame, blockStyle);
    return page;
  }

  function addSnippetToPages(ctx, pages, page, styles, snippet, index) {
    if (index > 0) {
      page = addRule(pages, page, styles, snippet);
    }

    page = ensureSpace(pages, page, styles, styles.paragraphId.lineHeight + 18, snippet);
    addShareText(page, styles.padding, snippet.ids.join(", "), styles.paragraphId);
    page.y += 12;

    if (!snippet.blocks.length) {
      page = addFlowText(ctx, pages, page, styles, snippet, "当前片段没有可导出的文本。", styles.placeholder);
      page.y += 20;
      return page;
    }

    snippet.blocks.forEach(function (block) {
      if (block.kind === "translation") {
        page = addFlowText(ctx, pages, page, styles, snippet, block.text, styles.translation);
        page.y += 24;
      } else {
        page = addFramedBlock(ctx, pages, page, styles, snippet, block);
      }
    });

    return page;
  }

  function drawRoundedRect(ctx, x, y, width, height, radius) {
    var r = Math.min(radius, width / 2, height / 2);
    if (ctx.roundRect) {
      ctx.roundRect(x, y, width, height, r);
      return;
    }
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
  }

  function drawShareHeader(ctx, styles, pageIndex, pageCount) {
    ctx.font = styles.header.titleFont;
    ctx.fillStyle = styles.header.titleColor;
    ctx.textAlign = "center";
    ctx.fillText("拉康中文开放翻译计划", styles.width / 2, 58);
    ctx.font = styles.header.metaFont;
    ctx.fillStyle = styles.header.metaColor;
    ctx.fillText("片段分享 · " + (pageIndex + 1) + " / " + pageCount, styles.width / 2, 104);
    ctx.strokeStyle = styles.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(styles.padding, 136.5);
    ctx.lineTo(styles.padding + styles.innerWidth, 136.5);
    ctx.stroke();
    ctx.textAlign = "left";
  }

  function drawShareFooter(ctx, styles, page) {
    var qrSize = styles.qrSize;
    var qrX = styles.padding + styles.innerWidth - qrSize;
    var labelWidth = styles.innerWidth - qrSize - 28;
    var url = page.url || window.location.href;
    var ids = page.ids.length > 3 ? page.ids.slice(0, 3).join(", ") + " ..." : page.ids.join(", ");
    var footerLabel = "扫码定位：" + (ids || "当前片段");
    var footerFont = styles.header.metaFont;

    ctx.strokeStyle = styles.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(styles.padding, styles.footerY - 26.5);
    ctx.lineTo(styles.padding + styles.innerWidth, styles.footerY - 26.5);
    ctx.stroke();

    ctx.font = footerFont;
    ctx.fillStyle = styles.fg;
    ctx.fillText(footerLabel, styles.padding, styles.footerY + 10);
    ctx.fillStyle = styles.muted;
    wrapParagraph(ctx, url, labelWidth, 0).slice(0, 3).forEach(function (line, index) {
      ctx.fillText(line.text, styles.padding, styles.footerY + 42 + index * 24);
    });

    drawQr(ctx, createQrMatrix(url), qrX, styles.footerY, qrSize, { borderColor: styles.border });
  }

  function renderSharePage(page, styles, pageIndex, pageCount) {
    var canvas = document.createElement("canvas");
    canvas.width = styles.width * styles.canvasScale;
    canvas.height = styles.height * styles.canvasScale;

    var ctx = canvas.getContext("2d");
    ctx.scale(styles.canvasScale, styles.canvasScale);
    ctx.textBaseline = "top";
    ctx.fillStyle = styles.bg;
    ctx.fillRect(0, 0, styles.width, styles.height);
    drawShareHeader(ctx, styles, pageIndex, pageCount);

    page.ops.forEach(function (op) {
      if (op.type === "frame") {
        ctx.beginPath();
        drawRoundedRect(ctx, op.x, op.y, op.width, op.height, op.radius);
        ctx.fillStyle = op.fill;
        ctx.fill();
        ctx.strokeStyle = styles.border;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = op.border;
        ctx.fillRect(op.x, op.y, op.borderWidth, op.height);
        return;
      }

      if (op.type === "rule") {
        ctx.strokeStyle = op.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(op.x, op.y + 0.5);
        ctx.lineTo(op.x + op.width, op.y + 0.5);
        ctx.stroke();
        return;
      }

      ctx.font = op.font;
      ctx.fillStyle = op.color;
      ctx.fillText(op.text, op.x, op.y);
    });

    drawShareFooter(ctx, styles, page);
    return canvas;
  }

  function createShareCanvases(snippets) {
    if (!snippets.length) {
      throw new Error("请先选择要分享的片段。");
    }

    var styles = readShareStyles();
    var measureCanvas = document.createElement("canvas");
    var measureCtx = measureCanvas.getContext("2d");
    var pages = [newSharePage(styles, snippets[0])];
    var page = pages[0];

    snippets.forEach(function (snippet, index) {
      page = addSnippetToPages(measureCtx, pages, page, styles, snippet, index);
    });

    return pages.map(function (sharePage, index) {
      return renderSharePage(sharePage, styles, index, pages.length);
    });
  }

  function canvasToBlob(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("无法生成图片文件。"));
        }
      }, "image/png");
    });
  }

  function downloadBlob(blob, filename) {
    var link = document.createElement("a");
    var url = URL.createObjectURL(blob);
    link.download = filename;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function makeCrcTable() {
    var table = [];
    for (var n = 0; n < 256; n += 1) {
      var c = n;
      for (var k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  }

  var crcTable = null;

  function crc32(bytes) {
    if (!crcTable) {
      crcTable = makeCrcTable();
    }
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i += 1) {
      crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function writeZipHeader(length) {
    return {
      bytes: new Uint8Array(length),
      view: null,
    };
  }

  function dosDateTime(date) {
    var year = Math.max(1980, date.getFullYear());
    var dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    var dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time: dosTime, date: dosDate };
  }

  function makeZipBlob(entries) {
    var encoder = new TextEncoder();
    var now = dosDateTime(new Date());

    return Promise.all(entries.map(function (entry) {
      return entry.blob.arrayBuffer().then(function (buffer) {
        var data = new Uint8Array(buffer);
        return {
          name: entry.name,
          nameBytes: encoder.encode(entry.name),
          data: data,
          crc: crc32(data),
        };
      });
    })).then(function (files) {
      var parts = [];
      var central = [];
      var offset = 0;

      files.forEach(function (file) {
        var local = writeZipHeader(30 + file.nameBytes.length);
        local.view = new DataView(local.bytes.buffer);
        local.view.setUint32(0, 0x04034b50, true);
        local.view.setUint16(4, 20, true);
        local.view.setUint16(6, 0x0800, true);
        local.view.setUint16(8, 0, true);
        local.view.setUint16(10, now.time, true);
        local.view.setUint16(12, now.date, true);
        local.view.setUint32(14, file.crc, true);
        local.view.setUint32(18, file.data.length, true);
        local.view.setUint32(22, file.data.length, true);
        local.view.setUint16(26, file.nameBytes.length, true);
        local.bytes.set(file.nameBytes, 30);
        parts.push(local.bytes, file.data);

        var centralHeader = writeZipHeader(46 + file.nameBytes.length);
        centralHeader.view = new DataView(centralHeader.bytes.buffer);
        centralHeader.view.setUint32(0, 0x02014b50, true);
        centralHeader.view.setUint16(4, 20, true);
        centralHeader.view.setUint16(6, 20, true);
        centralHeader.view.setUint16(8, 0x0800, true);
        centralHeader.view.setUint16(10, 0, true);
        centralHeader.view.setUint16(12, now.time, true);
        centralHeader.view.setUint16(14, now.date, true);
        centralHeader.view.setUint32(16, file.crc, true);
        centralHeader.view.setUint32(20, file.data.length, true);
        centralHeader.view.setUint32(24, file.data.length, true);
        centralHeader.view.setUint16(28, file.nameBytes.length, true);
        centralHeader.view.setUint32(42, offset, true);
        centralHeader.bytes.set(file.nameBytes, 46);
        central.push(centralHeader.bytes);
        offset += local.bytes.length + file.data.length;
      });

      var centralOffset = offset;
      central.forEach(function (part) {
        parts.push(part);
        offset += part.length;
      });

      var end = writeZipHeader(22);
      end.view = new DataView(end.bytes.buffer);
      end.view.setUint32(0, 0x06054b50, true);
      end.view.setUint16(8, files.length, true);
      end.view.setUint16(10, files.length, true);
      end.view.setUint32(12, offset - centralOffset, true);
      end.view.setUint32(16, centralOffset, true);
      parts.push(end.bytes);

      return new Blob(parts, { type: "application/zip" });
    });
  }

  function saveSelectedParagraphs() {
    var sections = selectedSections();
    if (!sections.length) {
      throw new Error("请先选择要分享的片段。");
    }

    var snippets = sections.map(collectSnippet);
    var canvases = createShareCanvases(snippets);
    var ids = snippets.map(function (snippet) {
      return snippet.anchor;
    }).join("-");
    var basename = "lacan-" + safeFilename(ids);

    if (canvases.length === 1) {
      return canvasToBlob(canvases[0]).then(function (blob) {
        downloadBlob(blob, basename + ".png");
      });
    }

    return Promise.all(canvases.map(function (canvas, index) {
      return canvasToBlob(canvas).then(function (blob) {
        return {
          name: basename + "-" + String(index + 1).padStart(2, "0") + ".png",
          blob: blob,
        };
      });
    })).then(makeZipBlob).then(function (blob) {
      downloadBlob(blob, basename + ".zip");
    });
  }

  function initGf() {
    if (qrExp && qrLog) {
      return;
    }

    qrExp = [];
    qrLog = [];

    var x = 1;
    for (var i = 0; i < 255; i += 1) {
      qrExp[i] = x;
      qrLog[x] = i;
      x <<= 1;
      if (x & 0x100) {
        x ^= 0x11d;
      }
    }

    for (var j = 255; j < 512; j += 1) {
      qrExp[j] = qrExp[j - 255];
    }
  }

  function gfMultiply(x, y) {
    if (x === 0 || y === 0) {
      return 0;
    }
    return qrExp[qrLog[x] + qrLog[y]];
  }

  function reedSolomonGenerator(degree) {
    initGf();
    var poly = [1];
    for (var i = 0; i < degree; i += 1) {
      var next = new Array(poly.length + 1);
      for (var n = 0; n < next.length; n += 1) {
        next[n] = 0;
      }
      for (var j = 0; j < poly.length; j += 1) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMultiply(poly[j], qrExp[i]);
      }
      poly = next;
    }
    return poly;
  }

  function reedSolomonRemainder(data, degree) {
    var generator = reedSolomonGenerator(degree);
    var remainder = new Array(degree);
    for (var i = 0; i < degree; i += 1) {
      remainder[i] = 0;
    }

    data.forEach(function (byte) {
      var factor = byte ^ remainder[0];
      remainder.shift();
      remainder.push(0);
      for (var j = 0; j < degree; j += 1) {
        remainder[j] ^= gfMultiply(generator[j + 1], factor);
      }
    });

    return remainder;
  }

  function appendBits(bits, value, length) {
    for (var i = length - 1; i >= 0; i -= 1) {
      bits.push(((value >>> i) & 1) !== 0);
    }
  }

  function sum(values) {
    return values.reduce(function (total, value) {
      return total + value;
    }, 0);
  }

  function chooseQrVersion(dataLength) {
    for (var version = 1; version <= 10; version += 1) {
      var level = qrLevels[version];
      var countBits = version <= 9 ? 8 : 16;
      var neededBits = 4 + countBits + dataLength * 8;
      if (neededBits <= sum(level.blocks) * 8) {
        return version;
      }
    }
    throw new Error("当前段落链接过长，无法生成二维码。");
  }

  function encodeQrData(text) {
    if (!window.TextEncoder) {
      throw new Error("当前浏览器不支持二维码编码所需的 TextEncoder。");
    }

    var bytes = Array.prototype.slice.call(new TextEncoder().encode(text));
    var version = chooseQrVersion(bytes.length);
    var level = qrLevels[version];
    var capacity = sum(level.blocks);
    var capacityBits = capacity * 8;
    var bits = [];

    appendBits(bits, 0x4, 4);
    appendBits(bits, bytes.length, version <= 9 ? 8 : 16);
    bytes.forEach(function (byte) {
      appendBits(bits, byte, 8);
    });

    var terminator = Math.min(4, capacityBits - bits.length);
    appendBits(bits, 0, terminator);
    while (bits.length % 8 !== 0) {
      bits.push(false);
    }

    var codewords = [];
    for (var i = 0; i < bits.length; i += 8) {
      var value = 0;
      for (var j = 0; j < 8; j += 1) {
        value = (value << 1) | (bits[i + j] ? 1 : 0);
      }
      codewords.push(value);
    }

    var padBytes = [0xec, 0x11];
    var padIndex = 0;
    while (codewords.length < capacity) {
      codewords.push(padBytes[padIndex % 2]);
      padIndex += 1;
    }

    return { version: version, level: level, codewords: codewords };
  }

  function splitBlocks(codewords, blockLengths) {
    var blocks = [];
    var offset = 0;
    blockLengths.forEach(function (length) {
      blocks.push(codewords.slice(offset, offset + length));
      offset += length;
    });
    return blocks;
  }

  function addErrorCorrection(encoded) {
    var dataBlocks = splitBlocks(encoded.codewords, encoded.level.blocks);
    var eccBlocks = dataBlocks.map(function (block) {
      return reedSolomonRemainder(block, encoded.level.ecc);
    });
    var result = [];
    var maxDataLength = Math.max.apply(null, encoded.level.blocks);

    for (var i = 0; i < maxDataLength; i += 1) {
      dataBlocks.forEach(function (block) {
        if (i < block.length) {
          result.push(block[i]);
        }
      });
    }

    for (var j = 0; j < encoded.level.ecc; j += 1) {
      eccBlocks.forEach(function (block) {
        result.push(block[j]);
      });
    }

    return result;
  }

  function createQrState(version) {
    var size = version * 4 + 17;
    var modules = [];
    var isFunction = [];
    for (var y = 0; y < size; y += 1) {
      modules[y] = [];
      isFunction[y] = [];
      for (var x = 0; x < size; x += 1) {
        modules[y][x] = false;
        isFunction[y][x] = false;
      }
    }
    return { version: version, size: size, modules: modules, isFunction: isFunction };
  }

  function setFunction(state, x, y, dark) {
    if (x < 0 || y < 0 || x >= state.size || y >= state.size) {
      return;
    }
    state.modules[y][x] = !!dark;
    state.isFunction[y][x] = true;
  }

  function drawFinder(state, x, y) {
    for (var dy = -1; dy <= 7; dy += 1) {
      for (var dx = -1; dx <= 7; dx += 1) {
        var xx = x + dx;
        var yy = y + dy;
        var dark = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 &&
          (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
        setFunction(state, xx, yy, dark);
      }
    }
  }

  function drawAlignment(state, cx, cy) {
    for (var dy = -2; dy <= 2; dy += 1) {
      for (var dx = -2; dx <= 2; dx += 1) {
        setFunction(state, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  function reserveFormatBits(state) {
    drawFormatBits(state, 0);
  }

  function getBit(value, index) {
    return ((value >>> index) & 1) !== 0;
  }

  function drawFormatBits(state, mask) {
    var data = (1 << 3) | mask;
    var remainder = data;
    for (var i = 0; i < 10; i += 1) {
      remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) ? 0x537 : 0);
    }
    var bits = ((data << 10) | remainder) ^ 0x5412;

    for (var a = 0; a <= 5; a += 1) {
      setFunction(state, 8, a, getBit(bits, a));
    }
    setFunction(state, 8, 7, getBit(bits, 6));
    setFunction(state, 8, 8, getBit(bits, 7));
    setFunction(state, 7, 8, getBit(bits, 8));
    for (var b = 9; b < 15; b += 1) {
      setFunction(state, 14 - b, 8, getBit(bits, b));
    }

    for (var c = 0; c < 8; c += 1) {
      setFunction(state, state.size - 1 - c, 8, getBit(bits, c));
    }
    for (var d = 8; d < 15; d += 1) {
      setFunction(state, 8, state.size - 15 + d, getBit(bits, d));
    }
    setFunction(state, 8, state.size - 8, true);
  }

  function drawVersionBits(state) {
    if (state.version < 7) {
      return;
    }

    var remainder = state.version;
    for (var i = 0; i < 12; i += 1) {
      remainder = (remainder << 1) ^ (((remainder >>> 11) & 1) ? 0x1f25 : 0);
    }
    var bits = (state.version << 12) | remainder;

    for (var j = 0; j < 18; j += 1) {
      var bit = getBit(bits, j);
      var a = state.size - 11 + (j % 3);
      var b = Math.floor(j / 3);
      setFunction(state, a, b, bit);
      setFunction(state, b, a, bit);
    }
  }

  function drawFunctionPatterns(state, alignPositions) {
    drawFinder(state, 0, 0);
    drawFinder(state, state.size - 7, 0);
    drawFinder(state, 0, state.size - 7);

    for (var i = 8; i < state.size - 8; i += 1) {
      setFunction(state, i, 6, i % 2 === 0);
      setFunction(state, 6, i, i % 2 === 0);
    }

    alignPositions.forEach(function (cx) {
      alignPositions.forEach(function (cy) {
        var nearFinder = (cx < 9 && cy < 9) ||
          (cx > state.size - 10 && cy < 9) ||
          (cx < 9 && cy > state.size - 10);
        if (!nearFinder) {
          drawAlignment(state, cx, cy);
        }
      });
    });

    reserveFormatBits(state);
    drawVersionBits(state);
  }

  function placeDataBits(state, codewords) {
    var bitLength = codewords.length * 8;
    var bitIndex = 0;
    var upward = true;

    for (var right = state.size - 1; right >= 1; right -= 2) {
      if (right === 6) {
        right = 5;
      }

      for (var vert = 0; vert < state.size; vert += 1) {
        var y = upward ? state.size - 1 - vert : vert;
        for (var j = 0; j < 2; j += 1) {
          var x = right - j;
          if (state.isFunction[y][x]) {
            continue;
          }

          var dark = false;
          if (bitIndex < bitLength) {
            dark = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
          }
          state.modules[y][x] = dark;
          bitIndex += 1;
        }
      }

      upward = !upward;
    }
  }

  function maskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return ((x * y) % 2 + (x * y) % 3) === 0;
      case 6: return (((x * y) % 2 + (x * y) % 3) % 2) === 0;
      case 7: return (((x + y) % 2 + (x * y) % 3) % 2) === 0;
      default: return false;
    }
  }

  function cloneQrState(state) {
    var clone = createQrState(state.version);
    for (var y = 0; y < state.size; y += 1) {
      for (var x = 0; x < state.size; x += 1) {
        clone.modules[y][x] = state.modules[y][x];
        clone.isFunction[y][x] = state.isFunction[y][x];
      }
    }
    return clone;
  }

  function applyMask(state, mask) {
    var masked = cloneQrState(state);
    for (var y = 0; y < masked.size; y += 1) {
      for (var x = 0; x < masked.size; x += 1) {
        if (!masked.isFunction[y][x] && maskBit(mask, x, y)) {
          masked.modules[y][x] = !masked.modules[y][x];
        }
      }
    }
    drawFormatBits(masked, mask);
    return masked;
  }

  function penaltyScore(state) {
    var penalty = 0;
    var size = state.size;

    function scoreLine(getValue) {
      var score = 0;
      var runColor = getValue(0);
      var runLength = 1;
      for (var i = 1; i < size; i += 1) {
        var color = getValue(i);
        if (color === runColor) {
          runLength += 1;
          if (runLength === 5) {
            score += 3;
          } else if (runLength > 5) {
            score += 1;
          }
        } else {
          runColor = color;
          runLength = 1;
        }
      }
      return score;
    }

    for (var y = 0; y < size; y += 1) {
      penalty += scoreLine(function (x) {
        return state.modules[y][x];
      });
    }
    for (var x = 0; x < size; x += 1) {
      penalty += scoreLine(function (yIndex) {
        return state.modules[yIndex][x];
      });
    }

    for (var yy = 0; yy < size - 1; yy += 1) {
      for (var xx = 0; xx < size - 1; xx += 1) {
        var color = state.modules[yy][xx];
        if (color === state.modules[yy][xx + 1] &&
            color === state.modules[yy + 1][xx] &&
            color === state.modules[yy + 1][xx + 1]) {
          penalty += 3;
        }
      }
    }

    var pattern = [true, false, true, true, true, false, true, false, false, false, false];
    var reverse = pattern.slice().reverse();
    function matchesPattern(getValue, start, values) {
      for (var i = 0; i < values.length; i += 1) {
        if (getValue(start + i) !== values[i]) {
          return false;
        }
      }
      return true;
    }
    for (var row = 0; row < size; row += 1) {
      for (var sx = 0; sx <= size - 11; sx += 1) {
        if (matchesPattern(function (index) { return state.modules[row][index]; }, sx, pattern) ||
            matchesPattern(function (index) { return state.modules[row][index]; }, sx, reverse)) {
          penalty += 40;
        }
      }
    }
    for (var col = 0; col < size; col += 1) {
      for (var sy = 0; sy <= size - 11; sy += 1) {
        if (matchesPattern(function (index) { return state.modules[index][col]; }, sy, pattern) ||
            matchesPattern(function (index) { return state.modules[index][col]; }, sy, reverse)) {
          penalty += 40;
        }
      }
    }

    var dark = 0;
    for (var py = 0; py < size; py += 1) {
      for (var px = 0; px < size; px += 1) {
        if (state.modules[py][px]) {
          dark += 1;
        }
      }
    }
    var ratio = Math.abs((dark * 100) / (size * size) - 50);
    penalty += Math.floor(ratio / 5) * 10;
    return penalty;
  }

  function createQrMatrix(text) {
    var encoded = encodeQrData(text);
    var codewords = addErrorCorrection(encoded);
    var base = createQrState(encoded.version);
    drawFunctionPatterns(base, encoded.level.align);
    placeDataBits(base, codewords);

    var best = null;
    var bestPenalty = Infinity;
    for (var mask = 0; mask < 8; mask += 1) {
      var candidate = applyMask(base, mask);
      var penalty = penaltyScore(candidate);
      if (penalty < bestPenalty) {
        best = candidate;
        bestPenalty = penalty;
      }
    }
    return best.modules;
  }

  function drawQr(ctx, matrix, x, y, size, options) {
    var opts = options || {};
    var quiet = 4;
    var count = matrix.length;
    var moduleSize = size / (count + quiet * 2);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = "#111827";

    for (var row = 0; row < count; row += 1) {
      for (var col = 0; col < count; col += 1) {
        if (matrix[row][col]) {
          ctx.fillRect(
            x + (col + quiet) * moduleSize,
            y + (row + quiet) * moduleSize,
            Math.ceil(moduleSize),
            Math.ceil(moduleSize)
          );
        }
      }
    }

    ctx.strokeStyle = opts.borderColor || "#ded6c8";
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
  }

  document.addEventListener("DOMContentLoaded", function () {
    refineThemeMenu();
    ensureToolPanel();
    applyAll();

    Array.prototype.forEach.call(document.querySelectorAll(".parallel-paragraph"), function (section) {
      ensureParagraphAnchors(section);
    });

    Object.keys(toggles).forEach(function (name) {
      var controls = document.querySelectorAll('[data-lacan-toggle="' + name + '"]');
      Array.prototype.forEach.call(controls, function (control) {
        control.addEventListener("change", function () {
          window.localStorage.setItem(key(name), String(control.checked));
          applyToggle(name, control.checked);
        });
      });
    });
  });
})();
