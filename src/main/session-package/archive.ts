import { createReadStream, createWriteStream, type ReadStream } from 'node:fs'
import { lstat, mkdir, open, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { finished, pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { Header, Pax, Parser } from 'tar'
import {
  PACKAGE_MAX_BYTES,
  PACKAGE_MAX_FILE_BYTES,
  sessionPackageManifestSchema,
  type SessionPackageManifest
} from '../../shared/session-package'
import { readFileWithinLimit } from '../storage/durable-json-file'
import { resolveStorageKey } from '../artifacts/provenance-storage'
import { digestFileWithinBudget } from '../bounded-file-io'
import { pacedFileTransform } from '../file-io-pacing'
import { assertPackageCapacity, packageCapacityChecker } from './capacity'

export const PACKAGE_MAX_JSON_BYTES = 256 * 1024 ** 2
const MAX_MANIFEST_BYTES = 8 * 1024 ** 2
const MAX_ENTRIES = 10004
const ENTRY_PATH = /^(manifest\.json|session\.json|records\.json|README\.md|objects\/[a-f0-9]{64})$/

// The configured root may itself use a platform alias (/var -> /private/var). Below that owned
// root, reject links at every level so a Notebook directory cannot include unrelated local data.
export const assertPackageSourcePath = async (root: string, key: string): Promise<void> => {
  resolveStorageKey(root, key)
  const segments = key.split('/')
  for (let length = 1; length <= segments.length; length++) {
    const info = await lstat(join(root, ...segments.slice(0, length)))
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
      throw new Error('Session package source contains a link or special file.')
  }
}

export const fileChecksum = async (path: string, signal?: AbortSignal): Promise<string> =>
  (await digestFileWithinBudget(path, PACKAGE_MAX_BYTES, signal)).checksum

export const readPackageJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFileWithinLimit(path, PACKAGE_MAX_JSON_BYTES)) as unknown

export const writePackageArchive = async (
  directory: string,
  path: string,
  signal?: AbortSignal
): Promise<void> => {
  const manifest = sessionPackageManifestSchema.parse(
    await readPackageJson(join(directory, 'manifest.json'))
  )
  const entries = [
    { path: 'manifest.json', sizeBytes: (await stat(join(directory, 'manifest.json'))).size },
    ...manifest.inventory
  ]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((entry) => {
      const header = new Header({
        path: entry.path,
        type: 'File',
        size: entry.sizeBytes,
        mode: 0o644
      })
      const block = Buffer.alloc(512)
      const pax = header.encode(block)
        ? new Pax({ path: entry.path, size: entry.sizeBytes }).encode()!
        : Buffer.alloc(0)
      return { ...entry, header: Buffer.concat([pax, block]) }
    })
  const tarBytes = entries.reduce(
    (sum, entry) => sum + entry.header.length + Math.ceil(entry.sizeBytes / 512) * 512,
    1024
  )
  // zlib deflateBound for windowBits=15, memLevel=8 and an 18-byte gzip wrapper.
  // Use division, not JS's 32-bit shifts: packages can exceed 4 GiB.
  // https://github.com/madler/zlib/blob/v1.3.1/deflate.c#L827-L830
  const archiveBound =
    tarBytes +
    Math.floor(tarBytes / 4096) +
    Math.floor(tarBytes / 16384) +
    Math.floor(tarBytes / 33554432) +
    25
  await assertPackageCapacity(dirname(path), archiveBound)
  let source: ReadStream | undefined
  try {
    await pipeline(
      // tar.Pack does not close its child file readers when destroyed. Own the Node reader,
      // retaining tar's Header/PAX encoders for the fixed, manifest-owned regular files.
      async function* ({ signal: streamSignal } = { signal }): AsyncGenerator<Buffer> {
        for (const entry of entries) {
          streamSignal?.throwIfAborted()
          const file = join(directory, entry.path)
          const metadata = await lstat(file)
          streamSignal?.throwIfAborted()
          if (!metadata.isFile() || metadata.size !== entry.sizeBytes)
            throw new Error('Invalid or changed package source file.')
          yield entry.header
          source = createReadStream(file, { signal: streamSignal, highWaterMark: 64 * 1024 })
          let bytes = 0
          for await (const chunk of source) {
            bytes += chunk.byteLength
            if (bytes > metadata.size)
              throw new Error('Package source file changed during compression.')
            yield chunk
          }
          if (bytes !== metadata.size)
            throw new Error('Package source file changed during compression.')
          const padding = (512 - (bytes % 512)) % 512
          if (padding) yield Buffer.alloc(padding)
        }
        yield Buffer.alloc(1024)
      },
      pacedFileTransform(signal),
      // Asynchronous zlib work keeps compression off the main event loop.
      createGzip({ level: 1, windowBits: 15, memLevel: 8 }),
      pacedFileTransform(signal),
      createWriteStream(path, { flags: 'wx' }),
      { signal }
    )
  } finally {
    // A pipeline failure can settle before an in-flight filesystem read closes. Await that
    // close before its caller removes staging files or releases the source Session.
    if (source) {
      source.destroy()
      await finished(source, { cleanup: true }).catch(() => undefined)
    }
  }
  if ((await stat(path)).size > PACKAGE_MAX_BYTES)
    throw new Error('Session package exceeds the archive limit.')
}

// Extraction only creates fixed ASCII names in a freshly allocated private directory. Source
// filenames and storage paths never become tar entry names. Validate the complete manifest before
// publishing any Project, Session or file authority.
export const readPackageArchive = async (
  path: string,
  directory: string,
  signal?: AbortSignal
): Promise<SessionPackageManifest> => {
  const input = await open(path, 'r')
  try {
    const metadata = await input.stat()
    if (!metadata.isFile() || metadata.size > PACKAGE_MAX_BYTES)
      throw new Error('Session package exceeds the archive limit.')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const checkCapacity = await packageCapacityChecker(directory)
    const entries = new Set<string>()
    let total = 0
    let invalid: Error | undefined
    const controller = new AbortController()
    const abort = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    let writes = Promise.resolve()
    const extractor = new Parser({
      strict: true,
      maxMetaEntrySize: MAX_MANIFEST_BYTES,
      filter: (name, entry) => {
        const type = 'type' in entry ? entry.type : undefined
        const isDirectory = name === 'objects/' && type === 'Directory'
        const limit =
          name === 'manifest.json'
            ? MAX_MANIFEST_BYTES
            : name.endsWith('.json')
              ? PACKAGE_MAX_JSON_BYTES
              : PACKAGE_MAX_FILE_BYTES
        total += entry.size
        if (
          entries.has(name) ||
          entries.size >= MAX_ENTRIES ||
          (!isDirectory && (type !== 'File' || !ENTRY_PATH.test(name))) ||
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0 ||
          entry.size > limit ||
          total > PACKAGE_MAX_BYTES
        ) {
          invalid = new Error('Session package contains an unsafe, duplicate or oversized entry.')
          controller.abort(invalid)
          return false
        }
        try {
          checkCapacity(total)
        } catch (error) {
          invalid = error as Error
          controller.abort(invalid)
          return false
        }
        entries.add(name)
        return true
      },
      onReadEntry: (entry) => {
        // Keep filesystem ownership outside tar.Unpack, whose asynchronous child writes can
        // outlive parser cancellation. The chain also bounds writes for many empty entries.
        writes = writes
          .then(async () => {
            controller.signal.throwIfAborted()
            const file = join(directory, entry.path)
            if (entry.type === 'Directory') {
              await mkdir(file, { recursive: true, mode: 0o700 })
              entry.resume()
              return
            }
            await mkdir(dirname(file), { recursive: true, mode: 0o700 })
            controller.signal.throwIfAborted()
            await pipeline(
              entry as unknown as NodeJS.ReadableStream,
              pacedFileTransform(controller.signal),
              createWriteStream(file, { flags: 'wx', mode: 0o600 }),
              { signal: controller.signal }
            )
          })
          .catch((error: Error) => {
            invalid ??= error
            controller.abort(error)
          })
      }
    })
    try {
      await pipeline(
        input.createReadStream({ highWaterMark: 16 * 1024 }),
        pacedFileTransform(controller.signal),
        extractor as unknown as NodeJS.WritableStream,
        {
          signal: controller.signal
        }
      )
      await writes
      if (invalid) throw invalid
    } catch (error) {
      invalid ??= error as Error
      controller.abort(invalid)
      await writes
      throw invalid
    } finally {
      signal?.removeEventListener('abort', abort)
    }
    return await validatePackageDirectory(directory, signal, entries)
  } finally {
    await input.close()
  }
}

export const validatePackageDirectory = async (
  directory: string,
  signal?: AbortSignal,
  entries?: Set<string>
): Promise<SessionPackageManifest> => {
  const manifest = sessionPackageManifestSchema.parse(
    JSON.parse(await readFileWithinLimit(join(directory, 'manifest.json'), MAX_MANIFEST_BYTES))
  )
  const declared = new Set(['manifest.json', 'objects/'])
  for (const entry of manifest.inventory) {
    if (declared.has(entry.path))
      throw new Error('Session package inventory contains duplicate entries.')
    declared.add(entry.path)
    const file = join(directory, entry.path)
    await assertPackageSourcePath(directory, entry.path)
    const details = await lstat(file)
    if (
      !details.isFile() ||
      details.size !== entry.sizeBytes ||
      (await fileChecksum(file, signal)) !== entry.checksum
    ) {
      throw new Error('Session package content checksum or size mismatch.')
    }
  }
  if (
    !declared.has('session.json') ||
    !declared.has('records.json') ||
    !declared.has('README.md') ||
    (entries && [...entries].some((name) => !declared.has(name)))
  ) {
    throw new Error('Session package inventory is incomplete.')
  }
  return manifest
}

export const packageEntry = async (
  directory: string,
  path: string,
  kind: SessionPackageManifest['inventory'][number]['kind'],
  signal?: AbortSignal
): Promise<SessionPackageManifest['inventory'][number]> => ({
  path,
  kind,
  sizeBytes: (await stat(join(directory, path))).size,
  checksum: await fileChecksum(join(directory, path), signal)
})
