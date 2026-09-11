# Brand names and storage migration

Project prose preserves its original letter case and inserts one hyphen: `OpenScience` and
`Open Science` become `Open-Science`; `openscience` and `open science` become `open-science`.
Mixed case follows the same rule. This does not rename third-party products, certificate subjects,
protocol members, persisted record identities, user prose, or historical evidence.

## Roots and entry points

| Root                         | Previous default                                   | Current default                                    | Readers / writers                                                                                                        |
| ---------------------------- | -------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Packaged research data       | `<home>/OpenScience`                               | `<home>/Open-Science`                              | `src/main/storage-root.ts`; storage, uploads, artifacts, Notebook, runtime, workspaces, content and compute repositories |
| Development research data    | `<home>/OpenScience-DEV`                           | `<home>/Open-Science-DEV`                          | Same data-root owner, development mode                                                                                   |
| Packaged Electron profile    | `<appData>/Open Science`                           | `<appData>/Open-Science`                           | `src/main/index.ts`; Chromium preferences, sessions, cache, local storage and Electron logs                              |
| Development Electron profile | `<appData>/Open Science (DEV)`                     | `<appData>/Open-Science (DEV)`                     | Same bootstrap, development mode                                                                                         |
| macOS logs                   | `~/Library/Logs/Open Science / Open Science (DEV)` | `~/Library/Logs/Open-Science / Open-Science (DEV)` | Electron log path; actual development suffix is ` (DEV)`                                                                 |
| Packaged configuration       | `~/.open-science`                                  | unchanged                                          | `session-persistence/paths.ts`, `storage-root.ts`; `settings.json`, SQLite, sessions, agent configuration                |
| Development configuration    | `~/.open-science-project`                          | unchanged                                          | Same owners, development mode                                                                                            |
| Windows fallback tools       | `%LOCALAPPDATA%/OpenScience`                       | `%LOCALAPPDATA%/Open-Science`                      | `notebook/windows-micromamba-runner.ts`                                                                                  |
| Windows sandbox ownership    | `%LOCALAPPDATA%/Aipoch/OpenScience`                | `%LOCALAPPDATA%/Aipoch/Open-Science`               | `packages/notebook-network-sandbox/src/config.ts`, uninstall helper                                                      |
| Windows working cache parent | `<runtime-volume or TEMP>/OpenScienceTmp`          | `.../Open-ScienceTmp`                              | `notebook/micromamba-cache.ts`; only parents with the application ownership marker are discovered                        |
| New remote jobs              | `<scratch>/.openscience/jobs/<id>`                 | `<scratch>/.open-science/jobs/<id>`                | `compute/job-dispatcher.ts`; poll, recovery, harvest and deletion validate both generations                              |
| New remote activation files  | `~/.openscience/environments/<name>.sh`            | `~/.open-science/environments/<name>.sh`           | `compute/compute-environment.ts`; the compute setup Skill writes the new location                                        |

`appData` is `~/Library/Application Support` on macOS, `%APPDATA%` on Windows, and
`$XDG_CONFIG_HOME` (normally `~/.config`) on Linux. Actual directory letter case is discovered in
these known parents and retained. Two distinct default data trees are an ambiguity, not an ordering
choice. Configuration directories already containing research data retain their existing compliant
name; ordinary data-location preferences continue to apply.

`--user-data-dir`, development `OPEN_SCIENCE_USER_DATA`, `OPEN_SCIENCE_STORAGE_ROOT`, and
`OPEN_SCIENCE_E2E_STORAGE_ROOT` remain literal overrides. Isolated development/E2E storage is also
the logical migration home and data parent, so tests never inspect the account's real default roots.
`settings.dataRoot` is mapped automatically only when its final component is an exact old
application data-directory name. Other selected paths and their brand-looking ancestors remain
literal. `--map` is the explicit operator mechanism for another confirmed application-owned root.
All paths must be absolute. `.open-science` and `.open-science-project` are not renamed again.

Notebook command-lease evidence uses `<config-root>/notebook-command-temp`. Older versions placed
it under the Electron profile. Profile migration preserves those older receipts and directories,
including their original backup; the current command reconciler scans the configuration root and
does not claim to have cleaned the older profile location. Retain legacy evidence until its
installation/lease owner and stopped native or WSL process have been verified through the existing
command recovery procedure. Do not delete or fold those receipts into a new lease, or connect to a
WSL/VM environment without the required authorization.

## Transaction and startup

The shared implementation is `resources/brand-migration/`. Both the standalone CLI and
`src/main/brand-path-migration.ts` use it. Packaged builds include it in `app.asar.unpacked/resources`.
Startup runs the offline helper synchronously before Electron reaches ready or opens application
logs, SQLite, sessions, or runtime writers. A migration lease is then held for the app lifetime.
Second launches with the same profile and single-instance mode may relay through the existing application lease; other profiles and multi-instance writers are refused; they cannot bypass an offline
migration/rollback lock. A live worker or app PID prevents abandoned-lock recovery.

The default standalone action only returns a plan. Execution classifies each mapping:

- Old only: inventory, copy to a private sibling stage, verify, migrate references, then publish.
- New only: adopt that root without copying or replacing it. Only changed supported JSON and DB/WAL files enter a reference-bundle transaction; unrelated files and root inodes stay in place. Installed runtimes with old prefixes receive a recorded, audited transition alias.
- Neither: initialize using the new default; do not manufacture old data.
- Both, new directory empty: the plan reports `targetHandling: "empty"`. Preserve that directory
  in a separate backup, then migrate the old tree. Empty means no entries, including hidden files.
- Both, known macOS application log roots: the plan reports `targetHandling: "logs"`. Preserve
  the complete existing new log tree separately, then publish the old logs at the new location.
  Same-name logs are never overwritten or concatenated; both histories remain accessible.
- Both, any other nonempty target (including an Electron profile or data root): stop with both
  exact paths. Nested roots with existing targets also require explicit reconciliation.

Each source tree is inventoried before copying and rechecked before any source rename. Native copy
preserves file bytes, directory layout, permissions, ACLs and extended attributes; hashes,
metadata, timestamps and hardlink relationships are compared. Symlink roots and reference files,
multiple hardlinks to mutable reference documents, unsupported special nodes, active operations,
permission failures and insufficient aggregate destination space stop execution. Nested symlinks
are copied without following them. macOS uses `ditto`/`xattr`/`ls`; Linux requires `cp`, `getfacl`
and `getfattr`; Windows uses `robocopy` and PowerShell ACL/stream inspection. A missing metadata
inspection tool is a failure, not permission to skip verification.

The copy is always made before publication, including across filesystems. A source is renamed to
`<old-root>.brand-backup-<transaction-id>` on its own filesystem; the verified stage is renamed to
its destination on the destination filesystem. Originals are never deleted. Durable journal intent
precedes publication; file and directory fsync is used where supported. A crash between any root
rename is resumed from the journal. A failed copy or database transaction leaves originals usable;
a partial publication blocks normal startup until resumed or rolled back.

An existing empty target or known log target is inventoried under the same migration lock and
rechecked after staging and immediately before publication. Its original directory is renamed to
`<new-root>.brand-existing-<transaction-id>` before the source is backed up. This preserves its
inode, contents and metadata. The durable receipt records both original manifests before any root
moves. Execution and subsequent dry-run output list these additional archives in
`existingTargetBackups`; `backups` lists the original source backups. Neither archive is deleted
automatically. Unexpected writes, missing archives or changed manifests stop recovery instead of
choosing another tree. Startup uses this same logic automatically, before its writers open.

For stationary roots, only affected files move to the private backup bundle; the root itself stays in place. Every new backup/parking ancestor is persisted before originals move, and cross-directory renames synchronize both parent directories on POSIX.

After publication, owned old-root aliases point to new roots. They are transitional dependencies
for absolute interpreter prefixes, scripts and encrypted/external configuration. Owned CLI shims are regenerated from the actual installation path at startup. Windows profile moves remove only the old owned PATH snapshot and install the new entry using the existing compare-and-set PATH journal; a separate launcher intent resumes interruptions. A user-modified PATH snapshot blocks that transition and must be reconciled before alias retirement.
They are not duplicate data trees. The original byte-for-byte trees remain separate backups.
Failure is surfaced as a startup failure with the helper's reason; the app does not switch to an
empty directory. The normal startup error handling reports failures after Electron initialization.

## Database and document references

The SQLite adapter enumerates actual tables and columns and checks integrity and foreign keys.
It executes a single `BEGIN IMMEDIATE` transaction against the staged DB plus its copied WAL bundle.
Only these mutable path fields are rewritten:

| Table                 | Mutable field                                 |
| --------------------- | --------------------------------------------- |
| `GrantedLocalRoot`    | `path`                                        |
| `ProjectPreviewState` | `items[].path`                                |
| `ComputeHost`         | `sshOverrides.identityFile`                   |
| `ComputeJob`          | `inputManifest[]` upload entries' `localPath` |

The schema review covers `prisma/schema.prisma`, the generated SQLite runtime schema and migrations,
plus the consumers in storage/content repositories, preview persistence, permission grants,
session projection, Notebook and compute dispatch/recovery. Other path-looking columns have these
specific meanings:

- `ManagedFile`, `ContentBlob`, `ArtifactMessageSnapshot`, `ArtifactVersionInput` and
  `ReviewScopeSnapshot.storageKey`, plus `ArtifactVersion.executionSnapshotStorageKey`, are relative
  content keys resolved by their storage-root owner; their values and checksums stay unchanged.
- Artifact execution/message snapshots, version input evidence, review snapshots and projection
  fingerprints preserve immutable provenance and file identity. They are not mutable file locators.
- `ComputeHost.scratchRoot`, `ComputeJob.remoteWorkdir`, remote handles, output/harvest manifests and
  remote file evidence refer to the remote host. Local home-root mappings never rewrite them;
  existing jobs follow the explicit remote transition described below.
- Permission qualifiers are capability categories or versioned digests, not filesystem roots
  (`permission-grants/registry.ts`). Replacing text inside them would invent a different approval.
- Memory, literature metadata, user messages, notes, commands, URLs and encrypted credentials are
  user or external content. No recursive string replacement is applied to these records.

Rewrites use exact root mappings, path-component boundaries, Windows separator/case rules, and
file-URI decoding/encoding. Similar prefixes, external paths and relative content/storage keys are
not rewritten. IDs, project/session ownership, lineage, version relations, checksums, immutable
execution evidence and user text remain unchanged. Pending managed-file writes or Compute Job
operations block offline migration. Session projection fingerprints are preserved; they are not path fields. The startup head-repair path preserves a same-version, same-session
`ManagedFile.messageId`; a new user edit keeps the existing distinct publication semantics.

Protected Compute Job JSON is an array envelope, not plaintext. The offline phase records a pending
reconciliation and retains its alias. After Electron's OS credential store is ready, but before the
application DB client opens, the app decrypts only this field, maps upload paths, and encrypts it
again within a SQLite transaction in a second private staging bundle. A durable intent stores the encrypted bundle manifests before publication; offline `--resume` or `--rollback` can recover an interrupted publication without decrypting anything. Original DB/WAL backups remain available. Key-store/decryption
failure stops startup; no plaintext or credentials enter the journal. Retrying is idempotent. The
receipt records hashes of validated encrypted values for later alias auditing.

Known document adapters cover `settings.json` (data root, agent executables, manual interpreters,
legacy granted roots and disabled runtime entries), `sessions/<project>/<session>.json` (cwd,
upload/artifact paths and derived file URLs), `notebooks/<project>/<session>/run.json` (current roots,
run cwd/working files/artifacts), and `task-runs.json`. Relative `$DATA/` values remain portable.
Runtime operations must be settled. Installation authorizations are not transferred to a new runtime
identity. User messages, tool inputs, historical frozen snapshots and provenance are not recursively
rewritten. Arbitrary MCP commands/env and third-party databases require their own explicit repair;
remaining old-root dependencies block alias retirement.

## Operator commands

Stop the app and all of its interpreter/CLI children first. Use Node.js 22.16 or later (with
`node:sqlite`), or run the shipped Electron payload with `ELECTRON_RUN_AS_NODE=1` and the unpacked
`resources/brand-migration/cli.mjs`. Do not set `HOME` to simulate another account's keychain.
The following Unix example deliberately names a **disposable fixture**, not a real home:

```sh
node scripts/migrate-brand-paths.mjs --home /absolute/fixture --app-data /absolute/fixture/appData --mode dev
node scripts/migrate-brand-paths.mjs --home /absolute/fixture --app-data /absolute/fixture/appData --mode dev --execute
node scripts/migrate-brand-paths.mjs --home /absolute/fixture --app-data /absolute/fixture/appData --mode dev --resume --recover-lock
node scripts/migrate-brand-paths.mjs --home /absolute/fixture --app-data /absolute/fixture/appData --mode dev --rollback --recover-lock
node scripts/migrate-brand-paths.mjs --home /absolute/fixture --app-data /absolute/fixture/appData --mode dev --audit-aliases
node scripts/migrate-brand-paths.mjs --home /absolute/fixture --app-data /absolute/fixture/appData --mode dev --retire-aliases
```

For packaged data use `--mode packaged`; supply actual `--app-data`, `--config-root`,
`--user-data`, `--local-app-data` and repeated `--temp-parent` overrides as applicable. Use
`--state-dir /absolute/sibling-state` only to select a separate receipt location deliberately. An
additional confirmed map is JSON, for example
`--map '{"from":"/absolute/legacy-root","to":"/absolute/new-root"}'`. Never pass an arbitrary
string replacement. Explicit `--dry-run` cannot be combined with a writing action.

Resume reuses the saved transaction and validates derived stage/backup paths before touching them.
Rollback verifies original backups and the published/parked generation, restores originals, and
retains the newer tree as `<stage>.rolled-back`. Interrupted rollback resumes with `--rollback`.
If an existing target was archived, rollback also restores that original target to its original
name, after restoring the old source. Both pre-migration trees are therefore recovered, including
the empty target or the independent new logs. All backups are checked before rollback changes any
participant, and interruptions between either restoration step use the same `--rollback` command.
Rollback refuses when newer files/changes exist; retain both generations and reconcile those changes
before any restoration. It is not a destructive reset of an app that has already resumed work.
A completed rollback retains its receipt. Re-run with `--execute --restart-after-rollback`: it archives the old receipt inside the same state directory and starts a new transaction. Normal startup therefore sees the new committed receipt; original backups and parked generations are retained.
Backups are never automatically pruned by the migration CLI.

## Completing the transition

A moved venv/conda/R environment is not assumed relocatable. The full original environment is
preserved, including pip/CRAN/user packages. Owned aliases keep embedded prefixes valid. Rebuild or
reinstall each environment at its new prefix using its complete package manifest; compare installed
packages and execute its entry points before removing the alias. Rebuildable caches may be recreated,
but original environments, user files and environment definitions are not disposable caches.

Run `--audit-aliases` after repairing generated launchers, runtime prefixes and explicit external
configuration. It reports concrete blockers without editing content. It checks direct paths,
UTF-16 strings, JSON escaping, file URIs, relative symlink targets, known document path fields and
live database columns. On Windows it also reads User and Machine PATH, expands environment variables,
and blocks retirement for any remaining old-root entry or unresolved variable. It never edits these
registry values. If a new CLI receipt's `beforePath` preserves an unowned old entry, use the app's
normal CLI uninstall (which validates/restores its owned PATH snapshot), explicitly correct the
old user PATH entry, then reinstall CLI to create a clean receipt and rerun the audit. Do not delete
or edit receipts to bypass this check.

`--retire-aliases` requires a committed receipt and no blockers, verifies
ownership of every alias, then removes only those links. Preserve the journal as the record of
migration; preserve backups until the operator has separately verified recovery requirements.

Remote activations are **user-managed**: the application does not claim ownership of arbitrary
remote home directories. The updated setup Skill provides the new canonical activation path. It
must copy/validate a named legacy activation and its dependencies under the user's remote-operation
authorization before switching; never move an active scheduler workdir. Existing jobs use their
persisted old workdir and scheduler name until terminal harvest and the existing ownership-checked
cleanup finish. New jobs use the new path and name. Old missing-workdir records use the legacy
fallback specifically for recovery; no new jobs are created through that fallback.

## Stable technical contracts

`OpenScienceAPI`, component/type/function identifiers, `OPEN_SCIENCE_*`, `open_science`, HTTP/RPC
member names, native AppContainer IDs/mutexes, signature key IDs, marketplace repository URLs and
versioned ownership markers remain compatible. The Windows helper pipe `LOCAL\OpenScience.RAccess`
is a wire contract shared with the shipped native helper; it is not a filesystem data root.
Hyphens cannot be inserted into ordinary JavaScript
identifiers. Renaming OS resource IDs or keys would create a different security/data identity.
Legacy installation/Remote.It names remain read-side discovery candidates. These are individually
reviewed technical contracts; they do not justify creating research data in old default directories.

Certificate subjects and third-party names (including Open Science Framework) remain exact. This
includes the incoming local inspection CA subject `CN=Open Science process inspection CA`; its
certificate identity is not a display label. The public-read HTTP product token is `Open-Science/1.0`:
a hyphen is valid in that product name and does not change header field names or approval policy. Original
screenshots and historical benchmark entries must not be edited to fabricate a different historical
product label; current application renders and newly generated baselines use the normalized brand.

## Occupancy, interrupted recovery, and later legacy roots

The offline precondition includes Notebook kernels, external Python/R interpreters, terminal
shells, editors, and other processes with a working directory or an open descriptor in any
participating tree. Notebook and shell launchers pass paths through `cwd`, independently of their
command lines. A parent terminal is not exempt: change its working directory out of the trees
before running the CLI. The application startup coordinator is exempt from the executable-name
check only; another process's open files are never exempted by that flag. No process is killed.

On macOS the helper uses the system `lsof` and its NUL-delimited cwd, descriptor and mapped-file
records. Linux uses the bundled read-only `linux-occupancy.py` with `/usr/bin/python3 -I -S -B`: it inspects
all visible user-space processes and their threads, including cwd/root/exe, every descriptor and mapped file.
Within one inventory round, a successfully read mapping table is shared only by the same verified thread
group identity: Linux `CLONE_THREAD` requires `CLONE_VM`. Cwd and descriptor tables can be unshared,
so they are still inspected for every thread. A new round reads maps again because `execve` can
replace a mapping table without changing the leader's start time. No occupancy conclusion is cached between probes.
An unreadable task ends the current probe as incomplete; an authorized privileged retry always
starts a new full inspection. Newly discovered task identities are inspected until the inventory
stabilizes within the existing 30-second helper budget, otherwise the operation is refused.
Directory boundaries and device/inode identities detect retained handles even through hardlinks or
alternate mount paths. Kernel threads are outside this user-space inspection capability; kernel NFS/VM services and
remote/shared-filesystem writers must be stopped separately. Exited/zombie task state is checked per
thread, not inferred for an entire thread group; PID 1, another UID or a private data directory never establish that a process is safe.
Unreadable maps, incomplete proc views (including hidepid), unstable inventories and malformed helper
reports stop the operation. A positive writer is never retried away. Failed, truncated, empty or
permission-denied inspections are not treated as an empty process list. It checks
originals, stages, destinations, original backups, existing-target backups and rollback parking
locations. Checks run before preparation, before publication, at publication boundaries and before
the committed receipt is saved. All published targets and both kinds of backups are reverified at
commit. Renaming a root does not make an already-open POSIX descriptor safe: the backup is checked
under its new name too. These checks and the application lease do not prevent an arbitrary external
program from reopening a path in the future. Keep all such writers stopped throughout migration,
recovery and retirement; the tool does not claim a mandatory filesystem-wide write lock.

Linux ordinary users commonly cannot inspect system processes. By default this blocks migration,
with an actionable error, before publication. An administrator can explicitly authorize just the
bundled read-only inspector using the following environment switch and an existing non-interactive
sudo authorization. It runs the fixed `/usr/bin/sudo -n -- /usr/bin/python3 -I -S -B -c <bundled inspector>`
with a minimal environment and JSON roots on stdin. Python site initialization and bytecode writes
are disabled. It does not prompt for a password or run the
migration, SQLite operations, copies, tests or application as root. No arbitrary helper command is
accepted. Review the bundled inspector before granting this permission; unrestricted passwordless
Python permission is not recommended as a permanent sudoers policy. Without sufficient existing
sudo authorization, or if the privileged inspection is still incomplete, migration remains blocked.

```bash
# Preview remains read-only and does not need elevated inspection.
node scripts/migrate-brand-paths.mjs --home /isolated/home --app-data /isolated/profiles --mode dev
# Explicit permission for the read-only probe; all migration writes keep the current user.
OPEN_SCIENCE_MIGRATION_PRIVILEGED_INSPECTION=1 node scripts/migrate-brand-paths.mjs \
  --home /isolated/home --app-data /isolated/profiles --mode dev --execute
# Same opt-in applies to startup, --resume, --rollback and --retire-aliases.
OPEN_SCIENCE_MIGRATION_PRIVILEGED_INSPECTION=1 node scripts/migrate-brand-paths.mjs \
  --home /isolated/home --app-data /isolated/profiles --mode dev --rollback
```

The new inspector does not change journal format, backup locations or commit/recovery ordering.
Existing version 1 and version 2 receipts, and version 3 snapshot-restart receipts, use the same
version-specific resume/rollback validation described below.
A read-only probe failure leaves the durable recovery state and both original/target backups intact.
Proc inspection proves only the visible process namespace at each check; perform migration in the
application's host namespace with all external writers stopped, not inside an unrelated container
that hides host writers. It is not a mandatory lock against future or privileged adversarial writes.

The PR Gate Linux test job installs `acl`, `attr` and `python3` and explicitly enables this probe on
the disposable runner. `lsof` is no longer a Linux dependency. Vitest and its real temporary-directory
and SQLite migrations run as the ordinary runner user. These changes are deliberately visible in
`.github/workflows/pr-gate.yml`: `protected-gate-control-plane` requires an explicit **maintainer
ruleset bypass**. Do not relocate installation or disable integrity checks to conceal that change.
The two migration Electron specs belong to `test:e2e:regressions`, the existing macOS-only PR Gate
command with Electron/Web builds and a 1200-second group budget; they are not added to Windows groups.

**Platform capability limit:** actual Windows migration currently stops because command-line
inspection does not prove that directory/file handles are unused. There is no fallback that silently
accepts PowerShell `Win32_Process` as sufficient. Windows path and URI algorithms can be tested on
another host, but that is not Windows handle or application validation. Linux also requires its
native metadata tools and sufficient visibility for the occupancy probe; a missing tool is an error.

Pure initialization and repeated empty-receipt startup use the atomic logical lease without
requiring offline probe tools. Any abandoned-lock recovery still requires the kernel guard.
Lock recovery is serialized by a kernel lock held by a small child process. On POSIX this requires
`python3` with `fcntl`; the guard is released when the helper exits or its parent pipe closes, even
if a recovery is interrupted. The `lock-guard` file is permanent and must not be deleted: retaining
one inode is part of mutual exclusion. Logical lock metadata is fully written and synchronized
before its name is atomically linked into place. A verified pair of self-owned hardlinks left by an
interruption is recoverable; unknown hardlinks and symlinks are refused. Active owner or worker PIDs
block recovery, including a reused PID that cannot safely be distinguished from the original owner.

`--recover-lock` preserves dead legacy `lock` and `lock-recovery` nodes as
`<node>.abandoned-<UUID>` after checking ownership and current identity. It does not delete the
abandoned evidence. Empty or truncated legacy metadata cannot establish an owner automatically.
The error prints an exact SHA-256 identity fingerprint and an explicit recovery command. After
stopping all old migration processes and writers, use that fingerprint; a changed node or wrong
fingerprint is refused. This is operator-authorized recovery of an inspected unknown owner, not a
PID liveness inference. For the disposable fixture above:

```sh
node scripts/migrate-brand-paths.mjs --home /absolute/fixture --app-data /absolute/fixture/appData --mode dev --resume --recover-lock --recover-incomplete-lock <fingerprint-from-error>
```

Use `--execute` instead of `--resume` if no journal was created yet. Repeat
`--recover-incomplete-lock` when separately inspected incomplete nodes each require a fingerprint.
Do not remove a lock directory or the kernel guard by hand to bypass these checks.

New and updated recovery receipts use **journal version 2**. Version 1 remains readable. The new
receipt records per-member publication/restoration intents and the exact originals verified to be
in place at rollback entry. Directory and existing-target restoration intents are persisted before
renaming either original back. An intent does not by itself prove a rename occurred. Recovery checks
the actual source, stage, backup and parked manifests. For old interrupted version-1 rollbacks,
an unprepared participant with no published manifest, or a still-staged verified member together
with its exact original, provides evidence of non-publication. A missing backup after actual
publication remains an error. A version-1 receipt is preserved as `journal-<id>.version-1.json` and upgraded under the lease
before writable processing or online adapters; older binaries
that understand only version 1 must not be used for recovery. No database schema or record identity
changes with this journal version.

Repeated pre-publication, partial-publication and committed rollback interruptions all use the
same `--rollback --recover-lock` command. Original contents must still match, and published/parked
contents must match wherever they exist. Backups are not considered restored merely because a
copy exists or the global status says `rolling-back`.

Every committed launch, resume and alias operation rediscovers supported defaults and explicitly
supplied mappings. A legacy root absent from the committed receipt is an error if it later appears.
A verified alias belonging to an existing mapping is distinguished from a new independent tree.
The helper stops before startup can initialize an empty new profile. It does not delete a receipt
and silently start a new transaction.

When the previously committed generation has not acquired newer writes, the supported way to
include a later legacy profile/root is a verified rollback followed by a new transaction. This
preserves the first receipt as `journal-<id>.rolled-back.json` in the same state directory and keeps
its backup/parked generations. Keep the same mode, overrides and explicit maps on both commands:

```sh
node scripts/migrate-brand-paths.mjs --home /absolute/fixture --app-data /absolute/fixture/appData --mode dev --rollback --recover-lock
node scripts/migrate-brand-paths.mjs --home /absolute/fixture --app-data /absolute/fixture/appData --mode dev --execute --restart-after-rollback --recover-lock
```

If rollback reports newer writes or conflicting contents, neither command overwrites them. Keep
both generations and the journal and reconcile those changes before retrying verified rollback.
Automatic merging of divergent histories is intentionally not provided. Do not use a different
`--state-dir` to bypass the receipt that protects a live installation.

Case matching uses actual filesystem identity for differently-cased roots on the current host.
Both spellings must resolve to the same directory (`dev` and `ino`), with a complete component
boundary. macOS is not assumed universally case-insensitive. Structured database/document migration,
symlink auditing and opaque executable-prefix auditing use this rule consistently; file URIs are
decoded before comparison. Retirement also inspects the configuration database even if that root
needed no reference bundle in the original transaction. Reintroduced legacy paths block retirement.
Similar names such as `OpenScience-DEV-other` remain independent paths.

## Visible startup migration

Normal application startup now opens a separate progress window before the offline worker begins
its plan and inventory. This window uses the existing brand animation, translation catalogs and
`ErrorNotice` presentation, but never imports the business application bootstrap. Its Electron
`userData`, `sessionData`, logs, crash dumps and disk cache point to a newly created temporary tree;
the window uses a nonpersistent session partition. The formal application remains before `ready`
until migration and the progress helper have finished, so displaying progress does not open the
profile being moved. Packaged startup routes the helper before normal application initialization.

The window displays the current phase, root, actual inventory count, elapsed time and overall
percentage. A census counts all participating roots before fixing the total workload; only that
initial phase is indeterminate. The percentage covers copying, repeated verification, reference
updates and commit, reaching 100% only on committed success. Native copying and metadata inspection
can hold the percentage steady until they return. Inventory counts still belong to the current scan.
After 10 seconds without an update, the window says it is waiting for the current operation.
The title and progress area stay anchored while long paths and waiting text expand downward. An
amber notice reminds users to re-add model keys after configuration migration. See
[Local data migration progress](migration-progress.md) for counting, resume and layout details.
A separate helper heartbeat keeps elapsed time and console diagnostics visible even when the
worker is inside a synchronous native copy. Scanning, copying, verification, reference updates,
durable writes and publication still use the same migration implementation and journal.

The standalone CLI streams `[brand-migration]` diagnostics to **stderr** while keeping **stdout**
a JSON plan/receipt. The application forwards stderr live instead of buffering it until exit.
The internal `--show-progress-window` option requires the validated startup owner; regular offline
CLI invocations and `--open-science-headless` startup remain terminal-only. The helper acknowledges a painted renderer before migration
starts. Known helper process IDs are exempt only from the executable-name scan; their open file
handles remain subject to the regular occupancy guard.

Closing the window or quitting its helper is prevented while migration is active. On migration
failure, the original transaction remains recoverable and the error stays visible with **Copy
diagnostics** and **Close**. The page advises retaining the journal/backups and using the recovery
procedures above; it does not execute a reset, rollback or deletion. An unexpected worker disconnect
also leaves an error surface. Successful completion closes the helper and allows the formal app to
continue. Temporary UI files are removed on a normal helper exit; forced OS termination can leave
an isolated `open-science-migration-ui-*` temporary directory, containing UI caches only.

## Restarting a preparing snapshot after logs were appended

The append exception applies only to the discovered standalone macOS `Library/Logs` brand roots.
Linux and Windows profile contents remain subject to strict snapshot verification: a changed log
inside a profile is not permission to accept other profile changes or overwrite a nonempty target.
Portable state-machine tests explicitly select the macOS path plan while using real host filesystem,
SQLite and process inspection. Separate native-plan CLI tests cover restart, resume and rollback;
the portable macOS-plan tests do not establish Linux profile-log append recovery support.

An integrity failure names the changed entries, not just their root. A count such as `5 / 5` is
an inventory count; it does not mean publication or migration succeeded. The CLI stops heartbeat
messages as soon as migration fails, even while the isolated error window remains open.

If the journal is still `preparing`, an earlier attempt may have inventoried the originals before
an old or new application instance appended to its logs. Stopping that instance does not repair the
saved snapshot: normal startup, `--resume` and `--rollback` still compare against the saved bytes.
Do not truncate the logs, delete the journal, change its hashes, or point startup at an empty profile.

After stopping all application, interpreter and terminal writers, the standalone **offline** action
below can supersede an unpublished preparing snapshot. These examples use a disposable fixture;
select the same home, mode, overrides and state directory as the original transaction:

```sh
# Read-only discovery of the current transaction.
node scripts/migrate-brand-paths.mjs --home /absolute/fixture --app-data /absolute/fixture/appData --mode dev
# Explicitly accept only proven appends in existing application .log files and execute a new generation.
node scripts/migrate-brand-paths.mjs --home /absolute/fixture --app-data /absolute/fixture/appData --mode dev --restart-preparing --recover-lock
# Finish a restart interrupted after its durable intent, or continue preparing its accepted generation.
node scripts/migrate-brand-paths.mjs --home /absolute/fixture --app-data /absolute/fixture/appData --mode dev --resume --recover-lock
# Roll back the newly committed generation using its normal verified backups.
node scripts/migrate-brand-paths.mjs --home /absolute/fixture --app-data /absolute/fixture/appData --mode dev --rollback --recover-lock
```

`--restart-preparing` is a standalone writing action, incompatible with `--dry-run`, other actions
or an application startup owner. Automatic startup never selects it. Eligibility is deliberately
narrow:

- The whole transaction must still be `preparing`. No publication, protected-path or launcher
  transaction, backup, restoration intent or parked rollback generation may exist. Sources and
  existing targets must remain plain original directories; unexpected destinations block recovery.
- Existing `.log` files in discovered application log roots may have additional bytes only when
  their original prefix hashes still match. Both the old and the independently existing new log
  trees are checked and preserved separately. The file list, permissions, ownership, links and
  extended metadata must remain unchanged. Rotation, deletion, truncation, replacement of the
  original prefix, new files and changes to non-log content require separate reconciliation.
- Every data/profile/reference participant, including actual SQLite bytes, must still match the
  original manifest. No record IDs, relationships or historical text are refreshed through a
  blanket replacement. The rediscovered roots and reference participants must match the old plan.
- Real occupancy is checked under the migration's OS guard. Both the originals and the accepted
  replacement snapshot are rechecked before intent/publication of the new receipt. Writers must
  stay stopped; this does not create a mandatory filesystem-wide write lock.

Before installing a replacement receipt, the original receipt is durably copied to
`<stateDir>/journal-<old-id>.superseded.json`. **All old staging directories remain at the paths in
that receipt**, untouched by the new transaction. A new UUID gives the replacement different stage,
source-backup and existing-target-backup names. No journal is deleted to bypass verification. A failed
ordinary resume now checks original and existing-target integrity before removing any old staging.

Restart uses **journal version 3**: an intermediate `restarting` receipt durably identifies the
accepted replacement, then atomically installs its `preparing` receipt with `restartOf`. Versions
1 and 2 remain readable; ordinary migrations continue using version 2. Previous executables that
only understand versions 1/2 reject version 3 rather than guessing how to resume it. Keep the updated
script for all recovery of a restarted generation. The database schema version does not change.

An interruption before intent leaves the original receipt and any completed archive intact; repeat
`--restart-preparing`. After intent, ordinary startup stops with a recovery instruction; either
`--resume` or `--restart-preparing` validates the archive and completes installation. After replacement,
repeating the action resumes the same accepted generation (and returns the existing result if it has
committed), rather than creating another generation. The archived receipt must exactly match the
intent; tampering, missing archives and unsafe paths block recovery. If files change again after an
intent was saved, recovery stops: it never silently refreshes the accepted snapshot.

Rollback of the new generation restores both log trees with their accepted appended bytes and
retains the newer parked tree and every earlier archive/stage. A `prepared`, partially published,
committed or rolling-back original transaction cannot use this shortcut. Its existing resume/rollback
and conflict-reconciliation requirements still apply. No backup or superseded generation is pruned
by this command.
