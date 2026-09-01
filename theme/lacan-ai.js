(function () {
  "use strict";

  var Core = window.LacanAiCore;
  if (!Core) return;

  var SETTINGS_KEY = "lacan-ai:settings";
  var API_KEY = "lacan-ai:key";
  var LAUNCHER_POSITION_KEY = "lacan-ai:launcher-position";
  var PANEL_WIDTH_KEY = "lacan-ai:panel-width";
  var STORAGE_PREFIX = "lacan-ai:";
  var LAUNCHER_EDGE_MARGIN = 8;
  var PANEL_DEFAULT_WIDTH = 440;
  var PANEL_MIN_WIDTH = 320;
  var PANEL_MAX_WIDTH = 900;
  var PANEL_CENTER_MIN_WIDTH = 360;
  var PANEL_DOCK_BREAKPOINT = 900;
  var PANEL_KEYBOARD_STEP = 24;
  var OUTPUT_FOLLOW_THRESHOLD = 56;
  var ownScript = document.currentScript;
  var scriptUrl = ownScript && ownScript.src ? ownScript.src : "";
  var rootUrl = scriptUrl
    ? new URL("../", scriptUrl)
    : new URL("./", window.location.href);

  var state = {
    index: null,
    indexPromise: null,
    selectedCard: null,
    translationSelection: null,
    outputMarkdown: "",
    copyResetTimer: 0,
    copyScrollFrame: 0,
    lastOutputScrollSnapshot: null,
    outputSnapshotFrame: 0,
    outputAutoFollow: true,
    outputScrollFrame: 0,
    pendingStreamingMarkdown: "",
    streamRenderFrame: 0,
    requestAutoFollowActive: false,
    requestAutoFollowReleaseFrame: 0,
    activeRequestController: null,
    activeRequestCleared: false,
    segmentPageCache: new Map(),
    panelWidthPreference: PANEL_DEFAULT_WIDTH,
    sidebarResizeObserver: null,
    selectionPointerStartedInPage: false,
    selectionCaptureFrame: 0,
    refs: {},
  };

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (typeof text === "string") node.textContent = text;
    return node;
  }

  function button(label, className) {
    var node = element("button", className, label);
    node.type = "button";
    return node;
  }

  function readSettings() {
    var defaults = {
      endpoint: "https://api.openai.com/v1/chat/completions",
      model: "",
      persistKey: false,
    };
    try {
      var saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "{}");
      var settings = Object.assign({}, defaults, saved);
      settings.apiKey = settings.persistKey
        ? window.localStorage.getItem(API_KEY) || ""
        : window.sessionStorage.getItem(API_KEY) || "";
      return settings;
    } catch (_error) {
      return Object.assign({}, defaults, { apiKey: "" });
    }
  }

  function saveSettings(settings) {
    var persisted = {
      endpoint: settings.endpoint,
      model: settings.model,
      persistKey: Boolean(settings.persistKey),
    };
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(persisted));
    if (persisted.persistKey) {
      window.localStorage.setItem(API_KEY, settings.apiKey || "");
      window.sessionStorage.removeItem(API_KEY);
    } else {
      window.sessionStorage.setItem(API_KEY, settings.apiKey || "");
      window.localStorage.removeItem(API_KEY);
    }
  }

  function setStatus(message, kind) {
    state.refs.status.textContent = message || "";
    state.refs.status.dataset.kind = kind || "info";
  }

  function updateOutputNavigationState() {
    var body = state.refs.body;
    if (!body || !state.refs.outputNav) return;
    var nearTop = body.scrollTop <= 1;
    var nearBottom = Core.isScrollNearBottom(body, OUTPUT_FOLLOW_THRESHOLD);
    var outputKind = state.refs.output ? state.refs.output.dataset.kind : "";
    state.refs.outputTop.disabled = nearTop;
    state.refs.outputBottom.disabled = nearBottom;
    state.refs.outputClear.disabled = (
      !state.outputMarkdown.trim() || outputKind === "placeholder"
    ) && !state.activeRequestController;
    state.refs.outputNav.dataset.following = String(state.outputAutoFollow && nearBottom);
  }

  function rememberOutputScrollSnapshot() {
    if (!state.refs.body) return;
    state.lastOutputScrollSnapshot = Core.captureScrollSnapshot(
      state.refs.body,
      state.outputAutoFollow,
      OUTPUT_FOLLOW_THRESHOLD
    );
  }

  function scheduleRememberOutputScrollSnapshot() {
    window.cancelAnimationFrame(state.outputSnapshotFrame);
    state.outputSnapshotFrame = window.requestAnimationFrame(function () {
      state.outputSnapshotFrame = 0;
      rememberOutputScrollSnapshot();
    });
  }

  function scrollOutputToBottom() {
    if (!state.refs.body) return;
    state.refs.body.scrollTop = state.refs.body.scrollHeight;
    updateOutputNavigationState();
    rememberOutputScrollSnapshot();
  }

  function releaseRequestAutoFollow() {
    window.cancelAnimationFrame(state.requestAutoFollowReleaseFrame);
    state.requestAutoFollowReleaseFrame = window.requestAnimationFrame(function () {
      state.requestAutoFollowReleaseFrame = 0;
      state.requestAutoFollowActive = false;
      if (state.outputAutoFollow) scrollOutputToBottom();
      else updateOutputNavigationState();
    });
  }

  function scheduleOutputAutoFollow(kind) {
    if (!["streaming", "answer", "partial"].includes(kind)) {
      updateOutputNavigationState();
      return;
    }
    if (!state.outputAutoFollow || !state.refs.body) {
      updateOutputNavigationState();
      return;
    }
    scrollOutputToBottom();
    window.cancelAnimationFrame(state.outputScrollFrame);
    state.outputScrollFrame = window.requestAnimationFrame(function () {
      state.outputScrollFrame = 0;
      if (!state.outputAutoFollow || !state.refs.body) return;
      scrollOutputToBottom();
    });
  }

  function setOutput(message, kind) {
    state.outputMarkdown = String(message || "");
    var output = state.refs.output;
    output.innerHTML = Core.renderMarkdown(state.outputMarkdown);
    output.dataset.kind = kind || "answer";
    if (state.refs.outputShell) state.refs.outputShell.dataset.kind = kind || "answer";
    if (state.refs.copyButton) {
      state.refs.copyButton.disabled = !state.outputMarkdown.trim()
        || ["loading", "error", "placeholder"].includes(kind);
    }
    scheduleOutputAutoFollow(kind);
  }

  function cancelScheduledStreamingOutput() {
    window.cancelAnimationFrame(state.streamRenderFrame);
    state.streamRenderFrame = 0;
    state.pendingStreamingMarkdown = "";
  }

  function scheduleStreamingOutput(markdown) {
    state.pendingStreamingMarkdown = String(markdown || "");
    if (state.streamRenderFrame) return;
    state.streamRenderFrame = window.requestAnimationFrame(function () {
      state.streamRenderFrame = 0;
      var latest = state.pendingStreamingMarkdown;
      state.pendingStreamingMarkdown = "";
      setOutput(latest, "streaming");
    });
  }

  function handleOutputTop() {
    if (!state.refs.body) return;
    state.outputAutoFollow = false;
    state.refs.body.scrollTop = 0;
    updateOutputNavigationState();
    rememberOutputScrollSnapshot();
  }

  function handleOutputBottom() {
    if (!state.refs.body) return;
    state.outputAutoFollow = true;
    scrollOutputToBottom();
  }

  function handleClearOutput() {
    window.cancelAnimationFrame(state.outputScrollFrame);
    state.outputScrollFrame = 0;
    cancelScheduledStreamingOutput();
    state.outputAutoFollow = true;
    window.cancelAnimationFrame(state.requestAutoFollowReleaseFrame);
    state.requestAutoFollowReleaseFrame = 0;
    state.requestAutoFollowActive = false;
    if (state.activeRequestController) {
      state.activeRequestCleared = true;
      state.activeRequestController.abort();
      state.activeRequestController = null;
    }
    setOutput("", "placeholder");
    state.refs.output.setAttribute("aria-busy", "false");
    setStatus("当前回答已清空。", "info");
    setDiagnostics("当前回答已清空；如有正在生成的请求，也已停止。");
    updateOutputNavigationState();
    rememberOutputScrollSnapshot();
  }

  function setupOutputNavigation(body) {
    body.addEventListener("scroll", function () {
      var nearBottom = Core.isScrollNearBottom(body, OUTPUT_FOLLOW_THRESHOLD);
      if (nearBottom) {
        state.outputAutoFollow = true;
      } else if (!state.requestAutoFollowActive) {
        state.outputAutoFollow = false;
      }
      updateOutputNavigationState();
    }, { passive: true });
    body.addEventListener("wheel", function (event) {
      if (event.deltaY < 0) {
        state.outputAutoFollow = false;
        updateOutputNavigationState();
      }
      scheduleRememberOutputScrollSnapshot();
    }, { passive: true });
    body.addEventListener("touchend", scheduleRememberOutputScrollSnapshot, { passive: true });
    body.addEventListener("pointerup", function (event) {
      if (event.target === body) scheduleRememberOutputScrollSnapshot();
    });
    body.addEventListener("keyup", function (event) {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) {
        scheduleRememberOutputScrollSnapshot();
      }
    });
  }

  async function writeMarkdownToClipboard(markdown) {
    if (
      navigator.clipboard
      && typeof navigator.clipboard.writeText === "function"
      && window.isSecureContext
    ) {
      await navigator.clipboard.writeText(markdown);
      return;
    }

    var textarea = element("textarea", "lacan-ai-copy-source");
    textarea.value = markdown;
    textarea.setAttribute("readonly", "");
    document.body.appendChild(textarea);
    textarea.select();
    var copied = false;
    try {
      copied = document.execCommand("copy");
    } finally {
      textarea.remove();
    }
    if (!copied) throw new Error("当前浏览器未允许复制。请手动选择回答内容复制。");
  }

  function restoreScrollAfterCopy(snapshot) {
    var body = state.refs.body;
    if (!body || !snapshot) return;
    window.cancelAnimationFrame(state.copyScrollFrame);
    state.copyScrollFrame = window.requestAnimationFrame(function () {
      state.copyScrollFrame = 0;
      body.scrollTop = Core.resolveRestoredScrollTop(snapshot, body);
      state.outputAutoFollow = snapshot.autoFollow;
      updateOutputNavigationState();
      rememberOutputScrollSnapshot();
    });
  }

  async function handleCopyOutput() {
    var markdown = state.outputMarkdown;
    if (!markdown.trim() || state.refs.copyButton.disabled) return;
    var scrollSnapshot = state.lastOutputScrollSnapshot || Core.captureScrollSnapshot(
      state.refs.body,
      state.outputAutoFollow,
      OUTPUT_FOLLOW_THRESHOLD
    );
    window.clearTimeout(state.copyResetTimer);
    try {
      await writeMarkdownToClipboard(markdown);
      state.refs.copyButton.textContent = "已复制";
      state.refs.copyFeedback.textContent = "原始 Markdown 已复制";
      state.refs.copyFeedback.dataset.kind = "success";
    } catch (error) {
      state.refs.copyButton.textContent = "复制失败";
      state.refs.copyFeedback.textContent = error.message;
      state.refs.copyFeedback.dataset.kind = "error";
    } finally {
      restoreScrollAfterCopy(scrollSnapshot);
    }
    state.copyResetTimer = window.setTimeout(function () {
      state.refs.copyButton.textContent = "复制 Markdown";
      state.refs.copyFeedback.textContent = "";
      delete state.refs.copyFeedback.dataset.kind;
    }, 1800);
  }

  function setDiagnostics(details) {
    state.refs.diagnostics.textContent = typeof details === "string"
      ? details
      : Core.formatDiagnostics(details);
  }

  function findOwnScriptUrl() {
    if (scriptUrl) return scriptUrl;
    var scripts = Array.prototype.slice.call(document.scripts || []);
    var match = scripts.find(function (script) {
      return /\/lacan-ai\.js(?:\?|$)/.test(script.src || "");
    });
    return match ? match.src : "";
  }

  function refreshRootUrl() {
    var found = findOwnScriptUrl();
    if (found) rootUrl = new URL("../", found);
  }

  function launcherViewport() {
    return {
      width: document.documentElement.clientWidth || window.innerWidth,
      height: document.documentElement.clientHeight || window.innerHeight,
    };
  }

  function applyLauncherPosition(launcher, position) {
    var rect = launcher.getBoundingClientRect();
    var clamped = Core.clampLauncherPosition(
      position,
      launcherViewport(),
      { width: rect.width, height: rect.height },
      LAUNCHER_EDGE_MARGIN
    );
    launcher.style.left = clamped.left + "px";
    launcher.style.top = clamped.top + "px";
    launcher.style.right = "auto";
    launcher.style.bottom = "auto";
    return clamped;
  }

  function saveLauncherPosition(position) {
    try {
      window.localStorage.setItem(LAUNCHER_POSITION_KEY, JSON.stringify(position));
    } catch (_error) {}
  }

  function restoreLauncherPosition(launcher) {
    try {
      var saved = JSON.parse(window.localStorage.getItem(LAUNCHER_POSITION_KEY) || "null");
      if (saved && Number.isFinite(Number(saved.left)) && Number.isFinite(Number(saved.top))) {
        applyLauncherPosition(launcher, saved);
      }
    } catch (_error) {}
  }

  function resetLauncherPosition() {
    var launcher = state.refs.launcher;
    if (!launcher) return;
    launcher.style.removeProperty("left");
    launcher.style.removeProperty("top");
    launcher.style.removeProperty("right");
    launcher.style.removeProperty("bottom");
  }

  function pageStartOffset() {
    var viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    if (viewportWidth < PANEL_DOCK_BREAKPOINT) return 0;
    var pageWrapper = document.querySelector(".page-wrapper");
    if (!pageWrapper) return 0;
    var computed = window.getComputedStyle(pageWrapper);
    var offset = parseFloat(computed.marginInlineStart);
    if (!Number.isFinite(offset)) offset = parseFloat(computed.marginLeft);
    return Number.isFinite(offset) ? Math.max(0, offset) : 0;
  }

  function panelWidthBounds() {
    var viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    return Core.getDockedPanelWidthBounds(
      viewportWidth,
      pageStartOffset(),
      viewportWidth >= PANEL_DOCK_BREAKPOINT ? PANEL_CENTER_MIN_WIDTH : 0,
      PANEL_MIN_WIDTH,
      PANEL_MAX_WIDTH
    );
  }

  function updatePanelWidthAria(panel, width, bounds) {
    var resizer = state.refs.resizer || panel.querySelector(".lacan-ai-resizer");
    if (!resizer) return;
    resizer.setAttribute("aria-valuemin", String(Math.round(bounds.min)));
    resizer.setAttribute("aria-valuemax", String(Math.round(bounds.max)));
    resizer.setAttribute("aria-valuenow", String(Math.round(width)));
  }

  function applyPanelWidth(panel, width) {
    var requested = Number(width);
    if (Number.isFinite(requested) && requested > 0) {
      state.panelWidthPreference = requested;
    }
    var bounds = panelWidthBounds();
    var clamped = Core.clampPanelWidth(
      state.panelWidthPreference,
      bounds.min,
      bounds.max
    );
    panel.style.setProperty("--lacan-ai-panel-width", clamped + "px");
    document.documentElement.style.setProperty("--lacan-ai-docked-width", clamped + "px");
    updatePanelWidthAria(panel, clamped, bounds);
    return clamped;
  }

  function savePanelWidth(width) {
    state.panelWidthPreference = Number(width) || PANEL_DEFAULT_WIDTH;
    try {
      window.localStorage.setItem(
        PANEL_WIDTH_KEY,
        String(Math.round(state.panelWidthPreference))
      );
    } catch (_error) {}
  }

  function restorePanelWidth(panel) {
    var saved = NaN;
    try {
      saved = Number(window.localStorage.getItem(PANEL_WIDTH_KEY));
    } catch (_error) {}
    state.panelWidthPreference = Number.isFinite(saved) && saved > 0
      ? saved
      : PANEL_DEFAULT_WIDTH;
    applyPanelWidth(panel, state.panelWidthPreference);
  }

  function resetPanelWidth() {
    var panel = state.refs.panel;
    if (!panel) return;
    state.panelWidthPreference = PANEL_DEFAULT_WIDTH;
    applyPanelWidth(panel, PANEL_DEFAULT_WIDTH);
  }

  function setupDockedPanelCoordination(panel) {
    var sidebar = document.getElementById("mdbook-sidebar");
    var sidebarToggle = document.getElementById("mdbook-sidebar-toggle-anchor");
    if (sidebar && "ResizeObserver" in window) {
      state.sidebarResizeObserver = new ResizeObserver(function () {
        applyPanelWidth(panel, state.panelWidthPreference);
      });
      state.sidebarResizeObserver.observe(sidebar);
    }
    if (sidebarToggle) {
      sidebarToggle.addEventListener("change", function () {
        window.requestAnimationFrame(function () {
          applyPanelWidth(panel, state.panelWidthPreference);
        });
      });
    }
  }

  function setupPanelResize(panel, resizer) {
    var drag = null;

    function finishResize(event, persist) {
      if (!drag) return;
      if (
        resizer.releasePointerCapture
        && resizer.hasPointerCapture
        && resizer.hasPointerCapture(drag.pointerId)
      ) {
        resizer.releasePointerCapture(drag.pointerId);
      }
      if (persist) {
        savePanelWidth(applyPanelWidth(
          panel,
          drag.startWidth - (event.clientX - drag.startX)
        ));
      }
      drag = null;
      delete panel.dataset.resizing;
      document.documentElement.classList.remove("lacan-ai-is-resizing");
    }

    resizer.addEventListener("pointerdown", function (event) {
      if (typeof event.button === "number" && event.button !== 0) return;
      if (document.documentElement.classList.contains("sidebar-resizing")) return;
      event.preventDefault();
      event.stopPropagation();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: panel.getBoundingClientRect().width,
      };
      panel.dataset.resizing = "true";
      document.documentElement.classList.add("lacan-ai-is-resizing");
      if (resizer.setPointerCapture) resizer.setPointerCapture(event.pointerId);
    });

    resizer.addEventListener("mousedown", function (event) {
      event.stopPropagation();
    });

    window.addEventListener("pointermove", function (event) {
      if (!drag) return;
      event.preventDefault();
      applyPanelWidth(panel, drag.startWidth - (event.clientX - drag.startX));
    });

    window.addEventListener("pointerup", function (event) {
      finishResize(event, true);
    });

    window.addEventListener("pointercancel", function (event) {
      finishResize(event, false);
    });

    resizer.addEventListener("keydown", function (event) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      var direction = event.key === "ArrowLeft" ? 1 : -1;
      var step = event.shiftKey ? PANEL_KEYBOARD_STEP * 3 : PANEL_KEYBOARD_STEP;
      savePanelWidth(applyPanelWidth(
        panel,
        panel.getBoundingClientRect().width + direction * step
      ));
    });

    window.addEventListener("resize", function () {
      applyPanelWidth(panel, state.panelWidthPreference);
    });
  }

  function setupLauncherDrag(launcher) {
    var drag = null;
    var suppressClick = false;

    launcher.addEventListener("pointerdown", function (event) {
      if (typeof event.button === "number" && event.button !== 0) return;
      var rect = launcher.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top,
        moved: false,
      };
      launcher.dataset.dragging = "true";
      if (launcher.setPointerCapture) launcher.setPointerCapture(event.pointerId);
    });

    window.addEventListener("pointermove", function (event) {
      if (!drag) return;
      var deltaX = event.clientX - drag.startX;
      var deltaY = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return;
      drag.moved = true;
      event.preventDefault();
      applyLauncherPosition(launcher, {
        left: drag.left + deltaX,
        top: drag.top + deltaY,
      });
    });

    window.addEventListener("pointerup", function (event) {
      if (!drag) return;
      if (
        launcher.releasePointerCapture
        && launcher.hasPointerCapture
        && launcher.hasPointerCapture(drag.pointerId)
      ) {
        launcher.releasePointerCapture(drag.pointerId);
      }
      if (drag.moved) {
        suppressClick = true;
        saveLauncherPosition(applyLauncherPosition(launcher, {
          left: drag.left + event.clientX - drag.startX,
          top: drag.top + event.clientY - drag.startY,
        }));
      }
      drag = null;
      delete launcher.dataset.dragging;
    });

    window.addEventListener("pointercancel", function () {
      drag = null;
      delete launcher.dataset.dragging;
    });

    launcher.addEventListener("click", function (event) {
      if (suppressClick) {
        suppressClick = false;
        event.preventDefault();
        return;
      }
      togglePanel();
    });

    window.addEventListener("resize", function () {
      if (!launcher.style.left || !launcher.style.top) return;
      saveLauncherPosition(applyLauncherPosition(launcher, {
        left: parseFloat(launcher.style.left),
        top: parseFloat(launcher.style.top),
      }));
    });
  }

  async function loadIndex() {
    if (state.index) return state.index;
    if (state.indexPromise) return state.indexPromise;
    refreshRootUrl();
    setStatus("正在加载知识库索引……", "loading");
    state.indexPromise = fetch(new URL("ai/knowledge-index.json", rootUrl), {
      credentials: "same-origin",
    })
      .then(function (response) {
        if (!response.ok) throw new Error("知识库索引加载失败（HTTP " + response.status + "）。");
        return response.json();
      })
      .then(function (payload) {
        if (!payload || !Array.isArray(payload.cards)) {
          throw new Error("知识库索引格式不正确。");
        }
        state.index = payload;
        setStatus("知识库已就绪，共 " + payload.cards.length + " 张卡片。", "success");
        selectCardForCurrentPage();
        return payload;
      })
      .catch(function (error) {
        state.indexPromise = null;
        setStatus(error.message, "error");
        throw error;
      });
    return state.indexPromise;
  }

  function openPanel() {
    state.refs.panel.hidden = false;
    document.documentElement.classList.add("lacan-ai-panel-open");
    state.refs.launcher.setAttribute("aria-expanded", "true");
    state.refs.launcher.setAttribute("aria-label", "关闭阅读助手；可拖动调整位置");
    syncFunctionUi();
    if (Core.usesKnowledgeWorkspace(state.refs.skill.value)) state.refs.query.focus();
    else state.refs.question.focus();
  }

  function closePanel() {
    document.documentElement.classList.remove("lacan-ai-panel-open");
    state.refs.panel.hidden = true;
    state.refs.launcher.setAttribute("aria-expanded", "false");
    state.refs.launcher.setAttribute("aria-label", "打开阅读助手；可拖动调整位置");
    state.refs.launcher.focus();
  }

  function togglePanel() {
    state.refs.panel.hidden ? openPanel() : closePanel();
  }

  function nodeElement(node) {
    if (!node) return null;
    return node.nodeType === 1 ? node : node.parentElement;
  }

  function isAssistantTarget(target) {
    var targetElement = nodeElement(target);
    return Boolean(
      targetElement
      && targetElement.closest
      && targetElement.closest(
        ".lacan-ai-panel, .lacan-ai-launcher, .lacan-ai-settings-overlay"
      )
    );
  }

  function collectTranslationReviewContext(selection) {
    if (!selection || selection.rangeCount < 1 || selection.isCollapsed) return null;
    var selectedText = String(selection).trim().slice(0, 12000);
    if (!selectedText || isAssistantTarget(selection.anchorNode) || isAssistantTarget(selection.focusNode)) {
      return null;
    }

    var range = selection.getRangeAt(0);
    var sections = Array.prototype.filter.call(
      document.querySelectorAll(".parallel-paragraph"),
      function (section) {
        try {
          return range.intersectsNode(section);
        } catch (_error) {
          return false;
        }
      }
    );
    var segments = sections.slice(0, 8).map(function (section) {
      var french = Array.prototype.map.call(
        section.querySelectorAll(".original-paragraph"),
        function (paragraph) {
          return String(paragraph.textContent || "").trim();
        }
      ).filter(Boolean).join("\n\n");
      var translationBlock = section.querySelector(".translation-block");
      var translation = translationBlock
        ? String(translationBlock.textContent || "").trim()
        : "";
      var ids = String(section.dataset.paragraphIds || section.id || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .join(", ");
      return {
        id: ids || "未标注分段",
        french: french,
        translation: translation,
      };
    }).filter(function (segment) {
      return segment.french && segment.translation;
    });

    if (!segments.length) return null;
    return { selectedText: selectedText, segments: segments };
  }

  function renderTranslationSelection() {
    if (!state.refs.selectionSummary) return;
    var context = state.translationSelection;
    if (!context) {
      state.refs.selectionSummary.dataset.empty = "true";
      state.refs.selectionSummary.replaceChildren(
        element("strong", "", "尚未选择正文"),
        element("span", "", "请回到左侧正文，用鼠标选中需要核对的中文内容。")
      );
      return;
    }

    delete state.refs.selectionSummary.dataset.empty;
    var segmentIds = context.segments.map(function (segment) {
      return segment.id;
    }).join(" · ");
    var excerpt = context.selectedText.replace(/\s+/g, " ");
    if (excerpt.length > 180) excerpt = excerpt.slice(0, 180) + "…";
    state.refs.selectionSummary.replaceChildren(
      element("strong", "", "已配对 " + context.segments.length + " 个中法分段 · " + segmentIds),
      element("span", "", excerpt)
    );
  }

  function setTranslationReviewContext(context) {
    state.translationSelection = context || null;
    renderTranslationSelection();
    if (!state.refs.skill || state.refs.skill.value !== "translation-review") return;
    if (context) {
      setStatus(
        "已选中 " + context.selectedText.length + " 个字符，并配对 "
          + context.segments.length + " 个中法分段。可补充问题后发送。",
        "success"
      );
    } else {
      setStatus("请先在页面正文中用鼠标选中需要翻译校对的内容。", "info");
    }
  }

  function currentTranslationReviewContext() {
    var current = collectTranslationReviewContext(
      window.getSelection && window.getSelection()
    );
    if (current) setTranslationReviewContext(current);
    return current || state.translationSelection;
  }

  function setupTranslationSelectionTracking() {
    document.addEventListener("selectionchange", function () {
      if (state.selectionCaptureFrame) {
        window.cancelAnimationFrame(state.selectionCaptureFrame);
      }
      state.selectionCaptureFrame = window.requestAnimationFrame(function () {
        state.selectionCaptureFrame = 0;
        var context = collectTranslationReviewContext(
          window.getSelection && window.getSelection()
        );
        if (context) setTranslationReviewContext(context);
      });
    });

    document.addEventListener("pointerdown", function (event) {
      state.selectionPointerStartedInPage = !isAssistantTarget(event.target);
    }, true);

    document.addEventListener("pointerup", function () {
      if (!state.selectionPointerStartedInPage) return;
      state.selectionPointerStartedInPage = false;
      window.requestAnimationFrame(function () {
        setTranslationReviewContext(collectTranslationReviewContext(
          window.getSelection && window.getSelection()
        ));
      });
    }, true);

    document.addEventListener("pointercancel", function () {
      state.selectionPointerStartedInPage = false;
    }, true);
  }

  function syncFunctionUi() {
    var skill = state.refs.skill.value;
    var showKnowledge = Core.usesKnowledgeWorkspace(skill);
    var showTranslationReview = skill === "translation-review";
    state.refs.knowledgeWorkspace.hidden = !showKnowledge;
    state.refs.selectionSummary.hidden = !showTranslationReview;
    if (showKnowledge) {
      state.refs.functionHelp.textContent = "先检索并选中知识卡，再打开卡片或在下方补充问题后解读。";
      state.refs.question.placeholder = "可选：补充你希望重点解读的问题。";
      loadIndex().catch(function () {});
    } else if (showTranslationReview) {
      state.refs.functionHelp.textContent = "使用方法：先在正文中用鼠标选中需要翻译校对的中文，再点击“发送”。助手会自动带入同一分段的法语原文和现有译文，先重译后比较；这里只检查内容与含义，不做单纯文风润色。可在下方输入框补充疑问或需要确认的地方。";
      state.refs.question.placeholder = "可选：写下你对选中文字的疑问，或说明希望重点确认的词句。";
      setTranslationReviewContext(state.translationSelection);
    } else {
      state.refs.functionHelp.textContent = "输入问题后发送；页面问答会优先使用当前选中的文字，否则读取当前分段或页面内容。";
      state.refs.question.placeholder = "输入你对当前页面或选中文字的问题。";
      setStatus("可直接发送；将优先使用页面中选中的文字。", "info");
    }
  }

  function openSettings() {
    var settings = readSettings();
    state.refs.endpoint.value = settings.endpoint;
    state.refs.model.value = settings.model;
    state.refs.apiKey.value = settings.apiKey;
    state.refs.persistKey.checked = settings.persistKey;
    state.refs.settingsMessage.textContent = "";
    state.refs.settingsOverlay.hidden = false;
    state.refs.endpoint.focus();
  }

  function closeSettings() {
    state.refs.settingsOverlay.hidden = true;
    state.refs.settingsButton.focus();
  }

  function handleSaveSettings() {
    try {
      var endpoint = Core.validateEndpoint(state.refs.endpoint.value);
      var settings = {
        endpoint: endpoint,
        model: state.refs.model.value.trim().slice(0, 120),
        apiKey: state.refs.apiKey.value.trim().slice(0, 1000),
        persistKey: state.refs.persistKey.checked,
      };
      if (!settings.model) throw new Error("请填写模型名称。");
      saveSettings(settings);
      closeSettings();
      setStatus(
        settings.persistKey
          ? "接口配置已保存在此浏览器。"
          : "接口地址与模型已保存；API Key 只保留在当前会话。",
        "success"
      );
    } catch (error) {
      state.refs.settingsMessage.textContent = error.message;
    }
  }

  function handleClearSettings() {
    Core.clearLocalConfig(window.localStorage, STORAGE_PREFIX);
    Core.clearLocalConfig(window.sessionStorage, STORAGE_PREFIX);
    resetLauncherPosition();
    resetPanelWidth();
    state.refs.endpoint.value = "https://api.openai.com/v1/chat/completions";
    state.refs.model.value = "";
    state.refs.apiKey.value = "";
    state.refs.persistKey.checked = false;
    state.refs.settingsMessage.textContent = "本网站的本地接口配置、悬浮按钮位置和助手宽度已清空；其他网站数据未受影响。";
    setStatus("浏览器本地接口配置已清空。", "success");
  }

  function renderResults(results) {
    state.refs.results.replaceChildren();
    if (!results.length) {
      state.refs.results.appendChild(element("p", "lacan-ai-empty", "没有找到相关知识卡。"));
      return;
    }
    results.forEach(function (result) {
      var item = button("", "lacan-ai-result");
      item.dataset.cardPath = result.card.path;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(Boolean(
        state.selectedCard && state.selectedCard.path === result.card.path
      )));
      item.addEventListener("click", function () {
        selectCard(result.card);
      });
      var title = element("span", "lacan-ai-result-title", result.card.title);
      var meta = element(
        "span",
        "lacan-ai-result-meta",
        [result.card.verification || "未标注", (result.reasons || []).join(" · ")]
          .filter(Boolean)
          .join(" · ")
      );
      var tags = element("span", "lacan-ai-result-tags", (result.card.tags || []).slice(0, 4).join(" · "));
      item.append(title, meta, tags);
      state.refs.results.appendChild(item);
    });
  }

  async function handleSearch(event) {
    if (event) event.preventDefault();
    var query = state.refs.query.value.trim().slice(0, 300);
    if (!query) {
      setStatus("请先输入关键词、术语、人名或卡片标题。", "error");
      return;
    }
    try {
      var index = await loadIndex();
      var results = Core.searchCards(index.cards, query, 10);
      renderResults(results);
      setStatus("找到 " + results.length + " 个候选；关联理由已显示。", "success");
    } catch (_error) {}
  }

  function currentSegmentId() {
    var selected = window.getSelection && window.getSelection();
    var selectedNode = selected && selected.anchorNode;
    var selectedElement = selectedNode && (selectedNode.nodeType === 1 ? selectedNode : selectedNode.parentElement);
    var selectedSection = selectedElement && selectedElement.closest
      ? selectedElement.closest(".parallel-paragraph")
      : null;
    if (selectedSection && selectedSection.id) return selectedSection.id;

    var hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    var target = hash ? document.getElementById(hash) : null;
    var section = target && target.closest ? target.closest(".parallel-paragraph") : null;
    return section && section.id ? section.id : (target && /^s\d+/i.test(target.id) ? target.id : "");
  }

  async function handleCurrentSegmentSearch() {
    var segmentId = currentSegmentId();
    if (!segmentId) {
      setStatus("请先选中某段文字，或打开带分段锚点的译文位置。", "error");
      return;
    }
    try {
      var index = await loadIndex();
      var cards = Core.findCardsBySegment(index.cards, segmentId);
      var results = cards.slice(0, 12).map(function (card) {
        return { card: card, score: 100, reasons: ["当前段落关联"] };
      });
      renderResults(results);
      setStatus(segmentId + " 关联 " + results.length + " 张知识卡。", "success");
    } catch (_error) {}
  }

  function selectCard(card) {
    state.selectedCard = card;
    Array.prototype.forEach.call(
      state.refs.results.querySelectorAll(".lacan-ai-result"),
      function (item) {
        item.setAttribute("aria-selected", String(item.dataset.cardPath === card.path));
      }
    );
    state.refs.selected.replaceChildren();
    var title = element("strong", "", card.title);
    var meta = element(
      "div",
      "lacan-ai-selected-meta",
      [card.verification, card.verified_at].filter(Boolean).join(" · ")
    );
    var excerpt = element("p", "", String(card.body || "").replace(/\s+/g, " ").slice(0, 280) + "…");
    var link = element("a", "lacan-ai-open-card", "打开此卡片");
    link.href = new URL(card.href, rootUrl).href;
    var explain = button("解读此卡片", "lacan-ai-secondary");
    explain.addEventListener("click", function () {
      state.refs.skill.value = "knowledge";
      syncFunctionUi();
      if (!state.refs.question.value.trim()) {
        state.refs.question.value = "请解释这张知识卡的核心内容、文本依据和理解边界。";
      }
      state.refs.question.focus();
    });
    state.refs.selected.append(title, meta, excerpt, link, explain);
  }

  function selectCardForCurrentPage() {
    if (!state.index) return;
    var path = decodeURIComponent(window.location.pathname);
    var card = state.index.cards.find(function (candidate) {
      return path.endsWith("/" + candidate.href) || path.endsWith(candidate.href);
    });
    if (card) selectCard(card);
  }

  function pageContext() {
    var selected = window.getSelection && String(window.getSelection()).trim();
    if (selected) return selected.slice(0, 12000);
    var segmentId = currentSegmentId();
    var section = segmentId ? document.getElementById(segmentId) : null;
    if (section) return String(section.textContent || "").trim().slice(0, 12000);
    var main = document.querySelector("main") || document.querySelector(".content") || document.body;
    return String(main.textContent || "").trim().slice(0, 12000);
  }

  async function fetchSegment(link) {
    var pageUrl = new URL(link.href, rootUrl);
    pageUrl.hash = "";
    var cacheKey = pageUrl.href;
    var html = state.segmentPageCache.get(cacheKey);
    if (!html) {
      var response = await fetch(pageUrl, { credentials: "same-origin" });
      if (!response.ok) throw new Error("无法读取分段 " + link.id + "。");
      html = await response.text();
      state.segmentPageCache.set(cacheKey, html);
    }
    var parsed = new DOMParser().parseFromString(html, "text/html");
    var section = parsed.getElementById(link.id);
    return {
      id: link.id,
      text: section ? String(section.textContent || "").trim().slice(0, 4000) : "未找到对应分段。",
    };
  }

  async function buildPrompt(skill, reviewContext) {
    var question = state.refs.question.value.trim();
    if (skill === "translation-review") {
      return Core.buildTranslationReviewPrompt({
        question: question,
        selectedText: reviewContext && reviewContext.selectedText,
        segments: reviewContext && reviewContext.segments,
      });
    }
    if (skill === "knowledge") {
      if (!state.selectedCard) throw new Error("请先从检索结果中选择一张知识卡。");
      var segmentLinks = (state.selectedCard.segment_links || []).slice(0, 4);
      var segments = await Promise.all(segmentLinks.map(fetchSegment));
      return Core.buildInterpretationPrompt({
        question: question,
        card: state.selectedCard,
        segments: segments,
      });
    }
    return Core.buildSkillPrompt(skill, {
      question: question,
      context: pageContext(),
    });
  }

  async function callAi(endpoint, model, apiKey, prompt, onUpdate) {
    var startedAt = Date.now();
    var responseStartedAt = 0;
    var partialText = "";
    var diagnostics = {};
    var controller = new AbortController();
    state.activeRequestController = controller;
    state.activeRequestCleared = false;
    var timer = window.setTimeout(function () {
      controller.abort();
    }, Core.REQUEST_TIMEOUT_MS);
    var headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = "Bearer " + apiKey;
    try {
      var response = await fetch(endpoint, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(Core.buildChatRequest(model, prompt)),
        signal: controller.signal,
      });
      responseStartedAt = Date.now();
      diagnostics = {
        httpStatus: response.status,
        firstByteMs: responseStartedAt - startedAt,
        traceId: response.headers.get("x-siliconcloud-trace-id")
          || response.headers.get("x-request-id")
          || response.headers.get("request-id")
          || "",
      };
      if (!response.ok) {
        var httpError = new Error("AI 接口返回 HTTP " + response.status + "。");
        httpError.diagnostics = Object.assign({}, diagnostics, {
          totalMs: Date.now() - startedAt,
        });
        throw httpError;
      }

      if (typeof onUpdate === "function") {
        onUpdate("", Object.assign({}, diagnostics, {
          generationMs: 0,
          totalMs: Date.now() - startedAt,
          streaming: true,
        }), { phase: "connected" });
      }

      var answer = await Core.readChatResponse(response, function (fullText, _delta, streamEvent) {
        partialText = fullText;
        if (typeof onUpdate === "function") {
          onUpdate(fullText, Object.assign({}, diagnostics, {
            generationMs: Date.now() - responseStartedAt,
            totalMs: Date.now() - startedAt,
            streaming: true,
          }), streamEvent);
        }
      });
      var finishedAt = Date.now();
      return {
        answer: answer,
        diagnostics: Object.assign({}, diagnostics, {
          generationMs: finishedAt - responseStartedAt,
          totalMs: finishedAt - startedAt,
        }),
      };
    } catch (error) {
      var endedAt = Date.now();
      var errorDiagnostics = error.diagnostics || Object.assign({}, diagnostics, {
        generationMs: responseStartedAt ? endedAt - responseStartedAt : undefined,
        totalMs: endedAt - startedAt,
      });
      if (error.name === "AbortError") {
        if (state.activeRequestCleared) {
          var clearedError = new Error("当前回答已清空。");
          clearedError.cleared = true;
          throw clearedError;
        }
        var timeoutSeconds = Math.round(Core.REQUEST_TIMEOUT_MS / 1000);
        var timeoutError = new Error("AI 请求在 " + timeoutSeconds + " 秒后超时。");
        timeoutError.partialText = partialText;
        timeoutError.diagnostics = Object.assign({}, errorDiagnostics, {
          partial: Boolean(partialText),
          timedOut: true,
        });
        throw timeoutError;
      }
      if (error instanceof TypeError) {
        var connectionError = new Error("浏览器无法连接该接口；请检查地址、网络和服务端 CORS 设置。");
        connectionError.partialText = partialText;
        connectionError.diagnostics = Object.assign({}, errorDiagnostics, {
          partial: Boolean(partialText),
        });
        throw connectionError;
      }
      error.partialText = error.partialText || partialText;
      error.diagnostics = errorDiagnostics;
      throw error;
    } finally {
      window.clearTimeout(timer);
      if (state.activeRequestController === controller) {
        state.activeRequestController = null;
      }
      updateOutputNavigationState();
    }
  }

  async function handleRunAi() {
    var skill = state.refs.skill.value;
    var reviewContext = skill === "translation-review"
      ? currentTranslationReviewContext()
      : null;
    if (skill === "translation-review" && !reviewContext) {
      setStatus(
        "请先在页面正文中用鼠标选中需要翻译校对的内容，然后点击“发送”。",
        "error"
      );
      setOutput(
        "尚未发送请求。选中正文后，可在下方输入框补充疑问或需要确认的地方。",
        "error"
      );
      setDiagnostics("前端已拦截：未发现有效正文选区，未连接 AI 接口。");
      return;
    }

    var settings = readSettings();
    try {
      settings.endpoint = Core.validateEndpoint(settings.endpoint);
      if (!settings.model) {
        openSettings();
        throw new Error("请先配置模型名称。");
      }
      state.outputAutoFollow = true;
      window.cancelAnimationFrame(state.requestAutoFollowReleaseFrame);
      state.requestAutoFollowReleaseFrame = 0;
      state.requestAutoFollowActive = true;
      state.activeRequestCleared = false;
      state.refs.run.disabled = true;
      state.refs.output.setAttribute("aria-busy", "true");
      cancelScheduledStreamingOutput();
      setOutput("正在准备上下文并调用 AI……", "loading");
      setDiagnostics("正在建立连接；最长等待 180 秒，回答将流式显示。");
      var prompt = await buildPrompt(skill, reviewContext);
      var result = await callAi(
        settings.endpoint,
        settings.model,
        settings.apiKey,
        prompt,
        function (partialText, liveDiagnostics, streamEvent) {
          setDiagnostics(liveDiagnostics);
          if (streamEvent.phase === "connected") {
            setOutput("接口已连接，正在等待流式正文……", "loading");
            setStatus("AI 接口已连接。", "loading");
          } else if (streamEvent.phase === "reasoning") {
            setStatus("AI 正在准备回答……", "loading");
          } else if (partialText) {
            scheduleStreamingOutput(partialText);
            setStatus("AI 正在流式生成回答……", "loading");
          }
        }
      );
      cancelScheduledStreamingOutput();
      setOutput(result.answer, "answer");
      setDiagnostics(result.diagnostics);
      setStatus("回答已返回，并按 Markdown 渲染；复制按钮保留原始 Markdown。", "success");
    } catch (error) {
      cancelScheduledStreamingOutput();
      if (error.cleared) {
        setStatus("当前回答已清空，生成已停止。", "info");
        setDiagnostics("当前生成已由用户清空并停止。");
        return;
      }
      if (error.partialText) {
        setOutput(
          error.partialText + "\n\n[请求未完整结束；已保留已经返回的部分内容。]",
          "partial"
        );
        setStatus("AI 请求未完整结束，已保留部分结果。", "error");
      } else {
        setOutput(error.message, "error");
        setStatus("AI 调用失败，详情见回答区。", "error");
      }
      setDiagnostics(error.diagnostics || "未取得接口诊断信息。");
    } finally {
      releaseRequestAutoFollow();
      state.activeRequestCleared = false;
      state.refs.run.disabled = false;
      state.refs.output.setAttribute("aria-busy", "false");
      updateOutputNavigationState();
    }
  }

  function createSettingsDialog() {
    var overlay = element("div", "lacan-ai-settings-overlay");
    overlay.hidden = true;
    var dialog = element("form", "lacan-ai-settings");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "lacan-ai-settings-title");

    var title = element("h2", "", "OpenAI 接口配置");
    title.id = "lacan-ai-settings-title";
    var endpoint = element("input", "lacan-ai-input");
    endpoint.type = "url";
    endpoint.autocomplete = "url";
    var model = element("input", "lacan-ai-input");
    model.type = "text";
    model.placeholder = "填写接口支持的模型名称";
    var apiKey = element("input", "lacan-ai-input");
    apiKey.type = "password";
    apiKey.autocomplete = "off";
    var persistKey = element("input", "");
    persistKey.type = "checkbox";

    var persistLabel = element("label", "lacan-ai-check");
    persistLabel.append(persistKey, document.createTextNode("在此浏览器持久保存 API Key（同源脚本可能读取）"));
    var notice = element(
      "p",
      "lacan-ai-settings-notice",
      "本页面不会将您的 API Key 保存到任何外部服务；它仅保存在您本地的浏览器缓存中，并只在调用时发送到您填写的 OpenAI 兼容接口。"
    );
    var message = element("p", "lacan-ai-settings-message", "");
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    var actions = element("div", "lacan-ai-actions");
    var save = button("保存配置", "lacan-ai-primary");
    save.type = "submit";
    var clear = button("清空浏览器本地配置", "lacan-ai-danger");
    var close = button("取消", "lacan-ai-secondary");
    dialog.addEventListener("submit", function (event) {
      event.preventDefault();
      handleSaveSettings();
    });
    clear.addEventListener("click", handleClearSettings);
    close.addEventListener("click", closeSettings);
    actions.append(save, clear, close);

    dialog.append(
      title,
      element("label", "lacan-ai-label", "接口地址"),
      endpoint,
      element("label", "lacan-ai-label", "模型名称"),
      model,
      element("label", "lacan-ai-label", "API Key（本地接口可留空）"),
      apiKey,
      persistLabel,
      notice,
      message,
      actions
    );
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    state.refs.settingsOverlay = overlay;
    state.refs.endpoint = endpoint;
    state.refs.model = model;
    state.refs.apiKey = apiKey;
    state.refs.persistKey = persistKey;
    state.refs.settingsMessage = message;
  }

  function createPanel() {
    var launcher = button("AI", "lacan-ai-launcher");
    launcher.setAttribute("aria-controls", "lacan-ai-panel");
    launcher.setAttribute("aria-expanded", "false");
    launcher.setAttribute("aria-label", "打开阅读助手；可拖动调整位置");
    launcher.title = "阅读助手（可拖动）";
    setupLauncherDrag(launcher);

    var panel = element("aside", "lacan-ai-panel");
    panel.id = "lacan-ai-panel";
    panel.hidden = true;
    panel.setAttribute("aria-label", "阅读助手");
    var resizer = element("div", "lacan-ai-resizer");
    resizer.tabIndex = 0;
    resizer.setAttribute("role", "separator");
    resizer.setAttribute("aria-orientation", "vertical");
    resizer.setAttribute("aria-label", "调整阅读助手宽度");
    resizer.title = "拖动调整宽度；也可使用左右方向键";
    setupPanelResize(panel, resizer);

    var header = element("header", "lacan-ai-header");
    var heading = element("h2", "", "阅读助手");
    var headerActions = element("div", "lacan-ai-header-actions");
    var settingsButton = button("OpenAI 接口配置", "lacan-ai-secondary");
    var close = button("关闭", "lacan-ai-close");
    settingsButton.addEventListener("click", openSettings);
    close.addEventListener("click", closePanel);
    headerActions.append(settingsButton, close);
    header.append(heading, headerActions);

    var body = element("div", "lacan-ai-body");
    var functionTitle = element("h3", "", "功能");
    var skill = element("select", "lacan-ai-input");
    skill.setAttribute("aria-label", "功能");
    [
      ["translation-review", "翻译校对"],
      ["page-qa", "页面问答"],
      ["knowledge", "知识库解读"],
    ].forEach(function (entry) {
      var option = element("option", "", entry[1]);
      option.value = entry[0];
      skill.appendChild(option);
    });
    skill.addEventListener("change", syncFunctionUi);

    var functionHelp = element(
      "p",
      "lacan-ai-function-help",
      "使用方法：先在正文中用鼠标选中需要翻译校对的中文，再点击“发送”。助手会自动带入同一分段的法语原文和现有译文，先重译后比较；这里只检查内容与含义，不做单纯文风润色。可在下方输入框补充疑问或需要确认的地方。"
    );
    var selectionSummary = element("section", "lacan-ai-selection-summary");
    selectionSummary.setAttribute("aria-label", "当前翻译校对选区");
    selectionSummary.setAttribute("aria-live", "polite");

    var knowledgeWorkspace = element("section", "lacan-ai-knowledge-workspace");
    knowledgeWorkspace.hidden = true;
    var searchTitle = element("h3", "", "知识库检索");
    var searchForm = element("form", "lacan-ai-search");
    var query = element("input", "lacan-ai-input");
    query.type = "search";
    query.placeholder = "术语、人物、作品或知识卡标题";
    query.maxLength = 300;
    query.setAttribute("aria-label", "知识库检索关键词");
    var searchButton = button("检索", "lacan-ai-primary");
    searchButton.type = "submit";
    searchForm.append(query, searchButton);
    searchForm.addEventListener("submit", handleSearch);
    var current = button("查当前段落关联", "lacan-ai-secondary lacan-ai-wide");
    current.addEventListener("click", handleCurrentSegmentSearch);
    var results = element("div", "lacan-ai-results");
    results.setAttribute("role", "listbox");
    results.setAttribute("aria-label", "知识库检索结果");
    var selected = element("section", "lacan-ai-selected", "尚未选择知识卡。" );
    selected.setAttribute("aria-live", "polite");
    knowledgeWorkspace.append(searchTitle, searchForm, current, results, selected);

    var question = element("textarea", "lacan-ai-input lacan-ai-question");
    question.rows = 4;
    question.maxLength = 1200;
    question.placeholder = "可选：写下你对选中文字的疑问，或说明希望重点确认的词句。";
    question.setAttribute("aria-label", "问题或具体要求");
    var run = button("发送", "lacan-ai-primary lacan-ai-wide");
    run.addEventListener("click", handleRunAi);
    var status = element("p", "lacan-ai-status", "请先在页面正文中用鼠标选中需要翻译校对的内容。" );
    status.setAttribute("role", "status");
    var disclosure = element(
      "p",
      "lacan-ai-disclosure",
      "发送时，翻译校对会把选中文字、对应法语原文和现有译文，由浏览器直接发送到你配置的接口；知识库解读会发送知识卡及最多四个关联分段。默认最多生成 1600 tokens；浏览器最多接收 "
        + Math.round(Core.MAX_RESPONSE_BYTES / 1024 / 1024)
        + " MiB 响应并保留 "
        + Core.MAX_OUTPUT_CHARS
        + " 个字符，超限会自动停止。"
    );
    var diagnostics = element(
      "p",
      "lacan-ai-diagnostics",
      "诊断信息将在调用后显示。"
    );
    diagnostics.setAttribute("aria-live", "polite");
    var outputShell = element("section", "lacan-ai-output-shell");
    outputShell.setAttribute("aria-label", "AI 回答");
    var outputToolbar = element("div", "lacan-ai-output-toolbar");
    var outputLabel = element("span", "lacan-ai-output-label", "Markdown 渲染");
    var copyTools = element("div", "lacan-ai-copy-tools");
    var copyFeedback = element("span", "lacan-ai-copy-feedback", "");
    copyFeedback.setAttribute("role", "status");
    copyFeedback.setAttribute("aria-live", "polite");
    var copyButton = button("复制 Markdown", "lacan-ai-copy");
    copyButton.setAttribute("aria-label", "复制 Markdown 原文");
    copyButton.disabled = true;
    copyButton.addEventListener("pointerdown", function (event) {
      event.preventDefault();
    });
    copyButton.addEventListener("click", handleCopyOutput);
    copyTools.append(copyFeedback, copyButton);
    outputToolbar.append(outputLabel, copyTools);
    var output = element("article", "lacan-ai-output");
    output.id = "lacan-ai-output-content";
    output.setAttribute("aria-live", "polite");
    outputShell.append(outputToolbar, output);

    var outputNav = element("nav", "lacan-ai-output-nav");
    outputNav.setAttribute("aria-label", "回答区快捷导航");
    var outputTop = button("↑", "lacan-ai-output-nav-button");
    outputTop.setAttribute("aria-label", "滚动到阅读助手顶部");
    outputTop.setAttribute("title", "滚动到顶部");
    outputTop.setAttribute("aria-controls", output.id);
    outputTop.addEventListener("click", handleOutputTop);
    var outputBottom = button("↓", "lacan-ai-output-nav-button");
    outputBottom.setAttribute("aria-label", "滚动到阅读助手底部");
    outputBottom.setAttribute("title", "滚动到最新内容");
    outputBottom.setAttribute("aria-controls", output.id);
    outputBottom.addEventListener("click", handleOutputBottom);
    var outputClear = button("清", "lacan-ai-output-nav-button lacan-ai-output-nav-clear");
    outputClear.setAttribute("aria-label", "清空当前回答");
    outputClear.setAttribute("title", "清空当前回答；生成中点击会停止生成");
    outputClear.setAttribute("aria-controls", output.id);
    outputClear.addEventListener("click", handleClearOutput);
    outputNav.append(outputTop, outputBottom, outputClear);

    body.append(
      functionTitle,
      skill,
      functionHelp,
      selectionSummary,
      knowledgeWorkspace,
      question,
      run,
      status,
      disclosure,
      diagnostics,
      outputShell
    );
    panel.append(resizer, header, body, outputNav);
    document.body.append(launcher, panel);

    state.refs.launcher = launcher;
    state.refs.panel = panel;
    state.refs.resizer = resizer;
    state.refs.settingsButton = settingsButton;
    state.refs.functionHelp = functionHelp;
    state.refs.selectionSummary = selectionSummary;
    state.refs.knowledgeWorkspace = knowledgeWorkspace;
    state.refs.query = query;
    state.refs.status = status;
    state.refs.results = results;
    state.refs.selected = selected;
    state.refs.skill = skill;
    state.refs.question = question;
    state.refs.run = run;
    state.refs.body = body;
    state.refs.diagnostics = diagnostics;
    state.refs.copyButton = copyButton;
    state.refs.copyFeedback = copyFeedback;
    state.refs.outputShell = outputShell;
    state.refs.output = output;
    state.refs.outputNav = outputNav;
    state.refs.outputTop = outputTop;
    state.refs.outputBottom = outputBottom;
    state.refs.outputClear = outputClear;
    setupOutputNavigation(body);
    setOutput("返回内容将在这里显示。", "placeholder");
    rememberOutputScrollSnapshot();
    renderTranslationSelection();
    setupDockedPanelCoordination(panel);
    syncFunctionUi();
    restoreLauncherPosition(launcher);
    restorePanelWidth(panel);
  }

  function init() {
    createPanel();
    createSettingsDialog();
    setupTranslationSelectionTracking();
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      if (!state.refs.settingsOverlay.hidden) closeSettings();
      else if (!state.refs.panel.hidden) closePanel();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
