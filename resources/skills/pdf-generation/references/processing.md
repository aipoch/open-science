# PDF processing recipes

All recipes run in `notebook_execute`. Paths are relative to the Notebook working directory; attached files are under `inputs/`. Command-line tools (poppler, qpdf, pdftk, ImageMagick) are not bundled, so every recipe here is pure Python. JavaScript PDF libraries are not needed in the Notebook.

## Pages

```python
from pypdf import PdfReader, PdfWriter, Transformation

reader = PdfReader("inputs/in.pdf")
writer = PdfWriter()
for number in [1, 3, 5]:                       # pick and reorder (1-based)
    writer.add_page(reader.pages[number - 1])
writer.write("picked.pdf")

writer = PdfWriter(clone_from=reader)          # crop page 1 (points from the bottom left)
page = writer.pages[0]
page.cropbox.lower_left = (50, 50)
page.cropbox.upper_right = (545, 792)
writer.write("cropped.pdf")

page = PdfWriter(clone_from=reader).pages[0]   # scale content to A4
page.scale_to(595.28, 841.89)
```

Chunk-split every 10 pages with `writer.add_page` inside a loop over `range(0, len(reader.pages), 10)`. `writer.append(path, pages=(start, stop))` merges a 0-based half-open range and keeps bookmarks of the appended range.

## Bookmarks, links, metadata

```python
writer = PdfWriter(clone_from=PdfReader("in.pdf"))
chapter = writer.add_outline_item("1. Methods", 0)        # page index 0
writer.add_outline_item("1.1 Samples", 1, parent=chapter)
writer.add_metadata({"/Title": "Report", "/Author": "Lab", "/Subject": "Summary"})
writer.write("with-outline.pdf")
```

When building with ReportLab, prefer bookmarks at build time (see SKILL.md). Internal links in Platypus are `<a href="#key">` pointing at an `<a name="key"/>` anchor.

## Watermark or stamp

Create the stamp with ReportLab at the target page size, then merge it on every page. Use `page.merge_page(stamp)` for a foreground stamp, or merge the original page onto a copy of the stamp page for a background mark. Use a light gray (`setFillGray(0.85)`) or `setFillAlpha(0.15)` so the text below stays readable, and register fonts with `register_pdf_fonts` if the stamp text is not plain Latin text.

## Encryption

```python
writer = PdfWriter(clone_from=PdfReader("in.pdf"))
writer.encrypt(user_password="open-pass", owner_password="owner-pass", algorithm="AES-256")
writer.write("protected.pdf")

reader = PdfReader("protected.pdf")
if reader.is_encrypted:
    reader.decrypt("open-pass")
```

AES requires the `cryptography` package; install it with `manage_packages` if pypdf asks for it. Never print or store a user's password in the Notebook output; read it from the user's message only when they provided it for this task.

## Text and tables with pdfplumber

```python
import pdfplumber
with pdfplumber.open("inputs/in.pdf") as pdf:
    page = pdf.pages[0]
    text = page.extract_text(layout=True)                     # keeps column positions
    region = page.within_bbox((0, 0, page.width, 200)).extract_text()   # top 200 pt
    words = page.extract_words(extra_attrs=["fontname", "size"])
    tables = page.extract_tables({
        "vertical_strategy": "lines",      # "text" for tables without ruling lines
        "horizontal_strategy": "lines",
        "snap_tolerance": 3,
        "intersection_tolerance": 15,
    })
```

Convert a table with `pandas.DataFrame(table[1:], columns=table[0])`, then check the header row and merged cells by hand: pdfplumber returns `None` for spanned cells. Use `page.to_image(resolution=100).debug_tablefinder().save("qa/table.png")` and view it when a table splits wrongly. For text from papers in the user's library, prefer `read_library_pdf` and `read_pdf_element`; they already handle layout and citations.

## Images

Extract embedded images with pypdf:

```python
import os
reader = PdfReader("inputs/in.pdf")
os.makedirs("images", exist_ok=True)
for number, page in enumerate(reader.pages, start=1):
    for index, image in enumerate(page.images):
        with open(f"images/p{number}-{index}{os.path.splitext(image.name)[1] or '.png'}", "wb") as fh:
            fh.write(image.data)
```

Vector figures are not embedded images. To capture one, render the page with `render_pdf_pages` at a larger `max_long_edge` and crop the PNG with PIL.

## Scanned PDFs (OCR)

`inspect_pdf(...)["likely_scanned"]` is true when no page has a text layer. OCR needs the Tesseract engine, which is not bundled. Check with `inspect_packages`; it can be installed from conda-forge as `tesseract` together with `pytesseract` through `manage_packages`. Render pages at a long edge of about 3000 px for OCR, then run `pytesseract.image_to_string(PIL.Image.open(path), lang="eng")` (`chi_sim` for Simplified Chinese if that language pack is installed). Report OCR text as machine-read and possibly wrong; do not present it as a verified quotation.

## Troubleshooting

| Symptom                                              | Cause and fix                                                                                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Black boxes or missing characters in a generated PDF | Built-in font used for non-Latin text. Call `register_pdf_fonts(cjk=True)` and use its names in every style, including table and canvas text |
| `TTFError: postscript outlines are not supported`    | The font file is CFF/OpenType. Use a TrueType `.ttf`/`.ttc` instead                                                                          |
| `Paragraph` raises a parse error or drops text       | Unescaped `&`, `<`, or `>`; escape data text with `xml.sax.saxutils.escape`                                                                  |
| Table runs off the page                              | Cells are plain strings or `colWidths` exceed `doc.width`; wrap cells in `Paragraph` and recompute widths                                    |
| `LayoutError: Flowable ... too large`                | One cell, image, or `KeepTogether` block is taller than the frame. Split the table rows, scale the image, or remove `KeepTogether`           |
| `PdfReadError` or empty pages from a damaged file    | Try `PdfReader(path, strict=False)`; if it still fails, ask the user for a re-exported copy                                                  |
| Extracted text has wrong order or missing spaces     | Try `extract_text(layout=True)`, or `extract_words` and sort by `(top, x0)`                                                                  |
