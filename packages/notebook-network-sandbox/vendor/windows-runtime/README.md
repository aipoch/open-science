# Windows Notebook runtime

AppContainer remains the execution boundary. It requires two runtime repairs:

- Node 24.21.0: backport only `deps/uv/src/win/pipe.c` from
  [libuv f46e424](https://github.com/libuv/libuv/commit/f46e4246b5277fe1c5888b88b24d8b78020dd4f8).
  AppContainer child stdio pipes must use the `LOCAL` namespace. The previous
  libuv implementation can block synchronously before the child timeout starts.
- PowerShell 7.6.5: skip inaccessible mapped drives when initializing providers,
  and preserve inaccessible ancestor components during path normalization while
  still validating the final item. Windows permits access to a granted descendant
  without granting metadata access to every ancestor. Neither change grants ACLs.

`sources.json` pins upstream source and portable SDK archive checksums. The runtime
patches above and the source-archive metadata patch are the complete source delta.
Build using PowerShell 7, Python 3.12+, Git, Windows' `curl.exe`, and Visual Studio
2022 C++ Build Tools with C++ Clang Compiler for Windows and MSBuild support for the
LLVM (clang-cl) toolset:

```powershell
pwsh -File packages/notebook-network-sandbox/vendor/windows-runtime/build.ps1 -BuildRoot C:\os-runtime-build
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

PowerShell release archives do not include Git metadata. The builder supplies the
pinned upstream source commit to its MSBuild version target and records that commit
in `build.json`, so builds never infer a PowerShell commit from this application's
enclosing Git checkout.

Notebook children receive Node's standard `--preserve-symlinks` and
`--preserve-symlinks-main` options. This extends the REPL's existing entry-point
handling to npm and descendant Node processes: module loading must not enumerate
ungranted ancestors. Module identity follows the supplied path (including any
symlink), as documented for these Node options. Arbitrary host `NODE_OPTIONS` is
not inherited. npm uses `cache/notebook/npm` in the existing disposable workload
cache. Global npm tools use `.notebook-tools/npm` inside the existing writable
Notebook workspace and are added to child PATH after the bundled Node directory.
These tools survive process shutdown and disposable cache cleanup; existing host
global packages are not copied or migrated. The host user's npm cache and bundled
runtime remain outside the package install destination.

Only Windows Notebook child processes use this bundled Node. Electron and the
development toolchain are independent. Moving a Notebook workspace from Node 22
to Node 24 preserves its tool directory, but packages with native addons may need
reinstallation or rebuilding for Node 24. No automatic migration of those packages
or historical Notebook data is performed.

Run the real AppContainer regression on a machine with the installed product's
owned sandbox profile (normal unit tests do not provision machine resources):

```powershell
$env:RUN_WINDOWS_NOTEBOOK_RUNTIME = '1'
npx vitest run packages/notebook-network-sandbox/src/windows-notebook-runtime.integration.test.ts
```

New Shell bindings record PowerShell `7.6`. Historical `5.1` bindings remain
readable and retain their original interpreter identity. There is no database
migration or new execution state. Re-running a historical cell uses the selected
Session runtime, as before. A source build is not a vendor-signed runtime; Windows
release packaging must include these artifacts in its normal signing process.
