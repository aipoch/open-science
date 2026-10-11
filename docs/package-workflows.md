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

The dispatcher reuses the Connector, Diagnostics, Notebook, Skills and PDF/Literature verifiers.
Prerequisites need compilation; only selected packages need their own unit suites. Installed
consumers retain public declarations, private-import rejection, browser entries, CJS/ESM identity
where supported, actual execution and resource checks. PDF worker assets, Notebook grammars and
Skills locking/lifecycle checks are not replaced with import smoke tests. Consumer environments
remove host resolution hooks and CI test exclusions.

Online installation is the default. `--offline` requires a populated npm cache; a missing cached
archive is an environment failure, not evidence that a package contract is broken. Timings and
exit codes are written to `test-results/package-verification.json` and uploaded by CI. The manually
triggered **Package test policy dry-run** executes the same dispatcher on Ubuntu/Node 24; empty
`packages` means all registered packages. This is the first place to debug this lane.

## Business boundary review

| Boundary                           | Decision                                                                 | Reason and remaining burden                                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PDF host options                   | Accept only usage, runners, target capture and the host checkpoint store | The host already overrides diagnostics, write admission, source identity and provider policy. Accepting those options advertised configuration that had no effect.                                                                                                                                                               |
| PDF source/checkpoint conversion   | Retain                                                                   | Host source identities and checkpoint persistence differ from package contracts. Removing conversion would change IPC/storage semantics. Caller leases, cancellation and write admission remain owned by the existing workflow.                                                                                                  |
| Skills authoring                   | Retain one mutation owner across approval, mutation and refresh          | Splitting these steps into independent callbacks permits stale approvals and competing writers. The host owns approval/UI refresh; the package owns file mutation.                                                                                                                                                               |
| Skills/Specialist transaction port | Retain prepare, commit, rollback, recovery and lock scope                | Two persisted domains must settle consistently after failure. The protocol has substantial interface cost, but hiding the methods without moving the invariant owner would only hide that cost. The optional lifecycle methods remain a candidate for a separately designed capability contract, not an incidental cleanup here. |
| Journal catalog                    | Separate change                                                          | The dedicated journal work removes SQL from the package and keeps domain store operations at its boundary. This tooling change does not implement or certify that transaction redesign.                                                                                                                                          |

See `src/main/skills/host-skills-service.ts`, `packages/skills/src/specialist-package-adapter.ts`,
`src/main/specialist/package/transaction.ts` and their contract tests for the actual transaction
ordering. Package count does not demonstrate reduced coupling: cross-domain invariants still need
an owner and recovery evidence.

## Measuring actual changes

Use real commits and declared module/interface ownership from both revisions:

```sh
node scripts/package-change-evidence.mjs \
  --base=BASE_SHA --head=HEAD_SHA --output=test-results/change-evidence.json
```

Optional `--builds=file.json` attaches recorded build observations; record command, toolchain,
cache condition, elapsed milliseconds, exit code and machine. Optional `--ci=file.json` accepts a
GitHub Actions run response with its attempt-specific jobs response's `jobs` array attached. Fetch all job pages for
large runs. It separates queue time, execution elapsed time and summed job duration, retaining
attempt, outcome and per-step timings. Mixed-attempt aggregates and rerun queue time remain unavailable. Store evidence under ignored `test-results/` or local
`docs/internal/`; use CI artifacts/PR summaries for review.

Reports classify host-only, package-implementation, public-contract candidates and mixed/uncertain changes. Registered interfaces include test helpers;
review the actual diff before calling a candidate a public-contract change.
They count changed owner modules, not selected consumer modules. Unregistered paths keep the
classification uncertain. Missing timing or integration-failure evidence is `null`, never zero.
Review failed test logs to distinguish integration defects, environment failures and unresolved
failures; a failed job alone cannot establish the cause.

Initial real-change examples are host shutdown #3429, WSL path handling inside the Notebook sandbox
package #3254, and literature candidate identity contract #3422. They cover different scopes and
runners and are not a controlled before/after experiment. Build timings must be measured on matched
machines/dependencies; synthetic fixture edits prove scheduling correctness, not developer savings.
Continue collecting all three change categories before attributing productivity or CI savings to
package extraction. This shared-build/CI change itself is mixed infrastructure work.

No application data migration, product state/enum change or business persistence change is included.
Only disposable compiler metadata and technical measurement reports are written by the new tooling.
