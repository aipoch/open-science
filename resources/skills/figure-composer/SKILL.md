---
name: figure-composer
description: 'Compose one publication-grade multi-panel figure. Start from a one-line claim plus immutable data Artifact Version references, or inspect an existing figure and draft its outline directly. Plan a 12-column panel outline, delegate one worker per panel, compose and inspect the result, then run at most three adversarial review rounds while regenerating only affected panels. For a standalone plot use `figure-style`; for whole-paper figure ordering use `paper-narrative`.'
license: Apache-2.0
---

# Figure Composer — narrative → panels → compose → adversarial loop

`figure-composer` is the outer workflow for one multi-panel figure. Use the
`figure-style` rules while planning and reviewing; every panel worker uses those
rules independently. Run `paper-narrative` first when the paper-level figure
sequence is still undecided.

## Open Science Notebook call

Every `notebook_execute` request whose `code` uses a function named in this skill
includes this skill ID:

```json
{ "kernelSkillIds": ["figure-composer"], "code": "print(figure_outline_schema())" }
```

`kernelSkillIds` contains the skill ID; function calls belong in `code`. Call the
named functions directly without an import or discovery step.

## Inputs

- `claim`: the one sentence the figure makes true without surrounding prose.
- `dataVersionIds`: immutable Upload or Artifact Version identities grounding
  the panels.
- `width_mm`: venue column width, commonly 85–89 mm single or 174–183 mm double.
- `rulesVersionId` (optional): a pre-existing, finalized immutable Artifact
  Version containing additional design rules used by the composite reviewer.
  When absent, the reviewer loads `figure-style` directly. Never create a rules
  Artifact in the current turn and treat its pending Version as delegated input.
- `delegatePrefix`: short branch-unique prefix for panel and reviewer child names.

Run this workflow only in the Main/root agent. Delegated children cannot call
`host.delegate`, so the whole composer cannot itself be delegated.

## Entry points

- **From a claim:** Main writes the outline in step 1 from the claim, data, and
  `figure-style` rules.
- **From an existing figure:** inspect it with `host.viewImage`, then have Main
  draft and review the outline directly. Current `host.llm` calls do not accept
  images, so do not add a second hidden inference step. Pixels cannot supply
  Artifact Version identities; fill `data_vid` from the provided data.

## 1. Narrative → panel outline

Main produces a `panel_outline` matching `figure_outline_schema()`:

```json
{
  "claim": "…",
  "width_mm": 180,
  "ncol": 12,
  "row_heights_mm": [40, 60, 46, 52],
  "panels": [
    {
      "letter": "a",
      "role": "schematic",
      "row": 0,
      "col": 0,
      "colspan": 12,
      "chart_family": "schematic overview",
      "message": "…",
      "data_vid": null,
      "ask": "…"
    },
    {
      "letter": "b",
      "role": "primary",
      "row": 1,
      "col": 0,
      "colspan": 7,
      "chart_family": "scatter + trend",
      "message": "…",
      "data_vid": "…",
      "ask": "…"
    }
  ]
}
```

Outline rules:

- A is the context-free hook: schematic or hero, normally full width.
- B carries the claim: it should make the sentence true on its own.
- Remaining panels add evidence in descending importance.
- Use one row per sub-claim, normally 5–10 panels, and a 12-column grid.
- Every non-schematic `data_vid` must be one of the supplied immutable Version
  identities. Do not invent or rewrite Version IDs.

Review the outline before fan-out. Use the schema as a contract; Main does the
reasoning and does not call `host.llm` to generate the outline again.

## 2. Fan out panel workers

Generate each task in Python with `panel_task(outline, letter, fig_label)`. The
returned task contains the complete panel procedure. Pass it unchanged on the
first render and supply the panel's data Version in `inputs`.

Dispatch from `repl_execute`. `host.delegate` accepts at most four children per
atomic call, so send ordered waves of no more than four. Each request uses this
output schema:

```javascript
const panelOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['panelVersionId', 'labelsUsed'],
  properties: {
    panelVersionId: { type: 'string', minLength: 1 },
    labelsUsed: { type: 'array', items: { type: 'string' } }
  }
}
```

Use `wait: false`, then collect the exact `{ frameId, attemptId }` receipt
handles. Reject a non-completed/error child, missing or unsatisfied structured
output, a missing or duplicate expected `panel_<letter>.png`, or a mismatch
between its Artifact `versionId` and `structuredOutput.panelVersionId`. MIME
metadata may be absent; the exact filename and Version identity are the binding
checks. Return each wave's validated `{ letter, versionId }` values from the
`repl_execute` call instead of relying on local `const` or `let` declarations to
survive a later call.

Treat collection as a **Delegated Wait**: bounded observation, not child
lifetime management. It is distinct from an **Attempt Deadline**, which exists
only when the user or execution contract explicitly imposes one. Use
`host.collect(..., { timeoutSeconds: 240, returnWhen: 'all' })` inside a
`repl_execute` call whose `timeoutMs` is at most `270000`, then inspect every
returned status. If any pinned Attempt is still `running`, collect those same
exact `{ frameId, attemptId }` handles again in another bounded observation
window. Expiry returns a durable observation and never stops the Attempt. A
transport or REPL observation timeout is also not an Attempt Deadline: it does
not make a child failed and never authorizes `host.stopChild` or a replacement
child. Retry only after the pinned Attempt is terminal: either it settled as
`error`/`cancelled`, or it settled as `completed` but its required postcondition
or Version/Artifact identity validation was explicitly rejected. A `running`
Attempt is never retryable; cancel it only when the user explicitly asks.

Keep Version identities in outline order. Resolve bytes with
`host.artifactPath(versionId)` only after collection; temporary paths are never
the Agent-to-Agent contract. Child names remain occupied after settlement, so
use a unique `delegatePrefix` and round number.

## 3. Compose in a producer child and bind the Run

The Main Agent's own `write_artifact_file` output remains pending until the root
turn ends, so it cannot be inspected or passed to a reviewer in the same turn.
Compose in one non-delegating producer child instead. Generate its exact task in
Python with `composition_task(outline, panelVersions, fig_label)` and pass the
ordered panel Version IDs in `inputs`. The child must not call `host.delegate`.

Use this output schema:

```javascript
const compositionOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['compositeVersionId'],
  properties: { compositeVersionId: { type: 'string', minLength: 1 } }
}
```

Collect its exact `{ frameId, attemptId }` receipt and apply the same terminal
checks as a panel: completed status, satisfied structured output, exactly one
`figure.png`, and equality between that Artifact's `versionId` and
`structuredOutput.compositeVersionId`. Attempt settlement finalizes the
composite Version, so Main can now use it with `host.viewImage` and as reviewer
input. This is the required provenance-safe boundary; never replace it with a
root pending Version or an absolute/local path fallback.

Inside the producer child, the task resolves panel bytes with
`host.artifactPath`, moves only paths through a JSON handoff under
`process.env.OPEN_SCIENCE_HANDOFF_DIR`, and passes the ordered, de-duplicated
panel identities to the composition `notebook_execute` as
`artifactVersionInputs`. It calls `compose_figure`, verifies completion, and
publishes `figure.png` with the exact returned `runId` as `producerRunId` before
submitting the composite Version identity.

## 3.5 Look before review

Call `compose_crops` in Python and inspect every crop before formal review.
`host.viewImage` never upscales and caps the output long edge at 1568 pixels;
omit `maxSize` when native pixels are required.

One `repl_execute` invocation can attach at most four images. Split five or more
crops into ordered batches of no more than four, and let each invocation finish
successfully before starting the next; a failed enclosing invocation discards
every image staged by that invocation. For each `cropBatch`, use the current
camelCase API:

```javascript
if (cropBatch.length > 4) throw new Error('viewImage crop batch exceeds four images')
for (const [letter, box] of cropBatch) {
  await host.viewImage(
    { versionId: compositeVersionId },
    { crop: { unit: 'pixels', left: box[0], top: box[1], right: box[2], bottom: box[3] } }
  )
}
return { inspectedPanels: cropBatch.map(([letter]) => letter) }
```

Check contrast, smallest marks, leader crossings, color identity, legend
binding, seams, panel-letter overlap, gutter bleed, and resize artifacts. Fix an
obvious defect before formal review.

## 4. Adversarial review loop

Run **one to three** rounds with review floors 5 → 4 → 3. At least one formal
reviewer Attempt is mandatory even when Main's crop inspection finds no obvious
defect; never replace this step with Main self-review. Generate the reviewer
task with `composite_review_task(compositeVersionId, outline,
rulesVersionId or None, ...)` and its `outputSchema` with `review_schema()`.
Pass the task unchanged to one reviewer; include the finalized composite,
optional previous composite, every non-null panel data Version, and only a
pre-existing finalized `rulesVersionId` in `inputs`. When no rules Version was
supplied, the task tells the reviewer to load `figure-style` directly. Collect
the exact receipt and use only validated `structuredOutput` as the review object.

After each result:

1. Accept when the verdict is `accept` or `minor_revision`, there are no
   `BLOCKER`s, and there are at most two `MAJOR`s.
2. Apply `outline_revisions` explicitly, then call
   `apply_outline_revisions(outline, revisions)` to compute their panel scope.
3. Call `group_fixes_by_panel(review)` and compute
   `regen = affected | set(fixb)`.
4. Regenerate only `regen`. For every regenerated panel, actually call
   `panel_task(outline, letter, fig_label)` and use its returned base task
   byte-for-byte unchanged. Only append `fixb.get(letter, "")` and: “Do not
   over-correct: preserve everything the previous version got right.” Include
   the prior panel Version and its data Version in `inputs`. Never handwrite,
   shorten, or rename the generated retry task. This preserves the exact
   `panel_<letter>.png`
   filename, pixel geometry, publication, and structured-output postconditions.
   Run the same validation after every round. A terminal child that publishes
   `panel_<letter>_final.png` or any other alias fails validation; its Version
   must not enter composition provenance, and only after terminal settlement may
   Main create a fresh-name retry.
5. Keep every clean panel's exact Version identity. Compose a new revision with
   a fresh producer child only after every regenerated panel passes the same
   identity checks; never reuse a child name or a root pending Version.

Stop when accepted, or when `outline_revisions` is empty and new findings are
only carve-out exceptions to the previous round; that is the over-labeling
signal. Otherwise stop after round three.

## 5. Return the accepted composite

Only after a reviewer accepts the current composite, verify that no panel
Attempt started after its producer and that its provenance still contains the
latest validated Version for every panel. Return that existing finalized child
Artifact as the deliverable and include a user-visible Markdown link named
`figure.png` in the final response. Do not create a duplicate root Artifact or
claim completion from Main's visual inspection alone.

## Anti-patterns

- Do not regenerate clean panels.
- Do not manufacture findings merely to meet the review floor.
- Verify review anchors on the composite, not only on isolated panels.
- Remove labels that a reader with field context would find redundant.
