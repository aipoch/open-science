# @aipoch/agent-harness

Powers the built-in **Open-Science Agent**. The package name and persisted framework ID (`open-science-agent`)
remain independent of the host's display name.

Experimental, independent agent sessions, streaming model/tool events, durable tool ordering,
interrupt/resume, portable history and context compaction. No runtime dependencies, ACP, Electron or
project-specific types. Node.js 22.13+. The core does not access files, credentials or the network;
HTTP support is opt-in through the independent `./chat-completions`, `./responses` and `./messages`
subpaths.

The package keeps execution, provider conversion and host capabilities separate. Project features are
compatibility scenarios, not core types.

The public exports, versioning/recovery guarantees, tested provider/platform scope and reproducible
artifact verification are defined in [the support contract](SUPPORT.md).

## Delegated tasks

`createDelegationTool` composes isolated child sessions using the same package loop. The host supplies
named agents, explicit models/tools/guards/budgets and an authorization callback; parent history and
capabilities are never inherited. Inject `owner.tool` into the parent's tool list, and await
`owner.dispose()` when the owning conversation ends. Concurrent calls are bounded (default four);
excess calls return an error result rather than creating an unbounded queue.

```ts
import { createDelegationTool, openAgentSession, type AgentModel } from '@aipoch/agent-harness'
declare const model: AgentModel
const owner = createDelegationTool({
  agents: {
    reviewer: {
      description: 'Review the supplied text without external tools.',
      session: { model, tools: [], maxSteps: 4, maxOutputTokens: 2048, timeoutMs: 60000 }
    }
  },
  authorize: async () => true // Explicit policy for this configured, tool-free child only.
})
const parent = await openAgentSession({ sessionId: 'parent', model, tools: [owner.tool] })
try {
  await parent.prompt([{ type: 'text', text: 'Ask reviewer to check: 2 + 2 = 4.' }])
} finally {
  await parent.dispose()
  await owner.dispose()
}
```

Final text and portable media share a result allowance (default 16 KiB): UTF-8 text bytes plus
serialized media blocks. Receipt metadata, including per-request usage, is additional. Text is
truncated at a character boundary; oversized media and provider-private file identities are omitted
with `truncated`/`omittedMedia` in the receipt. Media is never byte-truncated or fetched. Inline data
and HTTP(S) references remain content; a short URL is not a bound on remote size or media tokens.
The host must authorize references and configure compatible parent input capabilities. Child stores
and event observers retain full evidence.

A waiting child returns `{ waiting: { type: 'delegation', taskId, agent, parentSessionId,
parentInvocationId } }` after disposing its active session. Waiting requires an explicit child store;
use a durable store if the interaction must survive restart. The parent stores this reference as a
pending interaction; it does not receive all child questions/history or continue model execution.
The trusted host checks the reference against the parent's pending invocation and configured agent,
opens `taskId` with the same child store/capabilities, answers its pending question with `respond`,
and calls `continue`. It disposes the resumed child before submitting a bounded final result through
`parent.respond(parentInvocationId, result)` and `parent.continue()`. Repeated child waits stay with
the host; they are not final results. Do not replay the original `delegate_task` to resume it.

Cancellation propagates and owner disposal waits for active children to drain. Waiting checkpoints
remain host-owned data, without a background worker or occupied execution slot. Durable child IDs
derive from parent session/invocation IDs; existing checkpoints and uncertain effects require explicit
host reconciliation. The package does not spawn or kill processes. Host tools must stop and drain
resources they create before settling, release shared MCP leases without killing sibling sessions,
and confirm process-tree exit before reusing host capacity/workspaces. No abort signal alone proves
remote termination. Process isolation, persistent scheduling, role catalogs and approval UI remain
host responsibilities. The tool definition is version 2; unresolved version-1 calls require the
existing capability-version reconciliation path rather than silent replay.

## Standalone sessions

`openAgentSession` is the package-level execution API. Supply an `AgentModel` and optional authorized
`AgentTool` capabilities. Storage defaults to a private in-memory instance; supply an `AgentStore`
for persistence. The selected store is the single checkpoint authority for that session;
do not drive the same conversation simultaneously through this API and another runtime owner.

```ts
import { openAgentSession, type AgentModel } from '@aipoch/agent-harness'

// Supply your SDK/protocol adapter. This example runs entirely in memory.
declare const model: AgentModel
const session = await openAgentSession({
  sessionId: 'conversation-1',
  model,
  instructions: 'Follow the host instructions and use only the supplied tools.',
  maxSteps: 20,
  maxOutputTokens: 4096,
  timeoutMs: 120_000,
  tools: [
    {
      name: 'sum',
      version: '1',
      description: 'Sum an array of finite numbers.',
      parameters: {
        type: 'object',
        properties: { values: { type: 'array', items: { type: 'number' } } },
        required: ['values'],
        additionalProperties: false
      },
      validate(input) {
        if (
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          Object.keys(input).length !== 1 ||
          !Array.isArray(input.values) ||
          !input.values.every((value) => typeof value === 'number' && Number.isFinite(value))
        )
          throw new Error('Invalid values')
        return input
      },
      authorize: async () => true, // Explicit host policy for this pure arithmetic tool only.
      execute: async (input) => ({
        content: [
          {
            type: 'text',
            text: String(
              (input as { values: number[] }).values.reduce((sum, value) => sum + value, 0)
            )
          }
        ]
      })
    }
  ],
  onEvent(event) {
    if (
      event.type === 'model' &&
      event.purpose !== 'compaction' &&
      event.event.type === 'text-delta'
    )
      process.stdout.write(event.event.text)
  }
})
await session.prompt([{ type: 'text', text: 'Use sum to add 3, 5 and 8.' }])
await session.dispose()
```

While a turn is active, `await session.steer(blocks)` persists a follow-up message in the session
inbox. The active loop consumes queued messages before its next model request, including after a
completed response when the queue arrived during streaming. Cancellation leaves the inbox intact;
the next explicit `continue()` consumes it. Steering is a message queue, not a new capability grant,
and it never interrupts a tool effect or causes a second execution of an acknowledged tool. An idle
session rejects steering; callers that need a durable cross-process inbox must map their store to the
same checkpoint CAS and fence old workers before recovery.

The package check installs a tarball in a fresh directory and executes this model/tool workflow
through both ESM and CommonJS exports, with a deterministic model. The repository's older real
MiniMax smoke uses the low-level helpers below; it is not live certification of every new adapter.

### Model boundary

An adapter exposes an immutable `id`, `capabilities` and `stream(request, signal)`. Convert the
portable messages, instructions, tool schemas and output reserve into your provider's request.
Yield `text-delta`, `reasoning-delta` and `tool-delta` notifications, followed by exactly one `finish`
with complete content/calls, a `complete`, `tools` or `length` reason, and optional normalized usage.
Non-streaming providers can yield a single finish. Partial tool arguments are notifications only;
no tool executes until the full response has been validated and committed to the selected store.
No events may follow finish. Deltas are provisional; only committed messages enter history.
Cross-process durability requires a durable store adapter.

Chat Completions, Responses, Messages, subscription refresh and SDK-specific parsing belong in
adapters, not this loop. The package supplies optional native-fetch Chat Completions, Responses and
Anthropic Messages SSE adapters; an interface alone does not certify a provider.
An existing provider implementation can supply the adapter without bringing its dependencies into the core. Its iterator must acknowledge abort and await cleanup in
`finally`. Adapters must not retry tool execution. Provider HTTP retries/limits are explicit host policy.

`AgentMessage` supports text, image, file, audio and video references. The host authorizes/resolves references and
the adapter converts them; the harness does not fetch arbitrary URLs, read paths or add OCR. Unsupported
input is rejected before contacting the provider. A `summary` is untrusted history evidence, never a
system instruction or permission. Opaque reasoning/signatures belong in `providerState` and are only
replayed to the exact adapter ID. Use a new ID when model/protocol compatibility changes. Switching
adapters preserves portable content and drops foreign state from requests, while retaining the raw
record. Forks copy portable content only. A provider requiring special history repair must implement
that conversion itself rather than assuming all signatures can cross models.

Usage is recorded per request. Missing usage stays unknown, including failed/interrupted requests;
it is not zero. Input/cache field semantics must be normalized by the adapter. Reported usage survives
a later stream failure. `admit(request)` lets the host price the complete request and reject excess
capacity before dispatch. Step exhaustion and a provider length limit return `budget`, not `complete`.

`transformContext(messages, signal)` optionally transforms the message projection before **each**
model step, including after tool results. Await retrieval/pruning here and return portable messages;
input is deeply frozen. The returned history must have valid unique identities and balanced tool
exchanges. Invalid history fails before admission or dispatch. The hook does not edit stored history,
instructions or capabilities. Cancellation waits for its cleanup, like model/tool cleanup. Adapter
state filtering and media checks follow the hook, then `admit` sees the final complete request.
Transforms must not rely on a once-only invocation or mutate the session from inside the hook.

### Tools, interactions and capabilities

Tool definitions carry a version and JSON schema. The host supplies schema validation and mandatory
authorization; the same deeply frozen validated JSON reaches authorization and execution. Approval
scope, sandboxing, credentials, remote jobs and persistent grants stay with the host. The harness
stores started intent before effects and the result before the next model call. Invalid arguments,
missing tools and denial become error results the model can correct. Tool progress can use
`context.update(blocks)`; late or cancelled progress is ignored. Progress is not a durable result.

Optional `guards: ToolGuard[]` enforce host invariants **after authorization and before started intent**.
Each receives the same frozen arguments/context and a frozen tool definition. A guard returns
`'abstain'` to continue or `'deny'` to stop; exceptions and any invalid response also deny. Later
guards cannot overturn a denial, and authorization cannot bypass a guard. Denial becomes a tool error
result with no execution. Guards are snapshotted at session open, are not model-visible schemas, and
must perform checks without tool effects. Read current host policy inside a guard if it can change.
A prompt such as "submit only after review" is not an execution gate: bind readiness to the
session's host-owned workflow state, for example
`guards: [(_args, context, tool) => tool.name === 'submit' && !isReady(context.sessionId) ? 'deny' : 'abstain']`.
Recheck readiness on every invocation; another session's approval must not open this gate.

Return `{ content, isError: true }` for an acknowledged failure. A thrown exception means effects
may be unknown: the invocation blocks continuation until the host verifies the actual result and
calls `reconcile(invocationId, result)`. A lost write acknowledgement also requires reopening and
reading the store; no automatic retry or claimed exactly-once external side effect is provided.

For a human question or Plan review, return `{ waiting: jsonRequest }`. With a durable store this
checkpoint survives a restart. The trusted host validates the user's response, calls `respond(invocationId, result)` once,
then explicitly calls `continue()`. Neither method repeats the original tool. This is a tool-result
continuation boundary, not serialization of a suspended JavaScript stack. If more work is needed
after approval, schedule another authorized tool call. Do not use an interaction answer as an
unrestricted capability grant. Pending tool definitions must still match their version/schema.

Skills can supply instructions/tool definitions or return guidance through a loading tool. A
Connector, REPL, Shell, artifact or literature service is an ordinary host capability. Configure tool
catalogs and system instructions with `configure()` between turns; there is no arbitrary plugin
loader or mutation of the active turn's capability snapshot.

### Persistence, recovery and isolated sessions

Omitting `store` gives each opened instance its own in-memory store, even for identical session IDs.
Use exported `createMemoryAgentStore()` and share its returned instance to reopen/fork sessions in
one process. Reads/writes are cloned and revision updates use atomic CAS. Memory stores support
ephemeral applications as well as tests; they cannot recover across process exits. Pass the same
explicit store when opening a fork. `dispose()` closes the session, not a shared store.

`AgentStore.commit(id, expectedRevision, next)` must implement atomic compare-and-swap,
including create-only when the expected revision is null. Return false only for a confirmed conflict;
throw for storage errors/uncertain acknowledgements. A read-then-unconditional-write is not CAS.
For durable recovery, use a database transaction or an equivalent fenced storage owner and acknowledge
only persisted writes. Checkpoint serialization is JSON; preserve the whole validated versioned value.
The session loop includes no distributed worker lease or database driver; optional file adapters
own their local commit locks.

For longer local sessions, select the optional journal store without changing the session API:

```ts
import { createJournalAgentStore } from '@aipoch/agent-harness'

const store = createJournalAgentStore({
  directory: '/host-owned/session-storage',
  snapshotMinRevisions: 64
})
```

This uses a checksum-protected JSONL baseline plus revision deltas and periodic full snapshots.
Each commit still waits for file fsync. Snapshotting requires both the minimum revision interval and
enough accumulated journal bytes to match the last snapshot size; it does not rewrite full history at
every fixed interval. `load` returns immutable checkpoints. Session writes share immutable history,
copy mutable metadata, and keep every validation and execution-before-effect persistence boundary.
Explicit `snapshot()` and fork still copy complete requested history. Validation and metadata scans
remain proportional to history length; this is not a constant-time or bounded-memory session engine.
Context preparation validates persisted compaction boundaries before encoding message bodies, then
uses the latest summary and uncompacted suffix. Superseded bodies and summaries are still validated
and retained as evidence, but are not serialized into a discarded model projection or kept in a
separate encoded-history cache. Model requests clone their selected messages once and freeze them.
Fork commits may share package-owned immutable content in memory; the returned checkpoint remains
a detached frozen copy, provider-private state is removed, and the child persists independently.
Cold journal replay reads UTF-8 records incrementally with a 256 KiB buffer, preserving checksums,
sequence checks and strict rejection of incomplete tails. One large record and the complete restored
state still require memory; snapshot JSON and explicit full exports are not lazy or bounded in size.
Use `session.inspect()` for frozen operational state (`sessionId`, `revision`, `run`, `pending`,
`requestCount`) without exporting messages, compactions or queued prompt content. It returns an empty
`requests` array by default; `inspect({ requestsFrom: previous.requestCount })` includes the request
receipts from that inclusive index, including unfinished requests. The offset must be a nonnegative
safe integer no greater than the current count and belongs to that same session's append-only history.
Each inspection reads and validates the store, including after disposal, so another owner's committed
revision remains visible. Only the returned fields are cloned; custom-store reads, complete validation
and journal integrity checks can still scale with full history. Inspection does not claim a writer lease
or replace CAS, permission checks or reconciliation of uncertain effects.
The store caches at most 16 recently used sessions and at most 128 MiB of accounted snapshot plus
journal bytes by default (`maxCacheBytes`; zero disables caching). Accounting reuses existing IO
sizes rather than serializing history again. This is a conservative serialized-data allowance,
not a heap/RSS bound; active sessions and an individual cold restore can still be larger. Oversized
entries bypass the cache without evicting useful smaller entries. Other evicted sessions restore
from the same fully validated durable files. A working set exceeding the allowance can increase
cold replay cost; tune the allowance at the store's resource owner, not through user-facing modes.

Use the same adapter/directory after restart. It holds a local per-session lock while reading,
comparing revisions, appending and rotating. Snapshot publication precedes journal reset, so a restart
can read a snapshot alongside the older journal without applying covered records twice. Complete
records have version/revision/checksum validation; missing baselines, partial tails and corruption fail
closed. No damaged tail is silently discarded. A stale lock is not stolen automatically: the host
must verify the previous worker has stopped before removing it or restoring a known-good backup.
`store.delete(sessionId)` permanently removes journal/snapshot content under the same lock.
Stop and drain all workers first. An empty durable tombstone rejects every later commit, including
create-only commits from stale store instances; use a new identity for a new conversation. Deletion
is idempotent and can be retried after interruption. Closing a session does not delete its history.

Never repair storage by retrying uncertain tools. A write error may follow a durable append: reopen
and inspect/recover the session rather than retrying the old commit.

The repository's `scripts/agent-harness-journal-crash.integration.test.ts` kills real child processes
at append, fsync and snapshot/journal replacement boundaries. It verifies that partial journal tails
block reads and writes without being truncated, orphan snapshot temp files do not replace valid
history, and fully appended records survive a lost commit acknowledgement. Stale locks remain until
the isolated test host confirms worker exit and removes its own lock. Recovery preserves completed
tool results and rejects stale revisions. These are controlled process-crash tests, not power-loss
or storage-device write-cache certification.

This local adapter is not a distributed lease or multi-machine database. It relies on local filesystem
exclusive-create locks and atomic rename. Files are synced on all platforms; directory fsync is used
on POSIX and unavailable through this Node path on Windows. Power-loss and Windows/Linux filesystem
behavior still require platform certification. Existing JSON snapshots are not migrated automatically;
the legacy JSON and journal stores must not write the same execution domain concurrently.
Optional `onWrite({kind, bytes})` reports successfully synced payload bytes for diagnostics, not
physical disk IO; observer errors do not change commit success. The store caches immutable session
state until its owner releases the store object, checking snapshot and journal content hashes before
reuse. Equal-size writes can retain identical filesystem timestamps; metadata alone cannot prove
the journal is unchanged. Cache hits avoid decoding/replaying records, but still read and hash the
files under the store lock. Warm validation hashes fixed-size byte buffers instead of allocating
full-history strings; a changed file falls back to full decoding, so this bounds temporary validation
memory without reducing integrity-read bytes. After a successful append, the cache hash is extended from the known
written bytes; publishing a snapshot resets that hash. This avoids rereading the files immediately
after writing them without weakening the next load/commit's full content verification.

`cancel()` aborts the active work and holds admission until model/tool cleanup settles. A new prompt
can then run on the same session if no effects remain uncertain. `dispose()` also permanently closes
this instance. Callbacks ignoring abort keep cleanup pending; the host must terminate its workers.
Do not await session disposal from inside its own tool/observer callback. Cancellation is not an
automatic replay permission. A waiting interaction can still require an explicit answer.

On a cold restart, open the same store key. A checkpoint left `running` requires
`recover(expectedRunId)` **after the host stops/fences the previous worker**. Recovery marks unfinished
requests interrupted, leaves started tools unknown and cancels tools never started. It does not
resend a model request or re-execute tools. CAS fences late commits, but cannot stop external effects
already in progress in another worker. Two ordinary writers cannot admit overlapping turns.

`fork(newSessionId, throughMessageId?)` copies a balanced raw history prefix into a new key without
permissions, model-call charges or provider-private state. It does not copy an unresolved tool batch.
The host opens the child with its own model and capabilities. Delegation and Side chat use these
independent session domains: explicitly pass allowed context, relay messages through a host tool,
propagate cancellation, await children and dispose them. Closing one session does not close shared
models or other sessions. Transient storage cleanup and provider leases remain host-owned.

`compact()` reuses the balanced-prefix algorithm below, appends a summary with source references,
retains raw messages, and rebuilds the projection on reload. Its `measure(request)` includes system
instructions, tools and media; the host supplies accurate model-specific pricing. `summarize` receives
history only, with cancellation, and must use a separately budgeted tool-free summarizer. Summarizer
usage for manual `compact()` is host-owned. Call manual `compact()` between turns; opt-in automatic
compaction below runs inside the existing turn and records summary usage. `compact` measures the
canonical projection and does not invoke `transformContext`;
account for retrieval/transform overhead in the final `admit` check before every request.
The optional `keepRecentTokens` target uses the same measurement units; automatic compaction defaults
to 20% of usable input space, capped at 20,000. `keepRecentItems` remains a minimum; use 1 for the
token-based policy with balanced tool exchanges. Mandatory user input or a recent tool batch that
cannot fit still returns `budget`. No provider-native opaque checkpoint is needed.
`AgentSession` always preserves the latest consecutive user messages verbatim. The lower-level
`compactContext` primitive retains its prefix-replacement default; independent storage owners can
opt into `preserveLatestUser` only when they persist `proposal.preserved` with the replacement.

Observers receive immutable notifications. Exceptions/rejected observer promises are reported through
`onObserverError` and do not change execution or repeat effects. A checkpoint event contains private
conversation data, including provider state: UI adapters should deliberately select what to display.

The repository's `scripts/agent-harness-recovery.integration.test.ts` exercises recovery using real
Node process termination and MCP SDK stdio connections through these public APIs. It checks effects
whose replies were lost, already-persisted tool results, interrupted automatic summaries, and an MCP
service that exits after a durable effect. Real loopback Streamable HTTP tests also close a connection
or cancel the client while an accepted server job continues. Reconnecting and disposing the old
session do not stop that job or authorize replay. The host must confirm execution has settled,
verify the durable outcome and call `reconcile` before continuing. Late replies do not silently clear
an uncertain invocation. Partial summary text is never committed; missing interrupted-request usage
stays unknown. These tests cover local process and HTTP failures, not cross-machine partitions,
power loss or a distributed exactly-once guarantee.

### Automatic compaction

Set `compaction` explicitly to enable threshold-based compaction before each main model request:

```ts
import type { ModelRequest } from '@aipoch/agent-harness'

// Use accurate model-specific accounting, including instructions, schemas, media and output reserve.
declare const measureTokens: (request: ModelRequest) => number
const session = await openAgentSession({
  sessionId: 'long-task',
  model,
  maxSteps: 20,
  maxOutputTokens: 4096,
  compaction: {
    inputBudget: 80_000,
    keepRecentItems: 8,
    measure: measureTokens,
    maxOutputTokens: 2048,
    admit: async (request) => {
      /* Admit the full summary request against the current model capacity/cost policy. */
    }
  }
})
```

Automatic compaction has one policy: use the current main model, preserve instructions and tool
schemas, summarize the selected old prefix, and append a continuation-checkpoint instruction.
The unchanged recent tail is not sent twice. Custom `transformContext` projections keep the full
transformed summary input so filtering/redaction and balanced custom exchanges remain authoritative.
There is no strategy selector or separate summary model. `configure()` changes the model for both
main requests and future summaries. A new route does not inherit old cache hits.

The checkpoint must contain nonempty `Goal`, `Progress`, `Evidence` and `Next` sections in that order.
The instruction separates confirmed work from unexecuted actions, retains exact evidence references,
drops repetitive diagnostics, and treats later verbatim user instructions as authoritative over
historical intent. A checkpoint does not authorize new work or complete later requests.
Invalid or incomplete output and tool calls fail before any summary replaces history. Reported
usage is retained even on failure. This structural check cannot guarantee factual accuracy.

Keeping the prefix lets a provider reuse previously submitted input. Recent unsent results and the
summary instruction still need processing; cache hits depend on the provider, route and TTL.
After the checkpoint commits, subsequent main requests use the checkpoint plus a balanced recent
tail plus verbatim latest user messages as a new stable prefix. A long current turn can compact
completed tool exchanges while preserving its original user constraints. Consecutive user messages
are retained together. This boundary necessarily changes the old conversational prefix.
Raw history stays intact. The summary request retains tool schemas for caching but has no execution
path for tools. Dynamic retrieval text or reordered schemas can still invalidate the provider cache.

The core measures the final transformed main request. If over budget, it makes at most one
balanced-prefix compaction attempt for that step, then rebuilds/transforms/measures the request.
No progress or a still-oversized tail returns `budget` before main dispatch. There is no blind retry
of provider errors and no replay of executed tools. Source history remains intact. Threshold units
come from `measure`; the package does not invent a tokenizer or infer a context limit from a model name.

Additional `compaction.instructions` describe task-specific evidence to retain; they do not replace
the built-in checkpoint contract. Summary requests carry `purpose: 'compaction'` in checkpoints,
including reported usage and failed/interrupted status; unknown usage remains absent. Summarization
runs under the same exclusive turn and cancellation signal. Its events also carry this purpose, so
UIs can filter them without reading private checkpoints. Summary completion is not task completion.
Separate `compaction` events carry one stable `compactionId`: `started` immediately before
summarization, then `finished` with the actual `CompactionOutcome`, or `failed`/`cancelled`.
Only `finished` with `outcome.status === 'committed'` confirms checkpoint installation; a completed
summary model request alone does not. No lifecycle is emitted when selection skips summarization.
Events contain no summary text and are not replayed when a session reopens. Hosts map them to their
existing compaction UI and keep summary usage in accounting rather than current-context readings.
`admit` on the session still applies to the final main request after compaction. Transforms may be
called again for the rebuilt request and must not assume once-only execution.

For a reproducible local long-session check, run `npm test -- src/long-session-benchmark.test.ts`
from this package. Set `AGENT_HARNESS_BENCHMARK_REPORT_DIR` to an existing output directory to save
per-request fixture measurements and actual file-store commit timings. The three reports explicitly
separate main and summary usage. Their byte-based units and ideal prefix-cache oracle are not
provider token counts or cache hits; they do not compare full external harnesses. Compaction bounds
the model context, while the JSON checkpoint store still rewrites the complete evidence history.
The same benchmark now compares JSON and journal persistence and verifies that model requests,
summary requests and tool effects are unchanged. Journal byte totals include both deltas and snapshots.

### Optional Chat Completions adapter

```ts
import { createChatCompletionsModel } from '@aipoch/agent-harness/chat-completions'

const model = createChatCompletionsModel({
  endpoint: process.env.MODEL_CHAT_COMPLETIONS_URL!, // Complete URL, including /chat/completions.
  model: process.env.MODEL_NAME!,
  apiKey: () => process.env.MODEL_API_KEY!, // Resolved separately for each request.
  parameters: { reasoning_split: true } // Optional vendor tuning; use only supported parameters.
})
```

This subpath uses native fetch and SSE. It supports text, images, native PDF and inline WAV/MP3 audio input, function tools, fragmented arguments,
separate `reasoning_content` history, final usage, cancellation and bounded responses.
Structured `reasoning_details` fragments retain their text, signatures and encrypted data for the same
adapter identity. Unsupported detail types are rejected. The stream requires
a finish reason plus `[DONE]` or a successful MiniMax usage/status trailer; a bare EOF cannot dispatch tools.
Chat tool messages carry text only: tool media follow the complete tool-result batch in a media message
that explicitly identifies their untrusted tool provenance. Stored history remains unchanged.
HTTP/network/protocol failures do not retry. Errors do not include response bodies or credentials.
`ChatCompletionsError.diagnostics` describes response/stream parsing failures using HTTP status, a fixed phase,
SSE data event count, observed finish reason, `[DONE]` state and any already validated usage. It contains
no provider text, tool arguments, URLs or headers. Observed usage on an error does not mark a request
complete; absent usage remains unknown. Hosts may persist this metadata alongside their failed receipt
without accepting incomplete tool calls or automatically retrying them.
Redirects are rejected; HTTP is allowed only for loopback fixtures/proxies, otherwise use HTTPS.

`parameters` cannot override messages, model, tools, streaming or output reserve. The adapter sends
`max_tokens` and requests streamed usage. Provider `prompt_tokens` is retained as total input,
including cache hits; `cacheReadTokens` is a subset, not additional input. Responses
`input_tokens_details.cached_tokens`, Anthropic Messages cache read/write fields and Chat Completions
cache hit fields are normalized when present. Missing usage stays unknown.
Private reasoning is replayed only under the same adapter identity. Full endpoint/model determines
the default ID; supply a distinct `id` when changing protocol compatibility semantics. Neither the
adapter nor core persists credentials, manages accounts or refreshes subscriptions.

The native HTTP integration fixture exercises a long context → automatic summary → authorized tool
→ model answer, including reasoning replay and summary usage. This is protocol-contract evidence,
not a live MiniMax/DeepSeek quality or service-availability certification.

`./responses` and `./messages` expose the same `AgentModel` contract for OpenAI-style Responses and
Anthropic Messages streams. They map text, images, tool calls, tool results, reasoning deltas and
normalized usage; credentials are resolved per request and never checkpointed. These adapters reject
redirects, bound response bytes, await cancellation cleanup and do not retry. Provider-specific
features outside the mapped event sets remain adapter work. Messages preserves base64/URL images inside
`tool_result`, `is_error`, signed thinking and redacted blocks. Responses preserves images inside
`function_call_output` and encrypted reasoning items with `store: false`; it does not depend on server-side
conversation storage. Native call IDs survive replay and compaction. Both adapters reject parameters
that could replace the authorized tool set or core request fields.

### Native input media

| Input           | Chat Completions                                   | Messages                                       | Responses                                                                             |
| --------------- | -------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| PDF             | Inline data or uploaded file ID                    | Inline data, HTTPS URL or uploaded file ID     | Inline data, HTTPS URL or uploaded file ID                                            |
| Other documents | Rejected                                           | Rejected                                       | Text, JSON, Markdown, HTML, CSV, XML, RTF, Word, PowerPoint, Excel and ODT MIME types |
| Audio           | Inline WAV/MP3 (`input_audio`)                     | Rejected                                       | Rejected                                                                              |
| Video           | Explicit MiniMax-compatible `video_url` capability | Explicit MiniMax-compatible `video` capability | Explicit MiniMax-compatible `input_video` capability                                  |

These are adapter contracts, not claims that every model behind the endpoint supports them. Set
`inputCapabilities` to narrow image/file/audio support; video defaults to false and must be explicitly
asserted by the host for a compatible model. Audio cannot be enabled on Messages or Responses.
The built-in host disables files/audio for the documented MiniMax text endpoints and enables video
only for its known M3 family. Existing text/image request projections remain stable.

Media blocks have `{ type, mimeType, source, filename? }`. `source` is a data URL, an authorized HTTP(S)
URL (or `{ url }`), or for uploaded files `{ fileId, adapterId }`. Uploaded IDs must match the exact
current model adapter identity; supply an account-generation-specific adapter `id`. The adapter checks
MIME/transport, base64 shape, filenames and capability before resolving credentials or making network
requests. The session rejects model-disabled prompt/steering media before persisting it; restored media
is checked again when constructing requests. Filesystem paths, automatic uploads, playback, OCR,
transcription, extraction and native media generation are not implemented. The host owns reference
access policy, upload/expiry/deletion and provider/model-specific size and token budgets. A serialized
byte estimate is not an upper bound on PDF page expansion or audio/video tokens.
All three native adapters enforce `maxRequestBytes` (32 MiB by default) on the serialized UTF-8
request before acquiring credentials or performing network I/O. This includes tools, instructions,
history and inline media together. It is a transport bound, not a model-specific media-token budget,
and does not avoid constructing the request string. Hosts can supply a narrower verified limit.

Media returned by tools uses the same native serializer, with tool-result identity/provenance retained.
Automatic summaries receive native input blocks and retain the original durable transcript; summary
quality still depends on the selected model. Tests cover compaction and journal reopen with PDF/video.
Real MiniMax CN M3 verification covers user and tool-returned MP4 through all three protocols (6/6,
2026-11-05). PDF/other documents and audio have contract tests, not real OpenAI/Anthropic certification.
See [SUPPORT.md](SUPPORT.md) for the precise evidence boundary.

### Parallel tools and capability scopes

Set `scheduling: 'parallel'` on a tool only when its host effect is safe to overlap. The default is
`'exclusive'`. The harness preflights authorization and guards for a parallel batch, commits every
`started` intent in one checkpoint, then runs up to `maxParallelTools` effects concurrently and stores
results in model-call order. An exclusive tool prevents a parallel batch from crossing its barrier;
unknown effects block continuation. Scheduling metadata never enters the model schema.

`registerTool`, `unregisterTool` and `openToolScope` wait for the active turn to drain before changing
the capability snapshot. `openToolScope(...).close()` detaches tools in reverse order and is idempotent.
In-flight effects are never revoked halfway through execution.

`createJsonFileAgentStore({ directory })` provides a standard-library durable single-owner store:
file locks, JSON validation, fsync and atomic rename. It is suitable for a local process owner; use a
database-backed `AgentStore` for high-concurrency workers or shared service deployments.

### Performance comparison

`src/performance-benchmark.test.ts` runs one identical five-step, four-tool workload through four
paths: a minimal `createAgentRunner` loop, a rolling-compaction loop, a session
without compaction, and a session with automatic compaction. It reports main model steps, total model
requests (including summary requests), tool calls, normalized input/output tokens and wall time. The
fixture uses character-count estimates, not provider tokens or billing. It verifies five main steps,
four tool effects, separately accounted summary requests, and bounded later main inputs.

The session uses the single prefix-preserving policy described above. Summaries themselves submit
history, so compaction need not reduce cumulative raw input on a short task. Compare cached input,
uncached input, output, total requests and task quality separately. `long-session-benchmark.test.ts`
checks exact wire-prefix preservation, repeated compaction, reopening and route changes using an
ideal prefix oracle; its cache numbers are not provider cache-hit measurements.

Live comparisons must use the same task, tool set, model route and reporting rules, include failed
attempts and summary usage, and distinguish main steps from total requests. The rolling-compaction
loop in the fixture is a baseline implementation for local comparison.

### Verified compatibility scenarios

Package tests exercise streamed responses; final tool-call admission; mandatory allow/deny;
Plan feedback/revision/approval; disk-serialized human waits; cancellation and a new turn;
uncertain effects and CAS takeover; model switching with media; balanced forks; durable compaction;
host skills/Connector/artifact flows; parent/child cancellation; and isolated Side chat relay.
Model and Connector responses are deterministic fixtures. Artifact writes and one delegated Node
calculation execute real host operations. These tests do not certify a particular HTTP protocol,
Python environment, remote host, UI, power-loss durability, or Windows/Linux sandbox.

## Low-level scheduling API (existing hosts)

```ts
import { createAgentRunner } from '@aipoch/agent-harness'

const runner = createAgentRunner({ maxSteps: 20 })
const outcome = await runner.run(async (signal, stepIndex) => {
  // Host: request the model, validate/authorize tools, await execution and persist results.
  // Return only when this step's resources and tool results are settled.
  return 'complete' // or 'continue' for another model step
})
await runner.dispose()
```

Use one runner per execution domain. `run` rejects overlapping turns. `cancel` signals the active
step; it does not release ownership until that step settles. `dispose` prevents future admission,
requests cancellation and waits for cleanup. Hosts must propagate the signal and dismiss pending
permissions. A callback that ignores cancellation can keep disposal pending; the host remains
responsible for terminating unresponsive processes. Do not await disposal from inside a step.

Outcomes are `complete`, `budget` and `cancelled`. Reaching the step budget is not task completion.
Errors propagate without retries. Failure or cancellation invalidates the runner: create a new one
only after the host has reconciled incomplete history and uncertain tool effects. A completed or
budget-limited turn can be followed by another turn.

The host adapter owns the model/tool capabilities, transcript, usage and permissions. The package
provides scheduling, execution ordering and a text-context compaction contract described below.
These low-level helpers do not own persistence, restart recovery, automatic compaction triggers,
tokenizers or model routes. The standalone session API above composes its own injected store;
existing application adapters can continue owning their current journal instead.

## Tool execution

`executeToolCall` validates and snapshots arguments before authorization. Authorization and execution
receive the same deeply frozen plain objects/arrays; mutable built-ins are rejected. The host supplies
validation, authorization, execution and durable receipt storage. A denial records `denied` without
executing. A granted call durably records `started` before effects, then `completed` with its output.
An execution error records `unknown`; a failed result write remains ambiguous and is never retried.
The host's receipt owner must reject repeated starts and bind each call to its durable model response.
This helper neither grants tool access nor replaces the application's permission or sandbox owners.

Run `npm run build`, `npm run typecheck` and `npm test` from this directory. The repository build
solution and portable test suite also include this package.

## Text context compaction

`compactContext(options)` performs one summary attempt over a balanced prefix, preserving at least
`keepRecentItems` recent items. Input must be the host's active branch projection; the package never
selects a conversation branch. System instructions and tool schemas remain outside the selectable
items. `measure(items)` must price the entire model request, including that fixed envelope and summary
framing. `inputBudget` is the available input capacity after reserving output and safety margin.
The package does not claim tokenizer accuracy or multimodal support.

A snapshot binds `sessionId`, `frameId`, `branchId`, runtime `generation`, `routeId` and `revision`.
The host must advance the revision for every relevant context change, including instructions,
capabilities and pricing changes; all identifiers must be stable and never reused for a new generation.
Items have unique IDs, text, and a `message`, `summary`, `tool-call` or `tool-result` kind. Call IDs
must be unique within the snapshot. An outstanding call may remain in the recent tail, but cannot
cross the compression boundary. Duplicate calls, orphan results and ID collisions are rejected.

Inject two host capabilities:

- `summarize(source, signal)`: a bounded, tool-free model request. The auxiliary summary request
  itself needs provider budget admission. Summary text is untrusted evidence, never instructions
  that grant permission. The host validates factual claims and evidence references before returning it.
- `commit(proposal, signal)`: atomically compare **all** expected scope fields and revision, check
  cancellation at the commit boundary, and durably append the summary plus its source IDs and new
  projection revision. Return true only after confirmed commit; false means no write because the
  candidate was superseded. Preserve raw history. A read/check followed by an unrelated write is
  insufficient. Storage errors, including uncertain commits, must propagate for host reconciliation.

The package freezes its snapshot and proposal. It does not update the host's current context itself.
A true commit is reported as `committed` even if cancellation arrives afterward. Do not automatically
retry a thrown storage error: the write may already exist. The host owns durable idempotency and
restart recovery; the test CAS store is only an executable example of the contract.

Other outcomes are `within-budget`, `uncompactable`, `not-smaller` and `stale`. A `committed` result
includes `tokens` and `fitsBudget`; false means the host must not submit that context yet. No automatic
retry occurs. An empty summary fails without committing. Summaries are distinct context items; hosts
must deliberately project them to their provider format and retain provenance. Integration with the
application-specific stores and model protocols belongs to the host. The repository's smoke host
exercises durable Session replay and a real summarizer; scientific evidence quality and product
backend integration require separate certification.

## Optional MCP tools

`@aipoch/agent-harness/mcp` exports `loadMcpTools` and `mcpToolResult`. It has no MCP SDK dependency and is not loaded by the core entry point. Supply a borrowed connection bridge; the host continues to own authentication, networking and disposal:

```ts
const tools = await loadMcpTools({
  signal: lifetime.signal,
  client: {
    listTools: (cursor, signal) => sdkClient.listTools(cursor ? { cursor } : {}, { signal }),
    callTool: (name, args, context) =>
      sdkClient.callTool({ name, arguments: args }, undefined, {
        signal: context.signal,
        onprogress: (progress) => {
          if (progress.message) context.update([{ type: 'text', text: progress.message }])
        }
      })
  },
  bind: (definition) => trustedBindings.get(definition.name)
})
```

Each selected binding must supply `validate` and `authorize`; returning `undefined` omits the tool. Use the host's schema validator rather than treating the server schema as authorization. A declared output schema additionally requires `validateOutput`. Bindings may explicitly narrow `parameters`/`description` and approve `scheduling: 'parallel'`; server annotations never enable concurrency or grant permissions. The host can rename returned tools when combining multiple servers; their execution remains bound to the original remote name.

Discovery follows pagination once, rejects duplicate/unsupported model function names and cursor loops, and returns a frozen, sorted snapshot with schema-derived versions. Names currently use `[a-zA-Z0-9_-]{1,64}`. Refresh deliberately between turns through the session capability/configuration APIs; the adapter does not subscribe to list-change notifications or add a discovery step to every model request.

Text, base64 images/audio and embedded resource blobs map to portable content. Structured output is included without duplicating an equivalent JSON text block. Resource links, text resources and extension blocks remain JSON evidence; no URI is fetched, no implicit permission is granted, and audio playback/rendering is not implemented. Hosts should keep large data at the executor and return authorized references. Unsupported/malformed results or transport exceptions propagate, preserving the core's unknown-effect fence. A valid `isError` result is an acknowledged tool failure. The adapter does not retry or claim that a cancelled MCP request proves remote execution has stopped: the host must supply a real drain/reconciliation boundary, particularly for non-idempotent operations.

Validators can throw `ToolValidationError([{ path: '$.groups', expected: 'array' }])` to return bounded, deliberately public diagnostics to the model before authorization. Other validator exceptions remain a generic error so private details are not exposed. This applies to exclusive and parallel tool batches. Schema validation, output/reference policy, remote cleanup and credential ownership remain host responsibilities.

Validate model-facing schemas against the chosen provider. If a provider repeatedly emits malformed
values for a dynamic map such as `{key: string[]}`, a tool owner can expose an entry array such as
`[{key: string, values: string[]}]` and validate/map it back to the business representation. Reject
duplicate keys instead of silently overwriting entries. Keep the original business validation and
acceptance criteria; do not coerce arbitrary strings or objects into arrays. `bind.parameters`,
`validate` and execution must describe the same projection, chosen before the turn so the tool prefix
stays stable. The harness does not rewrite schemas or tool arguments automatically. Clear validation
feedback helps diagnosis but does not guarantee the model can repair every provider/schema combination.

### Bounded original tool results

Set `toolResults: { authorize }` alongside `compaction` to enable the single bounded-result policy.
The host must supply an authorization callback for the package-owned `read_tool_result` tool. This
capability reads only already-completed evidence in its own session; it cannot select a different
session, open a path, fetch media, or repeat the original effect. The Open-Science host explicitly
allows this same-session read; arbitrary MCP tools continue through its existing permission broker.
The reader's schema is installed before the first request and remains across `configure()` calls.

Large text results retain an immutable `modelContent` preview in the same durable message as the
complete original `content`. Preview text uses the smaller of 8,192 measured units and 10% of usable
input space, with an additional 50-KiB/2,000-line ceiling. Measurement includes the result framing and
reference. The preview keeps a bounded head/tail and an invocation reference; subsequent requests
reuse it without age-based rewriting. Images/files/audio/video and error flags remain unchanged.
Media admission stays with the adapter/host. If even the mandatory reference cannot fit, the original
is retained and normal request admission may stop with `budget`; no unreadable fake preview is used.
The original is the payload returned to the harness. If a tool already shortened its own output,
use that tool's existing artifact/preview/read interface for omitted source data; the session reader
cannot recover bytes that never reached the harness.

The marker and reader description ask the model to use visible evidence when sufficient and read
only missing information needed for the current task. A page cursor is not an instruction to fetch
the entire result; this guidance does not enforce model behavior.

The model can call `read_tool_result({ invocationId, offset?, limit? })`. Applications can call
`session.readToolResult(invocationId, offset?, limit?)` directly for their own trusted inspection.
Offsets count Unicode code points across original text blocks joined with a newline. `limit` defaults
to 2,048 characters and is capped at 8,192; the current model budget can shorten the page further.
The result includes `text`, `nextOffset`, `totalCharacters` and the original `isError`. A non-null
`nextOffset` is the next page cursor. No entire-output copy is allocated for paging, although seeking
and counting text requires a scan of the original. Reader results are already bounded and are not
recursively shortened into more result references.

Full originals and previews survive journal reload and fork. Fork reads use the child's copied
history and do not inherit authorization grants. Disposal disables reads from the old session
object; deleting the host-owned session storage removes its retained evidence. Without a configured
reader, the package leaves tool results intact rather than silently making their middle inaccessible.
After explicit worker takeover, an interrupted intrinsic reader is settled with a bounded error;
it has no external effect to reconcile. A subsequent read obtains host authorization again. Other
tools with uncertain effects retain the existing explicit reconciliation requirement.
