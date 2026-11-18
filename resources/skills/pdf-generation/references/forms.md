# Filling PDF forms

Complete these steps in order. Run code with `notebook_execute` and `kernelSkillIds: ["pdf-generation"]`. Never overwrite the input form.

## 1. Detect fillable fields

```python
fields = pdf_form_fields("inputs/form.pdf")
print(len(fields)); fields[:10]
```

A non-empty list means the PDF has AcroForm fields: follow section 2. An empty list means the form is printed text and lines only: follow section 3.

## 2. Fillable forms

1. Render the pages with `render_pdf_pages` and view them, so each `field_id` is mapped to its visible label. Field names such as `Text12` say nothing about meaning. `rect` is `[left, bottom, right, top]` in PDF points with the origin at the bottom left. To find a field on a rendered PNG, convert with `x_px = left * scale` and `y_px = (page_height - top) * scale`, where `scale = png_width / page_width_pt` (page sizes come from `inspect_pdf`).
2. Build one dict of values. Checkboxes take their `checked_value` or `unchecked_value`. Radio groups and choice fields take one of the listed option values. Text fields take strings.
3. Fill into a new file:

```python
fill_pdf_form("inputs/form.pdf", {"last_name": "Simpson", "Check12": "/Yes"}, "form-filled.pdf")
```

`fill_pdf_form` checks every id and value first and reports every problem at once without writing anything. Fix the dict and run it again. It sets `NeedAppearances` so viewers regenerate field appearances.

4. Render the filled file and look at every page that has filled fields. If a viewer shows empty fields although the values are set (`PdfReader(...).get_fields()[id]["/V"]`), the form has stale appearance streams. Report that to the user, or produce a flattened copy with the overlay method in section 3 if the user wants printed values.

## 3. Non-fillable forms (text overlay)

Write the values onto a transparent ReportLab page and merge it over the original. This produces normal page text, which every viewer shows.

### 3a. Find coordinates from the text layer

```python
import pdfplumber
with pdfplumber.open("inputs/form.pdf") as pdf:
    page = pdf.pages[0]
    words = page.extract_words()        # x0, x1, top, bottom; origin at the TOP left
    lines = [l for l in page.lines if abs(l["top"] - l["bottom"]) < 1]   # entry underlines
    boxes = [r for r in page.rects if 6 <= r["width"] <= 16 and abs(r["width"] - r["height"]) < 2]  # checkboxes
```

pdfplumber measures `top` from the top of the page; ReportLab and pypdf measure `y` from the bottom. Convert with `y = page_height - bottom`. Put an entry after its label (`x = label.x1 + 4`) on the underline or inside the box. Group words with the same `top` into one label.

If `extract_words()` returns nothing or `(cid:…)` noise, the page is scanned. Estimate positions from the rendered PNG instead, refine them by viewing crops (`host.viewImage({ path }, { crop: { unit: "pixels", left, top, right, bottom } })`), and convert pixels to points with `pt = px / scale`.

### 3b. Draw the overlay and merge

```python
import io
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas

fonts = register_pdf_fonts(cjk=True)       # cjk=False when every value is Latin text
entries = [  # page (1-based), x and y in PDF points from the bottom left, text, size
    {"page": 1, "x": 140, "y": 702, "text": "Simpson", "size": 10},
    {"page": 1, "x": 287, "y": 590, "text": "X", "size": 10},
]
reader = PdfReader("inputs/form.pdf")
writer = PdfWriter(clone_from=reader)
for number, page in enumerate(writer.pages, start=1):
    items = [e for e in entries if e["page"] == number]
    if not items:
        continue
    box = page.mediabox
    buffer = io.BytesIO()
    c = canvas.Canvas(buffer, pagesize=(float(box.width), float(box.height)))
    for e in items:
        c.setFont(fonts["regular"], e["size"])
        c.drawString(float(box.left) + e["x"], float(box.bottom) + e["y"], e["text"])
    c.save()
    page.merge_page(PdfReader(buffer).pages[0])
writer.write("form-filled.pdf")
```

Before drawing, check that no two entry boxes overlap and that each entry fits: the string width (`reportlab.pdfbase.pdfmetrics.stringWidth(text, font, size)`) must be smaller than the space before the next label, and `size` must be smaller than the box height. For a page with `/Rotate`, render it and confirm the orientation before trusting coordinates.

## 4. Verify

Render each filled page with `render_pdf_pages("form-filled.pdf", "qa/form")` and view it. Check that every value sits on its line or in its box, that nothing overlaps printed text, that checkmarks land in the right box, and that no required field was missed. Fix the coordinates or values and regenerate. Then deliver `form-filled.pdf` as an Artifact.
