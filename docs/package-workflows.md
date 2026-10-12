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

## Package versions

Repository-local packages have versions independent of the application release. The private
`@aipoch/compute`, `@aipoch/skills` and `@aipoch/specialists` packages stay at `0.1.0`; do not bump
them when releasing the app. The root manifest uses `file:packages/...` dependencies, and release
builds compile and stage the current checkout. These package versions do not identify stored data,
Skill content or Specialist archives.

Keep package manifests, their package-local lockfiles (when present), and the corresponding
`packages/<name>` entries in the root lockfile consistent. Application releases update the root
`package.json` and its lockfile version metadata. Standalone CLI/runtime release manifests derive
the application version during staging; their generated release versions still match the app.

If a local package is published independently in the future, give it its own release/versioning
policy before publishing changed contents under the same package name and version. See the
[npm package metadata guidance](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#version).

## Independent verification

```sh
npm run check:packages -- --explain
npm run check:packages -- --packages=pdf-translation --explain
npm run check:packages -- --packages=pdf-translation
npm run check:packages -- --ci
```

Explicit package names select exactly those consumers, plus prerequisite builds. Ordinary PR updates
run affected package unit tests and host integration tests; installed tarball verification runs in
**merge queue** as a separate blocking job. Static checks no longer install or execute package tarballs;
CLI/SDK, Node 22 compatibility and published-runtime checks have their own job with unchanged selection.

Queue verification selects changed packages and transitive downstream consumers from the trusted
`select-package-tests` action using its `verification` input. Its graph is
`scripts/ci/package-test-boundaries.json`; tests check edges against compiler references and manifests.
An empty selection skips dependency installation and verification. Upstream packages required to build
selected consumers are built without selecting their own tests.

Installed-consumer selection ignores host source, documentation, E2E, unrelated workflow changes and
known host CI routing inputs. Changes to a package's verifier select its consumer family and downstream
packages. Root dependencies/lockfile, Node/TypeScript/Vitest configuration, package policy, shared
installation/build helpers and unknown inputs retain broad verification: they can affect packages even
without changes under `packages/`. This does not narrow the portable unit-test selector's global rules.
Missing or partial trusted evidence retains full verification. Older trusted policy may still select
more packages during rollout; a new package absent from trusted evidence cannot silently disappear.

**Source Regression** verifies all installed packages on Ubuntu/Node 24 at its existing twice-daily
schedule and in manual `full` mode. Its failure participates in the existing scheduled tracking issue.
The **Package test policy dry-run** is manual-only; policy and actual Vitest discovery regression tests
also run through the ordinary test suites. Queue, scheduled and manual installation checks reuse
`.github/actions/verify-packages` and the production dispatcher.

PR Gate treats package sources, package metadata, package compilation inputs and the package-test
policy as global package inputs. Unrelated `scripts/**` changes and root regression fixture data
are excluded from unchanged package units; fixture changes still select their declared reader
suites through module-impact fixture routing. Unknown paths and incomplete trusted evidence keep
the complete package baseline.

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

## Package and host test layers

PRs run changed package suites and bounded host adapter/contracts; downstream suites and more distant
host consumers remain blocking in merge queue. `test:affected -- --tier pr` explains/exercises the PR
selection; the default remains the complete affected queue selection. Full portable Ubuntu regression
runs in Source Regression, with a focused manual `portable` mode. Run
`node scripts/ci/audit-package-consumers.mjs HEAD` for per-package host dependency evidence.
