# Maintained DOCX report profile

This on-demand skill provides a reusable Markdown-to-DOCX path without changing
Artifact storage or prescribing a generator for other formats and editing tasks.

## Execution boundary

Loading a framework Skill does not grant Notebook or shell access to its directory.
The registered `prepare_docx_conversion` helper transports the fixed converter and
reference through the existing `kernelSkillIds` mechanism and writes them into a
fresh directory under the caller's authorized execution directory. No filesystem
permission expansion is needed. The model receives paths, not base64 file contents.

`kernel.py` is generated from `scripts/convert.py` and `assets/reference.docx` by
`python3 resources/skills/docx-generation/scripts/build_kernel.py`. Rebuild it after
changing either source asset; a regression rejects stale embedded assets. The
original CLI remains available for environments with direct package access.

## Reproducibility

- Supported generator: Pandoc **3.12.1**; Python **3.9+**, standard library only.
- `assets/reference.docx`: profile `open-science-report-v3`, based on Pandoc's
  default reference. A4 with 2 cm margins, 10.5 pt body text at approximately 1.33
  line spacing, coordinated paragraph/linked character heading styles (17/14/11.5 pt),
  and compact lists. Tables have a complete 0.5 pt gray grid, bold headers without
  shading, 9.5 pt Table Body text, and 3 pt vertical / 4 pt horizontal cell padding.
  Arial and PingFang SC are font preferences, not embedded fonts; missing faces
  are substituted by the viewer.
- `scripts/build_reference.py`: maintainer-only reference builder. Run with the
  supported Pandoc version when deliberately changing this profile; ZIP entry
  timestamps are fixed. Review and test the new asset before publishing it.
- `scripts/convert.py`: preserves custom reference page/style settings; only the
  bundled profile remaps non-numbered Compact paragraphs directly within cells
  and expands top-level automatic-width tables to the text area. Explicit table
  widths, nested tables, column proportions, and layout algorithms are retained. Custom reference bodies are not filled/copied.
- The output contains an `OpenScienceConversion` custom property with converter
  version, Pandoc version, source/reference hashes, profile and Markdown dialect.
  stdout contains a compact receipt, not source text. Publication never overwrites
  an existing destination. Intermediates are removed on failure.

Reference documents must be valid DOCX packages supported by Pandoc. Malformed
output XML is rejected before publication. Pandoc warnings (including missing
images) also stop publication and are returned as actionable errors. This is not a visual-layout guarantee.
For content-preserving edits to existing DOCX files use a suitable editing library;
a Markdown round trip can lose information. The reference still requires appropriate fonts on the viewing host. No font installation or Office engine is bundled.

## Validation

```sh
python3 -m unittest discover -s test/docx-generation -v
npx vitest run src/main/skills/docx-generation.test.ts
npx vitest run src/renderer/src/pages/workspace/previews/docx-table-styles.test.ts
npx playwright test --config e2e/playwright.browser.config.ts e2e/browser/docx-table-styles.spec.ts
```

Python tests cover real Pandoc conversion when the supported executable is
available; absence is reported as skipped, not a successful integration run.
Browser tests cover the production preview, including zoom/resize and nested
styles. Semantic/style assertions run on every OS; the reviewed pixel baseline
uses macOS fonts and runs only on macOS. Other platforms capture screenshots
without comparing them to the macOS font layout. Office-engine PDF preview is a
separate optional future capability.

The registered-helper test executes through the Notebook kernel. On macOS, a real
`sandbox-exec` regression denies reads of the original skill directory while
preparing and converting a report with the injected helper. This bounded profile
reproduces resource denial; it is not a full desktop-session E2E run.

Sources: [Pandoc reference documents](https://pandoc.org/MANUAL.html#option--reference-doc),
[OOXML conditional table styles](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.tablestyleproperties).
