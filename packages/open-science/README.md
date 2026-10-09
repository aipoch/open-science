# @aipoch/open-science

Node.js SDK and command-line client for an Open-Science daemon running on the local machine.

## Documentation

- [CLI guide](./CLI.md) - installation, daemon lifecycle, task automation, artifacts, and exit codes

## SDK quick start

```js
import { connectToOpenScience } from '@aipoch/open-science'

const client = await connectToOpenScience()
const run = await client.startRun({
  project: 'systematic-review',
  prompt: 'Summarize the evidence.',
  cwd: '/absolute/path/to/research',
  permissionProfile: 'auto',
  permissionPrompts: 'none' // Deny requests that would require a human; keep existing permission rules.
})
const result = await client.waitForRun(run.id)
console.log(result.output)
```

Session, Project-default, and global Agent-routing configuration use the same authenticated local
API:

```js
const configuration = await client.getSessionConfiguration(run.sessionId)
await client.updateSessionConfiguration(run.sessionId, {
  expectedRevision: configuration.revision,
  memoryEnabled: false
})

const defaults = await client.getProjectSessionDefaults('systematic-review')
await client.updateProjectSessionDefaults('systematic-review', {
  expectedUpdatedAt: defaults.updatedAt,
  patch: { permissionProfile: 'auto' }
})

await client.updateAgentRouting({
  framework: 'codex',
  reviewer: { mode: 'inherit' },
  subagent: { mode: 'inherit' }
})

const runtimes = await client.listRuntimes()
```

Session updates use `revision`; Project-default updates use `updatedAt`. Both reject stale writes.
Project defaults are copied only when a Session is created, with precedence `startRun` request,
Project defaults, application settings, then provider default. Agent-routing updates are atomic and
never return provider credentials.

Agent runtime listings expose only framework, readiness, version, and managed/external source. They
do not expose executable paths.

SDK requests have a 30-second default deadline that remains active while the response body is being
consumed. Override the client default with `requestTimeoutMs`, or pass `{ signal, timeoutMs }` as the
final options argument to an individual request method. `downloadArtifact` keeps the deadline active
while its returned `Response` body is streaming. `waitForRun` applies its overall `timeoutMs` and
caller signal to every in-flight polling request as well as the delay between polls. Each poll is
bounded by the smaller of the client's `requestTimeoutMs` and the remaining total wait budget.
A request timeout fails the wait immediately; it does not silently retry. Without a total
`timeoutMs`, waiting has no overall deadline. `pollIntervalMs` defaults to 250 and must be a finite
positive number.

Aborting or timing out a wait stops only the local observation. The Run may continue on the host;
call `getRun(run.id)` to check it, or explicitly call `cancelRun(run.id)` to stop it. With
`returnOnAttention: true`, a returned Run may still have `status: 'running'` and need a Plan decision before it can finish. Ordinary permissions do not populate Run attention.

```js
const waitController = new AbortController()
const result = await client.waitForRun(run.id, {
  timeoutMs: 120_000, // Total wait budget; each poll still has the client request deadline.
  pollIntervalMs: 500,
  returnOnAttention: true,
  signal: waitController.signal // Aborts observation; does not call cancelRun.
})
console.log(result.status, result.attention)
```

For retry-safe project creation and Run starts, pass the same `idempotencyKey` in the final options
argument on every attempt. The daemon replays the first response for up to 24 hours while it remains
running; reusing a key with a different request body fails with `idempotency_conflict`. If the
bounded replay registry is full, a new unique key fails with `idempotency_unavailable` rather than
evicting an existing guarantee. A lost response after submission does not prove that the Run was
not started. Retry with the original key and identical request while that daemon is still running,
or query the known Run ID. The replay registry is process-local: a daemon restart loses it, so
reusing a key after restart is not a durable exactly-once guarantee.

The `project` request field and the `listSessions(projectId)` argument both require a Project ID.
Project display names are not accepted as routing identifiers.

SDK and HTTP callers must supply an absolute `cwd`. Open-Science canonicalizes and validates it,
persists it as the Session working directory, and returns the effective path on every Run. Supplying
`cwd` with `sessionId` is allowed only when both paths resolve to the same directory. Omit `cwd` to
use a managed workspace. External working directories remain caller-owned and are never removed by
Open-Science.

For live automation feedback, subscribe before starting the Run. `run.progress` reports ordered
provider-neutral phases and emits a progress heartbeat every ten seconds until the first visible
provider output. This progress heartbeat describes Run activity; it is separate from the filtered
connection heartbeat that keeps an otherwise-idle WebSocket alive. The timer starts after Task has
prepared the Session and registered its Run; Session creation or resume time before registration is
outside this event stream:

```js
const abortController = new AbortController()
const events = client.events({ signal: abortController.signal })
await events.ready

const progress = (async () => {
  for await (const event of events) {
    if (event.type === 'run.progress') {
      console.log(event.data.phase, event.data.elapsedMs, event.data.heartbeat)
    }
  }
})()

const observedRun = await client.startRun({
  project: 'systematic-review',
  prompt: 'Summarize the evidence.',
  permissionProfile: 'auto'
})
const observedResult = await client.waitForRun(observedRun.id)
abortController.abort()
await progress
console.log(observedResult.output)
```

`events.ready` rejects if the socket fails, closes, or receives no liveness frame before opening.
After opening, the iterator fails with `timeout` when no event or connection heartbeat arrives for
30 seconds. Pass `idleTimeoutMs` to change that connection-liveness window; it does not limit model,
Notebook, permission-approval, or other Run duration. Connection heartbeats are control frames and
are not yielded to consumers. Malformed frames and a consumer backlog above 1024 events terminate
the iterator with `event_stream_invalid_message` or `event_stream_overflow` instead of throwing
outside the iterator or growing memory without a bound.

Every Run event includes top-level `sequence`, `runId`, `sessionId`, and `projectId` fields in
addition to its existing `type` and `data`. After an established socket closes unexpectedly, the SDK
reconnects with its last sequence and the daemon replays the retained suffix. Replay is bounded and
process-local. If the daemon restarted or the suffix was evicted, the iterator yields
`stream.resync-required` with reason `stream-changed` or `cursor-expired`; read the Run or Session
through the HTTP API to restore authoritative state.

Plan First runs can opt into actionable waiting with returnOnAttention. When the returned Run has
attention.kind equal to plan-approval, use getSessionPlan and respondSessionPlan. Calling waitForRun
without returnOnAttention keeps the original terminal-only behavior.

Automatic review and Specialist binding reuse existing Session JSON fields. Delegation adds
delegationPolicy with values allow or deny; an omitted historical value restores as allow.

To stop a still-running task instead of waiting for it, cancel it explicitly. Cancellation waits for
provider work and application finalization to drain before returning the terminal Run:

```js
const cancelled = await client.cancelRun(run.id)
console.log(cancelled.status) // cancelled
```

The client discovers the local daemon and reads its authentication token from the Open-Science config
directory. Tokens are sent in request headers and are never included in normal command output.

### Automation new-session defaults

`project session-defaults show|update` manages defaults for new Sessions created through the
Task CLI/API. Explicit run options override these defaults. Existing Sessions and desktop New
conversation drafts are not changed.

`--provider-default-model` keeps following the provider-owned default instead of pinning the
first model in its catalog. An explicit `--model` stays fixed. If a saved selection becomes
unavailable, choose a replacement explicitly or wait for it to become available again.

## Managed execution of research materials

`client.execution` uses the receiving machine's authenticated local service. It prepares immutable
research materials in an Open-Science managed environment and executes a bounded command through
Notebook. It does not start an Agent/model task. Use an existing writable Session, or
`execution.createSession({ projectId, requestId, title })` to create an ordinary local Session.
The source research and destination Session can differ within the authorized Project.

```js
const scope = { projectId: 'your-project-id', sessionId: 'your-writable-session-id' }
const { runtimes, diagnostics } = await client.execution.runtimes()
if (!runtimes.length) {
  console.log(diagnostics?.issues)
  throw new Error('Open Science needs an available independent Node runtime.')
}
const materials = await client.execution.inspectMaterials({
  ...scope,
  sourceSessionId: 'imported-research-session-id'
})
// Select an available immutable Version reported by materials.versions.
const environment = await client.execution.prepare({
  ...scope,
  requestId: 'prepare-analysis-1',
  sourceSessionId: materials.source.sessionId,
  sourceIdentity: materials.source.identity,
  runtimeId: runtimes[0].runtimeId,
  materials: { files: [{ versionId: 'selected-version-id', restorePath: 'input.json' }] }
})
const operation = await client.execution.execute({
  ...scope,
  environmentId: environment.environmentId,
  requestId: 'analysis-1',
  command: 'node --version',
  timeoutMs: 10_000
})
const latest = await client.execution.waitOperation({
  ...scope,
  requestId: operation.requestId,
  timeoutMs: 60_000
})
console.log(latest)
```

For a real reproduction, select the original research plan and call
For an explicitly selected package offline plan, use
`execution.inspectOfflinePlans({...scope, sourceSessionId})`, then
`execution.executeOfflinePlan({...scope, sourceSessionId, sourceIdentity, planVersionId, requestId})`.
Use an ordinary writable destination Session; the source can be an imported read-only research.
Main freezes the plan/material versions and derives the command and offline confinement. Commands,
profiles, credentials and network overrides are rejected. The response is the normal operation
snapshot plus `environmentId`; observe/cancel by the same `requestId` and release the environment
when outputs are published. CLI equivalents are `execution offline-plans` and `execution offline-run`.
The project process is offline; an Agent orchestrating it may still use a model. These are new
results under declared substitutions, not historical playback or proof of full reproduction.

`execution.preflight({...scope, sourceSessionId, sourceIdentity, descriptorVersionId, planKey})`.
This read-only check reports missing materials, compatible runtimes and credential slots; it never
substitutes an offline Replay demonstration. `ready` means local prerequisites, not validated remote
credentials or a reproduced scientific conclusion.

If credentials or service configuration are needed, call
`execution.requestConfiguration({...selection, requestId: 'configure-original-1'})`. Open Science's
trusted desktop displays the exact research/plan form; an external client can poll
`execution.getConfiguration({...scope, configurationId})`. A `configured` snapshot supplies an opaque
`profileId` to pass to `execution.execute`. Dismissal, expiry, and successful configuration never
execute a run. There is no API to submit raw credentials: do not put secrets in chat, commands or
`.env` artifacts. Local profiles bind source identity, description checksum and plan; declared
service hosts are a ceiling and still require the existing network permission flow. Prepared
executions without a profile receive no external service host permission. Profile configuration
records non-secret variables and declared condition changes in the new execution receipt. Known
credential values are removed from stdout/stderr; output publication stops if a selected file
contains a configured value or its URL/base64 encoding. This protects accidental disclosure; it is
not a guarantee against arbitrary transformations performed by malicious workload code.

The initial native-service target is macOS with an independently installed Node 22 or newer.
Discovery uses the application's launch PATH and common host locations, including `~/.local/bin`.
An empty runtime list means the application cannot currently find a compatible runtime; make the
existing Node available to the application and restart it before retrying. The client does not
install a runtime or substitute Electron. For an isolated Test installation, explicitly select its
`configRoot` when connecting so execution and package operations use the intended application.

Runtime discovery's `available` means a compatible independent Node was found; it does not establish
that a particular plan or local HTTP service is supported. Optional `diagnostics` reports
`nativeServiceSupported` and `issues` with stable `code`, fixed `message`, and suggested `action`.
Codes distinguish `node_not_found`, `node_version_unsupported`, `node_host_mismatch`,
`node_not_independent`, `node_unusable`, and `native_service_unsupported`. The same diagnostics reach
the CLI and internal `host.managedExecution.runtimes()` without candidate paths, environment values,
or raw probe errors. Older applications may omit diagnostics. Inspect them before executing a plan;
they do not authorize or perform installation.

Save the actual execution scope as an ordinary output Artifact: include the selected `sourceIdentity`,
descriptor identity or `planKey` when present, declared scope, actual parameters, known missing
materials or alternative conditions, and limits on what the results establish. Declare that report
in `outputs` so it travels with the result package. This is a record of the chosen execution, not a
new `.science` field. External request/result records do not automatically capture the complete
Codex conversation.

Use a new `requestId` for new work. Retrying an identical preparation or execution with its existing
ID retrieves the same work; reusing that ID for different input is rejected. The optional HTTP
`idempotencyKey` is an additional transport retry safeguard, not a replacement for the request ID.

`waitOperation` waits at most 60 seconds and returns the current snapshot, which may still be
running. Aborting an SDK request only stops waiting. Explicitly use `cancelOperation` to stop work;
use `releaseEnvironment` after work settles and outputs are collected to release its managed files.
A `cleanup-pending` state means cleanup has not yet been verified. Release can also return a retained
`pendingCollection` while the original turn has saved files but has not published them yet. Requested
cleanup completes automatically after every exact output Version, including the execution/collection
receipt, is published. Pending outputs are preserved until then; do not delete files outside this API.

If output publication did not finish, inspect `getEnvironment` for `pendingCollection.collectionId`.
`collectOutputs({ projectId, sessionId, environmentId, collectionId, requestId })` saves the retained
outputs without rerunning the experiment. It returns an operation start snapshot: observe the same
`requestId` using `getOperation` or `waitOperation`, including after an HTTP observation timeout.
Keep the collection's request ID for identical retries. Collection is separate from `execute`;
never rerun a command merely to recover publication. If collection reports that saved Versions still
await publication, finish or recover the original turn's finalization before trying collection again.

Inside that same active producing turn, an exact output `versionId` may be read using
`host.artifactPath(versionId)` through the turn's producer authority. This does not publish it early:
the ordinary Artifact catalog and other readers still expose only published Versions.

Only explicit `discardOutputs({ projectId, sessionId, environmentId, collectionId })` abandons the
identified pending collection. It returns the current environment; inspect it before release.
Already published immutable Artifacts remain available. Neither request accepts `provenance`,
`recoveryAuthority` or `writeAttempt`; these are application-owned authorities, not public inputs.

The command starts in its writable work directory. `OPEN_SCIENCE_INPUT_DIR` refers to restored,
read-only inputs, `OPEN_SCIENCE_OUTPUT_DIR` to the output directory, and `OPEN_SCIENCE_NODE` to the
selected independent Node executable. Declare output paths relative to the output directory in
`outputs` to publish immutable Session artifacts. Runtime paths, filesystem grants and execution
capabilities cannot be supplied through this API. The first supported sandbox is macOS; remote
callers are rejected. Optional local HTTP service adaptation uses a managed Unix socket and does
not expose a public TCP endpoint.

## Observe an existing research run

`client.observations` opens a scoped Replay viewer for existing work. Opening a viewer does not
start a Run, create a Session, rerun an experiment, or open a browser automatically. Use an exact
`operationId` returned by `execution.execute`, or an exact `executionInvocationId` or `runId`;
the application never guesses the latest Run in a Session.

```js
const viewer = await client.observations.open({
  target: { ...scope, operationId: operation.operationId },
  allowInteraction: false,
  allowCancel: false
})
console.log(viewer.url) // Open this local URL in Codex's browser panel or a browser.
const snapshot = await client.observations.snapshot({ viewerId: viewer.viewerId })
const update = await client.observations.changes({
  viewerId: viewer.viewerId,
  cursor: snapshot.cursor
})
if (update.kind === 'resync') {
  console.log(update.snapshot) // Replace the previous snapshot after reconnecting or cursor expiry.
} else {
  console.log(update.changes) // Ordered revisions; do not invent progress between observations.
}
// The viewer's “Ask about this step” selection is available to this same authenticated SDK caller.
const selected = await client.observations.selection({ viewerId: viewer.viewerId })
if (selected) console.log(selected.snapshot)
// Revoke viewing access when finished. The underlying experiment continues.
await client.observations.revoke({ viewerId: viewer.viewerId })
```

`open` accepts `target`, `allowInteraction`, `allowCancel`, `allowCapture`, and `allowRecording`.
Permissions default to false. Interactive project controls may change the running experiment and
require explicit `allowInteraction: true`; the viewer's stop control requires `allowCancel: true`
separately. Image capture and continuous recording require their own respective permissions.
Pausing Replay or revoking a viewer does not pause or cancel the experiment. An aborted or timed-out
SDK request only stops waiting. Use the explicit execution cancellation API when stopping work is
intended.

`history` returns the viewer's bounded retained observations with `coverage: 'process-local'` and a
`truncated` indicator. This is sampled evidence, not a claim that every event before opening the
viewer was recorded. `select({ viewerId, cursor, stepId })` freezes an actually retained step; an
expired cursor must be refreshed, never silently substituted with the latest output. `selection`
returns that frozen snapshot or `null`, so Codex can discuss the exact selected log cutoff and
Artifact Versions. Different viewers retain independent selections.

All methods use the authenticated local service and the viewer's original caller identity and
authorization. Viewing links and browser grants expire; reopen a viewer after expiry or application
restart. Keep its `viewerId` while observing, but do not save its temporary URL in research Artifacts
or `.science` files. Saved process records and media are separate ordinary Artifacts.

A managed command can declare its project Web interface without changing the package protocol:

```js
const projectOperation = await client.execution.execute({
  ...scope,
  environmentId: environment.environmentId,
  requestId: 'interactive-analysis-1',
  command: '"$OPEN_SCIENCE_NODE" "$OPEN_SCIENCE_INPUT_DIR/server.mjs"',
  timeoutMs: 120_000,
  localServicePort: 8080,
  projectView: { title: 'Experiment controls', entryPath: '/' }
})
const interactiveViewer = await client.observations.open({
  target: { ...scope, operationId: projectOperation.operationId },
  allowInteraction: true,
  allowCancel: true
})
console.log(interactiveViewer.url)
```

The prepared project must actually provide the declared local service; this declaration does not
install dependencies or create a server. `projectView` requires `localServicePort >= 1024` and accepts
`title`, `entryPath`, optional project-specific `allowedRequestHeaders`, `webSocketProtocols`, and
explicit per-run `adaptFrameAncestors`. The application owns routing, credentials and service
lifetime; these cannot be supplied as project-view options. A closed Run's page is not a historical
capture of that Run.

## Local `.science` package transfers

`client.packages` uses explicit file paths on the receiving local machine. It shares the desktop
package format, validation, locks and import receipt. Importing preserves read-only research history
and does not execute its contents. Inspect first, review the returned summary and omissions, then
explicitly commit the returned handle:

```js
const review = await client.packages.preflightImport(
  {
    filePath: '/absolute/path/research.science',
    target: { projectName: 'Imported research' } // Or { projectId: 'existing-project-id' }
  },
  { idempotencyKey: 'inspect-research-1', timeoutMs: 120_000 }
)
console.log(review.preview, review.expiresAt)
// After reviewing this exact preview:
const imported = await client.packages.commitImport({ preflightId: review.preflightId })
await client.packages.export(
  {
    projectId: imported.projectId,
    sessionId: imported.sessionId,
    filePath: '/absolute/path/shared-research.science'
  },
  { timeoutMs: 120_000 }
)
```

Preflight stages and validates the archive but publishes no Project or Session. Its handle belongs to
the caller and expires after ten minutes by default; commit uses the staged archive, even if the
original file changes. Use `cancelImport({ preflightId })` to discard it. Only one transfer may be
active at a time. Shutdown discards an uncommitted preflight; review again after restarting.
Retrying a committed handle within the same service lifetime returns its imported identity without
importing twice. Use HTTP `idempotencyKey` options when retrying a lost preflight or export response;
a new preflight intentionally starts a new review.

Export requires a new destination filename and never overwrites an existing file. Optional
`excludedStorageKeys` and `includePdfNotes` use the existing package selection rules; sensitive
content checks remain enforced. A successful transfer can return `cleanupPending: true` when its
publication succeeded but private staging cleanup must be retried. Remote callers cannot use host
file paths. These methods do not open desktop dialogs or weaken desktop command restrictions.

### Saved Replay observations

Set `recordObservation: true` on `execution.execute` to capture bounded process observations as
ordinary Artifacts. This option is independent of `projectView`; command-line projects can record
without a Web service. Opening or closing a viewer does not start or stop recording or execution.
Execution, capture, and Artifact publication have separate outcomes. Missing captures are not
reconstructed from the current project page.

After publication, or after importing the result `.science`, open the receiving Artifact Version:

```js
const recorded = await client.observations.openRecorded({
  target: { projectId, sessionId, artifactId, versionId }
})
// Open recorded.url in the host's ordinary browser pane.
const evidence = await client.observations.recording({ viewerId: recorded.viewerId })
const selected = await client.observations.recordingSelection({ viewerId: recorded.viewerId })
```

The browser's Ask action freezes an exact recorded step for the creating SDK caller. Copying that
reference does not automatically send a message to Codex. Source IDs identify author evidence only;
the current receiving Artifact/Version controls reads. This uses ordinary Artifact bytes and does
not add mandatory `.science` entries or change native recipes.

For independent project recordings, use `openRecorded({ target, format: 'project-recording' })`.
The viewer format is fixed when opened; `recording` returns either an observation archive or a
project recording. Both are read-only and never start a program, prepare an environment, or
reconnect to an author-machine service. `readRecorded({ target })` and
`readProjectRecording({ target })` read the same verified content without opening a viewer.

Results and captured images have their own file evidence. Call
`selectRecordedFile({ target, mediaKey, format: 'project-recording' })`, or use
`selectRecordingFile({ viewerId, mediaKey })` and read `recordingFileSelection({ viewerId })`.
These return the exact receiving Artifact Version and checksum without inventing a Notebook step.
An unspecified result stage is not inferred to mean a final result.

With `recordObservation: true`, declared image outputs and an optional declared
`project-recording-data.json` are also sampled into an independent project recording. No browser
or Notebook observation is required. Missing or failed captures are reported separately from the
experiment result; frames preserve capture provenance and structured states remain author-declared.
This is a bounded sampled recording, not a complete video of every screen update.

### Continuous project-page recording

`projectRecordings` controls recording separately from execution and historical playback. Start
from an authorized live viewer opened with `allowRecording: true`. `inspect` reports whether the
current desktop project page can be recorded and lists eligible desktop sources for the exact same
execution. Codex can explicitly choose that Open Science page; this does not record Codex's browser
tab or the entire desktop. Start recording before the experimental actions you want to preserve.

```js
const inspection = await client.projectRecordings.inspect({ viewerId: viewer.viewerId })
const recording = await client.projectRecordings.start({
  viewerId: viewer.viewerId,
  request: { requestId: 'record-1', sourceViewId: inspection.sources?.[0]?.sourceViewId }
})
// Interact with the recorded Open Science project page, or run the experiment.
const saved = await client.projectRecordings.stop({
  viewerId: viewer.viewerId,
  request: { requestId: 'stop-1', recordingId: recording.recordingId }
})
// `finalized` above describes capture, not Artifact publication. Keep the original execution
// requestId from execute/executeOfflinePlan; the recording requestId is a different identity.
const operationRef = { projectId, sessionId, requestId: executionRequestId }
let operation = await client.execution.getOperation(operationRef)
while (operation && ['admitting', 'running', 'cancelling'].includes(operation.status)) {
  operation = await client.execution.waitOperation({ ...operationRef, timeoutMs: 30000 })
}
if (!operation || operation.recoveryPending) {
  throw new Error('Inspect or recover the original execution publication before opening Replay.')
}
if (saved.target) {
  const playback = await client.projectRecordings.openRecorded({ target: saved.target })
  // Open playback.url in the host's browser panel; the SDK does not open it automatically.
  const moment = await client.projectRecordings.selectMoment({
    viewerId: playback.viewerId,
    offsetMs: 1500
  })
  console.log(moment.resource, moment.segmentOffsetMs)
}
```

`pause`, `resume`, and `stop` require an idempotent `requestId` and the `recordingId` returned by
`start`. `status({ viewerId })` returns the latest recording even after its source page disappears.
Stopping recording does not stop the experiment. A `finalized` recording has finished collecting
and saving evidence; its Artifacts are published when the hosting execution or Agent turn ends and
finalizes its outputs. Before that, `read` and `openRecorded` may return `unavailable` for the saved
exact target. Use the original execution's `getOperation`/`waitOperation` reference to wait for a
terminal status. An observation timeout only ends the wait. If output publication remains pending
after termination, inspect or recover the original finalization; do not rerun the experiment or
recording. Historical reads require published Versions and never acquire the producing turn's
private read authority.

Recorded segments are independently playable, bounded WebM Artifacts, indexed by ordinary
`open-science-web-recording` JSON. Immutable checkpoints and the final index have distinct filenames;
Replay discovery selects the final index or the newest available checkpoint. The `.science`
container rules do not change. Import resolves media against receiving immutable Versions and
checksums; recording timestamps never authorize a Notebook step, an executable page, or a service.

`read({ target })` returns the imported index and resolved media. `selection({ viewerId })` returns
the last explicitly selected immutable moment, including the index checksum, segment Version, and
relative playback time. The browser offers a copyable reference; it cannot automatically write to
the Codex conversation. Playback only serves recorded media and declares missing intervals. Existing
sampled-image recordings remain supported. Audio, arbitrary external browser tabs, DOM reconstruction,
and MP4 export are not provided by this API.

### Read current captured images from Codex or another local agent

`observations.captures` lists images already captured for the active Run. It does not take a new
picture, start work, or create a Session. A viewer needs its existing read authorization; creating
images separately requires `allowCapture: true` and an available capture capability. External
agents can request declared project exports. Host screenshots require an authorized Electron host
and are advertised by `captureOptions`, rather than assumed available in every browser.

```js
import { createHash } from 'node:crypto'

const frames = await client.observations.captures({ viewerId: viewer.viewerId })
const frame = frames.at(-1)
if (frame) {
  const chunks = []
  let offset = 0
  for (;;) {
    const chunk = await client.observations.captureContent({
      viewerId: viewer.viewerId,
      captureId: frame.captureId,
      offset,
      length: 1048576
    })
    if (chunk.checksum !== frame.checksum || chunk.sizeBytes !== frame.sizeBytes)
      throw new Error('Captured image identity changed')
    chunks.push(Buffer.from(chunk.dataBase64, 'base64'))
    if (chunk.nextOffset === undefined) break
    offset = chunk.nextOffset
  }
  const image = Buffer.concat(chunks)
  if (
    image.length !== frame.sizeBytes ||
    createHash('sha256').update(image).digest('hex') !== frame.checksum
  )
    throw new Error('Captured image verification failed')
  // The agent can now inspect or display these verified bytes using its own image tools.
}
```

Each chunk defaults to, and cannot exceed, 1 MiB. `checksum` and `sizeBytes` describe the entire
image; `offset` and `nextOffset` describe byte positions. Every read rechecks viewer authorization.
Only `viewerId` and `captureId` identify content; URLs, paths, alternative scopes and producer IDs
are not accepted. This live cache is released when the Run ends. After publication, read the saved
Artifact Version through the recorded observation workflow instead. `awaiting-publication` means
the ordinary Artifact has been saved but its owning turn has not published it yet.

`capture` returns an `ObservationViewerCapture`. Its optional `viewerEvidence` is an explicit
association with the initiating viewer's real observation, independent of the recording's private
`stepKey`; other viewers' cursors must not be equated. `capture.startedAt` and `finishedAt` record
actual acquisition time, while an unchanged observation may retain an earlier `observedAt`.

### Read a complete research Replay

`client.replays` opens the receiving Project/Session as a scoped, read-only browser view. It
includes saved original conversation, Notebook records, recorded project footage, and saved
results. It does not start a runtime, create a discussion Session, call a provider, or run any
instructions contained in the historical conversation. Use the existing execution APIs only
when the user separately requests a new run.

```js
const view = await client.replays.open({
  target: { projectId: importedProjectId, sessionId: importedSessionId }
})
// Open view.url in your browser/Codex browser panel. The one-time bootstrap URL must not be shared.
const overview = await client.replays.read({ viewerId: view.viewerId, query: { kind: 'overview' } })
const page = await client.replays.read({
  viewerId: view.viewerId,
  query: { kind: 'steps', limit: 20 }
})
const step = await client.replays.read({
  viewerId: view.viewerId,
  query: { kind: 'step', branchId: page.branchId, stepId: page.steps[0].id }
})
// After the user chooses “Ask about this step/moment” in the browser:
const selection = await client.replays.selection({ viewerId: view.viewerId })
// selection.position and exact evidence versions remain fixed as playback continues.
// Read Notebook details only for run IDs present in the chosen step (at most eight per request).
// Read saved result bytes by resourceId, in chunks of at most 262144 bytes.
await client.replays.revoke({ viewerId: view.viewerId })
```

Step pages accept `offset`/`limit` (maximum 50) and return `nextOffset`. Exact resource reads return
`dataBase64` and `nextOffset`. Browser media uses authenticated range requests. Source identities
always refer to the receiving import; source package identities cannot authorize unrelated local
files. Missing, oversized, or unshared evidence is not substituted with a current file.

Each viewer has its own frozen source snapshot and independent playback position. The viewer
expires after two hours or when its originating authorization becomes invalid; reopening creates
a new snapshot. Up to 16 recent selection snapshots remain addressable with `selectionId` for
that viewer; copied references can be resolved while the viewer remains open. Selection does not
send a message into Codex: the agent reads the chosen evidence when the user asks a question.

For a step plus context exceeding 128 KiB, `read({query:{kind:'step',...}})` returns
`step: null`, `contentTruncated: true`, and `contentQuery`. Follow that query with
`kind: 'step-content'` to read the exact serialized step JSON in character chunks (maximum
32768 per request); concatenate chunks using `nextOffset` before parsing. This avoids silently
dropping an oversized historical message or injecting it into an agent prompt. Selected evidence
respects the current playback phase: input-only selections exclude recorded outputs. Explicit
saved-resource inspection is labeled separately from the material visible at the current time.
