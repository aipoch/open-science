---
name: skill-creator
description: Create, revise, evaluate, publish, and improve Open Science Skills through the native JavaScript host.skills composer. Use when the user wants a reusable workflow, an existing Skill changed, test cases or benchmarks for a Skill, or better Skill triggering.
---

# Skill Creator

Create one focused, reusable Skill package. Skills are application-managed packages, not Artifacts.
Use the JavaScript control-plane REPL and the native `host.skills` composer for lifecycle operations.

## Native composer

```javascript
await host.skills.list()
await host.skills.read(name)
await host.skills.read(name, path)
await host.skills.validate(name)
await host.skills.edit(name, path, content)
await host.skills.edit(name, path, replacement, oldString)
await host.skills.publish(name)
await host.skills.publish(name, true)
await host.skills.delete(stableId)
```

Without `old_string`, `edit` creates a file and fails if it exists. With `old_string`, the old text
must occur exactly once. Never silently overwrite an existing draft file. `publish` promotes the
complete draft into Personal Skills. `delete` is privileged and always uses app approval. When a
published Skill and its draft coexist, delete only by the exact `draft-<name>` or `personal-<name>`
id returned from `list()`; never guess from the shared display name.

## Choose the current stage

Infer where the user is in the workflow and start there:

1. Capture intent and examples.
2. Draft or revise the Skill.
3. Review the package with the user.
4. Optionally evaluate realistic prompts.
5. Improve from evidence and repeat.
6. Publish only after the user accepts the draft.

Do not force evaluation. Objectively verifiable workflows benefit from test cases; subjective writing
or exploratory Skills may be better reviewed directly in conversation.

## Capture intent

Extract what is already known from the conversation before asking questions. Confirm only gaps that
materially change behavior:

- What should the Skill enable an agent to do?
- When should it trigger, including near-miss cases where it should not?
- What inputs and output formats matter?
- What counts as success, and what failures need explicit handling?
- Are scripts, references, assets, connectors, or example files required?
- Does the user want test cases now?

Prefer one concise question at a time. Calibrate terms such as benchmark, JSON, or assertion to the
user's technical comfort.

## Author the package

1. Call `host.skills.list()` before editing. Read every existing file you intend to change.
2. For Built-in or Imported Skills, create a Personal fork under a new lowercase hyphenated name.
3. Use frontmatter with `name` and `description`, plus optional `displayName`; `name` is the immutable
   safe draft name and defaults as the presentation label when `displayName` is omitted.
4. Put stable procedures in `SKILL.md`, detailed knowledge in `references/`, deterministic automation
   in `scripts/`, and output templates in `assets/`.
5. Prefer imperative instructions and explain why constraints matter. Avoid brittle lists of MUSTs.
6. Keep `SKILL.md` focused. Link directly to optional resources and state when to read them.
7. Re-read changed files, call `host.skills.validate(name)`, and show the user the important behavior
   and boundaries before publishing.

Do not promise automatic kernel sidecars, per-Specialist environments, or connector tool patterns;
those capabilities are not part of the current composer.

## Create test cases

When the user wants evaluation, propose two or three realistic prompts. Ask them to confirm or revise
the set before running anything. Store output-evaluation cases as `evals/evals.json`. Store trigger
and near-miss cases as `trigger-evals.json`. Follow [`references/schemas.md`](references/schemas.md).

Good cases cover different phrasings, input shapes, edge cases, and near misses. Expectations should
be observable from the transcript or output files. Use human review for qualities that cannot be
reliably reduced to assertions.

## Run and evaluate

Evaluation is capability-gated. First check whether this runtime exposes `host.skills.evals`. If it
does not, run a qualitative sanity check in the current conversation or publish without evaluation if
the user chooses; never claim that baseline, blind, or trigger evaluation ran when it did not.

When `host.skills.evals` is available:

1. Freeze the draft identity and revision.
2. Create paired runs for each case: one with the Skill and one baseline.
3. Keep inputs, provider/model, and tool capabilities equal across the pair.
4. Save outputs, transcript, timing, token counts, and actual Skill activity.
5. Grade expectations using [`agents/grader.md`](agents/grader.md).
6. Aggregate results with `scripts/aggregate-benchmark.js`.
7. Generate the review page with `eval-viewer/generate-review.js` and let the user review outputs
   before changing the Skill.
8. Use [`agents/comparator.md`](agents/comparator.md) only when A/B origins are genuinely hidden.
9. Use [`agents/analyzer.md`](agents/analyzer.md) to explain benchmark patterns and comparison results.

Never use persistent `host.agents` Specialists as pretend isolated evaluators. Never start another
provider CLI from the REPL to bypass the app-owned Session and approval boundaries.

## Improve from feedback

Read user feedback, grades, transcripts, and benchmark notes together. Generalize from repeated
failures instead of overfitting to one prompt. Look for:

- ambiguous instructions that led to divergent behavior;
- repeated helper code that belongs in `scripts/`;
- expectations that pass both configurations and therefore do not measure Skill value;
- flaky cases with high variance;
- time or token costs that outweigh the quality gain;
- false-positive and false-negative trigger cases.

`scripts/improve-description.js` can build and parse a description-improvement prompt, but the current
Agent or an app-owned evaluation Session must perform the model call. Always show description changes
and scores to the user before applying an exact-match edit.

## Review and publish

Summarize the final behavior, boundaries, files, and any unverified capability. Publish with
`await host.skills.publish(name)`. Use `overwrite = true` only after the user explicitly chooses to
replace an existing Personal Skill. Read the published `SKILL.md` back and report its actual id and
origin.

If the user asks to attach it to a Specialist, read the live Specialist and Skill catalogs first,
then call `host.agents.attachSkill(...)` and report the returned read-back. Never attach automatically.
