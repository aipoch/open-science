# Contributing to Open Science

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

### Run in development

```bash
npm run dev
```

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
- Wrap user-facing strings with the `t()` translation function from `react-i18next`. Add corresponding translations to the `renderer` namespace in `src/shared/i18n/locales/fr.json` (French), `src/shared/i18n/locales/ja.json` (Japanese), `src/shared/i18n/locales/ko.json` (Korean), `src/shared/i18n/locales/ru.json` (Russian), `src/shared/i18n/locales/zh-Hans.json` (Simplified Chinese), and `src/shared/i18n/locales/zh-Hant.json` (Traditional Chinese). Use the English text as the translation key. Keep code comments and documentation in English.

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

`test:module` supports only the Module IDs declared in `scripts/ci/module-impact.json`. It runs that
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
- After the pull request checks pass, merge it directly using **squash merge only**. Do not update the
  branch only because `main` advanced; update it when it has merge conflicts or a maintainer requests
  it. The squash commit subject must keep the pull request title's Conventional Commit format.
- Non-documentation changes merged into `main` trigger the [Nightly workflow](.github/workflows/nightly.yml),
  which runs post-merge verification and cross-platform package certification on the resulting commit.

## Reporting Issues

When filing a bug report, please include:

- What you expected to happen and what actually happened.
- Steps to reproduce.
- Your operating system and app version.
- Relevant logs or screenshots, if available.

## Publishing the npm Package

Maintainers should follow the [npm package release guide](docs/npm-release.md). npm package versions
use `npm-v*` tags and are published through the protected `Publish npm package` workflow.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](./LICENSE), the same license that covers this project.
