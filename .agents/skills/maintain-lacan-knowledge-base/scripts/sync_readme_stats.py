#!/usr/bin/env python3
"""Check or synchronize knowledge-base statistics in 知识库/README.md."""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import date
from pathlib import Path
import re
import sys

from validate_knowledge_base import (
    VERIFICATION_VALUES,
    parse_frontmatter,
    seminar_map,
)


COUNT_CLAUSE_RE = re.compile(
    r"共收录 \d+ 张知识卡；其中.*?。(?=同一卡片可以关联多个研讨班)"
)


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


def load_counts(knowledge_dir: Path) -> tuple[int, Counter[str], Counter[str]]:
    seminar_counts: Counter[str] = Counter()
    verification_counts: Counter[str] = Counter()
    cards = sorted(
        path for path in knowledge_dir.glob("*.md") if path.name != "README.md"
    )
    for path in cards:
        card = parse_frontmatter(path)
        tags = card.metadata.get("tags")
        verification = card.metadata.get("verification")
        if not isinstance(tags, list) or verification not in VERIFICATION_VALUES:
            raise ValueError(f"{path}: invalid metadata; run validate_knowledge_base.py")
        seminar_counts.update(tag for tag in tags if tag.startswith("研讨班"))
        verification_counts[verification] += 1
    return len(cards), seminar_counts, verification_counts


def expected_text(
    readme_text: str,
    readme_path: Path,
    total: int,
    seminar_counts: Counter[str],
    verification_counts: Counter[str],
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
        total, seminar_counts, verification_counts = load_counts(knowledge_dir)
        expected = expected_text(
            current,
            readme,
            total,
            seminar_counts,
            verification_counts,
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
