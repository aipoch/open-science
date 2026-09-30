# Windows Notebook runtime

AppContainer remains the execution boundary. It requires these runtime repairs:

- Node 24.21.0: backport only `deps/uv/src/win/pipe.c` from
  [libuv f46e424](https://github.com/libuv/libuv/commit/f46e4246b5277fe1c5888b88b24d8b78020dd4f8).
  AppContainer child stdio pipes must use the `LOCAL` namespace. The previous
  libuv implementation can block synchronously before the child timeout starts.
- Node package-scope traversal: stop CommonJS and ESM ancestor searches when a
  package config cannot be read and its directory cannot be listed inside
  AppContainer. A readable package config remains authoritative, including its
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
Packaged applications include their runtime assets. Rebuilding the runtimes is a
maintainer task when their sources or patches change.

## Building from source

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
Generated `x64/` is ignored and copied by electron-builder outside app.asar.
`build.json` is written last; incomplete builds fail closed at runtime.
The same staged directory is used by `npm run dev`.

CI builds once per workflow through `windows-notebook-runtime.yml` on
`windows-2022` (VS 2022), using `.github/actions/windows-notebook-runtime`.
Packaging, Windows core, E2E setup, full-test dependency snapshots and resource
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

Only Windows Notebook child processes use this bundled Node. Electron and the
development toolchain are independent. Upgrading Notebook from Node 22
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
Windows core runs all 17 cases inside the native lifecycle smoke's
owned test installation; setup and final removal remain owned by that smoke.
This does not certify arbitrary native addons, online
registry access, or a clean installed application.

New Shell bindings record PowerShell `7.6`. Historical `5.1` bindings remain
readable and retain their original interpreter identity. There is no database
migration or new execution state. Re-running a historical cell uses the selected
Session runtime, as before. A source build is not a vendor-signed runtime; Windows
release packaging must include these artifacts in its normal signing process.
