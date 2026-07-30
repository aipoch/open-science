# Unread Task SQLite Persistence Design

- **Status:** Approved
- **Date:** 2026-07-30
- **Scope:** Replace the unread-task JSON file introduced by this pull request with the existing SQLite data layer, recover unread cleanup from the authoritative Session catalog, and keep reconciliation entirely in the main process. This design does not expand the notification product behavior.

## Context

The desktop notification work keeps a set of session IDs whose terminal agent tasks have not yet been viewed. The set drives the macOS Dock badge, Windows taskbar overlay, and supported Linux badge count after application restart.

The first implementation of this pull request stored that set in `unread-task-sessions.json` under Electron's `userData` directory. Open Science already has a shared Prisma/SQLite metadata store at `open-science.db`, rooted through `resolveStorageRoot()`. Keeping this new metadata in a separate JSON file would create a second persistence mechanism and bypass development or test storage-root isolation supplied through `OPEN_SCIENCE_STORAGE_ROOT`.

Only the unread session set needs durable storage. Session JSON remains authoritative for existence, while native handles, live event correlation, renderer projections, and deletion race tombstones are valid only inside the current process and remain in memory.

## Goals

- Store the unread session ID set in the existing `open-science.db` authority store.
- Preserve current unread, badge, focus, deletion, headless, and error-isolation behavior.
- Keep the notification controller independent of Prisma and SQLite details.
- Preserve insertion order so the existing oldest-first 1,000-entry bound remains stable across restarts.
- Make every database update atomic and serialize competing snapshots.
- Repair interrupted and headless unread cleanup from a complete authoritative Session scan.
- Use the repository's packaged-app runtime DDL convention for fresh and existing databases.

## Non-goals

- Do not migrate, read, delete, or back up `unread-task-sessions.json` from builds of this pull request.
- Do not add notification history, read timestamps, project ownership, or per-notification records.
- Do not move process-local state into SQLite.
- Do not otherwise change Dock attention, taskbar flashing, badge presentation, or visible-session acknowledgement behavior. The review correction reserves transient attention for blocking approval requests; terminal results retain their system notification and unread badge without bounce or flashing.
- Do not make session JSON subordinate to SQLite or introduce a SQLite Session model.

## Persistence Inventory

| State | Lifetime | Decision | Reason |
| --- | --- | --- | --- |
| Unread session IDs | Across restarts | SQLite | Required to restore the badge and unread ownership |
| Notification-enabled setting | Across restarts | Existing Settings repository | Predates this pull request and already has an authority |
| Task tracks and track counter | Current agent event stream | Memory | Correlates live prompt and terminal events |
| Pending open-session handoff | Current renderer startup | Memory | Consume-once window handoff is stale after restart |
| Visible session ID and renderer acknowledgement | Current UI | Memory | Depends on the mounted renderer and focus state |
| Deleted-session tombstones | Current process | Memory | Prevents a live terminal-event/deletion race only |
| Permission challenges | Current IPC request | Memory | Request/response correlation has no restart meaning |
| macOS bounce ID and Windows flashing window | Current native process | Memory | Native handles are invalid after restart |
| Windows overlay image cache | Current native process | Memory | Recreated from the durable unread count |
| Session scan `isComplete` diagnostic | Current main-process scan | Computed, not stored | Authorizes catalog reconciliation only for one completed scan |

No other data newly persisted by this pull request should move to SQLite.

## Data Model

Add one normalized row per unread session:

```prisma
model UnreadTaskSession {
  id        Int    @id @default(autoincrement())
  sessionId String @unique
}
```

The auto-incrementing `id` records first-unread insertion order. Removing and later re-adding a session gives it a new position, matching the in-memory `Set` behavior. `sessionId` is unique so duplicate rows are structurally impossible.

The model deliberately has no timestamp, `projectId`, or foreign key:

- Current behavior neither queries nor displays unread timestamps.
- The controller and deletion coordinator already operate on globally identified session IDs; adding `projectId` would introduce redundant ownership plumbing.
- Sessions remain authoritative JSON files and have no corresponding authority table in SQLite.

The equivalent packaged-runtime schema is:

```sql
CREATE TABLE IF NOT EXISTS "UnreadTaskSession" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "sessionId" TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS
  "UnreadTaskSession_sessionId_key"
  ON "UnreadTaskSession"("sessionId");
```

Both statements are additive and idempotent. `ensureProjectSchema()` must run them before a generated Prisma client accesses the model. No second deletion table is required: after a crash, an unread row whose Session JSON is absent is sufficient evidence for cleanup; a deleted session without an unread row has no durable notification state to repair.

## Module Boundary

The controller keeps its existing narrow dependency:

```ts
type UnreadTaskRepository = {
  load(): Promise<string[]>
  save(sessionIds: string[]): Promise<void>
}
```

`UnreadTaskDbRepository` owns:

- lazy Prisma client acquisition;
- input normalization and the 1,000-entry bound;
- ordered reads;
- snapshot reconciliation transactions;
- chunked mutations;
- write serialization and queue recovery; and
- complete-scan reconciliation against authoritative Session JSON.

The controller owns:

- the live in-memory `Set`;
- unread policy and visibility checks;
- deletion tombstones;
- immediate badge refreshes; and
- best-effort persistence error reporting.

This keeps Prisma delegates, transactions, SQL limits, and storage-root selection out of notification policy.

## Startup Restore

Desktop startup performs these steps before task notification wiring:

1. Construct `UnreadTaskDbRepository` with a lazy provider that calls `getProjectDbClient(resolveStorageRoot())`.
2. Call `controller.restore()`.
3. Read at most the newest 1,000 rows ordered by `id`, then restore them oldest-to-newest into the in-memory `Set`.
4. Mark persistence ready only after `load()` succeeds, including the valid empty-table case.
5. Refresh the native badge once from the restored count.
6. Bind deletion recovery to the Session coordinator before a renderer can request its first load.
7. Register unread event and renderer visibility wiring.

Headless startup skips the repository and badge entirely, as it does now.

If database loading fails, startup continues and the in-memory badge remains usable. Persistence stays disabled for that process. This guard is important: treating a failed read as an authoritative empty set and later reconciling it would delete unread rows that the process never successfully loaded. A later application start retries normally through the existing non-sticky `getProjectDbClient()` initialization.

## Snapshot Reconciliation

Every state-changing controller path keeps the current order:

1. Mutate the in-memory `Set`.
2. Apply the 1,000-entry oldest-first eviction rule.
3. Refresh the native badge immediately.
4. Copy the complete in-memory snapshot and call `save()`.

`save()` copies and normalizes its input before enqueueing it. The repository maintains a promise tail so snapshots execute in call order. A rejected operation is returned to its caller for logging, while the internal tail catches the rejection so later snapshots still run.

Each queued snapshot runs one SQLite transaction:

1. Read the current unread rows ordered by `id`.
2. Compute rows absent from the desired snapshot and delete them in bounded chunks.
3. Compute desired session IDs absent from the table and insert them in snapshot order, also in bounded chunks.
4. Commit only after all differences have been applied.

Existing rows retain their IDs. Controller snapshots preserve `Set` insertion order, so only newly unread sessions require new ordering IDs. An empty snapshot explicitly deletes every row.

Full-snapshot reconciliation is intentional. If one write fails, the next successful state change compares the complete current snapshot with the actual table and repairs the missed difference. A transaction failure rolls back the entire attempt and cannot expose a half-applied snapshot.

## Session Deletion Recovery

Session JSON remains authoritative. Deletion uses this ordered protocol:

1. List every target session ID before removing a project directory.
2. Delete authoritative Session JSON without changing unread state first.
3. After deletion commits, remove matching live unread markers and persist the controller snapshot.
4. After the next complete authoritative session scan, remove every unread row whose Session JSON is absent, including interrupted and headless deletions.

Snapshot and catalog operations share one repository queue so an older full-state save cannot overtake newer reconciliation. Reconciliation is skipped after a partial session scan because absence is not authoritative in that case. Headless deletion continues to avoid all desktop-state writes; a later desktop launch repairs the projection from the complete Session JSON catalog.

## Failure Boundaries

- A load failure does not prevent the desktop application from starting.
- After a load failure, the controller does not write an assumed-empty snapshot during that process.
- A save failure does not roll back the in-memory unread set or native badge.
- A save failure does not poison the repository queue.
- No persistent retry timer is added. A later state change naturally retries with a complete snapshot.
- Durable session deletion remains authoritative. Cleanup failures after commit remain retryable from the next complete catalog scan and cannot turn a committed deletion into a failure.
- Only a complete main-process Session scan authorizes unread-row reconciliation; renderer state never authorizes deletion.
- Native badge, bounce, flashing, and overlay failures remain isolated from unread persistence.

## Code Changes

### `prisma/schema.prisma`

- Add `UnreadTaskSession`.
- Update the schema overview comment to include unread desktop task state.

### `src/main/projects/prisma-client.ts`

- Add table and unique-index DDL matching Prisma's SQLite output.
- Execute both statements from `ensureProjectSchema()`.

### `src/main/notifications/unread-task-repository.ts`

- Replace `UnreadTaskFileRepository` with `UnreadTaskDbRepository`.
- Remove file parsing, corrupt-file backup, temp-file rename, and `userData` path handling.
- Retain the normalization helper, entry limit, snapshot copy, and serialized queue semantics.
- Accept a narrow lazy Prisma client provider, following existing project repositories.
- Serialize catalog reconciliation on the same queue as full unread snapshots.

### `src/main/notifications/unread-task-controller.ts`

- Preserve the public controller and repository contracts.
- Track whether restore established a valid database baseline.
- Skip persistence after a failed restore while retaining current-process badge behavior.

### `src/main/index.ts`

- Construct the database repository with `getProjectDbClient(resolveStorageRoot())`.
- Stop using `app.getPath('userData')` for unread state.
- Restore unread state, then bind deletion recovery before installing the first window lifecycle.
- Keep window-dependent focus and native-attention wiring separate from window-independent deletion recovery.

### `src/main/session-persistence/coordinator.ts`

- Notify unread state only after authoritative JSON removal succeeds.
- Reconcile unread rows absent from the catalog only after a complete desktop session scan.

### Renderer and Shared Session Changes

- Keep the renderer projection limited to `visibleSessionId` and visibility challenges.
- Remove `existingSessionIds`, `MAX_UNREAD_VIEW_SESSION_IDS`, and the unread-only `sessionCatalogRevision` store counter.
- Stop propagating the main-process scan diagnostic through renderer Session persistence state.

### Unchanged Areas

- task terminal-event tracking;
- macOS Dock attention;
- Windows taskbar flashing and overlay rendering;
- Linux badge capability checks; and
- Settings persistence.

## Test Strategy

### Repository Tests

Use a real temporary SQLite database where schema compatibility matters, plus a narrow injected client when deterministic failures are required.

- A fresh database loads an empty list.
- Saved rows restore across repository instances in insertion order.
- Empty and whitespace-only IDs are removed.
- Duplicate IDs collapse to one row.
- Only the last 1,000 normalized IDs remain.
- A later snapshot inserts missing rows and deletes absent rows.
- An empty snapshot clears the table.
- The unique index rejects duplicate rows outside the repository path.
- Concurrent `save()` calls settle in call order and leave the last snapshot.
- A failed transaction leaves the previous snapshot intact.
- A failed queued write does not prevent the next write from succeeding.
- Failed authoritative deletion retains unread state; successful deletion removes it afterwards.
- Complete-scan reconciliation removes unread rows absent from the authoritative catalog, including interrupted and headless deletions.

### Controller Tests

- Successful restore enables later persistence.
- Failed restore reports the error, renders an empty current-process badge, and disables later saves.
- Marking, viewing, focusing, and deletion retain existing behavior; catalog pruning is covered by coordinator and repository tests.
- Save failure is reported without reverting memory or the badge.
- Headless mode never loads, saves, or renders a badge.

### Schema and Wiring Tests

- Existing runtime-schema parity coverage includes every scalar field of `UnreadTaskSession`.
- Fresh and existing databases receive the table and unique index idempotently.
- Main startup wires the repository to `resolveStorageRoot()` and the shared Prisma client.
- The deletion-runtime composition test uses a real temporary SQLite database and exercises reconciliation and cleanup through the captured coordinator handlers.
- Renderer tests prove that visibility changes and challenges never include the Session catalog.
- No production source references `UnreadTaskFileRepository` or `unread-task-sessions.json`.

### Verification Commands

Implementation verification must include:

```sh
npx prisma generate
npx vitest run src/main/notifications src/main/projects/prisma-client.test.ts
npm run typecheck
npm run build
```

The user will perform virtual-machine and physical-platform validation. Since this change affects only the persistence adapter, the previously approved platform attention and badge rules remain the manual acceptance baseline.

## Acceptance Criteria

- Unread task state survives restart through `open-science.db` on supported desktop platforms.
- The database contains at most one row per session and the controller retains at most 1,000 unread sessions.
- Viewing or deleting a session removes its durable unread row through the existing policy paths.
- A crash between authoritative deletion and unread cleanup, or a session deletion performed headlessly, converges from the next complete desktop Session JSON scan without retaining stale unread state or deleting unread state for a session whose JSON still exists.
- Database failures never block agent completion, committed session deletion, application startup, or current-process native feedback.
- A failed initial read cannot erase previously stored unread rows.
- Headless mode performs no unread database or native badge work.
- Terminal task results update the unread badge without native attention; blocking approval requests retain the transient five-second macOS bounce or three-second Windows/Linux flash.
- The old JSON file is ignored without migration or cleanup logic.
- No other process-local notification state is persisted.
