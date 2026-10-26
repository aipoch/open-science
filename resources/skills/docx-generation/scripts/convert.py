#!/usr/bin/env python3
"""Reproducible Markdown -> DOCX generation; standard library plus an existing Pandoc."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from xml.dom import minidom
import zipfile

VERSION = '1'
PANDOC_VERSION = '3.12.1'
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}
ET.register_namespace('w', W)


def normalize_table_paragraphs(data):
    """Separate ordinary table text from Compact, leaving lists and custom styles intact."""
    document = minidom.parseString(data)
    def children(node, name):
        return [el for el in node.childNodes if el.nodeType == el.ELEMENT_NODE
                and el.namespaceURI == W and el.localName == name]
    for cell in document.getElementsByTagNameNS(W, 'tc'):
        for paragraph in children(cell, 'p'):
            for props in children(paragraph, 'pPr'):
                if children(props, 'numPr'):
                    continue
                for style in children(props, 'pStyle'):
                    if style.getAttributeNS(W, 'val') == 'Compact':
                        # Keep prefixes used only in mc:Ignorable or mc:Choice Requires.
                        attribute = style.getAttributeNodeNS(W, 'val')
                        style.setAttributeNS(W, attribute.name, 'TableBody')
    return document.toxml(encoding='utf-8')



def record_provenance(parts, receipt):
    """Keep provenance inside the delivered package without changing user core metadata."""
    cp = 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties'
    vt = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes'
    rel = 'http://schemas.openxmlformats.org/package/2006/relationships'
    ct = 'http://schemas.openxmlformats.org/package/2006/content-types'
    root = ET.fromstring(parts['docProps/custom.xml']) if 'docProps/custom.xml' in parts else ET.Element('{%s}Properties' % cp)
    for child in list(root):
        if child.get('name') == 'OpenScienceConversion':
            root.remove(child)
    pid = max([int(el.get('pid', '1')) for el in root] + [1]) + 1
    prop = ET.SubElement(root, '{%s}property' % cp, {'fmtid': '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}', 'pid': str(pid), 'name': 'OpenScienceConversion'})
    ET.SubElement(prop, '{%s}lpwstr' % vt).text = json.dumps(receipt, sort_keys=True)
    parts['docProps/custom.xml'] = ET.tostring(root, encoding='utf-8', xml_declaration=True)
    relations = ET.fromstring(parts['_rels/.rels'])
    custom_type = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties'
    if not any(el.get('Type') == custom_type for el in relations):
        ids = {el.get('Id') for el in relations}
        index = 1
        while 'rIdOpenScience%d' % index in ids:
            index += 1
        ET.SubElement(relations, '{%s}Relationship' % rel, {'Id': 'rIdOpenScience%d' % index, 'Type': custom_type, 'Target': 'docProps/custom.xml'})
    parts['_rels/.rels'] = ET.tostring(relations, encoding='utf-8', xml_declaration=True)
    types = ET.fromstring(parts['[Content_Types].xml'])
    if not any(el.get('PartName') == '/docProps/custom.xml' for el in types):
        ET.SubElement(types, '{%s}Override' % ct, {'PartName': '/docProps/custom.xml', 'ContentType': 'application/vnd.openxmlformats-officedocument.custom-properties+xml'})
    parts['[Content_Types].xml'] = ET.tostring(types, encoding='utf-8', xml_declaration=True)


def convert(source, output, reference=None, pandoc='pandoc', input_format='markdown'):
    source, output = Path(source).resolve(), Path(output).absolute()
    if output.exists() or output.is_symlink():
        raise ValueError('Output already exists; choose a new artifact filename.')
    if source.suffix.lower() not in ('.md', '.markdown'):
        raise ValueError('This workflow accepts Markdown input. Edit existing DOCX files in place with a suitable document library.')
    if output.suffix.lower() != '.docx':
        raise ValueError('Output must use the .docx extension.')
    if not source.is_file():
        raise ValueError('Markdown input does not exist.')
    version = subprocess.run([pandoc, '--version'], capture_output=True, text=True, check=True).stdout.splitlines()[0]
    if version != 'pandoc ' + PANDOC_VERSION:
        raise ValueError('This profile is validated with Pandoc %s; found %s. Use that version or another suitable workflow.' % (PANDOC_VERSION, version))
    bundled = reference is None
    reference = Path(reference).resolve() if reference else Path(__file__).resolve().parents[1] / 'assets/reference.docx'
    template = reference.read_bytes()
    receipt = {'converter_version': VERSION, 'pandoc_version': PANDOC_VERSION,
               'profile': 'open-science-report-v1' if bundled else 'user-template',
               'reference_sha256': hashlib.sha256(template).hexdigest(),
               'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'input_format': input_format}
    # All intermediates live beside the destination, under the caller's approved execution directory.
    with tempfile.TemporaryDirectory(prefix='.docx-convert-', dir=output.parent) as temp:
        temp = Path(temp)
        ref = temp / 'reference.docx'
        ref.write_bytes(template)
        raw = temp / 'generated.docx'
        subprocess.run([pandoc, str(source), '--from=' + input_format, '--to=docx',
                        '--fail-if-warnings', '--reference-doc=' + str(ref), '--resource-path=' + str(source.parent),
                        '--output=' + str(raw)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        with zipfile.ZipFile(raw) as package:
            parts = {name: package.read(name) for name in package.namelist()}
        if bundled:
            parts['word/document.xml'] = normalize_table_paragraphs(parts['word/document.xml'])
        record_provenance(parts, receipt)
        # Reject malformed packages before publication; this is not a visual-layout assertion.
        for name, data in parts.items():
            if name.endswith(('.xml', '.rels')):
                ET.fromstring(data)
        final = temp / 'final.docx'
        with zipfile.ZipFile(final, 'w', zipfile.ZIP_DEFLATED) as package:
            for name, data in parts.items():
                package.writestr(name, data)
        # Atomic no-clobber publication on the same filesystem, including a concurrent destination creation.
        os.link(final, output)
    return {**receipt, 'path': str(output), 'mime_type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('output')
    parser.add_argument('--reference-doc')
    parser.add_argument('--pandoc', default='pandoc')
    parser.add_argument('--from', dest='input_format', default='markdown', help='Pandoc Markdown dialect, e.g. gfm or markdown+pipe_tables')
    args = parser.parse_args()
    try:
        receipt = convert(args.source, args.output, args.reference_doc, args.pandoc, args.input_format)
        print(json.dumps(receipt, ensure_ascii=False))
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode('utf-8', errors='replace') if isinstance(error.stderr, bytes) else error.stderr
        print(json.dumps({'ok': False, 'error': detail or str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    except (OSError, ValueError, subprocess.SubprocessError, zipfile.BadZipFile, ET.ParseError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
