# Testing and module registration

Use this guide to choose local checks and register source/test changes. Start with
the [contribution workflow](../CONTRIBUTING.md#development-workflow) for branch and PR requirements.

## Verification Policy

### Stable test-command semantics

- `npm test` always runs the complete portable Vitest suite. Its meaning does not depend on the current
  branch or changed files.
- `npm test -- <paths> [-t '<pattern>']` runs only the explicit target supplied by the caller. It does
  not discover affected tests and must not be described as full verification.
- Impact selection is a separate decision based on the final diff. Do not overload `npm test` with
  implicit Git-diff behavior.

### Inner loop

During implementation, run the smallest project-owned test that exercises the behavior being changed.
Rerun it whenever that behavior changes. Inner-loop results from an earlier implementation state are
not final evidence.

### Final local Test Impact Set

Before handoff, derive the minimum set from the final material diff:

1. tests for the behavior owned by the changed Module;
2. contract tests for changed Interfaces and Adapters;
3. consumer or feature-slice tests when an Interface may have changed;
4. typechecks for every affected runtime process;
5. `npm run lint` when source or linted configuration changed;
6. platform, persistence, migration, build, or E2E checks for risks that can be exercised locally.

Directory proximity alone is not impact evidence. If a file mixes responsibilities, treat it as
Interface-affecting or use the full fallback.

`test:module` supports the Module IDs given by filenames in `scripts/ci/module-impact/`. It runs that
Module's curated owner, contract, and representative consumer tests; it is not complete downstream
verification for an Interface change. Use `test:affected` or the exact-head PR Gate plan when an
Interface or its consumers may have changed.

Large `test:module` and `test:affected` selections use a temporary argument file to avoid operating
system command-line limits, including Windows npm's shell limit. The internal
`test:module:arguments` script runs the same `pretest` preparation and restores the complete argument
list before starting the installed Vitest CLI. Filters, exclusions, coverage and shard options keep
their normal meaning; the selection is neither truncated nor expanded to the full suite. The parent
removes the temporary file after the command exits, including test or spawn failures. Forced parent
termination can leave a file in the OS temporary directory; it contains test arguments only.

### Dependency boundaries and explainable convergence

`test:affected` refines a declared selection against immutable merge-base, head and actual checkout
sources. Documentation and validated additive registrations retain their own evidence without
turning an otherwise homogeneous source change into a mixed boundary. Policy changes, deletions,
unknown ownership, dirty checkouts and unavailable evidence keep the conservative selection.

Both PR and queue tiers may exclude a host test reached only through module expansion when a
complete dependency traversal proves it cannot reach the actual changed files in **all three**
snapshots. Selecting a consumer module never makes its other sources new change seeds: two owners
wired into one composition do not automatically affect each other's independent tests. Changed
owners' direct declarations, contracts, changed tests, graph evidence and new registration evidence
are protected. Runtime-only traversal excludes erased type imports; typechecks and structural
architecture checks still cover those relationships. Mixed imports, schemas, side effects, mocks
and registered dynamic contracts remain runtime dependencies.

PR additionally keeps the existing direct-consumer/one-adapter boundary and defers farther consumers
to blocking merge queue. That distance rule is **not** proof of independence. Queue retains real
multi-hop consumers. Opaque IPC, event, filesystem, native or unresolved imports cannot establish
independence and retain tests. `test:affected:explain -- --base <base> --head <head> --tier pr` shows
exclusions, retained boundary reasons, deferrals, capabilities and fallback reasons.

`node scripts/ci/module-relationships.mjs <revision>` exports all registered modules with file-role
layers, public interfaces, test counts, unresolved runtime files and file evidence for each edge.
Runtime imports, type imports and explicit dynamic contracts point **consumer → dependency**;
`test-routing` points **changed owner → consumer evidence**. These graphs must not be conflated.
Layers describe file roles; a mixed legacy module can occupy several roles. The architecture guard
prevents foundation dependencies, shared-to-host/presentation imports, owner-to-composition imports
and private imports across the PDF/isolated-helper public boundaries. It does not claim complete
encapsulation of every existing domain.

Static diagnostics and selection use different engines: `npm run analyze:test-impact --
--revision HEAD` uses the private package's external dependency engine, while generated consumers
use the repository's TypeScript-based reader. Neither missing static edges nor a bounded runtime
coverage sample proves independence. Dynamic evidence only covers the tests and inputs actually
executed; IPC, events and filesystem relationships still need explicit contracts.

The derived-consumer reader also follows literal relative and renderer-alias imports of SVG, PNG,
JPEG, GIF, WebP, AVIF, ICO and CSS files, including `?raw`, `?url`, `?inline`, `?no-inline` and
fragment suffixes. These edges add consumers but remain incomplete for retirement/pruning:
resource contents, CSS imports/URLs and arbitrary loader plugins are not analyzed. Computed
imports and unsupported query combinations retain uncertainty. Resource consumers can be registered
explicitly in their owning module; the generated index stores only additional memberships.
Tests that read resource contents through filesystem APIs such as `readFileSync` need explicit
`testFiles.consumer` entries; import analysis does not discover those relationships.

### Full fallback

Run `npm run typecheck`, `npm run lint`, and `npm test` when any of these apply:

- the Owner Module, changed Interface, or consumers cannot be established;
- global validation inputs change, including package metadata, TypeScript/Vitest/build configuration,
  the PR Gate workflow or classifier, or ownership, consumer, capability, or fallback routing in the
  module-impact manifest, except validated additive evidence for existing modules as described below;
- the change crosses several runtime areas without a demonstrated impact map;
- a release-candidate workflow or maintainer explicitly requests the complete local suite.

Full fallback is a safety mechanism, not an unconditional prerequisite for every pull request.
Contributors are not expected to reproduce every operating-system CI lane locally.

Additive `testFiles`, interface evidence and ownership of newly added files within an existing
Module can use selective CI after trusted validation. Existing ownership, consumer edges, capability
routing and full-validation markers must remain intact. New modules, reassignment of existing files,
the root manifest and executable CI policy still require full validation. Run the
manifest validation tests, `npm run test:module -- <module-id>`, the affected process typechecks and
lint instead; exact-head CI remains authoritative for the complete portable and platform suites.

### CI authority and evidence

PR Gate classifies the final base-to-head diff from trusted inputs, adds consumer and platform-risk
lanes, and fails closed to the full plan for unknown or ambiguous ownership. Selected checks are
blocking; unselected checks are reported as skipped rather than treated as proof.

The final handoff must list the material changes, map each affected behavior to its project-owned check
and final result (`behavior -> command -> result`), explain why consumers or platform lanes were
included or excluded, and identify uncovered risks. State that the checks ran after the last material
edit. Only mark the change verified after an independent review confirms that this mapping covers the
final state.

## Reuse E2E preparation, preserve scenario assertions

Use `createProjectViaUi` from `e2e/fixtures/project.ts` when an English-language E2E needs
a project as setup. It clicks the Home header entry and submits the real form; the spec keeps
its own readiness checks and behavior assertions. Certification helpers compose this operation
while retaining their project-ID discovery. Tests that inspect the form, fill additional fields,
or activate it with the keyboard can use `homeNewProjectButton` without hiding those steps.

Keep explicit accessible-name assertions in tests for copy, translations and accessibility.
Scope ambiguous actions to their owning region rather than selecting the first match. Do not
replace UI journeys with API seeding merely to remove repetition, or delete scenarios because
they share preparation. Prefer small helpers for repeated operations over a generic page hierarchy.

Other shared preparations live in `e2e/fixtures/`: `settings-preferences.ts` owns Settings section
navigation, theme and language selection; `library.ts` opens Library's All references view;
`conversation.ts` submits a prompt without waiting for a reply; and `viewport.ts` waits for a
requested viewport width to take effect. Keep keyboard submission, conditional navigation,
reply/failure waits and scenario-specific assertions in the caller. The explicitly named
`activatePermissionDecisionViaDom` preserves an existing Windows overlay workaround for permission
state tests; it must not replace real pointer activation in hit-testing or accessibility journeys.

## Fast impact-registration gate

After dependencies are installed, run this fixed registration suite from the repository root:

```bash
npx vitest run --config scripts/ci/vitest.registration.config.ts
```

It checks module schema and path references, exact source/test ownership, test consumer evidence
(including declared runtime-loading edges), package dependency registration, classifier invariants
and platform/core-check selection. This includes the Windows source-signal check that otherwise
could be missed by selective test execution. The explicit inventory is independent of
`change-impact.json` and module registration data; it does not run application behavior tests.

PR Gate runs it in the independent **Impact registration** job on every PR and merge group,
including documentation-only and full-fallback plans. The job installs the locked parsing/test
toolchain with lifecycle scripts disabled, as CI Integrity does; this is not an application
installation. The dedicated Vitest config needs no app setup, Prisma generation, package build,
Electron or browser launch. The final PR Gate requires success even if affected tests would not
select these suites. Failure, cancellation, skipping or a missing result blocks admission.

The gate catches violations of the existing registration rules. It cannot infer arbitrary IPC,
events or filesystem relationships; those still require the explicit contracts described below.
Behavior tests and trusted-base Integrity preservation checks remain separate requirements.

The workflow, fixed inventory and assertions execute from the candidate checkout. They are
protected CI policy under `/scripts/ci/` and `/.github/workflows/`, requiring CI-owner approval;
new commits dismiss stale approvals under the main-branch ruleset. Independence here means that
registration data cannot select or skip its own checks. Changes to the checking policy itself use
the existing [CI control-plane approval](ci.md#ci-control-plane-approval) process, while trusted-base
Integrity continues to validate registration data and preservation rules.

## Module-impact registration

Module registration is part of the same change as the source and tests, not a follow-up after CI
fails. Edit `scripts/ci/module-impact/<module-id>.json`; the filename defines the module ID
(`^[a-z][a-z0-9_]*$`). The root `scripts/ci/module-impact.json` contains only `{"schemaVersion": 1}`;
do not add a shared index or inline modules. Reuse the existing owner module when appropriate.

Before committing:

- Register every new or renamed file under `src/` or `packages/` in exactly one module's
  `ownerPaths`, including tests, native sources, assets and fixtures. Use exact repository-relative
  paths with `/` separators. A `testFiles` entry does not assign file ownership.
- Register new tests in the appropriate `testFiles` category: `owner` for the module's behavior,
  `contract` for its interfaces, or `consumer` for downstream behavior depending on it. Within one
  module, list a test in only one category; the same test may provide evidence for multiple modules.
- After changing tests, imports, mocks or runtime-loading declarations, run
  `npm run generate:module-consumers`, then `npm run check:module-consumers`.
  The generated index records additional reachable tests without repeated manual registrations.
  Preserve explicit consumer contracts, including IPC, event and filesystem relationships;
  static reachability alone does not prove behavioral coverage or justify removing a contract.
- Keep public boundaries in `interfacePaths`, including test files that export helpers used by other
  tests. Keep `consumerModules` accurate for module-to-module relationships; it does not replace
  explicit test evidence. Native/worker loading edges use `scripts/ci/module-runtime-consumers.json`.
  IPC, events, filesystem protocols and other dynamic relationships still need explicit contract
  tests; static analysis cannot prove them all.
- On renames, update ownership, interface and test references to the new paths. Remove references
  only for files actually deleted; preserve coverage for surviving files. Do not weaken existing
  consumer edges, capability/fallback routing or `fullTestReason` to make registration checks pass.

**Stage intended new files before running these checks.** Review `git status --short`, then use
`git add -- <paths>` for the source, tests, assets and module records in this change. The ownership
audit and consumer-coverage guard enumerate `git ls-files`: they can miss untracked new files even
when a targeted test passes. They read working-tree contents for tracked paths, so rerun them after
the last material edit and review `git diff --cached` before committing.

Run from the repository root:

```bash
node scripts/ci/audit-module-ownership.mjs
npx vitest run scripts/ci/validate-module-impact.test.ts scripts/ci/check-module-ownership.test.ts scripts/ci/module-consumer-coverage.test.ts
```

These checks validate registration, not the changed product behavior. Also run
`npm run test:module -- <module-id>` for the affected modules and the other checks required by the
[Verification Policy](#verification-policy). After committing, inspect
`npm run test:affected:explain -- --base origin/main --head HEAD`; this compares committed revisions
and does not include staged or unstaged edits. Unknown ownership and directly changed full-validation
owners retain the full fallback; registration does not waive required CI. Exact registered runtime-resource
and package owners use their module evidence and platform overlays, regardless of directory.

Regression data under `test/fixtures/` does not need per-file module ownership or runtime-consumer
edges. `testFixtureSuites` in `scripts/ci/change-impact.json` maps bounded data paths to test-suite
patterns; adding a PDF JSON/JSONL case within the existing directory needs no manifest edit. Fixture
changes run those tests directly, without expanding production consumers. Mixed source changes keep
their normal module coverage. Unknown fixture directories and executable helpers retain conservative
routing until their test scope is established. Existing fixture ownership entries from older commits
are retained for the trusted Integrity preservation check; fixture selection no longer relies on them.

See [CI control-plane approval](ci.md#ci-control-plane-approval) for additive registration exemptions,
coverage-preservation rules and changes that require CI owner approval.
