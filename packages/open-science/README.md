# @aipoch/open-science

Node.js SDK and command-line client for an Open Science daemon running on the local machine.

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
  permissionProfile: 'auto'
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
```

Session updates use `revision`; Project-default updates use `updatedAt`. Both reject stale writes.
Project defaults are copied only when a Session is created, with precedence `startRun` request,
Project defaults, application settings, then provider default. Agent-routing updates are atomic and
never return provider credentials.

SDK requests have a 30-second default deadline that remains active while the response body is being
consumed. Override the client default with `requestTimeoutMs`, or pass `{ signal, timeoutMs }` as the
final options argument to an individual request method. `downloadArtifact` keeps the deadline active
while its returned `Response` body is streaming. `waitForRun` applies its overall `timeoutMs` and
caller signal to every in-flight polling request as well as the delay between polls.

For retry-safe project creation and Run starts, pass the same `idempotencyKey` in the final options
argument on every attempt. The daemon replays the first response for up to 24 hours while it remains
running; reusing a key with a different request body fails with `idempotency_conflict`. If the
bounded replay registry is full, a new unique key fails with `idempotency_unavailable` rather than
evicting an existing guarantee.

The `project` request field and the `listSessions(projectId)` argument both require a Project ID.
Project display names are not accepted as routing identifiers.

SDK and HTTP callers must supply an absolute `cwd`. Open Science canonicalizes and validates it,
persists it as the Session working directory, and returns the effective path on every Run. Supplying
`cwd` with `sessionId` is allowed only when both paths resolve to the same directory. Omit `cwd` to
use a managed workspace. External working directories remain caller-owned and are never removed by
Open Science.

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

The client discovers the local daemon and reads its authentication token from the Open Science config
directory. Tokens are sent in request headers and are never included in normal command output.
