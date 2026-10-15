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

Explicit package names select exactly those consumers, plus prerequisite builds. Ordinary PR updates
run bounded affected package unit tests and host integration tests on separate Ubuntu runners.
PR Gate uses four host shards and two package shards; `packages/` test files run only in the package
group, while host, CLI and repository-policy tests run in the host group. Both groups retain the
trusted package/module selection and feed one blocking coverage aggregate. Pure host changes omit
package runners entirely; package fixture readers and shared runtime/build inputs still select
package checks. Full portable plans defer to scheduled/manual Source Regression on both PRs and
merge queue. Its complete acceptance runs the same separate host/package groups without exclusions.
Selected test failures, timeouts and cancellations block the gate. A selective runner whose plan
unexpectedly expands to full fails with `--require-selective`; it never silently restarts full.
Full-suite failures can first appear after merge. CI policy changes still use the trusted base policy.

Installed tarball verification runs in
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
PDF/Literature, Reproducibility, Resilient Download and Durable Files verifiers.
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

Literature, Journal Catalog, PDF Structure and PDF Translation own their tests, fixtures and Vitest
configuration inside each package. The root runner loads those configurations as independent projects;
it does not apply host aliases, dotenv, i18n or DOM setup to them. Each package suite is discovered
once, and pure host selection does not load those projects. Run `npm --prefix packages/<name> test`
for a package's own suite (after installing its declared dependencies); use `check:packages` for the
additional repository-external source build/test and installed-tarball consumer checks. The shared
verifier only orchestrates these checks and supplies sibling tarballs, never host source or test setup.

Host tests own adapters, lifecycle, persistence and UI integration against public package contracts.
Changing host integration does not change an upstream package and therefore does not select its unit
suite. Package changes select their own suite and affected downstream consumers. Shared dependency,
compiler or test-policy changes still require broader verification. Explicit root `npm test` remains
the full acceptance command; use affected selection for ordinary host changes.

PRs run changed package suites and bounded host adapter/contracts; downstream suites and more distant
host consumers remain blocking in merge queue. `test:affected -- --tier pr` explains/exercises the PR
selection; the default remains the complete affected queue selection. Full portable Ubuntu regression
runs in Source Regression, with a focused manual `portable` mode. Run
`node scripts/ci/audit-package-consumers.mjs HEAD` for per-package host dependency evidence.

### Literature integration boundary

Domain operations belong to their package: citation style management includes formatter refresh;
PDF layout recording includes cache publication; the optional PDF SQLite adapter owns checkpoint
JSON projections and incremental commit semantics. Host adapters supply source authority, transaction
connections, historical identity conversion, platform resource remapping and diagnostics. They do not
coordinate these domain steps or reproduce package storage layouts.

The Literature renderer's `public/host` entry defines its own structural navigation, settings,
project and PDF-preview ports. It does not derive them from host stores or hooks. Project creation is
an injected action/state/rendered-dialog capability; PDF loading is injected for both local and
managed sources. The host adapter connects those ports to application stores, Workspace previews and
project forms. Architecture checks reject static, type-only and dynamic implementation imports in the
feature. Shared transport DTOs and UI components are still repository dependencies: this renderer is
an extraction-ready feature boundary, not yet a separately distributed renderer npm package or plugin
loader.

## Static impact diagnostic tool

The private [test-impact package](../packages/test-impact/README.md) analyzes Git revisions without
changing test selection. Run `npm run analyze:test-impact -- --revision HEAD` to generate evidence,
and `npm run check:packages -- --packages=test-impact` to verify its build and installed API/CLI.
Source Regression's manual `static-impact` mode runs the verifier on Linux, Windows and macOS.
