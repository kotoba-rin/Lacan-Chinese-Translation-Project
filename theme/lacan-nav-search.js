(function () {
  "use strict";

  var Core = window.LacanNavSearchCore;
  if (!Core) return;

  var state = {
    index: null,
    indexPromise: null,
    refs: null,
    previousFocus: null,
  };

  var kindLabels = {
    segment: "段落",
    seminar: "研讨班",
    "knowledge-index": "知识库",
    knowledge: "知识卡",
    lesson: "课程",
    glossary: "术语表",
    "notes-index": "阅读笔记",
    note: "笔记",
    home: "首页",
    page: "页面",
  };

  function rootPath() {
    return typeof path_to_root === "string" ? path_to_root : "";
  }

  function element(tag, className, textContent) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (textContent !== undefined) node.textContent = textContent;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function loadIndex() {
    if (state.index) return Promise.resolve(state.index);
    if (state.indexPromise) return state.indexPromise;

    state.indexPromise = fetch(rootPath() + "navigation-index.json")
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (index) {
        if (!index || !Array.isArray(index.entries) || !index.seminars) {
          throw new Error("导航索引格式无效");
        }
        state.index = index;
        return index;
      })
      .catch(function (error) {
        state.indexPromise = null;
        throw error;
      });
    return state.indexPromise;
  }

  function renderResults(results, query) {
    var refs = state.refs;
    clear(refs.results);

    if (!results.length) {
      refs.status.textContent = "没有找到标题匹配项。这里不检索正文。";
      return;
    }

    refs.status.textContent = results[0].direct
      ? "识别为段落 ID，可直接跳转。"
      : "找到 " + results.length + " 个导航结果。";

    results.forEach(function (entry) {
      var item = element("li", "lacan-nav-result");
      var link = element("a", "lacan-nav-result-link");
      link.href = rootPath() + entry.href;

      var title = element("span", "lacan-nav-result-title", entry.title);
      var meta = element("span", "lacan-nav-result-meta");
      var kind = element(
        "span",
        "lacan-nav-result-kind",
        kindLabels[entry.kind] || kindLabels.page
      );
      meta.appendChild(kind);
      if (entry.context) {
        meta.appendChild(document.createTextNode(" · " + entry.context));
      }

      link.appendChild(title);
      link.appendChild(meta);
      item.appendChild(link);
      refs.results.appendChild(item);
    });

    refs.results.setAttribute("aria-label", "“" + query + "”的导航结果");
  }

  function runSearch() {
    var refs = state.refs;
    var query = refs.input.value.trim();
    clear(refs.results);

    if (!query) {
      refs.status.textContent = "输入标题、知识卡、课程编号，或 s14-07-0097 这类段落 ID。";
      return;
    }

    refs.status.textContent = "正在载入小型导航目录…";
    loadIndex()
      .then(function (index) {
        if (refs.input.value.trim() !== query) return;
        renderResults(Core.searchEntries(index, query, 20), query);
      })
      .catch(function () {
        if (refs.input.value.trim() !== query) return;
        refs.status.textContent = "导航目录载入失败，请刷新页面后重试。";
      });
  }

  function close() {
    if (!state.refs || state.refs.overlay.hidden) return;
    state.refs.overlay.hidden = true;
    document.documentElement.classList.remove("lacan-nav-open");
    if (state.previousFocus && typeof state.previousFocus.focus === "function") {
      state.previousFocus.focus();
    }
  }

  function open(query) {
    ensureUi();
    state.previousFocus = document.activeElement;
    state.refs.overlay.hidden = false;
    document.documentElement.classList.add("lacan-nav-open");
    state.refs.input.value = query === undefined || query === null ? "" : String(query);
    runSearch();
    window.setTimeout(function () {
      state.refs.input.focus();
      state.refs.input.select();
    }, 0);
  }

  function createMenuButton() {
    if (document.getElementById("lacan-nav-search-toggle")) return;
    var leftButtons = document.querySelector("#mdbook-menu-bar .left-buttons");
    if (!leftButtons) return;

    var button = element("button", "icon-button lacan-nav-menu-button");
    button.id = "lacan-nav-search-toggle";
    button.type = "button";
    button.title = "导航搜索（/）";
    button.setAttribute("aria-label", "打开导航搜索");
    button.setAttribute("aria-keyshortcuts", "/");
    button.setAttribute("aria-haspopup", "dialog");
    var glyph = element("span", "lacan-nav-menu-glyph", "搜");
    glyph.setAttribute("aria-hidden", "true");
    button.appendChild(glyph);
    button.addEventListener("click", function () { open(""); });
    leftButtons.appendChild(button);
  }

  function createDialog() {
    var overlay = element("div", "lacan-nav-overlay");
    overlay.hidden = true;

    var dialog = element("section", "lacan-nav-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "lacan-nav-title");

    var header = element("header", "lacan-nav-header");
    var heading = element("h2", "", "导航搜索");
    heading.id = "lacan-nav-title";
    var closeButton = element("button", "lacan-nav-close", "×");
    closeButton.type = "button";
    closeButton.title = "关闭";
    closeButton.setAttribute("aria-label", "关闭导航搜索");
    header.appendChild(heading);
    header.appendChild(closeButton);

    var form = element("form", "lacan-nav-form");
    form.setAttribute("role", "search");
    var input = element("input", "lacan-nav-input");
    input.type = "search";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "搜索标题、知识卡、课程或段落 ID";
    input.setAttribute("aria-label", "搜索标题、知识卡、课程或段落 ID");
    input.setAttribute("aria-describedby", "lacan-nav-help lacan-nav-status");
    var submit = element("button", "lacan-nav-submit", "搜索");
    submit.type = "submit";
    form.appendChild(input);
    form.appendChild(submit);

    var help = element(
      "p",
      "lacan-nav-help",
      "仅检索页面标题与知识卡标签；段落 ID 直接定位，不加载全文索引。"
    );
    help.id = "lacan-nav-help";
    var status = element("p", "lacan-nav-status");
    status.id = "lacan-nav-status";
    status.setAttribute("aria-live", "polite");
    var results = element("ul", "lacan-nav-results");

    dialog.appendChild(header);
    dialog.appendChild(form);
    dialog.appendChild(help);
    dialog.appendChild(status);
    dialog.appendChild(results);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    input.addEventListener("input", runSearch);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      runSearch();
    });
    closeButton.addEventListener("click", close);
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) close();
    });

    return {
      overlay: overlay,
      dialog: dialog,
      input: input,
      status: status,
      results: results,
    };
  }

  function ensureUi() {
    if (!state.refs) state.refs = createDialog();
    createMenuButton();
  }

  function isEditableTarget(target) {
    if (!target || !target.tagName) return false;
    return /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable;
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && state.refs && !state.refs.overlay.hidden) {
      event.preventDefault();
      close();
      return;
    }
    if (
      event.key === "/" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !isEditableTarget(event.target)
    ) {
      event.preventDefault();
      open("");
    }
  });

  window.LacanNavigationSearch = {
    open: open,
    close: close,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureUi);
  } else {
    ensureUi();
  }
})();
