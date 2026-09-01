import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "build_from_texts.py"

spec = importlib.util.spec_from_file_location("build_from_texts_navigation_index", SCRIPT_PATH)
build_from_texts = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = build_from_texts
spec.loader.exec_module(build_from_texts)


class NavigationIndexTest(unittest.TestCase):
    def test_builds_title_only_navigation_index_with_direct_seminar_map(self):
        with tempfile.TemporaryDirectory() as tmp:
            build_dir = Path(tmp) / "build"
            build_dir.mkdir()
            (build_dir / "SUMMARY.md").write_text(
                "\n".join(
                    [
                        "# Summary",
                        "",
                        "- [首页](index.md)",
                        "- [知识库](知识库/README.md)",
                        "  - [对象 a](知识库/对象a.md)",
                        "- [S14：幻想的逻辑](s14-la-logique-du-fantasme/README.md)",
                        "  - [术语表](s14-la-logique-du-fantasme/glossary.md)",
                        "  - [阅读笔记](s14-la-logique-du-fantasme/notes/README.md)",
                        "    - [结构图](s14-la-logique-du-fantasme/notes/结构图.md)",
                        "  - [Leçon 07 | 15 Février 1967](s14-la-logique-du-fantasme/Leçon-07.md)",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            card = build_from_texts.KnowledgeCard(
                source_path=Path(tmp) / "知识库" / "对象a.md",
                output_relative_path=Path("知识库/对象a.md"),
                title="对象 a",
                segment_ids=["s14-07-0097"],
                tags=("概念/对象a", "欲望"),
                body="这段正文不应进入导航索引。",
            )

            old_build_dir = build_from_texts.BUILD_DIR
            build_from_texts.BUILD_DIR = build_dir
            try:
                output_path = build_from_texts.build_navigation_index([card])
            finally:
                build_from_texts.BUILD_DIR = old_build_dir

            payload = json.loads(output_path.read_text(encoding="utf-8"))
            serialized = output_path.read_text(encoding="utf-8")

            self.assertEqual(payload["version"], 1)
            self.assertEqual(payload["entry_count"], len(payload["entries"]))
            self.assertEqual(
                payload["seminars"],
                {"s14": "s14-la-logique-du-fantasme"},
            )

            by_title = {entry["title"]: entry for entry in payload["entries"]}
            self.assertEqual(by_title["首页"]["href"], "index.html")
            self.assertEqual(by_title["首页"]["kind"], "home")
            self.assertEqual(by_title["知识库"]["href"], "知识库/index.html")
            self.assertEqual(by_title["对象 a"]["kind"], "knowledge")
            self.assertEqual(by_title["对象 a"]["tags"], ["概念/对象a", "欲望"])
            self.assertIn("对象a", by_title["对象 a"]["aliases"])
            self.assertEqual(
                by_title["Leçon 07 | 15 Février 1967"]["context"],
                "S14：幻想的逻辑",
            )
            self.assertIn("s14-07", by_title["Leçon 07 | 15 Février 1967"]["aliases"])

            self.assertNotIn('"body"', serialized)
            self.assertNotIn("这段正文不应进入导航索引", serialized)
            self.assertNotIn("s14-07-0097", serialized)
            self.assertLess(output_path.stat().st_size, 10_000)


if __name__ == "__main__":
    unittest.main()
