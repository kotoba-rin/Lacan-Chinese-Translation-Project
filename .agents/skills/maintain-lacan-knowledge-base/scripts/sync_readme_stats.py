#!/usr/bin/env python3
"""Check or synchronize knowledge-base statistics in 知识库/README.md."""

from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import dataclass
from datetime import date
from pathlib import Path
import re
import sys

from validate_knowledge_base import (
    VERIFICATION_VALUES,
    parse_frontmatter,
    seminar_map,
)
from taxonomy import CATEGORY_GROUPS, FIELD_TAGS, field_anchor, field_label


COUNT_CLAUSE_RE = re.compile(
    r"共收录 \d+ 张知识卡；其中.*?。(?=同一卡片可以关联多个研讨班)"
)
CATEGORY_INDEX_RE = re.compile(
    r"<!-- BEGIN GENERATED CATEGORY INDEX -->.*?"
    r"<!-- END GENERATED CATEGORY INDEX -->",
    re.DOTALL,
)


@dataclass(frozen=True)
class CardSummary:
    path: Path
    title: str
    tags: tuple[str, ...]
    verification: str


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--write", action="store_true")
    parser.add_argument("--repo-root", type=Path, default=Path("."))
    parser.add_argument("--knowledge-dir", type=Path, default=Path("知识库"))
    parser.add_argument(
        "--date",
        default=date.today().isoformat(),
        help="README updated date used with --write (default: today).",
    )
    return parser.parse_args()


def load_cards(knowledge_dir: Path) -> list[CardSummary]:
    cards: list[CardSummary] = []
    paths = sorted(
        path for path in knowledge_dir.glob("*.md") if path.name != "README.md"
    )
    for path in paths:
        card = parse_frontmatter(path)
        title = card.metadata.get("title")
        tags = card.metadata.get("tags")
        verification = card.metadata.get("verification")
        if (
            not isinstance(title, str)
            or not isinstance(tags, list)
            or verification not in VERIFICATION_VALUES
        ):
            raise ValueError(f"{path}: invalid metadata; run validate_knowledge_base.py")
        cards.append(
            CardSummary(
                path=path,
                title=title,
                tags=tuple(tags),
                verification=verification,
            )
        )
    return cards


def load_counts(
    cards: list[CardSummary],
) -> tuple[Counter[str], Counter[str]]:
    seminar_counts: Counter[str] = Counter()
    verification_counts: Counter[str] = Counter()
    for card in cards:
        seminar_counts.update(tag for tag in card.tags if tag.startswith("研讨班"))
        verification_counts[card.verification] += 1
    return seminar_counts, verification_counts


def render_category_index(cards: list[CardSummary]) -> str:
    field_cards: dict[str, list[CardSummary]] = {
        field_tag: [] for field_tag in FIELD_TAGS
    }
    for card in cards:
        card_fields = [tag for tag in card.tags if tag.startswith("领域/")]
        if not card_fields:
            raise ValueError(f"{card.path}: must have at least one controlled 领域/ tag")
        for field_tag in card_fields:
            if field_tag not in field_cards:
                raise ValueError(f"{card.path}: unknown controlled field tag {field_tag}")
            field_cards[field_tag].append(card)

    active_categories = [
        category
        for category in CATEGORY_GROUPS
        if any(field_cards[f"领域/{field}"] for field in category.fields)
    ]
    indexed_relations = sum(len(entries) for entries in field_cards.values())
    lines = ["<!-- BEGIN GENERATED CATEGORY INDEX -->", ""]
    lines.append(
        f"当前 {len(cards)} 张卡依据受控 `领域/…` TAG 建立了 {indexed_relations} 条索引关系；"
        f"现有 {sum(bool(field_cards[tag]) for tag in FIELD_TAGS)} 个主题入口，"
        f"归入 {len(active_categories)} 个上位分类。"
        "同一卡可进入多个主题入口和上位分类，因此各项数量不能直接相加；"
        "上位分类计数对本分类内的重复卡片去重。"
    )
    lines.extend(["", "### 分类总览", ""])

    for offset in range(0, len(active_categories), 2):
        pair = active_categories[offset : offset + 2]
        headers: list[str] = []
        contents: list[str] = []
        for category in pair:
            category_paths = {
                card.path
                for field in category.fields
                for card in field_cards[f"领域/{field}"]
            }
            headers.append(
                f"[{category.icon} {category.title}（{len(category_paths)} 张）]"
                f"(#{category.slug})"
            )
            field_links = []
            for field in category.fields:
                field_tag = f"领域/{field}"
                count = len(field_cards[field_tag])
                if count:
                    field_links.append(
                        f"[{field_label(field)}（{count}）](#{field_anchor(field_tag)})"
                    )
            contents.append(" · ".join(field_links))
        if len(pair) == 1:
            headers.append("")
            contents.append("")
        lines.extend(
            [
                f"| {headers[0]} | {headers[1]} |",
                "| --- | --- |",
                f"| {contents[0]} | {contents[1]} |",
                "",
            ]
        )

    lines.extend(["### 分类明细", ""])
    for category in active_categories:
        category_cards = {
            card.path
            for field in category.fields
            for card in field_cards[f"领域/{field}"]
        }
        lines.extend(
            [
                f'<a id="{category.slug}"></a>',
                f"#### {category.icon} {category.title}（{len(category_cards)} 张）",
                "",
            ]
        )
        for field in category.fields:
            field_tag = f"领域/{field}"
            entries = sorted(
                field_cards[field_tag],
                key=lambda card: (card.title.casefold(), card.path.name),
            )
            if not entries:
                continue
            lines.extend(
                [
                    f'<a id="{field_anchor(field_tag)}"></a>',
                    "<details>",
                    f"<summary><strong>{field_label(field)}</strong>（{len(entries)} 张）</summary>",
                    "",
                ]
            )
            lines.extend(
                f"- [{card.title}](<./{card.path.name}>)" for card in entries
            )
            lines.extend(["", "</details>", ""])

    lines.append("<!-- END GENERATED CATEGORY INDEX -->")
    return "\n".join(lines)


def expected_text(
    readme_text: str,
    readme_path: Path,
    total: int,
    seminar_counts: Counter[str],
    verification_counts: Counter[str],
    category_index: str,
    update_date: str | None,
) -> str:
    mapping = seminar_map(readme_path)
    ordered_tags = list(dict.fromkeys(mapping.values()))
    ordered_tags.extend(sorted(set(seminar_counts) - set(ordered_tags)))
    if not ordered_tags:
        raise ValueError("README contains no seminar browse mappings")

    details = "，".join(
        f"带 `{tag}` 标签的有 {seminar_counts[tag]} 张" for tag in ordered_tags
    )
    clause = f"共收录 {total} 张知识卡；其中{details}。"
    text, replacements = COUNT_CLAUSE_RE.subn(clause, readme_text, count=1)
    if replacements != 1:
        raise ValueError("could not locate the README card-count clause")

    text, replacements = CATEGORY_INDEX_RE.subn(
        lambda _match: category_index,
        text,
        count=1,
    )
    if replacements != 1:
        raise ValueError("could not locate the generated category-index block")

    for status in ("已核实", "部分准确", "需更正", "解释性延伸"):
        pattern = re.compile(rf"(- `{re.escape(status)}`：)\d+( 张[；。])")
        text, replacements = pattern.subn(
            rf"\g<1>{verification_counts[status]}\g<2>",
            text,
            count=1,
        )
        if replacements != 1:
            raise ValueError(f"could not locate README verification count: {status}")

    if update_date is not None:
        try:
            date.fromisoformat(update_date)
        except ValueError as error:
            raise ValueError("--date must use a real YYYY-MM-DD date") from error
        text, replacements = re.subn(
            r"(?m)^updated: \d{4}-\d{2}-\d{2}$",
            f"updated: {update_date}",
            text,
            count=1,
        )
        if replacements != 1:
            raise ValueError("could not locate README updated property")
    return text


def main() -> int:
    args = arguments()
    repo_root = args.repo_root.resolve()
    knowledge_dir = (
        args.knowledge_dir
        if args.knowledge_dir.is_absolute()
        else repo_root / args.knowledge_dir
    )
    readme = knowledge_dir / "README.md"
    if not readme.is_file():
        print(f"ERROR knowledge-base README not found: {readme}", file=sys.stderr)
        return 2

    try:
        current = readme.read_text(encoding="utf-8")
        cards = load_cards(knowledge_dir)
        seminar_counts, verification_counts = load_counts(cards)
        total = len(cards)
        expected = expected_text(
            current,
            readme,
            total,
            seminar_counts,
            verification_counts,
            render_category_index(cards),
            args.date if args.write else None,
        )
    except (OSError, ValueError) as error:
        print(f"ERROR {error}", file=sys.stderr)
        return 2

    if args.check:
        if current != expected:
            print(
                "README statistics are out of sync. Run this script with --write.",
                file=sys.stderr,
            )
            return 1
        print(
            f"README statistics match {total} cards "
            f"({sum(verification_counts.values())} verification records)."
        )
        return 0

    if current == expected:
        print("README statistics already synchronized.")
        return 0
    readme.write_text(expected, encoding="utf-8")
    print(f"Updated README statistics for {total} cards.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
