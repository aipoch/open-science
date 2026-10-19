# @aipoch/skills

Repository-local npm package for Skill documents, catalogs, transactional installation, helper
snapshots and runtime projection. It follows the application version and is intentionally private.
No Electron, Prisma, Notebook installation or application source is required.

## Public entry points

| Import                      | Responsibility                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `@aipoch/skills`            | Repository, bundled registry, catalog merge, observation, draft service, helper catalog and Specialist transaction participant |
| `@aipoch/skills/document`   | Browser-safe document parsing/serialization, identity, activation rules and DTOs                                               |
| `@aipoch/skills/sources`    | GitHub/archive imports, release-source contracts, safe package validation and export bytes                                     |
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
permissions and application policy. Marketplace transport, catalog protocol, trust roots, cache and
batch lifecycle belong to the consuming application.
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
`UserSkillCatalogObserver.dispose()` is synchronous; call it when releasing the observer. Application notifications,
session approvals, ACP reload scheduling and Notebook execution remain host responsibilities.

## Safety and integration

- **Scope:** Skill documents, source imports, helper snapshots, installation, and runtime projection.
- **Controls:** Package/path validation, required non-builtin helper validation, immutable bindings,
  and recoverable mutations preserve the documented installation contract.
- **Remaining risks:** Skill instructions can redirect an Agent, and helpers can execute code when
  invoked. Structural validation or a source digest does not prove harmless behavior. Marketplace
  trust verification belongs to the host; this package does not establish it for arbitrary sources.
- **Safe integration:** Review content and updates, supply trusted source policy and helper validation,
  and keep invocation approvals and execution isolation in the host. Enable only needed capabilities.
  See the application's
  [extension precautions](https://github.com/aipoch/open-science/blob/main/docs/usage-scope.md#extensions-remote-access-and-automation).

## Compatibility and persistence

Extraction preserves existing Skill IDs, frontmatter, directory layout, `.source.json`,
`.specialist-package.json`, transaction journals, compatibility indexes, helper trust bindings and
projection manifests. No schema migration, new persisted status, IPC value or enum is introduced.
Helper bindings and immutable generations are durable execution evidence; do not treat them as a
throwaway cache. Existing recovery and legacy identity behavior is retained.

## Development and acceptance

Install the durable publication prerequisite as described below, then run `npm run build`,
`npm run typecheck` and `npm test` in this directory.
`npm run verify:package -- --durable-files-tarball=<absolute-path>` copies only this package to an OS temporary directory, installs its own
declared dependencies, builds/types/tests it, packs it, then installs and exercises the tarball in a
second clean consumer. It requires npm registry access on an empty cache. Temporary acceptance
artifacts are removed after successful verification. The tarball contains emitted code and types,
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

## Responsibility and acceptance contract

| Package owns                                                                                                     | Host owns                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `SkillAuthoringService`: draft files, safe editing, validation, publication, deletion and mutation serialization | `host.skills` request parsing, session identity, deletion approval/decline, model guidance and post-commit refresh |
| Skill installation plans, content/version preconditions, ownership records and transaction recovery              | Specialist preview choices, Main Agent enablement, consumer names and cross-domain coordination                    |
| Source-neutral release installation, diffs and confirmation fingerprints                                         | Marketplace verification/receipt codec/version policy, usage display and a revision checked under the impact lock  |
| Safe projected-directory reading and copying                                                                     | Framework directory defaults, MCP discovery budgets and Agent Home display labels                                  |

Use `runMutationExclusive` to keep an authoring operation serialized across a host approval decision;
resolve a deletion target before asking and delete that stable target only after approval. All
instances sharing the draft root use one mutation owner. Do not move file writes back into the host.
Release guard callbacks receive the installed Skill ID and its recorded owner IDs; return a
stable revision covering every usage relationship the user approved. Keep the impact lock held
through revalidation and commit. Display DTOs are composed by the host, never persisted by this guard.

Acceptance is a set of gates, not a file-size or test-count score:

1. **Cohesion:** public operations own Skill workflows or invariants. Package behavior tests use
   package-only fixtures. Architecture guards reject host session/approval and usage-display
   contracts in package implementation. Host tests retain RPC, approval, refresh and cross-domain
   integration evidence. Reviews must also check ownership, locking and lifecycle; import scanning
   alone cannot establish semantic cohesion.
2. **Dependency cleanliness:** zero host or sibling source imports, undeclared imports, or local
   dependency shortcuts in source/tests/scripts; zero host bypasses of public exports. The isolated
   `verify:package` build, tests, tarball runtime consumer and declaration consumer must all pass.
   A root-workspace build alone is insufficient. Policy callbacks are supported inputs, not host
   implementation dependencies.
3. **Host test reduction:** choose a fixed pre-extraction revision and a stable feature cohort,
   including renamed host catalog tests. Collect expanded cases with `vitest list --json=<file>`
   in both revisions; report unique test files and cases separately from package and downstream
   integration suites. Map removed host tests to their package successors, explain new cases and
   retain coverage. Host-only case count must decrease; deleting assertions or merely renaming
   host suites is not reduction. Do not infer elapsed CI savings from counts.
4. **CI direction:** the host boundary test replays host-only, package-only, shared and unknown
   changes through the existing package selector. A host-only change selects zero unchanged Skill
   package unit tests; a package change selects its units and keeps registered host consumer
   evidence. Shared/unknown changes retain fallback. Root `npm test` remains the complete suite.

Run the package checks above, then from the repository root run focused host tests including
`src/main/skills/package-boundary.architecture.test.ts`, the module registration guards and affected consumer
contracts. Record exact revisions, collection commands, counts and selection reasons in the local
acceptance report. Required PR CI validates the actual Ubuntu/Windows execution; local collection
and policy replay must not be reported as a measured CI-duration improvement.

## Test dependency direction

`npm --prefix packages/skills test` runs only this package's units and boundary checks. Repository
module commands also verify downstream application integration; `test:module skill_package` is not
an isolated package test command. Host modules must not register Skill package unit tests as their
own owner, contract or consumer evidence. Package units remain owned by `skill_package`; host
changes retain their application tests without pulling unchanged upstream units into local module
plans or Ubuntu PR execution.

Skill consumer registrations must have a static dependency path or an explicit edge in
`scripts/ci/module-runtime-consumers.json`. This includes architecture tests that read package
source from disk. Removing a stale registration never deletes the test or its actual owner.
Type-only dependencies through shared application contracts remain in the conservative consumer
graph, so a package change can still select many host tests. Skipping those edges would require a
separate design for contract validation; independence does not imply zero downstream verification.

## Release-source boundary

`releaseInstallation`, `previewReleaseUpdate` and `installRelease` accept a `SkillReleasePolicy`.
The source owns its metadata namespace, receipt codec, wire digest, version ordering and diff label.
The repository owns path safety, local-change detection, confirmation fingerprints, atomic package
and receipt promotion, locking and recovery. Source callbacks must be deterministic and validate
their own receipt fields; they must not write Skill files. The namespace cannot replace core source
fields. Receipts for another namespace cannot authorize an update.

The application Marketplace adapter retains the historical `.source.json.marketplace` representation
and its exact digest algorithm. This refactor does not migrate existing data. Package tests use a
fictional local publisher with a different version grammar and no official market fixtures. Boundary
tests reject Marketplace symbols, URLs and protocol identifiers in package source/tests/scripts.

### Durable publication dependency

This package declares `@aipoch/durable-files` as a runtime dependency. For unpublished local builds,
install its real npm tarball alongside the declared dependencies (`npm install --no-save /path/to/aipoch-durable-files-0.1.0.tgz`),
then build/typecheck/test as usual. Run the repository dispatcher with
`npm run check:packages -- --packages=skills` to prepare that prerequisite without rerunning its
unchanged unit suite. Standalone `verify:package` accepts `-- --durable-files-tarball=<absolute-path>`.
Verification removes the source copy and consumer devDependencies before its final runtime check.
