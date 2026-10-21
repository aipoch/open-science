# docx-preview compatibility patch

<!-- UPSTREAM-PATCH: docx-preview; version=0.4.0; patch=docx-preview+0.4.0.patch -->

The patch restores table borders when a multi-level style chain is declared child-first,
and distinguishes outer borders from `insideH` / `insideV`. It applies to both package
exports (`dist/docx-preview.mjs` and `dist/docx-preview.js`). The existing
`postinstall` command applies it through `patch-package --error-on-fail`.

## Upstream tracking

- Repository: <https://github.com/VolodymyrBaydalka/docxjs>
- Inner-border defect: <https://github.com/VolodymyrBaydalka/docxjs/issues/221>
- Related, unmerged candidate: <https://github.com/VolodymyrBaydalka/docxjs/pull/235>
- Style inheritance: `HtmlRenderer.processStyles` in 0.4.0 merges bases in file
  order. Our `child first` fixture loses all borders while the equivalent
  `parent first` fixture succeeds. No upstream issue/PR is claimed for this part.

This is a local fix, not a verbatim backport of #235. It retains table borders from
named/inherited styles, merges per-edge overrides, and assigns borders to detached
cells after `rowSpan` / `colSpan` have been resolved. Explicit cell borders,
including `nil` / `none`, remain authoritative. The style traversal is iterative,
handles missing bases and cycles, and matches conditional-style targets separately.

## Instructions for the periodic dependency-review agent

`TODO(upstream):` check releases and both fixes above. A merged PR or a higher
package version alone is **not** enough to remove this patch.

1. In an isolated checkout/install, update `docx-preview` to a released version
   containing the corresponding upstream fixes. Temporarily omit this patch.
2. Run the real dependency regressions:
   `npx vitest run src/renderer/src/pages/workspace/previews/docx-table-borders.test.ts`
   and the connected preview tests in `office-renderers.test.ts`.
3. Run the production browser fixtures:
   `npx playwright test --config e2e/playwright.browser.config.ts e2e/browser/docx-table-borders.spec.ts e2e/browser/docx-numbering.spec.ts`.
   Follow AGENTS.md's task-local environment isolation for outputs, profiles and logs.
4. Check both ESM and CommonJS exports and inspect the browser screenshots.
   Retain the regression fixtures/tests after upgrading.
5. If the unpatched release passes all regressions, remove this patch and this
   note in the dependency-upgrade change. If only one defect is fixed, reduce the
   patch to the remaining defect and update its version, links and explanation.
   Verify clean installation and repeated application of the remaining patch.

Do not automatically apply/rebase an old patch onto changed upstream internals.
Review the upstream implementation and record the replacement release/commit in
the upgrade description. These notes support an existing scanner; they do not
create a scheduled job.

## Validation scope and remaining upstream work

The retained fixtures exercise direct and inherited borders, partial overrides,
distinct inner/outer colors, horizontal/vertical merges, borderless tables and
explicitly disabled cell borders. Browser tests use the actual Office preview,
application CSS, fit/zoom controls and viewport resizing. The original reported
`clinical_application.docx` is unavailable; synthetic fixtures cannot establish
which defect that particular file contains.

This patch does not claim complete OOXML table fidelity. Full conditional-style
priority, irregular grids, bidirectional `start`/`end` semantics and the complete
OOXML border-conflict algorithm still need independent Word reference cases.
`wholeTable` and implicit default-style changes from the investigation are
deliberately excluded because the reference renderers did not establish a shared
expected result. Do not combine those changes with removal of this patch without
separate fixtures and evidence.
