# Brand and location compatibility

The product displays **Open-Science** (or **open-science** where lowercase is appropriate).
Display names are separate from persistent identities and filesystem locations. New versions use the
new brand; old installation names and launchers may remain. Installing or launching a new version
does not proactively rename, remove, or take over an old application.

Only this project's product name uses the hyphenated spelling. Third-party official names remain
**Open Science Framework** and **Center for Open Science**, including search results, quotations,
and test fixtures. URLs retain their exact remote addresses. Historical facts and quoted names
retain their original spelling. Technical identities and historical storage paths follow the
compatibility rules below; they are not display copy to mechanically rename.
The SignPath test certificate retains main's real subject,
`CN=Test certificate for 'Open Science [OSS]'`. Application IDs, release signing identities and
certificate verification policies also follow main; display branding does not request a new certificate.
macOS retains main's existing ad-hoc signing path, not a newly obtained Developer ID or a guarantee
that upgrades avoid system authorization. The credential probe and validator remain unpacked and
signed before the outer application.

The process TLS inspection CA (`CN=Open-Science process inspection CA`) is separate from application
release code signing. Its root/leaf subjects describe the sandbox's TLS inspection certificates, not
the publisher's identity. This change introduces no certificate, trust-store or credential migration.

## Existing installations

An absolute saved `dataRoot` stays authoritative, including custom paths containing an old brand.
For a legacy installation that has never completed a recorded selection, startup examines the current and historical default roots and the original
configuration root for actual research data, using the same legacy ownership evidence as manual
adoption. Generic `models` and `uploads` contents alone cannot establish application ownership.
Unrecorded symlinked directories or files are content to preserve, not ownership evidence; startup
and manual adoption do not follow them to infer a legacy root. An authoritative saved location
remains unchanged even when it contains links.
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
Migration preparation rechecks the confirmed target after asynchronous validation before owner-verified
cache cleanup. An `environment-inventory` directory name alone grants no deletion rights; unowned
runtime content is preserved and blocks staging.

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
research data disk. Production keeps its existing platform-local ownership and tool receipts. Test instances must never
modify the user's real Dock, shortcuts, application installations, or credentials.

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

## Installed applications and launchers

- macOS packaging names the bundle, executable, menu, and display metadata `Open-Science`.
  `/Applications/Open Science.app` and `/Applications/Open-Science.app` may coexist. Launching new
  code from an old-name bundle leaves that physical path intact: startup performs no brand-related
  rename, LaunchServices repair, Dock edit, or forced restart, and coexistence alone does not block
  startup. The DMG installation assistant stages the source bundle and replaces only the destination
  with the same filename. A failed replacement restores that same destination; concurrent requests
  join one transaction. An old-name sibling is neither inspected for takeover nor replaced.
- Windows retains the application ID, executable identity, and `.science` ProgID. New installer,
  uninstall and shortcut display names use the new brand. Normal installer/update/uninstall behavior
  and file/protocol registration remain; startup does not scan or rewrite old shortcuts, taskbar pins,
  or implicit shell entries. There is no brand-specific shortcut retention/rename notification hook.
  The standalone, explicitly confirmed data-reset tool still recognizes both brand names for data,
  profiles and runtime cache parents, and blocks deletion on incomplete or damaged profile selections.
- Linux retains package/desktop identifiers. New package metadata and launchers use the new brand.
  Startup does not rewrite user desktop-entry copies. Debian keeps main's normal CLI registration:
  install its own wrapper before removing the exact superseded executable alternative at the same
  product location. It does not additionally remove old-brand alternatives from other installations.
  Normal sandbox, MIME, desktop database and AppArmor setup remain.
- Standalone CLI discovery is read-only and checks only current new-brand default installation
  locations, after the existing repository development lookup. It does not enumerate old/mixed names
  or search arbitrary Linux PATH directories; public CLI wrappers are not desktop executables.
  `--app-path` takes precedence over `OPEN_SCIENCE_APP_PATH`, then automatic discovery. Explicit valid
  old-name, custom and mixed-name executable paths remain supported. A missing explicit selection
  errors on that path instead of falling back to another installation.
- App-installed CLI launchers bind to that application's executable; AppImage launchers bind to the
  stable AppImage file and mount its payload per invocation, never to a temporary FUSE path. Startup
  maintenance repairs confirmed missing bindings, not brand-copy differences or surviving bindings to
  another installation. Unknown formats and unreadable bindings require explicit handling, not
  automatic takeover. Users can explicitly reinstall/rebind or uninstall app-managed launchers.
  Old managed launcher and Windows PATH receipt ownership markers remain accepted; unrelated files
  remain protected by the existing ownership checks.

Normal installation and updater replacement, permission checks, update eligibility and signing
configuration are retained. Technical app IDs, protocols, signatures, certificate subjects, update
feeds and credential identities are not mechanically renamed. Normal update behavior may change its
own managed entries; it does not promise to remove every old application copy, Dock icon or shortcut.
Users can choose which application and launcher to keep. Windows registered installation IDs and Linux
package IDs remain shared, so this is not a promise of independently managed installer slots on every OS.

Installation paths do not select research data or encryption identity. Existing valid settings,
Electron profiles and credentials remain in use. Credential identity selection and
`verifyCredentialCiphertexts` still run before settings writers; see
[credential identity](credential-identity.md). Selecting `settings.dataRoot` does not replace either
profile or credential recovery. No installation rename or data migration is required for compatibility.
There is no special migration, mixed-identity decryption or re-encryption layer for unpublished
intermediate PR versions; identity failures preserve evidence and require recovery.

Coexistence does **not** authorize concurrent writes. The startup lock is acquired for the resolved
Electron profile before initialization writes, and arguments from a second launch are retained while
startup finishes. Packaged builds keep this lock even if the development multi-instance variable is
set. For parallel development, use separate task configuration/profile/data roots. Different profiles
pointing at the same research root, older binaries with different locking behavior, and cross-version
database downgrade compatibility are not made safe by allowing coexisting application files. Close
one version before opening another against the same data; do not assume a newer database can be read
by an older release.

## Acceptance and verification boundaries

Behavior regressions exercise the real startup entry with native APIs doubled: old/new macOS bundle
names can coexist, old-name launches do not mutate system entries or restart, and a second process
resolving the same profile cannot reach initialization writers. Startup argument forwarding and
credential validation ordering remain covered. Temporary bundle tests exercise actual macOS `ditto`
staging, same-name replacement and failure rollback, without touching `/Applications` or the Dock.
A rendered Debian post-install hook captures OS commands to verify that unrelated old-brand
alternatives survive. CLI tests cover new-default discovery, refusal to automatically select old or
mixed-name layouts, explicit bindings to those layouts, and preservation of coexisting bindings.

Storage/profile regressions must continue to cover authoritative old/custom selections, fresh defaults,
development/isolation precedence, missing or corrupt settings, missing profiles, ambiguous roots,
untrusted generic directories/links, and target replacement during migration. These protections are
independent of the removed system-entry repair. Migration remains a user-confirmed operation.

In-memory/mock tests, temporary bundle copies and installer compilation are not native installation
or upgrade certification. macOS/Windows/Linux installer, signing, file/protocol launch, shell cache,
actual Keychain/DPAPI, live updater and full application E2E verification must be reported separately;
no cross-platform success follows from these local regressions alone.

## Intentionally retained old spellings

| Spelling or family                                                                                                                             | Reason                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OpenScience`, `OpenScience-DEV`, `Open Science (DEV)`, `Open Science.app` in storage/profile compatibility and explicit installation fixtures | Recognize existing data/profiles and support explicitly bound installations without renaming or moving them; standalone CLI discovery does not enumerate old installations.                              |
| `Open Science` / `Open Science (DEV)` in credential selection                                                                                  | Legacy macOS Keychain identity after a new-name miss; stable Linux Secret Service technical identity for new and existing users. See [credential identity](credential-identity.md) for platform support. |
| Windows `Open Science Session package`                                                                                                         | Persisted `.science` ProgID. Its display description changes; registering a second class would break upgrades.                                                                                           |
| `OpenScienceTmp`, `.openscience/jobs`, `.openscience/environments`, `openscience-<job-id>`                                                     | Existing owned caches, remote records, activation files, and scheduler recovery; new resources use the new spelling.                                                                                     |
| `OpenScienceAPI`, `OpenScienceClient`, `OpenScienceApiError`, exported functions, GraphQL operation names, settings fields                     | Valid language/API identifiers and persisted contracts; inserting a hyphen would break syntax or consumers.                                                                                              |
| `openscience-skills`, marketplace protocols, repository URLs, signing key IDs, content digest prefix                                           | Published and signed third-party-facing contracts. Display copy is updated without changing signed bytes.                                                                                                |
| `# Open Science:` Codex route markers; old CLI/PATH receipt ownership headers                                                                  | Exact managed-block/receipt recognition across upgrades. They are technical ownership markers.                                                                                                           |
| `CHANGELOG.md`, rollback-to-0.7.3 fixtures and old-version paths                                                                               | Historical facts and explicit old-version compatibility.                                                                                                                                                 |
| `Electron.app` in development tooling                                                                                                          | Upstream Electron runtime filename; its development product display metadata is Open-Science (DEV).                                                                                                      |

NCBI request `tool=OpenScience` remains a stable external client identifier.

Regression fixtures deliberately keep old spellings to prove backward compatibility. This table does
not authorize adding new old-brand user-facing copy or new old-brand default locations.

New Windows Notebook ownership records use `Aipoch/Open-Science/notebook-sandbox`. Existing records
under `Aipoch/OpenScience/notebook-sandbox` stay in place; two populated roots require explicit
recovery. Isolated runs keep ownership under the configuration root. AppContainer, WFP, mutex and
named-pipe identifiers such as `Aipoch.OpenScience.Notebook` and `OpenScience.RAccess` are retained
security identities so upgrades and uninstall can manage the original resources.

## RIS exchange markers

New RIS exports write only `Open-Science literal creator: ` notes. Import accepts both that prefix
and historical `Open Science literal creator: ` notes, slicing JSON using the actual matched prefix.
The marker's structure, creator tag, index and literal must match the visible RIS creator field.
This preserves institution names containing commas for editors and translators, including book
`A3` versus other item types' `A2` editors. Malformed, out-of-range, mismatched or stale notes after
third-party edits cannot override the visible fields.

This is **write new, read new and old** compatibility. It does not promise that an old app can read
new markers; exports do not emit duplicate old/new notes. No historical RIS file, database or existing
literature record is rewritten. The old prefix remains solely as a read-compatibility identity and
in fixed historical test fixtures.

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

Managed Codex configuration blocks use `# Open-Science:` markers for new writes. Exact historical
`# Open Science:` marker pairs and preserved-line records remain readable so changing or removing
a managed route restores user configuration. Unrelated comments and TOML values are not renamed.
