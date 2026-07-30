import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class MdBookNavigationConfigTest(unittest.TestCase):
    def test_markdown_pages_are_sidebar_leaves(self):
        config = (ROOT / "book.toml").read_text(encoding="utf-8")
        html_section = re.search(
            r"(?ms)^\[output\.html\]\s*$\n(.*?)(?=^\[|\Z)",
            config,
        )

        self.assertIsNotNone(html_section)
        self.assertRegex(
            html_section.group(1),
            r"(?m)^sidebar-header-nav\s*=\s*false\s*$",
            "mdBook must not expand in-page headings beneath Markdown files",
        )


if __name__ == "__main__":
    unittest.main()
