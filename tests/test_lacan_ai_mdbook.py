import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class LacanAiMdBookConfigTest(unittest.TestCase):
    def test_loads_ai_assets_in_dependency_order(self):
        config = (ROOT / "book.toml").read_text(encoding="utf-8")
        html_section = re.search(
            r"(?ms)^\[output\.html\]\s*$\n(.*?)(?=^\[|\Z)",
            config,
        )

        self.assertIsNotNone(html_section)
        section = html_section.group(1)
        self.assertIn('"theme/lacan-ai.css"', section)
        self.assertRegex(
            section,
            r'additional-js\s*=\s*\[.*"theme/lacan-ai-core\.js".*"theme/lacan-ai\.js".*\]',
        )

    def test_ai_panel_includes_required_mvp_controls(self):
        script = (ROOT / "theme" / "lacan-ai.js").read_text(encoding="utf-8")
        styles = (ROOT / "theme" / "lacan-ai.css").read_text(encoding="utf-8")

        for label in (
            "知识库检索",
            "知识库解读",
            "页面问答",
            "翻译校对",
            "清空浏览器本地配置",
        ):
            self.assertIn(label, script)

        self.assertIn('["translation-review", "翻译校对"]', script)
        self.assertNotIn('["translation", "翻译"]', script)
        self.assertNotIn('["proofreading", "校对"]', script)

        self.assertIn("lacan-ai:settings", script)
        self.assertIn("lacan-ai:key", script)
        self.assertNotIn("localStorage.clear", script)
        self.assertIn("aria-modal", script)
        self.assertIn('element("form", "lacan-ai-settings")', script)
        self.assertIn("@media (max-width: 720px)", styles)

    def test_panel_copy_and_function_specific_workspace(self):
        script = (ROOT / "theme" / "lacan-ai.js").read_text(encoding="utf-8")

        self.assertIn('element("h2", "", "阅读助手")', script)
        self.assertIn('element("h3", "", "功能")', script)
        self.assertIn('button("发送", "lacan-ai-primary lacan-ai-wide")', script)
        self.assertIn('button("OpenAI 接口配置", "lacan-ai-secondary")', script)
        self.assertIn('element("h2", "", "OpenAI 接口配置")', script)
        self.assertIn("打开此卡片", script)
        self.assertIn("解读此卡片", script)
        self.assertIn("本页面不会将您的 API Key 保存到任何外部服务", script)
        self.assertIn('"lacan-ai-settings-notice"', script)
        self.assertIn('element("p", "lacan-ai-settings-message", "")', script)
        self.assertIn("knowledgeWorkspace.hidden = !showKnowledge", script)
        self.assertIn('skill.addEventListener("change", syncFunctionUi)', script)
        self.assertIn("先在正文中用鼠标选中需要翻译校对的中文", script)
        self.assertIn("这里只检查内容与含义，不做单纯文风润色", script)
        self.assertIn("可在下方输入框补充疑问或需要确认的地方", script)
        self.assertNotIn("预制 AI 能力", script)
        self.assertNotIn('button("调用 AI"', script)
        self.assertNotIn('"AI 阅读助手"', script)

    def test_translation_review_pairs_selected_text_with_french_and_current_translation(self):
        script = (ROOT / "theme" / "lacan-ai.js").read_text(encoding="utf-8")
        core = (ROOT / "theme" / "lacan-ai-core.js").read_text(encoding="utf-8")
        styles = (ROOT / "theme" / "lacan-ai.css").read_text(encoding="utf-8")

        self.assertIn("function collectTranslationReviewContext(selection)", script)
        self.assertIn('document.querySelectorAll(".parallel-paragraph")', script)
        self.assertIn("range.intersectsNode(section)", script)
        self.assertIn('section.querySelectorAll(".original-paragraph")', script)
        self.assertIn('section.querySelector(".translation-block")', script)
        self.assertIn("section.dataset.paragraphIds", script)
        self.assertIn("state.translationSelection", script)
        self.assertIn("Core.buildTranslationReviewPrompt", script)
        self.assertIn("function buildTranslationReviewPrompt(input)", core)
        self.assertIn("lacan-ai-selection-summary", script)
        self.assertIn(".lacan-ai-selection-summary", styles)

    def test_translation_review_without_selection_is_blocked_before_settings_or_fetch(self):
        script = (ROOT / "theme" / "lacan-ai.js").read_text(encoding="utf-8")
        start = script.index("async function handleRunAi()")
        end = script.index("\n  function createSettingsDialog()", start)
        handler = script[start:end]

        self.assertIn('skill === "translation-review" && !reviewContext', handler)
        self.assertIn("请先在页面正文中用鼠标选中需要翻译校对的内容", handler)
        self.assertIn("未连接 AI 接口", handler)
        self.assertLess(
            handler.index('skill === "translation-review" && !reviewContext'),
            handler.index("var settings = readSettings()"),
        )
        self.assertLess(
            handler.index("var settings = readSettings()"),
            handler.index("await callAi("),
        )

    def test_search_results_are_selectable_and_launcher_is_draggable(self):
        script = (ROOT / "theme" / "lacan-ai.js").read_text(encoding="utf-8")
        styles = (ROOT / "theme" / "lacan-ai.css").read_text(encoding="utf-8")

        self.assertIn('var item = button("", "lacan-ai-result")', script)
        self.assertIn('item.setAttribute("aria-selected"', script)
        self.assertIn("LAUNCHER_POSITION_KEY", script)
        self.assertIn('launcher.addEventListener("pointerdown"', script)
        self.assertIn('window.addEventListener("pointermove"', script)
        self.assertIn('window.addEventListener("pointerup"', script)
        self.assertNotIn("event.pointerId !== drag.pointerId", script)
        self.assertIn("saveLauncherPosition", script)
        self.assertRegex(styles, r"\.lacan-ai-launcher\s*\{[^}]*touch-action:\s*none;")
        self.assertRegex(styles, r"\.lacan-ai-launcher\s*\{[^}]*cursor:\s*grab;")
        self.assertRegex(styles, r"\.lacan-ai-results\s*\{[^}]*overflow-x:\s*hidden;")

    def test_launcher_toggles_panel_and_panel_width_is_resizable(self):
        script = (ROOT / "theme" / "lacan-ai.js").read_text(encoding="utf-8")
        styles = (ROOT / "theme" / "lacan-ai.css").read_text(encoding="utf-8")

        self.assertIn("function togglePanel()", script)
        self.assertIn("state.refs.panel.hidden ? openPanel() : closePanel()", script)
        self.assertIn("togglePanel();", script)
        self.assertIn("PANEL_WIDTH_KEY", script)
        self.assertIn("function setupPanelResize(panel, resizer)", script)
        self.assertIn('element("div", "lacan-ai-resizer")', script)
        self.assertIn('resizer.setAttribute("role", "separator")', script)
        self.assertIn("savePanelWidth", script)
        self.assertIn("restorePanelWidth", script)
        self.assertIn("resetPanelWidth", script)
        self.assertRegex(
            styles,
            r"\.lacan-ai-resizer\s*\{[^}]*cursor:\s*col-resize;[^}]*touch-action:\s*none;",
        )
        self.assertRegex(
            styles,
            r"@media \(max-width: 720px\)[\s\S]*\.lacan-ai-resizer\s*\{[^}]*display:\s*none;",
        )

    def test_reading_feedback_type_scales_with_panel_width(self):
        styles = (ROOT / "theme" / "lacan-ai.css").read_text(encoding="utf-8")

        self.assertRegex(
            styles,
            r"\.lacan-ai-panel\s*\{[^}]*container-type:\s*inline-size;",
        )
        self.assertIn(
            "font-size: clamp(15px, 12px + 0.7cqi, 18px);",
            styles,
        )
        self.assertRegex(
            styles,
            r"\.lacan-ai-output\s*\{[^}]*font-size:\s*clamp\(17px, 12px \+ 0\.9cqi, 21px\);",
        )

    def test_panel_scroll_area_reserves_space_below_the_last_line(self):
        styles = (ROOT / "theme" / "lacan-ai.css").read_text(encoding="utf-8")

        self.assertRegex(
            styles,
            r"\.lacan-ai-body\s*\{[^}]*box-sizing:\s*border-box;",
        )
        self.assertIn(
            "padding-bottom: calc(5rem + env(safe-area-inset-bottom, 0px));",
            styles,
        )
        self.assertIn(
            "scroll-padding-bottom: calc(5rem + env(safe-area-inset-bottom, 0px));",
            styles,
        )

    def test_right_panel_docks_content_and_isolates_both_resize_handles(self):
        script = (ROOT / "theme" / "lacan-ai.js").read_text(encoding="utf-8")
        styles = (ROOT / "theme" / "lacan-ai.css").read_text(encoding="utf-8")

        self.assertIn('document.documentElement.classList.add("lacan-ai-panel-open")', script)
        self.assertIn('document.documentElement.classList.remove("lacan-ai-panel-open")', script)
        self.assertIn('"--lacan-ai-docked-width"', script)
        self.assertIn('document.querySelector(".page-wrapper")', script)
        self.assertIn('document.getElementById("mdbook-sidebar")', script)
        self.assertIn("ResizeObserver", script)
        self.assertIn('classList.contains("sidebar-resizing")', script)
        self.assertIn('resizer.addEventListener("mousedown"', script)
        self.assertRegex(
            styles,
            r"html\.lacan-ai-panel-open \.page-wrapper\s*\{[^}]*margin-inline-end:\s*var\(--lacan-ai-docked-width, 440px\);",
        )
        self.assertRegex(
            styles,
            r"\.sidebar-resizing \.lacan-ai-resizer\s*\{[^}]*pointer-events:\s*none;",
        )
        self.assertRegex(
            styles,
            r"\.lacan-ai-is-resizing #mdbook-sidebar-resize-handle\s*\{[^}]*pointer-events:\s*none;",
        )

    def test_ai_request_streams_with_diagnostics_and_bounded_output(self):
        script = (ROOT / "theme" / "lacan-ai.js").read_text(encoding="utf-8")
        core = (ROOT / "theme" / "lacan-ai-core.js").read_text(encoding="utf-8")
        styles = (ROOT / "theme" / "lacan-ai.css").read_text(encoding="utf-8")

        self.assertIn("Core.REQUEST_TIMEOUT_MS", script)
        self.assertIn("Core.buildChatRequest", script)
        self.assertIn("stream: true", core)
        self.assertIn("enable_thinking: false", core)
        self.assertIn("Core.readChatResponse", script)
        self.assertIn('phase: "connected"', script)
        self.assertIn('streamEvent.phase === "reasoning"', script)
        self.assertIn("function scheduleStreamingOutput(markdown)", script)
        self.assertIn("pendingStreamingMarkdown", script)
        self.assertIn("streamRenderFrame", script)
        self.assertIn("scheduleStreamingOutput(partialText)", script)
        self.assertNotIn('setOutput(partialText, "streaming")', script)
        self.assertIn("cancelScheduledStreamingOutput()", script)
        self.assertIn("Core.MAX_RESPONSE_BYTES", script)
        self.assertIn("Core.MAX_OUTPUT_CHARS", script)
        self.assertIn("x-siliconcloud-trace-id", script)
        self.assertIn("已保留已经返回的部分内容", script)
        self.assertIn("lacan-ai-diagnostics", script)
        self.assertIn(".lacan-ai-diagnostics", styles)

    def test_markdown_output_renders_safely_and_copies_raw_source(self):
        script = (ROOT / "theme" / "lacan-ai.js").read_text(encoding="utf-8")
        core = (ROOT / "theme" / "lacan-ai-core.js").read_text(encoding="utf-8")
        styles = (ROOT / "theme" / "lacan-ai.css").read_text(encoding="utf-8")

        self.assertIn("function renderMarkdown(markdown)", core)
        self.assertIn("escapeHtml", core)
        self.assertIn("safeMarkdownUrl", core)
        self.assertIn("state.outputMarkdown", script)
        self.assertIn("output.innerHTML = Core.renderMarkdown(state.outputMarkdown)", script)
        self.assertIn('button("复制 Markdown", "lacan-ai-copy")', script)
        self.assertIn('copyButton.setAttribute("aria-label", "复制 Markdown 原文")', script)
        self.assertIn("navigator.clipboard.writeText(markdown)", script)
        self.assertIn('document.execCommand("copy")', script)
        self.assertIn('element("div", "lacan-ai-output-toolbar")', script)
        self.assertIn('element("article", "lacan-ai-output")', script)
        self.assertNotIn('element("pre", "lacan-ai-output"', script)
        self.assertIn(".lacan-ai-output-toolbar", styles)
        self.assertIn(".lacan-ai-output table", styles)
        self.assertIn(".lacan-ai-output pre", styles)

    def test_copy_preserves_the_assistant_scroll_position(self):
        script = (ROOT / "theme" / "lacan-ai.js").read_text(encoding="utf-8")
        styles = (ROOT / "theme" / "lacan-ai.css").read_text(encoding="utf-8")

        self.assertIn("Core.captureScrollSnapshot", script)
        self.assertIn("Core.resolveRestoredScrollTop", script)
        self.assertIn("lastOutputScrollSnapshot: null", script)
        self.assertIn("function rememberOutputScrollSnapshot()", script)
        self.assertIn("function restoreScrollAfterCopy(snapshot)", script)
        self.assertIn('copyButton.addEventListener("pointerdown"', script)
        self.assertIn("event.preventDefault();", script)

        start = script.index("async function handleCopyOutput()")
        end = script.index("\n  function setDiagnostics", start)
        handler = script[start:end]
        self.assertIn("state.lastOutputScrollSnapshot ||", handler)
        self.assertIn("restoreScrollAfterCopy(scrollSnapshot)", handler)
        self.assertIn("finally", handler)
        self.assertRegex(
            styles,
            r"\.lacan-ai-output-shell\s*\{[^}]*overflow:\s*visible;",
        )
        self.assertRegex(
            styles,
            r"\.lacan-ai-output-toolbar\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;",
        )

    def test_streaming_output_auto_follows_and_navigation_rail_controls_panel(self):
        script = (ROOT / "theme" / "lacan-ai.js").read_text(encoding="utf-8")
        core = (ROOT / "theme" / "lacan-ai-core.js").read_text(encoding="utf-8")
        styles = (ROOT / "theme" / "lacan-ai.css").read_text(encoding="utf-8")

        self.assertIn("function isScrollNearBottom(container, threshold)", core)
        self.assertIn("outputAutoFollow: true", script)
        self.assertIn("requestAutoFollowActive: false", script)
        self.assertIn("activeRequestController: null", script)
        self.assertIn("function scheduleOutputAutoFollow(kind)", script)
        self.assertIn("function scrollOutputToBottom()", script)
        self.assertIn("function releaseRequestAutoFollow()", script)
        self.assertGreaterEqual(script.count("scrollOutputToBottom();"), 2)
        self.assertIn('["streaming", "answer", "partial"].includes(kind)', script)
        self.assertIn("state.refs.body.scrollTop = state.refs.body.scrollHeight", script)
        self.assertIn('body.addEventListener("scroll"', script)
        self.assertIn(
            "Core.isScrollNearBottom(body, OUTPUT_FOLLOW_THRESHOLD)",
            script,
        )
        self.assertIn("else if (!state.requestAutoFollowActive)", script)
        self.assertIn('body.addEventListener("wheel"', script)

        self.assertIn("function handleOutputTop()", script)
        self.assertIn("function handleOutputBottom()", script)
        self.assertIn("function handleClearOutput()", script)
        self.assertIn('button("↑", "lacan-ai-output-nav-button")', script)
        self.assertIn('button("↓", "lacan-ai-output-nav-button")', script)
        self.assertIn('button("清", "lacan-ai-output-nav-button lacan-ai-output-nav-clear")', script)
        self.assertIn('setAttribute("aria-label", "滚动到阅读助手顶部")', script)
        self.assertIn('setAttribute("aria-label", "滚动到阅读助手底部")', script)
        self.assertIn('setAttribute("aria-label", "清空当前回答")', script)
        self.assertIn("state.activeRequestController.abort();", script)
        self.assertIn('setOutput("", "placeholder")', script)
        self.assertIn("if (error.cleared)", script)

        self.assertRegex(
            styles,
            r"\.lacan-ai-output-nav\s*\{[^}]*position:\s*absolute;[^}]*opacity:\s*0\.42;",
        )
        self.assertRegex(
            styles,
            r"\.lacan-ai-output-nav:hover,[\s\S]*\.lacan-ai-output-nav:focus-within\s*\{[^}]*opacity:\s*1;",
        )


if __name__ == "__main__":
    unittest.main()
