# Local data migration progress

The startup helper displays the current phase, an overall progress bar, elapsed time and a reminder
to add model keys again after configuration migration. The reminder uses the shared amber warning
palette in both themes. This UI change does not clear or rewrite credentials. The existing startup
adapter still launches a disposable UI before the offline migration worker, before application
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
