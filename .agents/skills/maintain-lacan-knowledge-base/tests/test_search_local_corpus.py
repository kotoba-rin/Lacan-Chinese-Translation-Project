from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys
import tempfile
import unittest


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import search_local_corpus as corpus_search  # noqa: E402


CARD_TEMPLATE = """\
---
title: {title}
type: knowledge-card
verification: 已核实
tags:
  - 研讨班XVII
  - 领域/精神分析
  - 概念/四种话语
verified_at: 2026-07-28
---

{body}

## 来源

- [Source](https://example.com)（法文；测试）

## 关联

{card_link}
[[texts/s17-test/translation/Leçon-01.md#s17-01-0001|s17-01-0001]]
"""


class SearchLocalCorpusTests(unittest.TestCase):
    def make_repo(self) -> tuple[tempfile.TemporaryDirectory[str], Path]:
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        (root / "知识库").mkdir()
        (root / "texts/s17-test/translation").mkdir(parents=True)
        (root / "texts/s17-test/original").mkdir(parents=True)
        (root / "texts/s17-test/translation/Leçon-01.md").write_text(
            "<!-- id: s17-01-0001 -->\n拉康的四种话语。\n",
            encoding="utf-8",
        )
        (root / "texts/s17-test/original/Leçon-01.md").write_text(
            "<!-- id: s17-01-0001 -->\nLes quatre discours.\n",
            encoding="utf-8",
        )
        (root / "知识库/四种话语.md").write_text(
            CARD_TEMPLATE.format(
                title="四种话语",
                body="四种话语通过四分之一转位形成。",
                card_link="[[知识库/分析家话语.md|分析家话语]]\n",
            ),
            encoding="utf-8",
        )
        (root / "知识库/分析家话语.md").write_text(
            CARD_TEMPLATE.format(
                title="分析家话语",
                body="分析家话语是四种话语之一。",
                card_link="[[知识库/四种话语.md|四种话语]]\n",
            ),
            encoding="utf-8",
        )
        return temporary, root

    def test_fuzzy_query_returns_query_plan_and_matches_inserted_character(self) -> None:
        temporary, root = self.make_repo()
        self.addCleanup(temporary.cleanup)
        args = argparse.Namespace(
            repo_root=root,
            query=["四话语"],
            card=[],
            tag=[],
            segment=[],
            include_originals=False,
            exact=False,
            depth=1,
            limit=5,
            json=False,
        )

        result = corpus_search.search(args)

        self.assertEqual(result["cards"][0]["title"], "四种话语")
        self.assertIn("query_plan", result)
        pattern = result["query_plan"][0]["fuzzy_regex"]
        self.assertIsNotNone(re.search(pattern, "四种话语"))

    def test_fuzzy_name_matching_tolerates_one_transliteration_character(self) -> None:
        quality = corpus_search.match_quality(
            "波德里亚",
            "鲍德里亚《拟像与仿真》",
            fuzzy=True,
            allow_edit_distance=True,
        )

        self.assertEqual(quality, "fuzzy-spelling")

    def test_explicit_card_link_is_traversed_bidirectionally(self) -> None:
        temporary, root = self.make_repo()
        self.addCleanup(temporary.cleanup)
        args = argparse.Namespace(
            repo_root=root,
            query=[],
            card=["四种话语"],
            tag=[],
            segment=[],
            include_originals=False,
            exact=False,
            depth=1,
            limit=5,
            json=False,
        )

        result = corpus_search.search(args)
        related = next(item for item in result["cards"] if item["title"] == "分析家话语")

        self.assertTrue(
            any(reason.startswith("显式卡片链接:") for reason in related["reasons"])
        )


if __name__ == "__main__":
    unittest.main()
