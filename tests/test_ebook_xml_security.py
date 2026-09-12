"""XML safety and SVG/EPUB compatibility; requires only the optional lxml."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import export_ebook as ebook


class EbookXmlSecurityTest(unittest.TestCase):
    def test_namespaces_text_and_predefined_entities_survive(self):
        document = ebook.parse_xml(
            f'<svg xmlns="{ebook.SVG}" viewBox="0 0 10 10">'
            '<text id="label">移情 &amp; &lt; &#x3A6;</text></svg>'.encode())
        self.assertEqual(document.tag, f'{{{ebook.SVG}}}svg')
        self.assertEqual(document.get('viewBox'), '0 0 10 10')
        self.assertEqual(document[0].get('id'), 'label')
        self.assertEqual(document[0].text, '移情 & < Φ')
        document.append(ebook.etree.Element(f'{{{ebook.SVG}}}title'))
        self.assertEqual(len(document), 2)

    def test_dtds_and_internal_entities_are_rejected_in_supported_encodings(self):
        documents = [
            '<!DOCTYPE root><root/>',
            '<!DOCTYPE root [<!ENTITY secret "MARKER">]><root>&secret;</root>',
            '<!DOCTYPE root [<!ENTITY a "MARKER"><!ENTITY b "&a;&a;">]>'
            '<root>&b;</root>',
            '<!DOCTYPE root [<!ATTLIST root id CDATA "injected">]><root/>',
        ]
        for document in documents:
            for encoding in ('utf-8', 'utf-16'):
                with self.subTest(document=document, encoding=encoding):
                    with self.assertRaisesRegex(ValueError, 'DTD declarations'):
                        ebook.parse_xml(document.encode(encoding))

    def test_external_entities_and_dtds_never_reach_the_resource_resolver(self):
        requests = []

        class RecordingResolver(ebook.etree.Resolver):
            def resolve(self, url, public_id, context):
                requests.append(url)
                return self.resolve_string('EXTERNAL_MARKER', context)

        original_parser = ebook.etree.XMLParser

        def recording_parser(*args, **kwargs):
            parser = original_parser(*args, **kwargs)
            parser.resolvers.add(RecordingResolver())
            return parser

        with tempfile.TemporaryDirectory() as folder:
            secret = Path(folder) / 'sentinel.txt'
            secret.write_text('LOCAL_MARKER')
            for uri in (secret.as_uri(), 'https://ebook-xml-test.invalid/resource'):
                documents = [
                    f'<!DOCTYPE root SYSTEM "{uri}"><root/>',
                    f'<!DOCTYPE root [<!ENTITY secret SYSTEM "{uri}">]>'
                    '<root>&secret;</root>',
                    f'<!DOCTYPE root [<!ENTITY % external SYSTEM "{uri}">'
                    '%external;]><root/>',
                ]
                for document in documents:
                    with self.subTest(document=document):
                        with patch.object(ebook.etree, 'XMLParser', recording_parser):
                            with self.assertRaisesRegex(ValueError, 'DTD declarations'):
                                ebook.parse_xml(document.encode())
                        self.assertEqual(requests, [])

    def test_an_unsafe_global_parser_cannot_enable_entity_expansion(self):
        original = ebook.etree.get_default_parser()
        ebook.etree.set_default_parser(ebook.etree.XMLParser(resolve_entities=True))
        try:
            with self.assertRaisesRegex(ValueError, 'DTD declarations'):
                ebook.parse_xml(b'<!DOCTYPE root [<!ENTITY e "MARKER">]><root>&e;</root>')
        finally:
            ebook.etree.set_default_parser(original)

    def test_malformed_xml_is_not_recovered(self):
        with self.assertRaises(ebook.etree.XMLSyntaxError):
            ebook.parse_xml(b'<root><child></root>')

    def test_math_output_remains_compatible_with_lxml_chapters(self):
        root = ebook.html.fragment_fromstring(
            '<div><span class="math-source" data-formula="0"></span></div>')
        svg = f'<svg xmlns="{ebook.SVG}" viewBox="0 0 1 1"><path d="M0 0"/></svg>'
        result = subprocess.CompletedProcess([], 0, stdout=json.dumps([svg]))
        with patch.object(ebook.subprocess, 'run', return_value=result):
            ebook.prepare_math([{'root': root}], [{'tex': r'\Phi', 'display': False}])
        self.assertEqual(root[0].get('class'), 'math-inline')
        self.assertEqual(root[0][0].tag, f'{{{ebook.SVG}}}svg')
        self.assertEqual(root[0][0][0].text, r'\Phi')
        self.assertEqual(root[0][0].get('viewBox'), '0 0 1 1')

    def test_math_output_with_entities_is_rejected(self):
        root = ebook.html.fragment_fromstring(
            '<div><span class="math-source" data-formula="0"></span></div>')
        svg = f'<!DOCTYPE svg [<!ENTITY e "MARKER">]><svg xmlns="{ebook.SVG}">&e;</svg>'
        result = subprocess.CompletedProcess([], 0, stdout=json.dumps([svg]))
        with patch.object(ebook.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(ValueError, 'DTD declarations'):
                ebook.prepare_math([{'root': root}], [{'tex': 'x', 'display': False}])
        self.assertEqual(len(root[0]), 0)

    def test_generated_epub_passes_xml_links_and_content_validation(self):
        root = ebook.html.fragment_fromstring(
            '<div><section id="lesson-01"><div id="s8-01-0001">'
            '<p>移情 &amp; 欲望</p><div class="annotation">注释</div>'
            '<div class="knowledge-links"><a href="https://kotoba-rin.com/seminars/">'
            '知识卡</a></div><a href="#s8-01-0001">返回段落</a>'
            '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>'
            '</div></section></div>')
        chapters = [{'number': 1, 'title': '第1课', 'root': root}]
        audit = {'segment_ids': ['s8-01-0001'], 'annotation_blocks': 1, 'knowledge_links': 1}
        known = {'ebook-toc': 0, 'lesson-01': 1, 's8-01-0001': 1}
        with tempfile.TemporaryDirectory() as folder:
            stage = Path(folder)
            (stage / 'assets').mkdir()
            (stage / 'assets/cover.png').write_bytes(b'fixture-cover')
            output = stage / 'book.epub'
            ebook.write_epub(output, '移情', chapters, stage, '', '2026-09-12', known)
            ebook.validate_epub(output, audit)
            with zipfile.ZipFile(output) as archive:
                document = ebook.parse_xml(archive.read('EPUB/lesson-01.xhtml'))
            svg = next(document.iter(f'{{{ebook.SVG}}}svg'))
            self.assertEqual(svg.get('viewBox'), '0 0 1 1')
            self.assertIn('移情 & 欲望', ''.join(document.itertext()))

    def test_epub_validation_rejects_entities_in_every_xml_document_type(self):
        audit = {'segment_ids': [], 'annotation_blocks': 0, 'knowledge_links': 0}
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / 'book.epub'
            for extension in ('.xhtml', '.opf', '.ncx', '.xml'):
                with self.subTest(extension=extension):
                    with zipfile.ZipFile(output, 'w') as archive:
                        archive.writestr('mimetype', 'application/epub+zip',
                                         compress_type=zipfile.ZIP_STORED)
                        archive.writestr('EPUB/document' + extension,
                            '<!DOCTYPE root [<!ENTITY e "MARKER">]><root>&e;</root>')
                    with self.assertRaisesRegex(ValueError, 'DTD declarations'):
                        ebook.validate_epub(output, audit)


if __name__ == '__main__':
    unittest.main()
