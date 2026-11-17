import math
import os
import re

_EMU_PER_IN = 914400
_EMU_PER_PT = 12700
_PLACEHOLDER_TEXT = re.compile(
    r"\bx{3,}\b|lorem|ipsum|\bTODO\b|\[insert|click to (add|edit)|this.*(page|slide).*layout", re.I)
_UNRELIABLE_FONTS = {"aptos", "aptos display", "aptos narrow"}


def _iter_text_shapes(shapes):
    from pptx.enum.shapes import MSO_SHAPE_TYPE
    for shape in shapes:
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from _iter_text_shapes(shape.shapes)
        elif shape.has_text_frame:
            yield shape, list(shape.text_frame.paragraphs)
        elif getattr(shape, "has_table", False) and shape.has_table:
            yield shape, [p for row in shape.table.rows for cell in row.cells for p in cell.text_frame.paragraphs]


def _slide_title(slide):
    title = slide.shapes.title
    return title.text_frame.text.strip() if title is not None and title.has_text_frame else None


def pptx_outline(pptx_path):
    """Return a per-slide text dump: layout, title, text blocks, notes, object counts.

    Use it for content QA (missing items, order, typos) and to map a template's
    slides before editing. Text from groups and table cells is included.
    """
    from pptx import Presentation
    deck = Presentation(pptx_path)
    slides = []
    for number, slide in enumerate(deck.slides, start=1):
        texts = []
        for shape, paragraphs in _iter_text_shapes(slide.shapes):
            block = "\n".join(p.text for p in paragraphs if p.text.strip())
            if block:
                texts.append(block)
        notes = slide.notes_slide.notes_text_frame.text.strip() if slide.has_notes_slide else ""
        kinds = [getattr(s.shape_type, "name", str(s.shape_type)) for s in slide.shapes]
        slides.append({"slide": number, "layout": slide.slide_layout.name, "title": _slide_title(slide),
                       "texts": texts, "notes": notes,
                       "pictures": kinds.count("PICTURE"), "charts": sum(1 for s in slide.shapes if getattr(s, "has_chart", False)),
                       "tables": sum(1 for s in slide.shapes if getattr(s, "has_table", False))})
    return slides


def _char_em(ch, bold):
    code = ord(ch)
    if (0x2E80 <= code <= 0x9FFF or 0xAC00 <= code <= 0xD7AF or 0xF900 <= code <= 0xFAFF
            or 0xFF00 <= code <= 0xFFEF or 0x3000 <= code <= 0x303F):
        return 1.0
    if ch == " ":
        return 0.28
    if ch.isupper() or ch in "mwMW@%":
        return 0.68 if bold else 0.64
    return 0.55 if bold else 0.5


def _paragraph_size_pt(paragraph, default_pt):
    sizes = [r.font.size.pt for r in paragraph.runs if r.font.size is not None]
    if sizes:
        return max(sizes), False
    if paragraph.font.size is not None:
        return paragraph.font.size.pt, False
    return default_pt, True


def _estimate_text_height_pt(shape, paragraphs, default_pt):
    """Approximate rendered text height for a wrapping text box; None if not estimable."""
    frame = shape.text_frame
    margin_w = (frame.margin_left or 0) + (frame.margin_right or 0)
    margin_h = (frame.margin_top or 0) + (frame.margin_bottom or 0)
    avail_pt = (shape.width - margin_w) / _EMU_PER_PT
    if avail_pt <= 0:
        return None, False, False
    total, assumed, too_wide = margin_h / _EMU_PER_PT, False, False
    for paragraph in paragraphs:
        size, guessed = _paragraph_size_pt(paragraph, default_pt)
        assumed = assumed or guessed
        bold = any(r.font.bold for r in paragraph.runs)
        spacing = paragraph.line_spacing
        factor = spacing if isinstance(spacing, float) and spacing < 5 else 1.0
        line_pt = (spacing.pt if hasattr(spacing, "pt") else size * 1.2 * factor)
        lines = 0
        for piece in re.split(r"[\v\n]", paragraph.text) or [""]:
            width = sum(_char_em(ch, bold) for ch in piece) * size
            if frame.word_wrap is False:
                lines += 1
                too_wide = too_wide or width > avail_pt * 1.02
            else:
                lines += max(1, math.ceil(width * 1.05 / avail_pt))
        total += lines * line_pt
        total += (paragraph.space_before.pt if paragraph.space_before is not None else 0)
        total += (paragraph.space_after.pt if paragraph.space_after is not None else 0)
    return total, assumed, too_wide


def lint_pptx(pptx_path, *, margin_in=0.4, min_font_pt=10, default_font_pt=18):
    """Programmatic layout QA for a .pptx; no renderer required.

    Reports, per slide and shape: off_slide (error), text_overflow (error, an
    estimate; `assumed_size` marks text whose size is inherited and was taken as
    default_font_pt), placeholder_text (error), edge_margin, text_overlap,
    empty_placeholder, small_font and unreliable_font (warnings). Returns
    {"ok", "slides", "slide_size_in", "fonts", "issues"}; ok is False when any
    error is present. Width estimates assume average glyph widths, so treat a
    near-limit pass as a reason to leave slack, not as proof of fit.
    """
    from pptx import Presentation
    deck = Presentation(pptx_path)
    sw, sh = deck.slide_width, deck.slide_height
    margin = margin_in * _EMU_PER_IN
    issues, fonts = [], set()

    def add(slide, shape, kind, severity, **detail):
        issues.append({"slide": slide, "shape": shape.name, "kind": kind, "severity": severity, **detail})

    for number, slide in enumerate(deck.slides, start=1):
        boxes = []
        for shape in slide.shapes:
            if None in (shape.left, shape.top, shape.width, shape.height):
                continue
            if shape.left < 0 or shape.top < 0 or shape.left + shape.width > sw or shape.top + shape.height > sh:
                add(number, shape, "off_slide", "error",
                    box_in=[round(v / _EMU_PER_IN, 2) for v in (shape.left, shape.top, shape.width, shape.height)])
            if shape.is_placeholder and shape.has_text_frame and not shape.text_frame.text.strip():
                add(number, shape, "empty_placeholder", "warning")
        for shape, paragraphs in _iter_text_shapes(slide.shapes):
            text = "\n".join(p.text for p in paragraphs).strip()
            for paragraph in paragraphs:
                for run in paragraph.runs:
                    if run.font.name:
                        fonts.add(run.font.name)
                        if run.font.name.lower() in _UNRELIABLE_FONTS:
                            add(number, shape, "unreliable_font", "warning", font=run.font.name)
                    if run.text.strip() and run.font.size is not None and run.font.size.pt < min_font_pt:
                        add(number, shape, "small_font", "warning", size_pt=run.font.size.pt)
            if not text:
                continue
            match = _PLACEHOLDER_TEXT.search(text)
            if match:
                add(number, shape, "placeholder_text", "error", match=match.group(0))
            if not shape.has_text_frame or None in (shape.left, shape.top, shape.width, shape.height):
                continue
            boxes.append(shape)
            if (shape.left < margin or shape.top < margin or sw - (shape.left + shape.width) < margin
                    or sh - (shape.top + shape.height) < margin):
                add(number, shape, "edge_margin", "warning", margin_in=margin_in)
            # Auto-size is applied by PowerPoint only when the text is edited; the stored
            # box is what viewers render, so it is checked like any other box.
            auto_size = shape.text_frame.auto_size
            needed, assumed, too_wide = _estimate_text_height_pt(shape, paragraphs, default_font_pt)
            box_pt = shape.height / _EMU_PER_PT
            if too_wide or (needed is not None and needed > box_pt + 2):
                add(number, shape, "text_overflow", "error", assumed_size=assumed,
                    estimated_height_in=round((needed or 0) / 72, 2), box_height_in=round(box_pt / 72, 2),
                    unwrapped_too_wide=too_wide,
                    auto_size=None if auto_size is None else auto_size.name)
        for i, a in enumerate(boxes):
            for b in boxes[i + 1:]:
                w = min(a.left + a.width, b.left + b.width) - max(a.left, b.left)
                h = min(a.top + a.height, b.top + b.height) - max(a.top, b.top)
                smaller = min(a.width * a.height, b.width * b.height) or 1
                if w > 0 and h > 0 and w * h / smaller > 0.1:
                    add(number, a, "text_overlap", "warning", other=b.name)
    return {"ok": not any(i["severity"] == "error" for i in issues), "slides": len(deck.slides),
            "slide_size_in": [round(sw / _EMU_PER_IN, 3), round(sh / _EMU_PER_IN, 3)],
            "fonts": sorted(fonts), "issues": issues}


def _emu(value):
    from pptx.util import Length
    return int(value) if isinstance(value, Length) else int(round(float(value) * _EMU_PER_IN))


def place_picture(slide, image_path, left, top, width, height, *, align="center"):
    """Insert a PNG/JPEG scaled to fit inside a box without distortion or upscaling past the box.

    left/top/width/height are inches (float) or python-pptx Length values.
    align : 'center' | 'top-left' — position of the fitted image inside the box.
    Returns the picture shape. SVG and EMF are not supported by python-pptx;
    rasterize them to PNG first (figure-style figures are already 300-dpi PNGs).
    """
    from PIL import Image
    if align not in ("center", "top-left"):
        raise ValueError("place_picture align must be 'center' or 'top-left'")
    box = [_emu(v) for v in (left, top, width, height)]
    if box[2] <= 0 or box[3] <= 0:
        raise ValueError("place_picture width and height must be positive")
    with Image.open(image_path) as image:
        px_w, px_h = image.size
    scale = min(box[2] / px_w, box[3] / px_h)
    w, h = int(px_w * scale), int(px_h * scale)
    x, y = box[0], box[1]
    if align == "center":
        x += (box[2] - w) // 2
        y += (box[3] - h) // 2
    return slide.shapes.add_picture(image_path, x, y, w, h)


def _find_soffice(explicit):
    import shutil
    for candidate in (explicit, shutil.which("soffice"), shutil.which("libreoffice"),
                      "/Applications/LibreOffice.app/Contents/MacOS/soffice",
                      "C:/Program Files/LibreOffice/program/soffice.exe"):
        if candidate and os.path.isfile(candidate):
            return candidate
    return None


def render_pptx_pages(pptx_path, out_dir="pptx-pages", *, soffice=None, max_long_edge=1568, timeout=180):
    """Render slides to PNG through an already installed LibreOffice, for host.viewImage.

    LibreOffice is not bundled. When it is absent this returns
    {"available": False, "reason", "pages": []} instead of raising; fall back to
    lint_pptx and pptx_outline. Otherwise returns {"available": True, "pdf",
    "pages"} with slide-001.png ... in out_dir. LibreOffice substitutes missing
    fonts, so treat text fit in the images as approximate for non-safe fonts.
    """
    import pathlib
    import shutil
    import subprocess
    import tempfile
    binary = _find_soffice(soffice)
    if binary is None:
        return {"available": False, "pages": [],
                "reason": "LibreOffice (soffice) was not found; use lint_pptx and pptx_outline for QA."}
    import pypdfium2 as pdfium
    os.makedirs(out_dir, exist_ok=True)
    with tempfile.TemporaryDirectory() as work:
        profile = pathlib.Path(work, "profile").as_uri()
        result = subprocess.run(
            [binary, f"-env:UserInstallation={profile}", "--headless", "--convert-to", "pdf",
             "--outdir", work, os.path.abspath(pptx_path)],
            capture_output=True, text=True, timeout=timeout)
        produced = os.path.join(work, pathlib.Path(pptx_path).stem + ".pdf")
        if result.returncode != 0 or not os.path.isfile(produced):
            return {"available": False, "pages": [],
                    "reason": f"LibreOffice conversion failed: {(result.stderr or result.stdout).strip()[:500]}"}
        pdf_path = os.path.join(out_dir, pathlib.Path(pptx_path).stem + ".pdf")
        shutil.copyfile(produced, pdf_path)
    document = pdfium.PdfDocument(pdf_path)
    pages = []
    try:
        for index in range(len(document)):
            page = document[index]
            try:
                width, height = page.get_size()
                target = os.path.join(out_dir, f"slide-{index + 1:03d}.png")
                page.render(scale=max_long_edge / max(width, height)).to_pil().save(target)
                pages.append(target)
            finally:
                page.close()
    finally:
        document.close()
    return {"available": True, "pdf": pdf_path, "pages": pages}


_RPR_AFTER_EA = ("cs", "sym", "hlinkClick", "hlinkMouseOver", "rtl", "extLst")


def set_run_fonts(run, *, latin=None, east_asian=None):
    """Set a run's Latin and East Asian typefaces in schema order.

    python-pptx's run.font.name writes only <a:latin>; CJK characters are drawn
    with <a:ea>, which otherwise falls back to the theme font. Pass either or both.
    """
    from pptx.oxml.ns import qn
    if latin is not None:
        run.font.name = latin
    if east_asian is None:
        return run
    rpr = run._r.get_or_add_rPr()
    for old in rpr.findall(qn("a:ea")):
        rpr.remove(old)
    element = rpr.makeelement(qn("a:ea"), {"typeface": east_asian})
    latin_element = rpr.find(qn("a:latin"))
    following = [rpr.find(qn(f"a:{tag}")) for tag in _RPR_AFTER_EA]
    following = [e for e in following if e is not None]
    if latin_element is not None:
        latin_element.addnext(element)
    elif following:
        following[0].addprevious(element)
    else:
        rpr.append(element)
    return run
