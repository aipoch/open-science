# Maintained DOCX report profile

This on-demand skill provides a reusable Markdown-to-DOCX path without changing
Artifact storage or prescribing a generator for other formats and editing tasks.

## Reproducibility

- Supported generator: Pandoc **3.12.1**; Python **3.9+**, standard library only.
- `assets/reference.docx`: profile `open-science-report-v1`, based on Pandoc's
  default reference. A4, theme-based fonts, native heading/list styles, modest
  header shading, and a separate 10.5 pt Table Body paragraph style.
- `scripts/build_reference.py`: maintainer-only reference builder. Run with the
  supported Pandoc version when deliberately changing this profile; ZIP entry
  timestamps are fixed. Review and test the new asset before publishing it.
- `scripts/convert.py`: preserves custom reference page/style settings; only the
  bundled profile remaps non-numbered Compact paragraphs directly within cells.
  It does not force column widths, fixed table layouts, or a font unavailable on
  the destination system. Custom reference bodies are not filled/copied.
- The output contains an `OpenScienceConversion` custom property with converter
  version, Pandoc version, source/reference hashes, profile and Markdown dialect.
  stdout contains a compact receipt, not source text. Publication never overwrites
  an existing destination. Intermediates are removed on failure.

Reference documents must be valid DOCX packages supported by Pandoc. Malformed
output XML is rejected before publication. Pandoc warnings (including missing
images) also stop publication and are returned as actionable errors. This is not a visual-layout guarantee.
For content-preserving edits to existing DOCX files use a suitable editing library;
a Markdown round trip can lose information. Theme fonts still require appropriate
fonts on the viewing host. No font installation or Office engine is bundled.

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
styles. Office-engine PDF preview is a separate optional future capability.

Sources: [Pandoc reference documents](https://pandoc.org/MANUAL.html#option--reference-doc),
[OOXML conditional table styles](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.tablestyleproperties).
