# Package workflows

`npm run build:packages` uses the TypeScript project references in `tsconfig.packages.json`.
Development, test preparation, typechecks and application packaging use this graph. Unchanged
outputs are reused; missing outputs invalidate their compiler metadata, and deleted sources lose
stale emitted files before downstream compilation. `-- --clean` removes selected output directories
and metadata first. Release and backend staging command chains request one clean package build.

`build:*:compiled` and `typecheck:*:compiled` are internal composition steps: their caller must
successfully prepare packages first. Public `build:web`, `build:backend` and process typecheck
commands prepare their own dependencies. Package-local build/prepack scripts remain standalone.
Native credential helpers, runtime staging/signing, CLI distribution and Notebook sandbox checks
retain their dedicated paths. TypeScript compilation does not certify those resources.

## Independent verification

```sh
npm run check:packages -- --explain
npm run check:packages -- --packages=pdf-translation --explain
npm run check:packages -- --packages=pdf-translation
npm run check:packages -- --ci
```

Explicit package names select exactly those consumers, plus prerequisite builds. CI obtains changed
packages and downstream consumers from the trusted `select-package-tests` action. Its package graph
is `scripts/ci/package-test-boundaries.json`; tests check that its edges match compiler references
and package manifests. Missing/partial selection retains all checks. A new package absent from the
trusted exclusion list cannot silently disappear from verification.

The dispatcher reuses the Connector, Diagnostics, Environment, Compute, Notebook, Skills and
PDF/Literature verifiers.
Prerequisites need compilation; only selected packages need their own unit suites. Installed
consumers retain public declarations, private-import rejection, browser entries, CJS/ESM identity
where supported, actual execution and resource checks. PDF worker assets, Notebook grammars and
Skills locking/lifecycle checks are not replaced with import smoke tests. PDF Structure caps workers
by available CPUs, as the host does, so dense-vector stress tests retain their original timeout. Consumer environments
remove host resolution hooks and CI test exclusions.

Online installation is the default. `--offline` requires a populated npm cache; a missing cached
archive is an environment failure, not evidence that a package contract is broken. Timings and
exit codes are written to `test-results/package-verification.json` and uploaded by CI. The manually
triggered **Package test policy dry-run** executes the same dispatcher on Ubuntu/Node 24; `packages=all`
selects every registered package explicitly. This is the first place to debug this lane.
