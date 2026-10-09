# Read-only Replay and ordinary offline execution

The research Replay reads archived evidence. Notebook, Project Replay, and Results are peer
material views. Discovering a recording does not switch the selected view. Playing, seeking,
selecting a file, and discussing it do not prepare environments, start project programs, reconnect
a service, or capture new evidence. Capturing or interacting with a real project belongs to its
ordinary execution Session's observation viewer.

## Run a packaged offline plan

External agents inspect the package in the scope of an existing writable Session:

```js
const inspection = await client.execution.inspectOfflinePlans({
  projectId,
  sessionId,
  sourceSessionId
})
const operation = await client.execution.executeOfflinePlan({
  projectId,
  sessionId,
  sourceSessionId,
  sourceIdentity: inspection.source.identity,
  planVersionId: selectedReadyPlan.planVersionId,
  requestId
})
```

Reuse the same `requestId` after an uncertain reply. Inspect the declared substitutions and
blockers before choosing a plan. The server freezes the exact plan and materials, prepares the
existing Open Science sandbox, and owns the operation in the supplied ordinary Session. There is
no newly created hidden demo Session. The ordinary in-app Agent uses
`host.managedExecution.inspectOfflinePlans` / `executeOfflinePlan` with the current Session and
turn supplied by the host. The existing `execution.execute` remains research execution. Neither
entry accepts an unchecked command/network/profile override for an offline plan. Project
processes run offline; this does not imply that an orchestrating Agent never calls its model.

`research-demo.json` and the historical `offline-demo` identifier remain compatible. Local
historical demo receipts are accessed through pure `readHistory` / `readReceipt` paths. Viewing
history does not perform journal recovery, persist fresh status, recreate a carrier, or restart a
run. Earlier records remain separate from an imported author's evidence.

## Record once, read independently

`open-science-project-recording` version 1 is optional ordinary Artifact JSON. It has no Notebook
requirement and does not change the `.science` container's version or mandatory fields. See
[the recording owner](../src/main/project-recordings/README.md) for sampling, resource bounds,
shutdown draining, and the author's optional `project-recording-data.json` output contract.

The initial recording adapter stores changed PNG/JPEG/WebP keyframes and bounded author-declared
states/events. Frame capture, derived visualization, and author declarations have separate
provenance. Original capture times and host intake times are not interchangeable. Missing frames,
capacity limits, failed samples and unrecorded activity remain visible as coverage limits. A
capture error cannot retry the experiment or change its scientific outcome.

The existing observation archive stays version 1. Its captured images adapt to the same Project
Replay model, retaining source-step links when actually recorded. Several frames can belong to
one observation; a frame's position does not invent a Notebook step. Project playback uses actual
frame intervals. Browsing another material pauses its clock; the frame choice survives returning.

Results are fixed immutable file Versions with source, scope, and stage. A recording-level
attachment is not silently assigned to the current step. An unspecified stage is not inferred to
be final from a name, timestamp or terminal Run. HTML results are sanitized, sandboxed without
scripts, and denied external connections. Normal project/runtime HTML keeps its existing policy.

File/frame questions carry an independent `recorded-observation-file` reference containing the
receiving recording and exact file Version/checksum. They do not fabricate a step. A late Ask
reply after navigation cannot attach itself to the replacement draft. The browser viewer retains
and exposes the same file selection for Codex through a dedicated read-only selection endpoint.

## Scope of this delivery

This delivery does not install a DOM recorder, execute bundled research JavaScript inside Replay,
or render MP4. Recording timestamps and independent media references leave room for subsequent
video or DOM adapters and an MP4 export renderer without coupling recording to Notebook or to a
particular research project. State-derived Tuanzi reports remain labeled as derived output; only
real captures claim to show the observed project UI.

Tuanzi acceptance materials are maintained outside this repository in a fresh research directory,
using source commit `b6d5810fef3baac1195c980fe728ce7a8a69408b`. Engineering offline runs do not
establish scientific reproduction of the external-model experiment. The installed Test release
and actual sandbox/export/import validation are recorded separately after execution.

## Installed acceptance, 2026-10-07

The isolated Test client executed the fixed Tuanzi rule/local plan in ordinary writable Sessions
through the SDK. Both bounded runs completed and their environments were explicitly released.
The first pass saved one screenshot; its two-frame acceptance failed and was retained. The second
pass saved two actual host-view screenshots (the final Canvas world and diagnostics), six declared
states and four declared state-change events. These screenshots are not a continuous recording of
the four actions, and the derived HTML report is not a captured project frame. External provider
calls were zero; scientific reproduction remains `NOT_EVALUATED`.

The second result package was exported and imported into a new Project/Session. Both recording
formats, media and results resolved to new receiving Versions with byte-identical checksums.
The SDK read/view/file-selection checks left environment, operation and Notebook metadata
unchanged. This checks the persistent execution boundary; no global in-memory service census API
is available. The package SHA-256 is
`e22a6aa68869b02ed516e3ceca360962117a0e06d4e3ef327e334cb69c394384`.

The Codex browser displayed the archived Canvas image after service shutdown, switched between
the two frames, and displayed the saved HTML as inert content. Asking about that HTML produced
an exact `recorded-observation-file` selection readable by the SDK. A real narrow-browser check
also exposed a first-click loss when the inspection banner moved the material tabs; the regression
uses an actual pointer press/release and verifies a single click selects Project Replay or Results.
Local receipts and the final installed release are retained in the fresh Tuanzi acceptance
directory, outside the source repository. No upstream submission is part of this acceptance.
