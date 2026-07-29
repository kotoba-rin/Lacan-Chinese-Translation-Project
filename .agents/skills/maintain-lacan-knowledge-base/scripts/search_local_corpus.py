#!/usr/bin/env python3
"""Search knowledge cards, translations, links, tags, and French originals."""

from __future__ import annotations

import argparse
from collections import defaultdict
from dataclasses import dataclass
from difflib import SequenceMatcher
import json
from pathlib import Path
import re
import sys
import unicodedata

from validate_knowledge_base import (
    KNOWLEDGE_RELATION_RE,
    SEGMENT_ID_RE,
    TRANSLATION_RELATION_RE,
    parse_frontmatter,
)


PRIMARY_ID_RE = re.compile(
    r"<!--\s*id:\s*(s\d+[a-z]?-\d{2}-\d{4})\s*-->",
    re.IGNORECASE,
)
IDS_RE = re.compile(r"<!--\s*ids:\s*([^>]+?)\s*-->", re.IGNORECASE)
CJK_RE = re.compile(r"[\u3400-\u9fff]")
MARKDOWN_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)


@dataclass(frozen=True)
class Card:
    path: str
    title: str
    tags: tuple[str, ...]
    text: str
    card_links: tuple[str, ...]
    translation_links: tuple[str, ...]


@dataclass(frozen=True)
class Segment:
    key: str
    path: str
    segment_id: str
    aliases: tuple[str, ...]
    line: int
    text: str


@dataclass(frozen=True)
class OriginalHit:
    path: str
    line: int
    segment_id: str | None
    text: str
    quality: str
    query: str


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path("."))
    parser.add_argument("--query", action="append", default=[], help="Literal or fuzzy term.")
    parser.add_argument("--card", action="append", default=[], help="Card title, filename, or path.")
    parser.add_argument("--tag", action="append", default=[], help="Exact, prefix, or fuzzy tag.")
    parser.add_argument(
        "--segment",
        action="append",
        default=[],
        help="Segment ID or texts/.../translation/file.md#segment-id.",
    )
    parser.add_argument(
        "--include-originals",
        action="store_true",
        help="Also search every texts/*/original/*.md file with --query terms.",
    )
    parser.add_argument(
        "--exact",
        action="store_true",
        help="Disable fuzzy query and card-name matching.",
    )
    parser.add_argument("--depth", type=int, choices=(0, 1, 2), default=1)
    parser.add_argument("--limit", type=int, default=12)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold()
    return "".join(character for character in value if character.isalnum())


def fuzzy_rg_pattern(query: str, max_gap: int = 2) -> str:
    """Return the first-pass rg pattern used for short Chinese concept variants."""
    normalized = normalize(query)
    if len(normalized) >= 3 and all(CJK_RE.fullmatch(character) for character in normalized):
        gap = f".{{0,{max_gap}}}"
        return gap.join(re.escape(character) for character in normalized)
    return re.escape(query)


def ordered_gap_match(needle: str, haystack: str, max_gap: int = 2) -> bool:
    if len(needle) < 3 or CJK_RE.search(needle) is None:
        return False
    position = haystack.find(needle[0])
    if position < 0:
        return False
    for character in needle[1:]:
        start = position + 1
        stop = min(len(haystack), start + max_gap + 1)
        found = haystack.find(character, start, stop)
        if found < 0:
            return False
        position = found
    return True


def close_window_match(needle: str, haystack: str) -> bool:
    if len(needle) < 4 or len(haystack) < 3:
        return False
    min_size = max(3, len(needle) - 1)
    max_size = min(len(haystack), len(needle) + 1)
    for size in range(min_size, max_size + 1):
        for start in range(0, len(haystack) - size + 1):
            ratio = SequenceMatcher(None, needle, haystack[start : start + size]).ratio()
            if ratio >= 0.8:
                return True
    return False


def match_quality(
    query: str,
    text: str,
    *,
    fuzzy: bool,
    allow_edit_distance: bool = False,
) -> str | None:
    if query.casefold() in text.casefold():
        return "literal"
    needle = normalize(query)
    haystack = normalize(text)
    if not needle:
        return None
    if needle in haystack:
        return "normalized"
    if not fuzzy:
        return None
    if ordered_gap_match(needle, haystack):
        return "fuzzy-gap"
    if allow_edit_distance and close_window_match(needle, haystack):
        return "fuzzy-spelling"
    return None


def relation_lines(lines: list[str]) -> list[str]:
    try:
        index = lines.index("## 关联")
    except ValueError:
        return []
    return [line for line in lines[index + 1 :] if line.strip()]


def load_cards(repo_root: Path) -> dict[str, Card]:
    cards: dict[str, Card] = {}
    for path in sorted((repo_root / "知识库").glob("*.md")):
        if path.name == "README.md":
            continue
        parsed = parse_frontmatter(path)
        title = parsed.metadata.get("title")
        tags = parsed.metadata.get("tags")
        if not isinstance(title, str) or not isinstance(tags, list):
            continue
        card_links: list[str] = []
        translation_links: list[str] = []
        for line in relation_lines(parsed.lines):
            card_match = KNOWLEDGE_RELATION_RE.fullmatch(line)
            if card_match:
                card_links.append(card_match.group("path"))
                continue
            translation_match = TRANSLATION_RELATION_RE.fullmatch(line)
            if translation_match:
                translation_links.append(
                    f"{translation_match.group('path')}#{translation_match.group('anchor')}"
                )
        relative = path.relative_to(repo_root).as_posix()
        cards[relative] = Card(
            path=relative,
            title=title,
            tags=tuple(tags),
            text=path.read_text(encoding="utf-8"),
            card_links=tuple(card_links),
            translation_links=tuple(translation_links),
        )
    return cards


def segment_blocks(repo_root: Path, section: str) -> dict[str, Segment]:
    segments: dict[str, Segment] = {}
    pattern = f"texts/*/{section}/*.md"
    for path in sorted(repo_root.glob(pattern)):
        text = path.read_text(encoding="utf-8")
        markers = list(PRIMARY_ID_RE.finditer(text))
        relative = path.relative_to(repo_root).as_posix()
        for index, marker in enumerate(markers):
            end = markers[index + 1].start() if index + 1 < len(markers) else len(text)
            block = text[marker.start() : end]
            primary = marker.group(1)
            aliases = {primary}
            for ids_match in IDS_RE.finditer(block):
                aliases.update(
                    value
                    for value in re.split(r"[\s,]+", ids_match.group(1).strip())
                    if SEGMENT_ID_RE.fullmatch(value)
                )
            line = text.count("\n", 0, marker.start()) + 1
            key = f"{relative}#{primary}"
            segment = Segment(
                key=key,
                path=relative,
                segment_id=primary,
                aliases=tuple(sorted(aliases)),
                line=line,
                text=block,
            )
            for alias in aliases:
                segments[f"{relative}#{alias}"] = segment
    return segments


def concise(value: str, limit: int = 260) -> str:
    value = MARKDOWN_COMMENT_RE.sub(" ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value if len(value) <= limit else value[: limit - 1] + "…"


def add_score(
    scores: dict[str, float],
    reasons: dict[str, set[str]],
    key: str,
    amount: float,
    reason: str,
) -> None:
    if reason in reasons[key]:
        return
    scores[key] += amount
    reasons[key].add(reason)


def tag_weight(tag: str, frequency: int) -> float:
    if tag.startswith("研讨班"):
        return 0.0
    base = 1.0 if tag.startswith("领域/") else 3.0
    if frequency > 20:
        return base * 0.25
    if frequency > 8:
        return base * 0.5
    return base


def original_hits(
    repo_root: Path,
    queries: list[str],
    fuzzy: bool,
) -> list[OriginalHit]:
    hits: list[OriginalHit] = []
    for path in sorted(repo_root.glob("texts/*/original/*.md")):
        current_id: str | None = None
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            marker = PRIMARY_ID_RE.search(line)
            if marker:
                current_id = marker.group(1)
            for query in queries:
                quality = match_quality(query, line, fuzzy=fuzzy)
                if quality:
                    hits.append(
                        OriginalHit(
                            path=path.relative_to(repo_root).as_posix(),
                            line=number,
                            segment_id=current_id,
                            text=concise(line),
                            quality=quality,
                            query=query,
                        )
                    )
                    break
    order = {"literal": 0, "normalized": 1, "fuzzy-gap": 2, "fuzzy-spelling": 3}
    return sorted(hits, key=lambda hit: (order[hit.quality], hit.path, hit.line))


def search(args: argparse.Namespace) -> dict[str, object]:
    if not (args.query or args.card or args.tag or args.segment):
        raise ValueError("provide at least one --query, --card, --tag, or --segment")
    if args.limit < 1:
        raise ValueError("--limit must be positive")

    repo_root = args.repo_root.resolve()
    fuzzy = not args.exact
    cards = load_cards(repo_root)
    translations = segment_blocks(repo_root, "translation")

    tag_to_cards: dict[str, set[str]] = defaultdict(set)
    segment_to_cards: dict[str, set[str]] = defaultdict(set)
    adjacency: dict[str, set[str]] = defaultdict(set)
    for card in cards.values():
        for tag in card.tags:
            tag_to_cards[tag].add(card.path)
        for segment in card.translation_links:
            segment_to_cards[segment].add(card.path)
        for target in card.card_links:
            if target in cards:
                adjacency[card.path].add(target)
                adjacency[target].add(card.path)

    card_scores: dict[str, float] = defaultdict(float)
    card_reasons: dict[str, set[str]] = defaultdict(set)
    segment_scores: dict[str, float] = defaultdict(float)
    segment_reasons: dict[str, set[str]] = defaultdict(set)
    direct_cards: set[str] = set()
    direct_segments: set[str] = set()

    for query in args.query:
        for card in cards.values():
            quality = match_quality(
                query,
                card.title,
                fuzzy=fuzzy,
                allow_edit_distance=True,
            )
            if quality:
                add_score(card_scores, card_reasons, card.path, 20.0, f"标题 {quality}: {query}")
                direct_cards.add(card.path)
            tag_quality = match_quality(
                query,
                " ".join(card.tags),
                fuzzy=fuzzy,
                allow_edit_distance=True,
            )
            if tag_quality:
                add_score(card_scores, card_reasons, card.path, 12.0, f"TAG {tag_quality}: {query}")
                direct_cards.add(card.path)
            body_quality = match_quality(query, card.text, fuzzy=fuzzy)
            if body_quality:
                amount = 4.0 if body_quality in {"literal", "normalized"} else 2.0
                add_score(card_scores, card_reasons, card.path, amount, f"正文 {body_quality}: {query}")
                direct_cards.add(card.path)

        seen_segments: set[str] = set()
        for segment in translations.values():
            if segment.key in seen_segments:
                continue
            seen_segments.add(segment.key)
            quality = match_quality(query, segment.text, fuzzy=fuzzy)
            if not quality:
                continue
            amount = 6.0 if quality in {"literal", "normalized"} else 3.0
            add_score(
                segment_scores,
                segment_reasons,
                segment.key,
                amount,
                f"译文 {quality}: {query}",
            )
            direct_segments.add(segment.key)
            linked_cards: set[str] = set()
            for alias in segment.aliases:
                linked_cards.update(
                    segment_to_cards.get(f"{segment.path}#{alias}", set())
                )
            for card_path in linked_cards:
                add_score(
                    card_scores,
                    card_reasons,
                    card_path,
                    4.0,
                    f"关联译文命中: {segment.segment_id}",
                )
                direct_cards.add(card_path)

    for tag_query in args.tag:
        for tag, paths in tag_to_cards.items():
            quality = match_quality(
                tag_query,
                tag,
                fuzzy=fuzzy,
                allow_edit_distance=True,
            )
            prefix = tag == tag_query or tag.startswith(tag_query.rstrip("/") + "/")
            if not quality and not prefix:
                continue
            reason = "TAG exact/prefix" if prefix else f"TAG {quality}"
            for path in paths:
                add_score(card_scores, card_reasons, path, 10.0, f"{reason}: {tag_query}")
                direct_cards.add(path)

    for card_query in args.card:
        for card in cards.values():
            fields = f"{card.path} {Path(card.path).stem} {card.title}"
            quality = match_quality(
                card_query,
                fields,
                fuzzy=fuzzy,
                allow_edit_distance=True,
            )
            if quality:
                add_score(card_scores, card_reasons, card.path, 12.0, f"卡片种子 {quality}: {card_query}")
                direct_cards.add(card.path)

    unique_translation_segments = {segment.key: segment for segment in translations.values()}
    for segment_query in args.segment:
        for key, segment in unique_translation_segments.items():
            if key == segment_query or key.endswith(f"#{segment_query}"):
                add_score(segment_scores, segment_reasons, key, 12.0, f"分段种子: {segment_query}")
                direct_segments.add(key)
                linked_cards: set[str] = set()
                for alias in segment.aliases:
                    linked_cards.update(
                        segment_to_cards.get(f"{segment.path}#{alias}", set())
                    )
                for path in linked_cards:
                    add_score(
                        card_scores,
                        card_reasons,
                        path,
                        10.0,
                        f"反向关联分段: {segment.segment_id}",
                    )
                    direct_cards.add(path)

    for segment_key in direct_segments:
        segment = unique_translation_segments.get(segment_key)
        if segment is None:
            continue
        linked_cards: set[str] = set()
        for alias in segment.aliases:
            linked_cards.update(segment_to_cards.get(f"{segment.path}#{alias}", set()))
        for path in linked_cards:
            add_score(
                card_scores,
                card_reasons,
                path,
                5.0,
                f"译文反向链接: {segment.segment_id}",
            )
            direct_cards.add(path)

    frontier = set(direct_cards)
    visited = set(direct_cards)
    for depth in range(args.depth):
        next_frontier: set[str] = set()
        factor = 1.0 / (depth + 1)
        for path in frontier:
            card = cards[path]
            for neighbor in adjacency.get(path, set()):
                add_score(card_scores, card_reasons, neighbor, 8.0 * factor, f"显式卡片链接: {card.title}")
                if neighbor not in visited:
                    next_frontier.add(neighbor)
            for segment_key in card.translation_links:
                for neighbor in segment_to_cards.get(segment_key, set()):
                    if neighbor == path:
                        continue
                    add_score(
                        card_scores,
                        card_reasons,
                        neighbor,
                        6.0 * factor,
                        f"共享译文分段: {segment_key.rsplit('#', 1)[-1]}",
                    )
                    if neighbor not in visited:
                        next_frontier.add(neighbor)
            for tag in card.tags:
                weight = tag_weight(tag, len(tag_to_cards[tag])) * factor
                if weight == 0:
                    continue
                for neighbor in tag_to_cards[tag]:
                    if neighbor == path:
                        continue
                    add_score(card_scores, card_reasons, neighbor, weight, f"共享 TAG: {tag}")
                    if neighbor not in visited:
                        next_frontier.add(neighbor)
        visited.update(next_frontier)
        frontier = next_frontier

    ranked_cards = sorted(
        (cards[path] for path, score in card_scores.items() if score > 0),
        key=lambda card: (-card_scores[card.path], card.title),
    )[: args.limit]

    for card in ranked_cards:
        for segment_key in card.translation_links:
            segment = translations.get(segment_key)
            if segment is None:
                continue
            add_score(
                segment_scores,
                segment_reasons,
                segment.key,
                1.0,
                f"关联自知识卡: {card.title}",
            )

    ranked_segments = sorted(
        (
            unique_translation_segments[key]
            for key, score in segment_scores.items()
            if score > 0 and key in unique_translation_segments
        ),
        key=lambda segment: (-segment_scores[segment.key], segment.path, segment.line),
    )[: args.limit]

    french_hits = (
        original_hits(repo_root, args.query, fuzzy)[: args.limit]
        if args.include_originals and args.query
        else []
    )

    return {
        "query_plan": [
            {
                "query": query,
                "mode": "exact" if args.exact else "fuzzy-first",
                "fuzzy_regex": re.escape(query) if args.exact else fuzzy_rg_pattern(query),
            }
            for query in args.query
        ],
        "cards": [
            {
                "title": card.title,
                "path": card.path,
                "score": round(card_scores[card.path], 2),
                "reasons": sorted(card_reasons[card.path]),
                "tags": list(card.tags),
                "card_links": list(card.card_links),
                "translation_links": list(card.translation_links),
            }
            for card in ranked_cards
        ],
        "translation_segments": [
            {
                "path": segment.path,
                "segment_id": segment.segment_id,
                "line": segment.line,
                "score": round(segment_scores[segment.key], 2),
                "reasons": sorted(segment_reasons[segment.key]),
                "snippet": concise(segment.text),
            }
            for segment in ranked_segments
        ],
        "original_hits": [
            {
                "path": hit.path,
                "line": hit.line,
                "segment_id": hit.segment_id,
                "quality": hit.quality,
                "query": hit.query,
                "snippet": hit.text,
            }
            for hit in french_hits
        ],
    }


def print_text(result: dict[str, object]) -> None:
    query_plan = result["query_plan"]
    cards = result["cards"]
    segments = result["translation_segments"]
    originals = result["original_hits"]

    if query_plan:
        print("查询计划")
        for item in query_plan:
            print(f"- {item['query']} ({item['mode']}): rg -n -- '{item['fuzzy_regex']}'")
        print()

    print(f"知识卡候选（{len(cards)}）")
    for index, item in enumerate(cards, start=1):
        print(f"{index}. {item['title']} [{item['score']}]")
        print(f"   path: {item['path']}")
        print(f"   reasons: {'; '.join(item['reasons'])}")
        print(f"   tags: {', '.join(item['tags'])}")
        if item["card_links"]:
            print(f"   card-links: {', '.join(item['card_links'])}")
        if item["translation_links"]:
            print(f"   translation-links: {', '.join(item['translation_links'])}")

    print(f"\n译文分段候选（{len(segments)}）")
    for item in segments:
        print(f"- {item['path']}#{item['segment_id']}:{item['line']} [{item['score']}]")
        print(f"  reasons: {'; '.join(item['reasons'])}")
        print(f"  {item['snippet']}")

    print(f"\n法语原文命中（{len(originals)}）")
    for item in originals:
        anchor = f"#{item['segment_id']}" if item["segment_id"] else ""
        print(f"- {item['path']}{anchor}:{item['line']} ({item['quality']}: {item['query']})")
        print(f"  {item['snippet']}")


def main() -> int:
    args = arguments()
    try:
        result = search(args)
    except (OSError, ValueError) as error:
        print(f"Search failed: {error}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print_text(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
