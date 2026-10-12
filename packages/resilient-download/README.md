# @aipoch/resilient-download

Verified HTTP downloads for Node >=22.13.0, with Range/If-Range resume, retry,
stall detection, SHA-256 verification and progress. Uses only Node built-ins.

```ts
import { resilientDownload, DownloadSourceError } from '@aipoch/resilient-download'

await resilientDownload(url, destination, {
  expectedSha256: trustedManifest.sha256,
  expectedSize: trustedManifest.size,
  expectedOrigin: new URL(url).origin,
  signal,
  onProgress: (progress) => console.log(progress.transferred, progress.bytesPerSecond)
})
```

The caller authorizes the URL and destination, creates its parent directory, and
exclusively owns the destination, `<destination>.part` and `<destination>.part.meta`
until the returned Promise settles. Different destinations can download concurrently.
There is no global queue or cross-process lock. Relative paths use Node's current directory.

Options: `expectedSha256` (lowercase hex), `expectedSize`, `expectedOrigin`, `maxRetries`
(default 5), `stallTimeoutMs` (default 60000), `signal`, `onProgress`, and `fetchImpl`
(default global fetch). Inject a fetch implementation for host proxy/network policy;
it must honor AbortSignal to stop requests and response streams, including bodies rejected
before consumption. `expectedOrigin` checks the final response URL; the caller still owns
redirect/network authorization. Progress callbacks should not throw.

The result is the destination path after verified publication. The package preserves
version-1 resume metadata: hashed request URL, representation validator and optional expected
size. A valid sidecar and strong ETag or Last-Modified allow guarded resume. Historical
partials lacking valid metadata restart safely. Short known-size bodies retry; without an
expected size or Content-Length, silent truncation cannot be detected. Metadata and bytes
are verified before final rename. File publication does not promise fsync crash durability.

`DownloadSourceError` identifies remote transport/representation failure and is the only
error category a mirror adapter should use to try another source. `DownloadChecksumError`
extends it. Storage errors and caller cancellation retain their original identity and must
not trigger source failover. Checksum/response-integrity failures remove unsafe partials;
transport exhaustion and cancellation can retain resumable partials. The caller owns cleanup
of abandoned destinations and may choose a stricter restart policy.

`SpeedMeter` accepts optional `{windowMs, now}` and exposes `record(cumulativeBytes)`,
`bytesPerSecond()` and `etaSeconds(totalBytes?)`. `DownloadProgress`, `DownloadPhase` and
`ResilientDownloadOpts` are public types. Progress phases remain `downloading` and
`reconnecting`; display, translation and task scheduling belong to the caller.

CommonJS `require` and ESM `import` consume the same module and error constructors.
Only the package root is exported. Filesystem and clock fault-injection seams in the
implementation are private, not supported storage adapter APIs.

Run `npm run build`, `npm run typecheck`, and `npm test` inside this directory.
Tests own their configuration, use isolated per-case files/maps, and run on Windows,
macOS and Linux. The repository's `npm run check:packages -- --packages=resilient-download`
installs declared dependencies in a clean source copy, packs it, deletes that copy,
and checks types, private export rejection, identity and real HTTP/resume/cancel behavior
from a separate installed consumer after pruning development dependencies.
