# Session retention and diagnostics

The JSON Session authority remains unchanged. Main's opportunistic hydration cache stores one
**complete catalog scan**, not a general collection of individually cached Sessions. Ordinary
historical Session opening reads the requested authority from disk.

## Retention boundary

The complete scan is retained only when it contains at most **32 Sessions** and its estimated
retained JavaScript values occupy at most **32 MiB**. A successful reuse refreshes a **30-second
idle expiry**. Mutation invalidation and idle expiry release the entire cached snapshot.

The estimator walks object values, accounting for strings and approximate object/property
allocation without serializing another transcript copy. Shared objects are visited once; repeated
strings are conservatively counted separately. It stops when the budget is exceeded. This is an
estimated retention limit, not a measurement or bound on process RSS, transient scan allocation,
or the size of the current conversation.

An over-budget snapshot is not retained. It is never truncated: partial history must not be
presented as a complete catalog to deletion or ownership reconciliation. A later explicit full
scan reloads authorities; opening a historical Session continues to load only that Session.

The active runtime's pending events and the renderer's selected Session belong to independent
owners. Cache eviction does not dispose or mutate them. A second Main cache and a second selected
Session lifecycle are intentionally not introduced.

This refines the per-Session LRU wording in specification #15 / ticket #19: the existing cache has
one completeness-sensitive entry, so the implementation bounds and expires that whole entry.
Per-Session LRU would require new revision/invalidation and selection-ownership contracts while
adding no benefit to the existing on-demand read path. The initial limits are conservative
engineering defaults and should be assessed against measured retention and reload cost.

Acceptance for #15 / #19 uses the complete-snapshot boundary: count, estimated size, idle expiry,
invalidation, and on-demand reload are tested on the whole entry. The selected authority remains
loadable and live runtime state remains writable after eviction; their independent owners do not
need a new cache pin flag. A per-Session LRU is not implemented. Windows process memory and
first-upgrade projection rebuilding require separate measurement; the cache limits do not imply
a process-wide memory or startup latency guarantee.

## Diagnostic fields

- Ready summary reads emit debug-level `mode`, `sessionCount`, `candidateCount`, `queueWaitMs`, and
  `summaryReadMs`. Debug level avoids an information-level event for every ordinary list read.
- Startup's catalog aggregate includes `mode`, overall `durationMs`, summary/hydrated counts, and
  whether an exceptional complete rebuild was needed.
- Full authority scans aggregate `sessionBytes`, `authorityReadMs`, and `jsonParseMs` separately.
  Read time measures file-reader calls, including failed attempts; parse time measures `JSON.parse`
  attempts. Directory enumeration, normalization, and repair remain in the enclosing phase timing.
- Hydration reports queue wait before entering its scheduler, existing per-phase durations, and
  `retainedSessionCount`, `retainedEstimatedBytes`, `cacheRetention`, `cacheMaxSessionCount`, and
  `cacheMaxEstimatedBytes`. Counts describe the cache, not independently owned runtime/renderer data.
- Deferred recovery failures include `projectId`, `sessionId`, `phase`, `attempt`, `retry`,
  `retryDelayMs`, and `exhausted`. Phases distinguish preparation, missing-authority confirmation,
  commit, and derived-state recovery. Error fields omit messages/stacks that could contain content.
- The sweep summary reports `status: complete | partial`, `unresolvedCount`, `cleanupEligible`,
  and `cleanupSkippedReason` (`retries-exhausted` or `unconfirmed-missing`). Eligibility only
  admits complete-catalog cleanup; fresh catalog/revision guards may still skip it. Those skips
  emit `deferred Session catalog cleanup skipped` with the reason and, when known, Session id.

Metrics contain counts, durations, modes, and outcomes. They do not include conversation bodies,
titles, or workspace paths. Scoped recovery conflicts/retries and background admission are reported
by their recovery owners; these cache metrics do not replace their durability checks.

## Scoped recovery commits

`prepareSessionRecovery` reads a bounded primary JSON snapshot without reserving the Project
persistence lane. It checks filesystem boundaries and file identity before and after reading.
This reader never promotes temporary files, removes them, or quarantines a primary. Temporary,
malformed, missing-primary, or changing-file evidence produces a `repair-required` handoff;
normal durable-file recovery then runs inside the guarded commit. No JSON format changes are needed.

`commitSessionRecovery` checks deletion/export guards, reloads authority, and compares the prepared
revision before upload, artifact, or file-index effects. It checks current runtime/preparation
ownership again and uses explicit revision comparisons on JSON saves. A stale candidate cannot
replace newer messages or metadata. `recoverStartupSession` reloads once after a revision conflict;
a second conflict remains a failure for the background owner to record and reschedule. Missing
Sessions return no result; unreadable authority throws and must not be counted as recovered.

This keeps historical primary reads from blocking a current Session's terminal save in the same
Project, including the second durable read and effectful indexing/migration. Recovery now reserves
its Session identity and a Project lifecycle fence independently of ordinary saves in other Sessions.
Project deletion and package publication reserve both scopes, while same-Session writes remain
serialized. Recovery JSON saves use the same isolated identity plus explicit CAS in the repository;
they do not reacquire the ordinary Project save queue. Synchronous JSON parsing still occupies
Main's event loop, and same-Session durable effects remain nonpreemptible.

A global request waiting for admitted recovery does not publish the global barrier until recovery
drains. Foreground saves remain admissible meanwhile; subsequent recovery waits behind those
pending globals, whose original order and failure isolation are retained. Package publication also
waits for existing recovery before reserving the ordinary Project queue, preventing an import
waiting on history from blocking later foreground saves. Later recovery waits behind admitted
publication. An ordinary request for the Session currently being recovered also waits before
reserving the Project save queue; opening that history cannot convoy another Session's terminal
save. Direct Project queries and deletion requests use the same delayed admission, then retain their
exclusive lifecycle boundary. Deferred admissions snapshot earlier predecessors to preserve FIFO
and rejection isolation without forming cycles with later requests; further recovery waits behind
these pending foreground/lifecycle operations. Ready-list metadata uses
a synchronous generation-checked replacement, preserving newer live metadata and marking it
incomplete if the summary snapshot became stale. Ordered metadata snapshots retain their existing
scheduler boundary.

Recovery diagnostics use `operation: session-recovery` with prepare/commit/startup modes, phase
durations, commit `queueWaitMs`, and `revisionConflicts`. They contain no message bodies, titles,
or paths. These timings distinguish snapshot reading, persistence waiting, and effectful repair.

## Startup and deferred recovery ownership

With a ready derived projection, startup reads Session summaries and the selected Session only.
Listing summaries does not inspect every historical body and an oversized or unreadable historical
file does not initiate a full rebuild. Missing/old projection versions retain the exceptional
complete rebuild path; the JSON schema and authority do not change. Opening history hydrates that
Session through the existing continuation path.

The application composition starts `DeferredSessionRecovery` after foreground surfaces are wired.
It visits pending recovery candidates first, then streams the remaining historical Sessions so
legacy Upload upgrades, Artifact repair, finalized message snapshots, file indexing, Compute Host
bindings, sandbox approvals, and Session Details recovery retain their previous obligations.
Only one full body is held by the worker at a time; the completion catalog holds identities,
revisions, archive state, timestamps, and cwd references. It is not another transcript cache.
Compute Host and Session Details owners continue to protect work owned by the current process.

Each Session gets at most three attempts, with 250 ms and 1 s backoff. Failed Sessions yield to
healthy entries. Admission yields between reads, commits, and entries; it does not reserve future
Project lanes. Shutdown cancels future admission and waits for an already admitted effect, while
an off-lane primary read may finish without submitting a commit. Background failures are logged
locally and do not set the active Session's terminal-save error state. A later process reconstructs
work from JSON and summaries; there is no additional durable queue. Missing authority is rechecked
inside a scoped repository lane before removing only its stale projection. Unreadable/quarantined
or pending-import evidence keeps the summary.

Exhaustion leaves that Session unresolved and skips absence-based complete cleanup for this sweep.
Healthy recovery and foreground saves remain usable. There is no automatic second sweep in the
same process; the next process reconstructs pending work. The summary's `complete` outcome describes
the recovery sweep, not a guarantee that every destructive cleanup action ran.

Production integration tests delay the primary read, the second durable read, and effectful file
indexing for more than 2.6 seconds. A concurrent ready-list request returns and a real same-Project
runtime terminal save acknowledges within 1.5 seconds and survives a new repository read. These
checks cover the effectful recovery path, not only off-lane planning. Synchronous JSON parsing and
operations on the same Session are still not preemptible; exceptional complete projection rebuilds
remain a separate startup path.

The background workflow also has a real revision-conflict case: foreground JSON N+1 is saved while
the prepared N snapshot waits, the first background commit conflicts, and a backed-off attempt
succeeds while preserving the new message and metadata. Unreadable, oversized, and failed-index
cases verify three attempts, backoff, healthy sibling recovery, and a partial sweep diagnostic.
See [Windows validation handoff](session-persistence-windows-validation.md) for the remaining
platform and upgrade acceptance work.

## Complete cleanup boundary

Absence-based cleanup runs only after a successful complete sweep. Identity enumeration is
body-free and rejects incomplete temporary/import/deletion evidence. Every collected reference
must match the current summary revision (including legacy revision zero); a fresh catalog epoch
alone cannot validate an earlier cwd snapshot. Both the coordinator generation and repository
mutation generation must remain current through each destructive application. Package publication
through a second repository invalidates the coordinator generation before releasing its Session
lane, including failed publications. Repository mutation fencing covers durable-reader repairs.

Permission/index/provenance and archive cleanup use the complete identity set. Workspace planning
runs outside the global boundary, includes shared branch cwd references, and each action checks
freshness again. A failure is isolated where safe; uncertain or stale evidence defers destructive
cleanup until a later recovery. Active FileOriginSession witnesses preserve native import rows
published before JSON; deleting/deleted witnesses keep their existing retained-origin policy.
Explicit deletion receipts remain authoritative. Derived index rows without an identity or native
ownership witness remain eligible for orphan cleanup.

A second streamed pass cleans verified legacy Upload sources and orphan Artifact staging only
after the complete sweep. Upload sources must already have fully versioned references; cleanup
uses the existing immutable checksum/private-claim verification. Hashing runs under isolated Session
ownership, outside the global catalog fence. The precheck alone is not a lasting fence: cleanup
accepts only the deterministic owning Session upload directory and matching UploadFile/Version
ownership, while package publication takes the exclusive Project lifecycle fence. Live-save upgrades
references before commit and direct repository writes reject legacy references. External
uncoordinated filesystem writers are outside that ownership contract.

Artifact directory planning runs outside global ownership. Application uses the artifact writer's
nonblocking Session reservation before entering the repository catalog fence, and rechecks
ownership, stat identity, grace period, and a fixed startup cutoff. Newly created staging from this
process is excluded. The callback must not invoke repository mutations under its catalog fence.
Busy writer ownership skips admission instead of waiting under the global boundary. The guarded
action atomically renames a proven orphan into a private UUID directory; it never falls back to
copying on rename failure. Recursive removal runs after global ownership is released. Workspace
cleanup follows the same detach-then-delete rule. The namespaces
`.ownership/.retired-workspaces` and `.staging/.retired-orphans` are rediscovered on restart so a
failed removal is retried without deleting a newly recreated original directory. The Artifact
callback hands detached cleanup back before physical removal so the coordinator releases the
Session reservation too; opening that Session does not wait for disposal of retired bytes. Parent directories
are synced before completing detachment; no new JSON schema or durable queue is introduced.

Deferred diagnostics report aggregate bytes, bounded read/parse timings, preparation and commit
timings, and existing per-phase index work. They never serialize transcripts merely to measure
size. Background retries/exhaustion and final counts are separate from foreground durability.

This refines specification #15's “short scoped commit” wording: existing effectful owners keep
Session serialization rather than being rewritten into separate speculative plans. Unrelated
Session saves share a Project without sharing the recovery reservation. Project-wide deletion,
package publication, global catalog changes, and each Session's revision/ownership checks retain
their conflict fences. Artifact Project snapshots contain compatibility-publication candidates;
target Session/context checks and Artifact Session ownership still authorize finalization. File-index
canonical collision reads and writes remain within their existing Prisma transaction.

Native owner cleanup is planned from proven identities and applied one Session at a time after the
catalog fence: Review scope mirrors (including retained/deleted FileOrigin owners), research-film
receipts, built-in Agent bindings, and Compute Session cache directories all recheck ownership and
stat identity immediately before removal. Live operations make an action defer; physical disposal
never waits under a repository or coordinator global fence. Built-in Agent cleanup also uses the
host's existing ACP identity admission: identities admitted for an existing-ID helper resume stay
protected for the host lifetime, while a temporary cleanup claim rejects a concurrent admission.
This is process-local recovery evidence and deliberately introduces no persistent lock format; the
next startup retries untouched native owners. Fresh helper UUIDs and reviewer sessions are not
associated with an old app Session and remain governed by their existing admission paths.
Permission-grant pruning follows the same per-owner plan so its liveness check cannot wait on a
registry queue while a global catalog fence is held. Native owner failures remain retryable and do
not block unrelated Session durability.
