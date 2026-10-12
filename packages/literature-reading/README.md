# Literature Reading

Repository-local npm package for bounded document reading, extraction caching, cursors, overlapping chunks, full-text search, fallback retrieval and index retention.

`LiteratureReader` accepts immutable document references and an `authorize` callback. Authorization runs before every cache lookup and returns a lazy text extractor. The caller owns session selection, immutable-version authority, leases and PDF extraction. Search results preserve every binding even when bindings share extracted content.

`LiteratureIndex` owns the SQLite FTS5 sidecar schema, migrations, search ranking and retention. Supply `IndexDatabase` connections and optional maintenance admission. Reuse one owner per physical index. The adapter owns opening, closing and transactional execution; the package owns SQL. Core database access and Prisma are not dependencies.

Existing index schema, extraction fingerprint and cursor serialization are preserved. Cached data remains disposable; an absent, expired or unavailable index falls back to bounded retrieval.

`npm test` builds and runs tests against Node's SQLite driver. `npm run check:packages -- --packages=literature-reading` from the repository builds and tests an isolated copy, packs it, and verifies a clean production consumer.
