# Windows Notebook runtime

AppContainer remains the execution boundary. It requires these runtime repairs:

- Node 24.21.0: backport only `deps/uv/src/win/pipe.c` from
  [libuv f46e424](https://github.com/libuv/libuv/commit/f46e4246b5277fe1c5888b88b24d8b78020dd4f8).
  AppContainer child stdio pipes must use the `LOCAL` namespace. The previous
  libuv implementation can block synchronously before the child timeout starts.
- Node package-scope traversal: stop CommonJS and ESM ancestor searches when a
  package config cannot be read and its directory metadata cannot be queried
  inside AppContainer. Ancestor grants intentionally allow traversal and
  metadata reads without directory listing. A readable package config remains authoritative, including its
  `type`, `imports` and `exports`. An unreadable config inside a readable directory,
  or malformed JSON, still fails. Direct package reads keep upstream error handling.
  This repair does not grant ancestor ACLs, create workspace package files, or
  enable Node's separate permission model. Outside AppContainer it has no effect.
- PowerShell 7.6.5: skip inaccessible mapped drives when initializing providers,
  and preserve inaccessible ancestor components during path normalization while
  still validating the final item. Windows permits access to a granted descendant
  without granting metadata access to every ancestor. Neither change grants ACLs.
- Bundled npm: seed Arborist's realpath cache at the shared prefix after the host
  validates its physical path and grants that directory. Descendant links still
  undergo normal resolution, and unapproved targets remain denied. This narrowly
  scoped JavaScript staging repair does not change Node or PowerShell executables.

## Using a prebuilt runtime in development

Use the `windows-notebook-runtime-<run-id>-<attempt>` artifact from a successful
runtime preparation job whose pinned sources, patches and build script match this
checkout. Verify the downloaded ZIP's SHA-256 against that artifact's GitHub digest
before extracting it into this directory's ignored `x64/` folder. The extracted
`build.json`, `node/` and `powershell/` entries must be directly inside `x64/`.
Check the actual Node and PowerShell versions against `sources.json`, then run
`node packages/notebook-network-sandbox/vendor/windows-runtime/npm/prepare.mjs`
to apply the checksum-verified npm repair to an older matching compiled runtime.
Unknown npm sources fail closed. Then run
`node scripts/check-windows-notebook-runtime.mjs` from the repository root.
Preserve an existing runtime until the replacement has been verified.

These CI artifacts currently have a short retention period; they are not a durable
download distribution. Automatic development downloads are not implemented yet.
Packaged applications prepare separate verified CDN components only when protection
is enabled. Standard development does not require these source-build fixtures.
Rebuilding is a maintainer task when sources or patches change.

## On-demand distribution

Application packages omit Node and PowerShell. Standard-mode new Sessions retain
Windows PowerShell 5.1 and the Electron-backed REPL. Explicit protection setup
prepares the components in the application's configuration directory under
`notebook-runtimes/<component>/<architecture>/<archive-sha256>`. This cache survives
Session deletion, disabling protection, and application upgrades. It is separate
from writable npm tools; no historical tools or Session bindings are migrated.
Incomplete downloads are discarded. Existing corrupt versions are preserved and
reported for repair, never overwritten while another process may be using them.

The application catalog pins every executable, library, module and archive byte.
Only catalog-listed official versions are candidates: a newer version number alone
does not establish AppContainer compatibility. Official installations at known
installation paths take precedence after file verification and a native probe;
otherwise an exact bundled/cached component is reused, then explicit setup can
download its CDN archive. A changed official installation is checked again before
another launch. The current catalog contains patched x64 releases; future verified
official releases can replace either component independently. Missing official
installations still need a download. A PowerShell minor-version change also needs
explicit Session binding support; changing a catalog must not reinterpret 7.6 as
another language version. Explicit protection setup/removal refreshes existing
conversations for subsequent turns, including interpreter selection, tool descriptions
and permission qualifiers. A stale in-flight capability fails closed until refreshed;
the user does not need to create a new Session.

Maintainers prepare **already signed** runtime directories with:

```powershell
$env:CDN_BASE_URL = '<configured CDN origin>'
$env:S3_PREFIX = '<configured release prefix>'
node scripts/stage-windows-notebook-components.mjs <signed-runtime-root> <output>
node scripts/windows-runtime-cdn.mjs verify <output>
```

To create the signed input without signing an application installer, dispatch
**Sign Windows Notebook runtime** from `main` with the successful `Prepare Windows Notebook runtime`
run and its exact artifact ID. The runtime path uses the separate protected
`windows-runtime-signing` environment, verifies every runtime PE file and timestamp, and uploads a
short-lived signed runtime artifact. It never writes to the CDN; pass that artifact to
**Stage Windows Notebook CDN components** with `dry_run=true` first. Keep the application
`windows-signing` environment restricted to version-tag releases. The runtime environment must have
the same Azure signing variables. Restrict its deployment branch policy to the `main` branch (not a
tag). With the repository's default OIDC subject format, add an Azure federated credential with
issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`, and
subject `repo:aipoch/open-science:environment:windows-runtime-signing`. An environment job uses the
environment subject, not `ref:refs/heads/main`; GitHub's deployment policy enforces the branch.
See the [GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc).
This is a one-time GitHub/Azure configuration requirement, not a runtime catalog or data migration.

Use the existing repository `CDN_BASE_URL` and `S3_PREFIX` values. The runtime
namespace uses the application root (the first segment of `S3_PREFIX`), matching
the Python/R runtime publisher. CDN workflows pass these values explicitly;
missing configuration or a reviewed catalog pointing elsewhere fails closed.

Staging validates source identities, repairs, every PE signature and timestamp,
and creates Node/npm and PowerShell archives plus a candidate catalog. Review and
commit the catalog before publication. `Stage Windows Notebook CDN components`
accepts an exact successful signing run and artifact ID. Its default `dry_run=true`
uploads Actions artifacts only, without signing again or writing to the CDN.
The existing `Stage runtime bundle` workflow also exposes this path through
`windows_runtime_run` and `windows_runtime_artifact`; setting these skips Python/R
staging. Source artifacts may contain `build.json`, `node/` and `powershell/`, or
an older signed installer containing that directory. Installers are extracted,
never executed by the staging workflow.

Publication uses the existing S3 credentials and content-addressed CDN keys, with
SHA-256 and S3 create-only conditions. Existing identical objects are reused;
different bytes at an existing key stop publication. There is no remote mutable
manifest and no GitHub Release publication. Application packaging checks pinned
CDN availability without rebuilding or re-signing these runtimes. Keep published
objects available for all application versions which reference them; do not apply
short-lived Actions cache/artifact retention to these CDN objects.

## Building from source (maintainers)

`sources.json` pins upstream source and portable SDK archive checksums. The runtime
patches above and the source-archive metadata patch are the complete source delta.
Build using PowerShell 7, Python 3.12+, Git, Windows' `curl.exe`, and Visual Studio
2022 C++ Build Tools with C++ Clang Compiler for Windows and MSBuild support for the
LLVM (clang-cl) toolset:

```powershell
pwsh -File packages/notebook-network-sandbox/vendor/windows-runtime/build.ps1 -BuildRoot C:\os-runtime-build
node packages/notebook-network-sandbox/vendor/windows-runtime/npm/prepare.mjs
```

Use a dedicated short build directory. No global SDK, drive, ACL, shell or Node
configuration is changed. The build retains Node/npm and PowerShell licenses.
Source transfers have connection and whole-transfer deadlines with bounded retries;
only checksum-verified downloads become reusable archives. Preparation and compiler
phases log their start so a stalled download is distinguishable from a slow build.
Source extraction uses Python's standard `tarfile` module, with a five-minute
deadline, a progress message every 30 seconds, and completion timing. This avoids
depending on the runner's selected `tar` and external decompressor. Sources are
promoted from a temporary `.extracting` directory only after successful extraction;
an interrupted extraction is retained for inspection and requires a fresh BuildRoot.
Generated `x64/` is ignored and used by native CI fixtures, not electron-builder.
`build.json` is written last; incomplete builds fail closed in preflight.

CI builds once per workflow through `windows-notebook-runtime.yml` on
`windows-2022` (VS 2022), using `.github/actions/windows-notebook-runtime`.
Windows core, E2E setup, full-test dependency snapshots and resource
probes consume its artifact by ID. The cache is keyed
by the pinned sources, patches and build script; restored binaries must pass
version and npm startup checks. E2E/dependency snapshots already include this
workspace package, so downstream jobs receive the same staged runtime.
Only the independent source-build job has a provisional 90-minute ceiling;
existing test and packaging deadlines remain unchanged. Use
PR Gate's `windows-notebook-runtime` dispatch mode to exercise the same preparation
and Windows core checks without running unrelated portable or desktop suites.
The action applies the npm staging repair after either compilation or cache
restore, before verification and artifact upload. Its checksum check is idempotent;
changing this JavaScript repair does not invalidate the compiler cache or require
recompiling the unchanged Node and PowerShell sources.

The same workflow also runs on pushes to `main` that change the compiler recipe,
runtime preparation or verification, or the workflow itself. This warms the default
branch cache for subsequent PRs: GitHub isolates caches written under a PR merge
ref, so another PR cannot reuse them even when the recipe hash is identical.
Ordinary application and Notebook source changes reuse the exact matching cache;
they do not trigger the standalone warm-up. Tests still receive and verify the
runtime on every selected run. Only a cache miss requires source compilation.

To populate a missing or evicted shared cache without running the test suites,
manually dispatch **Prepare Windows Notebook runtime** on `main`. A cold recipe
still needs one source build on `main`, including after merging a recipe change
already built in a PR. PRs started before warm-up finishes, or after cache eviction,
can also compile on a miss; this cache is an optimization, not durable storage.
See [GitHub's cache access restrictions](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache).

PowerShell release archives do not include Git metadata. The builder supplies the
pinned upstream source commit to its MSBuild version target and records that commit
in `build.json`, so builds never infer a PowerShell commit from this application's
enclosing Git checkout.

Notebook children receive Node's standard `--preserve-symlinks` and
`--preserve-symlinks-main` options. This extends the REPL's existing entry-point
handling to npm and descendant Node processes: module loading must not enumerate
ungranted ancestors. Module identity follows the supplied path (including any
symlink), as documented for these Node options. Arbitrary host `NODE_OPTIONS` is
not inherited. npm uses the existing disposable workload cache. Global npm tools
use the app-owned `runtime/npm/win32-<arch>` prefix shared by Shell and Windows REPL
across Sessions. Only this tool directory receives a writable sandbox grant;
bundled executables and managed Python/R environments remain read-only.
Tools survive process shutdown, Session deletion and disposable cache cleanup.
The existing data-root migration owner copies and verifies this package tree.
Host global packages and experimental Session-local `.notebook-tools/npm` packages
are not imported automatically; reinstall any needed tools with `npm install -g`.

This managed Node is limited to Windows Notebook child processes, including restoration of
existing Core-bound Sessions from cache. Electron and the development toolchain are independent.
Upgrading Notebook from Node 22
to Node 24 preserves its shared tool directory, but packages with native addons may need
reinstallation or rebuilding for Node 24. No automatic migration of those packages
or historical Notebook data is performed.

Native-addon compatibility depends on the API used by the package. A Node-API
binary built for Node 22 can remain compatible with Node 24, while addons using
Node/V8 C++ APIs can fail with `ERR_DLOPEN_FAILED` and require a compatible rebuild
or reinstall. Verify the package's actual entry point; retaining its files does
not establish binary compatibility.

Upstream Node 24 can search for an ancestor `package.json` outside the granted
workspace when evaluating `node -e` imports, and fail with
`ERR_INVALID_PACKAGE_CONFIG`. The package-scope repair treats an inaccessible
ancestor directory as the end of that search. A workspace without its own package
scope no longer inherits module settings from an inaccessible parent; readable
package scopes within granted directories retain their normal semantics. The
development asset check rejects same-version runtimes without this repair marker.

Run the real AppContainer regression on a machine with the installed product's
owned sandbox profile (normal unit tests do not provision machine resources):

```powershell
$env:RUN_WINDOWS_NOTEBOOK_RUNTIME = '1'
npx vitest run packages/notebook-network-sandbox/src/windows-notebook-runtime.integration.test.ts
```

The opt-in suite also installs generic local CJS and ESM tools with installation
scripts enabled in separate workspaces containing Unicode and spaces. It checks
that tools remain available in a fresh protected process after npm cache removal,
that installations are shared across workspaces and survive workspace deletion,
and that another workspace remains unreadable. Both the system temporary directory and the checkout's temporary
directory are exercised. It also covers CommonJS and ESM package imports through
eval, explicit module eval, print and stdin with inaccessible CommonJS and ESM
ancestor scopes, rejects malformed and unreadable configs inside readable
directories, and preserves readable workspace `type`, `imports` and `exports`.
The PR Gate Windows core lane runs the package-scope and protected workspace execution cases
inside the native lifecycle smoke's owned test installation. Setup and final removal remain owned
by that smoke. The shared-tool matrix remains available through the full integration test
invocation for scheduled or manual validation.
This does not certify arbitrary native addons, online
registry access, or a clean installed application.

New standard-mode Shell bindings record PowerShell `5.1`; new protected bindings
record verified `7.6`. Explicitly switching protection refreshes existing Sessions
to the corresponding version for subsequent turns; switching back restores 5.1.
There is no database migration or new persisted execution state. Re-running a
historical cell uses the selected Session runtime, as before. A source build is
not a signed distribution: sign changed runtime components before the independent
CDN staging workflow verifies them. Application releases reuse those signed bytes
and do not bundle or re-sign Node/PowerShell.
