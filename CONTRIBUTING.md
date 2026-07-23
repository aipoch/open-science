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

- [Node.js](https://nodejs.org/) (LTS recommended) and npm
- Git

### Setup

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
```

`npm install` runs a `postinstall` step that generates the Prisma client and
installs native Electron app dependencies.

### Run in development

```bash
npm run dev
```

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
4. Run the full check suite locally (see below) and make sure it passes.
5. Open a pull request with a clear description of the change and its motivation.

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
- Keep user-facing strings, comments, and documentation in English.

## Required Checks

Before opening a pull request, run all of these and make sure they pass:

```bash
npm run typecheck   # TypeScript type checking (node + web)
npm run lint        # ESLint
npm run test        # Vitest unit tests
```

Pull requests are expected to keep type checking, linting, and the test suite
green. New behavior should come with tests.

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
- Keep PRs reasonably small and scoped so they are easy to review.
- Ensure the required checks above pass.
- Merge pull requests using **squash merge only**. The squash commit subject must
  keep the pull request title's Conventional Commit format.

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
