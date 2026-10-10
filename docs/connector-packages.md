# Connector package boundaries and acceptance

The Connector extraction in [PR #3417](https://github.com/aipoch/open-science/pull/3417)
separates reusable execution from application composition. Moving files into `packages/`
is necessary but does not establish cohesion, preserve coverage, or prove independent installation.
This document defines those three claims separately. These are project acceptance rules, not
purported industry-standard percentages.

## Cohesion: one capability and its invariants

A package is cohesive when it owns a named capability and all invariants needed to complete
that capability. Callers provide resources or policy through documented interfaces; they do not
coordinate fragments of the package's internal state machine.

| Owner                  | Belongs here                                                                                                     | Remains with the host                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `connector-core`       | Schema validation, descriptor/error identity, HTTP budgets, retries and cancellation                             | Credential acquisition, permissions, application identity, storage                                                     |
| `connector-builtins`   | Scientific schemas, provider mappings, parsers, pagination, remote jobs, scientific limitations                  | Settings groups, Skill invocation syntax, Notebook policy, Artifact/Provenance workflow                                |
| `connector-mcp-client` | Connection/discovery/call/close, OAuth/PKCE, callback lifecycle, generations and ordered shared-auth updates     | Browser opening, network policy, identity and recovery copy, encrypted storage and compare-before-write interpretation |
| Application            | Composition, permissions, credentials, sessions, Skill documents, preview/Artifact transactions, Settings/UI/IPC | Provider parsing, HTTP retry algorithms and OAuth protocol implementations                                             |

For each exported operation, the review must identify its input/outcome, invariant owner,
resource/state owner, failure/abort behavior, injected capability and tests. Acceptance requires:

- Every advertised operation executes its contract. A descriptor that always throws because it
  needs the application does not qualify as a reusable provider operation. `preview_molecule`
  belongs to the host; `render_molecule` remains an offline scientific operation.
- Each mutable lifecycle has one owner for creation, mutation, invalidation and disposal.
  In particular, abstracting persistence must preserve MCP generation checks, serialized shared
  credential writes, sibling invalidation and shutdown ordering.
- Provider examples are schema-valid argument data (`exampleArgs`). The host renders the
  `host.mcp` call and adds Settings, persistence and tool-routing guidance. Scientific caveats
  and upstream attribution stay with the provider.
- Host consumers use documented exports. Host tests cover wiring and policy; package tests
  cover the algorithms and lifecycle they own. Runtime, UI and composition changes must not
  require edits to unrelated provider implementations.
- An independent consumer exercises real execution, including supplied capabilities, rather
  than only importing constructors or counting descriptors.

`connector-builtins` is a distribution of scientific providers, not a shared mutable aggregate.
Many public provider subpaths are intentional. Importing one subpath does not install fewer
dependencies. Split distributions only for demonstrated release, install or runtime constraints;
neither file length nor a dependency-count target establishes a useful boundary.

ENCORI's range/validator checks, partial-file identity, gzip validation, recovery and rate limiter
remain together. Its publisher callback owns atomic no-overwrite publication and platform durability.
Filesystem use is compatible with a Node package's purpose; it still counts as persistence.

## Host unit-test reduction: transfer ownership without losing behavior

Freeze base and head commits, the capability scope and the classification before measuring.
Classify **asserted behavior**, not directories, mocks or filenames:

- **P**: package-owned behavior, such as parsing, retries or MCP invalidation.
- **H**: host-owned policy/wiring, such as permissions, credential projection or Artifact creation.
- **I**: integration/contract behavior spanning the interface.
- **L**: live-service or platform validation, reported separately.

Let `U0` and `U1` count runnable, collected P cases owned by host unit-test suites before and after.
Running package suites from the root runner does not make them host-owned tests.
Report `U0 - U1` and `(U0 - U1) / U0` only for that frozen scope; if `U0 = 0`, the ratio is
not applicable. Parameterized cases count after collection. Report skipped/todo cases separately.
A moved filename, fewer selected CI tests, reduced wall time or fewer lines cannot substitute
for this measurement. Mixed tests must be split or classified by their actual assertions.

The extraction passes when every transferred P behavior has a package-owned test, its duplicate
host-only assertion is removed or justified, and every required H/I behavior remains covered.
The behavior ledger must reconcile `moved / retained integration / new / intentionally removed`;
removal needs an explicit obsolete requirement, not a desire to lower the count. Require zero
unexplained behavior loss and zero unexplained duplicate P ownership. Do not impose a generic
percentage decrease on H/I tests: adding integration coverage may increase them legitimately.

### Recorded #3417 baseline

Base `6db81a12cb83acaa0d5ee66fb5005eab5837ba73`, head
`1cbaaf0cabe2e40136a29b494d26b6974fe999dc`:

| Inventory                                                       | Before | After | Interpretation                                             |
| --------------------------------------------------------------- | -----: | ----: | ---------------------------------------------------------- |
| Connector host test files, including the moved composition test |     87 |    15 | Net −72 files (82.8%); **not** a unit-case reduction claim |
| Connector package test files                                    |      0 |    78 | 74 renamed from host; four additional package test files   |
| All `src/` test files                                           |   2674 |  2602 | Repository file inventory only                             |

Reproduce the file inventory with `git ls-tree -r --name-only <revision>` and tracked
`.test.[cm]?[jt]sx?` paths; include `src/main/connectors`, `src/main/connector-core` and
`src/main/composition/connector-application.test.ts`. Use
`git diff --find-renames --name-status <base> <head>` to review moves. File similarity does
not prove assertion preservation. A collected/classified `U0` baseline was not established
by that inventory, so the 82.8% figure must not be presented as fewer host unit-test cases.

### Follow-up behavior ledger

| Behavior                                     | Package evidence                                                                                                                            | Retained/new host evidence                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scientific examples and validation           | `connector-builtins/src/contracts.test.ts`; provider-specific example tests validate argument objects                                       | `registry.test.ts`, `skill-document-renderer.test.ts`, `skill-doc.test.ts`; Notebook `host-mcp.integration.test.ts` executes the rendered example |
| Molecular calculation vs preview             | Builtins `molecule.test.ts`; reusable descriptors contain only `render_molecule`                                                            | `registry.test.ts`, `molecule-artifact-adapter.test.ts`, composition `connector-application.test.ts` retain the preview/Artifact workflow         |
| HTTP identity and transport                  | Core `engine.test.ts` checks managed/raw headers and caller override                                                                        | `ConnectorService` supplies the application User-Agent; existing service/network tests retain host routing                                        |
| MCP identity, authentication and persistence | MCP `client-manager.test.ts`, `oauth-client.test.ts` retain generations, shared writes, cancellation and lifecycle; guard payload is opaque | `custom-mcp-config.test.ts`, `mcp-host-dependencies.test.ts`, composition and Settings workflow tests cover mapping to existing stored fields     |
| Provider caveats vs product recovery         | Provider tests retain scientific/email requirements                                                                                         | Host Skill tests retain Settings/contact-email, retention and no-HTTP-bypass instructions                                                         |

This follow-up transfers presentation assertions and strengthens contracts; it does not claim
another numerical reduction in host tests. Keep the package and host evidence as distinct rows
in the PR's final Test Impact Set, with executed/passed/skipped counts and exact commands.

## Clean dependencies: declared, directional and independently consumable

Acceptance requires all of the following, with zero unexplained violations:

1. Production source and emitted declarations use only runtime dependencies, peers and the
   documented Node platform. Dev dependencies are available only to tests/build tooling.
   Type-only public imports still require a consumer-resolvable declaration dependency.
2. Packages do not import host source, aliases or sibling private files. Hosts and sibling
   packages consume only declared exports. Dependency direction is builtins/MCP → core;
   core must not depend on either of them or the application. No package cycle is allowed.
3. Every peer has a documented compatible range. A single core instance preserves cross-package
   `instanceof` and descriptor identity. CJS and ESM consumption must agree.
4. Fresh tarball installation outside the repository can build, typecheck and test each package.
   A strict TypeScript consumer checks declarations **without `skipLibCheck`**. Then prune
   dev dependencies, remove copied source trees, and execute the consumer using runtime
   dependencies only. No repository `node_modules`, source aliases or `NODE_PATH` fallback.
5. The consumer calls a custom core provider, provider error fallback, offline molecule
   calculation, ENCORI query/publication, and MCP initialization/discovery/pagination/call/close.
   Test injected resources with deterministic fixtures; live services are a separate dimension.

`exports` restricts supported package-name subpaths, but is not a security sandbox against
absolute filesystem access. Static import guards and independent execution provide separate
kinds of evidence. Neither zero Electron imports nor a passing root build alone proves cleanliness.

### Executable checks

- `npx vitest run src/main/connectors/boundaries.architecture.test.ts`: declared runtime/dev
  dependencies, host escapes, public exports and forbidden dependency directions.
- `npm run check:connector-packages`: copied-package typechecks/tests and independent tarball
  consumer. `-- --offline` may use an explicitly supplied npm cache; it may not borrow source
  or `node_modules` from the repository.
- `npm run test:module -- <module-id>`: prints and executes selected owner, contract and consumer
  evidence for `connector_core`, `connector_builtins`,
  `connector_mcp_client` and `main_connectors`. For a read-only preview use `createModuleTestPlan` / `formatModuleTestPlan` from
  `scripts/ci/module-test-impact.mjs`; `test:affected:explain` previews a committed diff. Interface changes also
  require affected consumer evidence; module selection alone is not complete downstream proof.
- Run affected process typechecks, lint, ownership and consumer registration guards after new
  files are tracked. Exact-head PR CI remains authoritative for complete and platform suites.

## 0.2 source compatibility and data impact

The three package versions advance together to 0.2.0; builtins/MCP require core `^0.2.0`.
This is a breaking **source API** change from 0.1, with explicit host adaptation:

- Replace `ToolDescriptor.example` executable strings with `exampleArgs` objects. Consumers
  choose their own invocation syntax. `ConnectorGroup`/catalog `group` move to the host catalog.
- `MOLECULE_TOOLS` no longer advertises `preview_molecule`; the application still registers
  the same tool identity and uses the existing local Artifact handler.
- MCP config carries `persistenceGuard`; `saveOAuthState` receives that guard as its third
  argument. The host maps its fingerprint/secret-reference fields into the guard and checks
  them through the existing Settings writer. Never drop the guard during adaptation.
- Supply MCP `clientInfo`, authentication guidance and expired-callback HTML for host branding.
  Core accepts `userAgent` and applies it to managed/raw requests while retaining explicit
  provider headers. Independent defaults identify the package. Enrichr's default upstream job
  description becomes `Gene-set enrichment`; explicit caller descriptions are unchanged.

**Historical data:** no new migration, legacy reader, stored-field rename or compatibility shim.
Existing custom-server/OAuth records, credential references, tool IDs and ENCORI recovery data
remain in their existing formats. Existing historical handling is retained and tested; this is
not a request to add another compatibility layer. ENCORI retains the historical default directory
`~/OpenScienceConnectorData/encori` and recovery owner tag `open-science.encori.download`.
These branded persisted identifiers are an explicit retained compatibility boundary, not generic
presentation metadata. Renaming them would need a separate decision about legacy files/resume.

**States/enums:** no new product state or enum value. Connection generations and OAuth protocol
state continue to be owned by the same lifecycle.

**Persistence:** existing OAuth/credential writes, ENCORI files/receipts and Artifact/Provenance
writes still exist. Only the in-memory adapter contract changes. Storage locations, encryption,
formats, atomic publication, write ordering and compare-before-write checks are preserved.
Generated Skill text changes and is regenerated through the existing provisioner.

## External foundations

- [Cockburn: Hexagonal Architecture](https://alistair.cockburn.us/hexagonal-architecture/)
  motivates explicit ports for external resources and policies; it does not prescribe a cohesion score.
- [Node.js package entry points](https://nodejs.org/api/packages.html#package-entry-points)
  defines supported exports and their encapsulation limits.
- [npm package.json dependencies](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#dependencies)
  distinguishes runtime, development and peer dependencies.
