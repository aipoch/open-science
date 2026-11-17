# PDF generation and processing skill

On-demand skill for creating PDFs with ReportLab and processing existing PDFs
with pypdf, pdfplumber, and pypdfium2 inside the Open Science Notebook.

## Execution boundary

The Notebook and shell cannot necessarily read this skill directory. Code that
the model needs at run time is in `kernel.py`, registered in `open-science.json`
and injected with `kernelSkillIds: ["pdf-generation"]`. The helpers import their
third-party packages lazily, so injection succeeds before the packages are
installed; a call reports the missing module through the normal recovery flow,
and the model installs packages with `manage_packages`. No command-line PDF tool,
Office engine, or font is bundled.

## Helpers

- `register_pdf_fonts`: registers an embeddable TrueType family. CJK lookup covers
  macOS (STHeiti, Songti, Arial Unicode), Windows (Microsoft YaHei, SimHei,
  SimSun), and common Linux packages (WenQuanYi, Droid Sans Fallback). CFF-based
  fonts such as Hiragino and most `.otf` files are skipped because ReportLab cannot
  embed them. The non-CJK default is matplotlib's DejaVu Sans.
- `render_pdf_pages`: pypdfium2 rendering sized for `host.viewImage` (1568 px).
- `inspect_pdf`: text-layer, font-embedding, outline, and form summary.
- `pdf_form_fields`, `fill_pdf_form`: AcroForm listing and validated filling.

## Attribution

The workflow and form-filling procedure are adapted from the `pdf` skill in
[anthropics/skills](https://github.com/anthropics/skills) (Apache-2.0). Changes:
Open Science execution and Artifact delivery, removal of CLI tools that are not
bundled, embedded-font handling, helper functions in place of scripts.

## Validation

```sh
python3 -m unittest discover -s test/pdf-generation -v
npx vitest run src/main/skills/pdf-generation.test.ts
```

The Python suite skips when ReportLab, pypdf, pdfplumber, or pypdfium2 are not
installed in the test interpreter; set `OPEN_SCIENCE_TEST_PYTHON` to an
interpreter that has them for a full run.
