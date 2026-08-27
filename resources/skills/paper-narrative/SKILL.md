---
name: paper-narrative
description: 'Judge and reshape the story told by an entire paper figure deck. Uses deterministic Python helpers for the paper-brief and narrative-review schemas and the handling-editor task, while the existing JavaScript Host reasons from manuscript and captions, reviews the full deck, and hands a grounded figure arc to figure-composer. Load when writing or revising a paper.'
license: Apache-2.0
---

# Paper Narrative — manuscript → brief → figure arc → editorial loop

`paper-narrative` is the outermost figure workflow. It judges the paper-level
story before `figure-composer` designs any one figure. The inputs are the work
itself: a manuscript (or abstract), figure captions, and the current full deck.

## Open Science helper interface

For deterministic Python work, declare the registered helper on the same
`notebook_execute` request as the producer code:

```json
{ "helperModules": ["paper-narrative"], "code": "print(paper_brief_schema())" }
```

In shorthand, use `helperModules: ["paper-narrative"]`. The host injects only
the three public callables below. Call them directly; do not read, import,
`exec`, copy, or rewrite the helper implementation, and never ask for its path
or digest. Brief reasoning and deck review do not run in the Python data
kernel. Use `repl_execute` and the existing camelCase JavaScript Host API; do
not invent a Python Host, Connector, LLM, or delegation bridge.

### Public Python methods

- `paper_brief_schema()` takes no arguments and returns the JSON Schema for a
  paper brief. The result is a mapping with required string `pitch`, required
  string `vision`, optional string `audience`, optional string
  `most_arresting_asset`, and required `figures`. Each figure requires string
  `key` and `claim`; string `composite_vid` is optional. The method performs no
  I/O and raises no domain-specific errors.
- `narrative_review_schema()` takes no arguments and returns the JSON Schema for
  the handling-editor result. It requires `hook_verdict`, `figure_moves`,
  `missing_panels`, `kill_list`, `arc`, and `boldest_defensible_fig1`.
  `would_send_for_review` is `yes`, `weak`, or `no`; arc roles are `hook`,
  `mechanism`, `evidence`, `application`, or `supplement`. A hook verdict must
  include both `fig1_is` and `fig1_should_be`; every missing panel must include
  a source-oriented `data_hint`. The method performs no I/O and raises no
  domain-specific errors.
- `narrative_review_task(brief, deck_vid, rules_vid)` returns the complete
  handling-editor task string. `brief` is a mapping shaped by
  `paper_brief_schema()`; `deck_vid` and `rules_vid` are immutable Artifact
  Version identities. Missing optional brief fields use display defaults;
  non-mapping inputs and malformed figure entries surface normal Python
  `AttributeError` or iteration errors. The method performs no Host calls.

The former Host-backed brief helper is intentionally absent. Model reasoning
belongs to the JavaScript control plane, where its provenance and limitations
remain visible.

## Required inputs and trust labels

Keep these inputs distinct throughout the workflow:

- `manuscriptVersionId`: immutable manuscript Artifact Version (an abstract-only
  manuscript is allowed) and the reviewed manuscript text read from it.
- `abstractText`: reviewed abstract text when available; use it for bounded brief
  reasoning while retaining the full manuscript Version as source provenance.
- `captionsVersionId`: immutable captions Artifact Version and the reviewed
  per-figure caption or claim text read from it.
- `deckVersionId`: immutable deck Artifact Version containing every current
  figure in review order.
- `rulesVersionId`: immutable design-rules Artifact Version, used only as a
  reference so the editor judges story rather than visual craft.
- `figureDataVersionIds`: immutable data Artifact Versions grouped by figure.
- `figureWidthMmByFigure`: reviewed positive venue width for each figure; the
  downstream composer must not invent this physical output constraint.

Manuscript, captions, deck, and data are source inputs. Every brief, review,
arc, move, omission, and proposed analysis is model-generated and requires human review.
Never describe generated text as manuscript evidence or source data. Preserve
the input Version identities when publishing or delegating downstream work.

## 1. Reason from manuscript and captions

Load the reviewed manuscript/abstract and captions content into the JavaScript
control-plane request. Obtain `paper_brief_schema()` in Python first. Then call
the current tool-less Host model and require JSON only:

```javascript
const briefSchema = paperBriefSchemaFromNotebook
const caps = await host.capabilities()
if (caps.llm !== true) throw new Error('paper-narrative requires host.llm for brief reasoning')
const Ajv2020 = require('ajv/dist/2020').default
const validateBrief = new Ajv2020({ allErrors: true }).compile(briefSchema)
const briefSourceText = abstractText || manuscriptText
let repair = ''
let brief
for (let attempt = 1; attempt <= 2; attempt += 1) {
  const prompt =
    `Return JSON only. The complete paper_brief JSON Schema is:\n${JSON.stringify(briefSchema)}\n` +
    `Manuscript Artifact Version: ${manuscriptVersionId}\n` +
    `Captions Artifact Version: ${captionsVersionId}\n` +
    `Reviewed abstract/manuscript source:\n${briefSourceText}\n\nCaptions/claims:\n${captionsText}\n\n` +
    `Pitch is the grandest supportable one-sentence claim, not the method. ` +
    `Vision is the killer application: what readers can now do. ` +
    `Name the audience and the single most-arresting image.` +
    repair
  if (Buffer.byteLength(prompt, 'utf8') > 64 * 1024) {
    throw new Error(
      'paper brief prompt exceeds host.llm 64 KiB UTF-8 limit; provide a reviewed abstract or shorter captions'
    )
  }
  const briefDraft = await host.llm(prompt)
  if (briefDraft.stopReason !== 'end_turn') {
    throw new Error(`paper brief inference stopped with ${briefDraft.stopReason}`)
  }
  let candidate
  let problem
  try {
    candidate = JSON.parse(briefDraft.text)
    if (validateBrief(candidate)) {
      brief = candidate
      break
    }
    problem = JSON.stringify(validateBrief.errors)
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error)
  }
  if (attempt === 2) throw new Error('invalid paper brief after corrective retry')
  repair =
    `\nPrevious response was invalid: ${problem}. Repair it and return JSON only. ` +
    `Previous response:\n${briefDraft.text.slice(0, 8000)}`
}
```

`host.llm` does not enforce a caller-provided schema. The code therefore checks
the UTF-8 request budget, requires `stopReason === "end_turn"`, parses JSON, and
validates with the same bundled Ajv 2020 implementation used elsewhere in the
control plane. Prefer the reviewed abstract because a full manuscript commonly
exceeds the hard 64 KiB prompt limit; never silently truncate source text. If a
corrective retry still fails, stop. Do not fill missing required
fields with guesses. After validation, attach the immutable figure/data
references from the source claim table. Then review every field — pitch,
vision, audience, most-arresting asset, and every figure claim — before
continuing. Fix unsupported wording explicitly; never silently treat the first
model draft as approved.

## 2. Review the full deck as a handling editor

Generate the task with
`narrative_review_task(reviewedBrief, deckVersionId, rulesVersionId)` and obtain
`narrative_review_schema()` in Python. Dispatch one reviewer from
`repl_execute`. All three work inputs are explicit alongside the deck; the
schema makes the expected model result reviewable:

```javascript
const collectStructuredBatch = async (requests) => {
  const receipts = await host.delegate(requests, { wait: false })
  const children = await host.collect(
    receipts.children.map(({ frameId, attemptId }) => ({ frameId, attemptId })),
    { returnWhen: 'all', timeoutSeconds: 1800 }
  )
  return children.map((child) => {
    if (!child || child.status !== 'completed' || child.error) {
      throw new Error(
        `delegated workflow failed: ${child?.error ?? child?.status ?? 'missing child'}`
      )
    }
    if (child.structuredOutputUnsatisfied || child.structuredOutput === undefined) {
      throw new Error('delegated workflow returned no schema-valid structuredOutput')
    }
    return child.structuredOutput
  })
}

let narrativeRound = 1
const request = {
  name: `paper-narrative-editor-r${narrativeRound}`,
  task: reviewTask,
  inputs: [manuscriptVersionId, captionsVersionId, deckVersionId, rulesVersionId],
  outputSchema: reviewSchema
}
const [review] = await collectStructuredBatch([request])
```

Require a completed child and a schema-valid result. Human-review the result as
an editorial recommendation, not a fact extraction. Preserve all of the
original narrative judgments:

- `hook_verdict`: whether Figure 1 alone earns external review, why, what it is,
  and what it should become.
- `arc`: hook → mechanism → evidence → application; off-arc material moves to
  supplement unless a reviewed exception is justified.
- `figure_moves`: panels whose correct figure changes, with the reason.
- `missing_panels`: what to show, the concrete analysis to run, and the closest
  source-data hint. Search existing project artifacts before proposing new work.
- `kill_list`: content to demote to supplement/caption or delete.
- `boldest_defensible_fig1`: the strongest supportable Figure 1 claim, never a
  merely louder unsupported claim.

## 3. Hand the reviewed arc to figure-composer

After human review, build root-level composition specifications only for arc
figures that actually need a visual revision. A figure needs recomposition when
it gains or loses a moved panel, receives an accepted missing-panel analysis,
has no existing `composite_vid`, or its reviewed claim/layout differs from the
current figure. Record any additional human-approved layout changes in
`explicitlyReviewedRecomposeFigures`; do not treat a new narrative order alone
as a reason to redraw a figure. Reuse the exact existing `composite_vid` for
every untouched figure. Do **not** delegate the whole `figure-composer`: delegated children cannot
call `host.delegate`, while the composer must fan out panel workers. Remain in
the Main/root agent, load `figure-composer`, and complete its workflow for each
changed specification in review order. Each specification must include:

1. that entry's exact reviewed `one_line` claim;
2. every reviewed moved-in panel whose `to_fig` matches the arc figure and every
   moved-out panel whose `from_fig` matches it, so the source composition removes
   the transferred material;
3. the immutable data Artifact Version references grounding the claim and
   moved panels; and
4. any accepted missing-panel analysis result after it has actually been run
   and published as an Artifact Version; and
5. the reviewed physical `width_mm` for that figure.

Build `inputs` as an order-preserving union: the target figure's source-data
Versions, every moved item's `from_fig` source-data Versions, and the published
missing-analysis Versions for the target. Deduplicate identities. A brief
figure's `composite_vid` identifies rendered figure output; it is not source
data and must never be substituted for these input references.

After the human decision and analysis run, keep the independently reviewed
`acceptedMissingPanelRecommendations`. Populate
`publishedMissingAnalysisVersionIdsByRecommendation` only from successful
Artifact writes, then map every accepted recommendation to its published Version.
Each resolved entry carries the reviewed `target_fig`, `what_to_show`, and exact
`version_id`. Fail closed if any accepted recommendation has no verified published
Version; never derive redraws directly from all model-proposed
`review.missing_panels`.

Initialize `currentFiguresByKey` once from the brief before the first review round,
then retain and update it across every round. Build the complete changed-figure
queue without slicing it. The stable arc index
prevents sanitized or truncated figure keys from colliding, while the round
keeps panel/reviewer delegate names unique across narrative rounds:

```javascript
// Initialize once, outside the review/recompose loop.
const currentFiguresByKey = new Map(brief.figures.map((figure) => [figure.key, figure]))

// Recompute these values after each human-reviewed narrative result. The Map is
// populated from actual successful write_artifact_file results and keyed by the
// exact accepted recommendation object.
const acceptedPublishedMissingAnalyses = acceptedMissingPanelRecommendations.map(
  (recommendation) => {
    const version_id = publishedMissingAnalysisVersionIdsByRecommendation.get(recommendation)
    if (typeof version_id !== 'string' || !version_id) {
      throw new Error(
        `accepted missing-panel analysis has no published Version: ${recommendation.what_to_show}`
      )
    }
    return { ...recommendation, version_id }
  }
)
const changedFigures = new Set([
  ...review.figure_moves.flatMap((move) => [move.from_fig, move.to_fig]),
  ...acceptedPublishedMissingAnalyses.map((analysis) => analysis.target_fig),
  ...review.arc
    .filter((item) => {
      const existing = currentFiguresByKey.get(item.fig)
      return !existing?.composite_vid || existing.claim !== item.one_line
    })
    .map((item) => item.fig),
  ...explicitlyReviewedRecomposeFigures
])
const compositionQueue = review.arc.flatMap((item, arcIndex) => {
  if (!changedFigures.has(item.fig)) return []
  const movedIn = review.figure_moves.filter((move) => move.to_fig === item.fig)
  const movedOut = review.figure_moves.filter((move) => move.from_fig === item.fig)
  const missingAnalyses = acceptedPublishedMissingAnalyses.filter(
    (analysis) => analysis.target_fig === item.fig
  )
  const sourceInputs = [
    ...(figureDataVersionIds[item.fig] ?? []),
    ...movedIn.flatMap((move) => figureDataVersionIds[move.from_fig] ?? []),
    ...missingAnalyses.map((analysis) => analysis.version_id)
  ]
  const width_mm = figureWidthMmByFigure[item.fig]
  if (!Number.isFinite(width_mm) || width_mm <= 0) {
    throw new Error(`missing positive width_mm for ${item.fig}`)
  }
  const figureKey = String(item.fig)
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 12)
  if (!figureKey) throw new Error(`figure key cannot form a delegate prefix: ${item.fig}`)
  return [
    {
      figure: item.fig,
      claim: item.one_line,
      movedInPanels: movedIn.map((move) => move.what),
      movedOutPanels: movedOut.map((move) => move.what),
      dataVersionIds: [...new Set(sourceInputs)],
      width_mm,
      delegatePrefix: `paper-r${narrativeRound}-${String(arcIndex + 1).padStart(2, '0')}-${figureKey}`
    }
  ]
})
```

For every queued entry, pass its claim, data summaries/Version IDs, `width_mm`, and
`delegatePrefix` into the root `figure-composer` workflow. Record the actual
final `version_id` returned by the successful `write_artifact_file` call; never
accept a model-proposed or merely non-empty string as the composite identity.
Use `currentFiguresByKey` as the figure-to-Version map, and after every successful
composer run replace that entry with the reviewed claim and the actual returned
`version_id`. Never recreate this map from the initial brief on a later round. The
composer itself sends panel workers in waves of four. Once every queued entry
has a verified composite Version, build and publish a new deck from the mapped
Versions in complete arc order, including reused untouched Versions. Retain its
immutable `rebuiltDeckVersionId`, and include that exact identity in the next
review request's `inputs`. Never invent an identity, hard-code the next
revision, omit queue entries beyond the first four, or substitute a redrawn
Version for an untouched figure.

The current notebook request schema records the composer's collected delegated
panel Versions through `artifactVersionInputs`. The main process resolves those
identities and persists them as `inputFiles` with `artifact-version` source kind;
callers supply identities only and never paths or provenance metadata.

## 4. Re-review and converge

Review the rebuilt full deck again with the manuscript and captions identities
still present in
`inputs: [manuscriptVersionId, captionsVersionId, rebuiltDeckVersionId,
rulesVersionId]`. Convergence is exactly:

```javascript
review.hook_verdict.would_send_for_review === 'yes' &&
  review.figure_moves.length === 0 &&
  review.missing_panels.length === 0
```

Do not erase a kill list or weaken an arc merely to satisfy convergence. If the
condition is false, human-review the new recommendations, run accepted missing
analyses, increment `narrativeRound`, and rebuild only the newly affected
figures with new delegate prefixes while retaining untouched composite Version
identities. Stop and report an
unresolved editorial disagreement when the evidence cannot support the desired
hook.

## Minimal invocation

> Load `paper-narrative`. Manuscript: `@manuscript.tex`. Captions:
> `@captions.md`. Deck: `@all_figures.pdf`. Derive the brief, ask me to review
> model-generated judgments, reshape only affected arc figures through
> `figure-composer` while reusing every untouched composite Version, and re-review
> until the explicit convergence condition is met or the evidence blocks it.
