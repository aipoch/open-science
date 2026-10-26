#!/usr/bin/env python3
"""Maintainer-only: rebuild the versioned reference using the supported Pandoc."""
from pathlib import Path
import subprocess
import io
import xml.etree.ElementTree as ET
import zipfile
from convert import PANDOC_VERSION, W, NS


def build_reference(output):
    version = subprocess.check_output(['pandoc', '--version'], text=True).splitlines()[0]
    if version != 'pandoc ' + PANDOC_VERSION:
        raise ValueError('Use Pandoc ' + PANDOC_VERSION)
    raw = subprocess.check_output(['pandoc', '--print-default-data-file', 'reference.docx'])
    with zipfile.ZipFile(io.BytesIO(raw)) as package:
        parts = {name: package.read(name) for name in package.namelist()}
    root = ET.fromstring(parts['word/styles.xml'])
    table = root.find("w:style[@w:styleId='Table']", NS)
    # Whole-table text and header emphasis remain semantic styles, not per-cell flattening.
    props = ET.SubElement(table, '{%s}rPr' % W)
    ET.SubElement(props, '{%s}sz' % W, {'{%s}val' % W: '21'})
    first = table.find("w:tblStylePr[@w:type='firstRow']", NS)
    run = ET.SubElement(first, '{%s}rPr' % W)
    ET.SubElement(run, '{%s}b' % W)
    cell = first.find('w:tcPr', NS)
    ET.SubElement(cell, '{%s}shd' % W, {'{%s}fill' % W: 'F2F4F7', '{%s}val' % W: 'clear'})
    body = ET.SubElement(root, '{%s}style' % W, {'{%s}type' % W: 'paragraph', '{%s}styleId' % W: 'TableBody', '{%s}customStyle' % W: '1'})
    ET.SubElement(body, '{%s}name' % W, {'{%s}val' % W: 'Table Body'})
    ET.SubElement(body, '{%s}basedOn' % W, {'{%s}val' % W: 'Normal'})
    paragraph = ET.SubElement(body, '{%s}pPr' % W)
    ET.SubElement(paragraph, '{%s}spacing' % W, {'{%s}before' % W: '0', '{%s}after' % W: '40', '{%s}line' % W: '240', '{%s}lineRule' % W: 'auto'})
    run = ET.SubElement(body, '{%s}rPr' % W)
    ET.SubElement(run, '{%s}sz' % W, {'{%s}val' % W: '21'})
    parts['word/styles.xml'] = ET.tostring(root, encoding='utf-8', xml_declaration=True)
    document = ET.fromstring(parts['word/document.xml'])
    section = document.find('.//w:sectPr', NS)
    size = section.find('w:pgSz', NS)
    if size is None:
        size = ET.SubElement(section, '{%s}pgSz' % W)
    size.set('{%s}w' % W, '11906')
    size.set('{%s}h' % W, '16838')
    parts['word/document.xml'] = ET.tostring(document, encoding='utf-8', xml_declaration=True)
    # Keep Pandoc's theme and margins. CJK face selection belongs to the user's reference,
    # since a font name in a package cannot ensure that font is installed on the viewing host.
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as package:
        for name, data in parts.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            package.writestr(info, data)


if __name__ == '__main__':
    build_reference(Path(__file__).resolve().parents[1] / 'assets/reference.docx')
