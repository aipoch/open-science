# @aipoch/journal-catalog

Owns journal identity matching, staged dataset imports, reviewed commits, dataset edits, filtering, alignment and portable dataset exchange.

- Root: `JournalAttributes` and domain storage/reference interfaces (Node).
- `/contracts`: validated dataset/identity/request/result types and normalization (browser safe).
- `/files`: CSV/TSV/XLSX parsing, column mapping, portable bundles and template bytes (browser safe).

## Storage contract

Provide one stable `JournalDatabase` per opened database. Its `JournalStore` operations exchange
journal identities, datasets and entry values, without table names, statements, driver values or
serialized storage columns. `importedAt` is epoch milliseconds; counts and revisions are numbers.
The adapter owns serialization, indexes, constraints, connections and migrations. This package
contains no database engine or schema and does not provision or upgrade storage.

`transaction(operation, options)` supplies a scoped `JournalStore`. Its catalog operations and
`references` operations must all use the same native transaction. Resolve only after commit;
on rejection, roll back all writes before rejecting. Do not retain the scoped store beyond the
callback. Timeout and acquisition-wait options are milliseconds. The adapter must serialize or
isolate competing writes so revision checks cannot both accept the same old state.

Reads return detached domain values. Dataset lists include entry counts and are ordered by year
descending, then source. Entry and dataset-row reads use journal-ID ordering, exclusive `after`
cursors and optional limits; pagination of entries is used within one dataset. Omitted ID filters
mean all IDs in scope, while empty ID filters mean no rows. Read `ports.ts` declarations through
the root export for the write, revision, reference paging and removal contracts.

`saveDatasetImport` creates revision 1 or increments the existing revision, preserving an existing
dataset's name/source/year. `saveJournals` preserves an existing journal's name while replacing its
reviewed aliases and identifiers. `saveEntries` upserts values and source rows. `updateDataset`
increments revision even for an empty patch (an entry edit). `removeDataset` removes its entries,
then orphan journals and their bindings, without deleting host references. Implement these operations
inside the supplied transaction; the package owns review, matching, merge policy and validation.

The Open-Science adapter is `src/main/literature/journal-attributes.ts`. It maps this contract to
Prisma and the application tables; `prisma/schema.prisma` and application migrations remain their
schema authority. Shared transactions and cascading reference bindings are intentional host
constraints. Changing the host's physical schema requires updating that adapter, not this package.
Changing the domain storage contract requires updating all adapters. Independent packaging does not
make the application's database migrations independently deployable.

## Ownership and lifecycle

The package owns staged imports, review digests, identity matching, caches and scan cancellation.
The host owns reference metadata/fingerprints, binding persistence, file dialogs and application
events. Call `referencesChanged()` after committed reference changes; catalog writes invalidate the
package's caches automatically. Use one catalog owner per opened database; out-of-band catalog
writes require replacing the owner. Reopening storage requires a new database object.

`dispose()` stops staging/scans, drains in-flight import commits (rolling them back if interrupted)
and releases timers. It does not close the host connection or generally join every request: the host
must stop admitting requests and drain other operations before closing its database. Notification
failures are reported through `JournalIntegration.warn` after commit, without undoing committed data.
Dataset formats, IDs, revisions, field colors and manual binding behavior retain their representations.

## Verification

From the repository root, run `npm test -- packages/journal-catalog/test
src/main/literature/journal-attributes.test.ts`. In an independent source checkout, run `npm run build`
and `npm test`. `npm pack` contains runtime code/declarations only; consume its public exports.

Package tests use a transactional in-memory domain adapter with no application schema or host imports.
They cover import review, matching, numeric filters, cache invalidation, paging, confirmation concurrency,
cancellation and bundle round trips. Host tests exercise real Prisma transactions, parameterized storage,
binding and deletion rollback, Library projection, shared datasets and database reopening. The opt-in
host scale suite measures the actual Worker/Prisma pipeline. The packed runtime check imports and
resolves a dataset using consumer-owned in-memory storage.
