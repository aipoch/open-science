import importlib.util
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "resources" / "skills" / "pptx-generation"
sys.path.insert(0, str(ROOT))
MISSING = [m for m in ("pptx", "PIL") if importlib.util.find_spec(m) is None]

import kernel  # noqa: E402  (imports are lazy; loading never needs python-pptx)


@unittest.skipIf(MISSING, f"PPTX packages not installed: {MISSING}")
class PptxKernelTest(unittest.TestCase):
    def setUp(self):
        self.cwd = os.getcwd()
        self.tmp = tempfile.TemporaryDirectory()
        os.chdir(self.tmp.name)

    def tearDown(self):
        os.chdir(self.cwd)
        self.tmp.cleanup()

    def test_skill_example_deck_passes_lint_and_outline(self):
        text = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        block = re.search(r"## Creating a deck with python-pptx\n\n```python\n(.*?)```", text, re.S).group(1)
        exec(block, {"set_run_fonts": kernel.set_run_fonts})
        report = kernel.lint_pptx("deck.pptx")
        self.assertTrue(report["ok"], report["issues"])
        self.assertEqual(report["slide_size_in"], [13.333, 7.5])
        self.assertEqual(report["fonts"], ["Calibri"])
        [slide] = kernel.pptx_outline("deck.pptx")
        self.assertEqual(slide["charts"], 1)
        self.assertIn("Treatment B halves relapse at 12 months", slide["texts"])
        self.assertTrue(slide["notes"])
        from pptx import Presentation
        from pptx.oxml.ns import qn
        run = Presentation("deck.pptx").slides[0].shapes[0].text_frame.paragraphs[0].runs[0]
        rpr = run._r.find(qn("a:rPr"))
        tags = [child.tag.split("}")[1] for child in rpr]
        self.assertEqual(rpr.find(qn("a:ea")).get("typeface"), "Microsoft YaHei")
        self.assertEqual(tags.index("ea"), tags.index("latin") + 1)

    def build_defective_deck(self):
        from PIL import Image
        from pptx import Presentation
        from pptx.util import Inches, Pt
        Image.new("RGB", (600, 300), "red").save("fig.png")
        deck = Presentation()
        deck.slide_width, deck.slide_height = Inches(13.333), Inches(7.5)
        slide = deck.slides.add_slide(deck.slide_layouts[6])
        crowded = slide.shapes.add_textbox(Inches(0.6), Inches(2), Inches(3), Inches(0.6))
        crowded.text_frame.word_wrap = True
        run = crowded.text_frame.paragraphs[0].add_run()
        run.text = "这是一个很长的中文段落，用来测试文字是否会溢出文本框的边界。" * 3
        run.font.size = Pt(16)
        outside = slide.shapes.add_textbox(Inches(12), Inches(7), Inches(3), Inches(1))
        outside.text_frame.text = "Lorem ipsum"
        tiny = slide.shapes.add_textbox(Inches(5), Inches(3), Inches(3), Inches(1))
        tiny.text_frame.paragraphs[0].add_run().text = "fine print"
        tiny.text_frame.paragraphs[0].runs[0].font.size = Pt(8)
        tiny.text_frame.paragraphs[0].runs[0].font.name = "Aptos"
        picture = kernel.place_picture(slide, "fig.png", 7, 1, 5, 5)
        deck.slides.add_slide(deck.slide_layouts[1]).shapes.title.text = "Second"
        deck.save("bad.pptx")
        return picture

    def test_lint_reports_overflow_off_slide_placeholder_and_font_issues(self):
        picture = self.build_defective_deck()
        self.assertEqual([round(v / 914400, 3) for v in (picture.left, picture.top, picture.width, picture.height)],
                         [7.0, 2.25, 5.0, 2.5])
        report = kernel.lint_pptx("bad.pptx")
        self.assertFalse(report["ok"])
        kinds = {(i["slide"], i["shape"], i["kind"]) for i in report["issues"]}
        for expected in [(1, "TextBox 1", "text_overflow"), (1, "TextBox 2", "off_slide"),
                         (1, "TextBox 2", "placeholder_text"), (1, "TextBox 3", "small_font"),
                         (1, "TextBox 3", "unreliable_font"), (2, "Content Placeholder 2", "empty_placeholder")]:
            self.assertIn(expected, kinds)

    def test_skill_slide_deletion_recipe_drops_the_slide_part(self):
        import zipfile
        from pptx import Presentation
        self.build_defective_deck()
        deck = Presentation("bad.pptx")
        sld = deck.slides._sldIdLst[0]
        deck.part.drop_rel(sld.rId)
        deck.slides._sldIdLst.remove(sld)
        deck.save("deleted.pptx")
        self.assertEqual(len(Presentation("deleted.pptx").slides), 1)
        parts = [n for n in zipfile.ZipFile("deleted.pptx").namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)]
        self.assertEqual(len(parts), 1)

    def test_render_reports_missing_libreoffice_instead_of_raising(self):
        self.build_defective_deck()
        if kernel._find_soffice(None) is not None:
            self.skipTest("LibreOffice is installed; rendering is covered by manual QA")
        result = kernel.render_pptx_pages("bad.pptx", soffice="/nonexistent/soffice")
        self.assertEqual(result["available"], False)
        self.assertEqual(result["pages"], [])


if __name__ == "__main__":
    unittest.main()
