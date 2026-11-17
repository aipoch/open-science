import importlib.util
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "resources" / "skills" / "pdf-generation"
sys.path.insert(0, str(ROOT))
MISSING = [m for m in ("reportlab", "pypdf", "pdfplumber", "pypdfium2", "PIL") if importlib.util.find_spec(m) is None]

import kernel  # noqa: E402  (imports are lazy; loading never needs the PDF packages)


def skill_block(heading):
    text = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    section = text.split(heading, 1)[1]
    return re.search(r"```python\n(.*?)```", section, re.S).group(1)


@unittest.skipIf(MISSING, f"PDF packages not installed: {MISSING}")
class PdfKernelTest(unittest.TestCase):
    def setUp(self):
        self.cwd = os.getcwd()
        self.tmp = tempfile.TemporaryDirectory()
        os.chdir(self.tmp.name)

    def tearDown(self):
        os.chdir(self.cwd)
        self.tmp.cleanup()

    def test_skill_report_example_builds_embedded_fonts_bookmarks_and_renders(self):
        namespace = {"register_pdf_fonts": lambda cjk=False, **kw: kernel.register_pdf_fonts(**kw)}
        exec(skill_block("## Creating a report with ReportLab"), namespace)
        info = kernel.inspect_pdf("report.pdf")
        self.assertEqual(info["pages"], 1)
        self.assertEqual(info["unembedded_fonts"], [])
        self.assertEqual(info["outline_items"], 1)
        self.assertEqual(info["metadata"]["Title"], "Report title")
        self.assertIn("Results", info["page_details"][0]["text_preview"])
        pages = kernel.render_pdf_pages("report.pdf", "qa", max_long_edge=400)
        self.assertEqual(pages, [os.path.join("qa", "page-001.png")])
        from PIL import Image
        with Image.open(pages[0]) as image:
            self.assertEqual(max(image.size), 400)
        with self.assertRaises(ValueError):
            kernel.render_pdf_pages("report.pdf", pages=[2])

    def test_default_font_covers_greek_and_cjk_is_explicit(self):
        fonts = kernel.register_pdf_fonts()
        self.assertTrue(fonts["embedded"])
        self.assertFalse(fonts["cjk"])
        try:
            cjk = kernel.register_pdf_fonts(cjk=True)
        except RuntimeError as error:
            self.assertIn("path=", str(error))
        else:
            self.assertTrue(cjk["cjk"] and cjk["embedded"])
        with self.assertRaises(ValueError):
            kernel.register_pdf_fonts(path="missing.ttf")

    def make_form(self):
        from reportlab.pdfgen import canvas
        c = canvas.Canvas("form.pdf")
        form = c.acroForm
        form.textfield(name="name", x=100, y=700, width=200, height=20)
        form.checkbox(name="agree", x=100, y=650)
        form.choice(name="color", value="red", options=["red", "blue"], x=100, y=600, width=100, height=20)
        form.radio(name="size", value="s", x=100, y=550, selected=True)
        form.radio(name="size", value="m", x=130, y=550)
        c.showPage()
        c.save()

    def test_form_fields_are_listed_validated_and_filled(self):
        self.make_form()
        fields = {f["field_id"]: f for f in kernel.pdf_form_fields("form.pdf")}
        self.assertEqual(set(fields), {"name", "agree", "color", "size"})
        self.assertEqual(fields["name"]["rect"], [100.0, 700.0, 300.0, 720.0])
        self.assertEqual([o["value"] for o in fields["size"]["radio_options"]], ["/s", "/m"])
        with self.assertRaisesRegex(ValueError, "unknown field_id 'nope'.*'/Bad'"):
            kernel.fill_pdf_form("form.pdf", {"nope": 1, "agree": "/Bad"}, "out.pdf")
        self.assertFalse(os.path.exists("out.pdf"))
        values = {"name": "Zhang", "agree": fields["agree"]["checked_value"], "color": "blue", "size": "/m"}
        self.assertEqual(kernel.fill_pdf_form("form.pdf", values, "out.pdf")["filled"], 4)
        from pypdf import PdfReader
        filled = {k: v.get("/V") for k, v in PdfReader("out.pdf").get_fields().items()}
        self.assertEqual(filled, values)
        with self.assertRaises(FileExistsError):
            kernel.fill_pdf_form("form.pdf", values, "out.pdf")

    def test_scanned_page_has_no_text_layer(self):
        from reportlab.pdfgen import canvas
        c = canvas.Canvas("blank.pdf")
        c.rect(100, 100, 200, 200, fill=1)
        c.showPage()
        c.save()
        self.assertTrue(kernel.inspect_pdf("blank.pdf")["likely_scanned"])

    def test_forms_reference_overlay_example_writes_page_text(self):
        self.make_form()
        os.makedirs("inputs")
        os.replace("form.pdf", "inputs/form.pdf")
        text = (ROOT / "references" / "forms.md").read_text(encoding="utf-8")
        block = re.search(r"### 3b.*?```python\n(.*?)```", text, re.S).group(1)
        exec(block, {"register_pdf_fonts": lambda cjk=False, **kw: kernel.register_pdf_fonts(**kw)})
        self.assertIn("Simpson", kernel.inspect_pdf("form-filled.pdf")["page_details"][0]["text_preview"])


if __name__ == "__main__":
    unittest.main()
