import { compress, decompress, init as initZstd } from '@bokuweb/zstd-wasm'
import { c as createTar, x as extractTar, type ReadEntry, type Unpack } from 'tar'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createZstdDecompress } from 'node:zlib'

let zstdReady: Promise<void> | undefined

const ensureZstd = (): Promise<void> => {
  zstdReady ??= initZstd()
  return zstdReady
}

const assertSafeEntry = (entry: ReadEntry): void => {
  const path = entry.path.replaceAll('\\', '/')
  const segments = path.split('/')
  if (
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    segments.includes('..') ||
    !['File', 'Directory'].includes(entry.type)
  ) {
    throw new Error(`unsafe runtime pack entry: ${entry.path}`)
  }
}

const tarDirectory = async (sourceDir: string): Promise<Buffer> => {
  const stream = createTar({ cwd: sourceDir, portable: true }, ['.'])
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

// Builds a strict tar extractor that rejects unsafe entries. Throwing from the filter would escape
// tar's stream machinery as an uncaught exception, so the error is retained and re-thrown by the
// caller after the stream closes. Inlined per call site (not returned) so `extractor` keeps tar's
// concrete Unpack type instead of the extractTar overload union.
const buildExtractor = (destDir: string, onUnsafe: (error: Error) => void): Unpack =>
  extractTar({
    cwd: destDir,
    preservePaths: false,
    strict: true,
    filter: (_path, entry) => {
      try {
        assertSafeEntry(entry as ReadEntry)
        return true
      } catch (error) {
        onUnsafe(error instanceof Error ? error : new Error(String(error)))
        return false
      }
    }
  })

// Streaming decode: read -> native zstd decompress -> tar extractor. Nothing ever holds the whole
// compressed file or the whole decompressed tar in memory (the R pack is ~345 MB compressed, and the
// buffered path below would keep compressed + decompressed + a tar copy resident, spiking the Electron
// main process past ~1 GB RSS). Keeps memory flat regardless of pack size.
const untarStream = async (archivePath: string, destDir: string): Promise<void> => {
  await mkdir(destDir, { recursive: true })
  let unsafeEntry: Error | undefined
  const extractor = buildExtractor(destDir, (error) => {
    unsafeEntry = error
  })
  // node:stream/promises.pipeline propagates any stream error AND destroys the whole chain (source,
  // decompressor, extractor). So a decode/extract failure releases the archive file handle — avoiding a
  // Windows EPERM on the caller's `finally rm` of the staging dir — and never leaves a half-open stream
  // or masks the original error behind a cleanup failure. (Cast: tar's Unpack is a Minipass stream that
  // is pipe-compatible at runtime but not typed as NodeJS.WritableStream.)
  await pipeline(
    createReadStream(archivePath),
    createZstdDecompress(),
    extractor as unknown as NodeJS.WritableStream
  )
  if (unsafeEntry) throw unsafeEntry
}

// Fallback for a runtime whose Node lacks native zstd streaming (node:zlib createZstdDecompress).
// Decodes in memory via the wasm codec — correct but memory-heavy, so only used when streaming is
// unavailable.
const untarBuffer = async (tarBytes: Uint8Array, destDir: string): Promise<void> => {
  await mkdir(destDir, { recursive: true })
  let unsafeEntry: Error | undefined
  const extractor = buildExtractor(destDir, (error) => {
    unsafeEntry = error
  })
  await new Promise<void>((resolve, reject) => {
    extractor.once('error', reject)
    extractor.once('close', resolve)
    extractor.end(Buffer.from(tarBytes))
  })
  if (unsafeEntry) throw unsafeEntry
}

// The pack codec is intentionally independent of the host's tar/zstd binaries. The same archive
// shape is used by staging and by the packaged app: a tar stream compressed with zstd.
export const createPackArchive = async (sourceDir: string, archivePath: string): Promise<void> => {
  await ensureZstd()
  const tarBytes = await tarDirectory(sourceDir)
  await writeFile(archivePath, Buffer.from(compress(tarBytes, 10)))
}

export const extractPackArchive = async (archivePath: string, destDir: string): Promise<void> => {
  // Prefer native streaming zstd (Electron's Node ≥22.15 has it); fall back to the in-memory wasm codec
  // only where it is unavailable, so a large pack never OOMs the main process on the common path.
  if (typeof createZstdDecompress === 'function') {
    await untarStream(archivePath, destDir)
    return
  }
  await ensureZstd()
  await untarBuffer(decompress(await readFile(archivePath)), destDir)
}

export type PackArchiveDeps = {
  extract?: (archivePath: string, destDir: string) => Promise<void>
}

export const extractPackArchiveWithDeps = (
  archivePath: string,
  destDir: string,
  deps: PackArchiveDeps = {}
): Promise<void> => (deps.extract ?? extractPackArchive)(archivePath, destDir)
