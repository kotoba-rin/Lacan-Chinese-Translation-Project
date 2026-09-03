#!/usr/bin/env python3
"""Build mdBook input pages from canonical texts.

The texts directory is the editable source of truth:

  texts/index.md
  texts/<seminar>/original/Leçon-xx.md
  texts/<seminar>/translation/Leçon-xx.md
  texts/<seminar>/notes/*.md
  知识库/*.md

This script combines the original French paragraphs and the Chinese
translation blocks into build/<seminar>/Leçon-xx.md. Translation blocks may
declare either a single id:

  <!-- id: s8-01-0001 -->

or a grouped alignment:

  <!-- id: s8-01-0001 -->
  <!-- ids: s8-01-0001 s8-01-0002 -->

Grouped alignments are rendered once with all corresponding original
paragraphs. Each rendered block is ordered as original, translation, notes,
commentary, reading note links, and knowledge-card links. Quote blocks in
translation content are classified as notes when their first visible text
starts with "注"; other quote blocks are rendered as commentary. Reading notes
and knowledge cards are linked back to translation paragraphs by segment ID.
"""

from __future__ import annotations

import argparse
import json
import posixpath
import re
import shutil
from dataclasses import dataclass, field
from html import escape
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
TEXTS_DIR = ROOT / "texts"
TEXTS_INDEX = TEXTS_DIR / "index.md"
KNOWLEDGE_DIR = ROOT / "知识库"
BUILD_DIR = ROOT / "build"

ID_RE = re.compile(r"<!--\s*id:\s*([^>\s]+)\s*-->")
IDS_RE = re.compile(r"<!--\s*ids:\s*([^>]+?)\s*-->")
HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
COMMENTARY_MARKER_RE = re.compile(r"<!--\s*建言\s*-->")
LESSON_FILE_RE = re.compile(r"^(?:Leçon|Lecon|lesson)-(\d+)\.md$", re.IGNORECASE)
CANONICAL_LESSON_PREFIX = "Leçon"
NOTE_HEADING_RE = re.compile(r"^##\s+Notes\s*$", re.MULTILINE)
INLINE_STRONG_RE = re.compile(r"\*\*([^*\n]+?)\*\*")
OBSIDIAN_IMAGE_RE = re.compile(r"!\[\[([^\]\n]+?)\]\]")
OBSIDIAN_WIKI_LINK_RE = re.compile(r"(?<!!)\[\[([^\]\n]+?)\]\]")
READING_NOTE_LINK_LINE_RE = re.compile(
    r"^\s*\[\[\s*notes/[^|\]\n]+(?:\.md)?(?:#[^|\]\n]+)?(?:\|[^\]\n]*)?\]\]\s*$",
    re.IGNORECASE,
)
READING_NOTE_MARKDOWN_LINK_LINE_RE = re.compile(
    r"^\s*\[[^\]\n]*阅读笔记[^\]\n]*\]\(notes/[^)\n]+(?:\.md)?(?:#[^)\n]+)?\)\s*$",
    re.IGNORECASE,
)
NOTES_README_LESSON_LINK_RE = re.compile(
    r"(?P<prefix>\]\()\.\./(?:original|translation)/"
    r"(?P<filename>(?:Leçon|Lecon|lesson)-\d+\.md)"
    r"(?P<fragment>#[^)\s]+)?(?P<suffix>\))",
    re.IGNORECASE,
)
OBSIDIAN_IMAGE_SIZE_RE = re.compile(r"^(\d+)(?:x(\d+))?$", re.IGNORECASE)
INLINE_CODE_SPAN_RE = re.compile(r"(`+)(.*?)(\1)")
SEGMENT_ID_TOKEN_RE = re.compile(r"\bs\d+[a-z]?-\d+-\d+\b", re.IGNORECASE)
SEGMENT_ID_LINK_RE = re.compile(r"^s\d+[a-z]?-(\d+)-\d+$", re.IGNORECASE)
SUMMARY_LINK_RE = re.compile(
    r"^(?P<indent>\s*)-\s+\[(?P<title>.*)\]\((?P<href>[^)]+)\)\s*$"
)
FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*(?:\n|\Z)", re.DOTALL)
FRONTMATTER_TITLE_RE = re.compile(r"^\s*title\s*:\s*(.+?)\s*$", re.MULTILINE)
LEVEL_ONE_HEADING_RE = re.compile(r"^#\s+\S", re.MULTILINE)
ASSET_DIR_NAMES = {"original", "translation", "notes"}
NOTES_DIR_NAME = "notes"
KNOWLEDGE_DIR_NAME = "知识库"


@dataclass
class Paragraph:
    paragraph_id: str
    content: str


@dataclass
class Lesson:
    title: str
    intro: str
    paragraphs: list[Paragraph]
    notes: str = ""


@dataclass
class TranslationEntry:
    anchor_id: str
    paragraph_ids: list[str]
    content: str
    untranslated: bool = False


@dataclass
class RenderedTranslation:
    body: str = ""
    notes: str = ""
    commentary: str = ""


@dataclass(frozen=True)
class ReadingNote:
    source_path: Path
    output_relative_path: Path
    title: str
    segment_ids: list[str]


@dataclass(frozen=True)
class KnowledgeCard:
    source_path: Path
    output_relative_path: Path
    title: str
    segment_ids: list[str]
    verification: str = ""
    verified_at: str = ""
    tags: tuple[str, ...] = ()
    body: str = ""
    card_links: tuple[dict[str, str], ...] = ()
    segment_links: tuple[dict[str, str], ...] = ()


@dataclass
class BuildStats:
    lessons: int = 0
    aligned_blocks: int = 0
    untranslated_blocks: int = 0
    missing_translations: int = 0
    seminars: set[str] = field(default_factory=set)


class DuplicateIdError(ValueError):
    pass


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def clean_block(text: str) -> str:
    return text.strip("\n")


def id_marker_line_number(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def duplicate_id_markers(text: str) -> list[tuple[str, list[int]]]:
    lines_by_id: dict[str, list[int]] = {}
    for match in ID_RE.finditer(text):
        paragraph_id = match.group(1).strip()
        lines_by_id.setdefault(paragraph_id, []).append(id_marker_line_number(text, match.start()))
    return [(paragraph_id, lines) for paragraph_id, lines in lines_by_id.items() if len(lines) > 1]


def validate_unique_id_markers(text: str, path: Path) -> None:
    duplicates = duplicate_id_markers(text)
    if not duplicates:
        return

    details = "; ".join(
        f"{paragraph_id} at lines {', '.join(str(line) for line in lines)}"
        for paragraph_id, lines in duplicates
    )
    raise DuplicateIdError(f"Duplicate segment ID in {path}: {details}")


def validate_unique_id_markers_in_file(path: Path) -> None:
    validate_unique_id_markers(read_text(path), path)


def normalize_source_markdown(text: str, source_path: Path) -> str:
    """Convert Obsidian-only markdown that mdBook cannot render directly."""
    text = convert_obsidian_image_embeds(text, source_path)
    text = convert_obsidian_wiki_links(text, source_path)
    return convert_obsidian_latex_math(text)


def convert_obsidian_wiki_links(text: str, source_path: Path) -> str:
    lines = text.splitlines(keepends=True)
    converted: list[str] = []
    in_fence = False
    fence_marker = ""

    for line in lines:
        stripped = line.lstrip()
        fence_match = re.match(r"(```+|~~~+)", stripped)
        if fence_match:
            marker = fence_match.group(1)
            if not in_fence:
                in_fence = True
                fence_marker = marker[:3]
            elif marker.startswith(fence_marker):
                in_fence = False
                fence_marker = ""
            converted.append(line)
            continue

        if in_fence:
            converted.append(line)
        else:
            converted.append(transform_outside_inline_code(line, lambda segment: convert_wiki_link_segment(segment, source_path)))

    return "".join(converted)


def convert_wiki_link_segment(segment: str, source_path: Path) -> str:
    return OBSIDIAN_WIKI_LINK_RE.sub(lambda match: render_obsidian_wiki_link(match, source_path), segment)


def render_obsidian_wiki_link(match: re.Match[str], source_path: Path) -> str:
    target, label = split_obsidian_wiki_link(match.group(1))
    if not target:
        return match.group(0)

    href = resolve_obsidian_wiki_href(target, source_path)
    if not href:
        return match.group(0)

    return f"[{label or target}]({href})"


def split_obsidian_wiki_link(raw: str) -> tuple[str, str]:
    target, options = split_obsidian_embed(raw)
    label = options[-1] if options else target.split("#", 1)[0].split("/")[-1]
    return target, label


def source_output_relative_path(source_path: Path) -> Path | None:
    try:
        knowledge_relative = source_path.resolve().relative_to(KNOWLEDGE_DIR.resolve())
    except ValueError:
        try:
            knowledge_relative = source_path.relative_to(KNOWLEDGE_DIR)
        except ValueError:
            knowledge_relative = None

    if knowledge_relative is not None:
        return Path(KNOWLEDGE_DIR_NAME) / knowledge_relative

    try:
        parts = source_path.resolve().relative_to(TEXTS_DIR.resolve()).parts
    except ValueError:
        try:
            parts = source_path.relative_to(TEXTS_DIR).parts
        except ValueError:
            return None

    if len(parts) < 2:
        return None

    folder = parts[1]
    if folder in {"original", "translation"} and len(parts) >= 3:
        number = lesson_number(Path(parts[-1]))
        if number is not None:
            return Path(parts[0]) / lesson_filename(number)
    if folder == NOTES_DIR_NAME and len(parts) >= 3:
        relative = Path(*parts[2:])
        if relative.suffix.lower() != ".md":
            relative = relative.with_suffix(".md")
        return Path(parts[0]) / NOTES_DIR_NAME / relative
    if len(parts) == 2 and parts[1] == "glossary.md":
        return Path(parts[0]) / "glossary.md"
    return None


def current_seminar_slug(source_path: Path) -> str:
    try:
        return source_path.resolve().relative_to(TEXTS_DIR.resolve()).parts[0]
    except (ValueError, IndexError):
        try:
            return source_path.relative_to(TEXTS_DIR).parts[0]
        except (ValueError, IndexError):
            return ""


def resolve_obsidian_wiki_href(target: str, source_path: Path) -> str:
    target = target.strip().replace("\\", "/")
    target_path, fragment = split_link_fragment(target)
    segment_match = SEGMENT_ID_LINK_RE.match(target_path.strip())
    if segment_match:
        return relative_href_for_build_paths(
            source_output_relative_path(source_path),
            Path(current_seminar_slug(source_path)) / lesson_filename(int(segment_match.group(1))),
            target_path.lower(),
        )

    target_output = resolve_wiki_target_output_path(target_path, source_path)
    if target_output is None:
        return ""
    return relative_href_for_build_paths(source_output_relative_path(source_path), target_output, fragment)


def split_link_fragment(target: str) -> tuple[str, str]:
    if "#" not in target:
        return target, ""
    path_part, fragment = target.split("#", 1)
    return path_part, fragment


def resolve_wiki_target_output_path(target_path: str, source_path: Path) -> Path | None:
    target_path = target_path.strip().strip("/")
    if not target_path:
        return None

    source_seminar = current_seminar_slug(source_path)
    parts = [part for part in target_path.split("/") if part and part != "."]
    if not parts:
        return None

    if parts[0] == KNOWLEDGE_DIR_NAME and len(parts) >= 2:
        relative = Path(*parts[1:])
        if relative.suffix.lower() != ".md":
            relative = relative.with_suffix(".md")
        return Path(KNOWLEDGE_DIR_NAME) / relative
    if parts[0] == "texts" and len(parts) >= 4:
        seminar = parts[1]
        folder = parts[2]
        rest = parts[3:]
    elif parts[0] == NOTES_DIR_NAME:
        seminar = source_seminar
        folder = NOTES_DIR_NAME
        rest = parts[1:]
    elif len(parts) >= 2 and parts[0] in {"original", "translation", NOTES_DIR_NAME}:
        seminar = source_seminar
        folder = parts[0]
        rest = parts[1:]
    else:
        seminar = source_seminar
        folder = NOTES_DIR_NAME
        rest = parts

    if not seminar or not rest:
        return None

    if folder == NOTES_DIR_NAME:
        relative = Path(*rest)
        if relative.suffix.lower() != ".md":
            relative = relative.with_suffix(".md")
        return Path(seminar) / NOTES_DIR_NAME / relative

    if folder in {"original", "translation"}:
        number = lesson_number(Path(rest[-1]))
        if number is None:
            return None
        return Path(seminar) / lesson_filename(number)

    return None


def relative_href_for_build_paths(source_output: Path | None, target_output: Path, fragment: str = "") -> str:
    if source_output is None:
        href = target_output.as_posix()
    else:
        href = posixpath.relpath(target_output.as_posix(), source_output.parent.as_posix())
    if fragment:
        href = f"{href}#{fragment}"
    return encode_link_href(href)


def encode_link_href(href: str) -> str:
    encoded: list[str] = []
    unsafe = set(' ()<>[]{}|\\^`"')
    for character in href:
        if character.isspace() or character in unsafe:
            encoded.extend(f"%{byte:02X}" for byte in character.encode("utf-8"))
        else:
            encoded.append(character)
    return "".join(encoded)


def convert_obsidian_image_embeds(text: str, source_path: Path) -> str:
    """Convert Obsidian image embeds to mdBook-compatible HTML images.

    Obsidian accepts embeds such as:

      ![[texts/s8-le-transfert/original/assets/image5.jpeg|268]]

    mdBook does not understand that form. The build directory flattens each
    seminar's original/translation assets into build/<seminar>/assets, so the
    generated reference should point at assets/<name>.
    """
    lines = text.splitlines(keepends=True)
    converted: list[str] = []
    in_fence = False
    fence_marker = ""

    for line in lines:
        stripped = line.lstrip()
        fence_match = re.match(r"(```+|~~~+)", stripped)
        if fence_match:
            marker = fence_match.group(1)
            if not in_fence:
                in_fence = True
                fence_marker = marker[:3]
            elif marker.startswith(fence_marker):
                in_fence = False
                fence_marker = ""
            converted.append(line)
            continue

        if in_fence:
            converted.append(line)
        else:
            converted.append(OBSIDIAN_IMAGE_RE.sub(lambda match: render_obsidian_image(match, source_path), line))

    return "".join(converted)


def convert_obsidian_latex_math(text: str) -> str:
    """Convert Obsidian dollar-delimited math to MathJax default delimiters.

    Obsidian commonly uses `$...$` for inline math and `$$...$$` for display
    math. mdBook's MathJax integration expects the generated Markdown source
    to contain double-backslash delimiters such as `\\(` and `\\[`.
    """
    lines = text.splitlines(keepends=True)
    converted: list[str] = []
    in_fence = False
    fence_marker = ""
    display_math_lines: list[str] | None = None

    for line in lines:
        stripped = line.lstrip()
        fence_match = re.match(r"(```+|~~~+)", stripped)
        if fence_match and display_math_lines is None:
            marker = fence_match.group(1)
            if not in_fence:
                in_fence = True
                fence_marker = marker[:3]
            elif marker.startswith(fence_marker):
                in_fence = False
                fence_marker = ""
            converted.append(line)
            continue

        if in_fence:
            converted.append(line)
            continue

        if display_math_lines is not None:
            if stripped.strip() == "$$":
                converted.append("\\\\[\n")
                converted.extend(display_math_lines)
                converted.append("\\\\]\n")
                display_math_lines = None
            else:
                display_math_lines.append(line)
            continue

        if stripped.strip() == "$$":
            display_math_lines = []
            continue

        converted.append(convert_inline_obsidian_math(line))

    if display_math_lines is not None:
        converted.append("$$\n")
        converted.extend(display_math_lines)

    return "".join(converted)


def convert_inline_obsidian_math(line: str) -> str:
    return transform_outside_inline_code(line, convert_inline_math_segment)


def transform_outside_inline_code(line: str, transform) -> str:
    parts: list[str] = []
    cursor = 0
    for match in INLINE_CODE_SPAN_RE.finditer(line):
        parts.append(transform(line[cursor : match.start()]))
        parts.append(match.group(0))
        cursor = match.end()
    parts.append(transform(line[cursor:]))
    return "".join(parts)


def convert_inline_math_segment(segment: str) -> str:
    out: list[str] = []
    cursor = 0
    length = len(segment)

    while cursor < length:
        char = segment[cursor]
        if char != "$" or is_escaped(segment, cursor):
            out.append(char)
            cursor += 1
            continue

        if cursor + 1 < length and segment[cursor + 1] == "$":
            end = find_unescaped_dollars(segment, cursor + 2, "$$")
            if end is None:
                out.append("$$")
                cursor += 2
                continue
            math = segment[cursor + 2 : end].strip()
            if math:
                out.append(f"\\\\[{math}\\\\]")
            else:
                out.append("$$$$")
            cursor = end + 2
            continue

        end = find_unescaped_dollars(segment, cursor + 1, "$")
        if end is None:
            out.append(char)
            cursor += 1
            continue

        math = segment[cursor + 1 : end].strip()
        if should_convert_inline_math(math):
            out.append(f"\\\\({math}\\\\)")
        else:
            out.append(segment[cursor : end + 1])
        cursor = end + 1

    return "".join(out)


def find_unescaped_dollars(text: str, start: int, marker: str) -> int | None:
    cursor = start
    while cursor < len(text):
        index = text.find(marker, cursor)
        if index == -1:
            return None
        if not is_escaped(text, index):
            return index
        cursor = index + len(marker)
    return None


def is_escaped(text: str, index: int) -> bool:
    backslashes = 0
    cursor = index - 1
    while cursor >= 0 and text[cursor] == "\\":
        backslashes += 1
        cursor -= 1
    return backslashes % 2 == 1


def should_convert_inline_math(math: str) -> bool:
    if not math or "\n" in math:
        return False
    return True


def render_obsidian_image(match: re.Match[str], source_path: Path) -> str:
    target, options = split_obsidian_embed(match.group(1))
    if not target:
        return match.group(0)

    width = ""
    height = ""
    alt = ""
    for option in options:
        size_match = OBSIDIAN_IMAGE_SIZE_RE.match(option)
        if size_match:
            width = size_match.group(1)
            height = size_match.group(2) or ""
        elif not alt:
            alt = option

    src = resolve_obsidian_asset_path(target, source_path)
    alt = alt or Path(target.split("#", 1)[0]).name or target
    attrs = [
        f'src="{escape(src, quote=True)}"',
        f'alt="{escape(alt, quote=True)}"',
    ]
    if width:
        attrs.append(f'width="{escape(width, quote=True)}"')
    if height:
        attrs.append(f'height="{escape(height, quote=True)}"')
    return f"<img {' '.join(attrs)} />"


def split_obsidian_embed(raw: str) -> tuple[str, list[str]]:
    parts = [part.strip() for part in raw.split("|")]
    target = parts[0].strip()
    return target, [part for part in parts[1:] if part]


def resolve_obsidian_asset_path(target: str, source_path: Path) -> str:
    target = target.strip().replace("\\", "/")
    path_without_fragment = target.split("#", 1)[0].split("?", 1)[0].strip()
    if not path_without_fragment:
        return target

    normalized = path_without_fragment.lstrip("/")
    parts = [part for part in normalized.split("/") if part and part != "."]
    asset_href = resolve_asset_href_from_parts(parts, source_path)
    if asset_href:
        return asset_href

    relative_candidate = (source_path.parent / normalized).resolve()
    try:
        relative_parts = list(relative_candidate.relative_to(TEXTS_DIR.resolve()).parts)
    except ValueError:
        relative_parts = []
    asset_href = resolve_asset_href_from_parts(relative_parts, source_path)
    if asset_href:
        return asset_href

    same_folder_asset = source_path.parent / "assets" / normalized
    if same_folder_asset.exists():
        return relative_href_for_build_paths(
            source_output_relative_path(source_path),
            Path(current_seminar_slug(source_path)) / NOTES_DIR_NAME / "assets" / normalized
            if source_path.parent.name == NOTES_DIR_NAME
            else Path(current_seminar_slug(source_path)) / "assets" / normalized,
        )

    seminar_dir = source_path.parents[1] if len(source_path.parents) > 1 else source_path.parent
    for folder in ("original", "translation", NOTES_DIR_NAME):
        seminar_asset = seminar_dir / folder / "assets" / normalized
        if seminar_asset.exists():
            output_asset = (
                Path(current_seminar_slug(source_path)) / NOTES_DIR_NAME / "assets" / normalized
                if folder == NOTES_DIR_NAME
                else Path(current_seminar_slug(source_path)) / "assets" / normalized
            )
            return relative_href_for_build_paths(source_output_relative_path(source_path), output_asset)

    return normalized


def resolve_asset_href_from_parts(parts: list[str], source_path: Path) -> str:
    assets_index = asset_path_index(parts)
    if assets_index is None:
        return ""

    source_seminar = current_seminar_slug(source_path)
    seminar = source_seminar
    folder = ""
    if len(parts) >= 3 and parts[0] == "texts":
        seminar = parts[1]
        folder = parts[assets_index - 1] if assets_index >= 1 else ""
    elif assets_index >= 1:
        folder = parts[assets_index - 1]

    if not seminar:
        return ""

    asset_parts = parts[assets_index + 1 :]
    if not asset_parts:
        return ""

    output_asset = (
        Path(seminar) / NOTES_DIR_NAME / "assets" / Path(*asset_parts)
        if folder == NOTES_DIR_NAME
        else Path(seminar) / "assets" / Path(*asset_parts)
    )
    return relative_href_for_build_paths(source_output_relative_path(source_path), output_asset)


def asset_path_index(parts: list[str]) -> int | None:
    for index, part in enumerate(parts):
        if part != "assets":
            continue
        if index >= 1 and parts[index - 1] in ASSET_DIR_NAMES and index + 1 < len(parts):
            return index
        if index == 0 and index + 1 < len(parts):
            return index
    return None


def split_notes(text: str) -> tuple[str, str]:
    match = NOTE_HEADING_RE.search(text)
    if not match:
        return text, ""
    return text[: match.start()].rstrip(), text[match.start() :].strip()


def parse_lesson(path: Path) -> Lesson:
    raw_text = read_text(path)
    validate_unique_id_markers(raw_text, path)
    text = normalize_source_markdown(raw_text, path)
    body, notes = split_notes(text)
    matches = list(ID_RE.finditer(body))

    if not matches:
        lines = body.splitlines()
        title = lines[0].strip() if lines else f"# {path.stem}"
        return Lesson(title=title, intro="", paragraphs=[], notes=notes)

    title_source = body[: matches[0].start()].strip()
    title = first_markdown_heading(title_source) or f"# {path.stem}"
    intro = title_source

    paragraphs: list[Paragraph] = []
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        paragraphs.append(
            Paragraph(
                paragraph_id=match.group(1).strip(),
                content=clean_block(body[start:end]),
            )
        )

    return Lesson(title=title, intro=intro, paragraphs=paragraphs, notes=notes)


def first_markdown_heading(text: str) -> str | None:
    for line in text.splitlines():
        if line.startswith("#"):
            return line.strip()
    return None


def strip_metadata_comments(text: str) -> str:
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("<!--") and (
            "source:" in stripped
            or "imported:" in stripped
            or "translation:" in stripped
            or "align" in stripped
        ):
            continue
        lines.append(line)
    return "\n".join(lines).strip("\n")


def parse_translation(path: Path) -> list[TranslationEntry]:
    if not path.exists():
        return []

    raw_text = read_text(path)
    validate_unique_id_markers(raw_text, path)
    text = normalize_source_markdown(raw_text, path)
    matches = list(ID_RE.finditer(text))
    entries: list[TranslationEntry] = []

    for index, match in enumerate(matches):
        anchor_id = match.group(1).strip()
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        block = text[start:end].strip("\n")

        ids_match = IDS_RE.search(block)
        if ids_match:
            paragraph_ids = ids_match.group(1).split()
            block = IDS_RE.sub("", block, count=1)
        else:
            paragraph_ids = [anchor_id]

        untranslated = "<!-- untranslated -->" in block
        block = block.replace("<!-- untranslated -->", "")
        block = HTML_COMMENT_RE.sub(
            lambda comment: (
                comment.group(0)
                if COMMENTARY_MARKER_RE.fullmatch(comment.group(0))
                else ""
            ),
            block,
        )
        block = strip_metadata_comments(block)

        entries.append(
            TranslationEntry(
                anchor_id=anchor_id,
                paragraph_ids=paragraph_ids,
                content=block.strip(),
                untranslated=untranslated,
            )
        )

    return entries


def split_frontmatter(text: str) -> tuple[dict[str, str], str, str]:
    match = FRONTMATTER_RE.match(text)
    if not match:
        return {}, "", text

    raw = match.group(1)
    data: dict[str, str] = {}
    for line in raw.splitlines():
        if ":" not in line or line.lstrip().startswith("-"):
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = value.strip().strip("\"'")
    return data, raw, text[match.end() :]


def frontmatter_title(raw_frontmatter: str) -> str:
    match = FRONTMATTER_TITLE_RE.search(raw_frontmatter)
    return match.group(1).strip().strip("\"'") if match else ""


def extract_segment_ids(text: str) -> list[str]:
    seen: set[str] = set()
    ids: list[str] = []
    for match in SEGMENT_ID_TOKEN_RE.finditer(text):
        segment_id = match.group(0).lower()
        if segment_id not in seen:
            seen.add(segment_id)
            ids.append(segment_id)
    return ids


def note_markdown_files(directory: Path) -> list[Path]:
    if not directory.exists():
        return []
    return sorted(
        path
        for path in directory.rglob("*.md")
        if path.name != "README.md" and "assets" not in path.relative_to(directory).parts
    )


def note_output_relative_path(note_path: Path, seminar_dir: Path) -> Path:
    relative = note_path.relative_to(seminar_dir / NOTES_DIR_NAME)
    return Path(NOTES_DIR_NAME) / relative


def note_title(path: Path, body: str, raw_frontmatter: str) -> str:
    title = frontmatter_title(raw_frontmatter)
    if title:
        return title
    heading = first_markdown_heading(body)
    if heading:
        return heading.lstrip("#").strip()
    return path.stem


def parse_reading_note(note_path: Path, seminar_dir: Path) -> ReadingNote:
    raw_text = read_text(note_path)
    validate_unique_id_markers(raw_text, note_path)
    _, raw_frontmatter, body = split_frontmatter(raw_text)
    segment_ids = extract_segment_ids(f"{raw_frontmatter}\n{body}")
    return ReadingNote(
        source_path=note_path,
        output_relative_path=note_output_relative_path(note_path, seminar_dir),
        title=note_title(note_path, body, raw_frontmatter),
        segment_ids=segment_ids,
    )


def parse_reading_notes(seminar_dir: Path) -> list[ReadingNote]:
    notes_dir = seminar_dir / NOTES_DIR_NAME
    return [parse_reading_note(path, seminar_dir) for path in note_markdown_files(notes_dir)]


def notes_by_segment(notes: Iterable[ReadingNote]) -> dict[str, list[ReadingNote]]:
    by_segment: dict[str, list[ReadingNote]] = {}
    for note in notes:
        for segment_id in note.segment_ids:
            by_segment.setdefault(segment_id, []).append(note)
    for segment_notes in by_segment.values():
        segment_notes.sort(key=lambda note: (note.title, note.output_relative_path.as_posix()))
    return by_segment


def knowledge_markdown_files(directory: Path) -> list[Path]:
    if not directory.exists():
        return []
    return sorted(
        path
        for path in directory.rglob("*.md")
        if path.name != "README.md"
    )


def markdown_section(text: str, heading: str) -> str:
    lines = text.splitlines()
    start: int | None = None
    for index, line in enumerate(lines):
        if line.strip() == f"## {heading}":
            start = index + 1
            break
    if start is None:
        return ""

    end = len(lines)
    for index in range(start, len(lines)):
        if lines[index].startswith("## "):
            end = index
            break
    return "\n".join(lines[start:end])


def knowledge_segment_ids(body: str) -> list[str]:
    association = markdown_section(body, "关联")
    seen: set[str] = set()
    segment_ids: list[str] = []
    for match in OBSIDIAN_WIKI_LINK_RE.finditer(association):
        target, _ = split_obsidian_wiki_link(match.group(1))
        target_path, fragment = split_link_fragment(target.strip().replace("\\", "/"))
        parts = [part for part in target_path.strip("/").split("/") if part]
        segment_id = fragment.lower()
        if (
            len(parts) >= 4
            and parts[0] == "texts"
            and parts[2] == "translation"
            and SEGMENT_ID_TOKEN_RE.fullmatch(segment_id)
            and segment_id not in seen
        ):
            seen.add(segment_id)
            segment_ids.append(segment_id)
    return segment_ids


def frontmatter_list(raw_frontmatter: str, key: str) -> list[str]:
    lines = raw_frontmatter.splitlines()
    values: list[str] = []
    in_list = False
    for line in lines:
        if re.match(rf"^\s*{re.escape(key)}\s*:\s*$", line):
            in_list = True
            continue
        if not in_list:
            continue
        item = re.match(r"^\s+-\s+(.+?)\s*$", line)
        if item:
            values.append(item.group(1).strip().strip("\"'"))
            continue
        if line.strip():
            break
    return values


def html_output_path(markdown_path: Path) -> str:
    return markdown_path.with_suffix(".html").as_posix()


def knowledge_links(body: str, source_path: Path) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    association = markdown_section(body, "关联")
    card_links: list[dict[str, str]] = []
    segment_links: list[dict[str, str]] = []

    for match in OBSIDIAN_WIKI_LINK_RE.finditer(association):
        target, label = split_obsidian_wiki_link(match.group(1))
        target_path, fragment = split_link_fragment(target.strip().replace("\\", "/"))
        output_path = resolve_wiki_target_output_path(target_path, source_path)
        if output_path is None:
            continue

        if output_path.parts and output_path.parts[0] == KNOWLEDGE_DIR_NAME:
            canonical_path = output_path.as_posix()
            card_links.append(
                {
                    "path": canonical_path,
                    "title": label or output_path.stem,
                    "href": html_output_path(output_path),
                }
            )
            continue

        if fragment and SEGMENT_ID_TOKEN_RE.fullmatch(fragment.lower()):
            canonical_path = target_path.strip("/")
            segment_links.append(
                {
                    "id": fragment.lower(),
                    "path": canonical_path,
                    "href": f"{html_output_path(output_path)}#{fragment.lower()}",
                }
            )

    return card_links, segment_links


def parse_knowledge_card(card_path: Path) -> KnowledgeCard:
    raw_text = read_text(card_path)
    metadata, raw_frontmatter, body = split_frontmatter(raw_text)
    title = frontmatter_title(raw_frontmatter) or card_path.stem
    card_links, segment_links = knowledge_links(body, card_path)
    return KnowledgeCard(
        source_path=card_path,
        output_relative_path=Path(KNOWLEDGE_DIR_NAME)
        / card_path.relative_to(KNOWLEDGE_DIR),
        title=title,
        segment_ids=knowledge_segment_ids(body),
        verification=metadata.get("verification", ""),
        verified_at=metadata.get("verified_at", ""),
        tags=tuple(frontmatter_list(raw_frontmatter, "tags")),
        body=body.strip(),
        card_links=tuple(card_links),
        segment_links=tuple(segment_links),
    )


def parse_knowledge_cards() -> list[KnowledgeCard]:
    return [
        parse_knowledge_card(path)
        for path in knowledge_markdown_files(KNOWLEDGE_DIR)
    ]


def knowledge_cards_by_segment(
    cards: Iterable[KnowledgeCard],
) -> dict[str, list[KnowledgeCard]]:
    by_segment: dict[str, list[KnowledgeCard]] = {}
    for card in cards:
        for segment_id in card.segment_ids:
            by_segment.setdefault(segment_id, []).append(card)
    for segment_cards in by_segment.values():
        segment_cards.sort(
            key=lambda card: (card.title, card.output_relative_path.as_posix())
        )
    return by_segment


def render_reading_note(note: ReadingNote) -> str:
    raw_text = read_text(note.source_path)
    _, _, body = split_frontmatter(raw_text)
    body = normalize_source_markdown(body.strip("\n"), note.source_path).strip()
    out: list[str] = []
    if body:
        out.append(body)
        out.append("")
    elif note.title:
        out.extend([f"# {note.title}", ""])

    if note.segment_ids:
        out.extend(["## 对应译文段落", ""])
        for segment_id in note.segment_ids:
            href = resolve_obsidian_wiki_href(segment_id, note.source_path)
            out.append(f"- [{segment_id}]({href})")
        out.append("")

    return "\n".join(out).rstrip() + "\n"


def render_notes_readme(seminar_dir: Path, notes: list[ReadingNote]) -> str:
    source_readme = seminar_dir / NOTES_DIR_NAME / "README.md"
    if source_readme.exists():
        content = normalize_source_markdown(read_text(source_readme), source_readme)
        content = rewrite_notes_readme_lesson_links(content).strip()
        if content:
            return content + "\n"

    lines = ["# 阅读笔记", ""]
    if not notes:
        lines.extend(["暂无阅读笔记。", ""])
        return "\n".join(lines).rstrip() + "\n"

    lines.extend(["## 材料目录", ""])
    for note in notes:
        segment_label = f" · {', '.join(note.segment_ids)}" if note.segment_ids else ""
        href = encode_link_href(
            note.output_relative_path.relative_to(NOTES_DIR_NAME).as_posix()
        )
        lines.append(f"- [{note.title}]({href}){segment_label}")
    lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def render_knowledge_page(source_path: Path, title: str) -> str:
    raw_text = read_text(source_path)
    _, _, body = split_frontmatter(raw_text)
    body = normalize_source_markdown(body.strip("\n"), source_path).strip()
    if not LEVEL_ONE_HEADING_RE.search(body):
        body = f"# {title}\n\n{body}" if body else f"# {title}"
    return body.rstrip() + "\n"


def build_knowledge_base(cards: list[KnowledgeCard] | None = None) -> None:
    output_dir = BUILD_DIR / KNOWLEDGE_DIR_NAME
    if output_dir.exists():
        shutil.rmtree(output_dir)
    if not KNOWLEDGE_DIR.exists():
        return

    cards = cards if cards is not None else parse_knowledge_cards()
    source_readme = KNOWLEDGE_DIR / "README.md"
    if source_readme.exists():
        _, raw_frontmatter, _ = split_frontmatter(read_text(source_readme))
        title = frontmatter_title(raw_frontmatter) or "知识库"
        write_text(
            output_dir / "README.md",
            render_knowledge_page(source_readme, title),
        )
    else:
        write_text(output_dir / "README.md", "# 知识库\n")

    for card in cards:
        write_text(
            BUILD_DIR / card.output_relative_path,
            render_knowledge_page(card.source_path, card.title),
        )


def build_ai_knowledge_index(cards: list[KnowledgeCard] | None = None) -> Path:
    cards = cards if cards is not None else parse_knowledge_cards()
    output_path = BUILD_DIR / "ai" / "knowledge-index.json"
    payload = {
        "version": 1,
        "card_count": len(cards),
        "cards": [
            {
                "path": card.output_relative_path.as_posix(),
                "title": card.title,
                "verification": card.verification,
                "verified_at": card.verified_at,
                "tags": list(card.tags),
                "href": html_output_path(card.output_relative_path),
                "body": card.body,
                "card_links": list(card.card_links),
                "segment_links": list(card.segment_links),
            }
            for card in cards
        ],
    }
    write_text(
        output_path,
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
    )
    return output_path


def navigation_html_href(markdown_href: str) -> str:
    """Convert an mdBook SUMMARY href to its generated HTML destination."""
    path, separator, fragment = markdown_href.partition("#")
    if path == "README.md":
        path = "index.html"
    elif path.endswith("/README.md"):
        path = f"{path[:-len('README.md')]}index.html"
    elif path.endswith(".md"):
        path = f"{path[:-len('.md')]}.html"
    return f"{path}{separator}{fragment}" if separator else path


def navigation_entry_kind(markdown_href: str) -> str:
    path = markdown_href.split("#", 1)[0]
    if path == "index.md":
        return "home"
    if path == "glossary.md":
        return "glossary"
    if path == f"{KNOWLEDGE_DIR_NAME}/README.md":
        return "knowledge-index"
    if path.startswith(f"{KNOWLEDGE_DIR_NAME}/"):
        return "knowledge"
    if path.endswith(f"/{NOTES_DIR_NAME}/README.md"):
        return "notes-index"
    if f"/{NOTES_DIR_NAME}/" in path:
        return "note"
    if re.search(r"/(?:Leçon|Lecon|lesson)-\d+\.md$", path, re.IGNORECASE):
        return "lesson"
    if path.endswith("/glossary.md"):
        return "glossary"
    if path.endswith("/README.md"):
        return "seminar"
    return "page"


def navigation_entry_aliases(
    title: str,
    markdown_href: str,
    kind: str,
    card: KnowledgeCard | None,
) -> list[str]:
    aliases: list[str] = []

    def add(value: str) -> None:
        clean = value.strip()
        if clean and clean != title and clean not in aliases:
            aliases.append(clean)

    if card is not None:
        add(card.title)
        add(card.output_relative_path.stem)

    path = markdown_href.split("#", 1)[0]
    first_part = path.split("/", 1)[0]
    seminar_match = re.match(r"^(s\d+[a-z]?)(?:-|$)", first_part, re.IGNORECASE)
    if seminar_match:
        code = seminar_match.group(1).lower()
        if kind == "seminar":
            add(code)
            add(first_part)
        elif kind == "lesson":
            lesson_match = re.search(
                r"/(?:Leçon|Lecon|lesson)-(\d+)\.md$",
                path,
                re.IGNORECASE,
            )
            if lesson_match:
                lesson_number_value = int(lesson_match.group(1))
                add(f"{code}-{lesson_number_value:02d}")
                add(f"{code.upper()} 第 {lesson_number_value} 课")

    return aliases


def build_navigation_index(cards: list[KnowledgeCard] | None = None) -> Path:
    """Build a compact title/path index; page bodies and segment IDs stay out."""
    cards = cards if cards is not None else parse_knowledge_cards()
    summary_path = BUILD_DIR / "SUMMARY.md"
    if not summary_path.exists():
        raise FileNotFoundError(f"Missing mdBook summary: {summary_path}")

    cards_by_href = {
        encode_link_href(card.output_relative_path.as_posix()): card
        for card in cards
    }
    parent_titles: dict[int, str] = {}
    entries: list[dict[str, object]] = []
    seminars: dict[str, str] = {}

    for line in read_text(summary_path).splitlines():
        match = SUMMARY_LINK_RE.match(line)
        if not match:
            continue

        indent = len(match.group("indent").expandtabs(2))
        depth = indent // 2
        title = match.group("title").strip()
        markdown_href = match.group("href").strip()
        kind = navigation_entry_kind(markdown_href)
        card = cards_by_href.get(markdown_href.split("#", 1)[0])
        aliases = navigation_entry_aliases(title, markdown_href, kind, card)
        context = parent_titles.get(depth - 1, "") if depth else ""

        entry: dict[str, object] = {
            "title": title,
            "href": navigation_html_href(markdown_href),
            "kind": kind,
            "context": context,
            "aliases": aliases,
            "tags": list(card.tags) if card is not None else [],
        }
        entries.append(entry)

        parent_titles[depth] = title
        for stale_depth in [key for key in parent_titles if key > depth]:
            del parent_titles[stale_depth]

        if kind == "seminar":
            slug = markdown_href.split("/", 1)[0]
            seminar_match = re.match(r"^(s\d+[a-z]?)(?:-|$)", slug, re.IGNORECASE)
            if seminar_match:
                seminars[seminar_match.group(1).lower()] = slug

    output_path = BUILD_DIR / "navigation-index.json"
    payload = {
        "version": 1,
        "entry_count": len(entries),
        "seminars": seminars,
        "entries": entries,
    }
    write_text(
        output_path,
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
    )
    return output_path


def rewrite_notes_readme_lesson_links(text: str) -> str:
    def replace(match: re.Match[str]) -> str:
        number = lesson_number(Path(match.group("filename")))
        if number is None:
            return match.group(0)
        fragment = match.group("fragment") or ""
        return (
            f"{match.group('prefix')}../{lesson_filename(number)}"
            f"{fragment}{match.group('suffix')}"
        )

    return NOTES_README_LESSON_LINK_RE.sub(replace, text)


def note_like_quote(lines: list[str]) -> bool:
    if any(COMMENTARY_MARKER_RE.search(line) for line in lines):
        return False

    visible_lines = []
    for line in lines:
        stripped = line.lstrip()
        if stripped.startswith(">"):
            stripped = stripped[1:].strip()
        if stripped:
            visible_lines.append(stripped)

    if not visible_lines:
        return False

    first = visible_lines[0].lstrip("【[（(").strip()
    return first.startswith("注")


def split_translation_chunks(content: str) -> list[tuple[str, list[str]]]:
    lines = content.splitlines()
    chunks: list[tuple[str, list[str]]] = []
    normal: list[str] = []
    index = 0

    def flush_normal() -> None:
        nonlocal normal
        if normal and any(line.strip() for line in normal):
            chunks.append(("normal", trim_blank_lines(normal)))
        normal = []

    while index < len(lines):
        line = lines[index]
        if reading_note_link_line(line):
            flush_normal()
            index += 1
            continue
        if line.lstrip().startswith(">"):
            flush_normal()
            quote: list[str] = []
            while index < len(lines) and lines[index].lstrip().startswith(">"):
                quote.append(lines[index])
                index += 1
            kind = "note" if note_like_quote(quote) else "commentary"
            chunks.append((kind, trim_blank_lines(quote)))
            continue

        normal.append(line)
        index += 1

    flush_normal()
    return [(kind, chunk) for kind, chunk in chunks if chunk]


def reading_note_link_line(line: str) -> bool:
    return bool(
        READING_NOTE_LINK_LINE_RE.match(line)
        or READING_NOTE_MARKDOWN_LINK_LINE_RE.match(line)
    )


def trim_blank_lines(lines: list[str]) -> list[str]:
    start = 0
    end = len(lines)
    while start < end and not lines[start].strip():
        start += 1
    while end > start and not lines[end - 1].strip():
        end -= 1
    return lines[start:end]


def grouped_entries(entries: Iterable[TranslationEntry]) -> tuple[dict[str, list[TranslationEntry]], set[str]]:
    by_anchor: dict[str, list[TranslationEntry]] = {}
    covered_non_anchor: set[str] = set()

    for entry in entries:
        anchor = entry.anchor_id
        by_anchor.setdefault(anchor, []).append(entry)
        for paragraph_id in entry.paragraph_ids:
            if paragraph_id != anchor:
                covered_non_anchor.add(paragraph_id)

    return by_anchor, covered_non_anchor


def render_translation_entry(entry: TranslationEntry) -> RenderedTranslation:
    if entry.untranslated or not entry.content.strip():
        return RenderedTranslation(body='<p class="translation-missing">[未译]</p>')

    body: list[str] = []
    notes: list[str] = []
    commentary: list[str] = []
    for kind, lines in split_translation_chunks(entry.content):
        text = render_translation_inline_markup("\n".join(lines).strip())
        if not text:
            continue
        if kind == "note":
            notes.extend(['<div class="note-block">', "", text, "", "</div>", ""])
        elif kind == "commentary":
            commentary.extend(['<div class="commentary-block">', "", text, "", "</div>", ""])
        else:
            body.extend([text, ""])

    return RenderedTranslation(
        body="\n".join(body).strip(),
        notes="\n".join(notes).strip(),
        commentary="\n".join(commentary).strip(),
    )


def render_translation_inline_markup(text: str) -> str:
    """Keep translation emphasis from leaking as literal Markdown markers."""
    return INLINE_STRONG_RE.sub(r"<strong>\1</strong>", text)


def render_original_blocks(blocks: list[Paragraph]) -> str:
    out: list[str] = []
    for block in blocks:
        out.append(f'<div class="original-paragraph" data-paragraph-id="{block.paragraph_id}">')
        out.append("")
        out.append(block.content.strip() or "&nbsp;")
        out.append("")
        out.append("</div>")
        out.append("")
    return "\n".join(out).strip()


def render_lesson(
    original_path: Path,
    translation_path: Path | None,
    reading_notes_by_segment: dict[str, list[ReadingNote]] | None = None,
    knowledge_cards_by_segment: dict[str, list[KnowledgeCard]] | None = None,
) -> tuple[str, BuildStats]:
    lesson = parse_lesson(original_path)
    entries = parse_translation(translation_path) if translation_path else []
    by_anchor, covered_non_anchor = grouped_entries(entries)
    by_id = {paragraph.paragraph_id: paragraph for paragraph in lesson.paragraphs}
    reading_notes_by_segment = reading_notes_by_segment or {}
    knowledge_cards_by_segment = knowledge_cards_by_segment or {}

    out: list[str] = []
    out.append(lesson.title)
    out.append("")
    out.extend(render_controls())
    out.append("")
    out.append('<div class="parallel-text">')
    out.append("")

    stats = BuildStats(lessons=1)
    consumed: set[str] = set()

    for paragraph in lesson.paragraphs:
        paragraph_id = paragraph.paragraph_id
        if paragraph_id in consumed or paragraph_id in covered_non_anchor:
            continue

        entries_for_id = by_anchor.get(paragraph_id, [])
        if entries_for_id:
            for entry in entries_for_id:
                paragraph_ids = [pid for pid in entry.paragraph_ids if pid in by_id]
                if not paragraph_ids:
                    paragraph_ids = [paragraph_id]
                original_blocks = [by_id[pid] for pid in paragraph_ids if pid in by_id]
                consumed.update(paragraph_ids)
                stats.aligned_blocks += 1
                if entry.untranslated:
                    stats.untranslated_blocks += 1
                out.extend(
                    render_parallel_block(
                        paragraph_ids,
                        original_blocks,
                        render_translation_entry(entry),
                        notes_for_paragraph_ids(paragraph_ids, reading_notes_by_segment),
                        knowledge_cards_for_paragraph_ids(
                            paragraph_ids,
                            knowledge_cards_by_segment,
                        ),
                    )
                )
        else:
            consumed.add(paragraph_id)
            stats.missing_translations += 1
            out.extend(
                render_parallel_block(
                    [paragraph_id],
                    [paragraph],
                    RenderedTranslation(body='<p class="translation-missing">[无对应译文]</p>'),
                    notes_for_paragraph_ids([paragraph_id], reading_notes_by_segment),
                    knowledge_cards_for_paragraph_ids(
                        [paragraph_id],
                        knowledge_cards_by_segment,
                    ),
                )
            )

    out.append("</div>")
    out.append("")

    if lesson.notes:
        out.append('<section class="note-block original-notes">')
        out.append("")
        out.append(lesson.notes)
        out.append("")
        out.append("</section>")
        out.append("")

    return "\n".join(out).rstrip() + "\n", stats


def render_controls() -> list[str]:
    return [
        '<div class="reading-controls lacan-tool-panel" role="group" aria-label="页面功能区">',
        '  <div class="lacan-toggle-group" aria-label="显示选项">',
        '    <label><input type="checkbox" data-lacan-toggle="original" checked> 原文</label>',
        '    <label><input type="checkbox" data-lacan-toggle="notes" checked> 注释</label>',
        '    <label><input type="checkbox" data-lacan-toggle="commentary" checked> 建言</label>',
        "  </div>",
        '  <form class="lacan-tool-search" role="search">',
        '    <input class="lacan-tool-search-input" type="search" placeholder="搜索标题、知识卡或段落 ID" aria-label="搜索标题、知识卡或段落 ID">',
        '    <button class="lacan-tool-button" type="submit" title="搜索">搜索</button>',
        "  </form>",
        '  <button class="lacan-tool-button lacan-back-to-top" type="button" title="回到页面最上方" aria-label="回到页面最上方">↑</button>',
        "</div>",
    ]


def render_parallel_block(
    paragraph_ids: list[str],
    original_blocks: list[Paragraph],
    translation: RenderedTranslation,
    reading_notes: list[ReadingNote] | None = None,
    knowledge_cards: list[KnowledgeCard] | None = None,
) -> list[str]:
    ids_text = " ".join(paragraph_ids)
    ids_label = ", ".join(escape(paragraph_id) for paragraph_id in paragraph_ids)
    anchor_id = escape(paragraph_ids[0], quote=True)
    ids_attr = escape(ids_text, quote=True)
    out = [
        f'<section id="{anchor_id}" class="parallel-paragraph" data-paragraph-ids="{ids_attr}">',
    ]

    for paragraph_id in paragraph_ids[1:]:
        out.append(
            f'<span id="{escape(paragraph_id, quote=True)}" class="paragraph-anchor-alias" aria-hidden="true"></span>'
        )

    out.extend([
        f'<div class="paragraph-id">{ids_label}</div>',
    ])

    out.extend([
        '<details class="original-block" open>',
        f"<summary>原文 · {ids_label}</summary>",
        "",
        render_original_blocks(original_blocks),
        "",
        "</details>",
    ])

    if translation.body:
        out.extend(["<div class=\"translation-block\">", "", translation.body, "", "</div>"])
    if translation.notes:
        out.extend(["", translation.notes])
    if translation.commentary:
        out.extend(["", translation.commentary])
    if reading_notes:
        out.extend(["", *render_reading_note_links(reading_notes)])
    if knowledge_cards:
        out.extend(["", *render_knowledge_card_links(knowledge_cards)])

    out.extend(["</section>", ""])
    return out


def notes_for_paragraph_ids(
    paragraph_ids: list[str],
    reading_notes_by_segment: dict[str, list[ReadingNote]],
) -> list[ReadingNote]:
    notes: list[ReadingNote] = []
    seen: set[Path] = set()
    for paragraph_id in paragraph_ids:
        for note in reading_notes_by_segment.get(paragraph_id, []):
            if note.output_relative_path not in seen:
                notes.append(note)
                seen.add(note.output_relative_path)
    return notes


def render_reading_note_links(reading_notes: list[ReadingNote]) -> list[str]:
    out = ['<div class="reading-note-links" aria-label="相关阅读笔记">']
    out.append('<span class="reading-note-links-title">阅读笔记</span>')
    links: list[str] = []
    for note in reading_notes:
        href = escape(
            encode_link_href(note.output_relative_path.as_posix()),
            quote=True,
        )
        title = escape(note.title)
        links.append(f'<a href="{href}">{title}</a>')
    out.append(f'<span class="reading-note-links-list">{" · ".join(links)}</span>')
    out.append("</div>")
    return out


def knowledge_cards_for_paragraph_ids(
    paragraph_ids: list[str],
    knowledge_cards_by_segment: dict[str, list[KnowledgeCard]],
) -> list[KnowledgeCard]:
    cards: list[KnowledgeCard] = []
    seen: set[Path] = set()
    for paragraph_id in paragraph_ids:
        for card in knowledge_cards_by_segment.get(paragraph_id, []):
            if card.output_relative_path not in seen:
                cards.append(card)
                seen.add(card.output_relative_path)
    return cards


def render_knowledge_card_links(
    knowledge_cards: list[KnowledgeCard],
) -> list[str]:
    out = [
        '<div class="reading-note-links knowledge-card-links" aria-label="相关知识库">'
    ]
    out.append('<span class="reading-note-links-title">知识库</span>')
    links: list[str] = []
    for card in knowledge_cards:
        href = escape(
            encode_link_href(
                posixpath.join("..", card.output_relative_path.as_posix())
            ),
            quote=True,
        )
        title = escape(card.title)
        links.append(f'<a href="{href}">{title}</a>')
    out.append(f'<span class="reading-note-links-list">{" · ".join(links)}</span>')
    out.append("</div>")
    return out


def lesson_number(path: Path) -> int | None:
    match = LESSON_FILE_RE.match(path.name)
    if match:
        return int(match.group(1))
    return None


def lesson_filename(number: int) -> str:
    return f"{CANONICAL_LESSON_PREFIX}-{number:02d}.md"


def lesson_sort_key(path: Path) -> tuple[int, str]:
    number = lesson_number(path)
    return number if number is not None else 9999, path.name


def lesson_markdown_files(directory: Path) -> list[Path]:
    if not directory.exists():
        return []
    return sorted(
        (path for path in directory.glob("*.md") if lesson_number(path) is not None),
        key=lesson_sort_key,
    )


def matching_lesson_file(directory: Path, number: int | None, preferred_name: str) -> Path:
    candidates = [directory / preferred_name]
    if number is not None:
        candidates.extend(
            [
                directory / lesson_filename(number),
                directory / f"lesson-{number:02d}.md",
                directory / f"Lecon-{number:02d}.md",
            ]
        )
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


def reset_build_seminar_dir(output_dir: Path) -> None:
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)


def seminar_title(slug: str, seminar_dir: Path) -> str:
    readme = seminar_dir / "original" / "README.md"
    if readme.exists():
        readme_text = read_text(readme)
        source_title = re.search(r"^\s*-\s*标题[:：]\s*(.+?)\s*$", readme_text, re.MULTILINE)
        if source_title:
            return f"{seminar_label(slug)}：{source_title.group(1).strip()}"

        title = first_markdown_heading(readme_text)
        if title:
            clean_title = title.lstrip("#").strip()
            if clean_title.endswith("原文"):
                return seminar_label(slug)
            return clean_title

    lessons = lesson_markdown_files(seminar_dir / "original")
    if lessons:
        title = parse_lesson(lessons[0]).title
        if "|" in title:
            return title.lstrip("#").split("|", 1)[0].strip()
        return title.lstrip("#").strip()

    return slug


def seminar_label(slug: str) -> str:
    first = slug.split("-", 1)[0]
    if re.match(r"^s\d+[a-z]?$", first):
        return first.upper()
    return slug


def seminar_sort_key(slug: str) -> tuple[int, str, str]:
    match = re.match(r"^s(\d+)([a-z]?)(?:-|$)", slug)
    if match:
        return int(match.group(1)), match.group(2), slug
    return 9999, "", slug


def build_seminar(
    slug: str,
    knowledge_cards_by_segment: dict[str, list[KnowledgeCard]] | None = None,
) -> BuildStats:
    seminar_dir = TEXTS_DIR / slug
    original_dir = seminar_dir / "original"
    translation_dir = seminar_dir / "translation"
    notes_dir = seminar_dir / NOTES_DIR_NAME
    output_dir = BUILD_DIR / slug
    stats = BuildStats(seminars={slug})
    knowledge_cards_by_segment = knowledge_cards_by_segment or {}

    if not original_dir.exists():
        raise FileNotFoundError(f"Missing original directory: {original_dir}")

    reset_build_seminar_dir(output_dir)
    reading_notes = parse_reading_notes(seminar_dir)
    reading_notes_by_segment = notes_by_segment(reading_notes)
    write_text(output_dir / "README.md", render_seminar_readme(slug, seminar_dir))
    if notes_dir.exists():
        write_text(
            output_dir / NOTES_DIR_NAME / "README.md",
            render_notes_readme(seminar_dir, reading_notes),
        )

    for lesson_path in lesson_markdown_files(original_dir):
        number = lesson_number(lesson_path)
        output_name = lesson_filename(number) if number is not None else lesson_path.name
        translation_path = matching_lesson_file(translation_dir, number, lesson_path.name)
        rendered, lesson_stats = render_lesson(
            lesson_path,
            translation_path if translation_path.exists() else None,
            reading_notes_by_segment,
            knowledge_cards_by_segment,
        )
        write_text(output_dir / output_name, rendered)
        stats.lessons += lesson_stats.lessons
        stats.aligned_blocks += lesson_stats.aligned_blocks
        stats.untranslated_blocks += lesson_stats.untranslated_blocks
        stats.missing_translations += lesson_stats.missing_translations

    for note in reading_notes:
        write_text(output_dir / note.output_relative_path, render_reading_note(note))

    copy_assets(original_dir / "assets", output_dir / "assets")
    copy_assets(translation_dir / "assets", output_dir / "assets")
    copy_assets(notes_dir / "assets", output_dir / NOTES_DIR_NAME / "assets")

    glossary = seminar_dir / "glossary.md"
    if glossary.exists():
        shutil.copy2(glossary, output_dir / "glossary.md")

    return stats


def validate_seminar_id_markers(slug: str) -> None:
    seminar_dir = TEXTS_DIR / slug
    original_dir = seminar_dir / "original"
    translation_dir = seminar_dir / "translation"
    notes_dir = seminar_dir / NOTES_DIR_NAME

    if not original_dir.exists():
        raise FileNotFoundError(f"Missing original directory: {original_dir}")

    for lesson_path in lesson_markdown_files(original_dir):
        validate_unique_id_markers_in_file(lesson_path)
    for lesson_path in lesson_markdown_files(translation_dir):
        validate_unique_id_markers_in_file(lesson_path)
    for note_path in note_markdown_files(notes_dir):
        validate_unique_id_markers_in_file(note_path)


def validate_selected_seminar_id_markers(seminars: Iterable[str]) -> None:
    for slug in seminars:
        validate_seminar_id_markers(slug)


def render_seminar_readme(slug: str, seminar_dir: Path) -> str:
    title = seminar_title(slug, seminar_dir)
    lines = [f"# {title}", ""]

    if (seminar_dir / "glossary.md").exists() or (BUILD_DIR / slug / "glossary.md").exists():
        lines.append("- [术语表](glossary.md)")
        lines.append("")

    if (seminar_dir / NOTES_DIR_NAME).exists() or (BUILD_DIR / slug / NOTES_DIR_NAME / "README.md").exists():
        lines.append("- [阅读笔记](notes/)")
        lines.append("")

    original_dir = seminar_dir / "original"
    lessons = lesson_markdown_files(original_dir)
    if lessons:
        lines.append("## 课时目录")
        lines.append("")
        for lesson in lessons:
            number = lesson_number(lesson)
            output_name = lesson_filename(number) if number is not None else lesson.name
            lesson_title = parse_lesson(lesson).title.lstrip("#").strip()
            lines.append(f"- [{lesson_title}]({output_name})")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def copy_assets(source: Path, destination: Path) -> None:
    if not source.exists():
        return
    destination.mkdir(parents=True, exist_ok=True)
    for path in source.rglob("*"):
        if path.is_dir():
            continue
        relative = path.relative_to(source)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)


def discover_text_seminars() -> list[str]:
    if not TEXTS_DIR.exists():
        return []
    seminars = []
    for path in TEXTS_DIR.iterdir():
        if path.is_dir() and (path / "original").exists():
            seminars.append(path.name)
    return sorted(seminars, key=seminar_sort_key)


def discover_build_seminars() -> list[str]:
    if not BUILD_DIR.exists():
        return []
    seminars = []
    for path in BUILD_DIR.iterdir():
        if (
            path.name != KNOWLEDGE_DIR_NAME
            and path.is_dir()
            and (path / "README.md").exists()
        ):
            seminars.append(path.name)
    return sorted(seminars, key=seminar_sort_key)


def write_summary() -> None:
    lines = ["# Summary", ""]

    index = BUILD_DIR / "index.md"
    if TEXTS_INDEX.exists():
        write_text(index, read_text(TEXTS_INDEX).rstrip() + "\n")
        lines.append("- [首页](index.md)")
    elif index.exists():
        lines.append("- [首页](index.md)")
    else:
        write_text(index, "# 拉康开放翻译计划\n")
        lines.append("- [首页](index.md)")

    homepage_assets = BUILD_DIR / "assets"
    if homepage_assets.exists():
        shutil.rmtree(homepage_assets)
    copy_assets(TEXTS_DIR / "assets", homepage_assets)

    glossary = BUILD_DIR / "glossary.md"
    if glossary.exists():
        lines.append("- [全局术语表](glossary.md)")

    knowledge_readme = BUILD_DIR / KNOWLEDGE_DIR_NAME / "README.md"
    if knowledge_readme.exists():
        lines.append(f"- [知识库]({KNOWLEDGE_DIR_NAME}/README.md)")
        for card in sorted(
            (
                path
                for path in (BUILD_DIR / KNOWLEDGE_DIR_NAME).rglob("*.md")
                if path.name != "README.md"
            ),
            key=lambda path: path.relative_to(
                BUILD_DIR / KNOWLEDGE_DIR_NAME
            ).as_posix(),
        ):
            card_title = first_markdown_heading(read_text(card))
            label = (
                card_title.lstrip("#").strip()
                if card_title
                else card.stem
            )
            relative = encode_link_href(card.relative_to(BUILD_DIR).as_posix())
            lines.append(f"  - [{label}]({relative})")

    for slug in discover_build_seminars():
        readme = BUILD_DIR / slug / "README.md"
        title = first_markdown_heading(read_text(readme)) or f"# {slug}"
        lines.append(f"- [{title.lstrip('#').strip()}]({slug}/README.md)")

        glossary = BUILD_DIR / slug / "glossary.md"
        if glossary.exists():
            lines.append(f"  - [术语表]({slug}/glossary.md)")

        notes_readme = BUILD_DIR / slug / NOTES_DIR_NAME / "README.md"
        if notes_readme.exists():
            lines.append(f"  - [阅读笔记]({slug}/notes/README.md)")
            for note in sorted(
                (path for path in (BUILD_DIR / slug / NOTES_DIR_NAME).rglob("*.md") if path.name != "README.md"),
                key=lambda path: path.relative_to(BUILD_DIR / slug / NOTES_DIR_NAME).as_posix(),
            ):
                note_title_value = first_markdown_heading(read_text(note))
                label = note_title_value.lstrip("#").strip() if note_title_value else note.stem
                note_relative = note.relative_to(
                    BUILD_DIR / slug / NOTES_DIR_NAME
                ).as_posix()
                note_href = encode_link_href(
                    f"{slug}/notes/{note_relative}"
                )
                lines.append(f"    - [{label}]({note_href})")

        for lesson in lesson_markdown_files(BUILD_DIR / slug):
            lesson_title = first_markdown_heading(read_text(lesson))
            label = lesson_title.lstrip("#").strip() if lesson_title else lesson.stem
            lines.append(f"  - [{label}]({slug}/{lesson.name})")

    write_text(BUILD_DIR / "SUMMARY.md", "\n".join(lines).rstrip() + "\n")


def combine_stats(stats: Iterable[BuildStats]) -> BuildStats:
    combined = BuildStats()
    for item in stats:
        combined.lessons += item.lessons
        combined.aligned_blocks += item.aligned_blocks
        combined.untranslated_blocks += item.untranslated_blocks
        combined.missing_translations += item.missing_translations
        combined.seminars.update(item.seminars)
    return combined


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build mdBook input pages from texts.")
    parser.add_argument(
        "--seminar",
        action="append",
        help="Seminar slug to build. May be used multiple times. Defaults to every texts/*/original directory.",
    )
    parser.add_argument(
        "--skip-summary",
        action="store_true",
        help="Do not regenerate build/SUMMARY.md.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    seminars = args.seminar or discover_text_seminars()
    if not seminars:
        raise SystemExit("No seminar directories found under texts/")

    try:
        validate_selected_seminar_id_markers(seminars)
    except DuplicateIdError as error:
        raise SystemExit(str(error)) from None

    knowledge_cards = parse_knowledge_cards()
    knowledge_by_segment = knowledge_cards_by_segment(knowledge_cards)
    build_knowledge_base(knowledge_cards)
    build_ai_knowledge_index(knowledge_cards)
    stats = combine_stats(
        build_seminar(slug, knowledge_by_segment)
        for slug in seminars
    )
    if not args.skip_summary:
        write_summary()
    build_navigation_index(knowledge_cards)

    seminar_list = ", ".join(sorted(stats.seminars))
    print(f"Built seminars: {seminar_list}")
    print(f"Lessons: {stats.lessons}")
    print(f"Aligned translation blocks: {stats.aligned_blocks}")
    print(f"Untranslated blocks: {stats.untranslated_blocks}")
    print(f"Missing translation blocks: {stats.missing_translations}")


if __name__ == "__main__":
    main()
