# AIPOCH Open-Science — Development & Packaging

AIPOCH Open-Science has an ordinary Node backend and an Electron desktop client, built with React, TypeScript, Prisma/SQLite, and an ACP-based agent runtime.

Prerequisites for source development:

- Node.js 24 (see [`.nvmrc`](../.nvmrc)) with npm
- Git
- Notebook execution optionally uses app-managed Python/R environments or a compatible interpreter you configure.

```bash
git clone https://github.com/aipoch/open-science.git
cd open-science
npm install
npm run dev
```

`npm install` automatically generates the Prisma client and installs Electron native dependencies. `npm run dev` builds the shared Node backend, stages its pinned executable, builds the Electron main/preload bundles, starts the renderer, and opens the desktop client. Development data is isolated under `~/.open-science-project`.

Useful commands:

| Command                | Purpose                                      |
| ---------------------- | -------------------------------------------- |
| `npm run dev`          | Start the development application            |
| `npm run dev:web`      | Node backend + localhost Web UI; no Electron |
| `npm run dev:headless` | Ordinary Node backend + Web UI, no Electron  |
| `npm run lint`         | Run ESLint                                   |
| `npm run typecheck`    | Type-check main and renderer code            |
| `npm test`             | Run the Vitest suite                         |
| `npm run build`        | Type-check and build the application         |
| `npm run build:web`    | Build the optional localhost web UI          |
| `npm run build:mac`    | Package macOS builds                         |
| `npm run build:win`    | Package Windows builds                       |
| `npm run build:linux`  | Package Linux builds                         |

Packaged output is written under `dist/`.

[README](../README.md)

`npm run build:backend` builds the Node entry; `npm run pack:backend` builds the target-specific
standalone package. See [standalone runtime](standalone-runtime.md) for prerequisites and boundaries.

## Toolchain details

Node 24 is the development and CI toolchain. The published CLI continues to support
Node >=22.5.0; PR Gate checks CLI/SDK compatibility on Node 22 as well. Local standalone npm tarballs require Node >=22.13.0; Release CLI archives include Node. Desktop packages include a separately pinned ordinary
Node backend executable; Electron remains the native UI host.

The typecheck scripts use the native TypeScript compiler pinned as `typescript-native`.
The separate `typescript` dependency provides the JavaScript compiler API used by API-map
generation and architecture tests. Keep both dependencies: changing the typecheck compiler
does not migrate those API consumers. Scripts select the compiler by its explicit path,
because both packages expose a `tsc` binary.

## Installation troubleshooting

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

## Development rebuilds and platform setup

Development reuses unchanged package builds and the verified Node runtime. Package edits rebuild
automatically; renderer package edits reload the page and may reset transient state. React keeps HMR.

For backend/main/preload changes, wait for a successful build, quit the app normally, stop the dev
command, then run `npm run dev` again. Web/headless development has no live reload.

For a new local package, follow an existing `tsconfig.dev.json`, reference its local dependencies,
and add it to `tsconfig.packages.json`. Use `npm run build:packages` to build packages alone. The development alias remains available.
Build scheduling and selected isolation checks are described in
[Package workflows](package-workflows.md).

Development reuses the pinned native credential helpers without rebuilding or re-signing them.
Changing their native sources requires publishing updated components; see the
[native component workflow](native-components.md). On macOS, an explicit source rebuild can
change the helper's identity and require Keychain authorization again.

Windows development also rebuilds the Notebook AppContainer host with Cargo before building the
backend, so an older checked-in executable cannot outlive changes to its source or launch protocol.
Install Rust and the MSVC C++ build tools for this step. Cargo reuses unchanged build outputs;
a compilation failure stops startup instead of falling back to an obsolete host.

Windows standard-mode development does not require a separate Notebook runtime.
Enabling Notebook protection prepares verified Node and PowerShell components on demand:
compatible official installations are preferred, and missing components are downloaded from
the pinned CDN catalog. Prepared components are reused across Sessions and application upgrades.
Source compilation is a maintainer workflow for changes to runtime sources or patches. See the
[Windows runtime notes](../packages/notebook-network-sandbox/vendor/windows-runtime/README.md)
for CI artifacts and source-build procedures. Neither application packaging nor end-user setup
compiles these components.

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

| Area     | Owner document                                                                     | Focused checks                                                                                        |
| -------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Renderer | [Design specification](design.md)                                                  | `npm run typecheck:web`; targeted tests under `src/renderer/`                                         |
| Notebook | [Current architecture](PRD.md#8-current-architecture-what-is-actually-implemented) | `npm run typecheck:node`; targeted tests under `src/main/notebook/`                                   |
| Settings | [Settings design](design.md#settings)                                              | `npm run typecheck`; targeted tests under `src/main/settings/` and `src/renderer/src/pages/settings/` |
| ACP      | [Current architecture](PRD.md#8-current-architecture-what-is-actually-implemented) | `npm run typecheck:node`; targeted tests under `src/main/acp/`                                        |

## Project Structure

The desktop uses Electron, electron-vite, React and TypeScript; business owners run in ordinary Node.
The desktop host, standalone Node host, and shared modules live under `src/`:

- `src/main/` — shared business runtime and its Node/Electron entry points (ACP, session
  persistence, artifacts, Notebook, projects, host adapters).
- `src/preload/` — preload bridge exposing a typed `window.api` to the renderer.
- `src/renderer/` — React UI (pages, stores, components).
- `src/shared/` — types and helpers shared across processes.
- `packages/` — independently tested domain packages, native helpers and the standalone CLI/client.

Keep the repository root focused on discovery and default tool entry points:

- Keep `README.md`, `LICENSE`, `AGENTS.md`, contribution/security policies, package metadata,
  and automatically discovered build, lint, test and TypeScript entry points at the root.
- Put product guides and the roadmap in `docs/`. Update relative links when moving documents;
  keep temporary implementation reports out of the root.
- Put configuration regression tests in `test/config/` and auxiliary browser/accessibility
  configurations in `e2e/`. Run the existing npm commands from the repository root; when moving
  a configuration, preserve its test, output, reporter and server working directories, and update
  CI path classification along with callers.

## Durable external components

Before adding a resource that survives its creating process outside app-managed storage or in a
third-party control plane, follow the
[durable external component ownership contract](PRD.md#durable-external-component-ownership).
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

## Database schema changes

`prisma/schema.prisma` owns tables, columns, defaults, indexes, and foreign keys. SQLite CHECK
constraints that Prisma cannot express live in `prisma/sqlite-check-constraints.json`. The runtime
schema module is generated; do not edit it or add feature DDL to startup code.

1. Change the Prisma schema and, only when required, the SQLite CHECK contract.
2. Run `npm run db:schema:generate` and review the generated target schema.
3. Add a new immutable entry under `src/main/database/migrations/`; never change a released
   migration or extend the frozen `0001` legacy repair list.
4. Run `npm run db:schema:check` and the migration tests before committing.

Application table names use singular PascalCase and default to the Prisma model name. Avoid
`@@map` unless an intentional external database contract requires a different physical name.

Prisma CLI is a development and CI tool only. Packaged applications execute the checked-in
migration manifest and do not ship the Prisma migrate engine.

Migration history is owned by `src/main/database/`. Module tests may run
`migrateApplicationDatabase` to create a current-schema fixture, but handcrafted historical schemas,
upgrade assertions, and migration-ledger expectations belong in the database migration tests rather
than in feature-module suites.

[Contribution workflow](../CONTRIBUTING.md) · [Testing](testing.md) · [CI reference](ci.md)
