---
name: pdf-extract
description: Extract PDF selectable text and full-page or segmented page images (including tables) into Markdown with per-page headings and image links; use when you need both readable text and page visuals for PPT creation, review, or analysis.
license: MIT
author: AIPOCH
---
> **Source**: [https://github.com/aipoch/medical-research-skills](https://github.com/aipoch/medical-research-skills)

## Validation Shortcut

Run this minimal command first to verify the supported execution path:

```bash
python scripts/extract_pdf.py --help
```

## When to Use

- Converting a PDF report/paper into Markdown while preserving page structure (`## Page XX`) for easy navigation.
- Preparing PPT or design materials where you need both extracted text and page screenshots/blocks (tables, figures, diagrams).
- Reviewing scanned or mixed PDFs and filtering out "text-only" screenshots to keep only meaningful visuals.
- Building a dataset for downstream analysis where each page's text and images must be linked and traceable.
- Creating a lightweight "PDF-to-Markdown" archive with per-page headings and image references.

## Key Features

- Extracts selectable PDF text and normalizes paragraphs (collapses line breaks into readable paragraphs).
- Writes Markdown with a document title and per-page sections (`# <filename>`, `## Page XX`).
- Supports multiple image extraction modes:
  - **segment** (default): renders segmented page blocks (useful for tables/figures).
  - **embedded**: extracts embedded images from the PDF.
  - **page**: renders full pages as images.
- Optional post-filters to reduce noisy images:
  - Filter text-heavy images via OCR (`--filter-text`).
  - Drop images that match extracted page text (likely screenshots of text) (`--filter-match`).
  - Drop images overlapping PDF text blocks without OCR (`--filter-pdf-text`).
- Produces stable, per-page image links in Markdown for easy referencing.

## Dependencies

- `pdfplumber` (version not specified)
- `pymupdf` (version not specified)
- `pytesseract` (version not specified; required only when `--filter-text on` or `--filter-match on`)

## Example Usage

```bash
python scripts/extract_pdf.py \
  --input input.pdf \
  --output output.md \
  --image-dir images \
  --image-mode segment \
  --filter-text on \
  --text-threshold 0.25 \
  --text-lang eng \
  --filter-match on \
  --match-lang eng \
  --match-min-len 30 \
  --filter-pdf-text on \
  --pdf-text-threshold 0.1
```

Expected Markdown structure:

- Document title: `# <filename>`
- Per-page section: `## Page XX`
- Text paragraphs (normalized)
- Image links, depending on mode:
  - Segmented blocks: `![page-XX](images/page-XX-block-YY.png)` with `--image-mode segment`
  - Embedded images: `![page-XX](images/page-XX-img-YY.png)` with `--image-mode embedded`
  - Full page render: `![page-XX](images/page-XX.png)` with `--image-mode page`

## Implementation Details

- **Text extraction and normalization**
  - Extracts selectable text from the PDF and collapses line breaks to form coherent paragraphs.
  - Headings are inferred using font-size heuristics (larger font sizes are treated as heading markers).

- **Image extraction modes**
  - `segment` (default): renders page segments/blocks to capture localized content (tables/figures) rather than entire pages.
  - `embedded`: extracts images embedded in the PDF content stream.
  - `page`: renders each full page as a single image (not recommended if you need cropped screenshots/blocks).

- **Filtering options**
  - `--filter-text on`: runs OCR on extracted images and removes images whose OCR text density exceeds `--text-threshold` (e.g., `0.25`).
  - `--filter-match on`: removes images whose OCR text substantially matches the page's extracted text; controlled by `--match-min-len` and language via `--match-lang`.
  - `--filter-pdf-text on`: removes images that overlap PDF text blocks using PDF layout information (no OCR); controlled by `--pdf-text-threshold` (e.g., `0.1`).

- **Output writing**
  - Writes a single Markdown file with `## Page XX` sections and image links pointing to files saved under `--image-dir`.

## When Not to Use

- Do not use this skill when the required source data, identifiers, files, or credentials are missing.
- Do not use this skill when the user asks for fabricated results, unsupported claims, or out-of-scope conclusions.
- Do not use this skill when a simpler direct answer is more appropriate than the documented workflow.

## Required Inputs

- A clearly specified task goal aligned with the documented scope.
- All required files, identifiers, parameters, or environment variables before execution.
- Any domain constraints, formatting requirements, and expected output destination if applicable.

## Recommended Workflow

1. Validate the request against the skill boundary and confirm all required inputs are present.
2. Select the documented execution path and prefer the simplest supported command or procedure.
3. Produce the expected output using the documented file format, schema, or narrative structure.
4. Run a final validation pass for completeness, consistency, and safety before returning the result.

## Output Contract

- Return a structured deliverable that is directly usable without reformatting.
- If a file is produced, prefer a deterministic output name such as `pdf_extract_result.md` unless the skill documentation defines a better convention.
- Include a short validation summary describing what was checked, what assumptions were made, and any remaining limitations.

## Validation and Safety Rules

- Validate required inputs before execution and stop early when mandatory fields or files are missing.
- Do not fabricate measurements, references, findings, or conclusions that are not supported by the provided source material.
- Emit a clear warning when credentials, privacy constraints, safety boundaries, or unsupported requests affect the result.
- Keep the output safe, reproducible, and within the documented scope at all times.

## Failure Handling

- If validation fails, explain the exact missing field, file, or parameter and show the minimum fix required.
- If an external dependency or script fails, surface the command path, likely cause, and the next recovery step.
- If partial output is returned, label it clearly and identify which checks could not be completed.

## Quick Validation

Run this minimal verification path before full execution when possible:

```bash
python scripts/extract_pdf.py --help
```

Expected output format:

```text
Result file: pdf_extract_result.md
Validation summary: PASS/FAIL with brief notes
Assumptions: explicit list if any
```

## Deterministic Output Rules

- Use the same section order for every supported request of this skill.
- Keep output field names stable and do not rename documented keys across examples.
- If a value is unavailable, emit an explicit placeholder instead of omitting the field.

## Completion Checklist

- Confirm all required inputs were present and valid.
- Confirm the supported execution path completed without unresolved errors.
- Confirm the final deliverable matches the documented format exactly.
- Confirm assumptions, limitations, and warnings are surfaced explicitly.
