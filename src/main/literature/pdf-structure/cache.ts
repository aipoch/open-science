import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readdir, rename, rmdir, unlink, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { readFileWithinLimit } from '../../storage/durable-json-file'
import { defaultFileDurability } from '../../storage/file-durability'
import {
  parsePdfStructureResult,
  type PdfStructureIdentity,
  type PdfStructureResult
} from './result'

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024
const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024
const MAX_ENTRY_BYTES = 64 * 1024 * 1024
const DEFAULT_CACHE_BYTES = 1024 * 1024 * 1024
const HASH = /^[a-f0-9]{64}$/
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex')

export type PdfStructureCacheKey = Omit<PdfStructureIdentity, 'extractionId'>
export type PdfStructureCacheClearResult = {
  removedBytes: number
  retained: Array<{ entry: string; reason: string }>
}
type Entry = {
  path: string
  result: PdfStructureResult
  files: Array<{ path: string; size: number }>
  bytes: number
  lastUsedAt: number
  damaged: boolean
}
const keyParts = (key: PdfStructureCacheKey): string[] => {
  if (!HASH.test(key.engineFingerprint) || !HASH.test(key.sourceChecksum))
    throw new Error('Invalid PDF cache key.')
  return [key.engineFingerprint, key.sourceChecksum, sha256(JSON.stringify(key.requestedPages))]
}
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
type Thumbnail = PdfStructureResult['thumbnails'][number]
const validPngHeader = (bytes: Uint8Array, image: Thumbnail): boolean => {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return (
    header.length >= 33 &&
    header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
    header.readUInt32BE(8) === 13 &&
    header.toString('ascii', 12, 16) === 'IHDR' &&
    image.width <= 2400 &&
    image.height <= 2400 &&
    header.readUInt32BE(16) === image.width &&
    header.readUInt32BE(20) === image.height
  )
}
const validPng = async (bytes: Uint8Array, image: Thumbnail): Promise<boolean> => {
  if (!validPngHeader(bytes, image)) return false
  const { default: sharp } = await import('sharp')
  try {
    const { info } = await sharp(bytes, { limitInputPixels: 2400 * 2400, failOn: 'warning' })
      .raw()
      .toBuffer({ resolveWithObject: true })
    return info.width === image.width && info.height === image.height
  } catch {
    return false
  }
}
const readThumbnail = async (
  path: string,
  image: Thumbnail,
  keepBytes = false
): Promise<Buffer | undefined> => {
  const hash = createHash('sha256')
  let size = 0
  let header = Buffer.alloc(0)
  const chunks: Buffer[] = []
  for await (const chunk of createReadStream(path)) {
    size += chunk.length
    if (size > image.sizeBytes || size > MAX_THUMBNAIL_BYTES) return undefined
    if (header.length < 33) header = Buffer.concat([header, chunk.subarray(0, 33 - header.length)])
    chunks.push(chunk)
    hash.update(chunk)
  }
  if (
    size !== image.sizeBytes ||
    hash.digest('hex') !== image.sha256 ||
    !validPngHeader(header, image)
  )
    return undefined
  const bytes = Buffer.concat(chunks)
  if (!(await validPng(bytes, image))) return undefined
  return keepBytes ? bytes : header
}

// Internal file owner. Its caller holds a data-root writer (or the running job's model use) for
// every operation. No source access grants are stored here. One instance per structure service.
export class PdfStructureCache {
  private tail = Promise.resolve()
  private readonly maxBytes: number

  constructor(private readonly options: { dataRoot(): string; maxBytes?: number }) {
    this.maxBytes = options.maxBytes ?? DEFAULT_CACHE_BYTES
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0)
      throw new Error('Invalid PDF cache capacity.')
  }

  // ponytail: serialize bounded cache I/O; use per-entry read leases only if measured contention
  // warrants it. The structure owner already limits expensive extraction to one worker.
  private operation<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async directory(parts: string[], create = false): Promise<string | undefined> {
    let path = this.options.dataRoot()
    for (const part of ['pdf-structure', 'v1', ...parts]) {
      path = join(path, part)
      if (create)
        await mkdir(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error
        })
      const info = await lstat(path).catch((error) => {
        if (missing(error)) return undefined
        throw error
      })
      if (!info) return undefined
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('Unsafe PDF cache directory.')
    }
    return path
  }

  private async inspect(path: string, expected?: PdfStructureCacheKey): Promise<Entry> {
    const rootInfo = await lstat(path)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
      throw new Error('Unsafe PDF cache entry.')
    const manifestPath = join(path, 'structure.json')
    const manifestInfo = await lstat(manifestPath)
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink())
      throw new Error('Unsafe PDF cache manifest.')
    const raw = JSON.parse(await readFileWithinLimit(manifestPath, MAX_MANIFEST_BYTES))
    const result = parsePdfStructureResult(raw, {
      extractionId: raw.extractionId,
      engineFingerprint: expected?.engineFingerprint ?? raw.engineFingerprint,
      sourceChecksum: expected?.sourceChecksum ?? raw.sourceChecksum,
      sourceSizeBytes: expected?.sourceSizeBytes ?? raw.sourceSizeBytes,
      requestedPages: expected?.requestedPages ?? raw.requestedPages
    })
    if (
      manifestInfo.size + result.thumbnails.reduce((sum, image) => sum + image.sizeBytes, 0) >
      MAX_ENTRY_BYTES
    ) {
      throw new Error('PDF cache manifest declares an oversized entry.')
    }
    const files = [{ path: manifestPath, size: manifestInfo.size }]
    const members = await readdir(path)
    if (members.some((name) => name !== 'structure.json' && name !== 'thumbnails')) {
      throw new Error('PDF cache entry contains unrecognized files.')
    }
    let damaged = false
    const thumbnailsPath = join(path, 'thumbnails')
    const thumbnailsInfo = await lstat(thumbnailsPath).catch((error) => {
      if (missing(error)) return undefined
      throw error
    })
    if (thumbnailsInfo && (!thumbnailsInfo.isDirectory() || thumbnailsInfo.isSymbolicLink())) {
      throw new Error('Unsafe PDF cache thumbnails directory.')
    }
    const thumbnails = new Map(result.thumbnails.map((image) => [`${image.id}.png`, image]))
    const names = thumbnailsInfo ? await readdir(thumbnailsPath) : []
    if (names.some((name) => !thumbnails.has(name)))
      throw new Error('PDF cache contains unrecognized thumbnails.')
    for (const [name, image] of thumbnails) {
      if (image.sizeBytes > MAX_THUMBNAIL_BYTES)
        throw new Error('PDF thumbnail exceeds its size limit.')
      if (!names.includes(name)) {
        damaged = true
        continue
      }
      const filePath = join(thumbnailsPath, name)
      const info = await lstat(filePath)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe PDF cache thumbnail.')
      files.push({ path: filePath, size: info.size })
      if (info.size !== image.sizeBytes) {
        damaged = true
        continue
      }
      if (!(await readThumbnail(filePath, image))) damaged = true
    }
    const bytes = files.reduce((total, file) => total + file.size, 0)
    return { path, result, files, bytes, lastUsedAt: rootInfo.mtimeMs, damaged }
  }

  private async pruneParents(path: string): Promise<void> {
    // Only remove empty hash index directories, never recursively or above the entries root.
    const entries = join(this.options.dataRoot(), 'pdf-structure', 'v1', 'entries')
    let parent = dirname(path)
    for (let count = 0; count < 2 && parent !== entries; count++) {
      try {
        await rmdir(parent)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOTEMPTY' || code === 'EEXIST') return
        if (code !== 'ENOENT') throw error
      }
      parent = dirname(parent)
    }
  }

  private async remove(entry: Entry, report: PdfStructureCacheClearResult): Promise<void> {
    try {
      // Recheck the entire bounded inventory before destructive work. Keep the manifest until its
      // declared payload files are gone, allowing a failed removal to be retried safely.
      const current = await this.inspect(entry.path)
      for (const file of [...current.files.slice(1), current.files[0]]) {
        if (file === current.files[0]) {
          await rmdir(join(entry.path, 'thumbnails')).catch((error) => {
            if (!missing(error)) throw error
          })
        }
        await unlink(file.path)
        report.removedBytes += file.size
      }
      await rmdir(entry.path)
      if (
        entry.path ===
        join(this.options.dataRoot(), 'pdf-structure', 'v1', 'entries', ...keyParts(entry.result))
      )
        await this.pruneParents(entry.path)
    } catch (error) {
      report.retained.push({ entry: entry.path, reason: reason(error) })
    }
  }

  private async inventory(): Promise<{
    entries: Entry[]
    retired: Entry[]
    retained: PdfStructureCacheClearResult['retained']
  }> {
    const entries: Entry[] = []
    const retired: Entry[] = []
    const retained: PdfStructureCacheClearResult['retained'] = []
    let visited = 0
    const scan = async (parts: string[], depth: number): Promise<void> => {
      const directory = await this.directory(parts)
      if (!directory) return
      const names = await readdir(directory)
      if (parts[0] === 'entries' && parts.length > 1 && depth > 0 && !names.length) {
        await rmdir(directory)
        return
      }
      if ((visited += names.length) > 8192)
        throw new Error('PDF cache inventory exceeds its entry limit.')
      for (const name of names) {
        const path = join(directory, name)
        try {
          if (parts[0] === 'entries' && !HASH.test(name))
            throw new Error('Unrecognized PDF cache directory.')
          if (depth > 0) await scan([...parts, name], depth - 1)
          else {
            const entry = await this.inspect(path)
            if (parts[0] === 'entries') {
              if (join(...keyParts(entry.result)) !== join(...parts.slice(1), name))
                throw new Error('PDF cache identity does not match its directory.')
              entries.push(entry)
            } else retired.push(entry)
          }
        } catch (error) {
          retained.push({ entry: path, reason: reason(error) })
        }
      }
    }
    await scan(['entries'], 2)
    await scan(['retired'], 0)
    return { entries, retired, retained }
  }

  read(key: PdfStructureCacheKey): Promise<PdfStructureResult | undefined> {
    return this.operation(async () => {
      const path = await this.directory(['entries', ...keyParts(key)])
      if (!path) return undefined
      const entry = await this.inspect(path, key)
      if (entry.damaged) {
        const retired = (await this.directory(['retired'], true))!
        await rename(path, join(retired, randomUUID()))
        await this.pruneParents(path)
        return undefined
      }
      const now = new Date()
      await utimes(path, now, now)
      return entry.result
    })
  }

  readThumbnail(
    key: PdfStructureCacheKey,
    extractionId: string,
    thumbnailId: string
  ): Promise<Buffer | undefined> {
    return this.operation(async () => {
      const path = await this.directory(['entries', ...keyParts(key)])
      if (!path) return undefined
      const entry = await this.inspect(path, key)
      if (entry.damaged || entry.result.extractionId !== extractionId) return undefined
      const image = entry.result.thumbnails.find(({ id }) => id === thumbnailId)
      if (!image) return undefined
      const bytes = await readThumbnail(join(path, 'thumbnails', `${image.id}.png`), image, true)
      if (bytes) {
        const now = new Date()
        await utimes(path, now, now)
      }
      return bytes
    })
  }

  publish(
    result: PdfStructureResult,
    images: ReadonlyMap<string, Uint8Array>,
    signal: AbortSignal
  ): Promise<PdfStructureResult> {
    return this.operation(async () => {
      signal.throwIfAborted()
      const validated = parsePdfStructureResult(result, result)
      const text = JSON.stringify(validated)
      const manifestBytes = Buffer.byteLength(text)
      const bytes =
        manifestBytes + validated.thumbnails.reduce((sum, image) => sum + image.sizeBytes, 0)
      if (manifestBytes > MAX_MANIFEST_BYTES || images.size !== validated.thumbnails.length)
        throw new Error('PDF cache output exceeds its manifest or image inventory limits.')
      if (bytes > MAX_ENTRY_BYTES || bytes > this.maxBytes)
        throw new Error('PDF cache entry exceeds capacity.')
      for (const image of validated.thumbnails) {
        const data = images.get(image.id)
        if (
          !data ||
          data.byteLength !== image.sizeBytes ||
          data.byteLength > MAX_THUMBNAIL_BYTES ||
          sha256(data) !== image.sha256 ||
          !(await validPng(data, image))
        ) {
          throw new Error('PDF thumbnail bytes do not match the manifest.')
        }
      }
      const parts = keyParts(validated)
      const existingPath = await this.directory(['entries', ...parts])
      if (existingPath) {
        const existing = await this.inspect(existingPath, validated)
        if (!existing.damaged) return existing.result
        const retired = (await this.directory(['retired'], true))!
        await rename(existingPath, join(retired, randomUUID()))
        await this.pruneParents(existingPath)
      }
      const inventory = await this.inventory()
      if (inventory.retained.length)
        throw new Error(
          'PDF cache contains unrecognized data; repair is required before publishing.'
        )
      const report: PdfStructureCacheClearResult = { removedBytes: 0, retained: [] }
      for (const entry of inventory.retired) await this.remove(entry, report)
      let total =
        inventory.entries.reduce((sum, entry) => sum + entry.bytes, 0) +
        inventory.retired.reduce((sum, entry) => sum + entry.bytes, 0) -
        report.removedBytes
      for (const entry of inventory.entries.sort(
        (a, b) => a.lastUsedAt - b.lastUsedAt || a.path.localeCompare(b.path)
      )) {
        if (total + bytes <= this.maxBytes) break
        const before = report.removedBytes
        await this.remove(entry, report)
        total -= report.removedBytes - before
      }
      if (report.retained.length || total + bytes > this.maxBytes)
        throw new Error('PDF cache capacity cannot be reclaimed safely.')
      signal.throwIfAborted()
      const stagingRoot = (await this.directory(['staging'], true))!
      const staging = join(stagingRoot, `publish-${randomUUID()}`)
      await mkdir(staging)
      try {
        // The main-only publisher runs after worker teardown. A valid manifest records exactly
        // which files this temporary directory owns, including partially written/missing payloads.
        await writeFile(join(staging, 'structure.json'), text, { flag: 'wx', mode: 0o600 })
        if (validated.thumbnails.length) {
          await mkdir(join(staging, 'thumbnails'))
          for (const image of validated.thumbnails) {
            signal.throwIfAborted()
            const path = join(staging, 'thumbnails', `${image.id}.png`)
            await writeFile(path, images.get(image.id)!, { flag: 'wx', mode: 0o600 })
            await defaultFileDurability.syncFile(path)
          }
          await defaultFileDurability.syncDirectory(join(staging, 'thumbnails'))
        }
        await defaultFileDurability.syncFile(join(staging, 'structure.json'))
        await defaultFileDurability.syncDirectory(staging)
        const staged = await this.inspect(staging, validated)
        if (staged.damaged) throw new Error('Staged PDF cache result is incomplete.')
        const parent = (await this.directory(['entries', ...parts.slice(0, 2)], true))!
        signal.throwIfAborted()
        await rename(staging, join(parent, parts[2]))
        await defaultFileDurability.syncDirectory(parent)
        return validated
      } catch (error) {
        // Never recursively erase an incomplete/unreadable manifest or unexpected extra files.
        const entry = await this.inspect(staging).catch(() => undefined)
        if (entry) await this.remove(entry, { removedBytes: 0, retained: [] })
        throw error
      }
    })
  }

  clear(): Promise<PdfStructureCacheClearResult> {
    return this.operation(async () => {
      const inventory = await this.inventory()
      const report: PdfStructureCacheClearResult = { removedBytes: 0, retained: inventory.retained }
      for (const entry of [...inventory.entries, ...inventory.retired])
        await this.remove(entry, report)
      const staging = await this.directory(['staging'])
      if (staging)
        for (const name of await readdir(staging)) {
          // Worker staging cannot be proven dead by a filename or a valid result. Recovery must
          // establish worker ownership/liveness before removing it; retain it explicitly here.
          report.retained.push({
            entry: join(staging, name),
            reason: 'Staging requires ownership and liveness recovery.'
          })
        }
      return report
    })
  }
}
