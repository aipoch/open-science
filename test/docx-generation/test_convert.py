"""Exercise the maintained converter with real packages and optional local Pandoc."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'resources/skills/docx-generation/scripts/convert.py'
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
ET.register_namespace('w', NS['w'])


class ConversionTests(unittest.TestCase):
    def test_registered_bundle_matches_the_maintained_assets(self):
        spec = importlib.util.spec_from_file_location('build_kernel', SCRIPT.parent / 'build_kernel.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual((SCRIPT.parents[1] / 'kernel.py').read_text(), module.kernel_source())

    @unittest.skipUnless(sys.platform == 'darwin' and shutil.which('sandbox-exec') and shutil.which('pandoc'),
                         'macOS sandbox-exec and Pandoc are required')
    def test_conversion_when_skill_directory_is_denied_by_the_os_sandbox(self):
        # The host injects registered helper source; the execution sandbox never reads the skill root.
        skill = SCRIPT.parents[1].resolve()
        helper = (skill / 'kernel.py').read_text()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = root / 'source.md'
            source.write_text('| 类别 | 描述 |\n|---|---|\n| 测试 | 保留样式 |\n', encoding='utf-8')
            code = helper + '\n' + '\n'.join([
                'import json, pathlib, subprocess, sys',
                'try:',
                '    pathlib.Path(%r).read_bytes()' % str(skill / 'assets/reference.docx'),
                'except PermissionError:',
                '    pass',
                'else:',
                '    raise AssertionError("The original skill directory must be inaccessible")',
                'prepared = prepare_docx_conversion(%r)' % str(root),
                'result = subprocess.check_output([sys.executable, prepared["script_path"], %r, %r], text=True)' % (str(source), str(root / 'report.docx')),
                'print(result)',
            ])
            policy = '(version 1)(allow default)(deny file-read* (subpath %s))' % json.dumps(str(skill))
            result = subprocess.run(['/usr/bin/sandbox-exec', '-p', policy, sys.executable, '-'], input=code, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            receipt = json.loads(result.stdout)
            self.assertEqual(receipt['profile'], 'open-science-report-v1')
            with zipfile.ZipFile(root / 'report.docx') as package:
                styles = ET.fromstring(package.read('word/styles.xml'))
                header = styles.find("w:style[@w:styleId='Table']/w:tblStylePr[@w:type='firstRow']", NS)
                self.assertIsNotNone(header.find('w:rPr/w:b', NS))
                self.assertEqual(header.find('w:tcPr/w:shd', NS).get('{%s}fill' % NS['w']), 'F2F4F7')

    def test_table_body_normalization_is_scoped_and_idempotent(self):
        spec = importlib.util.spec_from_file_location('docx_convert', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        xml = b'''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14"><w:body>
        <w:p><w:pPr><w:pStyle w:val="Compact"/><w:numPr/></w:pPr></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:pPr><w:pStyle w:val="Compact"/></w:pPr></w:p>
        <w:p><w:pPr><w:pStyle w:val="Compact"/><w:numPr/></w:pPr></w:p>
        <w:p><w:pPr><w:pStyle w:val="Custom"/></w:pPr></w:p></w:tc></w:tr></w:tbl>
        </w:body></w:document>'''
        normalized = module.normalize_table_paragraphs(xml)
        self.assertEqual(module.normalize_table_paragraphs(normalized), normalized)
        self.assertIn(b'xmlns:w14=', normalized)
        root = ET.fromstring(normalized)
        self.assertEqual([el.get('{%s}val' % NS['w']) for el in root.findall('.//w:pStyle', NS)],
                         ['Compact', 'TableBody', 'Compact', 'Custom'])

    @unittest.skipUnless(shutil.which('pandoc'), 'Pandoc is required for converter integration')
    def test_real_conversion_preserves_structure_and_custom_page_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.md'
            source.write_text('# 标题\n\n1. 第一项\n2. 第二项\n\n| 类别 | 描述 |\n|---|---|\n| 神经 | 长中文说明，保持结构与内容。 |\n', encoding='utf-8')
            output = root / 'report.docx'
            result = subprocess.run([sys.executable, str(SCRIPT), str(source), str(output)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            receipt = json.loads(result.stdout)
            self.assertEqual(receipt['profile'], 'open-science-report-v1')
            with zipfile.ZipFile(output) as package:
                doc = ET.fromstring(package.read('word/document.xml'))
                self.assertEqual(len(doc.findall('.//w:tbl', NS)), 1)
                self.assertEqual(len(doc.findall('.//w:tr', NS)), 2)
                self.assertEqual(len(doc.findall('.//w:numPr', NS)), 2)
                self.assertEqual(len(doc.findall('.//w:pStyle[@w:val="Heading1"]', NS)), 1)
                self.assertEqual(len(doc.findall('.//w:tbl//w:pStyle[@w:val="TableBody"]', NS)), 4)
                self.assertIn('open-science-report-v1', package.read('docProps/custom.xml').decode())
            before = output.read_bytes()
            again = subprocess.run([sys.executable, str(SCRIPT), str(source), str(output)], capture_output=True, text=True)
            self.assertNotEqual(again.returncode, 0)
            self.assertEqual(output.read_bytes(), before)
            # A user template has its own dimensions and styles; the default profile must not rewrite it.
            template = root / 'custom.docx'
            with zipfile.ZipFile(output) as src, zipfile.ZipFile(template, 'w') as dst:
                for entry in src.infolist():
                    data = src.read(entry.filename)
                    if entry.filename == 'word/document.xml':
                        tree = ET.fromstring(data)
                        tree.find('.//w:pgSz', NS).set('{%s}w' % NS['w'], '18000')
                        data = ET.tostring(tree)
                    dst.writestr(entry, data)
            custom = root / 'custom-output.docx'
            result = subprocess.run([sys.executable, str(SCRIPT), str(source), str(custom), '--reference-doc', str(template)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['profile'], 'user-template')
            with zipfile.ZipFile(custom) as package:
                doc = ET.fromstring(package.read('word/document.xml'))
                self.assertEqual(doc.find('.//w:pgSz', NS).get('{%s}w' % NS['w']), '18000')
                self.assertEqual(len(doc.findall('.//w:tbl//w:pStyle[@w:val="TableBody"]', NS)), 0)

    @unittest.skipUnless(shutil.which('pandoc'), 'Pandoc is required for converter integration')
    def test_missing_image_is_not_published_as_a_successful_document(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'missing.md'
            source.write_text('![Required diagram](does-not-exist.png)', encoding='utf-8')
            output = root / 'report.docx'
            result = subprocess.run([sys.executable, str(SCRIPT), str(source), str(output)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())
            self.assertIn('does-not-exist.png', result.stderr)


if __name__ == '__main__':
    unittest.main()
