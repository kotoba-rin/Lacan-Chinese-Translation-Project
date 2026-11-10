"""Regression coverage for emphasis at Chinese punctuation boundaries."""

import importlib.util
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "build_from_texts.py"
spec = importlib.util.spec_from_file_location("build_from_texts_emphasis", SCRIPT_PATH)
builder = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = builder
spec.loader.exec_module(builder)


def mdbook_binary():
    bundled = ROOT / "bin" / "mdbook"
    return str(bundled) if bundled.is_file() else shutil.which("mdbook")


class ProtectedMarkupTest(unittest.TestCase):
    def test_literal_markers_are_preserved_in_code_and_raw_html(self):
        samples = {
            "inline code": "`**句号。**后文`",
            "long inline delimiter": "`` a ` **句号。**后文 ``",
            "multiline inline code": "`第一行\n**句号。**后文\n最后一行`",
            "fenced code": "```markdown\n**句号。**后文\n```\n",
            "tilde fence": "~~~markdown\n**句号。**后文\n~~~\n",
            "long fence": "````markdown\n```\n**句号。**后文\n````\n",
            "list tilde fence": "- ~~~markdown\n  **句号。**后文\n  ~~~\n",
            "indented code": "    **句号。**后文\n",
            "escaped markers": r"\*\*句号。\*\*后文",
            "html attribute": '<span title="**句号。**后文">标签</span>',
            "html comment": "<!-- **句号。**后文 -->",
            "html code": "<code>**句号。**后文</code>",
            "html pre": "<pre>\n**句号。**后文\n</pre>\n",
            "html script": '<script>const example = "**句号。**后文";</script>',
            "html style": '<style>.x::after { content: "**句号。**后文"; }</style>',
            "link title": '[链接](https://example.org/ "**标题。**后文")',
            "reference destination": "[ref]: https://example.org/**path.**next\n",
        }
        for name, source in samples.items():
            with self.subTest(name=name):
                self.assertEqual(
                    builder.normalize_source_markdown(source, ROOT / "知识库" / "例.md"),
                    source,
                )
                self.assertEqual(builder.render_translation_inline_markup(source), source)

    def test_math_markers_are_preserved_by_emphasis_conversion(self):
        samples = [
            "$**句号。**后文$",
            "$$\n**句号。**后文\n$$",
            r"\(**句号。**后文\)",
            "\\[\n**句号。**后文\n\\]",
            r"\\(**句号。**后文\\)",
            "\\\\[\n**句号。**后文\n\\\\]",
        ]
        for source in samples:
            with self.subTest(source=source):
                self.assertEqual(builder.render_translation_inline_markup(source), source)

    def test_normalized_obsidian_math_keeps_literal_asterisks(self):
        source = "$**句号。**后文$\n\n$$\n**句号。**后文\n$$\n"
        expected = "\\\\(**句号。**后文\\\\)\n\n\\\\[\n**句号。**后文\n\\\\]\n"
        self.assertEqual(
            builder.normalize_source_markdown(source, ROOT / "知识库" / "例.md"),
            expected,
        )

    def test_normalization_is_idempotent(self):
        source = '**“术语”**后文；**普通**文字。`**例。**后文`；$a^{**}$'
        path = ROOT / "知识库" / "例.md"
        once = builder.normalize_source_markdown(source, path)
        self.assertEqual(builder.normalize_source_markdown(once, path), once)

    def test_unpaired_or_space_padded_markers_are_not_guessed(self):
        samples = [
            "**没有结束标记。",
            "**跨段第一段。\n\n**第二段。\n",
            "** 两端有空格 **正文。",
        ]
        for source in samples:
            with self.subTest(source=source):
                self.assertEqual(builder.render_translation_inline_markup(source), source)

    def test_malformed_single_emphasis_boundaries_are_left_to_mdbook(self):
        samples = [
            "*Schönbrunn**,* sur le *Stadtbahn**,*",
            "**加粗 *斜体** 后文*",
        ]
        for source in samples:
            with self.subTest(source=source):
                self.assertEqual(builder.render_translation_inline_markup(source), source)


@unittest.skipUnless(mdbook_binary(), "mdBook is required for actual HTML regression tests")
class MdBookEmphasisHtmlTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="lacan-emphasis-test-")
        cls.addClassCleanup(cls.temp.cleanup)
        cls.project = Path(cls.temp.name)
        src = cls.project / "src"
        src.mkdir()
        (cls.project / "book.toml").write_text(
            '[book]\ntitle = "Emphasis regression"\nsrc = "src"\n'
            '[output.html]\n[output.html.search]\nenable = false\n'
            '[output.html.print]\nenable = false\n',
            encoding="utf-8",
        )

        cls.source = (
            "**广延不等于形状。**广延。\n\n"
            "前文**“理智之爱”**后文。\n\n"
            "前文**（关系）**后文。\n\n"
            "**实体、属性与样态。**《伦理学》。\n\n"
            "**普通加粗**文字；*正常斜体*。\n\n"
            "**嵌套 *术语*。**后文。\n\n"
            "*斜体 **加粗** 结尾*。\n\n"
            "**[链接](https://example.org/)。**后文。\n\n"
            '<span title="**属性。**后文">标签</span> **紧邻。**正文。\n'
        )
        canonical = cls.project / "canonical"
        canonical.mkdir()
        card = canonical / "card.md"
        note = canonical / "note.md"
        seminar = canonical / "seminar"
        (seminar / "notes").mkdir(parents=True)
        readme = seminar / "notes" / "README.md"
        content = "---\ntitle: 原始标题\n---\n\n# 原始标题\n\n" + cls.source
        card.write_text(content, encoding="utf-8")
        note.write_text(content, encoding="utf-8")
        readme.write_text("# 阅读笔记\n\n" + cls.source, encoding="utf-8")
        original_files = {p: p.read_bytes() for p in (card, note, readme)}
        note_info = builder.ReadingNote(note, Path("notes/note.md"), "阅读笔记", [])
        entry = builder.TranslationEntry("s8-01-0001", ["s8-01-0001"], cls.source)
        pages = {
            "knowledge": builder.render_knowledge_page(card, "知识卡"),
            "note": builder.render_reading_note(note_info),
            "notes-index": builder.render_notes_readme(seminar, [note_info]),
            "translation": builder.render_translation_entry(entry).body,
            "normalized": builder.normalize_source_markdown(cls.source, card),
        }
        literal_pages = {
            "containers": (
                "- ~~~markdown\n  **代码。**后文\n  ~~~\n\n"
                "**围栏之后。**正文。\n\n"
                "- 首段\n\n    **列表续段。**正文。\n"
            ),
            "link-metadata": (
                '[链接](https://example.org/ "**标题。**后文")\n\n'
                "[引用][ref]\n\n[ref]: https://example.org/**path.**next\n\n"
                "**链接之后。**正文。\n"
            ),
            "paragraph-boundaries": (
                "`未闭合\n\n**隔段。**正文。\n\n`另一段\n\n"
                "> ~~~markdown\n> **引用代码。**后文\n\n"
                "**引用之后。**正文。\n\n"
                "<pre>\n~~~\n</pre>\n\n**原始块之后。**正文。\n"
            ),
            "mixed-emphasis-boundaries": (
                "*Schönbrunn**,* sur le *Stadtbahn**,*\n\n"
                "*前段* **后段。**正文。\n\n"
                "* **列表段。**正文。\n"
            ),
        }
        pages.update({
            name: builder.normalize_source_markdown(markdown, card)
            for name, markdown in literal_pages.items()
        })
        cls.sources_unchanged = all(p.read_bytes() == original for p, original in original_files.items())
        (src / "SUMMARY.md").write_text(
            "# Summary\n\n" + "".join(f"- [{name}]({name}.md)\n" for name in pages),
            encoding="utf-8",
        )
        for name, markdown in pages.items():
            (src / f"{name}.md").write_text(markdown, encoding="utf-8")
        result = subprocess.run(
            [mdbook_binary(), "build", str(cls.project)],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode:
            raise AssertionError(f"mdBook build failed: {result.stdout}\n{result.stderr}")
        cls.build_stderr = result.stderr
        cls.pages = {}
        cls.literal_pages = {}
        for name in pages:
            html = (cls.project / "book" / f"{name}.html").read_text(encoding="utf-8")
            main = re.search(r"<main>(.*?)</main>", html, re.S).group(1)
            if name in literal_pages:
                cls.literal_pages[name] = main
            else:
                cls.pages[name] = main

    def test_original_chinese_punctuation_failure_renders_as_strong_on_all_page_paths(self):
        for name, html in self.pages.items():
            with self.subTest(page=name):
                self.assertIn("<strong>广延不等于形状。</strong>广延", html)
                self.assertNotIn("**广延不等于形状。**", html)

    def test_quotes_parentheses_and_adjacent_text_preserve_emphasis(self):
        for name, html in self.pages.items():
            with self.subTest(page=name):
                self.assertIn("前文<strong>“理智之爱”</strong>后文", html)
                self.assertIn("前文<strong>（关系）</strong>后文", html)
                self.assertIn("<strong>紧邻。</strong>正文", html)
                self.assertIn('title="**属性。**后文"', html)

    def test_regular_nested_and_link_markup_keeps_its_html_meaning(self):
        for name, html in self.pages.items():
            with self.subTest(page=name):
                self.assertIn("<strong>实体、属性与样态。</strong>《伦理学》", html)
                self.assertIn("<strong>普通加粗</strong>文字；<em>正常斜体</em>", html)
                self.assertIn("<strong>嵌套 <em>术语</em>。</strong>后文", html)
                self.assertIn("<em>斜体 <strong>加粗</strong> 结尾</em>", html)
                self.assertIn('<strong><a href="https://example.org/">链接</a>。</strong>后文', html)

    def test_canonical_markdown_files_are_unchanged(self):
        self.assertTrue(self.sources_unchanged)

    def test_list_fences_protect_code_without_hiding_following_prose(self):
        html = self.literal_pages["containers"]
        self.assertIn("**代码。**后文", html)
        self.assertNotIn("<strong>代码。</strong>", html)
        self.assertIn("<strong>围栏之后。</strong>正文", html)
        self.assertIn("<strong>列表续段。</strong>正文", html)

    def test_link_titles_and_reference_destinations_remain_literal(self):
        html = self.literal_pages["link-metadata"]
        self.assertIn('title="**标题。**后文"', html)
        self.assertIn('href="https://example.org/**path.**next"', html)
        self.assertIn("<strong>链接之后。</strong>正文", html)

    def test_unmatched_code_does_not_hide_other_paragraphs_or_quote_containers(self):
        html = self.literal_pages["paragraph-boundaries"]
        self.assertIn("<strong>隔段。</strong>正文", html)
        self.assertIn("**引用代码。**后文", html)
        self.assertNotIn("<strong>引用代码。</strong>", html)
        self.assertIn("<strong>引用之后。</strong>正文", html)
        self.assertIn("<strong>原始块之后。</strong>正文", html)

    def test_mixed_delimiters_keep_existing_html_without_crossing_emphasis(self):
        html = self.literal_pages["mixed-emphasis-boundaries"]
        self.assertIn("<em>Schönbrunn</em>*,* sur le <em>Stadtbahn</em>*,*", html)
        self.assertIn("<em>前段</em> <strong>后段。</strong>正文", html)
        self.assertIn("<strong>列表段。</strong>正文", html)
        self.assertNotIn("unclosed HTML tag", self.build_stderr)
        self.assertNotIn("unexpected HTML end tag", self.build_stderr)


if __name__ == "__main__":
    unittest.main()
