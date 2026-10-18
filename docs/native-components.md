# Maintaining native components

This workflow covers three first-party packages: `credential-identity-probe-native`,
`process-tree-native`, and `safe-file-publisher-native`. Normal dependency installation and
packaging reuse the exact binaries pinned in `build/native-components-lock.json`: signed on
macOS/Windows and checksum-verified on Linux. End users receive these files inside the application;
the application does not download them at runtime.

The Windows update progress executable is an application resource, outside these three backend
packages. `build/prepare-desktop.cjs` compiles it from `build/windows-update-progress` during Windows
application packaging, before calling the unchanged backend staging flow. Windows application
builds therefore need the MSVC toolchain for this resource; dependency installation and backend
component staging do not compile it. It receives the outer application's normal Windows signing.
This separate build does not provide a compilation fallback for a missing or stale catalog entry.

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

The native progress companion owns its window only. NSIS/electron-updater retain download,
verification, installation and recovery ownership. Interactive Windows updates create a fresh UUID
under the current user's `%APPDATA%/Open-Science/UpdateHandoffs/<uuid>/`. The request records the
expected version, executable, installer, profile and runtime startup options. The helper is copied
atomically into that operation directory, outside the installation being replaced.

The UUID travels through the patched NSIS updater argument and the installer's Finish-page launch.
NSIS publishes atomic `accepted`, `installing`, `installed` or `failed` receipts. The new application
restores the original startup options through the normal credential/profile checks and publishes
`ready` only after backend and original-data verification and the main window has been shown. A visible window or sampled process tree
is not an installation result. This protocol covers interactive relaunch; non-relaunching updates
retain the existing silent installation behavior and do not create a companion.

Before handoff, aborting writes a complete cancellation marker and closes the companion. After
handoff, an ambiguous launch error or the 20-minute observation deadline displays an unconfirmed
status with a Close button. Closing that window never cancels or terminates installation. Late
valid completion receipts can still close an open unconfirmed window.

The companion records its exit. A later startup removes recognized aborted/failed operations only
when all recorded owners have exited. For confirmed operations, it removes the helper executable
and binary launch input but retains the small configuration/receipt record until explicit uninstall.
Electron relaunch preserves argv and has a gap between old/new PIDs, so PID liveness alone cannot
prove that the configuration is no longer needed. Each successor renews its PID before opening the
profile. Once confirmed, ordinary relaunches use current data settings without repeating the original
update data-root assertion, allowing later data-folder migrations. Missing/corrupt launch configuration
fails closed. Unknown outcomes are retained for diagnosis.
Real product uninstall uses the fixed app-data root, validates ownership/ACLs and reparse points,
checks parent/helper and exact executable paths, and removes recognized inactive operations, including
unknown outcomes. It stops for active operations rather than terminating them. Unknown files are
preserved. A historical PID that now identifies a readable unrelated executable does not block
uninstall; an unreadable recorded identity remains conservative. Update-time uninstall skips this cleanup. Legacy shared temporary helper caches are not
adopted or recursively deleted because they lack the new ownership record.

Compatibility: installers without an operation argument continue normally; an older target without
receipts cannot produce confirmed success in the new companion. There is no user-data schema change.
This does not retrofit the released macOS 1.0.0 updater.

Native verification requires Windows. Build the helper through the desktop preparation command,
then run `node scripts/fixtures/windows-update-progress/run.mjs success`, `installer-failure`, and
`cancel`, `unconfirmed`, `late-ready`, and `wrong-receipt`. The success fixture deliberately exposes the successor window before releasing readiness.
The PR Windows runtime lane runs these six native companion cases and the uninstall regressions.
The independent observer remains diagnostic evidence only. NSIS receipt and uninstall regressions
run in `build/packaging.test.ts` and `scripts/windows-update-handoff-uninstall.test.ts` on Windows.
