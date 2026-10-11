# PDF package boundaries

PDF Structure and PDF Translation are independently consumable npm packages in this repository.
They ship with the application version and do not require separate publication or a plugin loader.
The existing Literature library, discovery, citations and UI remain application modules.

| Package                         | Owns                                                                                                                        | Host responsibilities                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `@aipoch/pdf-structure`         | Extraction engine, worker lifecycle, algorithms, assets and result validation                                               | Source authorization and immutable snapshots, verified model assets, global process supervision and cache publication                    |
| `@aipoch/pdf-translation`       | Translation state and recovery, batching, extraction/layout, generation workers, checkpoints, usage and generated-PDF cache | Inference/model/Agent execution, credentials and accounts, source authorization, transaction composition, application paths and shutdown |
| `@aipoch/pdf-document-contract` | Shared PDF source identity and validation                                                                                   | Establishing access authority and resolving the managed bytes                                                                            |

The identity contract is shared by workspace documents, bookmarks and translation; it does not
belong to an extraction engine or import application code. Translation consumes structural results
through `@aipoch/pdf-structure/result`. There are no dependencies from these packages into host source.

Structure exposes engine and result entries. Translation exposes seven capability entries: service,
contracts, text, reader, writer, storage and resources. Internal files are not separate npm packages
or public entry points. See each package README for lifecycle obligations and supported imports.

## Acceptance criteria

- **Cohesion:** each package owns its named workflow/invariants, state, failure and cleanup rules.
  Host ports supply external capabilities; they must not conceal the package's domain decisions.
  Tests cover success, error, cancellation and recovery. One service owns each mutable state.
- **Clean dependencies:** every production, type, build and test dependency is declared. Relative
  imports stay inside the package; external imports use package names and explicit exports.
  A copied source tree must build and test outside the repository. A clean production consumer of
  `npm pack` must load public entries, reject private paths, compile strict declarations, and execute
  real worker/resource behavior. Browser entries must bundle without Node or Electron dependencies.
- **Host test reduction:** record a fixed baseline and map each old test to its destination. Do not
  delete assertions or add skips to improve counts. Package algorithms run in package suites;
  authorization, transactions, IPC, lifecycle integration and UI remain host responsibilities.
  Separately report static test ownership and actual selected/runtime test counts.
- **Directional CI:** a host-only change selects zero unchanged package suites, while retaining
  applicable host integration tests. A package change selects that package and its downstream
  consumers. Shared build/lock/toolchain inputs retain explained conservative fallback. Full local
  `npm test` retains complete portable-suite semantics, including package tests and coverage sources.

## Local verification

`npm run build:pdf-packages` builds in dependency order. `npm run check:pdf-packages` uses existing
npm cache entries to check independent source builds/tests and clean tarball consumers. It does
not need a registry publication. Inspect the emitted report and worker/browser/type-check logs.
`npm run test:pack --prefix packages/pdf-structure` additionally tests the real extraction worker
lifecycle; its README documents successful inference with existing reviewed local model assets.
Host adapter tests and PDF Playwright journeys verify the assembled application separately.
The host regression corpus remains available to integration tests; the fixture consistency guard
requires those cases to be copied into the independent translation suite. New package-only cases
may stay local to the package. Fixture changes retain both package and host regression selection.

Package registry and dynamic worker/resource edges are recorded under `scripts/ci/`; ownership and
consumer guards must pass after adding or moving files. The initial migration changes root package
metadata and may conservatively select all suites. Savings apply to later, bounded downstream edits;
local elapsed time must not be presented as measured Ubuntu CI savings.

## Persistence and compatibility

The extraction result format/fingerprint inputs, translation checkpoint and usage tables, PDF source
identity, cache formats/directories and status values are preserved. This extraction adds no schema
migration or state enumeration and requires no historical-data conversion. Existing recovery behavior
remains covered. Host source checks and document registration continue in the same transaction as
checkpoint writes; database schema and global migration ownership remain with the application.
