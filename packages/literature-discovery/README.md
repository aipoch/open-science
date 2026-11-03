# @aipoch/literature-discovery

Reference resolution, metadata review/commit, full-text acquisition and resumable batch jobs.
The package owns provider parsing, identifiers, candidate/review lifetimes, retries, progress,
checkpoint versions and recovery decisions. It does not import application sources or Prisma.

- `.`: resolver, metadata enricher, full-text finder, batch jobs and capability types.
- `/contracts`: browser-safe discovery schemas and result-schema factories for a caller's reference view.
- `/jobs`: browser-safe batch commands, results and progress.
- `/download`: public-HTTPS download validation and an optional caller-supplied proxy tunnel.
- `/checkpoints`: batch journal construction with an explicit durable storage capability.

For proxied downloads, uniform IPv4 Fake-IP answers in `198.18.0.0/15` use the hostname
instead of a pinned IP. The configured proxy then owns DNS resolution and final-address
access restrictions; the downloader cannot verify that the proxy's destination is public.
TLS still verifies the publisher hostname. Mixed answers and direct Fake-IP connections
remain blocked. The host's SOCKS4 adapter requires numeric IPv4 destinations and does not
support this hostname fallback; use HTTP, HTTPS or SOCKS5 for remote resolution.

Provide catalog reads/atomic commits, atomic content publication, PDF inspection, credentials and
network transport. Batch jobs require durable checkpoint storage, write admission and oversized
result error translation. Checkpoint storage must atomically publish writes, preserve recovery
barriers and recover interrupted replacements; the package decides journal versions and epochs.
The journal uses the injected capability for durable reads/writes and recovery, but directly
uses `node:fs/promises` for directory creation, enumeration and cleanup (`mkdir`, `readdir`, `rm`).
The checkpoint capability is not a complete virtual filesystem.
Do not silently discard an unknown newer journal. Call `close()` before releasing host resources.

Reference snapshots validate the fields discovery reads and preserve caller-owned extension data.
Application transports can use the result-schema factories with stricter reference schemas.
No state/schema changes are required: batch indexes v1/v2/v3 remain readable and writes use v3.

Run `npm run build` and `npm test` inside this package. The repository's isolation check packs the
package, installs its declared sibling tarball and validates consumption outside the checkout.

## Identifier lookup

`LiteratureReferenceResolver.lookup()` accepts `doi:`, `pmid:`, `pmcid:PMC…`, and `arxiv:`
references. PMCID lookup queries Europe PMC and accepts only an exact PMCID match, retaining
any returned DOI and PubMed ID. PubMed ID lookup uses NCBI EFetch with Europe PMC fallback.
Crossref metadata must carry the requested DOI; an absent or mismatched DOI cannot supply metadata.
An independently identified fallback can still satisfy the lookup.

arXiv and PubMed reads share one admission implementation, with independent process-local quotas
across resolver instances and transports. Monotonic request starts remain at least three seconds
apart for arXiv ([API usage limits](https://info.arxiv.org/help/api/tou.html#rate-limits)) and
334 milliseconds apart for PubMed's unauthenticated E-utilities
([NCBI usage policy](https://www.ncbi.nlm.nih.gov/books/NBK25497/)). Reads wait for the previous
response body from the same provider to finish. Cancellation skips queued work without reserving
another slot; provider errors do not block later requests or trigger automatic retries. PubMed
batch resolution still groups IDs into a single EFetch request. These quotas cannot coordinate
other application processes or machines sharing the same IP address.

All requests use fixed provider origins, bounded responses and timeouts; caller-supplied article
URLs are normalized by the application before they reach the resolver.

## Single-paper citation discovery

`LiteratureRelatedFinder` resolves an existing catalog reference through the Semantic Scholar
Graph API and pages its references or citing papers. A title-only match requires explicit caller
confirmation using an expiring, reference-bound token. The host injects the catalog, transport,
and optional API-key reader; the finder never writes catalog records. UI selections use the
existing Library candidate-review workflow. Provider full names remain literal creator names.

Requests use a fixed HTTPS origin, a shared one-request-per-second admission schedule, bounded
responses and timeouts. HTTP 429 respects a capped Retry-After cooldown. Resolution tokens are
bounded in memory and expire after 15 minutes. Relationship pages contain at most 20 records and each next offset must advance. Returned content is attributed to Semantic
Scholar; upstream coverage and content rights still apply. See the official
[Graph API documentation](https://api.semanticscholar.org/api-docs/graph) and
[API license](https://www.semanticscholar.org/product/api/license).

## Manual publication checks

`LiteraturePublicationChecker` checks an existing reference's exact, unambiguous DOI.
`get` restores a saved result without making a network request; `check` explicitly queries
Crossref's fixed HTTPS `/works/{doi}` endpoint. The `updated-by` reverse edges identify
notices about that work. `update-to` points in the opposite direction and is not used.
See [Crossref's production API guidance](https://www.crossref.org/labs/retraction-watch/).

Results preserve each notice's DOI, raw type, source and available full date, including self
updates, unknown types and reinstatement notices. They are observations of source metadata,
not an inferred integrity verdict: an empty result does not prove that a work is unaffected.
Crossref/Retraction Watch coverage, especially for corrections, concerns and reinstatements,
is incomplete. The host must atomically recheck active item identity, metadata revision and
DOI when saving a snapshot. A failed check never replaces the previous successful snapshot.
Network responses are limited to 2 MiB and 100 notices, with a 15-second deadline and capped
429 cooldown. Checks do not modify bibliographic metadata or screening decisions.
