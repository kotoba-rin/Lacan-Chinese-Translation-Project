import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "publish_reading_branch.py"
SPEC = importlib.util.spec_from_file_location("publish_reading_branch", SCRIPT)
reading = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = reading
SPEC.loader.exec_module(reading)


class CommentaryBoundaryTest(unittest.TestCase):
    def test_only_commentary_is_removed_and_kept_bytes_are_unchanged(self):
        before = "---\r\ntitle: 测试\r\n---\r\n<!-- id: s1-01-0001 -->\r\n正文 $x > y$。\r\n\r\n> [注] 保留注释。\r\n> 第二行。\r\n\r\n> 旧式建言。\r\n\r\n> <!-- 建言 -->\r\n> 注：仍是明确标记的建言。\r\n\r\n<!-- ids: s1-01-0001 s1-01-0002 -->\r\n"
        result, count = reading.strip_commentary(before, translation=True)
        expected = before.replace("> 旧式建言。\r\n", "").replace("> <!-- 建言 -->\r\n> 注：仍是明确标记的建言。\r\n", "")
        self.assertEqual(result, expected)
        self.assertEqual(count, 2)

    def test_originals_and_independent_notes_keep_unmarked_quotations(self):
        text = "正文中的建言二字照常保留。\n\n> 作为正文的引文。\n\n> <!-- 建言 -->\n> 移除。\n"
        result, count = reading.strip_commentary(text)
        self.assertIn("> 作为正文的引文。\n", result)
        self.assertIn("正文中的建言二字照常保留。", result)
        self.assertNotIn("移除。", result)
        self.assertEqual(count, 1)

    def test_literal_fences_raw_html_math_and_source_quotations_survive(self):
        literal = "```markdown\n<!-- id: s99-01-0001 -->\n> <!-- 建言 -->\n> 示例代码。\n```\n\n~~~\n> 另一个示例。\n~~~\n\n$$\n> x+y\n$$\n\n<div class=\"text-quotation\">\n> 正文引文。\n</div>\n\n<pre>\n> <!-- 建言 -->\n</pre>\n"
        result, count = reading.strip_commentary(literal, translation=True)
        self.assertEqual(result, literal)
        self.assertEqual(count, 0)
        reviewed = "<!-- id: s8-27-0007 -->\n\n> 经既有电子书核对的正文引文。\n"
        self.assertEqual(reading.strip_commentary(reviewed, translation=True), (reviewed, 0))
        with self.assertRaisesRegex(ValueError, "Reviewed source quotation"):
            reading.strip_commentary(reviewed.replace("> 经", "> <!-- 建言 -->\n> 经"), translation=True)

    def test_literal_markers_in_quoted_fences_are_preserved(self):
        text = "> ```markdown\n> <!-- 建言 -->\n> ```\n"
        self.assertEqual(reading.strip_commentary(text, translation=True), (text, 0))
        inline = "> 使用 `<!-- 建言 -->` 展示字面标记。\n"
        self.assertEqual(reading.strip_commentary(inline), (inline, 0))

    def test_nested_source_quotation_html_keeps_its_entire_body(self):
        text = '<div class="text-quotation">\n<div>\n> 第一段正文。\n</div>\n> 第二段正文。\n</div>\n\n> 外部建言。\n'
        self.assertEqual(reading.strip_commentary(text, translation=True), (text.replace("> 外部建言。\n", ""), 1))

    def test_note_before_explicit_marker_in_same_quote_is_preserved(self):
        text = "> <span id=\"note\"></span>\n> [译注1] 必须保留。\n>\n> <!-- 建言 -->\n> 必须移除。\n"
        result, count = reading.strip_commentary(text, translation=True)
        self.assertEqual(result, "> <span id=\"note\"></span>\n> [译注1] 必须保留。\n>\n")
        self.assertEqual(count, 1)

    def test_standalone_marker_requires_a_defined_quote_boundary(self):
        text = "正文。\n\n<!-- 建言 -->\n\n> 建言内容。\n\n后续正文。\n"
        self.assertEqual(reading.strip_commentary(text), ("正文。\n\n\n后续正文。\n", 1))
        with self.assertRaisesRegex(ValueError, "no following quote block"):
            reading.strip_commentary("<!-- 建言 -->\n范围不明确，不能猜测删除。\n")


class PublicationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "source"
        self.root.mkdir()
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Reading Test")
        self.git("config", "user.email", "reading-test@example.invalid")
        self.translation = "texts/s1-test/translation/Leçon-01.md"
        self.original = "texts/s1-test/original/Leçon-01.md"
        self.write(self.translation, "<!-- id: s1-01-0001 -->\n译文。\n\n> [注] 保留。\n\n> 建言。\n")
        self.write(self.original, "<!-- id: s1-01-0001 -->\n> Une citation.\n")
        self.write("知识库/知识卡.md", "> 引文应保留。\n")
        self.write("README.md", "# Main\n")
        self.write("scripts/example.py", "# > <!-- 建言 --> literal script\n")
        self.git("add", ".")
        self.git("commit", "-m", "Initial source")
        self.source = self.git("rev-parse", "HEAD").strip()

    def tearDown(self):
        self.temporary.cleanup()

    def git(self, *arguments, input=None):
        result = subprocess.run(["git", "-C", str(self.root), *arguments], input=input, capture_output=True, text=True, check=True)
        return result.stdout

    def write(self, path, value):
        destination = self.root / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(value, encoding="utf-8")

    def test_publish_preserves_main_index_drafts_and_existing_reading_history(self):
        self.git("branch", "reading", self.source)
        self.write(self.translation, "PRIVATE UNSAVED MAIN DRAFT\n")
        self.write("staged.txt", "staged unrelated content\n")
        self.git("add", "staged.txt")
        self.write("untracked-note.md", "PRIVATE UNTRACKED NOTE\n")
        index = (self.root / ".git/index").read_bytes()
        result = reading.publish_reading_branch(self.root, self.source)
        published = result["reading_revision"]
        self.assertEqual(self.git("branch", "--show-current").strip(), "main")
        self.assertEqual(self.git("rev-parse", "HEAD").strip(), self.source)
        self.assertEqual((self.root / ".git/index").read_bytes(), index)
        self.assertEqual((self.root / self.translation).read_text(), "PRIVATE UNSAVED MAIN DRAFT\n")
        self.assertIn("> 建言。", self.git("show", f"main:{self.translation}"))
        self.assertNotIn("建言。", self.git("show", f"reading:{self.translation}"))
        self.assertIn("> [注] 保留。", self.git("show", f"reading:{self.translation}"))
        self.assertEqual(self.git("show", f"reading:{self.original}"), self.git("show", f"main:{self.original}"))
        self.assertNotIn("untracked-note.md", self.git("ls-tree", "-r", "--name-only", "reading"))
        self.assertNotIn("staged.txt", self.git("ls-tree", "-r", "--name-only", "reading"))
        self.git("merge-base", "--is-ancestor", self.source, published)
        self.assertTrue(reading.validate_reading_tree(self.root, published)["verified"])
        self.assertEqual(reading.publish_reading_branch(self.root, self.source)["reading_revision"], published)

    def test_remote_push_is_fast_forward_and_shallow_validator_has_source(self):
        remote = Path(self.temporary.name) / "remote.git"
        subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
        self.git("remote", "add", "publication", str(remote))
        first = reading.publish_reading_branch(self.root, self.source, remote="publication", push=True)
        self.write("README.md", "# Changed canonical source\n")
        self.git("add", "README.md")
        self.git("commit", "-m", "Update canonical source")
        second = reading.publish_reading_branch(self.root, "HEAD", remote="publication", push=True)
        self.git("merge-base", "--is-ancestor", first["reading_revision"], second["reading_revision"])
        observed = self.git("ls-remote", "--heads", "publication", "refs/heads/reading").split()[0]
        self.assertEqual(observed, second["reading_revision"])
        shallow = Path(self.temporary.name) / "shallow.git"
        subprocess.run(["git", "clone", "--bare", "--depth=2", "--branch=reading", remote.as_uri(), str(shallow)], check=True, capture_output=True)
        self.assertTrue(reading.validate_reading_tree(shallow, "HEAD")["verified"])

    def test_validator_rejects_tampering_and_missing_provenance(self):
        with self.assertRaisesRegex(ValueError, "provenance is missing"):
            reading.validate_reading_tree(self.root, self.source)
        generated = reading.publish_reading_branch(self.root, self.source)
        self.git("checkout", "-b", "tampered", generated["reading_revision"])
        self.write(self.original, "SILENT BODY LOSS\n")
        self.git("add", self.original)
        self.git("commit", "-m", "Tamper reading content")
        with self.assertRaisesRegex(ValueError, "differs from its verified transformation"):
            reading.validate_reading_tree(self.root, "HEAD")

    def test_export_reads_only_committed_content_and_rejects_overwrite(self):
        destination = Path(self.temporary.name) / "export"
        self.write(self.translation, "PRIVATE WORKTREE MODIFICATION\n")
        metadata = reading.export_tree(self.root, self.source, destination)
        self.assertEqual(metadata["removed_blocks"], 1)
        self.assertNotIn("建言。", (destination / self.translation).read_text())
        self.assertIn("译文。", (destination / self.translation).read_text())
        self.assertEqual(json.loads((destination / reading.PROVENANCE_PATH).read_text()), metadata)
        with self.assertRaisesRegex(ValueError, "empty directory"):
            reading.export_tree(self.root, self.source, destination)

    def test_checked_out_reading_branch_is_not_rewritten(self):
        self.git("checkout", "-b", "reading")
        with self.assertRaisesRegex(ValueError, "checked out"):
            reading.publish_reading_branch(self.root, self.source)


if __name__ == "__main__":
    unittest.main()
