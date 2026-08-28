---
name: figure-composer
description: 'Compose one publication-grade multi-panel figure from a one-line claim and immutable data Artifact Version references. Uses deterministic Python helpers for outline schema, geometry, panel tasks, crops, composition, review grouping, and revision scope; uses the existing JavaScript Host for reasoning, bounded panel delegation, visual inspection, and Artifact Version handoff. Runs at most three composite-review rounds and regenerates only affected panels. For a standalone plot use figure-style; for whole-paper figure ordering use paper-narrative.'
license: Apache-2.0
---

# Figure Composer — narrative → panels → compose → adversarial loop

`figure-composer` is the outer workflow for one multi-panel figure. Every panel
worker loads `figure-style` independently; run `paper-narrative` first when the
paper-level figure sequence is still undecided.

## Open Science helper interface

Every Python cell that calls this skill's helpers declares the registered helper
on the same `notebook_execute` request as its code:

```json
{ "helperModules": ["figure-composer"], "code": "print(figure_outline_schema())" }
```

Repeat `helperModules: ["figure-composer"]` on each dependent call; the host
reuses the helper within the live kernel. Call helper names as referenced below
directly. Do not read, import, `exec`, copy, or rewrite `kernel.py`, and never
ask for its path or digest. Reasoning, delegation, collection, and image
inspection run from `repl_execute` through the existing camelCase Host API;
there is no Python-to-JavaScript bridge.

## Inputs

- `claim`: the one sentence the figure makes true without surrounding prose.
- `data`: immutable Upload or Artifact Version identities grounding the panels,
  plus deterministic bounded summaries used by the tool-less outline model.
- `width_mm`: venue column width, commonly 85–89 mm single or 174–183 mm double.
- `delegatePrefix`: short branch-unique name prefix for this figure and narrative
  revision; it keeps all panel and reviewer child names unique.

Before starting the workflow, fail closed on every required control-plane
capability. Do not start partial work when one is unavailable:

```javascript
const caps = await host.capabilities()
if (caps.llm !== true) throw new Error('figure-composer requires host.llm')
if (caps.delegate !== true) throw new Error('figure-composer requires host.delegate')
if (caps.collect !== true) throw new Error('figure-composer requires host.collect')
if (caps.artifacts !== true) throw new Error('figure-composer requires Artifact discovery')
if (caps.viewImage !== true) throw new Error('figure-composer requires host.viewImage for QA')
```

Run `figure-composer` only in the Main/root agent. A delegated child cannot call
`host.delegate`, so delegating the whole composer and then asking it to fan out
panel workers cannot work. `paper-narrative` queues figures at the root and runs
this workflow there.

## 1. Reason into an outline

Use `figure_outline_schema()` in Python to obtain the contract and return that
JSON value to the control plane as `outlineSchema`. Embed the full schema in the
reasoning prompt; a method name or prose summary is not enough. `host.llm` is
tool-less and accepts no caller-selected model, images, or enforced structured
output, so parse and validate its text explicitly. The control REPL is CommonJS
and the app includes Ajv 2020:

```javascript
const Ajv2020 = require('ajv/dist/2020').default
const validateOutline = new Ajv2020({ allErrors: true }).compile(outlineSchema)
const promptBytes = (value) => Buffer.byteLength(value, 'utf8')
const baseOutlinePrompt =
  `Return JSON only for this figure outline. Claim: ${claim}. ` +
  `Required physical width_mm: ${width_mm}. ` +
  `Grounded data summaries (each includes its immutable Version id): ` +
  `${JSON.stringify(dataSummaries)}. ` +
  `The result MUST satisfy this JSON Schema: ${JSON.stringify(outlineSchema)}`
let outline
let repair = ''
for (let attempt = 1; attempt <= 2; attempt += 1) {
  const prompt = baseOutlinePrompt + repair
  if (promptBytes(prompt) > 64 * 1024) {
    throw new Error(
      'figure outline prompt exceeds host.llm 64 KiB UTF-8 limit; shorten data summaries'
    )
  }
  const outlineDraft = await host.llm(prompt)
  if (outlineDraft.stopReason !== 'end_turn') {
    throw new Error(`figure outline inference stopped with ${outlineDraft.stopReason}`)
  }
  let candidate
  let problem
  try {
    candidate = JSON.parse(outlineDraft.text)
    if (validateOutline(candidate)) {
      outline = candidate
      break
    }
    problem = JSON.stringify(validateOutline.errors)
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error)
  }
  if (attempt === 2) throw new Error('invalid outline after retry')
  repair =
    `\nThe previous response was invalid. Validation problem: ${problem}. ` +
    `Repair it and return JSON only. Previous response:\n${outlineDraft.text.slice(0, 8000)}`
}
```

Build `dataSummaries` deterministically from the staged data: Version ID, fields,
types, row/group counts, and the reviewed semantic description. Opaque Version
IDs alone give a tool-less model no data context. Return the Ajv-valid value to
Python and call `validate_figure_outline(outline)` before generating any panel
task. An invalid outline gets one corrective retry containing the actual parse
or schema error and then fails the workflow; never fan out an unparsed or invalid
draft. Review the valid outline before
fan-out. Panel A is the context-free hook; B
carries the claim; remaining panels add evidence in descending importance. Use
one row per sub-claim and normally 5–10 panels.

An existing image may be inspected with `host.viewImage`, but this Host release
does not pass images into `host.llm`; manually draft the outline from what is
visible instead of inventing a hidden vision bridge.

## 2. Fan out panel workers

Generate every task in Python with `panel_task`. Then dispatch from
`repl_execute`. `host.delegate` admits at most four children atomically, so send
waves of no more than four. A worker loads `figure-style` independently and
declares `helperModules: ["figure-style"]` on its own Python producer request,
renders the exact requested pixels, writes the PNG as an Artifact using the
notebook `runId` as `producerRunId`, and calls `host.submitOutput` for the small
JSON result. Never ask workers to exchange temporary absolute paths.

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
const validatePanelOutput = new Ajv2020({ allErrors: true }).compile(panelOutputSchema)
const requests = panelSpecs.map(({ letter, task, dataVersionId }) => ({
  name: `${delegatePrefix}-panel-${letter}-r1`,
  task: `${task}\nLoad \`figure-style\` independently. Publish the PNG Artifact, then submit panelVersionId and labelsUsed.`,
  inputs: dataVersionId ? [dataVersionId] : [],
  outputSchema: panelOutputSchema
}))
const panelVersions = []
for (let offset = 0; offset < requests.length; offset += 4) {
  const wave = requests.slice(offset, offset + 4)
  const sent = await host.delegate(wave, { wait: false })
  if (sent.kind !== 'receipts') throw new Error('panel delegation did not return receipts')
  const selectors = sent.children.map(({ frameId, attemptId }) => ({ frameId, attemptId }))
  const settled = await host.collect(selectors, { returnWhen: 'all', timeoutSeconds: 1800 })
  const byAttempt = new Map(settled.map((child) => [child.attemptId, child]))
  const checkedWave = sent.children.map((receipt, index) => {
    const child = byAttempt.get(receipt.attemptId)
    const expectedName = `panel_${panelSpecs[offset + index].letter}.png`
    if (!child || child.status !== 'completed' || child.error) {
      throw new Error(`panel failed: ${receipt.name}`)
    }
    if (child.structuredOutputUnsatisfied === true || !child.structuredOutput) {
      throw new Error(`panel structured output missing: ${receipt.name}`)
    }
    if (!validatePanelOutput(child.structuredOutput)) {
      throw new Error(`panel structured output invalid: ${receipt.name}`)
    }
    const pngs = child.artifactsCreated.filter(
      (artifact) => artifact.name === expectedName && artifact.mimeType === 'image/png'
    )
    if (pngs.length !== 1 || pngs[0].versionId !== child.structuredOutput.panelVersionId) {
      throw new Error(`panel Artifact identity mismatch: ${receipt.name}`)
    }
    return { letter: panelSpecs[offset + index].letter, versionId: pngs[0].versionId }
  })
  panelVersions.push(...checkedWave)
}
```

Here `validatePanelOutput` is an Ajv validator compiled from
`panelOutputSchema`. The loop handles all 5–10 panels in ordered waves of at
most four. It validates a whole wave before accepting any identity. Any
non-completed/error child, unsatisfied/missing/invalid structured output,
missing or duplicate expected PNG, or mismatch between `structuredOutput` and
`artifactsCreated` fails the workflow; do not compose a partial panel set. The
matching PNG's `versionId` is the immutable Artifact Version identity for
composition. Keep identities in outline order; use
`host.artifactPath(versionId)` only to resolve bytes locally after collection.
An Artifact path is an implementation detail, never the Agent-to-Agent contract.
Choose a short, branch-unique `delegatePrefix` for the figure, such as
`paper-r2-Fig3` or `standalone-figure-1`. Names remain occupied after a child
settles, so every figure and retry must use a distinct prefix/revision.

## 3. Compose and bind the producer Run

Resolve the collected Version identities, place the paths in a small JSON
handoff under `process.env.OPEN_SCIENCE_HANDOFF_DIR`, and read that manifest from
the Python producer cell. On that same `notebook_execute` request, pass the
ordered, de-duplicated panel identities as
`artifactVersionInputs: panelVersions.map(({ versionId }) => versionId)`. This
registers the delegated immutable panel Versions as the composition Run's
provenance inputs; paths remain byte-access implementation details and must never
replace Version identities in this field. Call `compose_figure`, verify the
notebook result is completed, and keep the actual returned `runId`. Publish the
final PNG with
`write_artifact_file({ filename: "figure.png", producerRunId: composeResult.runId })`;
never substitute a round number or locally invented Run identity. This binds the
composite Artifact to the run that last wrote its bytes. Fail the workflow if
any panel Version cannot be validated in the active Project; never silently
compose with an unregistered provenance input.

## 3.5 Look before review

Call `compose_crops` in Python. From `repl_execute`, inspect every crop with the
current camelCase API:

```javascript
await host.viewImage(
  { versionId: compositeVersionId },
  { crop: { unit: 'pixels', left: box[0], top: box[1], right: box[2], bottom: box[3] } }
)
```

Check contrast, smallest mark, leader crossings, color identity, legend binding,
seams, letter overlap, gutter bleed, and resize aliasing. Regenerate an offending
panel before paying for formal review.

## 4. Adversarial review loop

Run a maximum 3 review rounds, inspecting at least 5 → 4 → 3 independent rule
areas while reporting only violations that are actually present.
Generate `composite_review_task(...)` and `review_schema()` in Python, then
delegate one reviewer with the composite, optional previous composite,
design-rule, and every non-null panel data Artifact Version in `inputs`; use a
branch-unique name such as `${delegatePrefix}-review-r${roundNo}`. Use
`wait: false`, collect the exact
receipt handle, and reject a non-completed/error result,
`structuredOutputUnsatisfied === true`, missing `structuredOutput`, or output
that fails the `review_schema()` validator. The validated `structuredOutput` is
the review object; never scrape the reviewer's response text.

After each result:

1. Accept when the verdict is `accept` or `minor_revision`, there are no
   `BLOCKER`s, and there are at most two `MAJOR`s.
2. Send the validated review object back to deterministic Python. Apply reviewed
   outline edits explicitly, then call
   `apply_outline_revisions(outline, review["outline_revisions"])` to compute
   outline scope.
3. Call `group_fixes_by_panel(review)` for `BLOCKER`/`MAJOR` panel scope. Compute
   `regen = affected | set(fixb)` from those helper results, never from a
   hard-coded panel list.
4. Regenerate only the union of outline-affected and violation-affected panels.
   Give each retry a unique name such as `${delegatePrefix}-panel-B-r2`; include the prior panel
   Artifact Version and its immutable data Version in `inputs`.
5. Preserve every clean panel's exact Version identity. If any regeneration wave
   fails validation, keep the last complete composite and do not compose a
   partial revision. Otherwise recompose from the mixed
   map of reused and regenerated Versions, inspect all crops, then publish with
   the new compose run's `producerRunId`.

For example, if round 1 changes only B and round 2 changes only A, the final map
must be `A2 / B2 / C1`; C1 is never rerendered. Stop on convergence or after the
third review. Never manufacture findings to meet an inspection count, over-correct clean
content, or regenerate the whole figure for a localized issue.
