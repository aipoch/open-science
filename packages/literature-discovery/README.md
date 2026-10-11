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
Do not silently discard an unknown newer journal. Call `close()` before releasing host resources.

Reference snapshots validate the fields discovery reads and preserve caller-owned extension data.
Application transports can use the result-schema factories with stricter reference schemas.
No state/schema changes are required: batch indexes v1/v2/v3 remain readable and writes use v3.

Run `npm run build` and `npm test` inside this package. The repository's isolation check packs the
package, installs its declared sibling tarball and validates consumption outside the checkout.
