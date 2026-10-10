# @aipoch/skills

Repository-local npm package for Skill documents, catalogs, transactional installation, helper
snapshots and runtime projection. It follows the application version and is intentionally private.
No Electron, Prisma, Notebook installation or application source is required.

## Public entry points

| Import                      | Responsibility                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `@aipoch/skills`            | Repository, bundled registry, catalog merge, observation, draft service, helper catalog and Specialist transaction participant |
| `@aipoch/skills/document`   | Browser-safe document parsing/serialization, identity, activation rules and DTOs                                               |
| `@aipoch/skills/sources`    | GitHub/archive/marketplace transport and validation, install queue and export bytes                                            |
| `@aipoch/skills/projection` | Filesystem projections and bounded runtime document reading                                                                    |

Import only these names. Internal filenames are not supported APIs. One CommonJS implementation
also supports Node ESM consumption; both use the same error classes and per-root mutation owner.

```ts
import { UserSkillRepository, SkillRegistry, mergeSkillCatalog } from '@aipoch/skills'

const user = new UserSkillRepository('/absolute/app-data')
const bundled = new SkillRegistry('/absolute/bundled-skills')
const catalog = mergeSkillCatalog(await bundled.list(), await user.list())
```

The host provides storage/bundled roots, authenticated network functions, Python helper validation,
permissions and application policy. `SkillMarketplaceService` accepts a standard fetch function;
use a host transport when cookies, proxies or redirect handling require application policy.
Projection hooks provide the host's Compute notice and exact legacy-directory cleanup. Package
projection never infers host capabilities from Skill content.

Non-builtin Python helpers **require** a `SkillHelperValidator` when inspected, installed, published,
exported or bound. Missing validation rejects the operation. The package neither locates nor installs
an interpreter. The application adapter preserves managed-runtime discovery and callable-export
validation. Trusted bundled helper snapshots retain their existing trust rules.

`UserSkillSpecialistPackageAdapter` participates in the host's cross-domain transaction. It and
`UserSkillRepository` share one mutation owner per resolved storage root. Keep recovery barriers and
prepare/commit/rollback ordering in the coordinating application; do not write Skill files directly.
A repository read callback must finish before its lock is released.

`subscribeSkillDiagnostics` supplies scoped diagnostics and returns an unsubscribe function.
`UserSkillCatalogObserver.dispose()` must be awaited by its owner. Application notifications,
session approvals, ACP reload scheduling and Notebook execution remain host responsibilities.

## Compatibility and persistence

Extraction preserves existing Skill IDs, frontmatter, directory layout, `.source.json`,
`.specialist-package.json`, transaction journals, compatibility indexes, helper trust bindings and
projection manifests. No schema migration, new persisted status, IPC value or enum is introduced.
Helper bindings and immutable generations are durable execution evidence; do not treat them as a
throwaway cache. Existing recovery and legacy identity behavior is retained.

## Development and acceptance

Run `npm ci`, `npm run build`, `npm run typecheck` and `npm test` in this directory.
`npm run verify:package` copies only this package to an OS temporary directory, installs its own
locked dependencies, builds/types/tests it, packs it, then installs and exercises the tarball in a
second clean consumer. It requires npm registry access on an empty cache. Temporary acceptance
artifacts are reported and preserved for inspection. The tarball contains emitted code and types,
README and LICENSE; tests, host resources and source files are excluded.

Application integration tests run separately from `src/main/skills/` and the consuming features.
The repository's module-impact manifest retains downstream contract evidence. Package tests never
import the application. Consumer-only changes need host contract tests; package behavior changes
also require relevant downstream integration coverage.

## Boundary ownership

`AgentHomeSkillCatalog` composes with the same `UserSkillRepository` for discovery, safe path
resolution, alias deduplication, preview, batch import and legacy identity reconciliation. Supply
explicit permitted source directories; the package never reads application settings or chooses a
user home. Keep one catalog instance for the host lifecycle so failed-migration state survives reads.
The host selects roots for its active agent, supplies reserved bundled names, and refreshes its
permissions/UI/runtime after successful operations.

All four entry points use explicit symbol exports. Internal ZIP extraction, path normalization and
transaction owners are private; add public API deliberately rather than re-exporting entire modules.
The package's tests reject host imports, undeclared dependencies and local/workspace dependency
shortcuts. Application networking uses the standard Fetch contract; package transports are inputs.
