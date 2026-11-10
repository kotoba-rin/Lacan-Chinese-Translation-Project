"""Content-boundary regressions for the offline reading edition."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import export_ebook as ebook
from build_from_texts import TranslationEntry


class EbookBoundaryTest(unittest.TestCase):
    def test_notes_survive_but_explicit_and_legacy_commentary_do_not(self):
        entry = TranslationEntry('s8-01-0001', ['s8-01-0001'],
            '正文[注]。\n\n> [注] 原有注释。\n> 注释的第二行。\n\n'
            '> <!-- 建言 -->\n> 注：这是显式建言。\n\n> 这是旧式建言。\n\n'
            '[[notes/reading|阅读笔记]]')
        kept = ebook.kept_chunks(entry)
        self.assertEqual(kept, [('normal', '正文[注]。'),
            ('note', '> [注] 原有注释。\n> 注释的第二行。')])

    def test_source_quotation_is_not_deleted_as_commentary(self):
        entry = TranslationEntry('s8-27-0007', ['s8-27-0007'], '> 争议、即使不是分歧的位置。')
        self.assertEqual(ebook.kept_chunks(entry), [('normal', entry.content)])

    def test_changed_quote_override_requires_review(self):
        entry = TranslationEntry('s8-27-0007', ['s8-27-0007'], '> <!-- 建言 -->\n> 新的建言。')
        with self.assertRaises(ValueError):
            ebook.kept_chunks(entry)

    def test_escaped_square_brackets_are_not_math(self):
        formulas = []
        kept = ebook.math_placeholders(r'图中\[Ⅰ\]，以及 \\(\not S\\)。', formulas)
        self.assertIn(r'\[Ⅰ\]', kept)
        self.assertEqual(formulas, [{'tex': r'\not S', 'display': False}])


class PdfFontCompatibilityTest(unittest.TestCase):
    def test_page_headers_and_titles_embed_truetype_fonts(self):
        """The former CFF PingFang subset corrupts these in macOS Quartz."""
        from weasyprint import HTML
        from pypdf import PdfReader
        css = (ebook.ROOT / 'scripts/ebooks/reader.css').read_text()
        with tempfile.TemporaryDirectory() as folder:
            stage = Path(folder)
            sample = '<h1>第1课 · 1960年11月16日</h1><code>phallus｜阳具</code>'
            css = ebook.pdf_stylesheet(css, stage, sample)
            pdf = HTML(string='<style>' + css + '</style>' + sample).write_pdf()
            from io import BytesIO
            reader = PdfReader(BytesIO(pdf))
            for font_ref in reader.pages[0]['/Resources']['/Font'].values():
                font = font_ref.get_object()
                descendant = font['/DescendantFonts'][0]
                self.assertEqual(descendant['/Subtype'], '/CIDFontType2', font['/BaseFont'])
                self.assertIn('/FontFile2', descendant['/FontDescriptor'])


if __name__ == '__main__':
    unittest.main()
