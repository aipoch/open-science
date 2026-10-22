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
  Full OOXML border-conflict rules and conditional-style priority remain out of scope.

## Retirement

`TODO(upstream):` when a released version covers these fixes, test it **without**
this patch: run `docx-table-borders.test.ts`, `office-renderers.test.ts`, and the
browser specs `docx-table-borders.spec.ts` / `docx-numbering.spec.ts`. Verify both
exports, screenshots and a clean install under the task isolation rules in `AGENTS.md`.
Remove the patch and this note only when those checks pass; retain the regressions.
If upstream fixes only part, reduce the patch and update this note. Do not blindly
reapply it after an upgrade.
