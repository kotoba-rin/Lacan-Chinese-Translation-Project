import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "build_from_texts.py"

spec = importlib.util.spec_from_file_location("build_from_texts", SCRIPT_PATH)
build_from_texts = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = build_from_texts
spec.loader.exec_module(build_from_texts)


class DuplicateIdValidationTest(unittest.TestCase):
    def test_duplicate_id_markers_raise_with_file_and_line_numbers(self):
        source = "\n".join(
            [
                "# Leçon 01",
                "",
                "<!-- id: s8-01-0001 -->",
                "",
                "第一段。",
                "",
                "<!-- id: s8-01-0001 -->",
                "",
                "重复段。",
            ]
        )

        with self.assertRaises(build_from_texts.DuplicateIdError) as context:
            build_from_texts.validate_unique_id_markers(
                source,
                Path("texts/s8-le-transfert/translation/Leçon-01.md"),
            )

        message = str(context.exception)
        self.assertIn("texts/s8-le-transfert/translation/Leçon-01.md", message)
        self.assertIn("s8-01-0001", message)
        self.assertIn("lines 3, 7", message)

    def test_grouped_ids_comment_does_not_count_as_duplicate_anchor(self):
        source = "\n".join(
            [
                "# Leçon 01",
                "",
                "<!-- id: s8-01-0001 -->",
                "<!-- ids: s8-01-0001 s8-01-0002 -->",
                "",
                "合并译文。",
            ]
        )

        build_from_texts.validate_unique_id_markers(
            source,
            Path("texts/s8-le-transfert/translation/Leçon-01.md"),
        )


class TranslationCommentaryBuildTest(unittest.TestCase):
    def test_explicit_commentary_marker_overrides_note_like_prefix(self):
        with tempfile.TemporaryDirectory() as tmp:
            translation = Path(tmp) / "Leçon-01.md"
            translation.write_text(
                "\n".join(
                    [
                        "# Leçon 01",
                        "",
                        "<!-- id: s17-01-0001 -->",
                        "",
                        "译文正文。",
                        "",
                        "> <!-- 建言 -->",
                        "> 注：这一段明确标记为建言。",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            entry = build_from_texts.parse_translation(translation)[0]
            rendered = build_from_texts.render_translation_entry(entry)

            self.assertIn("注：这一段明确标记为建言。", rendered.commentary)
            self.assertNotIn("注：这一段明确标记为建言。", rendered.notes)


class SiteAssetsBuildTest(unittest.TestCase):
    def test_write_summary_syncs_homepage_assets(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            old_texts_dir = build_from_texts.TEXTS_DIR
            old_texts_index = build_from_texts.TEXTS_INDEX
            old_build_dir = build_from_texts.BUILD_DIR
            build_from_texts.TEXTS_DIR = tmp_path / "texts"
            build_from_texts.TEXTS_INDEX = build_from_texts.TEXTS_DIR / "index.md"
            build_from_texts.BUILD_DIR = tmp_path / "build"

            try:
                assets = build_from_texts.TEXTS_DIR / "assets"
                assets.mkdir(parents=True)
                (assets / "community.png").write_bytes(b"current")
                build_from_texts.TEXTS_INDEX.write_text(
                    "# 首页\n\n![交流群](assets/community.png)\n",
                    encoding="utf-8",
                )

                stale_assets = build_from_texts.BUILD_DIR / "assets"
                stale_assets.mkdir(parents=True)
                (stale_assets / "stale.png").write_bytes(b"stale")

                build_from_texts.write_summary()

                output_assets = build_from_texts.BUILD_DIR / "assets"
                self.assertTrue((output_assets / "community.png").exists())
                self.assertEqual(
                    (output_assets / "community.png").read_bytes(),
                    b"current",
                )
                self.assertFalse((output_assets / "stale.png").exists())
            finally:
                build_from_texts.TEXTS_DIR = old_texts_dir
                build_from_texts.TEXTS_INDEX = old_texts_index
                build_from_texts.BUILD_DIR = old_build_dir


class ReadingNotesBuildTest(unittest.TestCase):
    def test_build_without_notes_source_omits_notes_page_and_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            old_texts_dir = build_from_texts.TEXTS_DIR
            old_texts_index = build_from_texts.TEXTS_INDEX
            old_build_dir = build_from_texts.BUILD_DIR
            build_from_texts.TEXTS_DIR = tmp_path / "texts"
            build_from_texts.TEXTS_INDEX = build_from_texts.TEXTS_DIR / "index.md"
            build_from_texts.BUILD_DIR = tmp_path / "build"

            try:
                slug = "s17-l-envers-de-la-psychanalyse"
                seminar = build_from_texts.TEXTS_DIR / slug
                (seminar / "original").mkdir(parents=True)
                (seminar / "translation").mkdir()
                (seminar / "original" / "Leçon-01.md").write_text(
                    "# Leçon 01\n\n<!-- id: s17-01-0001 -->\n\nTexte original.\n",
                    encoding="utf-8",
                )
                (seminar / "translation" / "Leçon-01.md").write_text(
                    "# Leçon 01\n\n<!-- id: s17-01-0001 -->\n\n译文正文。\n",
                    encoding="utf-8",
                )
                stale_notes = build_from_texts.BUILD_DIR / slug / "notes"
                stale_notes.mkdir(parents=True)
                (stale_notes / "stale.md").write_text("# 旧笔记\n", encoding="utf-8")

                build_from_texts.build_seminar(slug)
                build_from_texts.write_summary()

                output_dir = build_from_texts.BUILD_DIR / slug
                seminar_readme = (output_dir / "README.md").read_text(encoding="utf-8")
                summary = (build_from_texts.BUILD_DIR / "SUMMARY.md").read_text(encoding="utf-8")

                self.assertFalse((output_dir / "notes").exists())
                self.assertNotIn("[阅读笔记](notes/)", seminar_readme)
                self.assertNotIn(f"[阅读笔记]({slug}/notes/README.md)", summary)
            finally:
                build_from_texts.TEXTS_DIR = old_texts_dir
                build_from_texts.TEXTS_INDEX = old_texts_index
                build_from_texts.BUILD_DIR = old_build_dir

    def test_builds_notes_pages_wiki_links_and_lesson_backlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            old_texts_dir = build_from_texts.TEXTS_DIR
            old_texts_index = build_from_texts.TEXTS_INDEX
            old_build_dir = build_from_texts.BUILD_DIR
            build_from_texts.TEXTS_DIR = tmp_path / "texts"
            build_from_texts.TEXTS_INDEX = build_from_texts.TEXTS_DIR / "index.md"
            build_from_texts.BUILD_DIR = tmp_path / "build"

            try:
                seminar = build_from_texts.TEXTS_DIR / "s8-le-transfert"
                (seminar / "original").mkdir(parents=True)
                (seminar / "translation").mkdir()
                (seminar / "notes").mkdir()
                (seminar / "original" / "README.md").write_text(
                    "# S8 原文\n\n- 标题：Le transfert\n",
                    encoding="utf-8",
                )
                (seminar / "original" / "Leçon-01.md").write_text(
                    "\n".join(
                        [
                            "# Leçon 01",
                            "",
                            "<!-- id: s8-01-0001 -->",
                            "",
                            "Texte original.",
                        ]
                    )
                    + "\n",
                    encoding="utf-8",
                )
                (seminar / "translation" / "Leçon-01.md").write_text(
                    "\n".join(
                        [
                            "# Leçon 01",
                            "",
                            "<!-- id: s8-01-0001 -->",
                            "",
                            "译文正文。",
                            "",
                            "[[notes/material|阅读笔记]]",
                            "",
                            "> 译者说明。",
                        ]
                    )
                    + "\n",
                    encoding="utf-8",
                )
                (seminar / "notes" / "README.md").write_text(
                    "\n".join(
                        [
                            "# 自定义阅读资料与笔记目录",
                            "",
                            "## ReadingList",
                            "",
                            "- 《会饮篇》",
                            "",
                            "## 阅读笔记目录",
                            "",
                            "| 笔记 | 对应译文段落 |",
                            "| --- | --- |",
                            "| [材料一](material.md) | "
                            "[s8-01-0001](../translation/Leçon-01.md#s8-01-0001) |",
                        ]
                    )
                    + "\n",
                    encoding="utf-8",
                )
                (seminar / "notes" / "material.md").write_text(
                    "\n".join(
                        [
                            "---",
                            "title: 材料一",
                            "segments:",
                            "  - s8-01-0001",
                            "---",
                            "# 材料一",
                            "",
                            "这里讨论 [[s8-01-0001|第一段]]。",
                        ]
                    )
                    + "\n",
                    encoding="utf-8",
                )
                stale_output_dir = build_from_texts.BUILD_DIR / "s8-le-transfert"
                (stale_output_dir / "notes").mkdir(parents=True)
                (stale_output_dir / "notes" / "stale.md").write_text(
                    "# 旧笔记\n",
                    encoding="utf-8",
                )
                (stale_output_dir / "assets").mkdir()
                (stale_output_dir / "assets" / "old.png").write_bytes(b"old")

                build_from_texts.build_seminar("s8-le-transfert")
                build_from_texts.write_summary()

                lesson = (build_from_texts.BUILD_DIR / "s8-le-transfert" / "Leçon-01.md").read_text(
                    encoding="utf-8"
                )
                note = (
                    build_from_texts.BUILD_DIR / "s8-le-transfert" / "notes" / "material.md"
                ).read_text(encoding="utf-8")
                notes_index = (
                    build_from_texts.BUILD_DIR / "s8-le-transfert" / "notes" / "README.md"
                ).read_text(encoding="utf-8")
                summary = (build_from_texts.BUILD_DIR / "SUMMARY.md").read_text(encoding="utf-8")

                self.assertIn('class="reading-note-links"', lesson)
                self.assertIn('<a href="notes/material.md">材料一</a>', lesson)
                self.assertNotIn("[阅读笔记](notes/material.md)", lesson)
                self.assertNotIn("<ul>", lesson)
                self.assertLess(lesson.index("译文正文。"), lesson.index('class="reading-note-links"'))
                self.assertLess(lesson.index('class="commentary-block"'), lesson.index('class="reading-note-links"'))
                self.assertIn("[第一段](../Leçon-01.md#s8-01-0001)", note)
                self.assertIn("[s8-01-0001](../Leçon-01.md#s8-01-0001)", note)
                self.assertIn("# 自定义阅读资料与笔记目录", notes_index)
                self.assertIn("## ReadingList", notes_index)
                self.assertIn("[材料一](material.md)", notes_index)
                self.assertIn(
                    "[s8-01-0001](../Leçon-01.md#s8-01-0001)",
                    notes_index,
                )
                self.assertNotIn("../translation/", notes_index)
                self.assertIn("[阅读笔记](s8-le-transfert/notes/README.md)", summary)
                self.assertFalse(
                    (build_from_texts.BUILD_DIR / "s8-le-transfert" / "notes" / "stale.md").exists()
                )
                self.assertFalse(
                    (build_from_texts.BUILD_DIR / "s8-le-transfert" / "assets" / "old.png").exists()
                )
            finally:
                build_from_texts.TEXTS_DIR = old_texts_dir
                build_from_texts.TEXTS_INDEX = old_texts_index
                build_from_texts.BUILD_DIR = old_build_dir

    def test_seminar_readme_links_to_rendered_notes_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            old_build_dir = build_from_texts.BUILD_DIR
            build_from_texts.BUILD_DIR = tmp_path / "build"

            try:
                seminar = tmp_path / "texts" / "s8-le-transfert"
                (seminar / "original").mkdir(parents=True)
                (seminar / "notes").mkdir()
                (seminar / "original" / "README.md").write_text(
                    "# S8 原文\n\n- 标题：Le transfert\n",
                    encoding="utf-8",
                )

                readme = build_from_texts.render_seminar_readme(
                    "s8-le-transfert",
                    seminar,
                )

                self.assertIn("[阅读笔记](notes/)", readme)
                self.assertNotIn("[阅读笔记](notes/README.md)", readme)
            finally:
                build_from_texts.BUILD_DIR = old_build_dir


class KnowledgeBaseBuildTest(unittest.TestCase):
    def test_builds_knowledge_pages_and_segment_backlinks_like_reading_notes(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            old_texts_dir = build_from_texts.TEXTS_DIR
            old_texts_index = build_from_texts.TEXTS_INDEX
            old_build_dir = build_from_texts.BUILD_DIR
            had_knowledge_dir = hasattr(build_from_texts, "KNOWLEDGE_DIR")
            old_knowledge_dir = getattr(build_from_texts, "KNOWLEDGE_DIR", None)
            build_from_texts.TEXTS_DIR = tmp_path / "texts"
            build_from_texts.TEXTS_INDEX = build_from_texts.TEXTS_DIR / "index.md"
            build_from_texts.BUILD_DIR = tmp_path / "build"
            build_from_texts.KNOWLEDGE_DIR = tmp_path / "知识库"

            try:
                slug = "s8-le-transfert"
                seminar = build_from_texts.TEXTS_DIR / slug
                (seminar / "original").mkdir(parents=True)
                (seminar / "translation").mkdir()
                (seminar / "notes").mkdir()
                (seminar / "original" / "Leçon-01.md").write_text(
                    "\n".join(
                        [
                            "# Leçon 01",
                            "",
                            "<!-- id: s8-01-0001 -->",
                            "",
                            "Premier paragraphe.",
                            "",
                            "<!-- id: s8-01-0002 -->",
                            "",
                            "Deuxième paragraphe.",
                        ]
                    )
                    + "\n",
                    encoding="utf-8",
                )
                (seminar / "translation" / "Leçon-01.md").write_text(
                    "\n".join(
                        [
                            "# Leçon 01",
                            "",
                            "<!-- id: s8-01-0001 -->",
                            "",
                            "第一段译文。",
                            "",
                            "> <!-- 建言 -->",
                            "> 第一段建言。",
                            "",
                            "<!-- id: s8-01-0002 -->",
                            "",
                            "第二段译文。",
                        ]
                    )
                    + "\n",
                    encoding="utf-8",
                )
                (seminar / "notes" / "material.md").write_text(
                    "\n".join(
                        [
                            "---",
                            "title: 阅读材料",
                            "segments:",
                            "  - s8-01-0001",
                            "---",
                            "# 阅读材料",
                            "",
                            "笔记正文。",
                        ]
                    )
                    + "\n",
                    encoding="utf-8",
                )

                build_from_texts.KNOWLEDGE_DIR.mkdir()
                (build_from_texts.KNOWLEDGE_DIR / "README.md").write_text(
                    "---\ntitle: 项目知识库\ntype: index\n---\n\n# 项目知识库\n",
                    encoding="utf-8",
                )
                (build_from_texts.KNOWLEDGE_DIR / "对象 a.md").write_text(
                    "\n".join(
                        [
                            "---",
                            "title: 对象 a",
                            "type: knowledge-card",
                            "verification: 已核实",
                            "tags:",
                            "  - 研讨班VIII",
                            "  - 领域/精神分析",
                            "  - 概念/对象a",
                            "verified_at: 2026-07-30",
                            "---",
                            "",
                            "对象 a 的知识卡正文。",
                            "",
                            "## 来源",
                            "",
                            "- [[texts/s8-le-transfert/translation/Leçon-01.md#s8-01-0002|仅作为来源出现的第二段]]",
                            "",
                            "## 关联",
                            "",
                            "[[texts/s8-le-transfert/translation/Leçon-01.md#s8-01-0001|s8-01-0001]]",
                        ]
                    )
                    + "\n",
                    encoding="utf-8",
                )

                with patch.object(
                    sys,
                    "argv",
                    [str(SCRIPT_PATH), "--seminar", slug],
                ):
                    build_from_texts.main()

                lesson = (
                    build_from_texts.BUILD_DIR / slug / "Leçon-01.md"
                ).read_text(encoding="utf-8")
                knowledge_page_path = (
                    build_from_texts.BUILD_DIR / "知识库" / "对象 a.md"
                )
                self.assertTrue(knowledge_page_path.exists())
                knowledge_page = knowledge_page_path.read_text(encoding="utf-8")
                summary = (build_from_texts.BUILD_DIR / "SUMMARY.md").read_text(
                    encoding="utf-8"
                )

                first_segment = lesson[
                    lesson.index('id="s8-01-0001"') : lesson.index(
                        'id="s8-01-0002"'
                    )
                ]
                second_segment = lesson[lesson.index('id="s8-01-0002"') :]
                self.assertIn('class="reading-note-links"', first_segment)
                self.assertIn(
                    'class="reading-note-links knowledge-card-links"',
                    first_segment,
                )
                self.assertIn(
                    '<span class="reading-note-links-title">知识库</span>',
                    first_segment,
                )
                self.assertIn(
                    '<a href="../知识库/对象%20a.md">对象 a</a>',
                    first_segment,
                )
                self.assertLess(
                    first_segment.index('class="commentary-block"'),
                    first_segment.index('aria-label="相关阅读笔记"'),
                )
                self.assertLess(
                    first_segment.index('aria-label="相关阅读笔记"'),
                    first_segment.index('aria-label="相关知识库"'),
                )
                self.assertNotIn("knowledge-card-links", second_segment)

                self.assertTrue(knowledge_page.startswith("# 对象 a\n"))
                self.assertNotIn("type: knowledge-card", knowledge_page)
                self.assertIn(
                    "[s8-01-0001](../s8-le-transfert/Leçon-01.md#s8-01-0001)",
                    knowledge_page,
                )
                self.assertIn("- [知识库](知识库/README.md)", summary)
                self.assertIn("  - [对象 a](知识库/对象%20a.md)", summary)
                self.assertEqual(summary.count("(知识库/README.md)"), 1)
            finally:
                build_from_texts.TEXTS_DIR = old_texts_dir
                build_from_texts.TEXTS_INDEX = old_texts_index
                build_from_texts.BUILD_DIR = old_build_dir
                if had_knowledge_dir:
                    build_from_texts.KNOWLEDGE_DIR = old_knowledge_dir
                else:
                    del build_from_texts.KNOWLEDGE_DIR


if __name__ == "__main__":
    unittest.main()
