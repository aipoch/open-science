# Brand and location compatibility

The product displays **Open-Science** (or **open-science** where lowercase is appropriate).
Display names are separate from persistent identities and filesystem locations.

Only this project's product name uses the hyphenated spelling. Third-party official names remain
**Open Science Framework** and **Center for Open Science**, including search results, quotations,
and test fixtures. URLs retain their exact remote addresses. Historical facts and quoted names
retain their original spelling. Technical identities and historical storage paths follow the
compatibility rules below; they are not display copy to mechanically rename.
The configured SignPath test certificate subject is `CN=Test certificate for 'Open-Science [OSS]'`;
the process inspection CA uses `CN=Open-Science process inspection CA` for both its self-signed root
and issued leaf certificates. These certificate subjects are not legacy-spelling exceptions.

## Existing installations

An absolute saved `dataRoot` stays authoritative, including custom paths containing an old brand.
For a legacy installation that has never completed a recorded selection, startup examines the current and historical default roots and the original
configuration root for actual research data, using the same legacy ownership evidence as manual
adoption. Generic `models` and `uploads` contents alone cannot establish application ownership.
Runtime alone is not evidence of the active data root:
migration can leave it at the old location. Empty scaffolding does not identify an existing installation. A single verified location is recorded before locale, database, or application writers
start. Uncommitted migration targets are never adopted by inference. Multiple candidates, unreadable
locations, damaged settings, and lost pointers with remaining configuration require recovery. A pending
migration cleanup journal also blocks inference until the original settings pointer is recovered. A
verified initial bootstrap record can resume onboarding at its original location, including its runtime.
A completed `electron-profile.json` proves that settings already pinned a location. If that settings
pointer is missing, startup first reads its durable recovery records; it never infers the current
root from a unique old default copy. Restore the verified settings selection before restarting.

The Electron profile has a separate `electron-profile.json` selection in the configuration root.
It retains the original physical profile, session cache, and log location. A missing recorded profile
is never silently recreated, even when an environment override resolves to that same path. Losing the record while historical configuration remains requires
restoring the original choice. The recovery dialog identifies the relevant file and location.
Restore the original settings/profile record or set its absolute path to the verified existing
folder; do not delete the remaining configuration to bypass recovery.

No brand upgrade relocates research data or rewrites database/session/attachment/runtime paths.
Settings still supports an explicit, verified change of data location. "Use default location" passes
the displayed full destination through inspection, confirmation and execution, while ordinary folder
picking retains legacy/custom-folder adoption. A generic `models`, `uploads` or `runtime` directory
does not establish ownership of the selected parent. Brand-named children with research content are
resolved separately; an unbranded custom root needs an application workspace ownership receipt or
an authoritative saved selection. Ambiguous or unverified content is preserved and requires explicit
recovery, rather than being adopted or overwritten. Displayed paths are the real paths. The initial empty default is recorded separately so onboarding may still select an appropriate
local drive, while later onboarding runs cannot replace a populated or missing saved root.
Pinning an old in-place configuration/data layout does not dismiss its one-time migration suggestion.
It remains available only while research content is there and the user has neither dismissed it nor
selected a different root. Showing the suggestion never moves data automatically.

## Fresh installations and development

| Resource                           | New default                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| Research data                      | `~/Open-Science`                                                                      |
| Development data                   | `~/Open-Science-DEV`                                                                  |
| Configuration                      | `~/.open-science` (development: `~/.open-science-project`)                            |
| Electron profile                   | Platform application-data folder / `Open-Science` (development: `Open-Science (DEV)`) |
| Windows tool cache                 | Local application-data folder / `Open-Science/tools/micromamba`                       |
| Windows runtime working cache      | Verified `Open-ScienceTmp` parent, or existing supported fallback                     |
| New remote jobs                    | `<scratch>/.open-science/jobs/<id>`                                                   |
| New compute activation definitions | `~/.open-science/environments/<name>.sh`                                              |

`OPEN_SCIENCE_CONFIG_ROOT` and `OPEN_SCIENCE_USER_DATA` explicitly isolate both packaged and development
runs. `OPEN_SCIENCE_E2E_STORAGE_ROOT` remains supported. The development-only
`OPEN_SCIENCE_STORAGE_ROOT` alias remains compatible. `OPEN_SCIENCE_ALLOW_MULTI_INSTANCE=1` permits
parallel development instances; packaged builds still require the single-instance lock. Configuration
resolution is shared with bootstrap: E2E_STORAGE_ROOT, then CONFIG_ROOT, then development-only
STORAGE_ROOT, then the development/production default. Blank values are ignored and selected paths
are normalized. All such paths must be absolute. The Windows Notebook sandbox and micromamba tool
writer use that same override parser and receive the actual application mode. Without an override,
development ownership and tools stay under the development configuration root, independent of the
research data disk. Production keeps its existing platform-local ownership and tool receipts. System-entry repair is disabled for
explicitly isolated test instances, which must never rewrite the user's real Dock or shortcuts.

Existing Windows tool receipts and owned working caches remain readable at their original paths.
New installations never create `OpenScience` tool or `OpenScienceTmp` cache directories. Old and new
cache cleanup uses the same ownership, canonical-root, and ACL checks. Existing remote job workdirs
remain unchanged, including recovery of historical records without a stored workdir. Old activation
files are sourced in place; two definitions with the same name require an explicit resolution.

The first location selection is recorded synchronously under the single-instance lock, before native
profile writers and logging can run. An interrupted `.bootstrap` record is consumed only when valid and consistent with the canonical record;
completed records cannot recreate a missing data directory. Only known process-lock files are ignored
when distinguishing an untouched profile from historical state. Conflicting or damaged profile records
are preserved for recovery. Selecting a different completed profile requires an explicit
`OPEN_SCIENCE_USER_DATA`; a config-root override alone cannot redirect a recorded profile.

Invalid JSON, unreadable settings, invalid `dataRoot` and unsupported settings versions show a native
startup error with the settings file, failure reason and recovery steps before renderer or file
logging initialization. Restore a verified backup, correct the path/permissions, or use a compatible
app version; preserve the damaged file and recovery records. Startup never replaces a corrupt primary.

## Installed application and launcher updates

- macOS packaging names the bundle, executable, menu, and display metadata `Open-Science`. Squirrel's
  normal update rename is supplemented by verified in-place renaming of recognized old `.app` names.
  An occupied destination or duplicate bundle blocks repair with a clear recovery message. The app
  registers the new bundle, repairs its exact existing Dock references, and relaunches the new physical
  executable before initializing updater and CLI owners. User-named bundles are not renamed.
  Failures report the failed step and actual bundle path through a native dialog. Before a rename,
  the original bundle remains in place. After a rename, startup stops without using old launch
  references or rolling back already repaired registrations; reopen the reported new bundle to retry
  registration and Dock repair. Every retry repeats identity, duplicate-installation and signature
  checks. Restore a valid signed installation or resolve permissions/duplicates as indicated.
  The DMG installation assistant replaces a single old-name physical bundle only after verifying
  its application ID, and restores its original path if installation fails. Coexisting old/new
  bundles or a different application identity stop installation before any replacement.
- Windows retains the application ID, executable identity, and `.science` ProgID. Display descriptions,
  installer, uninstall entry, and shortcuts use the new brand. The installer preserves the matching
  same-location installation's shortcut choices during manual and updater upgrades. Renames emit shell
  rename notifications instead of unpinning. Startup repairs owned taskbar and implicit shortcut
  filenames with sparse updates that preserve arguments and working directories. Windows may cache
  a pinned tooltip until the next sign-in; this cannot be certified by a file rename alone.
  The standalone, explicitly confirmed data-reset tool recognizes both brand names for data,
  Electron profiles and runtime cache parents. An incomplete, damaged or nonstandard profile
  selection blocks reset before deletion and requires manual review; the selection is preserved.
- Linux retains package/desktop identifiers. Package metadata and launchers use the new product path;
  Debian registers the replacement CLI alternative before removing exact historical product targets.
  Unrelated manual alternatives remain untouched. Owned user desktop-entry copies retain their
  `Exec` arguments while updating owned `TryExec`, `Path`, display and icon installation references.
  Custom working directories, unrelated executables and other desktop-entry groups stay intact. AppImages only repair their own entries; they do not redirect a coexisting deb installation.
- CLI discovery accepts old/new installation directories crossed with old/new executable names.
  Old managed launcher and Windows PATH-receipt ownership markers remain accepted for repair.

Native shell integration must also be tested on each target OS. Host-independent tests or installer
compilation do not certify Windows taskbar, Linux desktop, signing, or live updater behavior.

## Intentionally retained old spellings

| Spelling or family                                                                                                         | Reason                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OpenScience`, `OpenScience-DEV`, `Open Science (DEV)`, `Open Science.app` in location/upgrade code                        | Read existing data, profiles, applications, and shortcuts without moving research data.                                                             |
| `Open Science` / `Open Science (DEV)` in credential selection                                                              | Legacy macOS Keychain identity, selected only after a silent new-name miss; see [credential identity](credential-identity.md) for platform support. |
| Windows `Open Science Session package`                                                                                     | Persisted `.science` ProgID. Its display description changes; registering a second class would break upgrades.                                      |
| `OpenScienceTmp`, `.openscience/jobs`, `.openscience/environments`, `openscience-<job-id>`                                 | Existing owned caches, remote records, activation files, and scheduler recovery; new resources use the new spelling.                                |
| `OpenScienceAPI`, `OpenScienceClient`, `OpenScienceApiError`, exported functions, GraphQL operation names, settings fields | Valid language/API identifiers and persisted contracts; inserting a hyphen would break syntax or consumers.                                         |
| `openscience-skills`, marketplace protocols, repository URLs, signing key IDs, content digest prefix                       | Published and signed third-party-facing contracts. Display copy is updated without changing signed bytes.                                           |
| `# Open Science:` Codex route markers; old CLI/PATH receipt ownership headers                                              | Exact managed-block/receipt recognition across upgrades. They are technical ownership markers.                                                      |
| `CHANGELOG.md`, rollback-to-0.7.3 fixtures and old-version paths                                                           | Historical facts and explicit old-version compatibility.                                                                                            |
| `Electron.app` in development tooling                                                                                      | Upstream Electron runtime filename; its development product display metadata is Open-Science (DEV).                                                 |

NCBI request `tool=OpenScience` remains a stable external client identifier.

Regression fixtures deliberately keep old spellings to prove backward compatibility. This table does
not authorize adding new old-brand user-facing copy or new old-brand default locations.

New Windows Notebook ownership records use `Aipoch/Open-Science/notebook-sandbox`. Existing records
under `Aipoch/OpenScience/notebook-sandbox` stay in place; two populated roots require explicit
recovery. Isolated runs keep ownership under the configuration root. AppContainer, WFP, mutex and
named-pipe identifiers such as `Aipoch.OpenScience.Notebook` and `OpenScience.RAccess` are retained
security identities so upgrades and uninstall can manage the original resources.

## Explicit location changes

Inspection returns the exact target, intended operation and observed directory/ownership identity.
The renderer carries that selection into adoption or migration instead of resolving the parent again.
A changed parent, target, ownership receipt or operation requires a fresh inspection and confirmation.
Adoption never recreates a missing target. Settings recheck the selection after queued writes and
staging, immediately before atomically publishing the pointer; a failed guard preserves the old
settings and removes its uncommitted temporary file.

Both default-location actions use `defaultDataRoot`, including the legacy-layout migration prompt.
Ordinary folder picking still recognizes verified legacy and custom roots. An isolated default nested
inside the current data root is refused by the same containment guard; explicitly choose a separate
folder. No upgrade-triggered migration is introduced.
