from __future__ import annotations

from pathlib import Path
import sys
import unittest


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import sync_readme_stats as readme_sync  # noqa: E402
import taxonomy  # noqa: E402


class TaxonomyIndexTests(unittest.TestCase):
    def test_each_controlled_field_belongs_to_exactly_one_category(self) -> None:
        fields = [
            field
            for category in taxonomy.CATEGORY_GROUPS
            for field in category.fields
        ]

        self.assertEqual(len(fields), len(set(fields)))
        self.assertEqual(
            taxonomy.FIELD_TAGS,
            {f"领域/{field}" for field in fields},
        )

    def test_deprecated_alias_targets_are_current_tags(self) -> None:
        for old_tag, current_tag in taxonomy.DEPRECATED_TAG_ALIASES.items():
            self.assertNotEqual(old_tag, current_tag)
            self.assertNotIn(current_tag, taxonomy.DEPRECATED_TAG_ALIASES)

    def test_psychology_psychiatry_and_medicine_histories_are_separate(self) -> None:
        self.assertNotIn(
            "领域/心理精神病学与医学/心理医学史",
            taxonomy.FIELD_TAGS,
        )
        self.assertTrue(
            {
                "领域/心理精神病学与医学/心理学史",
                "领域/心理精神病学与医学/精神病学史",
                "领域/心理精神病学与医学/医学史",
            }.issubset(taxonomy.FIELD_TAGS)
        )

    def test_rendered_index_uses_all_field_tags_per_card(self) -> None:
        cards = [
            readme_sync.CardSummary(
                path=Path("知识库/示例甲.md"),
                title="示例甲",
                tags=(
                    "领域/精神分析/无意识与主体",
                    "领域/哲学/古代哲学",
                ),
                verification="已核实",
            ),
            readme_sync.CardSummary(
                path=Path("知识库/示例乙.md"),
                title="示例乙",
                tags=("领域/哲学/古代哲学",),
                verification="部分准确",
            ),
        ]

        rendered = readme_sync.render_category_index(cards)

        self.assertIn("精神分析（1 张）", rendered)
        self.assertIn("无意识与主体（1）", rendered)
        self.assertIn("哲学与思想（2 张）", rendered)
        self.assertIn("古代哲学（2）", rendered)
        self.assertEqual(rendered.count("[示例甲](<./示例甲.md>)"), 2)
        self.assertIn("3 条索引关系", rendered)

    def test_category_count_deduplicates_two_fields_from_the_same_group(self) -> None:
        card = readme_sync.CardSummary(
            path=Path("知识库/示例.md"),
            title="示例",
            tags=(
                "领域/精神分析/无意识与主体",
                "领域/精神分析/能指言说与书写",
            ),
            verification="已核实",
        )

        rendered = readme_sync.render_category_index([card])

        self.assertIn("精神分析（1 张）", rendered)
        self.assertIn("无意识与主体（1）", rendered)
        self.assertIn("能指言说与书写（1）", rendered)

    def test_rendered_index_rejects_missing_field_tag(self) -> None:
        card = readme_sync.CardSummary(
            path=Path("知识库/示例.md"),
            title="示例",
            tags=("人物/示例",),
            verification="已核实",
        )

        with self.assertRaisesRegex(ValueError, "at least one"):
            readme_sync.render_category_index([card])


if __name__ == "__main__":
    unittest.main()
