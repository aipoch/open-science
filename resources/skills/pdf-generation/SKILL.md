---
name: pdf-generation
description: Use when creating a PDF report, handout, or poster with Python, or when merging, splitting, rotating, watermarking, encrypting, filling forms in, or extracting tables from an existing PDF inside the Notebook. Covers ReportLab layout with embedded Unicode/CJK fonts, pypdf and pdfplumber processing, page rendering for visual QA, and Artifact delivery. For reading or citing a library paper, prefer read_document, list_pdf_elements, and read_library_pdf.
license: Apache-2.0
---

# PDF generation and processing

Create new PDFs with ReportLab. Process existing PDFs with pypdf (pages, metadata, forms, encryption), pdfplumber (text with layout, tables), and pypdfium2 (rendering to images). User requirements for content, page size, and design take precedence over the defaults below.

## Choose the tool

| Task                                                  | Use                                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Read, quote, or summarize a paper or attached PDF     | `read_document`, `list_pdf_elements`/`read_pdf_element`, `read_library_pdf`; no code needed   |
| Create a report or handout                            | ReportLab Platypus (`SimpleDocTemplate`, `Paragraph`, `Table`, `Image`)                       |
| Precise one-page layouts (poster, certificate, label) | ReportLab `canvas`                                                                            |
| Merge, split, rotate, crop, watermark, encrypt        | pypdf                                                                                         |
| Extract tables or positioned text                     | pdfplumber                                                                                    |
| Fill a form                                           | `pdf_form_fields` and `fill_pdf_form`, then follow [references/forms.md](references/forms.md) |
| Look at pages                                         | `render_pdf_pages` + `host.viewImage`                                                         |

Advanced recipes (cropping, bookmarks, links, table styling, pdfplumber settings, OCR, troubleshooting) are in [references/processing.md](references/processing.md).

## Setup

Run all PDF code with `notebook_execute`, not the shell. Check packages with `inspect_packages`; install missing ones with `manage_packages` (`language: "python"`, packages `reportlab`, `pypdf`, `pdfplumber`, `pypdfium2`, `pillow`). Never run `pip` in a cell. Poppler, qpdf, pdftk, and LibreOffice are not bundled; do not plan on `pdftotext`, `pdftoppm`, or `qpdf` commands.

Attached files are under `inputs/` relative to the Notebook working directory. Use the exact `notebookPath` shown for each input. Write outputs to the working directory or a subdirectory of it, never into this skill's directory and never over an input.

The registered helpers are injected with `kernelSkillIds`. Call them directly without importing, and repeat `kernelSkillIds` in every cell that uses them:

```json
{
  "kernelSkillIds": ["pdf-generation"],
  "code": "fonts = register_pdf_fonts(cjk=True)\nprint(fonts)"
}
```

| Helper                                                                               | Purpose                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `register_pdf_fonts(path=None, bold_path=None, *, cjk=False)`                        | Registers an embedded TrueType family `OSBody`/`OSBody-Bold` and returns its names. `cjk=True` finds a Chinese/Japanese/Korean system font or raises. Without it, DejaVu Sans (Latin, Greek, math symbols) is used |
| `render_pdf_pages(pdf_path, out_dir="pdf-pages", *, pages=None, max_long_edge=1568)` | Writes `page-001.png` and so on for visual QA, returns the paths                                                                                                                                                   |
| `inspect_pdf(pdf_path)`                                                              | Page count and sizes, text-layer presence, outline size, form fields, unembedded fonts                                                                                                                             |
| `pdf_form_fields(pdf_path)`                                                          | Fillable fields with page, rect, and allowed values                                                                                                                                                                |
| `fill_pdf_form(input_pdf, values, output_pdf)`                                       | Validates every value, then writes a new filled PDF                                                                                                                                                                |

## Creating a report with ReportLab

Fonts come first. ReportLab's built-in fonts (Helvetica, Times) cover only Western European text: Chinese, Greek letters, `±`, `≥`, and `µ` render as black boxes or vanish. Call `register_pdf_fonts` once per cell before building styles. Use `cjk=True` whenever the text may contain CJK characters. If it raises, ask the user for a TrueType font file rather than switching to an unembedded CID font; the Open Science preview may not display unembedded CJK text.

```python
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

fonts = register_pdf_fonts(cjk=True)
body = ParagraphStyle("Body", fontName=fonts["regular"], fontSize=10.5, leading=15)
h1 = ParagraphStyle("H1", parent=body, fontName=fonts["bold"], fontSize=17, leading=22, spaceBefore=6, spaceAfter=8)
h2 = ParagraphStyle("H2", parent=h1, fontSize=13.5, leading=18)
caption = ParagraphStyle("Caption", parent=body, fontSize=9, leading=12, textColor=colors.HexColor("#555555"))

def heading(text, style, level, key):
    p = Paragraph(f'<a name="{key}"/>{text}', style)
    p.outline = (text, level, key)  # consumed by afterFlowable below
    return p

class Report(SimpleDocTemplate):
    def afterFlowable(self, flowable):
        if hasattr(flowable, "outline"):
            text, level, key = flowable.outline
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(text, key, level=level, closed=False)

def page_number(canvas, doc):
    canvas.saveState()
    canvas.setFont(fonts["regular"], 8.5)
    canvas.drawRightString(A4[0] - 20 * mm, 12 * mm, str(doc.page))
    canvas.restoreState()

doc = Report("report.pdf", pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm,
             topMargin=20 * mm, bottomMargin=20 * mm,
             title="Report title", author="Open Science", subject="One-line summary")
source_url = "https://doi.org/10.1000/182"  # use the verified DOI or URL from the source record
story = [heading("1. Results", h1, 0, "results"),
         Paragraph(f'Effect size was 0.42 (<a href="{source_url}" color="#1a5fb4">DOI Handbook</a>).', body),
         Spacer(1, 4 * mm)]
doc.build(story, onFirstPage=page_number, onLaterPages=page_number)
```

Rules that prevent the common defects:

- **Paragraph text is XML.** Escape user and data text with `xml.sax.saxutils.escape` before wrapping it in `Paragraph`; a bare `&` or `<` raises or silently drops text. Line breaks are `<br/>`, not `\n`.
- **Never use Unicode subscript or superscript characters** (₀₁₂, ⁰¹²). Use `<sub>` and `<super>` markup inside a `Paragraph`, for example `H<sub>2</sub>O` and `10<super>-3</super>`.
- **Tables:** wrap cell text in `Paragraph` objects so it wraps; plain strings never wrap and overflow the page. Give `colWidths` that sum to the frame width (`doc.width`). Set `repeatRows=1` for multi-page tables and use `TableStyle` for padding, a `0.5` pt grid in a mid gray, and bold header text.
- **Figures:** insert PNGs from `figure-style` or `figure-composer` at their saved aspect ratio: `Image(path, width=w, height=w * px_h / px_w)`. Read the pixel size with PIL; never stretch. Keep 300 dpi sources; a figure narrower than the text width should not be scaled up.
- **Citations:** keep the citation style the user or upstream skill used. For `literature-review` output, keep inline `[Author Year](https://doi.org/…)` links as `<a href>` in the paragraph. Use `format_references` when a formatted reference list is needed. Never invent a DOI or URL.
- **Metadata:** set `title`, `author`, and `subject` on the document template. Add a bookmark for each heading as shown, so the PDF outline works in viewers.
- **Page geometry:** default to A4 with 20 mm margins unless the user or locale implies US Letter. Use `KeepTogether` for a heading with its first paragraph and for a figure with its caption.

## Processing existing PDFs

```python
from pypdf import PdfReader, PdfWriter

writer = PdfWriter()                                  # merge
for path in ["inputs/a.pdf", "inputs/b.pdf"]:
    writer.append(path)
writer.write("merged.pdf")

reader = PdfReader("inputs/a.pdf")                    # extract pages 2-4 (1-based)
part = PdfWriter()
for page in reader.pages[1:4]:
    part.add_page(page)
part.write("pages-2-4.pdf")

page = reader.pages[0].rotate(90)                     # rotate clockwise

import pdfplumber                                     # tables
with pdfplumber.open("inputs/a.pdf") as pdf:
    rows = pdf.pages[0].extract_tables()
```

Before transforming an unknown PDF, call `inspect_pdf`. If `likely_scanned` is true, the file has no text layer; text extraction returns nothing and OCR is required (see references/processing.md). Keep the original page order, bookmarks, and links unless the user asked to change them. `PdfWriter(clone_from=reader)` preserves document-level structures that page-by-page copying drops.

## Visual QA (required for generated PDFs)

Your first render usually has defects. Render, look, fix, and re-render only the changed pages:

1. In the Notebook, call `inspect_pdf("report.pdf")`. Confirm the page count, `unembedded_fonts == []`, and text previews that contain the expected text rather than empty strings or boxes.
2. Call `render_pdf_pages("report.pdf", "qa/report")`. It returns paths such as `qa/report/page-001.png`.
3. In a foreground `repl_execute`, view up to four pages per invocation: `await host.viewImage({ path: "qa/report/page-001.png" })`. If the path is rejected as outside the execution workspace, publish the PNG with `write_artifact_file` and view it by `versionId`.

Check for: missing glyphs (black boxes or blank gaps), text running past margins or table cells, tables split without a repeated header, figures stretched or blurred, captions separated from figures, orphaned headings at the bottom of a page, footer or page numbers colliding with content, and placeholder text (`TODO`, `lorem`, `xxx`). Fix the generator code and rebuild; do not patch the output PDF.

## Artifact delivery

Pass the generated file's local path to `write_artifact_file` with `mimeType: "application/pdf"` and the exact execution `runId` as `producerRunId`. Do not publish QA PNGs unless the user asks for them or you needed one for `viewImage`. Claim the PDF is available only after the Artifact tool succeeds, then end the reply with `- [report.pdf](report.pdf) — one-line description`.

The Open Science PDF preview uses pdf.js. Embedded TrueType fonts display reliably. Fonts that are not embedded are substituted by the viewer, so use `register_pdf_fonts` rather than relying on viewer fonts.
