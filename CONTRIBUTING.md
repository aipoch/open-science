# Contributing to Open-Science

Thanks for your interest in contributing! This document explains how to set up
the project, the workflow we follow, and the checks your change must pass before
it can be merged.

## Code of Conduct

Be respectful and constructive in all interactions. Assume good intent, keep
discussions focused on the technical merits, and help make this a welcoming
project for everyone.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 22 (see [`.nvmrc`](.nvmrc)) and npm
- Git

### Setup

```bash
# Fork the repo at https://github.com/aipoch/open-science/fork, then:
git clone https://github.com/<your-username>/open-science.git
cd open-science

# Add the original repo as upstream (to stay in sync)
git remote add upstream https://github.com/aipoch/open-science.git

npm install
```

`npm install` runs a `postinstall` step that generates the Prisma client and
installs native Electron app dependencies.

An existing `node_modules` directory can retain an older patch even when the
dependency version has not changed. Before applying patches, `npm install`
automatically restores known historical `@shadcn/react@0.3.0` scroller files to
their original content so the current patch can apply. Recovery is limited to
the exact version and checksums of previously committed patches; it does not
overwrite unknown manual edits or download dependencies from a lifecycle script.

If installation still reports a `patch-package` failure, review any manual edits
inside `node_modules`, then run `npm ci` from the repository root. It recreates
`node_modules` from `package-lock.json` and applies the current patches without
updating the lockfile. Any manual edits inside `node_modules` will be removed.

Patch failures stop installation before Prisma generation and native dependency
setup. Do not bypass them with `--ignore-scripts` or regenerate a patch from a
partially patched installation. See the upstream
[patch-package guidance](https://github.com/ds300/patch-package#applying-patches).

### Run in development

```bash
npm run dev
```

On Windows x64, opt into the unpackaged WSL2 Bash development flow from PowerShell with:

```powershell
$env:OPEN_SCIENCE_DEV_WSL2_BASH_PREVIEW = '1'
npm run dev
```

The switch is off by default and applies only to the development server. Packaged builds ignore it
and continue to require the certified, version-matched WSL2 assets.

## Coding-agent navigation

Run installation, development, and validation commands from the repository root:

| Intent         | Root command                                               |
| -------------- | ---------------------------------------------------------- |
| Install        | `npm install`                                              |
| Run            | `npm run dev`                                              |
| Target test    | `npm test -- <affected-test-path> [-t '<test pattern>']`   |
| Module tests   | `npm run test:module -- <module-id>`                       |
| Affected tests | `npm run test:affected -- --base <base> --head <head>`     |
| Node typecheck | `npm run typecheck:node`                                   |
| Web typecheck  | `npm run typecheck:web`                                    |
| Lint           | `npm run lint`                                             |
| Full fallback  | `npm run typecheck`, `npm run lint`, then `npm test`       |
| UI E2E         | `npm run build:e2e`, then `npm run test:e2e`               |
| UI journeys    | `npm run build:e2e`, then `npm run test:e2e:journey`       |
| Workspace      | `npm run build:e2e`, then `npm run test:e2e:workspace`     |
| A11y           | `npm run build:e2e`, then `npm run test:e2e:accessibility` |
| Visual         | `npm run build:e2e`, then `npm run test:e2e:visual`        |

Create Git worktrees only under the repository's `.worktree/<name>` directory, with each change
branch based on the default branch. Do not remove or move another worktree.

Get explicit approval before destructive Git or filesystem operations, dependency installation that
downloads or executes new code, publishing packages or releases, handling credentials outside the
project's existing flows, or external writes (such as pushes, pull requests, issues, and messages) that
the task did not already request.

Read the existing owner document before changing one of these areas, then run its focused checks:

| Area     | Owner document                                                                          | Focused checks                                                                                        |
| -------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Renderer | [Design specification](docs/design.md)                                                  | `npm run typecheck:web`; targeted tests under `src/renderer/`                                         |
| Notebook | [Current architecture](docs/PRD.md#8-current-architecture-what-is-actually-implemented) | `npm run typecheck:node`; targeted tests under `src/main/notebook/`                                   |
| Settings | [Settings design](docs/design.md#settings)                                              | `npm run typecheck`; targeted tests under `src/main/settings/` and `src/renderer/src/pages/settings/` |
| ACP      | [Current architecture](docs/PRD.md#8-current-architecture-what-is-actually-implemented) | `npm run typecheck:node`; targeted tests under `src/main/acp/`                                        |

## Project Structure

This is an Electron application built with electron-vite, React, and TypeScript.
Three runtime process layers and a shared module live under `src/`:

- `src/main/` — Electron main process (ACP runtime, session persistence,
  artifacts, notebook, projects, IPC handlers).
- `src/preload/` — preload bridge exposing a typed `window.api` to the renderer.
- `src/renderer/` — React UI (pages, stores, components).
- `src/shared/` — types and helpers shared across processes.

## Development Workflow

1. Create a branch off the default branch for your change.
2. Make your change, keeping it focused and self-contained.
3. Add or update tests that cover the behavior you changed.
4. Build the final Test Impact Set and run it after the last material edit. Use the full fallback when
   ownership, consumers, or risks cannot be established.
5. Open a pull request with a clear description of the change and its motivation.

### Durable external components

Before adding a resource that survives its creating process outside app-managed storage or in a
third-party control plane, follow the
[durable external component ownership contract](docs/PRD.md#durable-external-component-ownership).
The same contract applies when adding a new create, adopt, or remove path to an existing component.
The pull request must identify:

- the module that owns the component and the exact identity or receipt recorded at creation;
- create/start, stop, removal, crash-recovery, and application-uninstall behavior;
- how cleanup fails closed without scanning system directories or touching shared, user-managed, or
  otherwise unproven resources;
- the platform-specific tests for stop-before-remove ordering, retry, idempotency, and preservation
  of unowned resources; and
- any persisted-format, historical-compatibility, or new-state impact.

A future cleanup hook is not sufficient: do not ship creation until the owner can stop and remove
the component safely. If the PR changes a known legacy exception listed in the contract, it must
either migrate that path to proven ownership or document the bounded exception and its historical
compatibility plan; do not use an exception as precedent for new behavior.

### Database schema changes

`prisma/schema.prisma` owns tables, columns, defaults, indexes, and foreign keys. SQLite CHECK
constraints that Prisma cannot express live in `prisma/sqlite-check-constraints.json`. The runtime
schema module is generated; do not edit it or add feature DDL to startup code.

1. Change the Prisma schema and, only when required, the SQLite CHECK contract.
2. Run `npm run db:schema:generate` and review the generated target schema.
3. Add a new immutable entry under `src/main/database/migrations/`; never change a released
   migration or extend the frozen `0001` legacy repair list.
4. Run `npm run db:schema:check` and the migration tests before committing.

Prisma CLI is a development and CI tool only. Packaged applications execute the checked-in
migration manifest and do not ship the Prisma migrate engine.

Migration history is owned by `src/main/database/`. Module tests may run
`migrateApplicationDatabase` to create a current-schema fixture, but handcrafted historical schemas,
upgrade assertions, and migration-ledger expectations belong in the database migration tests rather
than in feature-module suites.

### Branch names

Use the format `<type>/<short-description>`, with a lowercase, hyphen-separated
description:

```text
feat/project-sidebar-filter
fix/notebook-kernel-timeout
ci/ai-pr-review
```

Use one of these standard type prefixes:

- `feat` — a new feature
- `fix` — a bug fix
- `docs` — documentation-only changes
- `style` — formatting or other changes that do not affect behavior
- `refactor` — code changes that neither fix a bug nor add a feature
- `perf` — performance improvements
- `test` — adding or correcting tests
- `build` — build system or dependency changes
- `ci` — CI configuration or script changes
- `chore` — maintenance work not covered by another type
- `revert` — reverting a previous change

### Coding style

- Match the style of the surrounding code — naming, structure, and idioms.
- Formatting is handled by Prettier. `npm run format` is optional; review its
  changes before committing because it rewrites files across the repository.
- Linting is enforced by ESLint; run `npm run lint`.
- Wrap user-facing strings with the `t()` translation function from `react-i18next`. Add corresponding translations to the `renderer` namespace in `src/shared/i18n/locales/de.json` (German), `src/shared/i18n/locales/es.json` (Spanish), `src/shared/i18n/locales/fr.json` (French), `src/shared/i18n/locales/ja.json` (Japanese), `src/shared/i18n/locales/ko.json` (Korean), `src/shared/i18n/locales/ru.json` (Russian), `src/shared/i18n/locales/zh-Hans.json` (Simplified Chinese), and `src/shared/i18n/locales/zh-Hant.json` (Traditional Chinese). Use the English text as the translation key. Keep code comments and documentation in English.

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

### Full fallback

Run `npm run typecheck`, `npm run lint`, and `npm test` when any of these apply:

- the Owner Module, changed Interface, or consumers cannot be established;
- global validation inputs change, including package metadata, TypeScript/Vitest/build configuration,
  the PR Gate workflow or classifier, or ownership, consumer, capability, or fallback routing in the
  module-impact manifest;
- the change crosses several runtime areas without a demonstrated impact map;
- a release-candidate workflow or maintainer explicitly requests the complete local suite.

Full fallback is a safety mechanism, not an unconditional prerequisite for every pull request.
Contributors are not expected to reproduce every operating-system CI lane locally.

Changing only `testFiles` within an already-owned Module does not trigger the full fallback. Run the
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

## Commit Messages

Every commit subject must follow Conventional Commits with a scope:

```text
<type>(<scope>): <description>
```

This format is checked for every commit in a pull request.

Use the same standard type prefixes listed under [Branch names](#branch-names).
The scope should be a short, hyphen-separated name for the affected area that
starts with a lowercase letter; uppercase is allowed inside for proper nouns
and technical terms (for example `macOS`).

```text
feat(projects): add sidebar filter
fix(notebook): prevent kernel startup timeout
ci(review): unify automated AI reviews
```

- Write a clear, imperative-mood description that starts with a lowercase
  letter; uppercase is allowed inside for proper nouns and technical terms (for
  example `detect user-installed CRAN R on Windows`).
- Keep the subject concise; use the body to explain the _why_ when it is not
  obvious from the diff.
- Add `!` before the colon and a `BREAKING CHANGE:` footer for breaking changes,
  for example `feat(api)!: remove legacy session endpoint`.

## Pull Requests

- Use the same `<type>(<scope>): <description>` format for the pull request
  title, for example `feat(projects): add sidebar filter`.
- Reference any related issue in the description.
- For behavior-changing work, use a concise description so reviewers can assess
  the intent, scope, and validation before reading the diff. Use the following
  structure where it is applicable:

  ```md
  ## Problem

  ## Proposed change

  ## Scope and non-goals

  ## Acceptance criteria and validation

  ## Review focus
  ```

- For architectural changes, data flows, state transitions, or interactions
  across multiple components, consider adding a Mermaid diagram when it makes
  the design easier to understand and review.
- Small documentation, maintenance, and narrowly scoped fixes may use a concise
  summary, but should still state the expected behavior and validation.
- Include the final evidence mapping from [Verification Policy](#verification-policy), state that the listed
  checks ran after the last material edit, and call out uncovered risks.
- Keep PRs reasonably small and scoped so they are easy to review.
- Ensure the final Test Impact Set, or the full fallback when required, passes.
- After required PR checks and review pass, add the pull request to the native merge queue once
  the queue rollout is enabled. The queue validates the combined revision before **squash merge**;
  its squash subject must retain the PR title's Conventional Commit format. Do not update a branch
  merely because `main` advanced; update it for conflicts or a maintainer request.
- PR commits retain policy/CI Integrity, CodeQL (GitHub default setup, not a repository
  workflow), AI review, static checks and portable tests on Ubuntu. Desktop changes run the Windows
  `@pr-mainline` E2E subset on one test runner: project/session/file journeys, native window
  behavior, permissions, draft recovery and media privacy. Keep the tag in the existing test title;
  new cases enter the complete scheduled suites by default. Full Windows business/browser variants
  run in the independent Windows E2E Regression workflow; Windows core checks remain blocking.
  Automatic PR checks do not allocate Mac runners, including for platform-sensitive changes;
  Mac validation happens in merge queue.
  PR and queue business E2E rely on one Playwright retry to absorb single-attempt flakes; the
  merged E2E summary reports retry-passed tests, and scheduled Source Regression keeps
  `--fail-on-flaky-tests`.
- Merge queue keeps concurrency two and validates the combined revision with Linux/portable
  checks and one short Mac job (project creation/relaunch, persisted theme and window presentation).
  Classification diffs the whole merge group against the target branch tip, so a stacked entry is
  planned for every change it carries, not only its own pull request. CI Integrity re-validates the
  pull request title in the queue because it becomes the squash subject.
  Platform-sensitive changes add focused Darwin sandbox, process/delegation, window/second-launch
  and Notebook checks in that same job. Selected native checks must succeed; skipped is not success.
  Queue does not repeat Windows business E2E or complete Mac business/presentation suites. Existing
  selected Windows core checks remain blocking. Full portable fallback still applies to unknown
  owners, destructive changes and global CI inputs.
- The platform policy uses the existing `macosProfile` values (`smoke` or `expanded`). An expanded
  queue plan selects the short core lane plus native checks on one runner. Manual `macos-smoke`,
  `source-regressions` and `e2e` runs retain their explicitly selected suites for early platform
  diagnosis. Classification and gate validation continue to use trusted base code.
- Complete Mac Source Regression runs twice daily on `main`, at **01:37 and 13:37 Singapore time**
  (Asia/Singapore, UTC+8), including when main is unchanged. Each round uses one build and one Mac
  runner for functional/workspace journeys, browser/visual/accessibility and supplemental suites.
  Windows E2E Regression runs daily at **02:17 Singapore time**
  (Asia/Singapore, UTC+8), with the complete functional/workspace/browser suites on three Windows
  test runners and `--fail-on-flaky-tests`. It has its own failure-tracking issue and does not run
  Windows Full Test or Notebook mutation checks. PR Gate manual `windows-e2e-mainline` reuses the
  short PR subset; `windows-e2e` and `e2e` retain complete coverage. The independent regression
  workflow also supports manual full runs. The existing WSL development-preview journey remains
  opt-in with its dedicated build and is not claimed as ordinary PR/scheduled coverage. Nightly packaging, Windows Full Test and Runtime Resource
  Soak retain their daily 23:17, 00:47 and 03:23 Singapore schedules and, like Windows E2E Regression,
  skip a head that the last successful scheduled run already covered (shared `skip-unchanged-scheduled` action); Nightly additionally requires that head to
  be published under the rolling `nightly` tag, and manual runs never count as coverage because
  the runs API cannot report which dispatch mode they selected. Manual runs always execute.
  Formal release certification and post-release Windows Upgrade Smoke retain their existing gates.
  Scheduled failures cannot retroactively block an already merged PR; Mac-only failures may first
  be discovered in queue or scheduled validation, and non-mainline Windows failures may first be
  discovered in Windows E2E Regression. A failing scheduled run opens or refreshes one
  tracking issue labelled `ci-scheduled-failure` and closes it once a later scheduled run passes.
  Nightly publication additionally requires the advisory runtime-certification and regression
  jobs of the source run to have succeeded.

### PR and issue labels

[`.github/labels.json`](.github/labels.json) defines PR type, `size:*`, and issue intake labels.
PR labels refresh on opening, reopening, new commits and title edits; size counts added/deleted
lines excluding lockfiles. File-based area labels are not generated. Other human/bot labels remain
untouched. Labels do not control CI or merges.

New template issues receive `needs-triage` and their category; maintainers remove `needs-triage`
after assessment. Existing issues and PRs are not assigned intake labels in bulk.

Catalog changes on `main` run **Sync Label Catalog**. Check its first successful run before relying
on new template labels. Manual runs on `main` default to a dry-run preview; disable **dry-run** to
apply. Sync creates labels and updates managed colors/descriptions without renaming labels. It also
deletes the 10 retired area labels from the former catalog, removing their assignments from historical
PRs and issues. Size labels and custom labels, including other `area:*` names, are preserved.

## Reporting Issues

When filing a bug report, please include:

- What you expected to happen and what actually happened.
- Steps to reproduce.
- Your operating system and app version.
- Relevant logs or screenshots, if available.

### Reproducibility cases

The [Reproducibility Pilot (#2725)](https://github.com/aipoch/open-science/issues/2725) collects real
Agent-generated Python and R analyses. Submit one through the reproducibility case template — a
first case needs only the original prompt, the generated code, the data source, and the observed
result, and failed runs are welcome. The [contribution guide](docs/reproducibility-cases/README.md)
explains the format, the curation follow-ups, and how reviewed examples are indexed.

## Publishing the npm Package

Maintainers should follow the [npm package release guide](docs/npm-release.md). npm package versions
use `npm-v*` tags and are published through the protected `Publish npm package` workflow.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](./LICENSE), the same license that covers this project.

### Supplemental desktop coverage

Complete Mac regression and Delegation suites run in Source Regression at 01:37 and 13:37
Asia/Singapore, as well as focused manual validation. Automatic PRs use the Windows mainline subset;
queue uses short Mac core plus focused native checks for sensitive changes. Full Mac presentation,
regression and Delegation matrices are not repeated in the queue. Capacity profiling remains in
Source Regression; manual callers without an explicit capacity input retain complete coverage.

### CI control-plane approval

CI workflows, local actions, CI scripts, Dependabot configuration and CODEOWNERS itself have
`@aipoch/ci-maintainers` as owner in `.github/CODEOWNERS`. Maintain membership in GitHub instead
of editing individual usernames in the file. The team must be visible and have explicit repository
write access. The main ruleset requires approval from one owner other than the PR author and
dismisses stale approvals after new commits. Ordinary application files have no CODEOWNERS entry.
The `scripts/ci/module-impact.json` registration file and JSON records directly under
`scripts/ci/module-impact/` are exempt from owner approval; other CI scripts and manifests remain
protected. CI Integrity rejects invalid filenames, nested records, nonregular files and mixed
inline/sharded layouts. New modules and additive ownership/test/consumer
registrations can enter the normal merge queue after required checks pass, without a bypass.

Trusted-base CI Integrity validates candidate registration data in both PRs and merge groups.
It preserves surviving owner/interface/test paths, consumer edges, capability overlays, fallback
routing and existing full-validation markers. References to actually deleted files may be removed.
New explicit ownership cannot hide existing inferred test coverage. Unknown policy metadata and
coverage reductions fail the check; owner approval alone does not waive these invariants. Deliberate
reductions require a separate CI policy change, not a registration-only PR. Registration changes
still select full portable tests; this exception does not enable untrusted selective test routing.
Introducing this exception changes protected policy files and therefore still needs owner approval.
It can then enter the normal queue; no bootstrap bypass is required when its checks pass.

Owner review authorizes control-plane changes; CI Integrity still validates unsafe workflow
execution, mutable action references, expanded target-workflow permissions and spoofed or missing
required checks. It runs for both PR admission and merge-group validation. Passing required checks
and owner approval precede normal merge-queue admission. Never remove the Integrity `merge_group`
trigger while its check is required; the `required-check-triggers` rule rejects a PR Gate or CI
Integrity revision that drops its `merge_group` or pull request trigger.

Keep required code-owner review and stale-approval dismissal enabled while relying on this policy.
CI Integrity checks exact module ownership under `src/` and `packages/`, covering all tracked code,
native sources, runtime helpers, assets and fixtures regardless of file extension.
Register each file in exactly one module's `ownerPaths` in `scripts/ci/module-impact/<module-id>.json`,
including owner, contract and consumer test evidence. Consumer-test membership does not establish
ownership. New unregistered files and ownership regressions block admission; renames must register
their new paths. Candidate manifests are read as data by trusted base code, against the Git merge
base. E2E and CI scripts retain their existing routing and integrity checks.

Registrations use a metadata-only `module-impact.json` containing
`{"schemaVersion": 1}` plus one module object per `module-impact/<module-id>.json` file.
The filename supplies the module ID; no shared index or committed aggregate is required.
Use `loadModuleImpactManifest` from `scripts/ci/load-module-impact.mjs` in tooling and tests
instead of reading the root JSON directly. The assembled manifest and validation rules are the
same for both layouts. Edit the affected module file directly; adding a module requires only a new
`<module-id>.json` file, with a lowercase ID matching `[a-z][a-z0-9_]*`. Keep all existing ownership,
test and consumer evidence when moving registrations. Do not add an inline module list or mix
inline modules and shards. The reader retains old-format Git history support.

The historical inventory is complete. Run `node scripts/ci/audit-module-ownership.mjs` (or `--json`)
to check every tracked file in these roots, including files untouched by a PR. The inventory test
rejects gaps and duplicate owners. The consumer-coverage test checks transitive static imports and
explicit native/worker loading edges in `scripts/ci/module-runtime-consumers.json`. Keep IPC,
event, filesystem and other dynamic consumer contracts explicit in module test evidence; static
analysis alone cannot prove those relationships.

Editing a registered test runs that test directly, except tests exporting shared helpers: register
those files in `interfacePaths` so their consumers remain selected. Tests owned by modules with
`fullTestReason` also retain full validation. Editing implementations or shared test helpers
runs the module's owner, contract and consumer evidence. Locale JSON keeps its focused translation
guards; the shared translation runtime has its own broader module. Modules whose dynamic consumers
cannot be safely bounded declare a nonempty `fullTestReason` and retain full validation. This is
intentional coverage, not an unregistered legacy exception. Unknown and destructive changes still
fall back to full validation.

The migration PR that removes the former unconditional protected-file rejection still encounters
the old guard from its base revision. Any bootstrap ruleset bypass requires explicit maintainer
authorization and directly merges the PR; it does not carry approval into a later queue run. Do not
enqueue a PR with a known failing required check and expect the queue to waive it.
