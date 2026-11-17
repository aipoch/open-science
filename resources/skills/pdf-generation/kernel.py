import os

# Candidate (regular, bold) TrueType files. ReportLab cannot embed CFF/OpenType
# outlines (most .otf files and Hiragino), so only TrueType-outline files are listed.
_CJK_FONT_CANDIDATES = (
    ("/System/Library/Fonts/STHeiti Light.ttc", "/System/Library/Fonts/STHeiti Medium.ttc"),
    ("/System/Library/Fonts/Supplemental/Songti.ttc", None),
    ("/Library/Fonts/Arial Unicode.ttf", None),
    ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", None),
    ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc"),
    ("C:/Windows/Fonts/simhei.ttf", None),
    ("C:/Windows/Fonts/simsun.ttc", None),
    ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", None),
    ("/usr/share/fonts/truetype/wqy/wqy-microhei.ttc", None),
    ("/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf", None),
)
_BASE14 = {
    "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
    "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
    "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic", "Symbol", "ZapfDingbats",
}


def _try_register_ttf(name, path):
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont, TTFError
    if not path or not os.path.isfile(path):
        return False
    try:
        pdfmetrics.registerFont(TTFont(name, path, subfontIndex=0))
        return True
    except (TTFError, OSError, ValueError):
        return False


def _dejavu_pair():
    try:
        import matplotlib
        root = os.path.join(os.path.dirname(matplotlib.__file__), "mpl-data", "fonts", "ttf")
    except Exception:
        return None, None
    regular = os.path.join(root, "DejaVuSans.ttf")
    bold = os.path.join(root, "DejaVuSans-Bold.ttf")
    return (regular if os.path.isfile(regular) else None), (bold if os.path.isfile(bold) else None)


def register_pdf_fonts(path=None, bold_path=None, *, cjk=False):
    """Register an embeddable Unicode font family for ReportLab and return its names.

    path/bold_path : explicit TrueType (.ttf/.ttc) files; take precedence.
    cjk            : require Chinese/Japanese/Korean glyph coverage. Raises when no
                     embeddable CJK TrueType font is found instead of silently
                     producing empty boxes.
    Without cjk, DejaVu Sans (bundled with matplotlib; Latin, Greek, math symbols)
    is preferred over the base-14 Helvetica, which only covers WinAnsi text.

    Returns {"regular", "bold", "path", "embedded", "cjk"}. Use the names in
    ParagraphStyle(fontName=...) and canvas.setFont(...). Bold falls back to the
    regular face when the family has no bold file.
    """
    from reportlab.lib.fonts import addMapping
    candidates = []
    if path:
        candidates.append((path, bold_path, bool(cjk)))
    elif cjk:
        candidates.extend((r, b, True) for r, b in _CJK_FONT_CANDIDATES)
    else:
        regular, bold = _dejavu_pair()
        candidates.append((regular, bold, False))
    for regular, bold, has_cjk in candidates:
        if not _try_register_ttf("OSBody", regular):
            continue
        bold_name = "OSBody-Bold" if _try_register_ttf("OSBody-Bold", bold) else "OSBody"
        addMapping("OSBody", 0, 0, "OSBody")
        addMapping("OSBody", 1, 0, bold_name)
        addMapping("OSBody", 0, 1, "OSBody")
        addMapping("OSBody", 1, 1, bold_name)
        return {"regular": "OSBody", "bold": bold_name, "path": regular,
                "embedded": True, "cjk": has_cjk}
    if path:
        raise ValueError(f"register_pdf_fonts could not load {path!r} as a TrueType font; "
                         "CFF-based .otf files are not supported by ReportLab")
    if cjk:
        raise RuntimeError(
            "register_pdf_fonts found no embeddable CJK TrueType font on this host. "
            "Pass path= to a .ttf/.ttc that covers the text (for example a Noto Sans SC "
            "TTF the user provides under inputs/); do not use unembedded CID fonts.")
    return {"regular": "Helvetica", "bold": "Helvetica-Bold", "path": None,
            "embedded": False, "cjk": False}


def render_pdf_pages(pdf_path, out_dir="pdf-pages", *, pages=None, max_long_edge=1568):
    """Rasterize PDF pages to PNG with pypdfium2 for visual QA via host.viewImage.

    pages         : 1-based page numbers; None renders every page.
    max_long_edge : output long edge in pixels (1568 matches host.viewImage).
    Returns the list of written PNG paths in page order. Existing PNGs with the
    same names in out_dir are replaced, so reuse one out_dir per document.
    """
    import pypdfium2 as pdfium
    if isinstance(max_long_edge, bool) or not isinstance(max_long_edge, int) or max_long_edge < 64:
        raise ValueError("render_pdf_pages max_long_edge must be an integer >= 64")
    os.makedirs(out_dir, exist_ok=True)
    document = pdfium.PdfDocument(pdf_path)
    try:
        count = len(document)
        numbers = list(range(1, count + 1)) if pages is None else list(pages)
        bad = [n for n in numbers if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= count]
        if bad:
            raise ValueError(f"render_pdf_pages pages must be 1..{count}; got {bad}")
        written = []
        for number in numbers:
            page = document[number - 1]
            try:
                width, height = page.get_size()
                bitmap = page.render(scale=max_long_edge / max(width, height))
                target = os.path.join(out_dir, f"page-{number:03d}.png")
                bitmap.to_pil().save(target)
                written.append(target)
            finally:
                page.close()
        return written
    finally:
        document.close()


def _page_fonts(page):
    resources = page.get("/Resources")
    fonts = resources.get_object().get("/Font") if resources else None
    found = []
    for ref in (fonts.get_object().values() if fonts else ()):
        font = ref.get_object()
        base = str(font.get("/BaseFont", "")).lstrip("/")
        descriptor = font.get("/FontDescriptor")
        if font.get("/Subtype") == "/Type0" and font.get("/DescendantFonts"):
            descriptor = font["/DescendantFonts"][0].get_object().get("/FontDescriptor")
        descriptor = descriptor.get_object() if descriptor else {}
        embedded = any(key in descriptor for key in ("/FontFile", "/FontFile2", "/FontFile3"))
        found.append((base, embedded or font.get("/Subtype") == "/Type3"))
    return found


def inspect_pdf(pdf_path, *, text_chars=200):
    """Summarize a PDF for QA or triage: pages, sizes, text layer, fonts, forms.

    Returns a dict with page count, metadata, encryption, outline size, form
    field count, per-page size/rotation/text preview, `likely_scanned` (no text
    layer on any page) and `unembedded_fonts` (non-base-14 fonts without an
    embedded program, which viewers will substitute).
    """
    from pypdf import PdfReader
    reader = PdfReader(pdf_path)
    encrypted = reader.is_encrypted
    if encrypted and not reader.decrypt(""):
        return {"pages": None, "encrypted": True, "readable": False}
    pages, unembedded = [], set()
    for number, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        box = page.mediabox
        pages.append({"page": number, "width_pt": round(float(box.width), 2),
                      "height_pt": round(float(box.height), 2), "rotation": page.rotation,
                      "text_chars": len(text), "text_preview": text[:text_chars]})
        for base, embedded in _page_fonts(page):
            if not embedded and base.split("+")[-1] not in _BASE14:
                unembedded.add(base)
    metadata = {str(k).lstrip("/"): str(v) for k, v in (reader.metadata or {}).items()}
    return {"pages": len(pages), "encrypted": encrypted, "readable": True, "metadata": metadata,
            "outline_items": len(reader.outline), "form_fields": len(reader.get_fields() or {}),
            "likely_scanned": bool(pages) and all(p["text_chars"] == 0 for p in pages),
            "unembedded_fonts": sorted(unembedded), "page_details": pages}


def _field_id(annotation):
    parts = []
    while annotation:
        if annotation.get("/T"):
            parts.append(str(annotation["/T"]))
        parent = annotation.get("/Parent")
        annotation = parent.get_object() if parent else None
    return ".".join(reversed(parts)) or None


def _describe_field(field_id, field):
    kind = field.get("/FT")
    states = [s for s in field.get("/_States_", [])]
    if kind == "/Tx":
        return {"field_id": field_id, "type": "text"}
    if kind == "/Btn":
        on = [s for s in states if s != "/Off"]
        return {"field_id": field_id, "type": "checkbox",
                "checked_value": on[0] if on else "/Yes", "unchecked_value": "/Off"}
    if kind == "/Ch":
        options = [{"value": s[0], "text": s[1]} if isinstance(s, list) and len(s) == 2
                   else {"value": s, "text": s} for s in states]
        return {"field_id": field_id, "type": "choice", "choice_options": options}
    return {"field_id": field_id, "type": f"unknown ({kind})"}


def pdf_form_fields(pdf_path):
    """List fillable AcroForm fields with 1-based page, rect and allowed values.

    rect is [left, bottom, right, top] in PDF points (origin bottom-left).
    Checkboxes report checked/unchecked values; radio groups list each option's
    value and rect; choice fields list option values. Returns [] when the PDF has
    no fillable fields (use the annotation workflow in references/forms.md).
    """
    from pypdf import PdfReader
    reader = PdfReader(pdf_path)
    fields = reader.get_fields() or {}
    info, radios = {}, {}
    radio_names = {k for k, f in fields.items() if f.get("/Kids") and f.get("/FT") == "/Btn"}
    for field_id, field in fields.items():
        if not field.get("/Kids"):
            info[field_id] = _describe_field(field_id, field)
    for number, page in enumerate(reader.pages, start=1):
        for ref in page.get("/Annots", []) or []:
            annotation = ref.get_object()
            field_id = _field_id(annotation)
            rect = [round(float(v), 2) for v in annotation.get("/Rect", [])]
            if field_id in info:
                info[field_id].update(page=number, rect=rect)
            elif field_id in radio_names:
                try:
                    on = [str(v) for v in annotation["/AP"]["/N"] if v != "/Off"]
                except KeyError:
                    continue
                if len(on) == 1:
                    group = radios.setdefault(field_id, {"field_id": field_id, "type": "radio_group",
                                                         "page": number, "radio_options": []})
                    group["radio_options"].append({"value": on[0], "rect": rect})
    located = [f for f in info.values() if "page" in f] + list(radios.values())

    def position(field):
        rect = (field["radio_options"][0]["rect"] if "radio_options" in field else field.get("rect")) or [0, 0]
        return (field["page"], -rect[1], rect[0])
    return sorted(located, key=position)


def fill_pdf_form(input_pdf, values, output_pdf):
    """Fill AcroForm fields and write a new PDF. values maps field_id -> value.

    Every field_id and value is validated against pdf_form_fields first; all
    problems are reported together and nothing is written. Checkbox values must
    be the field's checked/unchecked value, radio and choice values one of the
    listed options. output_pdf must be a new path. Returns {"output", "filled"}.
    """
    from pypdf import PdfReader, PdfWriter
    from pypdf.constants import FieldDictionaryAttributes
    from pypdf.generic import DictionaryObject
    if not isinstance(values, dict) or not values:
        raise ValueError("fill_pdf_form values must be a non-empty {field_id: value} dict")
    if os.path.exists(output_pdf) or os.path.abspath(output_pdf) == os.path.abspath(input_pdf):
        raise FileExistsError(f"fill_pdf_form output must be a new file: {output_pdf}")
    known = {f["field_id"]: f for f in pdf_form_fields(input_pdf)}
    errors, by_page = [], {}
    for field_id, value in values.items():
        field = known.get(field_id)
        if field is None:
            errors.append(f"unknown field_id {field_id!r}")
            continue
        allowed = None
        if field["type"] == "checkbox":
            allowed = [field["checked_value"], field["unchecked_value"]]
        elif field["type"] == "radio_group":
            allowed = [o["value"] for o in field["radio_options"]]
        elif field["type"] == "choice":
            allowed = [o["value"] for o in field["choice_options"]]
        if allowed is not None and value not in allowed:
            errors.append(f"{field_id!r}: {value!r} not in {allowed}")
        by_page.setdefault(field["page"], {})[field_id] = value
    if errors:
        raise ValueError("fill_pdf_form rejected values: " + "; ".join(errors))
    # pypdf can return [export, display] pairs for /Opt; normalize them while filling only.
    original = DictionaryObject.get_inherited

    def get_inherited(self, key, default=None):
        result = original(self, key, default)
        if key == FieldDictionaryAttributes.Opt and isinstance(result, list) and all(
                isinstance(v, list) and len(v) == 2 for v in result):
            result = [v[0] for v in result]
        return result
    DictionaryObject.get_inherited = get_inherited
    try:
        writer = PdfWriter(clone_from=PdfReader(input_pdf))
        for page, page_values in by_page.items():
            writer.update_page_form_field_values(writer.pages[page - 1], page_values, auto_regenerate=False)
        writer.set_need_appearances_writer(True)
        with open(output_pdf, "xb") as handle:
            writer.write(handle)
    finally:
        DictionaryObject.get_inherited = original
    return {"output": output_pdf, "filled": len(values)}
