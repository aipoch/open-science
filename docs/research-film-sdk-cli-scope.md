# Research Film SDK and CLI scope

## Confirmed goal

Expose both existing Research Film modes through the public Node SDK and the `open-science` CLI in this development cycle. The SDK and CLI should use the same application implementation and permission checks.

- **Research explanation** generates a narrated explanation from the completed research response on a conversation branch.
- **Operation replay** generates a narrated replay from recorded operations that belong to the selected branch.

The intended workflow starts with a research Run, uses its Session to identify an eligible conversation branch, starts the selected film mode, observes generation and retrieves the resulting film. The existing Run commands cover task submission and waiting.

- Both modes must work with the desktop app closed. A caller can start generation, check progress, recover from a review failure and retrieve the result through the SDK or CLI.
- The initial deliverable for each mode is a self-contained, narrated HTML player. MP4 is deferred.
- When film review stops generation, a user must be able to understand the failure and communicate revision instructions through an agent. Both public interfaces must support the resulting correction and allow the caller to observe whether it passes review.

## Baseline

Open Science 1.3.0 at official commit `69df576af5b2bd1d25bbea2b5d78f99615011e82`. Development branch `codex/research-film-sdk-cli`.

At the baseline commit, Research Film generation and MP4 export were desktop operations. The explanation flow used the desktop HTML renderer for visual checks. Both modes used the desktop frame-capture pipeline for MP4 export. [Generation composition](https://github.com/aipoch/open-science/blob/69df576af5b2bd1d25bbea2b5d78f99615011e82/src/main/composition/research-film.ts#L479-L523) · [MP4 export implementation](https://github.com/aipoch/open-science/blob/69df576af5b2bd1d25bbea2b5d78f99615011e82/src/main/research-video/export-electron.ts#L148-L218)

## Review and correction

The baseline pipeline supported bounded automatic repairs and desktop checkpoint recovery. This branch exposes failed review diagnostics and revision requests through the SDK and CLI. Headless explanation uses a sandboxed Chromium browser for HTML checks and uses drawings when a live Session app would require interactive approval. MP4 export continues through the desktop app. [Baseline film authoring and review](https://github.com/aipoch/open-science/blob/69df576af5b2bd1d25bbea2b5d78f99615011e82/packages/research-film/src/authoring.ts#L352-L490) · [Research Film commands](../packages/open-science/CLI.md#research-films)

### Feedback flow

1. After automatic repairs are exhausted, preserve a structured diagnostic with the failed review stage, actionable findings and a reference to the failed attempt. The CLI and SDK can read it after reconnecting. Distinguish a failed review from setup, transport and cancellation outcomes.
2. The user discusses the diagnostic with the calling agent. The agent submits revision instructions through the CLI or SDK against the specific failed attempt. The film author receives those instructions and the relevant review findings for the same branch, mode and frozen source. Reject stale or mismatched attempts.
3. Run the applicable film checks again after revision. Publish the HTML only when they pass. If review fails again, expose the updated findings for another feedback round. Keep any previously published film available until a revision passes.

The calling agent owns the user conversation and relays the diagnostic and revision instructions through the selected interface. The initial release accepts feedback for failed reviews. Requests to revise an already published player are outside this release.

Callers can opt into advisory narration scoring when starting a headless Research explanation or revising a failed review. Browser layout checks, applicable model screenshot review and integrity checks still gate publication. After they pass, one advisory assessment reports a score when available. A revision or resume inherits the pending attempt's policy when the caller omits the option. A fresh generation defaults to requiring 9/9 narration review.

## Acceptance

- With the desktop application closed, start each film mode for a scoped conversation branch, check progress and download the self-contained HTML player using the SDK or CLI. The explanation flow uses a sandboxed local Chromium browser for portrait and landscape checks. Replay keeps the existing evidence-order validation.
- Inject an exhausted review failure and recover its stage, attempt ID and findings after reconnecting. Submit feedback for that exact attempt, confirm the author receives it and verify the revised player passes the mode's review before publication. A stale attempt returns `film_review_conflict`. A second failure provides a new attempt ID and findings.
- A failed revision leaves an earlier published player available. Downloads require the published film ID and return the HTML as an attachment. The service keeps its native paths and the pending draft private.
- Use the matching local service profile with bearer authentication. An explanation requires a sandbox-capable Chrome, Chromium or Microsoft Edge installation. Both modes require the existing narration model and an eligible source branch.
