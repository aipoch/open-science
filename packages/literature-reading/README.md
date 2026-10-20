# Literature Reading

Repository-local npm package for bounded document reading, extraction caching, cursors, overlapping chunks, full-text search, fallback retrieval and index retention.

`LiteratureReader` accepts immutable document references and an `authorize` callback. Authorization runs before every cache lookup and returns a lazy text extractor. The caller owns session selection, immutable-version authority, leases and PDF extraction. Search results preserve every binding even when bindings share extracted content.

The index is optional: without it, reading and bounded lexical retrieval work without persistence.

`LiteratureIndex` coordinates search, overlapping-result filtering, access batching and maintenance
lifetimes through a typed `LiteratureIndexStore`. The consumer supplies an initialized index handle,
ranked search candidates and optional maintenance admission. It owns the search backend, persistence,
schema/migrations, retention policy and connection cleanup. No SQL, table names or serialized fields
cross the package interface. Reuse one coordinator per shared index; failed opening must release any
partially acquired resources. `test/memory-index.ts` exercises the package without a database.

Open Science supplies a SQLite FTS5 adapter in the host, including BM25 ranking, the existing sidecar
schema and disk reclamation. Those implementation details are neither imported nor exported here.

The index schema is unchanged. Callers may supply `extractionFingerprint(reference)` to identify every extraction-affecting option. In-memory extraction caches and persistent search indexes use both the document checksum and that fingerprint. Cursor continuations additionally bind the document binding and extraction identity; a cursor from another strategy, source version, or the previous serialization is rejected with instructions to restart reading. Cached data remains disposable; an absent, expired or unavailable index falls back to bounded retrieval.

The Open-Science host preserves native PDF text order by default. Its `read_document` tool applies only desktop-confirmed, table-free two-column body regions captured in the current message snapshot. Each region is `{ page, left, top, right, bottom, split }`: a physical one-based page and normalized coordinates in the unrotated CropBox, measured from its top-left corner. The host orders text inside each region from top to bottom in the left column, then the right. It keeps other text in native order. Regions must not overlap, cut text, or select runs interleaved with outside content; unsafe requests fail with `PDF_READING_REGION_INVALID` instead of silently guessing. This is an opt-in reading strategy, not automatic layout detection or table extraction. Desktop-confirmed regions are captured with the message and automatically reused for reading, searching, and cursor continuation. Each linked PDF uses its own snapshot selection, including searches across multiple PDFs. The response's `reading` metadata records the applied strategy and regions. In the desktop preview, link a multi-page PDF for reading, choose **Set two-column body**, drag across both body columns, adjust the divider, and save. Redrawing replaces the selection on that page; up to 32 unrotated pages can be configured. Clear the page selection to restore native order there. Draft selections are scoped to the current conversation branch and are not restored after restart; sent messages retain their immutable selection snapshot. Existing screenshot annotations keep their own behavior.

`npm test` builds, checks consumer types and runs database-independent behavior tests. `npm run check:packages -- --packages=literature-reading` from the repository builds and tests an isolated copy, packs it, and verifies a clean production consumer.

Unit tests import this package's source entrypoints so coverage measures the code they execute. Packed-consumer checks import the package name and its public exports from a clean production install.
