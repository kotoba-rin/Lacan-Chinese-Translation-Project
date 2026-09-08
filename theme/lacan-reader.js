(function () {
  "use strict";

  function element(tag, className, text) {
    var node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function enhanceReader() {
    var main = document.querySelector(".content main");
    var sidebar = document.getElementById("mdbook-sidebar");
    if (!main || !sidebar || document.querySelector(".lacan-sidebar-brand")) return;

    var root = typeof path_to_root === "string" ? path_to_root : "";
    var homeUrl = new URL(root + "index.html", window.location.href);
    var currentUrl = new URL(window.location.href);
    var isHome = currentUrl.pathname === homeUrl.pathname ||
      currentUrl.pathname === homeUrl.pathname.replace(/index\.html$/, "");
    var active = sidebar.querySelector("a.active");

    var brand = element("div", "lacan-sidebar-brand");
    var home = element("a", "lacan-brand-link");
    home.href = homeUrl.href;
    home.setAttribute("aria-label", "拉康中文开放翻译计划 · 首页");
    home.appendChild(element("span", "lacan-brand-wordmark", "LACAN"));
    home.appendChild(element("span", "lacan-brand-title", "中文开放翻译计划"));
    brand.appendChild(home);
    var search = element("button", "lacan-sidebar-search", "搜索目录与知识卡");
    search.type = "button";
    search.setAttribute("aria-label", "搜索目录、知识卡或段落 ID");
    search.appendChild(element("kbd", "lacan-search-key", "/"));
    search.addEventListener("click", function () {
      if (window.LacanNavigationSearch) window.LacanNavigationSearch.open("");
    });
    brand.appendChild(search);
    brand.appendChild(element("div", "lacan-sidebar-caption", "研讨班 / 术语 / 阅读笔记"));
    sidebar.prepend(brand);
    sidebar.classList.add("lacan-branded-sidebar");
    sidebar.setAttribute("aria-label", "全书目录");

    // Use the actual parent entry, including nested notes and alternate site roots.
    var contextLink = active;
    var item = active && active.closest("li.chapter-item");
    while (item) {
      var parentItem = item.parentElement.closest("li.chapter-item");
      if (!parentItem) break;
      var parentLink = parentItem.querySelector(":scope > .chapter-link-wrapper > a[href]");
      if (parentLink) contextLink = parentLink;
      item = parentItem;
    }

    var heading = main.querySelector("h1");
    if (heading) {
      var kicker = element("div", "lacan-page-kicker");
      var context = element(contextLink && !isHome ? "a" : "span", "lacan-page-context",
        isHome ? "JACQUES LACAN · 文本与研读" :
          contextLink ? contextLink.textContent.trim() : "拉康中文开放翻译计划");
      if (context.tagName === "A") context.href = contextLink.href;
      kicker.appendChild(context);
      heading.before(kicker);
      var title = heading.querySelector("a.header") || heading;
      var lesson = title.textContent.match(/^(Leçon\s+\d+)\s*\|\s*(.+)$/i);
      if (lesson) {
        title.replaceChildren(element("span", "lacan-lesson-number", lesson[1]),
          element("span", "lacan-title-separator", " | "),
          element("span", "lacan-lesson-date", lesson[2]));
      }

      if (isHome) {
        main.classList.add("lacan-home");
        title.textContent = "拉康中文开放翻译计划";
        var subtitle = heading.nextElementSibling;
        if (subtitle && subtitle.textContent.trim() === title.textContent) {
          subtitle.classList.add("lacan-home-subtitle");
        }
        var actions = element("nav", "lacan-home-actions");
        actions.setAttribute("aria-label", "开始阅读");
        var links = Array.from(sidebar.querySelectorAll("a[href]"));
        var firstSeminar = links.find(function (link) { return /^S1[：:]/.test(link.textContent); });
        var knowledge = links.find(function (link) { return link.textContent.trim() === "知识库"; });
        [[firstSeminar, "阅读研讨班 I", "lacan-home-primary"],
          [knowledge, "浏览知识库", "lacan-home-secondary"]].forEach(function (entry) {
          if (!entry[0]) return;
          var link = element("a", entry[2], entry[1]);
          link.href = entry[0].href;
          actions.appendChild(link);
        });
        if (actions.childElementCount) {
          var introduction = subtitle && subtitle.classList.contains("lacan-home-subtitle")
            ? subtitle.nextElementSibling : subtitle;
          (introduction || heading).after(actions);
        }
      }
    }

    var labels = {
      "mdbook-sidebar-toggle": "展开或收起目录",
      "mdbook-theme-toggle": "切换浅色或暗色主题",
      "mdbook-theme-list": "阅读主题",
    };
    Object.keys(labels).forEach(function (id) {
      var node = document.getElementById(id);
      if (node) {
        node.setAttribute("aria-label", labels[id]);
        node.title = labels[id];
      }
    });
    var controls = main.querySelector(".reading-controls");
    if (controls) controls.setAttribute("aria-label", "阅读设置");

    var scrollbox = sidebar.querySelector(".sidebar-scrollbox");
    if (active && scrollbox) {
      var activeBox = active.getBoundingClientRect();
      var scrollBox = scrollbox.getBoundingClientRect();
      if (activeBox.top < scrollBox.top || activeBox.bottom > scrollBox.bottom) {
        scrollbox.scrollTop += activeBox.top - scrollBox.top - scrollBox.height / 2;
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", enhanceReader);
  } else {
    enhanceReader();
  }
})();
