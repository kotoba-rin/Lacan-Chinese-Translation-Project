#!/usr/bin/env python3
"""Validate Lacan project knowledge-card structure and local links."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import date
from pathlib import Path
import re
import sys
from typing import Iterable


REQUIRED_KEYS = ["title", "type", "verification", "tags", "verified_at"]
VERIFICATION_VALUES = {"已核实", "部分准确", "需更正", "解释性延伸"}
FORBIDDEN_CARD_TAGS = {"知识卡片", "核实", *VERIFICATION_VALUES}
TAG_RE = re.compile(r"^[\w/-]+$", re.UNICODE)
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SEGMENT_ID_RE = re.compile(r"^s\d+[a-z]?-\d{2}-\d{4}$", re.IGNORECASE)
TRANSLATION_RELATION_RE = re.compile(
    r"^\[\[(?P<path>texts/[^#|\]]+/translation/[^#|\]]+\.md)"
    r"#(?P<anchor>[^|\]]+)\|(?P<label>[^\]]+)\]\]$"
)
KNOWLEDGE_RELATION_RE = re.compile(
    r"^\[\[(?P<path>知识库/[^#|\]]+\.md)\|(?P<label>[^\]]+)\]\]$"
)
LOCAL_LINK_RE = re.compile(
    r"\[\[(?P<path>texts/[^#|\]]+\.md)"
    r"(?:#(?P<anchor>[^|\]]+))?\|[^\]]+\]\]"
)
ID_COMMENT_RE = re.compile(r"<!--\s*ids?:\s*([^>]+?)\s*-->", re.IGNORECASE)
LANGUAGE_NOTE_RE = re.compile(r"（[^）]*(?:文|语)[^）]*）")
SEMINAR_BROWSE_RE = re.compile(
    r"^- `#(?P<tag>研讨班[^`]+)`：`texts/(?P<slug>[^/]+)/translation/`$"
)


@dataclass
class ParsedCard:
    path: Path
    metadata: dict[str, str | list[str]]
    lines: list[str]
    frontmatter_end: int


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "paths",
        nargs="*",
        type=Path,
        help="Optional card paths. Defaults to every knowledge card.",
    )
    parser.add_argument("--repo-root", type=Path, default=Path("."))
    parser.add_argument("--knowledge-dir", type=Path, default=Path("知识库"))
    parser.add_argument(
        "--require-card-links",
        action="store_true",
        help="Require every selected card to link at least one other knowledge card.",
    )
    return parser.parse_args()


def unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def parse_frontmatter(path: Path) -> ParsedCard:
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0] != "---":
        raise ValueError("missing opening YAML delimiter")
    try:
        end = lines.index("---", 1)
    except ValueError as error:
        raise ValueError("missing closing YAML delimiter") from error

    metadata: dict[str, str | list[str]] = {}
    active_list: str | None = None
    for number, line in enumerate(lines[1:end], start=2):
        if line.startswith("  - "):
            if active_list is None:
                raise ValueError(f"line {number}: list item without a list key")
            items = metadata[active_list]
            if not isinstance(items, list):
                raise ValueError(f"line {number}: invalid list state")
            items.append(unquote(line[4:].strip()))
            continue
        match = re.fullmatch(r"([a-z_]+):(.*)", line)
        if match is None:
            raise ValueError(f"line {number}: unsupported YAML syntax")
        key, raw_value = match.groups()
        if key in metadata:
            raise ValueError(f"line {number}: duplicate key {key}")
        value = raw_value.strip()
        if value:
            metadata[key] = unquote(value)
            active_list = None
        else:
            metadata[key] = []
            active_list = key
    return ParsedCard(path=path, metadata=metadata, lines=lines, frontmatter_end=end)


def seminar_map(readme: Path) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for line in readme.read_text(encoding="utf-8").splitlines():
        match = SEMINAR_BROWSE_RE.fullmatch(line)
        if match:
            mapping[match.group("slug")] = match.group("tag")
    return mapping


def segment_ids(path: Path, cache: dict[Path, set[str]]) -> set[str]:
    if path not in cache:
        found: set[str] = set()
        text = path.read_text(encoding="utf-8")
        for match in ID_COMMENT_RE.finditer(text):
            found.update(
                value
                for value in re.split(r"[\s,]+", match.group(1).strip())
                if SEGMENT_ID_RE.fullmatch(value)
            )
        cache[path] = found
    return cache[path]


def local_link_errors(
    line: str,
    repo_root: Path,
    anchor_cache: dict[Path, set[str]],
) -> list[str]:
    errors: list[str] = []
    for match in LOCAL_LINK_RE.finditer(line):
        relative = Path(match.group("path"))
        target = repo_root / relative
        if not target.is_file():
            errors.append(f"local source path does not exist: {relative.as_posix()}")
            continue
        anchor = match.group("anchor")
        if anchor and anchor not in segment_ids(target, anchor_cache):
            errors.append(
                f"local source anchor {anchor} does not exist in {relative.as_posix()}"
            )
    return errors


def validate_card(
    card: ParsedCard,
    repo_root: Path,
    knowledge_dir: Path,
    seminar_tags: dict[str, str],
    anchor_cache: dict[Path, set[str]],
    card_cache: dict[Path, ParsedCard],
    require_card_links: bool,
) -> list[str]:
    errors: list[str] = []
    metadata = card.metadata

    if list(metadata) != REQUIRED_KEYS:
        errors.append(
            "frontmatter keys/order must be exactly: " + ", ".join(REQUIRED_KEYS)
        )
    if metadata.get("type") != "knowledge-card":
        errors.append("type must be knowledge-card")

    title = metadata.get("title")
    if not isinstance(title, str) or not title.strip():
        errors.append("title must be a non-empty scalar")

    verification = metadata.get("verification")
    if verification not in VERIFICATION_VALUES:
        errors.append(
            "verification must be one of: " + ", ".join(sorted(VERIFICATION_VALUES))
        )

    verified_at = metadata.get("verified_at")
    if not isinstance(verified_at, str) or not DATE_RE.fullmatch(verified_at):
        errors.append("verified_at must use YYYY-MM-DD")
    else:
        try:
            date.fromisoformat(verified_at)
        except ValueError:
            errors.append("verified_at is not a real calendar date")

    tags = metadata.get("tags")
    if not isinstance(tags, list):
        errors.append("tags must be a YAML list")
        tags = []
    else:
        if not 3 <= len(tags) <= 5:
            errors.append("tags must contain 3 to 5 entries")
        if len(tags) != len(set(tags)):
            errors.append("tags must not contain duplicates")
        for tag in tags:
            if not tag or not TAG_RE.fullmatch(tag):
                errors.append(f"tag contains unsupported characters: {tag!r}")
            if tag in FORBIDDEN_CARD_TAGS or tag.startswith("索引/"):
                errors.append(f"card must not use workflow/index tag: {tag}")

    headings = [
        (index, line)
        for index, line in enumerate(card.lines[card.frontmatter_end + 1 :], start=card.frontmatter_end + 1)
        if line.startswith("#")
    ]
    heading_names = [line for _, line in headings]
    if heading_names != ["## 来源", "## 关联"]:
        errors.append("body headings must be exactly one ## 来源 followed by one ## 关联")
        return errors

    source_index = headings[0][0]
    relation_index = headings[1][0]
    body = [line for line in card.lines[card.frontmatter_end + 1 : source_index] if line.strip()]
    if not body:
        errors.append("knowledge body must not be empty")

    source_lines = [
        line for line in card.lines[source_index + 1 : relation_index] if line.strip()
    ]
    if not source_lines:
        errors.append("## 来源 must contain at least one source")
    for line in source_lines:
        if not line.startswith("- "):
            errors.append("each non-empty source line must start with '- '")
            continue
        is_local_original = "[[texts/" in line and "/original/" in line
        if LANGUAGE_NOTE_RE.search(line) is None and not is_local_original:
            errors.append(f"source must identify its language: {line}")
        errors.extend(local_link_errors(line, repo_root, anchor_cache))

    relation_lines = [line for line in card.lines[relation_index + 1 :] if line.strip()]
    if not relation_lines:
        errors.append("## 关联 must contain at least one relation")

    seen_relations: set[str] = set()
    relation_tag_set: set[str] = set()
    translation_count = 0
    card_link_count = 0
    saw_translation = False
    for line in relation_lines:
        translation_match = TRANSLATION_RELATION_RE.fullmatch(line)
        knowledge_match = KNOWLEDGE_RELATION_RE.fullmatch(line)
        if translation_match is None and knowledge_match is None:
            errors.append(f"invalid relation link: {line}")
            continue

        if line in seen_relations:
            errors.append(f"duplicate relation: {line}")
        seen_relations.add(line)

        if knowledge_match is not None:
            card_link_count += 1
            if saw_translation:
                errors.append("knowledge-card links must precede translation links")
            relative_text = knowledge_match.group("path")
            label = knowledge_match.group("label")
            relative = Path(relative_text)
            target = (repo_root / relative).resolve()
            if target == card.path.resolve():
                errors.append("knowledge card must not link to itself")
                continue
            if target.parent != knowledge_dir.resolve():
                errors.append(f"knowledge relation must stay inside 知识库/: {relative_text}")
                continue
            if not target.is_file():
                errors.append(f"knowledge relation path does not exist: {relative_text}")
                continue
            try:
                target_card = card_cache.setdefault(target, parse_frontmatter(target))
            except (OSError, ValueError) as error:
                errors.append(f"could not read related knowledge card {relative_text}: {error}")
                continue
            target_title = target_card.metadata.get("title")
            if label != target_title:
                errors.append(
                    f"knowledge relation label must equal target title {target_title!r}: {line}"
                )
            current_relative = card.path.resolve().relative_to(repo_root).as_posix()
            reciprocal = any(
                (match := KNOWLEDGE_RELATION_RE.fullmatch(target_line))
                and match.group("path") == current_relative
                for target_line in target_card.lines
            )
            if not reciprocal:
                errors.append(f"knowledge relation is not reciprocal in {relative_text}")
            continue

        match = translation_match
        assert match is not None
        saw_translation = True
        translation_count += 1
        relative_text = match.group("path")
        anchor = match.group("anchor")
        label = match.group("label")
        relative = Path(relative_text)
        if label != anchor:
            errors.append(f"relation label must equal anchor: {line}")
        if not SEGMENT_ID_RE.fullmatch(anchor):
            errors.append(f"invalid relation segment ID: {anchor}")

        target = repo_root / relative
        if not target.is_file():
            errors.append(f"relation path does not exist: {relative_text}")
        elif anchor not in segment_ids(target, anchor_cache):
            errors.append(f"relation anchor {anchor} does not exist in {relative_text}")

        parts = relative.parts
        if len(parts) >= 2:
            slug = parts[1]
            expected_tag = seminar_tags.get(slug)
            if expected_tag is None:
                errors.append(
                    f"README has no seminar browse mapping for relation slug: {slug}"
                )
            else:
                relation_tag_set.add(expected_tag)

    if translation_count == 0:
        errors.append("## 关联 must contain at least one translation link")
    if require_card_links and card_link_count == 0:
        errors.append("## 关联 must contain at least one related knowledge-card link")

    declared_seminar_tags = {tag for tag in tags if tag.startswith("研讨班")}
    if declared_seminar_tags != relation_tag_set:
        missing = sorted(relation_tag_set - declared_seminar_tags)
        extra = sorted(declared_seminar_tags - relation_tag_set)
        if missing:
            errors.append("missing seminar tags for relations: " + ", ".join(missing))
        if extra:
            errors.append("seminar tags without matching relations: " + ", ".join(extra))
    return errors


def resolve_cards(args: argparse.Namespace, knowledge_dir: Path) -> list[Path]:
    if args.paths:
        cards = [
            path if path.is_absolute() else args.repo_root / path
            for path in args.paths
        ]
    else:
        cards = sorted(knowledge_dir.glob("*.md"))
    return [path for path in cards if path.name != "README.md"]


def print_errors(path: Path, repo_root: Path, errors: Iterable[str]) -> None:
    try:
        label = path.relative_to(repo_root).as_posix()
    except ValueError:
        label = path.as_posix()
    for error in errors:
        print(f"ERROR {label}: {error}", file=sys.stderr)


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
        seminar_tags = seminar_map(readme)
    except OSError as error:
        print(f"ERROR could not read README: {error}", file=sys.stderr)
        return 2
    if not seminar_tags:
        print("ERROR README contains no seminar browse mappings", file=sys.stderr)
        return 2

    cards = resolve_cards(args, knowledge_dir)
    if not cards:
        print("ERROR no knowledge cards selected", file=sys.stderr)
        return 2

    failures = 0
    anchor_cache: dict[Path, set[str]] = {}
    card_cache: dict[Path, ParsedCard] = {}
    for path in cards:
        if not path.is_file():
            print_errors(path, repo_root, ["card file does not exist"])
            failures += 1
            continue
        try:
            card = parse_frontmatter(path)
        except (OSError, ValueError) as error:
            print_errors(path, repo_root, [str(error)])
            failures += 1
            continue
        card_cache[path.resolve()] = card
        errors = validate_card(
            card,
            repo_root,
            knowledge_dir,
            seminar_tags,
            anchor_cache,
            card_cache,
            args.require_card_links,
        )
        if errors:
            print_errors(path, repo_root, errors)
            failures += 1

    if failures:
        print(
            f"Knowledge-base validation failed: {failures} of {len(cards)} cards have errors.",
            file=sys.stderr,
        )
        return 1
    print(f"Knowledge-base validation passed: {len(cards)} cards.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
