# Maintaining native components

This workflow covers three first-party packages: `credential-identity-probe-native`,
`process-tree-native`, and `safe-file-publisher-native`. Normal dependency installation and
packaging reuse the exact binaries pinned in `build/native-components-lock.json`: signed on
macOS/Windows and checksum-verified on Linux. End users receive these files inside the application;
the application does not download them at runtime.

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
