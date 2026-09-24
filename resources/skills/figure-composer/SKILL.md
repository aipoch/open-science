---
name: figure-composer
description: 'Compose a publication-grade multi-panel figure from a claim and immutable data Artifact Versions, or revise an existing figure. Plan panels, delegate rendering, compose in a producer child, and independently review the current composite. For a standalone plot use `figure-style`; for whole-paper ordering use `paper-narrative`.'
license: Apache-2.0
---

# Figure Composer

Use this workflow in Main/root. Delegated children cannot delegate. Main plans and
validates; panel workers render, a producer child composes, and an independent
reviewer checks the current composite. Use `figure-style` for visual decisions.
Run `paper-narrative` first if paper-level figure order is undecided.

Call this skill's registered Python helpers directly in `notebook_execute` with
`kernelSkillIds: ["figure-composer"]`; do not import `kernel.py`.

## Inputs and outline

- `claim`: one sentence the figure supports.
- `dataVersionIds`: immutable Upload or Artifact Version IDs for panels.
- `width_mm`: final venue width in physical millimeters.
- `rulesVersionId` (optional): an existing finalized Version with extra rules.
- `delegatePrefix`: a unique prefix for child names in this run.

For an existing figure, inspect it first, then draft the outline from the image
and supplied data. Pixels alone cannot establish `data_vid` identities.

Main drafts an outline matching `figure_outline_schema()`: panel letters, roles,
messages, chart families, and a 12-column grid. `row` and `col` are zero-based;
`row_heights_mm` contains physical millimeter heights, not weights. An opening
schematic or hero and one panel carrying the central claim are useful defaults,
not required positions or a required panel count. Use only supplied immutable
Version IDs for non-schematic `data_vid` values. Set `fixed_panel_set: true` only
when the user requires the exact panel list. Review the outline before fan-out.

## Panel workers

Generate each first-render task with `panel_task(outline, letter, fig_label)` and
pass it intact, with that panel's data Version in `inputs` when present. Dispatch
ordered waves of at most four with `host.delegate(..., { wait: false })`; smaller
waves are fine when the provider cannot run them reliably in parallel. Each
request has this `outputSchema`:

```javascript
{
  type: 'object', additionalProperties: false,
  required: ['panelVersionId', 'labelsUsed'],
  properties: {
    panelVersionId: { type: 'string', minLength: 1 },
    labelsUsed: { type: 'array', items: { type: 'string' } }
  }
}
```

Record the exact `{ frameId, attemptId }` receipts. Collect those same handles
with `host.collect(handles, { returnWhen: 'all', timeoutSeconds: 240 })` in a
`repl_execute` call with enough execution time for the collect window. A collect
timeout only ends observation; it does not stop a child. If a pinned Attempt is
still running, collect it again. Retry only after it is terminal and failed or
its output failed validation. Give each new Attempt a fresh child name.

Accept a panel only when its Attempt completed without error, its structured
output is satisfied, and `artifactsCreated` contains exactly one
`panel_<letter>.png` whose `versionId` equals `panelVersionId`. Reject missing
or duplicate filenames, aliases, pending Versions, and IDs that name an Artifact
rather than a Version. Return validated `{ letter, versionId }` values from the
REPL call. Keep current panel Versions in outline order; paths are never the
Agent-to-Agent contract.

## Producer child

Generate `composition_task(outline, panelVersions, fig_label)` and delegate it
with ordered panel Version IDs in `inputs` and this output schema:

```javascript
{
  type: 'object', additionalProperties: false,
  required: ['compositeVersionId'],
  properties: { compositeVersionId: { type: 'string', minLength: 1 } }
}
```

The producer alone resolves panel bytes through `host.artifactPath`, calls
`compose_figure` with the same ordered Version IDs in
`artifactVersionInputs`, and publishes `figure.png` with the actual notebook
`runId` as `producerRunId`. Do not substitute paths, filenames, or round numbers
for Version or Run IDs. A panel size mismatch is a failed composition;
regenerate that panel at its exact `panel_px` dimensions. The producer must
submit its output with `host.submitOutput` and finish normally.

Collect and validate its exact Attempt as for panels. Require one `figure.png`
in `artifactsCreated`, matching `compositeVersionId`, with a finalized Version.
Use only that child Version for review. A root-created Artifact can remain
pending during Main's turn and cannot replace it.

## Inspect and review

Inspect the full composite. Use `compose_crops` and `host.viewImage` for any
panel whose details need a closer look. Image attachments are limited to four
per `repl_execute` call; split larger batches. Check contrast, labels, data
fidelity, legends, seams, and panel letters.

At least one independent reviewer Attempt is mandatory. Generate its task with
`composite_review_task(compositeVersionId, outline, rulesVersionId)` and schema
with `review_schema()`. Pass the finalized composite, optional previous
composite, non-null panel data Versions, and an existing rules Version when
provided in `inputs`. The reviewer may inspect the full figure and crop regions
needed to judge it. Collect the exact receipt and require completed status and
satisfied structured output. Do not substitute Main's own check for this review.

There is no finding quota. Accept `accept` or `minor_revision` only when there
are no `BLOCKER` or `MAJOR` findings and no required outline revision. If review
identifies material changes, save `previous_outline = copy.deepcopy(outline)`,
apply each `outline_revision` explicitly, then call
`apply_outline_revisions(outline, revisions, previous_outline=previous_outline)`.
This includes new panels and all panels whose pixel dimensions changed, even
if a shared row change named only one panel. Remove deleted panels from the
current Version map.

Combine that affected set with panel letters from `group_fixes_by_panel(review)`,
restricted to current panels. Generate each retry from a fresh
`panel_task(outline, letter, fig_label)` and append targeted fixes and the
previous panel Version. Preserve clean panel Versions. Wait for and validate
every new panel before composing a fresh producer and reviewing that composite.
Never return an older composite after a retry. Use at most three complete
compose/review rounds. If the last review does not accept, report unresolved
findings instead of claiming a finished figure.

## Return

After a reviewer accepts the current composite, use `host.lineage.graph` and
`host.lineage.get` to verify its producer Run's provenance contains the current
panel Versions. Return the existing finalized
`figure.png` Artifact with a user-visible Markdown link. Do not publish a
duplicate root Artifact.
