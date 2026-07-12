import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


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


class ReadingNotesBuildTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
