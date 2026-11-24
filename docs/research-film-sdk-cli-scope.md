# Research Film SDK and CLI scope

## Confirmed goal

Expose both existing Research Film modes through the public Node SDK and the `open-science` CLI in this development cycle. The SDK and CLI should use the same application implementation and permission checks.

- **Research explanation** generates a narrated explanation from the completed research response on a conversation branch.
- **Operation replay** generates a narrated replay from recorded operations that belong to the selected branch.

The intended workflow starts with a research Run, uses its Session to identify an eligible conversation branch, starts the selected film mode, observes generation and retrieves the resulting film. The existing Run commands cover task submission and waiting.

- Both modes must work with the desktop app closed. A caller can start generation, check progress, recover from a review failure and retrieve the result through the SDK or CLI.
- Each mode publishes a self-contained, narrated HTML player. The SDK and CLI also export a published player as a narrated landscape MP4.
- When film review stops generation, a user must be able to understand the failure and communicate revision instructions through an agent. Both public interfaces must support the resulting correction and allow the caller to observe whether it passes review.

## Generation and export workflow

The service publishes the reviewed HTML player before MP4 export. It uses the same stored player for frame capture and narration, so a caller can repeat export without rerunning Film generation.

| Starting point             | CLI workflow                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| An eligible Session branch | Run `film start`, poll `film status` for the intended publication, and pass its `result.id` to `film export`. |
| A published Film ID        | Run `film export` once. It waits for rendering and saves the verified MP4.                                    |

Use the same Project, Session, branch, and mode throughout. Each `film status` invocation returns a snapshot. An earlier `result` can remain visible while a new attempt is running or has failed. `film download` saves a local HTML copy when requested. [Research Film commands](../packages/open-science/CLI.md#research-films)

## Baseline

Initial baseline was Open Science 1.3.0 at official commit `69df576af5b2bd1d25bbea2b5d78f99615011e82`. Development branch `feat/research-film-sdk-cli` incorporates the upstream change to advisory narration scoring and best playable candidate selection. [Upstream quality review change](https://github.com/aipoch/open-science/pull/4468)

At the baseline commit, Research Film generation and MP4 export were desktop operations. The explanation flow used the desktop HTML renderer for visual checks. Both modes used the desktop frame-capture pipeline for MP4 export. [Generation composition](https://github.com/aipoch/open-science/blob/69df576af5b2bd1d25bbea2b5d78f99615011e82/src/main/composition/research-film.ts#L479-L523) · [MP4 export implementation](https://github.com/aipoch/open-science/blob/69df576af5b2bd1d25bbea2b5d78f99615011e82/src/main/research-video/export-electron.ts#L148-L218)

## Review and correction

The baseline pipeline supported bounded automatic repairs and desktop checkpoint recovery. This branch exposes failed review diagnostics and revision requests through the SDK and CLI. Headless explanation uses a sandboxed Chromium browser for HTML checks and uses drawings when a live Session app would require interactive approval. [Baseline film authoring and review](https://github.com/aipoch/open-science/blob/69df576af5b2bd1d25bbea2b5d78f99615011e82/packages/research-film/src/authoring.ts#L352-L490) · [Research Film commands](../packages/open-science/CLI.md#research-films)

### Feedback flow

1. When validation blocks publication after automatic repairs, preserve a structured diagnostic with the failed review stage, actionable findings and a reference to the failed attempt. This includes exhausted validation of a generated scene animation or shared helper. The CLI and SDK can read the diagnostic after reconnecting. Distinguish a failed review from setup, transport and cancellation outcomes.
2. The user discusses the diagnostic with the calling agent. The agent submits revision instructions through the CLI or SDK against the specific failed attempt. The film author receives those instructions and the relevant review findings for the same branch, mode and frozen source. Reject stale or mismatched attempts.
3. Run the applicable film checks again after revision. Publish an eligible player under the same review rules. If validation still blocks publication, expose the updated findings for another feedback round. Keep any previously published film available until a replacement is published.

The calling agent owns the user conversation and relays the diagnostic and revision instructions through the selected interface. The initial release accepts feedback for failed reviews. Requests to revise an already published player are outside this release.

Research explanation reports an advisory narration score from 0 to 9 when available. The public SDK option and CLI flag for advisory scoring remain accepted for compatibility. Headless Chromium checks portrait and landscape without a separate model screenshot review. After bounded repairs the service may publish its best playable candidate with remaining layout defects. Required screenplay and player integrity checks still apply. Saved failures from the earlier narration review policy remain eligible for revision.

## Acceptance

- With the desktop application closed, start each film mode for a scoped conversation branch, check progress and download the self-contained HTML player using the SDK or CLI. The explanation flow uses a sandboxed local Chromium browser for portrait and landscape checks. Replay keeps the existing evidence-order validation.
- Inject a blocking validation failure and recover its stage, attempt ID and findings after reconnecting. Submit feedback for that exact attempt, confirm the author receives it and verify the new player is eligible under the mode's review rules before publication. A stale attempt returns `film_review_conflict`. A second failure provides a new attempt ID and findings.
- A failed revision leaves an earlier published player available. Downloads require the published film ID and return the HTML as an attachment. Public status and error diagnostics hide native filesystem paths, and the pending draft remains private.
- Export each published Film ID to MP4 with the desktop closed. Frame capture runs in sandboxed Chromium with network access blocked. The existing FFmpeg encoder and ffprobe verifier check the final video and audio before streaming. An interrupted export leaves any existing destination file intact.
- Use the matching local service profile with bearer authentication. An explanation requires a sandbox-capable Chrome, Chromium or Microsoft Edge installation. Both modes require the existing narration model and an eligible source branch.
