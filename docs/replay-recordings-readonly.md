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
frame intervals. Embedded materials follow the shared research clock; switching material tabs does
not pause playback. A standalone recording viewer retains its own playback controls.

Results are fixed immutable file Versions with source, scope, and stage. A recording-level
attachment is not silently assigned to the current step. An unspecified stage is not inferred to
be final from a name, timestamp or terminal Run. HTML results are sanitized, sandboxed without
scripts, and denied external connections. Normal project/runtime HTML keeps its existing policy.

File/frame questions carry an independent `recorded-observation-file` reference containing the
receiving recording and exact file Version/checksum. They do not fabricate a step. A late Ask
reply after navigation cannot attach itself to the replacement draft. The browser viewer retains
and exposes the same file selection for Codex through a dedicated read-only selection endpoint.

## Scope and verification

Replay reads captured evidence without running bundled project JavaScript. Image sampling and
browser video are independent recording adapters; see [browser recording](browser-recording.md)
for supported WebM segments, the shared research clock, and exact media selection. DOM recording
and MP4 export are not implemented. Author-declared states and derived reports remain labeled as
such; only actual captures claim to show the observed project interface.

The generic tests verify that imported recording indexes, media, and results resolve through exact
receiving Versions and checksums, including export/import and re-export. Read and selection paths
must leave execution and Notebook state unchanged. Browser tests cover material switching with
actual pointer events; native integration tests cover admitted iframe navigation and context menus.
These engineering checks establish recording and viewing behavior. They do not establish scientific
equivalence between an offline plan and an experiment which used external models or services.
