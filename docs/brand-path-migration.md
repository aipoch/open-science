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
- Both: stop with both exact paths. No merge, overwrite, deletion, or silent preference.

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
versioned ownership markers remain compatible. Hyphens cannot be inserted into ordinary JavaScript
identifiers. Renaming OS resource IDs or keys would create a different security/data identity.
Legacy installation/Remote.It names remain read-side discovery candidates. These are individually
reviewed technical contracts; they do not justify creating research data in old default directories.

Certificate subjects and third-party names (including Open Science Framework) remain exact. Original
screenshots and historical benchmark entries must not be edited to fabricate a different historical
product label; current application renders and newly generated baselines use the normalized brand.
