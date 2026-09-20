"""Create synthetic inputs; requires reportlab and pypdf, not production dependencies."""

import io
import json
import sys
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.annotations import Text
from pypdf.generic import FloatObject, NameObject, RectangleObject
from reportlab.pdfgen import canvas

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
buffer = io.BytesIO()
c = canvas.Canvas(buffer, pagesize=(612, 792), invariant=1)
c.setTitle("MuPDF annotation export - interoperability specimen")
cases = []
for index, (rotation, crop, unit) in enumerate([
    (0, False, 1), (90, False, 1), (180, False, 1), (270, False, 1),
    (0, True, 1), (90, True, 1), (270, True, 2),
]):
    c.setFillColorRGB(.08, .18, .23)
    c.setFont("Helvetica-Bold", 22)
    c.drawString(60, 701, "Native PDF annotations")
    c.setFont("Helvetica", 10)
    c.drawString(60, 678, f"Page {index + 1} | Rotate {rotation} | CropBox offset {crop} | UserUnit {unit}")
    c.setStrokeColorRGB(.75, .82, .83)
    c.line(60, 662, 548, 662)
    for row, kind in enumerate(["highlight", "underline", "squiggly", "strikethrough"]):
        y = 620 - row * 68
        c.setFont("Helvetica-Bold", 10)
        c.drawString(60, y + 20, kind.upper())
        c.setFont("Helvetica", 14)
        text = "Evidence stays searchable and selectable."
        c.drawString(60, y, text)
        cases.append(dict(id=f"p{index + 1}-{kind}", pageNumber=index + 1, kind=kind,
                          color=["yellow", "blue", "green", "pink"][row],
                          rawRects=[[60, y - 3, 60 + c.stringWidth(text, "Helvetica", 14), y + 12]],
                          note=f"{kind}: 中文评论，导出后应可查看与编辑。\nSecond line of the comment."))
    c.setFont("Helvetica-Bold", 10)
    c.drawString(60, 368, "MULTILINE HIGHLIGHT / LONG COMMENT")
    c.setFont("Helvetica", 14)
    for j, text in enumerate(["One annotation can cover several lines.", "The note is stored as Unicode text."]):
        c.drawString(60, 346 - j * 22, text)
    cases.append(dict(id=f"p{index + 1}-multiline", pageNumber=index + 1, kind="highlight",
                      rawRects=[[60, 343, 318, 358], [60, 321, 285, 336]],
                      note=("长评论保留测试，标注仍可编辑。\n" * 500)))
    c.setFillColorRGB(.93, .95, .96)
    c.rect(60, 172, 360, 105, fill=1, stroke=0)
    c.setFillColorRGB(.13, .32, .4)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(76, 253, "REGION / FIGURE HIGHLIGHT")
    for j, height in enumerate([25, 43, 32, 55, 37]):
        c.rect(80 + 58 * j, 184, 30, height, fill=1, stroke=0)
    cases.append(dict(id=f"p{index + 1}-area", pageNumber=index + 1, kind="area",
                      color="purple", rawRects=[[60, 172, 420, 277]], note="区域批注：图表保留原始矢量内容，不嵌入截图。"))
    cases.append(dict(id=f"p{index + 1}-note", pageNumber=index + 1, kind="page-note",
                      rawRects=[[484, 600, 506, 622]], note="页面笔记：这是原生 PDF Text 注释。"))
    c.setFont("Helvetica", 9)
    c.drawString(60, 120, "Original text, vector graphics and existing annotations must survive export.")
    c.showPage()
c.save()
reader = PdfReader(buffer)
writer = PdfWriter()
for page, (rotation, crop, unit) in zip(reader.pages, [
    (0, False, 1), (90, False, 1), (180, False, 1), (270, False, 1),
    (0, True, 1), (90, True, 1), (270, True, 2),
]):
    if rotation:
        page.rotate(rotation)
    if crop:
        page.cropbox = RectangleObject([36, 72, 570, 744])
    page[NameObject("/UserUnit")] = FloatObject(unit)
    writer.add_page(page)
writer.add_annotation(0, Text(rect=(520, 600, 542, 622), text="Existing original annotation - preserve me"))
writer.write(out / "fixture.pdf")
cases.append(dict(id="document-note", kind="document-note", note="全文笔记：测试放在第一页页边，正式产品尚未决定入口。"))
# Simulate a user rotating the viewer, independently of the page's intrinsic rotation.
cases[0]["pageRotation"] = 90
(out / "fixture-marks.json").write_text(json.dumps(cases, ensure_ascii=False, indent=2))
# A bounded dense workload; repeat a real text/vector page, not blank pages.
dense = PdfWriter()
for _ in range(200):
    dense.add_page(reader.pages[0])
dense.write(out / "dense.pdf")
dense_marks = []
for page in range(1, 201):
    for index in range(20):
        mark = cases[index % 4].copy()
        mark.update(id=f"dense-{page}-{index}", pageNumber=page,
                    note="Dense export workload / 中文评论",
                    rawRects=[[60, 120 + index * 22, 320, 135 + index * 22]])
        dense_marks.append(mark)
(out / "dense-marks.json").write_text(json.dumps(dense_marks, ensure_ascii=False))
print(json.dumps({"fixturePages": 7, "fixtureMarks": len(cases), "densePages": 200}))

# Optional bounded image-heavy workload; requires Pillow only for this fixture.
if "--image-heavy" in sys.argv[2:]:
    import random
    from PIL import Image
    from reportlab.lib.utils import ImageReader

    rng = random.Random(420)
    image_pdf = canvas.Canvas(str(out / "image-heavy.pdf"), pagesize=(612, 792), invariant=1)
    image_marks = []
    for page in range(24):
        image = Image.frombytes("RGB", (1200, 1600), rng.randbytes(1200 * 1600 * 3))
        jpeg = io.BytesIO()
        image.save(jpeg, format="JPEG", quality=85)
        image_pdf.drawImage(ImageReader(io.BytesIO(jpeg.getvalue())), 0, 0, width=612, height=792)
        for index in range(10):
            image_marks.append(dict(id=f"image-{page}-{index}", pageNumber=page + 1, kind="area",
                                    color="purple", rawRects=[[60, 80 + index * 60, 300, 120 + index * 60]],
                                    note="图像型文档区域评论 / image-heavy fixture"))
        image_pdf.showPage()
    image_pdf.save()
    (out / "image-heavy-marks.json").write_text(json.dumps(image_marks, ensure_ascii=False))
    print(json.dumps({"imagePages": 24, "imageMarks": len(image_marks), "imageBytes": (out / "image-heavy.pdf").stat().st_size}))
