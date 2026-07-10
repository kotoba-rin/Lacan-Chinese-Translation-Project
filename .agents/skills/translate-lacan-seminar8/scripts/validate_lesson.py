#!/usr/bin/env python3
"""Validate one Seminar VIII source/translation pair."""

from __future__ import annotations

import argparse
from collections import Counter
from pathlib import Path
import re
import sys


ID_RE = re.compile(r"<!--\s*id:\s*(s8-\d{2}-\d{4})\s*-->")
MERGED_IDS_RE = re.compile(r"<!--\s*ids:\s*([^>]+?)\s*-->")
SOURCE_NOTE_REF_RE = re.compile(r"\[\^([^\]]+)\]")
SOURCE_NOTE_DEF_RE = re.compile(r"^\[\^([^\]]+)\]:", re.MULTILINE)
NUMBERED_NOTE_RE = re.compile(r"\[注(\d+)\]")
NUMBERED_NOTE_BLOCK_RE = re.compile(r"^>\s*\[注(\d+)\](?:\s|$)", re.MULTILINE)
TRANSLATOR_NOTE_RE = re.compile(r"\[注\]")
TRANSLATOR_NOTE_BLOCK_RE = re.compile(r"^>\s*\[注\](?:\s|$)", re.MULTILINE)
IMAGE_RE = re.compile(r"!\[\[|<img\b|!\[[^\]]*\]\(", re.IGNORECASE)
FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate ID, note, image, and completion invariants for one lesson."
    )
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--translation", required=True, type=Path)
    parser.add_argument(
        "--allow-merged-ids",
        action="store_true",
        help="Allow legacy <!-- ids: ... --> mappings in an existing translation.",
    )
    return parser.parse_args()


def ordered_unique(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))


def parse_segments(text: str) -> tuple[list[str], dict[str, str]]:
    matches = list(ID_RE.finditer(text))
    ids = [match.group(1) for match in matches]
    segments: dict[str, str] = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        segments[match.group(1)] = text[match.end() : end]
    return ids, segments


def visible_segment_content(segment: str) -> str:
    without_comments = re.sub(r"<!--.*?-->", "", segment, flags=re.DOTALL)
    return without_comments.strip()


def parse_frontmatter(text: str) -> dict[str, str]:
    match = FRONTMATTER_RE.search(text)
    if not match:
        return {}
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        fields[key.strip()] = value.strip()
    return fields


def source_note_refs(text: str) -> tuple[list[str], set[str]]:
    refs: list[str] = []
    for line in text.splitlines():
        if SOURCE_NOTE_DEF_RE.match(line):
            continue
        refs.extend(SOURCE_NOTE_REF_RE.findall(line))
    definitions = set(SOURCE_NOTE_DEF_RE.findall(text))
    return ordered_unique(refs), definitions


def check_segment_notes(
    segment_id: str,
    source_segment: str,
    translation_segment: str,
    errors: list[str],
) -> None:
    source_refs = ordered_unique(SOURCE_NOTE_REF_RE.findall(source_segment))
    numbered_blocks = NUMBERED_NOTE_BLOCK_RE.findall(translation_segment)
    numbered_all = NUMBERED_NOTE_RE.findall(translation_segment)
    numbered_inline_count = len(numbered_all) - len(numbered_blocks)

    if len(source_refs) != len(numbered_blocks):
        errors.append(
            f"{segment_id}: source footnote references={len(source_refs)}, "
            f"translated numbered note blocks={len(numbered_blocks)}"
        )
    if numbered_blocks and numbered_inline_count < len(numbered_blocks):
        errors.append(f"{segment_id}: numbered note block is missing a body [注N] marker")

    translator_blocks = len(TRANSLATOR_NOTE_BLOCK_RE.findall(translation_segment))
    translator_all = len(TRANSLATOR_NOTE_RE.findall(translation_segment))
    translator_inline = translator_all - translator_blocks
    if translator_inline != translator_blocks:
        errors.append(
            f"{segment_id}: translator-note body markers={translator_inline}, "
            f"blocks={translator_blocks}"
        )

    if numbered_blocks and translator_blocks:
        numbered_positions = [
            match.start() for match in NUMBERED_NOTE_BLOCK_RE.finditer(translation_segment)
        ]
        translator_positions = [
            match.start() for match in TRANSLATOR_NOTE_BLOCK_RE.finditer(translation_segment)
        ]
        if max(numbered_positions) > min(translator_positions):
            errors.append(f"{segment_id}: translator note must follow numbered source notes")

    if ("（原文" in translation_segment or "(原文" in translation_segment) and "/" in translation_segment:
        if translator_inline == 0 or translator_blocks == 0:
            errors.append(
                f"{segment_id}: ambiguous A/B (原文...) wording requires [注] and > [注]"
            )


def validate(args: argparse.Namespace) -> list[str]:
    errors: list[str] = []
    for label, path in (("source", args.source), ("translation", args.translation)):
        if not path.is_file():
            errors.append(f"{label} file not found: {path}")
    if errors:
        return errors

    source = args.source.read_text(encoding="utf-8")
    translation = args.translation.read_text(encoding="utf-8")
    source_body = re.split(r"\n##\s+Notes\s*\n", source, maxsplit=1)[0]

    source_ids, source_segments = parse_segments(source_body)
    translation_ids, translation_segments = parse_segments(translation)

    if not source_ids:
        errors.append("source contains no Seminar VIII paragraph IDs")
    if source_ids != translation_ids:
        errors.append(
            "source and translation IDs differ in count, value, or order "
            f"(source={len(source_ids)}, translation={len(translation_ids)})"
        )
    if len(source_ids) != len(set(source_ids)):
        errors.append("source contains duplicate paragraph IDs")
    if len(translation_ids) != len(set(translation_ids)):
        errors.append("translation contains duplicate paragraph IDs")

    if "<!-- untranslated -->" in translation:
        errors.append("translation still contains <!-- untranslated -->")

    if MERGED_IDS_RE.search(translation) and not args.allow_merged_ids:
        errors.append(
            "translation contains legacy <!-- ids: ... --> mappings; "
            "new one-to-one lessons must not introduce them"
        )

    for segment_id in translation_ids:
        if not visible_segment_content(translation_segments[segment_id]):
            errors.append(f"{segment_id}: empty translation block")
        if segment_id in source_segments:
            check_segment_notes(
                segment_id,
                source_segments[segment_id],
                translation_segments[segment_id],
                errors,
            )

    refs, definitions = source_note_refs(source)
    missing_definitions = [ref for ref in refs if ref not in definitions]
    if missing_definitions:
        errors.append(
            "source footnote references lack definitions: " + ", ".join(missing_definitions)
        )

    numbered_blocks = [int(value) for value in NUMBERED_NOTE_BLOCK_RE.findall(translation)]
    expected_numbers = list(range(1, len(refs) + 1))
    if numbered_blocks != expected_numbers:
        errors.append(
            "translated numbered note blocks must be sequential and match source notes "
            f"(expected={expected_numbers}, actual={numbered_blocks})"
        )
    counts = Counter(int(value) for value in NUMBERED_NOTE_RE.findall(translation))
    for number in expected_numbers:
        if counts[number] < 2:
            errors.append(f"[注{number}] needs both a body marker and a note block")

    frontmatter = parse_frontmatter(translation)
    required_frontmatter = {
        "translation_progress": "100",
        "translation_progress_label": "100.00%",
        "untranslated_count": "0",
    }
    for key, expected in required_frontmatter.items():
        if frontmatter.get(key) != expected:
            errors.append(
                f"frontmatter {key!r} must be {expected!r}, got {frontmatter.get(key)!r}"
            )
    if translation_ids:
        max_id = max(int(segment_id.rsplit("-", 1)[1]) for segment_id in translation_ids)
        if frontmatter.get("max_segment_id") != str(max_id):
            errors.append(
                f"frontmatter 'max_segment_id' must be {max_id}, "
                f"got {frontmatter.get('max_segment_id')!r}"
            )

    source_images = len(IMAGE_RE.findall(source))
    translation_images = len(IMAGE_RE.findall(translation))
    if translation_images < source_images:
        errors.append(
            f"translation has fewer image references than source "
            f"(source={source_images}, translation={translation_images})"
        )

    return errors


def main() -> int:
    args = parse_args()
    errors = validate(args)
    if errors:
        print("Lesson validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    source = args.source.read_text(encoding="utf-8")
    translation = args.translation.read_text(encoding="utf-8")
    ids = ID_RE.findall(translation)
    refs, _ = source_note_refs(source)
    translator_notes = len(TRANSLATOR_NOTE_BLOCK_RE.findall(translation))
    print(
        "Lesson validation passed: "
        f"ids={len(ids)}, source_notes={len(refs)}, "
        f"translator_notes={translator_notes}, images={len(IMAGE_RE.findall(translation))}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
