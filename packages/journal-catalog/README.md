# @aipoch/journal-catalog

Owns journal identity matching, staged dataset imports, reviewed commits, dataset edits, filtering, alignment and portable dataset exchange.

- Root: `JournalAttributes` and storage/reference integration interfaces (Node).
- `/contracts`: validated dataset/identity/request/result types and normalization (browser safe).
- `/files`: CSV/TSV/XLSX parsing, column mapping, portable bundles and template bytes (browser safe).

Provide a stable `JournalDatabase` per opened database, with parameterized `query`, `execute` and atomic `transaction` operations. A transaction must roll back on rejection. The SQL implementation touches only the package's Journal, JournalDataset and JournalDatasetEntry tables; application migrations provision the existing schema. Adapters implement date and integer conversion for their SQLite driver. The host supplies reference lookup and binding operations on the exact reader passed by the package, so reference checks and writes share the same native transaction.

The host owns application database migrations, Literature/Project/Session tables, reference bindings, file dialogs and application events. No generated Prisma client or host source is required. `dispose()` drains in-flight commits and releases staged imports/timers. Dataset formats, IDs, revisions, field colors and manual binding behavior retain their existing representations.

Run `npm run build` and `npm test` here. Tests use an independent SQLite database. `npm pack` contains runtime code/declarations only; use public exports to consume it.

Business assertions belong here: import review, matching, numeric filters, cache invalidation, paging, confirmation concurrency, cancellation and bundle round trips. Tests use package-owned SQLite tables and consumer-port DTOs; the fixture does not model Prisma or Library records. Host tests cover the real Prisma transaction, Library field projection/binding edits and reopening the application database. The opt-in host scale suite measures the actual Worker/Prisma pipeline.
