# Deadlock audit

## Scope and method

This audit covers application-owned mutual exclusion, readers-writer locks, drain barriers, and
Promise-tail serializers in Electron main and renderer code. It distinguishes those mechanisms from
in-flight request deduplication, work scheduling, Web Streams reader ownership, and atomic
`O_EXCL` file creation, none of which waits while holding another application lock.

The audit was performed against commit `1f26f4597bf2a9b2fc2d93c9114c83886198f5c1`. For each lock
owner, the review traced callers, callback boundaries, nested acquisition order, failure/cancellation
release, and cross-instance scope. Existing concurrency tests were used where they already exercised
the relevant invariant. Missing high-risk interleavings were added as deterministic tests with
explicit barriers.

## Result

One reachable lock-order deadlock was reproduced and repaired in Artifact Version publication. The
pre-fix order was:

```text
RPC createVersion
  Version Session lock
    -> Pending File lock (compatibility routing)

App-generated writeAppGeneratedVersion
  Pending File lock
    -> Version Session lock (immutable Version write)
```

When both operations address the same Project, application Session, Artifact storage Session, run,
and filename, each can hold the lock needed by the other. The regression test
`does not deadlock app-generated and RPC Version writes for the same pending file` reaches both lock
hold points with explicit barriers and then fails because neither operation settles within one
second. This is a mutual wait, not a timing-only slowdown.

The fix makes the process-wide Version Session serializer the outer owner for both paths:

```text
RPC createVersion
  Version Session lock
    -> Pending File lock (compatibility routing)

App-generated writeAppGeneratedVersion
  Version Session lock
    -> Pending File lock (atomic pending-file transaction and compatibility routing)
```

`withSessionWrite` supplies the already-scoped Version writer to the app-generated transaction, so
the inner Version write does not reacquire its own Session tail. The static Session tail remains
keyed by storage root, Project, and application Session, preserving serialization across repository
instances. The pending-file transaction remains intact around byte replacement, routing publication,
rollback, and reservation cleanup; compatibility routing still publishes before SQLite advances a
Version from `staging` to `pending`.

No second reachable mutual-wait cycle was found. Two APIs remain intentionally non-reentrant and
therefore depend on caller contracts: `ArchiveCoordinator` callbacks must not enter the archive gate
again, and a Session persistence Project operation must only extend to Session identities owned by
that Project. Current production callers preserve both contracts and have tests at those boundaries.

## Lock inventory and analysis

### Storage, Project, and lifecycle authority

| Lock or gate                     | Protected content and files                                                      | Acquisition/release analysis                                                                                                                                                                                                                                                       | Verdict and evidence                                                                                                                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data Root writer drain           | Migration exclusion in `src/main/storage/migration-state.ts`                     | Writers do not wait for migration; a pending migration rejects new writers and drains existing writers. `AsyncLocalStorage` makes nested writes in the same chain reentrant. Releases are in `finally` or idempotent lease callbacks.                                              | No cycle found. `migration-state.test.ts` covers nested writes after the migration gate rises and writer drain.                                                                                       |
| Project deletion queue           | Durable deletion intent/recovery in `src/main/projects/deletion-coordinator.ts`  | One Promise tail serializes deletion and recovery. The order is deletion queue -> Data Root writer -> lifecycle/archive/session cleanup. No caller was found that holds a downstream lock while waiting to enter this deletion queue. Failed tails are converted to settled tails. | No cycle found. `deletion-coordinator.test.ts` covers overlapping deletion, recovery, retry, and failure release.                                                                                     |
| Archive lifecycle gate           | Archive/restore and short runtime admission in `src/main/archive/coordinator.ts` | One non-reentrant Promise queue. Long prompt execution is outside the gate, and Session deletion admission deliberately returns the operation Promise after releasing admission. ACP continuation paths explicitly avoid entering this gate twice.                                 | No reachable production cycle found; API contract risk remains. Covered by `archive/coordinator.test.ts`, `acp/application-commands.test.ts`, `acp/handler-workflows.test.ts`, and `acp/ipc.test.ts`. |
| Durable JSON path queue          | Per-file atomic JSON writes in `src/main/storage/durable-json-file.ts`           | A private path-keyed tail wraps only the file replacement operation. It exposes no callback that can reacquire the same path and always advances the tail after rejection.                                                                                                         | No cycle found. Same-path write ordering is covered by the storage/repository consumer tests.                                                                                                         |
| Application single-instance lock | Electron process ownership in `src/main/single-instance.ts`                      | Electron owns this OS-level lock. The application does not hold it while waiting on another application lock.                                                                                                                                                                      | No cycle found. `single-instance.test.ts` covers ownership and handoff behavior.                                                                                                                      |

### Session persistence and Notebook

| Lock or gate                                 | Protected content and files                                                                                                     | Acquisition/release analysis                                                                                                                                                                                                | Verdict and evidence                                                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project/Session/global persistence scheduler | Project, Session identity, manifest, and global persistence scopes in `src/main/session-persistence/operation-scheduler.ts`     | Scopes are deduplicated; global generations prevent a late global barrier from becoming both predecessor and dependent of a running scope extension. An extension filters identities already held by the current operation. | No reachable cycle found. The new held-identity regression test and existing global/extension tests pass. Cross-Project identity extension would be unsafe, but the sole production caller derives identities from the Project deletion owner. |
| Environment lease                            | Per-environment shared/exclusive operations in `src/main/notebook/environment-lease-manager.ts` and `environment-operations.ts` | FIFO lease acquisition; release is in `finally`; cancellation and disposal reject waiters and release holders. Public mutation methods acquire once at their top-level boundary.                                            | No cycle found. `environment-lease-manager.test.ts` and `environment-operations.test.ts` cover contention, failure, cancellation, and disposal.                                                                                                |
| Provisioning environment lock                | Environment mutation in `src/main/notebook/runtime-service.ts` and `provisioner.ts`                                             | Repair code calls lock-free `do*` helpers while holding the exclusive environment lease, avoiding re-acquisition of the non-reentrant lease. No cache-to-environment edge was found.                                        | No cycle found. Provisioner and environment operation tests cover repair and failed-operation release.                                                                                                                                         |
| Package cache readers-writer lock            | Shared micromamba package caches in `src/main/notebook/pkgs-cache-lock.ts`                                                      | Multi-cache identities are deduplicated and sorted before nested acquisition. Both shared and exclusive helpers use the same order; all holders release in `finally`. Lock order is Environment -> Package Cache only.      | No cycle found. Existing opposite-order exclusive test and the new shared/exclusive mixed-mode test pass.                                                                                                                                      |
| Environment state target queue               | Per-target environment state projection in `src/main/notebook/environment-state-tracker.ts`                                     | Preparation occurs before entering the target serializer; serialized callbacks do not enter another target queue. Rejection cannot poison the tail.                                                                         | No cycle found. Covered by `environment-state-tracker.test.ts`.                                                                                                                                                                                |
| Notebook dependency/project queue            | Dependency projection in `src/main/notebook/dependency-analysis.ts`                                                             | A single private queue wraps projection mutation and exposes no nested lock callback.                                                                                                                                       | No cycle found. Covered by dependency analysis tests.                                                                                                                                                                                          |
| Notebook persistence/execution queues        | Notebook document saves and per-process execution/control in `src/main/notebook/repository.ts` and `session-aggregate.ts`       | Queues are per owner or process key. Lifecycle/control code drains execution before replacement rather than acquiring the queues in reverse order. Settled tails survive failures.                                          | No cycle found. Covered by repository, session aggregate, runtime, and executor lifecycle tests.                                                                                                                                               |
| Working-file evidence queue                  | Project initialization flights and global evidence mutation in `src/main/notebook/working-file-observer.ts`                     | Initialization is deduplicated before evidence mutation; the evidence tail is released on both success and failure. No evidence-mutation -> initialization reverse edge was found.                                          | No cycle found. Covered by working-file observer tests.                                                                                                                                                                                        |

### Artifact publication

| Lock or gate                 | Protected content and files                                                                                                | Acquisition/release analysis                                                                                                                                                                                           | Verdict and evidence                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Pending File lock            | Per Project/storage Session/run/filename publication in `src/main/artifacts/publication-owner.ts`                          | `withPendingFileTransaction` holds this lock across its callback and releases it in `finally`. App-generated publication now enters it only after acquiring the Version Session lock.                                  | **Cycle repaired.** Both Version publication paths now acquire Version Session -> Pending File.        |
| Version Session lock         | Per storage root/Project/application Session immutable Version writes in `src/main/artifacts/provenance-version-writer.ts` | A static Promise tail serializes repository instances. `withSessionWrite` can extend that scope around the app-generated pending-file transaction and supplies a writer that does not reacquire the same Session tail. | **Cycle repaired.** The regression test observes the app write queued at Session before Pending File.  |
| Artifact write budget queue  | Turn/Session reservations in `src/main/artifacts/write-budget-owner.ts`                                                    | One short private serializer protects accounting. It does not wait for file or Version publication while held; callers reserve before Version persistence and release outside the budget queue.                        | No cycle found. `write-budget-owner.test.ts` and provenance budget tests cover contention and release. |
| Finalize claim lock          | Per claim finalization in `src/main/artifacts/ipc.ts`                                                                      | A keyed tail joins only same-claim finalization. It releases in `finally` and does not acquire another claim key.                                                                                                      | No cycle found. `artifacts/ipc.test.ts` covers concurrent same-claim finalization.                     |
| Reconstruction in-flight map | Per reconstruction request in `src/main/artifacts/code-reconstruction.ts`                                                  | This is request deduplication, not a held mutex: consumers join the same result and no nested resource is held.                                                                                                        | Not a deadlock lock.                                                                                   |

### Skills and Specialists

| Lock or gate                       | Protected content and files                                                                                                       | Acquisition/release analysis                                                                                                                                          | Verdict and evidence                                                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skill mutation owner               | Per writable Skill root in `src/main/skills/skill-mutation-owner.ts` and `skill-package-transaction-owner.ts`                     | Cross-instance mutex with `AsyncLocalStorage` reentrancy. Manual leases are paired with a held-lock context and idempotent release.                                   | No cycle found. `user-skill-repository.test.ts` and `specialist-package-adapter.test.ts` cover cross-repository exclusion and reentrant inspection. |
| Host Skill mutation tail           | Host Skill publication/deletion in `src/main/skills/host-skills-service.ts`                                                       | One private serializer; callbacks do not acquire a second host tail and failed work releases it.                                                                      | No cycle found. `host-skills-service.test.ts` covers concurrent publish/delete.                                                                     |
| Specialist package transaction     | Package staging/commit/recovery in `src/main/specialist/package/transaction.ts`                                                   | One private transaction queue. Package mutation enters the shared Skill owner in a single direction.                                                                  | No cycle found. Package transaction/service tests cover overlapping work and recovery.                                                              |
| Marketplace operation coordinator  | Install/recovery/deletion coordination in `src/main/specialist/marketplace/operation-coordinator.ts` and `marketplace/service.ts` | Global order is Marketplace -> Specialist package transaction -> Skill mutation. No reverse Skill -> Marketplace or transaction -> Marketplace acquisition was found. | No cycle found. Marketplace and package service tests cover recovery/install and deletion/install contention.                                       |
| Marketplace/repository save queues | Marketplace catalog and Specialist metadata in `src/main/specialist/marketplace/repository.ts` and `specialist/repository.ts`     | Private write serializers; neither exposes its locked callback to external callers.                                                                                   | No cycle found. Repository tests cover concurrent saves and failed writes.                                                                          |
| Session reconfiguration tails      | Per Session Specialist reconfiguration in `src/main/specialist/session-reconfiguration.ts`                                        | One key per Session and no multi-key operation. Each tail settles after failure.                                                                                      | No cycle found. Covered by session reconfiguration tests.                                                                                           |

### Compute and runtime admission

| Lock or gate                  | Protected content and files                                                                                                                                                          | Acquisition/release analysis                                                                                                                              | Verdict and evidence                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Compute admission lock        | Capacity admission/accounting in `src/main/compute/concurrency-manager.ts`                                                                                                           | The lock protects only synchronous admission bookkeeping. Job execution is registered and then runs outside the admission tail.                           | No cycle found. `concurrency-manager.test.ts` covers concurrent admits and release.           |
| Harvest budget tail           | Harvest capacity reservation in `src/main/compute/harvest-engine.ts`                                                                                                                 | Only reservation mutation occurs under the tail. The returned release later re-enters after the acquisition operation has released it.                    | No cycle found. Covered by harvest engine tests.                                              |
| Provider mutation/auth tails  | Provider credentials and failure persistence in `src/main/compute/compute-auth-owner.ts` and `connection-broker.ts`                                                                  | Tails are per provider. Active-operation drain waiters are resolved when counts reach zero; drain does not hold a provider tail while waiting for itself. | No cycle found. Covered by compute auth and connection broker tests.                          |
| Host/job/session write queues | Host lifecycle, job persistence/deletion, and enabled-host mutation in `src/main/compute/ipc.ts`, `job-repository.ts`, `job-deletion-owner.ts`, and `session-enabled-hosts-owner.ts` | Each owner has one queue or one resource key. Deletion/runtime isolation establishes one-way lifecycle order and releases queues on rejection.            | No cycle found. Covered by compute IPC, job repository, job deletion, and enabled-host tests. |
| Dispatch drain                | Per-job in-flight counter and waiters in `src/main/compute/dispatch-tracker.ts`                                                                                                      | Drain waits without holding another tracker lock; decrement resolves all waiters.                                                                         | No cycle found. Covered by dispatch tracker/deletion tests.                                   |

### Other private serializers

The following owners use a single private Promise tail (or a single key with no multi-key operation):

- ACP provider prompt and Artifact handoff ordering:
  `src/main/acp/provider-prompt-serialization-owner.ts`,
  `src/main/acp/artifact-turn-owner.ts`, and `src/main/acp/runtime-coordinator.ts`.
- Delegation admission, Session record mutation, delivery lanes, and settlement wake state:
  `src/main/delegation/delegated-work-admission.ts`,
  `src/main/delegation/session-record-adapter.ts`,
  `src/main/delegation/message-delivery-owner.ts`, and
  `src/main/delegation/delegation-settlement-wake-owner.ts`.
- Settings and connector projection writes:
  `src/main/settings/document-store.ts`, `provider-auth-lifecycle.ts`,
  `network-proxy-settings-owner.ts`, and
  `src/main/connectors/runtime-settings-projection.ts`.
- Memory, tags, locale, notifications, remote access, permissions, and logging:
  `src/main/memory/service.ts`, `tags/service.ts`, `locale/owner.ts`,
  `notifications/notification-inbox-repository.ts`, `remote-access/service.ts`,
  `remote-access/repository.ts`, `remote-access/pairing.ts`,
  `permission-grants/registry.ts`, and `logger.ts`.

These queues serialize internal mutation only, do not offer a public callback that can re-enter the
same queue, acquire no second instance of their own resource, and convert rejected operations into a
settled tail. No mutual-wait edge was found among them. Their owner tests cover concurrent mutation
and recovery from a rejected operation; full-suite validation is still required after any lock-order
fix because many are composition boundaries rather than isolated utilities.

## Excluded concurrency mechanisms

The following were reviewed but are not held mutual-exclusion locks:

- Promise maps that deduplicate the same read, extraction, initialization, teardown, or request.
- Work queues whose consumers do not wait while retaining admission, such as job polling and message
  delivery pumps.
- Atomic exclusive file creation used for collision-safe staging.
- Web Streams `reader.releaseLock()`, which releases a stream reader reference.
- micromamba's external on-disk package lock and database/SQLite internal locking. These belong to
  external processes/libraries; the application package-cache lock explicitly documents that the
  external lock remains responsible for cross-process exclusion.
- Renderer persistence/coalescing queues, which order outbound state but hold no main-process
  authority lock while awaiting a reverse renderer resource.

## Test evidence

Before adding coverage, the initial focused lock suite passed 10 files and 255 tests. The expanded
lock-owner suite passed 23 files, 670 tests, with one intentionally skipped platform case. The
Compute connection tests required an unsandboxed rerun because their SSH askpass harness creates a
local Unix socket; all 49 runnable tests passed there. New coverage adds:

- `src/main/session-persistence/operation-scheduler.test.ts`: nested acquisition of an identity
  already held by the current operation completes instead of waiting on its own tail.
- `src/main/notebook/pkgs-cache-lock.test.ts`: opposite multi-cache requests across shared and
  exclusive modes settle after the current readers release.
- `src/main/artifacts/provenance-repository.test.ts`: a real repository, filesystem, and SQLite
  interleaving records the pre-fix mutual wait, then verifies the repaired Session -> Pending order
  and completion of both writes.

Focused commands and outcomes:

```text
npm test -- src/main/notebook/pkgs-cache-lock.test.ts \
  src/main/session-persistence/operation-scheduler.test.ts
PASS: 2 files, 15 tests

npm test -- src/main/artifacts/provenance-repository.test.ts \
  -t "does not deadlock app-generated and RPC Version writes"
PRE-FIX FAIL: expected "settled", received "blocked"

npm test -- src/main/artifacts/provenance-repository.test.ts \
  -t "does not deadlock app-generated and RPC Version writes for the same pending file"
POST-FIX PASS: 1 file, 1 test (41 skipped by the name filter)

npm run test:module -- artifact_storage
PASS: 4 files, 135 tests

npm run test:module -- artifact_provenance
PASS: 26 files, 1,455 tests (rerun with local TCP/Unix socket permission)

npm run typecheck
PASS: Node and Web TypeScript projects

npm run lint
PASS

npm test
PASS: 1,300 files and 21,902 tests; 17 files and 223 tests skipped by suite conditions
```

The first full-suite attempt used a shared `node_modules` symlink while another worktree generated a
Prisma client for an unmerged schema, producing unrelated ComputeJob schema mismatch failures. The
worktree dependencies were isolated, the client was regenerated from this branch's schema, and the
final full-suite result above passed. One intermediate isolated-client run had two completion-gate
timing/cleanup failures under full parallel load; the affected file passed all 22 tests immediately
when rerun alone, and the final unchanged full suite then passed.
