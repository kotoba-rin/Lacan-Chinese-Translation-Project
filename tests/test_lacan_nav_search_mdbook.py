import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class LacanNavigationSearchMdBookTest(unittest.TestCase):
    def test_global_navigation_search_is_lazy_and_accessible(self):
        script = (ROOT / "theme" / "lacan-nav-search.js").read_text(encoding="utf-8")
        styles = (ROOT / "theme" / "lacan-nav-search.css").read_text(encoding="utf-8")

        self.assertIn('fetch(rootPath() + "navigation-index.json")', script)
        self.assertIn("导航搜索", script)
        self.assertIn("搜索标题、知识卡、课程或段落 ID", script)
        self.assertIn('setAttribute("role", "dialog")', script)
        self.assertIn('setAttribute("aria-modal", "true")', script)
        self.assertIn("LacanNavigationSearch", script)
        self.assertIn("@media (max-width: 640px)", styles)

    def test_lesson_toolbar_uses_navigation_search_not_mdbook_searchbar(self):
        toggle = (ROOT / "theme" / "lacan-toggle.js").read_text(encoding="utf-8")
        builder = (ROOT / "scripts" / "build_from_texts.py").read_text(encoding="utf-8")

        self.assertIn("LacanNavigationSearch", toggle)
        self.assertIn("搜索标题、知识卡或段落 ID", toggle)
        self.assertIn("搜索标题、知识卡或段落 ID", builder)
        self.assertNotIn("mdbook-searchbar", toggle)
        self.assertNotIn("openBookSearch", toggle)
        self.assertNotIn("搜索全文", toggle)
        self.assertNotIn("搜索全文", builder)


if __name__ == "__main__":
    unittest.main()
