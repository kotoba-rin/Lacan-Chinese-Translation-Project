from pathlib import Path
import json
import sys
import tempfile
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import validate_knowledge_base as validator


class AliasMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.knowledge = self.root / "知识库"
        self.knowledge.mkdir()
        lesson = self.root / "texts/s1/translation/Leçon-01.md"
        lesson.parent.mkdir(parents=True)
        lesson.write_text("<!-- id: s1-01-0001 -->\n正文\n", encoding="utf-8")
        self.card = self.knowledge / "示例.md"

    def check(self, aliases=None, raw=None, position="after_title"):
        block = raw if raw is not None else "" if aliases is None else "aliases:\n" + "".join(f"  - {json.dumps(alias, ensure_ascii=False)}\n" for alias in aliases)
        text = "---\ntitle: 示例\n"
        if position == "after_title":
            text += block
        text += "type: knowledge-card\nverification: 已核实\ntags:\n  - 研讨班I\n  - 领域/精神分析/能指言说与书写\n  - 概念/示例\nverified_at: 2026-11-10\n"
        if position == "after_date":
            text += block
        text += "---\n\n独立正文。\n\n## 来源\n\n- [来源](https://example.invalid/source)（法文；测试资料）\n\n## 关联\n\n[[texts/s1/translation/Leçon-01.md#s1-01-0001|s1-01-0001]]\n"
        self.card.write_text(text, encoding="utf-8")
        card = validator.parse_frontmatter(self.card)
        errors = validator.validate_card(card, self.root, self.knowledge, {"s1": "研讨班I"}, {}, {}, False)
        return card, errors

    def test_existing_cards_without_aliases_still_validate(self):
        self.assertEqual(self.check()[1], [])

    def test_original_language_names_and_quoted_apostrophes_validate(self):
        card, errors = self.check(["Nom-du-Père", "L'homme", 'The "Object"'])
        self.assertEqual(errors, [])
        self.assertEqual(card.metadata["aliases"], ["Nom-du-Père", "L'homme", 'The "Object"'])
        card, errors = self.check(raw="aliases:\n  - 'L''homme'\n")
        self.assertEqual(card.metadata["aliases"], ["L'homme"])
        self.assertEqual(errors, [])

    def test_scalar_empty_and_oversized_alias_lists_are_rejected(self):
        for raw in ["aliases: name\n", "aliases:\n"]:
            with self.subTest(raw=raw):
                self.assertTrue(any("aliases must" in error for error in self.check(raw=raw)[1]))
        self.assertTrue(any("at most 32" in error for error in self.check([str(i) for i in range(33)])[1]))

    def test_blank_long_and_multiline_names_are_rejected(self):
        for alias in [" ", "字" * 301, "first\nsecond"]:
            with self.subTest(alias=alias[:20]):
                self.assertTrue(any("each alias" in error for error in self.check([alias])[1]))

    def test_matching_normalization_detects_duplicate_names(self):
        for aliases in [["Agalma", "agalma"], ["ＲＳＩ", "RSI"]]:
            self.assertTrue(any("duplicate" in error for error in self.check(aliases)[1]))

    def test_optional_alias_position_preserves_the_required_key_order(self):
        self.assertTrue(any("keys/order" in error for error in self.check(["nom"], position="after_date")[1]))


if __name__ == "__main__":
    unittest.main()
