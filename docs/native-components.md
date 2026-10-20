# Maintaining native components

This workflow covers three first-party packages: `credential-identity-probe-native`,
`process-tree-native`, and `safe-file-publisher-native`. Normal dependency installation and
packaging reuse the exact binaries pinned in `build/native-components-lock.json`: signed on
macOS/Windows and checksum-verified on Linux. End users receive these files inside the application;
the application does not download them at runtime.

Windows updates use the native NSIS installer for installation UI. There is no separate update
progress executable to compile, package or sign. `build/prepare-desktop.cjs` validates the target
platform/architecture and stages the backend runtime. The separate Notebook AppContainer host
still has its own native build requirements, described below.

An ordinary application release needs no native-component publication when the inputs below are
unchanged and the pinned objects remain available. The outer application and installer still need
their normal release signing. Third-party native dependencies retain their existing rebuild flow.

## Update gate and its limits

`scripts/native-components.mjs` fingerprints these inputs:

- `build/native-components.json`, including the pinned Node version and target settings;
- the `node_modules/node-gyp` record in `package-lock.json`;
- `.github/workflows/native-components.yml`, `scripts/produce-native-components.mjs`, and
  `scripts/verify-native-component-signatures.ps1`;
- each covered package's `binding.gyp` and files directly under `src/`.

Changing any of these inputs requires regenerating all five target records, because they share
one source fingerprint. The check is based on file contents, so even a comment-only edit to a
fingerprinted script invalidates the catalog. Changes to unrelated application code do not.
New build inputs outside this list must be added to the fingerprint when introduced.

Normal `postinstall` and `build:backend-native` calls validate the current target's catalog entry,
then verify every cached/downloaded file's size and SHA-256 before replacing package outputs.
Missing, stale, corrupt, unsigned where signing is required, or unsupported artifacts fail the
operation; there is no automatic compilation fallback. PR CI jobs using normal installation run
this check too. Jobs using `--ignore-scripts` do not run the postinstall gate.

This is not a dedicated all-five-target CDN gate. A passing job checks its own target, and a valid
local cache does not prove that the CDN object is still available. Before merging a catalog update,
verify downloads for every target from a clean native-component cache as described below.

## Update the binaries

Regenerate artifacts when native sources, the pinned toolchain, or the producer recipe changes:

1. Run **Stage runtime bundle** with `native_components=true` and `dry_run=true`.
   All five target jobs must pass native tests and dependency checks.
2. Run the same workflow with `dry_run=false` from a ref permitted by `windows-signing`.
   It uses the existing macOS Developer ID and Windows Azure signing configurations, verifies
   signatures, then publishes immutable objects under
   `/open-science/native-components/<target>/<sha256>/<filename>`.
3. Download all five `native-components-<target>` artifacts. Assemble their `release.json`
   records into `build/native-components-lock.json`, keyed by target. On each target, use a fresh
   checkout with producer dependencies installed, or remove only `node_modules/.cache/native-components`,
   then run `node scripts/native-components.mjs` to verify actual CDN downloads. Unsigned dry-run
   records are not accepted for macOS/Windows; Linux records use `signing: none`.
4. Commit the catalog with the source/configuration change in the same PR. Merge only after all
   target artifacts have been published and verified. The workflow does not commit the catalog,
   and merging a PR does not automatically publish native components.

With `native_components=true`, the workflow produces all five native targets; its Python/R
`version` and `subdir` inputs do not select native-component versions or targets. Signing refs must
follow the existing environment deployment policy; do not leave a temporary bootstrap exception open.

For source development, use the Node version in `build/native-components.json`, install producer
dependencies with `npm ci --ignore-scripts --no-audit`, then run `npm run build:native-source`.
This producer-only setup does not replace normal application installation. Regenerate the
published artifacts before merging source changes; the source fingerprint rejects stale binaries.
Linux still requires runtime libsecret/dbus libraries, but ordinary builds need no development headers.

## Diagnose installation or signing failures

A stale catalog needs regenerated artifacts. A corrupt cache can be removed from
`node_modules/.cache/native-components` and downloaded again. Do not disable hash validation or
replace objects already published at immutable URLs; retain objects referenced by older catalogs.

Packaging verifies the exact bytes in both `resources/backend/node_modules/@aipoch/` and
`resources/app.asar.unpacked/node_modules/@aipoch/`, under each package's `build/Release/`.
On macOS, `resources` is `Open-Science.app/Contents/Resources`. Subsequent app signing must preserve
these binaries; the after-sign check detects changes.

macOS helpers use stable Developer ID signing identifiers. Existing Keychain permissions for
Electron or older ad-hoc helpers may require one authorization when switching. Keep service/account
names, ciphertext, and Keychain ACLs intact. Verify password-prompt behavior with a real signed
A-to-B upgrade in a disposable user profile; signature checks alone cannot prove it.

This workflow adds a build catalog, retained CDN objects, and a disposable build cache. It adds no
application state or enum, database migration, or user credential format. The possible first-upgrade
Keychain authorization above is the historical compatibility concern; this change does not rewrite
existing credentials or permission records.

## How Notebook components differ

Notebook also reuses prepared artifacts, but has separate owners, catalogs, and download timing:

| Component                                  | Normal consumption                                                                                                                                                                       | Update and validation                                                                                                                                                                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The three native packages above            | Downloaded during dependency installation/build and shipped in application resources.                                                                                                    | Source fingerprint and per-target byte checks; publish all five targets and update the native catalog.                                                                                                                                                               |
| Managed Python/R environment packs         | Downloaded from the versioned CDN bundle when a managed environment is needed; a local offline bundle can also be supplied.                                                              | Update environment specs and `DEFAULT_ENV_VERSION` together, then run **Stage runtime bundle** in its default Python/R mode with the matching version. Release packaging checks the platform manifest; consumption verifies the selected archive's size and SHA-256. |
| Windows protected Notebook Node/PowerShell | Verified compatible official installations take precedence; otherwise protection setup reuses or downloads catalog-pinned signed components. Application installers omit these runtimes. | Separate source preparation, signing, and CDN publication; the application catalog is `src/main/notebook/windows-runtime-catalog.json`. Packaging checks CDN availability and size; full archive hashing is a separate check and occurs on consumption.              |
| Windows Notebook AppContainer host         | `notebook-appcontainer-host.exe` is bundled under `resources/notebook-network-sandbox`.                                                                                                  | The application build still invokes its Cargo/MSVC build. It is outside the three-package catalog above.                                                                                                                                                             |

The Python/R bundle gate checks version/platform metadata and availability; it is not this native
source-fingerprint gate. See [the bundle workflow](../.github/workflows/stage-runtime-bundle.yml)
and [environment versioning](../packages/environment/src/runtime-paths.ts) for the update contract.

For Windows Node/PowerShell, follow the [runtime maintenance guide](../packages/notebook-network-sandbox/vendor/windows-runtime/README.md).
Its CI compiler cache can rebuild on a miss and its Actions artifacts have short retention; neither
is the durable signed CDN distribution. The end-user runtime cache persists across application
upgrades. See [native host builds](../packages/notebook-network-sandbox/README.md#native-host-builds)
for the separate AppContainer host. These existing Notebook storage and compatibility rules are
unchanged by this native-component workflow.

### Windows update presentation handoff

The application owns update checking, download, verification, data saving and shutdown admission.
The visible native NSIS installer owns installation progress, errors, file replacement and launching
the updated application. No independent progress window remains; brief windowless handoffs before
installer or successor startup are allowed. Interactive Windows updates create a fresh UUID
under the current user's `%APPDATA%/Open-Science/UpdateHandoffs/<uuid>/`. The request records the
expected version, executable, installer, profile and runtime startup options. Handoff storage must
remain outside the installation being replaced. If the default root is inside that installation,
the application uses the fixed sibling `%APPDATA%/Open-Science-UpdateHandoffs/<uuid>/` instead.
Both paths are checked using their resolved filesystem locations; if both are inside the
installation, update admission still fails before shutdown. No arbitrary storage path is accepted
from command-line arguments. Each update creates a new operation, including an
automatically launched successor that immediately starts another update.

The UUID travels through the patched NSIS updater argument and the installer's Finish-page launch.
NSIS publishes atomic `accepted`, `installing`, `installed` or `failed` receipts. The new application
restores the original startup options through the normal credential/profile checks and publishes
`ready` only after backend and original-data verification and the main window has been shown.
A visible window or sampled process tree is not an installation result. This protocol covers
interactive relaunch; non-relaunching updates retain the existing silent installation behavior.

Before installer submission, cancellation records an `aborted` receipt for later cleanup. Once an
installer may be running, cancellation records `unconfirmed` and preserves the operation for
diagnosis rather than claiming success or terminating installation. There is no companion
observation deadline or unconfirmed-status window.

A later startup removes recognized aborted/failed operations only when all recorded owners have
exited. Historical operations with a helper PID also require its matching closed receipt. New
operations create neither a helper nor its binary launch input. For confirmed operations, cleanup
removes any historical helper executable and binary launch input but retains the small
configuration/receipt record until explicit uninstall.
Electron relaunch preserves argv and has a gap between old/new PIDs, so PID liveness alone cannot
prove that the configuration is no longer needed. Each successor renews its PID before opening the
profile. Once confirmed, ordinary relaunches use current data settings without repeating the original
update data-root assertion, allowing later data-folder migrations. Missing/corrupt launch configuration
fails closed. Unknown outcomes are retained for diagnosis.
Real product uninstall checks both fixed app-data roots, validates ownership/ACLs and reparse points,
checks parent/helper and exact executable paths, and removes recognized inactive operations, including
unknown outcomes. It stops for active operations rather than terminating them. Unknown files are
preserved. A historical PID that now identifies a readable unrelated executable does not block
uninstall; an unreadable recorded identity remains conservative. Update-time uninstall skips this cleanup. Legacy shared temporary helper caches are not
adopted or recursively deleted because they lack the new ownership record.

Compatibility: installers without an operation argument continue normally; an older target without
receipts cannot establish confirmed completion through this handoff protocol. Existing schema-1
requests in the original root and historical helper cleanup checks remain supported; they are not
moved. Application, NSIS and diagnostics reject duplicate operation IDs across the two roots.
The fallback is a new persistence location, not a new receipt schema, state or user-data migration.
An older target installer/application that knows only the original root cannot consume a fallback
lease; fallback updates require a target containing this support.
This does not retrofit the released macOS 1.0.0 updater.

Native process verification requires Windows. Run the maintained observer regressions with:

```powershell
node --test scripts/windows-upgrade-diagnostics/observer.node-test.mjs
```

Follow the [diagnostic guide](../scripts/windows-upgrade-diagnostics/README.md) for explicit app-data
selection, operation-bound discovery of Explorer-launched successors, historical helper observation
and ordinary-account preflight. The Windows Upgrade Diagnostics workflow runs these tools; it is
diagnostic evidence, not a new release gate or a substitute for real signed-package upgrade acceptance.

Packaging, NSIS receipt and uninstall regressions use the existing repository test entry point:

```powershell
npm test -- build/packaging.test.ts scripts/windows-update-notice.test.ts scripts/windows-update-handoff-uninstall.test.ts
```

Retain the fixtures' Windows/toolchain requirements and report skipped native cases separately.
Real upgrade acceptance must still verify installer outcome, successor readiness, profile/data
retention and normal process cleanup; seeing an installer window is insufficient.

### Windows installer extraction

NSIS embeds the official standalone 7-Zip 26.04 executable for its target architecture. The existing
`afterSign` hook downloads the pinned archive, verifies the executable and license hashes even on
cache hits, copies the tool to `out/windows-installer/<arch>`, and applies the configured Windows
signing identity to that copy. The shared cache stays unchanged. The tool runs only as a hidden,
synchronous installer child; it is not an installed updater or service. Its license and upstream
source notice accompany the application.

The same hook compiles `windows-install-publication.cs` with the Windows .NET Framework C#
compiler into an AnyCPU DLL and signs it. NSIS embeds it beside the publication PowerShell script
in its private plugin directory. Installation loads this assembly without invoking a compiler,
including when the user profile or temporary directory contains Unicode. PowerShell returns paths
as UTF-16LE, which Unicode NSIS detects without a lossy console-code-page conversion. The directory identity,
ACL and reparse-point checks are unchanged; the DLL is not installed in the application.

Only extractor exit code zero permits publication. CRC errors, truncated archives, write errors,
warnings and cancellation results fail installation. The native installer shows an extraction
stage instead of the old plugin's independent percentage. Download and installer-signature checks,
blockmaps and differential downloading are unchanged.

For an eligible ordinary-user installation, extraction uses a uniquely created child of the
installation directory after old-version removal. Directory identity, reparse points and equivalent
inherited permissions are checked before moving absent `resources` and `locales` directories.
Other files and ineligible installations retain NSIS copying and its error handling. Copy fallback
keeps the upstream short `7z-out` path inside the installer's private plugin directory. A failed
publication never proceeds to successor launch. Cleanup targets only this installer's verified
stage; uncertain identities and interrupted older stages are preserved rather than swept by name.
There is no user-data migration, new runtime state, persistent service or handoff-schema change.

Run `scripts/windows-install-publication.test.ts`, `scripts/windows-installer-extractor.test.ts` and
the packaging/signing regressions. Set `OPEN_SCIENCE_MAKENSIS` to the real compiler and
`OPEN_SCIENCE_7ZA` to the verified standalone tool for native extraction cases;
`OPEN_SCIENCE_7ZIP_EXTRA` enables real upstream-cache staging checks, and
`OPEN_SCIENCE_INSTALL_PUBLICATION_NATIVE=1` enables ordinary-user move/ACL cases. A simulated
extractor exit code 255 verifies rejection, not interactive cancellation or interrupted-install
recovery. Report unavailable native tools and unsupported fallback paths separately.
