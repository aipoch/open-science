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

The Open-Science host resolves PDF reading order automatically from complete logical structure or page layout. Ambiguous layouts retain native order. Reading, search and cursor continuation use the same extraction strategy; historical manual body-region selections are ignored. The response reports `reading.order` as `automatic`. This does not establish correct table, figure or equation interpretation.

`npm test` builds, checks consumer types and runs database-independent behavior tests. `npm run check:packages -- --packages=literature-reading` from the repository builds and tests an isolated copy, packs it, and verifies a clean production consumer.

Unit tests import this package's source entrypoints so coverage measures the code they execute. Packed-consumer checks import the package name and its public exports from a clean production install.

## Extraction coverage and host OCR

`TextExtraction.coverage` is optional `PdfTextCoverage` metadata, also returned on read and search
documents. Its arrays contain physical, one-based page numbers:

- `textPages`: pages containing native selectable text, including numeric labels.
- `ocrPages`: pages with recognized OCR text. These can overlap `textPages` when a numeric label
  precedes an OCR supplement; count their union when reporting pages with text.
- `unavailablePages`: pages without recovered body text, including blank pages and unsuccessful or
  budget-limited OCR attempts.
- `uncheckedPages`: pages omitted from the returned text because the output budget had no room for
  further page content. The current page may already have been inspected before this decision.
- `unverifiedPages` (optional): pages with raster or vector content requiring source verification.

When coverage is supplied, classification requires positive coverage of every valid physical page,
no missing, unchecked or visually unverified pages, and no text truncation before it can use
full-text evidence. Empty extraction produces unavailable evidence. Coverage describes extraction;
it does not verify equations, tables, reading order or scientific completeness.

The Open-Science host supplies Tesseract.js with bundled English and Simplified Chinese models.
No separate Tesseract application is required, and recognition does not download models or create
image/model caches. Automatic OCR is limited to pages with PDF drawing operations but no selectable
text, or raster pages whose only selectable text is an ASCII decimal label. Readable native prose
is preserved. An empty operator list skips OCR; this is not visual blank-page detection. Numeric labels are retained before a tagged
`[OCR]` supplement. The package itself owns neither OCR workers nor image policy.

The host permits at most 12 OCR attempts per extraction and caps the rendered image's longest edge
at 2400 pixels. Rendering, encoding and recognition share a 45-second page waiting deadline;
additional OCR admission shares a 120-second session budget. These are admission/waiting limits,
not a hard total extraction deadline: synchronous parsing and native image encoding cannot be
preempted. Pending renders are cancelled and the owned worker is terminated on expiration.

Results with unavailable or unchecked pages remain in the bounded extraction cache for
continuation/search. A fresh document read without a cursor retries those incomplete results under
the same budgets; it does not guarantee progress past previously budget-limited pages.
Index/cursor identity includes actual text, so changed text rejects stale cursors, while a
coverage-only update preserves an otherwise identical-text cursor. Each read, search or
classification request rechecks source authority, including cache hits. The existing Literature
card retains coverage, OCR and source verification reminders even when the full passage result
is truncated.
