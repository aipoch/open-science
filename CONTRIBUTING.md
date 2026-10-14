# Contributing to Open-Science

Thanks for your interest in contributing! This document explains how to set up
the project, the workflow we follow, and the checks your change must pass before
it can be merged. Detailed references:

- [Development and packaging](docs/development-quick-reference.md)
- [Testing and module registration](docs/testing.md)
- [CI and maintainer reference](docs/ci.md)

## Code of Conduct

Be respectful and constructive in all interactions. Assume good intent, keep
discussions focused on the technical merits, and help make this a welcoming
project for everyone.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 24 (see [`.nvmrc`](.nvmrc)) and npm
- Git

See [toolchain details](docs/development-quick-reference.md#toolchain-details) for
runtime compatibility and compiler dependencies.

### Setup

```bash
# Internal contributors with repository access:
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
```

External contributors: [fork the repository](https://github.com/aipoch/open-science/fork),
then replace `<your-username>` below with your GitHub username:

```bash
git clone https://github.com/<your-username>/open-science.git
cd open-science
git remote add upstream https://github.com/aipoch/open-science.git
npm install
```

`npm install` runs a `postinstall` step that generates the Prisma client and
stages verified first-party native components and installs Electron app dependencies.
See the [native component workflow](docs/native-components.md) for source builds and signed CDN artifacts.

For patch failures or an existing installation, follow
[installation troubleshooting](docs/development-quick-reference.md#installation-troubleshooting)
before retrying. Do not bypass patch failures with `--ignore-scripts`.

### Run in development

`npm run dev:web` builds and runs the ordinary Node host and Web UI. `npm run pack:backend`
creates an independent, target-specific npm tarball. See the [standalone runtime guide](docs/standalone-runtime.md)
for native build prerequisites, secure-storage requirements and host capability boundaries.

```bash
npm run dev
```

See [development rebuilds and platform setup](docs/development-quick-reference.md#development-rebuilds-and-platform-setup)
for restart requirements, native helpers and Windows runtime setup, and
[Package workflows](docs/package-workflows.md) when adding or building local packages.

## Coding-agent navigation

Run commands from the repository root. Use the
[command and owner-document map](docs/development-quick-reference.md#coding-agent-navigation)
for focused checks, worktree rules and actions requiring approval.

## Project Structure

The [project structure reference](docs/development-quick-reference.md#project-structure)
maps the Node/Electron runtime, preload, renderer, shared code and independent packages,
and explains where documents, configuration and regression tests belong.

## Development Workflow

1. Create a branch off the default branch for your change.
2. Make your change, keeping it focused and self-contained.
3. Add or update tests that cover the behavior you changed.
4. Complete the [module-impact registration checklist](#module-impact-registration) when adding,
   renaming, deleting, or changing dependencies of source files or tests. Stage new files before
   running the registration guards.
5. Build the final Test Impact Set and run it after the last material edit. Use the full fallback when
   ownership, consumers, or risks cannot be established.
6. Open a pull request with a clear description of the change and its motivation.

### Module-impact registration

Source/test additions, moves and dependency changes must complete the
[module-impact registration checklist](docs/testing.md#module-impact-registration)
in the same PR. Stage intended new files before the registration guards, which inspect
tracked files. Registration checks do not replace behavior tests.

### Durable external components

Before adding a resource outside app-managed storage that survives its creator, follow
the [ownership and cleanup requirements](docs/development-quick-reference.md#durable-external-components).
Creation must ship with safe stop/removal behavior and explicit compatibility, state
and persistence impacts in the PR.

### Database schema changes

Follow the [schema and migration workflow](docs/development-quick-reference.md#database-schema-changes).
Do not edit released migrations or generated runtime schemas; include schema checks
and migration tests with the change.

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

Use the [testing and registration guide](docs/testing.md) to derive checks from the
final diff. Required CI remains authoritative; skipped checks are not evidence.

### Stable test-command semantics

`npm test` runs the complete portable Vitest suite; `npm test -- <paths>` runs only
those targets. Module and affected-test selection use separate commands described in
[Testing](docs/testing.md#stable-test-command-semantics).

### Inner loop

Run the smallest project-owned test covering the behavior being changed and rerun it
when that behavior changes. See [inner-loop checks](docs/testing.md#inner-loop).

### Final local Test Impact Set

Cover changed owner behavior, interfaces, consumers and relevant process/platform risks.
Derive and run the set after the last material edit using the
[final-check checklist](docs/testing.md#final-local-test-impact-set).

### Full fallback

When ownership, consumers or risks cannot be established, or global validation inputs
change, follow the [full-fallback rules and bounded exemptions](docs/testing.md#full-fallback).

### CI authority and evidence

Report `behavior -> command -> result`, explain included/excluded consumer and platform
checks, and identify uncovered risks. State that checks ran after the last material edit.
Only mark the change verified after an independent review confirms coverage of the final
state. See [CI authority and evidence](docs/testing.md#ci-authority-and-evidence).

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
- Confirm the [module-impact registration checklist](#module-impact-registration) is complete for
  applicable changes, and report registration checks run after new files were tracked.
- After required PR checks and review pass, add the pull request to the native merge queue once
  the queue rollout is enabled. The queue validates the combined revision before **squash merge**;
  its squash subject must retain the PR title's Conventional Commit format. Do not update a branch
  merely because `main` advanced; update it for conflicts or a maintainer request.
- Selected CI checks are blocking. See the
  [CI coverage reference](docs/ci.md#pr-merge-queue-and-scheduled-coverage) for PR, merge-queue
  and scheduled suites, platform coverage and known coverage limits.

### PR and issue labels

PR type and size labels refresh automatically; labels do not control CI or merges.
See [label maintenance](docs/ci.md#pr-and-issue-labels) for issue intake and catalog updates.

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

## Publishing standalone CLI archives

See the [CLI archive publishing reference](docs/ci.md#publishing-standalone-cli-archives)
for certification and dry-run requirements, and the
[standalone runtime guide](docs/standalone-runtime.md) for packaging details.

## Further CI references

### Supplemental desktop coverage

See [supplemental desktop coverage](docs/ci.md#supplemental-desktop-coverage) for
complete Mac regression, presentation, Delegation and capacity validation.

### Independent package tests

See [independent package tests](docs/ci.md#independent-package-tests) and
[Package workflows](docs/package-workflows.md) for registration, PR/queue selection
and installed-package verification.

### CI control-plane approval

Protected CI policy changes require CI owner review. Additive module registrations
have bounded exemptions; coverage preservation and trusted-base Integrity checks
still apply. Read the [full approval and preservation rules](docs/ci.md#ci-control-plane-approval)
before editing CI policy or module records.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](./LICENSE), the same license that covers this project.
