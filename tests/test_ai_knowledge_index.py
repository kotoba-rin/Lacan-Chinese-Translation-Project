import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "build_from_texts.py"

spec = importlib.util.spec_from_file_location("build_from_texts_ai_index", SCRIPT_PATH)
build_from_texts = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = build_from_texts
spec.loader.exec_module(build_from_texts)


class AiKnowledgeIndexTest(unittest.TestCase):
    def test_exports_card_metadata_links_and_segment_routes(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            knowledge_dir = tmp_path / "知识库"
            build_dir = tmp_path / "build"
            knowledge_dir.mkdir()

            source = knowledge_dir / "对象a.md"
            source.write_text(
                "\n".join(
                    [
                        "---",
                        "title: 对象 a",
                        "type: knowledge-card",
                        "verification: 已核实",
                        "tags:",
                        "  - 研讨班VIII",
                        "  - 概念/对象a",
                        "verified_at: 2026-09-01",
                        "---",
                        "",
                        "对象 a 是欲望的原因。",
                        "",
                        "## 来源",
                        "",
                        "- 本地原文。",
                        "",
                        "## 关联",
                        "",
                        "[[知识库/部分对象.md|部分对象]]",
                        "",
                        "[[texts/s8-le-transfert/translation/Leçon-10.md#s8-10-0045|s8-10-0045]]",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            old_knowledge_dir = build_from_texts.KNOWLEDGE_DIR
            old_build_dir = build_from_texts.BUILD_DIR
            build_from_texts.KNOWLEDGE_DIR = knowledge_dir
            build_from_texts.BUILD_DIR = build_dir
            try:
                cards = build_from_texts.parse_knowledge_cards()
                output_path = build_from_texts.build_ai_knowledge_index(cards)
                payload = json.loads(output_path.read_text(encoding="utf-8"))
            finally:
                build_from_texts.KNOWLEDGE_DIR = old_knowledge_dir
                build_from_texts.BUILD_DIR = old_build_dir

            self.assertEqual(payload["version"], 1)
            self.assertEqual(payload["card_count"], 1)
            card = payload["cards"][0]
            self.assertEqual(card["title"], "对象 a")
            self.assertEqual(card["verification"], "已核实")
            self.assertEqual(card["verified_at"], "2026-09-01")
            self.assertEqual(card["tags"], ["研讨班VIII", "概念/对象a"])
            self.assertEqual(card["href"], "知识库/对象a.html")
            self.assertEqual(
                card["card_links"],
                [{"path": "知识库/部分对象.md", "title": "部分对象", "href": "知识库/部分对象.html"}],
            )
            self.assertEqual(
                card["segment_links"],
                [
                    {
                        "id": "s8-10-0045",
                        "path": "texts/s8-le-transfert/translation/Leçon-10.md",
                        "href": "s8-le-transfert/Leçon-10.html#s8-10-0045",
                    }
                ],
            )


if __name__ == "__main__":
    unittest.main()
