# Local data migration progress

The startup helper displays the current phase, an overall progress bar, elapsed time and a reminder
to add model keys again after configuration migration. The reminder uses the shared amber warning
palette in both themes. This UI change does not clear or rewrite credentials. The existing startup
adapter still lets the offline worker launch a disposable UI before migration, before application
writers open. The normal application starts only after the existing migration protocol succeeds.

## Meaning of the percentage

- Before the total is known, the bar is indeterminate and no percentage is shown. The census reads
  directory entries and file sizes across every participating root, including preserved targets.
  Nested symlinks count as single entries; their targets are not traversed. Stationary configuration
  roots contribute only the reference bundle members that will actually migrate.
- The denominator is fixed after the census. One work unit represents one byte or one entry for a
  planned operation. The budget covers original inventories, copying, repeated integrity checks,
  reference updates, syncing, publication and final verification. Large files therefore receive
  more weight than tiny files. This is a fraction of planned work, not a time or ETA estimate.
- File hashes advance with bytes actually read. Native metadata-preserving copy, metadata queries,
  reference updates and syncing advance on successful completion; their individual operations can
  hold the percentage steady. There is no timer-driven simulated percentage. A wait message appears
  if the worker has not reported progress for ten seconds.
- Progress never decreases within one attempt. A stage cannot finish its reserved unit until its
  operation succeeds. The UI caps unfinished migration at 99%; only a successfully committed result
  reaches 100%. A failed operation shows the existing recovery error surface.
- A resume starts a new budget for that attempt, derived from the recorded manifests and remaining
  phases. An already committed or empty initialization completes immediately after its checks.
  Dry-run and rollback do not pretend to be forward-migration percentage progress.

`completed` / `total` in an inventory event describe that particular directory check, which can
restart for another root or another verification pass. They are not the overall percentage. The
separate `overall` object contains `completed`, `total`, and the initial census `entries` and
`bytes`. CLI stderr and the startup IPC bridge carry the same events; CLI stdout remains the existing
parseable receipt.

## Layout and recovery

The graphic, title and progress area are anchored from the top. Wrapped paths and the wait message
extend the details downward. Small windows scroll vertically, with paths wrapping instead of
introducing horizontal scrolling. The indeterminate animation respects reduced-motion settings;
screen readers receive a named progress bar, with no numeric value until the census is complete.

Counters are ephemeral: no fields or versions are added to the durable journal. Version 1/2/3 journal
validation, source backups, existing-target backups, occupied-writer checks, alias handling and
transactional reference updates retain their existing behavior. A census/inventory size or entry
count mismatch blocks copying; keep the originals and stop the writer before retrying.

Existing operations and backup paths remain documented in [Brand names and storage migration](brand-path-migration.md).
For a disposable test home (replace the example path with that test home's actual path):

```bash
node scripts/migrate-brand-paths.mjs --home /tmp/migration-fixture --app-data /tmp/migration-fixture/profiles --mode dev
node scripts/migrate-brand-paths.mjs --home /tmp/migration-fixture --app-data /tmp/migration-fixture/profiles --mode dev --execute
node scripts/migrate-brand-paths.mjs --home /tmp/migration-fixture --app-data /tmp/migration-fixture/profiles --mode dev --resume
node scripts/migrate-brand-paths.mjs --home /tmp/migration-fixture --app-data /tmp/migration-fixture/profiles --mode dev --rollback
```

The first command is read-only dry-run. Execute/resume/rollback mutate the specified test home.
Never delete a journal or backups to reset the percentage, and never use real user data for UI tests.

## Continuous application startup

Normal desktop startup, in both development and packaged mode, retains that progress window after
the filesystem transaction commits. The same page then displays database checking, runtime startup,
settings loading and saved-conversation loading. These later phases are indeterminate: migration's
100% counter, scanned path and model-key warning are no longer displayed as current startup work.
The helper initially uses the main window's dimensions to reduce the visual jump at handoff.

The worker still communicates with its helper through child-process IPC throughout migration.
Only successful migration transfers presentation to main, through an authenticated loopback TCP
connection. Its random token stays in the launch environment; a private temporary
`open-science-startup-*` directory contains only endpoint metadata. The protocol accepts fixed
progress/focus/completion/failure messages, with bounded frames and one authenticated owner; it
exposes no filesystem or application APIs. TCP avoids Unix socket path limits in nested worktrees.
The offline worker exits after handoff, so Electron's real profile remains unopened until migration
has completed. No transaction logic, database schema or version 1/2/3 journal format changes.

Main creates its normal window hidden and preserves the existing database startup gate. The renderer
reports loading stages, then acknowledges two animation frames after committing an interactive
page: onboarding, the hydrated application, missing-data-root recovery, or an actionable startup
error. The top-level React recovery page also participates. Main verifies the sending window and
main frame before revealing it, then releases the helper. Activation, tray Show and second-launch
requests focus the helper while that handoff is pending. Once revealed, normal navigation, explicit
retries, reloads and later window creation use their existing behavior; the helper is not reopened.

Headless startup has no helper; standalone CLI execute/resume/rollback and their backups remain as
documented above. An offline failure still keeps migration diagnostics and prevents application
writers from opening. A later main-process or renderer-process failure keeps a startup error in the
helper. An authenticated owner disconnect is an error; if main never attaches after the worker's
handoff, the helper reports a lost owner after 30 seconds. Closing the error does not modify a
journal, roll back data or delete backups. Normal exits remove owned temporary UI/endpoint files;
forced termination or an OS-held cache can leave disposable temporary files. Durable migration
backups and recovery commands are unchanged.

For a manual development preview with isolated data in the current worktree:

```sh
mkdir -p .codex/startup-preview/config .codex/startup-preview/profile .codex/startup-preview/tmp
OPEN_SCIENCE_USER_DATA="$PWD/.codex/startup-preview/profile" \
OPEN_SCIENCE_CONFIG_ROOT="$PWD/.codex/startup-preview/config" \
OPEN_SCIENCE_STORAGE_ROOT="$PWD/.codex/startup-preview/config" \
OPEN_SCIENCE_E2E_STORAGE_ROOT="$PWD/.codex/startup-preview/config" \
OPEN_SCIENCE_ALLOW_MULTI_INSTANCE=1 TMPDIR="$PWD/.codex/startup-preview/tmp" npm run dev
```

`CONFIG_ROOT` scopes CLI discovery; desktop storage currently consumes `STORAGE_ROOT`.
`E2E_STORAGE_ROOT` also keeps Electron logs and migration discovery under the disposable tree.
E2E fixtures replace these roots per test and retain their own explicit `--user-data-dir` instead of
inheriting a task wrapper's profile. Do not point preview/test commands at a real user-data directory.
