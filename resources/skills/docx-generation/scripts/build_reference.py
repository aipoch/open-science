#!/usr/bin/env python3
"""Maintainer-only: rebuild the versioned reference using the supported Pandoc."""
from pathlib import Path
import subprocess
import io
import xml.etree.ElementTree as ET
import zipfile
from convert import PANDOC_VERSION, W, NS


def child(parent, name):
    node = parent.find('w:' + name, NS)
    if node is None:
        node = ET.SubElement(parent, '{%s}%s' % (W, name))
    return node


def properties(parent, name, **values):
    node = child(parent, name)
    node.attrib.clear()
    node.attrib.update({'{%s}%s' % (W, key): str(value) for key, value in values.items()})
    return node


def typography(run, size, color=None, bold=False):
    # Explicit faces avoid linked heading styles restoring Pandoc's theme typography.
    properties(run, 'rFonts', ascii='Arial', hAnsi='Arial', eastAsia='PingFang SC', cs='Arial')
    if bold:
        for index, name in enumerate(('b', 'bCs'), start=1):
            node = properties(run, name, val=1)
            run.remove(node)
            run.insert(index, node)
    if color:
        node = properties(run, 'color', val=color)
        run.remove(node)
        # CT_RPr places color before size (including when updating docDefaults).
        size_node = run.find('w:sz', NS)
        run.insert(list(run).index(size_node) if size_node is not None else len(run), node)
    properties(run, 'sz', val=size)
    properties(run, 'szCs', val=size)


def report_typography(root):
    styles = {node.get('{%s}styleId' % W): node for node in root.findall('w:style', NS)}
    typography(root.find('w:docDefaults/w:rPrDefault/w:rPr', NS), 21, '24292F')
    for name in ('Normal', 'BodyText', 'FirstParagraph'):
        properties(child(styles[name], 'pPr'), 'spacing', before=40, after=120, line=320, lineRule='auto')
    properties(child(styles['Compact'], 'pPr'), 'spacing', before=20, after=60, line=300, lineRule='auto')
    headings = [('Title', 34, 0, 240, '12324F'),
                ('Heading1', 34, 0, 240, '12324F'),
                ('Heading2', 28, 360, 160, '1F4E79'),
                ('Heading3', 23, 240, 120, '2E6DA4')]
    headings += [('Heading%d' % level, 21, 200, 100, '24292F') for level in range(4, 10)]
    for name, size, before, after, color in headings:
        paragraph = child(styles[name], 'pPr')
        properties(paragraph, 'spacing', before=before, after=after, line=280, lineRule='auto')
        for suffix in ('', 'Char'):
            typography(child(styles[name + suffix], 'rPr'), size, color, bold=True)


def build_reference(output):
    version = subprocess.check_output(['pandoc', '--version'], text=True).splitlines()[0]
    if version != 'pandoc ' + PANDOC_VERSION:
        raise ValueError('Use Pandoc ' + PANDOC_VERSION)
    raw = subprocess.check_output(['pandoc', '--print-default-data-file', 'reference.docx'])
    with zipfile.ZipFile(io.BytesIO(raw)) as package:
        parts = {name: package.read(name) for name in package.namelist()}
    root = ET.fromstring(parts['word/styles.xml'])
    report_typography(root)
    table = root.find("w:style[@w:styleId='Table']", NS)
    # Whole-table text and header emphasis remain semantic styles, not per-cell flattening.
    table_props = table.find('w:tblPr', NS)
    props = ET.Element('{%s}rPr' % W)
    table.insert(list(table).index(table_props), props)
    typography(props, 19)
    borders = ET.Element('{%s}tblBorders' % W)
    table_props.insert(list(table_props).index(table_props.find('w:tblCellMar', NS)), borders)
    for edge in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
        ET.SubElement(borders, '{%s}%s' % (W, edge), {
            '{%s}val' % W: 'single', '{%s}sz' % W: '4',
            '{%s}color' % W: '808080', '{%s}space' % W: '0',
        })
    first = table.find("w:tblStylePr[@w:type='firstRow']", NS)
    run = ET.Element('{%s}rPr' % W)
    first.insert(0, run)
    ET.SubElement(run, '{%s}b' % W)
    cell = first.find('w:tcPr', NS)
    # Use the complete grid for the header too; Pandoc's default header rule omits its width.
    cell.remove(cell.find('w:tcBorders', NS))
    margins = table_props.find('w:tblCellMar', NS)
    for edge, width in (('top', 60), ('left', 80), ('bottom', 60), ('right', 80)):
        properties(margins, edge, w=width, type='dxa')
    body = ET.SubElement(root, '{%s}style' % W, {'{%s}type' % W: 'paragraph', '{%s}styleId' % W: 'TableBody', '{%s}customStyle' % W: '1'})
    ET.SubElement(body, '{%s}name' % W, {'{%s}val' % W: 'Table Body'})
    ET.SubElement(body, '{%s}basedOn' % W, {'{%s}val' % W: 'Normal'})
    paragraph = ET.SubElement(body, '{%s}pPr' % W)
    ET.SubElement(paragraph, '{%s}spacing' % W, {'{%s}before' % W: '20', '{%s}after' % W: '20', '{%s}line' % W: '240', '{%s}lineRule' % W: 'auto'})
    run = ET.SubElement(body, '{%s}rPr' % W)
    typography(run, 19)
    parts['word/styles.xml'] = ET.tostring(root, encoding='utf-8', xml_declaration=True)
    document = ET.fromstring(parts['word/document.xml'])
    section = document.find('.//w:sectPr', NS)
    size = section.find('w:pgSz', NS)
    if size is None:
        size = ET.SubElement(section, '{%s}pgSz' % W)
    size.set('{%s}w' % W, '11906')
    size.set('{%s}h' % W, '16838')
    margins = properties(section, 'pgMar', top=1134, right=1134, bottom=1134, left=1134,
                         header=851, footer=992, gutter=0)
    section.remove(margins)
    section.insert(list(section).index(size) + 1, margins)
    parts['word/document.xml'] = ET.tostring(document, encoding='utf-8', xml_declaration=True)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as package:
        for name, data in parts.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            package.writestr(info, data)


if __name__ == '__main__':
    build_reference(Path(__file__).resolve().parents[1] / 'assets/reference.docx')
