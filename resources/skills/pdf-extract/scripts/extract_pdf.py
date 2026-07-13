# -*- coding: utf-8 -*-
"""Extract PDF text and render each page to a full image."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def _normalize_text(text: str) -> str:
    lines = [line.rstrip() for line in text.splitlines()]
    paragraphs = []
    buf = []
    for line in lines:
        if not line.strip():
            if buf:
                paragraphs.append(" ".join(buf).strip())
                buf = []
            continue
        buf.append(line.strip())
    if buf:
        paragraphs.append(" ".join(buf).strip())
    return "\n\n".join(paragraphs)


def _extract_text_pdfplumber(pdf_path: Path) -> list[str]:
    import pdfplumber

    page_texts = []
    with pdfplumber.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            text = page.extract_text(x_tolerance=2.0, y_tolerance=3.0) or ""
            page_texts.append(text.strip())
    return page_texts


def _render_pages_fitz(pdf_path: Path, image_dir: Path, dpi: int) -> list[list[tuple[str, int, tuple[int, int, int, int] | None]]]:
    import fitz

    image_dir.mkdir(parents=True, exist_ok=True)
    image_paths = []
    scale = dpi / 72.0
    matrix = fitz.Matrix(scale, scale)
    doc = fitz.open(str(pdf_path))
    try:
        for page_index in range(len(doc)):
            page = doc[page_index]
            pix = page.get_pixmap(matrix=matrix, alpha=False)
            name = f"page-{page_index + 1:02d}.png"
            out_path = image_dir / name
            pix.save(str(out_path))
            image_paths.append([(out_path.as_posix(), 0, None)])
    finally:
        doc.close()
    return image_paths


def _segment_indices(content_flags: list[bool], min_gap: int) -> list[tuple[int, int]]:
    segments = []
    start = None
    last = None
    gap = 0
    for idx, has_content in enumerate(content_flags):
        if has_content:
            if start is None:
                start = idx
            last = idx
            gap = 0
        else:
            if start is not None:
                gap += 1
                if gap >= min_gap:
                    segments.append((start, last))
                    start = None
                    last = None
                    gap = 0
    if start is not None:
        segments.append((start, last))
    return segments


def _segment_page_image(
    image,
    scale: float,
    threshold: int,
    row_gap: int,
    col_gap: int,
    min_area_ratio: float,
    min_width_ratio: float,
    min_height_ratio: float,
    pad: int,
) -> list[tuple[int, int, int, int]]:
    from PIL import Image

    width, height = image.size
    seg_w = max(1, int(width * scale))
    seg_h = max(1, int(height * scale))
    seg = image.resize((seg_w, seg_h), Image.BILINEAR).convert("L")
    pixels = seg.load()

    row_flags = []
    sample_stride = 2
    min_row_fraction = 0.02
    for y in range(seg_h):
        dark = 0
        total = 0
        for x in range(0, seg_w, sample_stride):
            total += 1
            if pixels[x, y] < threshold:
                dark += 1
        row_flags.append(total > 0 and (dark / total) >= min_row_fraction)

    row_segments = _segment_indices(row_flags, max(1, row_gap))
    if not row_segments:
        return []

    boxes = []
    for row_start, row_end in row_segments:
        col_flags = []
        min_col_fraction = 0.02
        for x in range(seg_w):
            dark = 0
            total = 0
            for y in range(row_start, row_end + 1, sample_stride):
                total += 1
                if pixels[x, y] < threshold:
                    dark += 1
            col_flags.append(total > 0 and (dark / total) >= min_col_fraction)

        col_segments = _segment_indices(col_flags, max(1, col_gap))
        for col_start, col_end in col_segments:
            x0 = int(col_start / scale)
            x1 = int((col_end + 1) / scale)
            y0 = int(row_start / scale)
            y1 = int((row_end + 1) / scale)

            x0 = max(0, x0 - pad)
            y0 = max(0, y0 - pad)
            x1 = min(width, x1 + pad)
            y1 = min(height, y1 + pad)

            box_w = x1 - x0
            box_h = y1 - y0
            if box_w <= 0 or box_h <= 0:
                continue

            if box_w < width * min_width_ratio:
                continue
            if box_h < height * min_height_ratio:
                continue
            if (box_w * box_h) < (width * height * min_area_ratio):
                continue

            boxes.append((x0, y0, x1, y1))

    return boxes


def _segment_pages_fitz(
    pdf_path: Path,
    image_dir: Path,
    dpi: int,
    scale: float,
    threshold: int,
    row_gap: int,
    col_gap: int,
    min_area_ratio: float,
    min_width_ratio: float,
    min_height_ratio: float,
    pad: int,
) -> list[list[tuple[str, int, tuple[int, int, int, int] | None]]]:
    import fitz
    from PIL import Image

    image_dir.mkdir(parents=True, exist_ok=True)
    image_paths = []
    matrix = fitz.Matrix(dpi / 72.0, dpi / 72.0)
    doc = fitz.open(str(pdf_path))
    try:
        for page_index in range(len(doc)):
            page = doc[page_index]
            pix = page.get_pixmap(matrix=matrix, alpha=False)
            image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            boxes = _segment_page_image(
                image,
                scale=scale,
                threshold=threshold,
                row_gap=row_gap,
                col_gap=col_gap,
                min_area_ratio=min_area_ratio,
                min_width_ratio=min_width_ratio,
                min_height_ratio=min_height_ratio,
                pad=pad,
            )
            page_paths: list[tuple[str, int, tuple[int, int, int, int] | None]] = []
            if not boxes:
                name = f"page-{page_index + 1:02d}.png"
                out_path = image_dir / name
                image.save(str(out_path))
                page_paths.append((out_path.as_posix(), 0, None))
            else:
                for block_index, box in enumerate(boxes, start=1):
                    name = f"page-{page_index + 1:02d}-block-{block_index:02d}.png"
                    out_path = image_dir / name
                    image.crop(box).save(str(out_path))
                    page_paths.append((out_path.as_posix(), box[1], box))
            image_paths.append(page_paths)
    finally:
        doc.close()
    return image_paths


def _extract_images_fitz(pdf_path: Path, image_dir: Path) -> list[list[tuple[str, int, tuple[int, int, int, int] | None]]]:
    import fitz

    image_dir.mkdir(parents=True, exist_ok=True)
    image_paths = []
    doc = fitz.open(str(pdf_path))
    try:
        for page_index in range(len(doc)):
            page = doc[page_index]
            images = page.get_images(full=True)
            page_paths: list[tuple[str, int, tuple[int, int, int, int] | None]] = []
            for img_index, img in enumerate(images, start=1):
                xref = img[0]
                base = doc.extract_image(xref)
                ext = base.get("ext", "png")
                name = f"page-{page_index + 1:02d}-img-{img_index:02d}.{ext}"
                out_path = image_dir / name
                out_path.write_bytes(base["image"])
                page_paths.append((out_path.as_posix(), 0, None))
            image_paths.append(page_paths)
    finally:
        doc.close()
    return image_paths


def _build_markdown(
    title: str,
    page_texts: list[str],
    image_paths: list[list[tuple[str, int, tuple[int, int, int, int] | None]]],
) -> str:
    md_lines = [f"# {title}", ""]
    for idx, raw_text in enumerate(page_texts, start=1):
        md_lines.append(f"## Page {idx:02d}")
        md_lines.append("")
        has_headings = raw_text.lstrip().startswith("#")
        normalized = raw_text if has_headings else _normalize_text(raw_text)
        if normalized:
            md_lines.append(normalized)
            md_lines.append("")
        else:
            md_lines.append("_No text extracted._")
            md_lines.append("")
        if idx - 1 < len(image_paths):
            for img_path, _y, _box in image_paths[idx - 1]:
                md_lines.append(f"![page-{idx:02d}]({img_path})")
            if image_paths[idx - 1]:
                md_lines.append("")
    return "\n".join(md_lines).strip() + "\n"


def _text_area_ratio(image, lang: str) -> float:
    from pytesseract import image_to_data, Output

    data = image_to_data(image, output_type=Output.DICT, lang=lang)
    area = 0
    for i in range(len(data["text"])):
        text = data["text"][i].strip()
        if not text:
            continue
        try:
            conf = int(float(data["conf"][i]))
        except Exception:
            conf = -1
        if conf < 30:
            continue
        area += data["width"][i] * data["height"][i]
    if image.width <= 0 or image.height <= 0:
        return 0.0
    return area / float(image.width * image.height)


def _filter_text_heavy_images(
    image_paths: list[list[tuple[str, int, tuple[int, int, int, int] | None]]],
    threshold: float,
    lang: str,
) -> list[list[tuple[str, int, tuple[int, int, int, int] | None]]]:
    try:
        from PIL import Image
    except Exception:
        print("Warning: PIL not available, skip text filtering.")
        return image_paths

    try:
        import pytesseract  # noqa: F401
    except Exception:
        print("Warning: pytesseract not available, skip text filtering.")
        return image_paths

    filtered = []
    for page_paths in image_paths:
        kept = []
        ordered = sorted(page_paths, key=lambda item: item[1])
        for path_str, y_pos, box in ordered:
            path = Path(path_str)
            try:
                with Image.open(path) as image:
                    ratio = _text_area_ratio(image, lang)
                if ratio <= threshold:
                    kept.append((path_str, y_pos, box))
                else:
                    try:
                        path.unlink()
                    except Exception:
                        pass
            except Exception:
                kept.append((path_str, y_pos, box))
        filtered.append(kept)
    return filtered


def _split_sentences(text: str) -> list[str]:
    import re

    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []
    delimiters = ".!?;\u3002\uff01\uff1f\uff1b"
    normalized = text.translate({ord(ch): "." for ch in delimiters})
    parts = [p.strip() for p in normalized.split(".")]
    return [p for p in parts if len(p) >= 20]


def _filter_images_by_text_match(
    image_paths: list[list[tuple[str, int, tuple[int, int, int, int] | None]]],
    page_texts: list[str],
    lang: str,
    min_match_len: int,
) -> list[list[tuple[str, int, tuple[int, int, int, int] | None]]]:
    try:
        from PIL import Image
    except Exception:
        print("Warning: PIL not available, skip match filtering.")
        return image_paths

    try:
        import pytesseract  # noqa: F401
    except Exception:
        print("Warning: pytesseract not available, skip match filtering.")
        return image_paths

    filtered = []
    for page_index, page_paths in enumerate(image_paths):
        text = page_texts[page_index] if page_index < len(page_texts) else ""
        sentences = _split_sentences(text)
        kept = []
        ordered = sorted(page_paths, key=lambda item: item[1])
        for path_str, y_pos, box in ordered:
            path = Path(path_str)
            try:
                with Image.open(path) as image:
                    ocr_text = pytesseract.image_to_string(image, lang=lang)
            except Exception:
                kept.append((path_str, y_pos, box))
                continue

            normalized = " ".join(ocr_text.split())
            matched = False
            for sent in sentences:
                if len(sent) < min_match_len:
                    continue
                if sent in normalized:
                    matched = True
                    break
            if matched:
                try:
                    path.unlink()
                except Exception:
                    pass
            else:
                kept.append((path_str, y_pos, box))
        filtered.append(kept)
    return filtered


def _filter_images_by_pdf_text(
    pdf_path: Path,
    image_paths: list[list[tuple[str, int, tuple[int, int, int, int] | None]]],
    dpi: int,
    threshold: float,
) -> list[list[tuple[str, int, tuple[int, int, int, int] | None]]]:
    import pdfplumber

    scale = dpi / 72.0
    filtered: list[list[tuple[str, int, tuple[int, int, int, int] | None]]] = []
    with pdfplumber.open(str(pdf_path)) as pdf:
        for page_index, page in enumerate(pdf.pages):
            words = page.extract_words() or []
            word_boxes = []
            for w in words:
                x0 = int(w.get("x0", 0) * scale)
                x1 = int(w.get("x1", 0) * scale)
                top = int(w.get("top", 0) * scale)
                bottom = int(w.get("bottom", 0) * scale)
                if x1 > x0 and bottom > top:
                    word_boxes.append((x0, top, x1, bottom))

            page_paths = image_paths[page_index] if page_index < len(image_paths) else []
            kept: list[tuple[str, int, tuple[int, int, int, int] | None]] = []
            for path_str, y_pos, box in page_paths:
                if box is None:
                    kept.append((path_str, y_pos, box))
                    continue

                x0, y0, x1, y1 = box
                img_area = max(1, (x1 - x0) * (y1 - y0))
                text_area = 0
                for wx0, wy0, wx1, wy1 in word_boxes:
                    ix0 = max(x0, wx0)
                    iy0 = max(y0, wy0)
                    ix1 = min(x1, wx1)
                    iy1 = min(y1, wy1)
                    if ix1 > ix0 and iy1 > iy0:
                        text_area += (ix1 - ix0) * (iy1 - iy0)

                if (text_area / img_area) > threshold:
                    try:
                        Path(path_str).unlink()
                    except Exception:
                        pass
                else:
                    kept.append((path_str, y_pos, box))
            filtered.append(kept)
    return filtered


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract PDF text and page images (including tables)."
    )
    parser.add_argument("--input", "-i", required=True, help="Path to input PDF.")
    parser.add_argument("--output", "-o", required=True, help="Path to output MD.")
    parser.add_argument("--image-dir", default="images", help="Output image directory.")
    parser.add_argument(
        "--image-mode",
        choices=("page", "embedded", "segment"),
        default="segment",
        help="Image mode: render pages, extract embedded images, or segment page images.",
    )
    parser.add_argument("--dpi", type=int, default=200, help="Render DPI (default: 200).")
    parser.add_argument("--segment-scale", type=float, default=0.25, help="Segmentation scale.")
    parser.add_argument("--segment-threshold", type=int, default=245, help="Segmentation threshold.")
    parser.add_argument("--segment-row-gap", type=int, default=5, help="Row gap for segmentation.")
    parser.add_argument("--segment-col-gap", type=int, default=5, help="Column gap for segmentation.")
    parser.add_argument("--segment-min-area", type=float, default=0.03, help="Min area ratio.")
    parser.add_argument("--segment-min-width", type=float, default=0.2, help="Min width ratio.")
    parser.add_argument("--segment-min-height", type=float, default=0.1, help="Min height ratio.")
    parser.add_argument("--segment-pad", type=int, default=10, help="Padding in pixels.")
    parser.add_argument(
        "--filter-text",
        choices=("on", "off"),
        default="off",
        help="Filter images with high text ratio.",
    )
    parser.add_argument(
        "--text-threshold",
        type=float,
        default=0.25,
        help="Text area ratio threshold for filtering.",
    )
    parser.add_argument(
        "--text-lang",
        default="eng",
        help="OCR language for text filtering.",
    )
    parser.add_argument(
        "--filter-match",
        choices=("on", "off"),
        default="off",
        help="Drop images whose OCR text matches page text.",
    )
    parser.add_argument(
        "--match-lang",
        default="eng",
        help="OCR language for match filtering.",
    )
    parser.add_argument(
        "--match-min-len",
        type=int,
        default=30,
        help="Minimum sentence length for match filtering.",
    )
    parser.add_argument(
        "--filter-pdf-text",
        choices=("on", "off"),
        default="off",
        help="Drop images whose area overlaps PDF text blocks.",
    )
    parser.add_argument(
        "--pdf-text-threshold",
        type=float,
        default=0.1,
        help="Text area ratio threshold for PDF text filtering.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    pdf_path = Path(args.input)
    output_path = Path(args.output)
    image_dir = output_path.parent / args.image_dir

    if not pdf_path.exists():
        print(f"Input PDF not found: {pdf_path}", file=sys.stderr)
        return 1

    try:
        page_texts = _extract_text_pdfplumber(pdf_path)
    except Exception as exc:
        print(f"Failed to extract text with pdfplumber: {exc}", file=sys.stderr)
        return 1

    try:
        if args.image_mode == "embedded":
            image_paths = _extract_images_fitz(pdf_path, image_dir)
        elif args.image_mode == "segment":
            image_paths = _segment_pages_fitz(
                pdf_path,
                image_dir,
                args.dpi,
                args.segment_scale,
                args.segment_threshold,
                args.segment_row_gap,
                args.segment_col_gap,
                args.segment_min_area,
                args.segment_min_width,
                args.segment_min_height,
                args.segment_pad,
            )
        else:
            image_paths = _render_pages_fitz(pdf_path, image_dir, args.dpi)
    except Exception as exc:
        print(f"Failed to extract images: {exc}", file=sys.stderr)
        return 1

    if args.filter_text == "on":
        image_paths = _filter_text_heavy_images(
            image_paths,
            args.text_threshold,
            args.text_lang,
        )
    if args.filter_match == "on":
        image_paths = _filter_images_by_text_match(
            image_paths,
            page_texts,
            args.match_lang,
            args.match_min_len,
        )
    if args.filter_pdf_text == "on":
        image_paths = _filter_images_by_pdf_text(
            pdf_path,
            image_paths,
            args.dpi,
            args.pdf_text_threshold,
        )

    markdown = _build_markdown(pdf_path.stem, page_texts, image_paths)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(markdown, encoding="utf-8")
    print(f"Saved: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
