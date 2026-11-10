#!/usr/bin/env python3
"""Publish a derived reading branch without changing canonical working files."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile
import uuid


PROVENANCE_PATH = ".reading-source.json"
TRANSFORM = "remove-commentary-v1"
PUBLIC_ROOTS = {"texts", "知识库", "术语表", "assets"}
PUBLIC_ROOT_FILES = {"README.md", "LICENSE.md", "NOTICE.md"}
LESSON_RE = re.compile(r"^(?:Leçon|Lecon|lesson)-\d+\.md$", re.I)
ID_RE = re.compile(r"^\s*<!--\s*id\s*:\s*([^\s>]+)\s*-->\s*$", re.I)
MARKER_RE = re.compile(r"<!--\s*建言\s*-->")
QUOTE_RE = re.compile(r"^[ \t]{0,3}>[ \t]?")
FENCE_RE = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})(.*)$")
RAW_RE = re.compile(r'^\s*<(pre|code|script|style|textarea|blockquote)\b', re.I)
SOURCE_QUOTATIONS = {"s8-19-0093", "s8-27-0007"}


def strip_quote_prefix(line: str) -> str:
    while QUOTE_RE.match(line):
        line = QUOTE_RE.sub("", line, count=1)
    return line


def visible_marker(line: str) -> bool:
    # Backtick code spans are literal examples, not editorial instructions.
    visible = re.sub(r"(`+)(?:(?!\1).)*?\1", "", strip_quote_prefix(line))
    return bool(MARKER_RE.search(visible))


def note_like_quote(lines: list[str]) -> bool:
    visible = "\n".join(strip_quote_prefix(line).strip() for line in lines)
    visible = re.sub(r"<span\b[^>]*>\s*</span>", "", visible).strip()
    return visible.lstrip("【[（(〔［").strip().startswith(("注", "译注", "原文注", "出版说明"))


def protected_end(lines: list[str], index: int) -> int | None:
    """Return the first line after a literal/code/math/source-quotation region."""
    first = lines[index].rstrip("\r\n")
    fence = FENCE_RE.match(first)
    if fence:
        character, length = fence[1][0], len(fence[1])
        closing = re.compile(rf"^[ \t]{{0,3}}{re.escape(character)}{{{length},}}[ \t]*$")
        for end in range(index + 1, len(lines)):
            if closing.match(lines[end].rstrip("\r\n")):
                return end + 1
        return len(lines)
    stripped = first.strip()
    math_close = {"$$": "$$", r"\[": r"\]", r"\\[": r"\\]"}.get(stripped)
    if math_close:
        for end in range(index + 1, len(lines)):
            if lines[end].strip() == math_close:
                return end + 1
        return len(lines)
    raw = RAW_RE.match(first)
    quotation = re.match(r'^\s*<div\b[^>]*\bclass\s*=\s*["\'][^"\']*\btext-quotation\b', first, re.I)
    tag = raw[1] if raw else "div" if quotation else None
    if tag:
        if tag.lower() in {"div", "blockquote"}:
            depth = 0
            tags = re.compile(rf"<(/?){tag}\b[^>]*>", re.I)
            for end in range(index, len(lines)):
                for match in tags.finditer(lines[end]):
                    depth += -1 if match[1] else 1
                    if depth == 0:
                        return end + 1
            return len(lines)
        closing = re.compile(rf"</{tag}\s*>", re.I)
        for end in range(index, len(lines)):
            if closing.search(lines[end]):
                return end + 1
        return len(lines)
    return None


def quote_marker_indices(lines: list[str]) -> tuple[list[int], bool]:
    indices = []
    fenced = None
    has_fence = False
    for index, line in enumerate(lines):
        visible = strip_quote_prefix(line).rstrip("\r\n")
        fence = FENCE_RE.match(visible)
        if fenced:
            if re.match(rf"^[ \t]{{0,3}}{re.escape(fenced[0])}{{{fenced[1]},}}[ \t]*$", visible):
                fenced = None
            continue
        if fence:
            fenced = (fence[1][0], len(fence[1]))
            has_fence = True
        elif visible_marker(line):
            indices.append(index)
    return indices, has_fence


def strip_commentary(text: str, *, translation: bool = False) -> tuple[str, int]:
    """Remove commentary blocks, preserving all retained bytes and line endings.

    Translation lessons retain the project's legacy note/quote distinction.
    Other Markdown loses only explicitly marked editorial quote blocks.
    """
    lines = text.splitlines(keepends=True)
    kept = []
    removed = 0
    anchor = ""
    index = 0
    while index < len(lines):
        end = protected_end(lines, index)
        if end is not None:
            kept.extend(lines[index:end])
            index = end
            continue
        current = lines[index]
        marker = ID_RE.match(current.rstrip("\r\n"))
        if marker:
            anchor = marker[1].lower()
        standalone = MARKER_RE.fullmatch(current.strip())
        explicit = False
        quote_start = index
        if standalone:
            quote_start += 1
            while quote_start < len(lines) and not lines[quote_start].strip():
                quote_start += 1
            if quote_start >= len(lines) or not QUOTE_RE.match(lines[quote_start]):
                raise ValueError("Unquoted commentary marker has no following quote block")
            explicit = True
        if not QUOTE_RE.match(lines[quote_start]):
            kept.append(current)
            index += 1
            continue
        end = quote_start
        while end < len(lines) and QUOTE_RE.match(lines[end]):
            end += 1
        quote = lines[quote_start:end]
        markers, has_fence = quote_marker_indices(quote)
        if translation and anchor in SOURCE_QUOTATIONS:
            if explicit or markers:
                raise ValueError(f"Reviewed source quotation now has a commentary marker: {anchor}")
            kept.extend(lines[index:end])
        elif explicit:
            removed += 1
        elif markers:
            # A note immediately preceding a new explicit marker remains a note.
            prefix = quote[:markers[0]]
            if prefix and (not translation or note_like_quote(prefix)):
                kept.extend(prefix)
            elif prefix:
                removed += 1
            removed += len(markers)
        elif translation and not note_like_quote(quote) and not has_fence:
            removed += 1
        else:
            kept.extend(quote)
        index = end
    return "".join(kept), removed


@dataclass(frozen=True)
class TreeEntry:
    mode: str
    kind: str
    oid: str
    path: str


def git(root: Path, *args: str, input: bytes | None = None, env: dict | None = None) -> bytes:
    result = subprocess.run(["git", "-C", str(root), *args], input=input, capture_output=True, env=env)
    if result.returncode:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise ValueError(f"git {args[0]} failed: {detail}")
    return result.stdout


def commit_id(root: Path, revision: str) -> str:
    if not revision or revision.startswith("-"):
        raise ValueError("A commit revision is required")
    return git(root, "rev-parse", "--verify", f"{revision}^{{commit}}").decode().strip()


def tree_entries(root: Path, revision: str) -> list[TreeEntry]:
    entries = []
    for record in git(root, "ls-tree", "-rz", "--full-tree", revision).split(b"\0"):
        if not record:
            continue
        metadata, name = record.split(b"\t", 1)
        mode, kind, oid = metadata.decode("ascii").split(" ")
        path = name.decode("utf-8")
        if PurePosixPath(path).is_absolute() or any(part in {"", ".", ".."} for part in path.split("/")) or "\\" in path:
            raise ValueError("Unsupported repository file path")
        entries.append(TreeEntry(mode, kind, oid, path))
    return entries


class BlobReader:
    def __init__(self, root: Path):
        self.process = subprocess.Popen(["git", "-C", str(root), "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def read(self, oid: str) -> bytes:
        self.process.stdin.write((oid + "\n").encode("ascii"))
        self.process.stdin.flush()
        header = self.process.stdout.readline().decode("ascii").strip().split()
        if len(header) != 3 or header[0] != oid or header[1] != "blob":
            raise ValueError("Git returned an unexpected blob")
        length = int(header[2])
        data = self.process.stdout.read(length)
        if len(data) != length or self.process.stdout.read(1) != b"\n":
            raise ValueError("Git returned an incomplete blob")
        return data

    def __enter__(self):
        return self

    def __exit__(self, kind, value, traceback):
        self.process.stdin.close()
        if kind:
            self.process.terminate()
        try:
            status = self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            status = self.process.wait()
        detail = self.process.stderr.read().decode("utf-8", errors="replace")
        self.process.stdout.close()
        self.process.stderr.close()
        if status and not kind:
            raise ValueError(f"Git blob reader failed: {detail.strip()}")


def public_markdown(path: str) -> bool:
    parts = path.split("/")
    return path in PUBLIC_ROOT_FILES or (len(parts) > 1 and parts[0] in PUBLIC_ROOTS and path.lower().endswith(".md"))


def translation_lesson(path: str) -> bool:
    parts = path.split("/")
    return len(parts) == 4 and parts[0] == "texts" and parts[2] == "translation" and bool(LESSON_RE.fullmatch(parts[3]))


def transformed_tree(root: Path, revision: str) -> tuple[list[TreeEntry], dict[str, bytes], dict]:
    source = commit_id(root, revision)
    entries = tree_entries(root, source)
    if any(entry.path == PROVENANCE_PATH for entry in entries):
        raise ValueError("The source is already a derived reading edition; select a main commit")
    updates = {}
    scanned = removed = changed = 0
    with BlobReader(root) as reader:
        for entry in entries:
            if not public_markdown(entry.path):
                continue
            if entry.kind != "blob" or entry.mode not in {"100644", "100755"}:
                raise ValueError(f"Public Markdown must be a regular file: {entry.path}")
            data = reader.read(entry.oid)
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError as error:
                raise ValueError(f"Public Markdown is not UTF-8: {entry.path}") from error
            stripped, count = strip_commentary(text, translation=translation_lesson(entry.path))
            scanned += 1
            removed += count
            transformed = stripped.encode("utf-8")
            if transformed != data:
                updates[entry.path] = transformed
                changed += 1
    provenance = {"schema_version": 1, "source_branch": "main", "source_revision": source, "transform": TRANSFORM,
                  "scanned_files": scanned, "transformed_files": changed, "removed_blocks": removed}
    updates[PROVENANCE_PATH] = (json.dumps(provenance, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    return entries, updates, provenance


def blob_oid(data: bytes, algorithm: str) -> str:
    return hashlib.new(algorithm, b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


def validate_reading_tree(source_root: Path, revision: str) -> dict:
    root = Path(source_root).resolve()
    revision = commit_id(root, revision)
    actual = {entry.path: entry for entry in tree_entries(root, revision)}
    record = actual.get(PROVENANCE_PATH)
    if record is None or record.mode != "100644" or record.kind != "blob":
        raise ValueError("Reading provenance is missing or is not a regular file")
    raw = git(root, "cat-file", "blob", record.oid)
    if len(raw) > 16384:
        raise ValueError("Reading provenance exceeds the permitted size")
    try:
        provenance = json.loads(raw)
    except (UnicodeDecodeError, ValueError) as error:
        raise ValueError("Reading provenance is not valid JSON") from error
    if not isinstance(provenance, dict) or provenance.get("schema_version") != 1 or provenance.get("source_branch") != "main" or provenance.get("transform") != TRANSFORM or not re.fullmatch(r"[0-9a-f]{40,64}", str(provenance.get("source_revision", ""))):
        raise ValueError("Unsupported reading provenance")
    entries, updates, expected_provenance = transformed_tree(root, provenance["source_revision"])
    if provenance != expected_provenance:
        raise ValueError("Reading provenance does not match the canonical source")
    algorithm = git(root, "rev-parse", "--show-object-format").decode().strip()
    expected = {entry.path: entry for entry in entries}
    for path, data in updates.items():
        old = expected.get(path)
        expected[path] = TreeEntry(old.mode if old else "100644", "blob", blob_oid(data, algorithm), path)
    if actual != expected:
        differences = sorted(path for path in set(actual) | set(expected) if actual.get(path) != expected.get(path))
        raise ValueError(f"Reading tree differs from its verified transformation: {', '.join(differences[:5])}")
    return {**provenance, "reading_revision": revision, "verified": True}


def export_tree(root: Path, revision: str, destination: Path) -> dict:
    destination = destination.resolve()
    if destination.exists() and (not destination.is_dir() or any(destination.iterdir())):
        raise ValueError("Export destination must be an empty directory")
    entries, updates, provenance = transformed_tree(root, revision)
    destination.mkdir(parents=True, exist_ok=True)
    with BlobReader(root) as reader:
        for entry in entries:
            if entry.kind != "blob" or entry.mode not in {"100644", "100755"}:
                raise ValueError(f"Export supports only regular tracked files: {entry.path}")
            target = destination / entry.path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(updates.get(entry.path) if entry.path in updates else reader.read(entry.oid))
            target.chmod(0o755 if entry.mode == "100755" else 0o644)
    (destination / PROVENANCE_PATH).write_bytes(updates[PROVENANCE_PATH])
    return provenance


def optional_ref(root: Path, name: str) -> str | None:
    result = subprocess.run(["git", "-C", str(root), "rev-parse", "--verify", name], capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else None


def publish_reading_branch(root: Path, revision: str, *, branch: str = "reading", remote: str | None = None, push: bool = False) -> dict:
    if branch != "reading":
        raise ValueError("The generated branch must be named reading")
    target = f"refs/heads/{branch}"
    if f"branch {target}\n" in git(root, "worktree", "list", "--porcelain").decode("utf-8"):
        raise ValueError("The reading branch is checked out; leave its worktree before regenerating it")
    if push and not remote:
        raise ValueError("--push requires an explicit --remote")
    if remote:
        if remote.startswith("-") or not re.fullmatch(r"[A-Za-z0-9_.-]+", remote):
            raise ValueError("Use a configured Git remote name")
        git(root, "remote", "get-url", remote)
    entries, updates, provenance = transformed_tree(root, revision)
    old = optional_ref(root, target)
    remote_commit = None
    temporary_ref = f"refs/reading-publication/{uuid.uuid4().hex}"
    try:
        if remote:
            advertised = git(root, "ls-remote", "--heads", remote, target).decode().strip()
            if advertised:
                git(root, "fetch", "--no-tags", remote, f"{target}:{temporary_ref}")
                remote_commit = optional_ref(root, temporary_ref)
        with tempfile.TemporaryDirectory(prefix="lctp-reading-index-") as temporary:
            env = {**os.environ, "GIT_INDEX_FILE": str(Path(temporary) / "index")}
            git(root, "read-tree", provenance["source_revision"], env=env)
            modes = {entry.path: entry.mode for entry in entries}
            records = bytearray()
            for path, data in updates.items():
                oid = git(root, "hash-object", "-w", "--stdin", input=data).decode().strip()
                records.extend(f"{modes.get(path, '100644')} {oid}\t{path}".encode("utf-8") + b"\0")
            git(root, "update-index", "-z", "--index-info", input=bytes(records), env=env)
            tree = git(root, "write-tree", env=env).decode().strip()
        parents = list(dict.fromkeys(value for value in (remote_commit, old, provenance["source_revision"]) if value))
        candidate = remote_commit or old
        reusable = candidate and git(root, "rev-parse", f"{candidate}^{{tree}}").decode().strip() == tree
        if reusable:
            for parent in parents:
                if subprocess.run(["git", "-C", str(root), "merge-base", "--is-ancestor", parent, candidate], capture_output=True).returncode:
                    reusable = False
                    break
        if reusable:
            commit = candidate
        else:
            arguments = ["commit-tree", tree]
            for parent in parents:
                arguments.extend(["-p", parent])
            message = f"build(reading): Publish reading edition from {provenance['source_revision'][:12]}\n"
            commit = git(root, *arguments, input=message.encode("utf-8")).decode().strip()
        validate_reading_tree(root, commit)
        git(root, "update-ref", target, commit, old or "0" * len(commit))
        if push:
            git(root, "push", remote, f"{commit}:{target}")
            observed = git(root, "ls-remote", "--heads", remote, target).decode().split()
            if not observed or observed[0] != commit:
                raise ValueError(f"Reading push could not be verified; local commit is {commit}")
        return {**provenance, "reading_revision": commit, "branch": branch, "pushed": push, "remote": remote}
    finally:
        if optional_ref(root, temporary_ref):
            git(root, "update-ref", "-d", temporary_ref)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    for command in ("export", "publish", "check"):
        sub = subcommands.add_parser(command)
        sub.add_argument("--source-root", type=Path, default=Path(__file__).resolve().parents[1])
        sub.add_argument("--revision" if command == "check" else "--source-revision", default="HEAD")
        if command == "export":
            sub.add_argument("--output-dir", type=Path, required=True)
        if command == "publish":
            sub.add_argument("--target-branch", default="reading")
            sub.add_argument("--remote")
            sub.add_argument("--push", action="store_true")
    args = parser.parse_args()
    root = args.source_root.resolve()
    try:
        if args.command == "check":
            result = validate_reading_tree(root, args.revision)
        elif args.command == "export":
            result = export_tree(root, args.source_revision, args.output_dir)
        else:
            result = publish_reading_branch(root, args.source_revision, branch=args.target_branch, remote=args.remote, push=args.push)
    except (OSError, ValueError, UnicodeError) as error:
        print(f"Reading publication failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
