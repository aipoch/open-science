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
    def assert_grid_style(self, styles):
        table = styles.find("w:style[@w:styleId='Table']", NS)
        borders = table.find('w:tblPr/w:tblBorders', NS)
        self.assertIsNotNone(borders, 'The default report needs actual table borders, not header shading')
        self.assertEqual({node.tag.split('}')[-1] for node in borders},
                         {'top', 'bottom', 'left', 'right', 'insideH', 'insideV'})
        for border in borders:
            self.assertEqual(border.get('{%s}val' % NS['w']), 'single')
            self.assertEqual(border.get('{%s}sz' % NS['w']), '4')
            self.assertEqual(border.get('{%s}color' % NS['w']), '808080')
        self.assertIsNone(table.find('.//w:shd', NS))
        header = table.find("w:tblStylePr[@w:type='firstRow']", NS)
        self.assertIsNotNone(header.find('w:rPr/w:b', NS))

    def test_default_profile_has_complete_grid_without_shading(self):
        with zipfile.ZipFile(SCRIPT.parents[1] / 'assets/reference.docx') as package:
            self.assert_grid_style(ET.fromstring(package.read('word/styles.xml')))

    def test_report_page_and_linked_heading_styles_are_consistent(self):
        with zipfile.ZipFile(SCRIPT.parents[1] / 'assets/reference.docx') as package:
            doc = ET.fromstring(package.read('word/document.xml'))
            styles = ET.fromstring(package.read('word/styles.xml'))
        margins = doc.find('.//w:pgMar', NS)
        self.assertIsNotNone(margins, 'Reports need explicit margins for stable page geometry')
        for edge in ('top', 'right', 'bottom', 'left'):
            self.assertEqual(margins.get('{%s}%s' % (NS['w'], edge)), '1134')
        for name, size in [('Heading1', '34'), ('Heading2', '28'), ('Heading3', '23')]:
            for suffix in ('', 'Char'):
                style = styles.find("w:style[@w:styleId='%s']" % (name + suffix), NS)
                self.assertEqual(style.find('w:rPr/w:sz', NS).get('{%s}val' % NS['w']), size)
        table = styles.find("w:style[@w:styleId='Table']", NS)
        self.assertEqual(table.find('w:tblPr/w:tblCellMar/w:top', NS).get('{%s}w' % NS['w']), '60')

    def test_default_table_layout_preserves_explicit_widths_and_nested_tables(self):
        spec = importlib.util.spec_from_file_location('docx_convert', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        xml = b'''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        <w:tbl><w:tblPr><w:tblW w:type="auto" w:w="0"/></w:tblPr><w:tr><w:tc>
        <w:tbl><w:tblPr><w:tblW w:type="auto" w:w="0"/></w:tblPr></w:tbl>
        </w:tc></w:tr></w:tbl>
        <w:tbl><w:tblPr><w:tblW w:type="dxa" w:w="4321"/></w:tblPr></w:tbl>
        <w:tbl><w:tblPr><w:tblW w:type="pct" w:w="3000"/></w:tblPr></w:tbl>
        </w:body></w:document>'''
        normalized = module.normalize_table_paragraphs(xml)
        self.assertEqual(module.normalize_table_paragraphs(normalized), normalized)
        root = ET.fromstring(normalized)
        self.assertEqual([(el.get('{%s}type' % NS['w']), el.get('{%s}w' % NS['w']))
                          for el in root.findall('.//w:tblW', NS)],
                         [('pct', '5000'), ('auto', '0'), ('dxa', '4321'), ('pct', '3000')])

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
            self.assertEqual(receipt['profile'], 'open-science-report-v3')
            with zipfile.ZipFile(root / 'report.docx') as package:
                styles = ET.fromstring(package.read('word/styles.xml'))
                self.assert_grid_style(styles)

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
            self.assertEqual(receipt['profile'], 'open-science-report-v3')
            with zipfile.ZipFile(output) as package:
                self.assert_grid_style(ET.fromstring(package.read('word/styles.xml')))
                doc = ET.fromstring(package.read('word/document.xml'))
                self.assertEqual(len(doc.findall('.//w:tbl', NS)), 1)
                self.assertEqual(len(doc.findall('.//w:tr', NS)), 2)
                self.assertEqual(len(doc.findall('.//w:numPr', NS)), 2)
                self.assertEqual(len(doc.findall('.//w:pStyle[@w:val="Heading1"]', NS)), 1)
                self.assertEqual(len(doc.findall('.//w:tbl//w:pStyle[@w:val="TableBody"]', NS)), 4)
                self.assertIn('open-science-report-v3', package.read('docProps/custom.xml').decode())
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
                        tree.find('.//w:pgMar', NS).set('{%s}left' % NS['w'], '2000')
                        data = ET.tostring(tree)
                    if entry.filename == 'word/styles.xml':
                        tree = ET.fromstring(data)
                        table_props = tree.find("w:style[@w:styleId='Table']/w:tblPr", NS)
                        table_props.remove(table_props.find('w:tblBorders', NS))
                        data = ET.tostring(tree)
                    dst.writestr(entry, data)
            custom = root / 'custom-output.docx'
            result = subprocess.run([sys.executable, str(SCRIPT), str(source), str(custom), '--reference-doc', str(template)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['profile'], 'user-template')
            with zipfile.ZipFile(custom) as package:
                styles = ET.fromstring(package.read('word/styles.xml'))
                self.assertIsNone(styles.find("w:style[@w:styleId='Table']/w:tblPr/w:tblBorders", NS))
                doc = ET.fromstring(package.read('word/document.xml'))
                self.assertEqual(doc.find('.//w:pgSz', NS).get('{%s}w' % NS['w']), '18000')
                self.assertEqual(doc.find('.//w:pgMar', NS).get('{%s}left' % NS['w']), '2000')
                self.assertEqual(doc.find('.//w:tblW', NS).get('{%s}type' % NS['w']), 'auto')
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
