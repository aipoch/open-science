# @aipoch/literature-discovery

Reference resolution, metadata review/commit, full-text acquisition and resumable batch jobs.
The package owns provider parsing, identifiers, candidate/review lifetimes, retries, progress,
checkpoint versions and recovery decisions. It does not import application sources or Prisma.

- `.`: resolver, metadata enricher, full-text finder, batch jobs and capability types.
- `/contracts`: browser-safe discovery schemas and result-schema factories for a caller's reference view.
- `/jobs`: browser-safe batch commands, results and progress.
- `/download`: public-HTTPS download validation and an optional caller-supplied proxy tunnel.
- `/checkpoints`: batch journal construction with an explicit durable storage capability.

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
