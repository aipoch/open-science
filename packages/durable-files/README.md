# @aipoch/durable-files

Node file publication and JSON recovery primitives. Requires Node >=22.13.0; no runtime dependencies.

```ts
import { readDurableJsonFile, writeDurableJsonFile } from '@aipoch/durable-files'

await writeDurableJsonFile(path, `${JSON.stringify(document)}\n`)
const result = await readDurableJsonFile(path, JSON.parse, {}, { maxBytes: 1024 * 1024 })
if (result.status === 'found') console.log(result.value)
```

The caller authorizes paths, chooses directories, serializes/decodes documents and owns business
versions, transactions and cancellation. Writing accepts a UTF-8 string; it does not validate JSON.
No application paths, schema migrations, IPC, Electron or browser runtime are included.

## Guarantees and limits

- Writes exclusively create a private (`wx`, `0600`) PID+UUID temp, flush it, rename with bounded
  EPERM/EACCES/EBUSY retries, then flush the directory. Failure cleanup never deletes a temp whose
  exclusive creation failed with EEXIST. A directory-flush failure can occur after publication;
  rejection does not imply the previous destination is still present.
- Reads keep a committed primary authoritative, including when its decoder fails. Only a missing
  primary permits temporary recovery. An unsupported authoritative document should be rejected by
  the caller's decoder with `DurableJsonRecoveryBarrierError`; it blocks promotion and cleanup of
  all recognized recovery candidates. Ordinary invalid JSON candidates may be skipped.
- `maxBytes` is enforced before and during reads, with bounded UTF-8 scratch buffers.
  `readFileWithinLimit` exposes the same bounded read without recovery.
- Legacy timestamp/sequence and PID-only temps remain recoverable. Current PID+UUID temps belonging
  to a live process are preserved. PID checks are not ownership locks or cross-process coordination.
- Reads/writes serialize by the exact path string within one loaded package instance. Different
  strings (including relative/absolute, case or symlink aliases), workers and processes have separate
  coordination. Read/modify/write sequences need a caller-owned transaction lock.
- CommonJS `require` and ESM named imports resolve the same CommonJS implementation, queue and error
  classes. Install one compatible package instance across participating owners. Independently
  installed versions or bundled copies do not share state.
- Ordinary files use write-capable fsync handles. Directory flushes are strict on POSIX; Windows
  ignores only EISDIR/EPERM/EINVAL/ENOTSUP for directory barriers. This cannot guarantee persistence
  beyond the filesystem/device's own durability guarantees.

`recoverDurableJsonDirectory` recovers recognized missing `.json` targets. The caller's decoder
receives the target path. `isRecoverableDurableJsonTemporaryFile` classifies a suffix for callers
that already checked the basename prefix and `.tmp` extension, as directory recovery does.

`createFileDurability` and `defaultFileDurability` expose file/directory barriers;
`retryFileReplacement` provides the bounded replacement policy. `FileDurability` and
`DurableJsonFileDependencies` describe supported I/O injection. No queue or mutable internal state
is exported, and private paths are blocked by package exports.

## Development

Run `npm install`, `npm run build`, `npm run typecheck`, and `npm test` in this package. The package
owns its Vitest configuration and temporary fixtures. `npm pack` builds the distributable. The
repository's `npm run check:packages -- --packages=durable-files` also verifies clean-source build,
real tarball installation, public types, private-import rejection and runtime behavior after the
source copy and consumer development dependencies are removed. This package ships with the app;
it does not require a separate publishing pipeline.
