#!/usr/bin/env python3
"""Export a Chinese reading edition without mutating canonical texts or mdBook.

Dependencies: pandoc, weasyprint, lxml, Pillow; Node.js and mathjax-full.
See scripts/ebooks/README.md for setup and the scope of S8's reviewed exceptions.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import posixpath
import re
import subprocess
import sys
from datetime import datetime
from html import escape
from urllib.parse import unquote, urlsplit, quote
import uuid
import zipfile

import build_from_texts as source

ROOT = source.ROOT
# Optional isolated dependencies; the ordinary website remains stdlib-only.
sys.path.insert(0, str(ROOT / '.cache/ebooks/python'))
os.environ.setdefault('DYLD_FALLBACK_LIBRARY_PATH', '/opt/homebrew/lib')
from lxml import etree, html

WEB = 'https://kotoba-rin.com/seminars/'
XHTML = 'http://www.w3.org/1999/xhtml'
SVG = 'http://www.w3.org/2000/svg'
EPUB = 'http://www.idpf.org/2007/ops'
INLINE_MATH = re.compile(r'\\{1,2}\((.*?)\\{1,2}\)', re.S)
DISPLAY_MATH = re.compile(r'^\\{2}\[\s*\n?(.*?)\n?\\{2}\]\s*$', re.S | re.M)
# Verified against the exact French paragraphs. The web classifier treats these
# source-text quotations as commentary solely because they begin with >.
SOURCE_QUOTATIONS = {'s8-19-0093', 's8-27-0007'}


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def kept_chunks(entry):
    chunks = source.split_translation_chunks(entry.content)
    result = []
    for kind, lines in chunks:
        text = '\n'.join(lines).strip()
        if kind == 'commentary' and entry.anchor_id in SOURCE_QUOTATIONS:
            if source.COMMENTARY_MARKER_RE.search(text):
                raise ValueError(f'Body-quote override now has an explicit commentary marker: {entry.anchor_id}')
            kind = 'normal'
        if kind != 'commentary':
            result.append((kind, text))
    return result


def math_placeholders(text, formulas):
    def put(match, display=False):
        index = len(formulas)
        formulas.append({'tex': match[1].strip(), 'display': display})
        return f'<span class="math-source" data-formula="{index}"></span>'
    text = DISPLAY_MATH.sub(lambda m: put(m, True), text)
    return INLINE_MATH.sub(put, text)


def public_url(path):
    return WEB + quote(source.navigation_html_href(path), safe='/#%:')


def chapter_title(raw, number):
    heading = source.first_markdown_heading(raw) or ''
    date = heading.partition('|')[2].strip()
    months = {'janvier': 1, 'février': 2, 'mars': 3, 'avril': 4, 'mai': 5, 'juin': 6,
              'juillet': 7, 'août': 8, 'septembre': 9, 'octobre': 10, 'novembre': 11, 'décembre': 12}
    match = re.fullmatch(r'(\d+)\s+(\S+)\s+(\d{4})', date)
    if match and match[2].lower() in months:
        date = f'{match[3]}年{months[match[2].lower()]}月{int(match[1])}日'
    return f'第{number}课' + (f' · {date}' if date else '')


def collect_chapters(seminar, cards, audit):
    formulas = []
    chapters = []
    by_segment = source.knowledge_cards_by_segment(cards)
    for path in source.lesson_markdown_files(seminar / 'translation'):
        entries = source.parse_translation(path)
        number = source.lesson_number(path)
        original = source.parse_lesson(seminar / 'original' / path.name)
        expected = {p.paragraph_id for p in original.paragraphs}
        actual = [pid for e in entries for pid in e.paragraph_ids]
        if set(actual) != expected or len(actual) != len(set(actual)):
            raise ValueError(f'Segment coverage mismatch: {path.name}')
        title = chapter_title(path.read_text(), number)
        parts = [f'<section class="chapter" id="lesson-{number:02d}">', '', f'# {title}', '']
        for entry in entries:
            if entry.untranslated:
                raise ValueError(f'Untranslated entry: {entry.anchor_id}')
            chunks = kept_chunks(entry)
            if not any(k == 'normal' and t.strip() for k, t in chunks):
                raise ValueError(f'No body left after filtering: {entry.anchor_id}')
            parts.extend([f'<div class="segment" id="{entry.anchor_id}">', ''])
            for pid in entry.paragraph_ids:
                if pid != entry.anchor_id:
                    parts.extend([f'<span class="segment-anchor" id="{pid}"></span>', ''])
            record = {'id': entry.anchor_id, 'ids': entry.paragraph_ids, 'notes': [], 'cards': []}
            for kind, text in chunks:
                if kind == 'note':
                    record['notes'].append(hashlib.sha256(text.encode()).hexdigest())
                    text = re.sub(r'^\s*> ?', '', text, flags=re.M)
                    parts.extend(['<div class="annotation">', '', math_placeholders(source.render_translation_inline_markup(text), formulas), '', '</div>', ''])
                    audit['annotation_blocks'] += 1
                else:
                    parts.extend([math_placeholders(source.render_translation_inline_markup(text), formulas), ''])
            associated = source.knowledge_cards_for_paragraph_ids(entry.paragraph_ids, by_segment)
            if associated:
                links = []
                for card in associated:
                    href = public_url(card.output_relative_path.as_posix())
                    links.append(f'<a href="{escape(href, quote=True)}">{escape(card.title)}</a>')
                    record['cards'].append(href)
                parts.extend(['<div class="knowledge-links"><span class="label">相关知识卡</span>' + ' · '.join(links) + '</div>', ''])
            parts.extend(['</div>', ''])
            audit['entries'].append(record)
            audit['segment_ids'].extend(entry.paragraph_ids)
            removed = [t for k,t in source.split_translation_chunks(entry.content) if k == 'commentary' and entry.anchor_id not in SOURCE_QUOTATIONS]
            audit['excluded_commentary_blocks'] += len(removed)
        parts.extend(['</section>', ''])
        markdown = '\n'.join(parts).replace('[[课次目录](#TABLE)](#RETOUR)', '[返回目录](#ebook-toc)')
        rendered = subprocess.run(['pandoc', '-f', 'markdown+raw_html-smart', '-t', 'html5', '--wrap=none'],
                                  input=markdown, text=True, capture_output=True, check=True).stdout
        # Pandoc appends text-presentation selectors to arrows. On macOS Pango
        # those sequences can select LastResort even when the base glyph exists.
        rendered = rendered.replace('\ufe0e', '').replace('\ufe0f', '')
        root = html.fragment_fromstring(rendered, create_parent='div')
        chapters.append({'number': number, 'title': title, 'root': root, 'source': path})
    audit['formulas'] = len(formulas)
    return chapters, formulas


def resolve_asset(src, source_path):
    target = unquote(urlsplit(src).path)
    if urlsplit(src).scheme:
        raise ValueError(f'Remote image must be supplied locally for offline export: {src}')
    candidates = [ROOT / target, source_path.parent / target]
    if target.startswith('assets/'):
        candidates.extend(source_path.parents[1] / folder / target for folder in ('translation', 'original'))
    matches = [p.resolve() for p in candidates if p.is_file()]
    if not matches:
        raise FileNotFoundError(f'{source_path}: missing image {src}')
    return matches[0]


def prepare_assets(chapters, staging, audit):
    from PIL import Image
    assets = {}
    target_dir = staging / 'assets'
    target_dir.mkdir(parents=True, exist_ok=True)
    for old in target_dir.iterdir():
        old.unlink()
    for chapter in chapters:
        for img in chapter['root'].iter('img'):
            path = resolve_asset(img.get('src', ''), chapter['source'])
            if path not in assets:
                digest = sha256(path)[:16]
                with Image.open(path) as original:
                    image = original.convert('RGB') if original.mode not in ('RGB', 'RGBA', 'L') else original.copy()
                    image.thumbnail((2000, 2000))
                    suffix = '.jpg' if path.suffix.lower() in ('.jpeg', '.jpg') else '.png'
                    output = target_dir / (digest + suffix)
                    options = {'quality': 92, 'optimize': True} if suffix == '.jpg' else {'optimize': True}
                    image.save(output, **options)
                assets[path] = 'assets/' + output.name
            img.set('src', assets[path])
            # Old image filenames are not useful spoken labels, but keep authored alt text.
            if not img.get('alt') or re.fullmatch(r'image\d+\.[a-z]+', img.get('alt', '')):
                img.set('alt', '本课图示')
            img.attrib.pop('height', None)
    audit['images'] = [{'source': str(p.relative_to(ROOT)), 'sha256': sha256(p), 'href': h} for p,h in assets.items()]


def prepare_math(chapters, formulas):
    if not formulas:
        return
    process = subprocess.run(['node', str(ROOT / 'scripts/ebooks/math.cjs')],
                             input=json.dumps(formulas, ensure_ascii=False), text=True, capture_output=True, check=True)
    svgs = json.loads(process.stdout)
    for chapter in chapters:
        for placeholder in list(chapter['root'].iter('span')):
            if placeholder.get('class') != 'math-source':
                continue
            index = int(placeholder.attrib.pop('data-formula'))
            placeholder.set('class', 'math-display' if formulas[index]['display'] else 'math-inline')
            svg = etree.fromstring(svgs[index].encode())
            title = etree.Element(f'{{{SVG}}}title')
            title.text = formulas[index]['tex']
            svg.insert(0, title)
            svg.attrib.pop('focusable', None)
            placeholder.append(svg)


def rewrite_links(chapters, seminar, audit):
    known = {element.get('id'): c['number'] for c in chapters for element in c['root'].iter() if element.get('id')}
    known['ebook-toc'] = 0
    local_paths = {source.lesson_filename(c['number']): c['number'] for c in chapters}
    for chapter in chapters:
        root = chapter['root']
        for anchor in list(root.iter('a')):
            href = unquote(anchor.get('href', ''))
            parsed = urlsplit(href)
            if parsed.scheme or not href:
                continue
            path = posixpath.normpath(posixpath.join(seminar.name, parsed.path)) if parsed.path else seminar.name
            if '/notes/' in path or path.endswith('/notes'):
                anchor.drop_tree()
                continue
            if parsed.fragment in known and (not parsed.path or path.startswith(seminar.name + '/')):
                anchor.set('href', '#' + parsed.fragment)
            elif Path(parsed.path).name in local_paths and path.startswith(seminar.name + '/') and not parsed.fragment:
                anchor.set('href', f'#lesson-{local_paths[Path(parsed.path).name]:02d}')
            else:
                if not parsed.path:
                    path = seminar.name + '/' + source.lesson_filename(chapter['number'])
                anchor.set('href', public_url(path + ('#' + parsed.fragment if parsed.fragment else '')))
        rendered = etree.tostring(root, encoding='unicode')
        if '[[' in rendered or '<!-- 建言' in rendered or 'class="commentary' in rendered:
            raise ValueError(f'Unconverted source markup in lesson {chapter["number"]}')
    audit['knowledge_links'] = sum(len(r['cards']) for r in audit['entries'])
    audit['unique_knowledge_cards'] = len({h for r in audit['entries'] for h in r['cards']})
    return known


def cover(title, date):
    return f'''<section class="cover"><p class="series">拉康研讨班 · 第八期</p><h1>{escape(title)}</h1>
<p class="french">Le transfert</p><p class="year">1960—1961</p><p class="author">雅克·拉康 著<br/>拉康中文开放翻译计划 译</p>
<p class="edition">中文阅读版<br/>{date}</p></section>'''


def imprint(date):
    return f'''<section class="imprint"><h1>版本说明</h1>
<p>本册收录第八期研讨班《移情》（Le transfert，1960—1961）共27课的现有中文译文，依据拉康中文开放翻译计划本地源文件整理。版本日期：{date}。</p>
<p>保留译文正文、正文图示和段下注释；移除建言、独立阅读笔记及其入口。相关知识卡链接保留在对应段落下，联网后可打开在线卡片。电子书正文、图示与公式可离线阅读。</p>
<p>译文覆盖已完成，学术校订仍在进行。本册为版本快照；后续修订以项目在线版为准。</p>
<p>作者：Jacques Lacan（雅克·拉康）<br/>中文译文及编辑：拉康中文开放翻译计划贡献者<br/>
在线阅读：<a href="https://kotoba-rin.com/seminars/">KotobaRin 言林</a><br/>
项目来源：<a href="https://github.com/kotoba-rin/Lacan-Chinese-Translation-Project">Lacan Chinese Translation Project</a></p>
<p>项目贡献者创作的中文译文、译注等采用 <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>。法文原始材料与第三方图像不因收录而自动纳入此授权。范围以项目 <a href="https://github.com/kotoba-rin/Lacan-Chinese-Translation-Project/blob/main/NOTICE.md">NOTICE</a> 为准。本册仅作内容筛选、链接转换和排版，未改写译文。</p></section>'''


def toc(chapters):
    items = ''.join(f'<li><a href="#lesson-{c["number"]:02d}">{escape(c["title"])}</a></li>' for c in chapters)
    return '<nav class="toc" id="ebook-toc"><h1>目录</h1><ol>' + items + '</ol></nav>'


def pdf_stylesheet(css, staging, text):
    """Use explicit static TrueType faces instead of macOS CID-keyed PingFang.

    PingFang CFF subsets render in Poppler but map to incorrect glyphs in
    CoreGraphics. Keep this override PDF-only; EPUB uses the reader's fonts.
    """
    from fontTools import subset
    from fontTools.ttLib import TTFont
    from fontTools.varLib.instancer import instantiateVariableFont
    source_font = Path(os.environ.get('EBOOK_SANS_FONT', ROOT / '.cache/ebooks/fonts/NotoSansSC-wght.ttf'))
    if not source_font.is_file():
        raise FileNotFoundError('Missing Noto Sans SC TrueType font; see scripts/ebooks/README.md')
    wanted = text + css + '雅克·拉康 / 第八期：移情 版本说明 拉康研讨班 中文阅读版 0123456789'
    charset = ''.join(sorted(set(wanted)))
    key = hashlib.sha256((sha256(source_font) + charset).encode()).hexdigest()[:16]
    font_dir = staging / 'fonts'
    font_dir.mkdir(parents=True, exist_ok=True)
    rules = []
    for weight, style in [(400, 'Regular'), (500, 'Medium'), (700, 'Bold')]:
        path = font_dir / f'LacanEbookSans-{style}-{key}.ttf'
        if not path.exists():
            font = TTFont(source_font)
            if 'glyf' not in font:
                raise ValueError('EBOOK_SANS_FONT must contain TrueType outlines')
            options = subset.Options()
            options.name_IDs = ['*']
            subsetter = subset.Subsetter(options=options)
            subsetter.populate(text=charset)
            subsetter.subset(font)
            if 'fvar' in font:
                font = instantiateVariableFont(font, {'wght': weight}, inplace=True, static=True)
            family = 'Lacan Ebook Sans'
            names = {1: family, 2: style, 4: family + ' ' + style,
                     6: 'LacanEbookSans-' + style, 16: family, 17: style}
            for record in list(font['name'].names):
                if record.nameID in names:
                    font['name'].setName(names[record.nameID], record.nameID,
                                         record.platformID, record.platEncID, record.langID)
            font['OS/2'].usWeightClass = weight
            font.save(path)
        rules.append(f'@font-face {{ font-family: "Lacan Ebook Sans"; src: url("{path.as_uri()}") format("truetype"); font-weight: {weight}; font-style: normal; }}')
    # Markdown code spans otherwise fall back from Latin monospace to the
    # system's PingFang when they contain Chinese, bypassing the body family.
    code_rule = '\ncode, pre { font-family: "Andale Mono", "Lacan Ebook Sans", monospace; }'
    return '\n'.join(rules) + '\n' + css.replace('"PingFang SC"', '"Lacan Ebook Sans"') + code_rule


def validate_pdf_fonts(path):
    """Fail if the PDF falls back to the incompatible CFF or missing-glyph face."""
    from pypdf import PdfReader
    from io import BytesIO
    from fontTools.ttLib import TTFont
    reader = PdfReader(path)
    checked = set()
    for page in reader.pages:
        for reference in page['/Resources'].get('/Font', {}).values():
            if reference.idnum in checked:
                continue
            checked.add(reference.idnum)
            font = reference.get_object()
            descendant = font['/DescendantFonts'][0]
            descriptor = descendant['/FontDescriptor']
            if descendant['/Subtype'] != '/CIDFontType2' or '/FontFile2' not in descriptor:
                raise ValueError(f'PDF requires static TrueType embedding: {font["/BaseFont"]}')
            embedded = TTFont(BytesIO(descriptor['/FontFile2'].get_data()))
            if 'glyf' not in embedded or 'fvar' in embedded or 'LastResort' in font['/BaseFont']:
                raise ValueError(f'Unsupported or missing PDF glyphs: {font["/BaseFont"]}')
    return len(checked)


def make_cover_image(staging, title, date, css):
    from weasyprint import HTML
    document = '<html lang="zh-CN"><head><meta charset="utf-8"/><style>' + css + '</style></head><body>' + cover(title, date) + '</body></html>'
    path = staging / 'cover.pdf'
    HTML(string=document).write_pdf(path)
    subprocess.run(['pdftoppm', '-f', '1', '-l', '1', '-singlefile', '-scale-to', '1600',
                    '-png', str(path), str(staging / 'assets/cover')], check=True, capture_output=True)


def inner(root):
    return ''.join(etree.tostring(c, encoding='unicode', method='html') for c in root)


def xhtml_document(title, body):
    document = html.document_fromstring('<html><head><title>' + escape(title) + '</title><link rel="stylesheet" href="reader.css"/></head><body>' + body + '</body></html>')
    # HTML parsers lower-case SVG names; restore case-sensitive SVG attributes.
    def namespaces(node, in_svg=False):
        if not isinstance(node.tag, str):
            return
        tag = etree.QName(node).localname
        in_svg = in_svg or tag == 'svg'
        node.tag = '{' + (SVG if in_svg else XHTML) + '}' + tag
        if in_svg and 'viewbox' in node.attrib:
            node.set('viewBox', node.attrib.pop('viewbox'))
        node.attrib.pop('xmlns', None)
        for child in node:
            namespaces(child, in_svg)
    namespaces(document)
    document.set('lang', 'zh-CN')
    document.set('{http://www.w3.org/XML/1998/namespace}lang', 'zh-CN')
    etree.cleanup_namespaces(document, top_nsmap={None: XHTML, 'epub': EPUB})
    return document


def write_epub(output, title, chapters, staging, css, date, known):
    ns = {'opf': 'http://www.idpf.org/2007/opf', 'dc': 'http://purl.org/dc/elements/1.1/'}
    cover_body = '<section class="cover-image"><img src="assets/cover.png" alt="移情 · 拉康研讨班第八期，1960—1961，中文阅读版"/></section>'
    documents = [('cover.xhtml', title, cover_body), ('imprint.xhtml', '版本说明', imprint(date)), ('nav.xhtml', '目录', toc(chapters))]
    documents += [(f'lesson-{c["number"]:02d}.xhtml', c['title'], inner(c['root'])) for c in chapters]
    package = etree.Element('{%s}package' % ns['opf'], nsmap={None:ns['opf'], 'dc':ns['dc']}, version='3.0', attrib={'unique-identifier':'book-id'})
    metadata = etree.SubElement(package, '{%s}metadata' % ns['opf'])
    identifier = 'urn:uuid:' + str(uuid.uuid5(uuid.NAMESPACE_URL, WEB + 's8-le-transfert/' + date))
    for key,value in [('identifier',identifier),('title','第八期：' + title),('creator','Jacques Lacan'),('contributor','拉康中文开放翻译计划'),('language','zh-CN'),('date',date),('publisher','拉康中文开放翻译计划'),('source',WEB+'s8-le-transfert/')]:
        e=etree.SubElement(metadata, '{%s}%s' % (ns['dc'],key));e.text=value
        if key=='identifier':e.set('id','book-id')
    modified=etree.SubElement(metadata,'{%s}meta'%ns['opf'],property='dcterms:modified');modified.text=date+'T00:00:00Z'
    etree.SubElement(metadata,'{%s}meta'%ns['opf'],name='cover',content='asset-cover')
    for prop, value in [('schema:accessMode','textual'),('schema:accessibilityFeature','tableOfContents'),('schema:accessibilityFeature','structuralNavigation')]:
        etree.SubElement(metadata,'{%s}meta'%ns['opf'],property=prop).text=value
    manifest=etree.SubElement(package,'{%s}manifest'%ns['opf'])
    spine=etree.SubElement(package,'{%s}spine'%ns['opf'],toc='ncx')
    ncx=etree.Element('{http://www.daisy.org/z3986/2005/ncx/}ncx',nsmap={None:'http://www.daisy.org/z3986/2005/ncx/'},version='2005-1')
    head=etree.SubElement(ncx,'head');etree.SubElement(head,'meta',name='dtb:uid',content=identifier)
    etree.SubElement(etree.SubElement(ncx,'docTitle'),'text').text='第八期：'+title
    navmap=etree.SubElement(ncx,'navMap')
    with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('mimetype','application/epub+zip',compress_type=zipfile.ZIP_STORED)
        archive.writestr('META-INF/container.xml','<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
        for index,(name,label,body) in enumerate(documents):
            document=xhtml_document(label,body)
            for anchor in document.iter('{%s}a'%XHTML):
                href=anchor.get('href','')
                if href.startswith('#'):
                    target=known[href[1:]]
                    filename = 'nav.xhtml' if target == 0 else f'lesson-{target:02d}.xhtml'
                    anchor.set('href',filename+href)
            properties=[]
            if name=='nav.xhtml':
                properties.append('nav')
                next(document.iter('{%s}nav'%XHTML)).set('{%s}type'%EPUB,'toc')
            if any(True for _ in document.iter('{%s}svg'%SVG)):properties.append('svg')
            args={'id':f'doc-{index}','href':name,'media-type':'application/xhtml+xml'}
            if properties:args['properties']=' '.join(properties)
            etree.SubElement(manifest,'{%s}item'%ns['opf'],**args)
            etree.SubElement(spine,'{%s}itemref'%ns['opf'],idref=f'doc-{index}')
            archive.writestr('EPUB/'+name,etree.tostring(document,encoding='utf-8',xml_declaration=True))
            if name.startswith('lesson-'):
                point=etree.SubElement(navmap,'navPoint',id=f'nav-{index}',playOrder=str(index-2))
                etree.SubElement(etree.SubElement(point,'navLabel'),'text').text=label
                etree.SubElement(point,'content',src=name)
        for name,media in [('reader.css','text/css'),('toc.ncx','application/x-dtbncx+xml')]:
            etree.SubElement(manifest,'{%s}item'%ns['opf'],id='ncx' if name=='toc.ncx' else 'css',href=name,attrib={'media-type':media})
        for asset in sorted((staging/'assets').iterdir()):
            name='assets/'+asset.name
            item=etree.SubElement(manifest,'{%s}item'%ns['opf'],id='asset-'+asset.stem,href=name,attrib={'media-type':mimetypes.guess_type(name)[0]})
            if asset.name=='cover.png':item.set('properties','cover-image')
            archive.write(asset,'EPUB/'+name)
        # EPUB CSS parsers do not accept paged-media margin boxes. Typography is
        # shared; running headers, page numbers and PDF TOC leaders are PDF-only.
        archive.writestr('EPUB/reader.css',css.partition('@media print')[0])
        archive.writestr('EPUB/toc.ncx',etree.tostring(ncx,encoding='utf-8',xml_declaration=True))
        archive.writestr('EPUB/package.opf',etree.tostring(package,encoding='utf-8',xml_declaration=True))


def validate_epub(path, audit):
    with zipfile.ZipFile(path) as archive:
        assert archive.namelist()[0]=='mimetype'
        assert archive.getinfo('mimetype').compress_type==zipfile.ZIP_STORED
        files=set(archive.namelist())
        docs={name:etree.fromstring(archive.read(name)) for name in files if name.endswith(('.xhtml','.opf','.ncx','.xml'))}
        ids={name:{e.get('id') for e in doc.iter() if e.get('id')} for name,doc in docs.items()}
        seen=[]; notes=0; cards=0
        for name,doc in docs.items():
            if not name.endswith('.xhtml'):continue
            if '/lesson-' in name:
                seen += [e.get('id') for e in doc.iter() if re.fullmatch(r's\d+[a-z]?-\d+-\d+',e.get('id',''))]
                notes += sum(e.get('class')=='annotation' for e in doc.iter())
                cards += sum(1 for e in doc.iter('{%s}div'%XHTML) if e.get('class')=='knowledge-links' for _ in e.iter('{%s}a'%XHTML))
            for e in doc.iter():
                for attr in ('src','href'):
                    value=e.get(attr)
                    if not value:continue
                    parsed=urlsplit(value)
                    if parsed.scheme:
                        assert attr!='src', f'Remote dependency: {value}'
                        assert '/notes/' not in unquote(parsed.path),value
                        continue
                    target=posixpath.normpath(posixpath.join(posixpath.dirname(name),unquote(parsed.path))) if parsed.path else name
                    assert target in files,(name,value)
                    if parsed.fragment:assert unquote(parsed.fragment) in ids[target],(name,value)
        assert len(seen)==len(set(seen))==len(audit['segment_ids'])
        assert set(seen)==set(audit['segment_ids'])
        assert notes==audit['annotation_blocks']
        assert cards==audit['knowledge_links']


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir',type=Path,default=ROOT/'output/ebooks/s8-le-transfert')
    parser.add_argument('--epub-only',action='store_true')
    args=parser.parse_args()
    seminar=ROOT/'texts/s8-le-transfert'
    title='移情'
    date=datetime.now().astimezone().date().isoformat()
    output=args.output_dir.resolve();output.mkdir(parents=True,exist_ok=True)
    staging=ROOT/'.cache/ebooks/s8-staging';staging.mkdir(parents=True,exist_ok=True)
    sources=sorted(seminar.glob('translation/*.md'))+sorted(seminar.glob('original/*.md'))+source.knowledge_markdown_files(source.KNOWLEDGE_DIR)
    hashes={str(p.relative_to(ROOT)):sha256(p) for p in sources}
    audit={'edition_date':date,'annotation_blocks':0,'excluded_commentary_blocks':0,'entries':[],'segment_ids':[],
           'preserved_source_quotations':sorted(SOURCE_QUOTATIONS),'source_hashes':hashes}
    chapters,formulas=collect_chapters(seminar,source.parse_knowledge_cards(),audit)
    prepare_assets(chapters,staging,audit)
    prepare_math(chapters,formulas)
    known=rewrite_links(chapters,seminar,audit)
    css=(ROOT/'scripts/ebooks/reader.css').read_text()
    content=cover(title,date)+imprint(date)+toc(chapters)+''.join(inner(c['root']) for c in chapters)
    pdf_css=pdf_stylesheet(css,staging,content)
    make_cover_image(staging,title,date,pdf_css)
    epub=output/'拉康研讨班第八期-移情.epub'
    write_epub(epub,title,chapters,staging,css,date,known)
    validate_epub(epub,audit)
    print(f'EPUB verified: {epub}',flush=True)
    document='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>拉康研讨班第八期：移情</title><meta name="author" content="雅克·拉康；拉康中文开放翻译计划"/><style>'+pdf_css+'</style></head><body>'+content+'</body></html>'
    (staging/'book.html').write_text(document)
    if not args.epub_only:
        from weasyprint import HTML
        pdf=output/'拉康研讨班第八期-移情.pdf'
        rendered=HTML(string=document,base_url=str(staging)).render()
        audit['pdf_pages']=len(rendered.pages)
        rendered.write_pdf(pdf)
        audit['pdf_static_truetype_fonts']=validate_pdf_fonts(pdf)
        print(f'PDF created: {pdf} ({audit["pdf_pages"]} pages)',flush=True)
    assert hashes=={str(p.relative_to(ROOT)):sha256(p) for p in sources},'Source files changed during export'
    audit['lessons']=len(chapters)
    generated = [epub] if args.epub_only else [epub, pdf]
    audit['output_sha256']={p.name:sha256(p) for p in generated}
    (output/'制作清单.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in audit.items() if k not in ('entries','source_hashes','segment_ids','images')},ensure_ascii=False,indent=2))


if __name__=='__main__':
    main()
