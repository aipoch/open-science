# Patch notes: docx-preview 0.4.0 local workaround

<!-- UPSTREAM-PATCH: docx-preview; version=0.4.0; patch=docx-preview+0.4.0.patch -->

Describes [`docx-preview+0.4.0.patch`](./docx-preview+0.4.0.patch), a temporary local
replacement for upstream table-border fixes unavailable in the pinned release.
`patch-package` applies it to both ESM and CommonJS exports during `postinstall`.

## Scope and upstream status

- **Inner/outer borders:** local fix for open [issue #221](https://github.com/VolodymyrBaydalka/docxjs/issues/221).
  Related [PR #235](https://github.com/VolodymyrBaydalka/docxjs/pull/235) remains unmerged
  (checked 2026-10-21). This patch is not a verbatim backport.
- **Style inheritance:** resolves base styles before children, preserving borders
  regardless of XML order. No upstream proposal is tracked for this part; it is
  not a confirmed roadmap item.
- Preserves explicit cell overrides, including `nil` / `none`, and merged-cell borders.
  Full OOXML border-conflict rules remain out of scope.
- **Conditional styles:** scopes default table rules to their actual cell/paragraph/run
  targets; supports `wholeTable`, first/last rows and columns, bands, and corners.
  Resolves conditional overrides independently of XML order: whole table, row
  bands, column bands, first/last columns, first/last rows, then corners. Region
  selectors have equal specificity; explicit paragraph and character styles
  override table defaults, and direct formatting retains precedence.
  Explicit `tblLook` flags override the legacy bitmask, including false. Missing
  region hints are derived from the grid; explicit `cnfStyle` flags are preserved.
  Table-style band sizes inherit from base styles. Missing sizes default to one;
  an explicit zero disables only that band direction, including region hints.
  Child paths isolate nested tables.
  This is a local fix, not an upstream backport or a claim of complete Word layout parity.

## Retirement

`TODO(upstream):` when a released version covers these fixes, test it **without**
this patch: run `docx-table-borders.test.ts`, `office-renderers.test.ts`, and the
browser specs `docx-table-borders.spec.ts`, `docx-table-styles.spec.ts`, and
`docx-numbering.spec.ts`, plus `docx-table-styles.test.ts`. Verify both
exports, screenshots and a clean install under the task isolation rules in `AGENTS.md`.
Remove the patch and this note only when those checks pass; retain the regressions.
If upstream fixes only part, reduce the patch and update this note. Do not blindly
reapply it after an upgrade.
