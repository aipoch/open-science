---
name: docx-generation
description: Use when creating a Word DOCX report from Markdown, converting Markdown tables and lists to DOCX, or choosing a workflow for editing an existing DOCX while preserving its structure and styles. Includes a reusable Pandoc reference document and a Python conversion script.
license: Apache-2.0
---

# DOCX generation and editing

Choose a workflow that preserves the user's requested content, structure, and presentation. User requirements take precedence over defaults. Keep tables, headings, and lists as native document structures.

## Markdown to a new DOCX

For ordinary reports, use the bundled converter with an existing Pandoc 3.12.1 executable and Python 3.9 or newer. It uses a versioned reference document, separates ordinary table paragraphs from the Compact style shared by lists, and records converter/template provenance inside the DOCX. It does not install software.

Run through the session's approved Notebook or shell execution tools, using the actual directory of this loaded skill and an approved intermediate output directory:

```text
python "<skill-directory>/scripts/convert.py" "<source.md>" "<output.docx>"
```

Optional arguments:

- `--reference-doc "<template.docx>"`: use the user's template. Its styles and page settings take precedence; the bundled TableBody normalization is not applied.
- `--from gfm` or `--from markdown+pipe_tables`: select the dialect that matches the source. The default is Pandoc Markdown.
- `--pandoc "<absolute-executable-path>"`: select an existing executable.

The bundled reference uses A4 and a restrained table header style. It preserves theme-based fonts; CJK font choice should come from the user's reference and fonts available on the intended viewing system. A reference document's body content is not copied into the output. Use another workflow when the task requires filling a template's existing content.

Do not substitute the bundled template when the user supplied a template or requested a different design. For special page layouts or table widths, use an appropriate reference or targeted document editing; do not impose fixed page/column dimensions on every document.

The converter emits one JSON receipt with the output path, MIME type, versions, and template hash. It requires a new output filename and leaves existing files intact. If the supported Pandoc version is unavailable, report the missing prerequisite or use another suitable document-generation workflow under the session's normal environment rules. This skill does not require Pandoc for every DOCX task.

## Editing existing DOCX files

Modify the existing package with an appropriate document library or narrowly scoped OOXML edits. Preserve unrelated styles, numbering, relationships, sections, and embedded objects. Avoid rebuilding a richly formatted source through Markdown when the task requires preserving its layout. For complex tables and precise forms, choose a library suited to that structure; library choice alone does not guarantee style preservation.

## Artifact delivery

Pass the generated file's local path and MIME type to `write_artifact_file`. When Notebook or shell execution produced it, include the exact execution `runId` as `producerRunId`. The converter receipt is not an Artifact receipt; claim availability only after the Artifact tool succeeds.
