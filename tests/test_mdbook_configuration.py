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

    def test_builtin_full_text_search_is_disabled(self):
        config = (ROOT / "book.toml").read_text(encoding="utf-8")
        search_section = re.search(
            r"(?ms)^\[output\.html\.search\]\s*$\n(.*?)(?=^\[|\Z)",
            config,
        )

        self.assertIsNotNone(search_section)
        self.assertRegex(search_section.group(1), r"(?m)^enable\s*=\s*false\s*$")

    def test_small_navigation_search_assets_are_loaded(self):
        config = (ROOT / "book.toml").read_text(encoding="utf-8")
        html_section = re.search(
            r"(?ms)^\[output\.html\]\s*$\n(.*?)(?=^\[|\Z)",
            config,
        )

        self.assertIsNotNone(html_section)
        section = html_section.group(1)
        self.assertIn('"theme/lacan-nav-search.css"', section)
        self.assertRegex(
            section,
            r'additional-js\s*=\s*\[.*"theme/lacan-nav-search-core\.js".*"theme/lacan-nav-search\.js".*\]',
        )


if __name__ == "__main__":
    unittest.main()
