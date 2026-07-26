import { open, type FileHandle } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createInflateRaw, inflateRaw } from 'node:zlib'

import { parseSkillDocument } from './frontmatter'
import { SKILL_IMPORT_LIMITS } from './import-limits'
import { selectSkillManifestRoots, skillManifestRootPath } from './skill-bundle-paths'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_MIN_SIZE = 22
const MAX_ZIP_COMMENT_BYTES = 0xffff
const CENTRAL_READ_CHUNK_BYTES = 64 * 1024
const ENTRY_READ_CHUNK_BYTES = 64 * 1024
const MAX_SNIFF_FRONTMATTER_BYTES = SKILL_IMPORT_LIMITS.maxFileBytes
const FRONTMATTER_DELIMITER = Buffer.from('---')

type ArchiveReader = {
  size: number
  read: (position: number, length: number) => Promise<Buffer | undefined>
}

type CentralEntry = {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

type ArchiveScan = {
  accepted: CentralEntry[]
  skippedPaths: string[]
}

type ManifestRootInspection = {
  ownerRoots: string[]
  candidateRoots: string[]
  named: boolean[]
}

type ScanLimits = {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
  maxDepth: number
  strictCaps: boolean
}

const OUTER_SCAN_LIMITS: ScanLimits = {
  maxFiles: SKILL_IMPORT_LIMITS.maxBundleEntries,
  maxFileBytes: SKILL_IMPORT_LIMITS.maxSkillArchiveBytes,
  maxTotalBytes: SKILL_IMPORT_LIMITS.maxBundleBytes,
  maxDepth: SKILL_IMPORT_LIMITS.maxDepth,
  strictCaps: false
}

const INNER_SCAN_LIMITS: ScanLimits = {
  maxFiles: SKILL_IMPORT_LIMITS.maxFiles,
  maxFileBytes: SKILL_IMPORT_LIMITS.maxFileBytes,
  maxTotalBytes: SKILL_IMPORT_LIMITS.maxTotalBytes,
  maxDepth: SKILL_IMPORT_LIMITS.maxDepth,
  strictCaps: true
}

const readFromHandle = async (
  handle: FileHandle,
  fileSize: number,
  position: number,
  length: number
): Promise<Buffer | undefined> => {
  if (
    !Number.isSafeInteger(position) ||
    !Number.isSafeInteger(length) ||
    position < 0 ||
    length < 0 ||
    position + length > fileSize
  ) {
    return undefined
  }

  const buffer = Buffer.allocUnsafe(length)
  let bytesRead = 0
  while (bytesRead < length) {
    const result = await handle.read(buffer, bytesRead, length - bytesRead, position + bytesRead)
    if (result.bytesRead === 0) return undefined
    bytesRead += result.bytesRead
  }
  return buffer
}

const fileReader = (handle: FileHandle, size: number): ArchiveReader => ({
  size,
  read: (position, length) => readFromHandle(handle, size, position, length)
})

const bufferReader = (buffer: Buffer): ArchiveReader => ({
  size: buffer.length,
  read: async (position, length) => {
    if (position < 0 || length < 0 || position + length > buffer.length) return undefined
    return buffer.subarray(position, position + length)
  }
})

const subrangeReader = (
  parent: ArchiveReader,
  offset: number,
  size: number
): ArchiveReader | undefined => {
  if (offset < 0 || size < 0 || offset + size > parent.size) return undefined
  return {
    size,
    read: (position, length) => {
      if (position < 0 || length < 0 || position + length > size) {
        return Promise.resolve(undefined)
      }
      return parent.read(offset + position, length)
    }
  }
}

const findEocd = (tail: Buffer): number => {
  for (let offset = tail.length - EOCD_MIN_SIZE; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue

    const commentLength = tail.readUInt16LE(offset + 20)
    if (offset + EOCD_MIN_SIZE + commentLength === tail.length) return offset
  }
  return -1
}

const isMetadataPath = (path: string): boolean =>
  path.startsWith('__MACOSX/') || path.startsWith('.')

const isUnsafeArchivePath = (path: string): boolean =>
  path.length === 0 ||
  path.includes('\\') ||
  path.startsWith('/') ||
  /^[A-Za-z]:/.test(path) ||
  path.split('/').some((segment) => segment === '..')

const isNestedArchive = (path: string): boolean => /\.(zip|skill)$/i.test(path)

const extractedEntrySize = (
  entry: Pick<CentralEntry, 'method' | 'compressedSize' | 'uncompressedSize'>
): number => (entry.method === 0 ? entry.compressedSize : entry.uncompressedSize)

// Sequential, fixed-size buffering keeps a ZIP with thousands of directory/metadata records from
// turning into two random-access reads per record. It also avoids allocating the full central
// directory, whose raw record count is not capped by the importer (only accepted files are capped).
const centralCursor = (
  reader: ArchiveReader,
  start: number,
  end: number
): {
  read: (length: number) => Promise<Buffer | undefined>
  skip: (length: number) => boolean
} => {
  let position = start
  let chunk: Buffer = Buffer.alloc(0)
  let chunkStart = start

  const ensureChunk = async (): Promise<boolean> => {
    if (position >= chunkStart && position < chunkStart + chunk.length) return true
    if (position >= end) return false

    chunkStart = position
    const next = await reader.read(position, Math.min(CENTRAL_READ_CHUNK_BYTES, end - position))
    if (!next) return false
    chunk = next
    return true
  }

  return {
    read: async (length) => {
      if (!Number.isSafeInteger(length) || length < 0 || position + length > end) return undefined
      if (length === 0) return Buffer.alloc(0)

      const output = Buffer.allocUnsafe(length)
      let written = 0
      while (written < length) {
        if (!(await ensureChunk())) return undefined
        const chunkOffset = position - chunkStart
        const copied = Math.min(length - written, chunk.length - chunkOffset)
        chunk.copy(output, written, chunkOffset, chunkOffset + copied)
        written += copied
        position += copied
      }
      return output
    },
    skip: (length) => {
      if (!Number.isSafeInteger(length) || length < 0 || position + length > end) return false
      position += length
      return true
    }
  }
}

// Streams central-directory records instead of reading the whole ZIP or inflating unrelated files.
// Size/count decisions mirror extractZipLenient (outer) and extractZip (one nested archive) using the
// central metadata; candidate entry bytes are checked against their local header when actually read.
const scanArchive = async (
  reader: ArchiveReader,
  limits: ScanLimits
): Promise<ArchiveScan | undefined> => {
  const tailSize = Math.min(reader.size, EOCD_MIN_SIZE + MAX_ZIP_COMMENT_BYTES)
  const tail = await reader.read(reader.size - tailSize, tailSize)
  if (!tail) return undefined

  const eocd = findEocd(tail)
  if (eocd < 0) return undefined

  const diskNumber = tail.readUInt16LE(eocd + 4)
  const centralDisk = tail.readUInt16LE(eocd + 6)
  const entriesOnDisk = tail.readUInt16LE(eocd + 8)
  const entryCount = tail.readUInt16LE(eocd + 10)
  const centralSize = tail.readUInt32LE(eocd + 12)
  const centralOffset = tail.readUInt32LE(eocd + 16)
  const centralEnd = centralOffset + centralSize

  // Multi-disk and ZIP64 archives are unsupported by the real importer too.
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    centralEnd > reader.size
  ) {
    return undefined
  }

  const accepted: CentralEntry[] = []
  const skippedPaths: string[] = []
  let totalBytes = 0
  const cursor = centralCursor(reader, centralOffset, centralEnd)

  for (let index = 0; index < entryCount; index += 1) {
    const header = await cursor.read(46)
    if (!header || header.readUInt32LE(0) !== CENTRAL_SIGNATURE) return undefined

    const method = header.readUInt16LE(10)
    const compressedSize = header.readUInt32LE(20)
    const uncompressedSize = header.readUInt32LE(24)
    const nameLength = header.readUInt16LE(28)
    const extraLength = header.readUInt16LE(30)
    const commentLength = header.readUInt16LE(32)
    const startDisk = header.readUInt16LE(34)
    const localOffset = header.readUInt32LE(42)
    if (startDisk !== 0) return undefined

    const nameBytes = await cursor.read(nameLength)
    if (!nameBytes) return undefined
    const name = nameBytes.toString('utf8')
    if (!cursor.skip(extraLength + commentLength)) return undefined

    // Match zip-extract's silent skips for directories, metadata, unsafe paths, and unsupported
    // methods. The outer lenient walk records real unsafe/method failures so a containing loose root
    // is rejected rather than classified from an incomplete bundle.
    if (name.endsWith('/') || isMetadataPath(name)) continue
    if (isUnsafeArchivePath(name) || (method !== 0 && method !== 8)) {
      if (!limits.strictCaps) skippedPaths.push(name)
      continue
    }

    const depth = name.split('/').length - 1
    const outputSize = method === 0 ? compressedSize : uncompressedSize
    const violatesCaps =
      depth > limits.maxDepth ||
      accepted.length >= limits.maxFiles ||
      outputSize > limits.maxFileBytes ||
      totalBytes + outputSize > limits.maxTotalBytes
    if (violatesCaps) {
      if (limits.strictCaps) return undefined
      skippedPaths.push(name)
      continue
    }

    accepted.push({ name, method, compressedSize, uncompressedSize, localOffset })
    totalBytes += outputSize
  }

  return { accepted, skippedPaths }
}

const entryDataOffset = async (
  reader: ArchiveReader,
  entry: CentralEntry
): Promise<number | undefined> => {
  const header = await reader.read(entry.localOffset, 30)
  if (
    !header ||
    header.readUInt32LE(0) !== LOCAL_SIGNATURE ||
    header.readUInt16LE(8) !== entry.method
  ) {
    return undefined
  }

  const offset = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
  return offset + entry.compressedSize <= reader.size ? offset : undefined
}

const inflateBounded = (compressed: Buffer, maxOutputLength: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    inflateRaw(compressed, { maxOutputLength }, (error, result) => {
      if (error) reject(error)
      else resolve(result)
    })
  })

const readEntry = async (
  reader: ArchiveReader,
  entry: CentralEntry,
  maxOutputLength: number
): Promise<Buffer | undefined> => {
  if (entry.uncompressedSize > maxOutputLength) return undefined

  const offset = await entryDataOffset(reader, entry)
  if (offset === undefined) return undefined
  const compressed = await reader.read(offset, entry.compressedSize)
  if (!compressed) return undefined

  try {
    if (entry.method === 0) {
      return compressed.length <= maxOutputLength ? compressed : undefined
    }
    return await inflateBounded(compressed, maxOutputLength)
  } catch {
    return undefined
  }
}

type FrontmatterScanResult = 'continue' | 'invalid' | { end: number }

const createFrontmatterScanner = (): {
  push: (chunk: Buffer) => FrontmatterScanResult
  finish: () => FrontmatterScanResult
} => {
  let offset = 0
  let lineIndex = 0
  let lineLength = 0
  let matchesDelimiter = true
  let skipLineFeed = false

  const finishLine = (end: number): FrontmatterScanResult => {
    const isDelimiter = matchesDelimiter && lineLength === FRONTMATTER_DELIMITER.length
    if (lineIndex === 0 && !isDelimiter) return 'invalid'
    if (lineIndex > 0 && isDelimiter) return { end }

    lineIndex += 1
    lineLength = 0
    matchesDelimiter = true
    return 'continue'
  }

  return {
    push: (chunk) => {
      for (const byte of chunk) {
        offset += 1
        if (skipLineFeed) {
          skipLineFeed = false
          if (byte === 0x0a) continue
        }
        if (byte === 0x0d || byte === 0x0a) {
          const result = finishLine(offset)
          if (result !== 'continue') return result
          skipLineFeed = byte === 0x0d
          continue
        }

        if (
          lineLength >= FRONTMATTER_DELIMITER.length ||
          byte !== FRONTMATTER_DELIMITER[lineLength]
        ) {
          matchesDelimiter = false
        }
        lineLength += 1
      }
      return 'continue'
    },
    finish: () => finishLine(offset)
  }
}

const compressedEntryChunks = async function* (
  reader: ArchiveReader,
  offset: number,
  size: number
): AsyncGenerator<Buffer> {
  let consumed = 0
  while (consumed < size) {
    const length = Math.min(ENTRY_READ_CHUNK_BYTES, size - consumed)
    const chunk = await reader.read(offset + consumed, length)
    if (!chunk) throw new Error('Unreadable ZIP entry.')
    yield chunk
    consumed += length
  }
}

const readStoredFrontmatter = async (
  reader: ArchiveReader,
  offset: number,
  size: number
): Promise<Buffer | undefined> => {
  if (size > MAX_SNIFF_FRONTMATTER_BYTES) return undefined

  const scanner = createFrontmatterScanner()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of compressedEntryChunks(reader, offset, size)) {
      chunks.push(chunk)
      total += chunk.length
      const result = scanner.push(chunk)
      if (result === 'invalid') return undefined
      if (result !== 'continue') return Buffer.concat(chunks, total).subarray(0, result.end)
    }
  } catch {
    return undefined
  }

  const result = scanner.finish()
  return result !== 'continue' && result !== 'invalid'
    ? Buffer.concat(chunks, total).subarray(0, result.end)
    : undefined
}

const readDeflatedFrontmatter = async (
  reader: ArchiveReader,
  offset: number,
  compressedSize: number,
  uncompressedSize: number
): Promise<Buffer | undefined> => {
  if (uncompressedSize > MAX_SNIFF_FRONTMATTER_BYTES) return undefined

  const scanner = createFrontmatterScanner()
  const chunks: Buffer[] = []
  let frontmatterEnd: number | undefined
  let total = 0
  const source = Readable.from(compressedEntryChunks(reader, offset, compressedSize))
  const output = source.pipe(createInflateRaw())
  // pipe() does not forward source errors. A file truncated between stat/scan/read must reject this
  // candidate through the consumed transform instead of becoming an unhandled main-process error.
  source.on('error', (error: Error) => output.destroy(error))

  try {
    for await (const value of output) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
      total += chunk.length
      if (total > MAX_SNIFF_FRONTMATTER_BYTES) return undefined
      if (frontmatterEnd !== undefined) continue

      chunks.push(chunk)
      const result = scanner.push(chunk)
      if (result === 'invalid') return undefined
      if (result !== 'continue') frontmatterEnd = result.end
    }
  } catch {
    return undefined
  } finally {
    output.destroy()
    source.destroy()
  }

  if (frontmatterEnd === undefined) {
    const result = scanner.finish()
    if (result === 'continue' || result === 'invalid') return undefined
    frontmatterEnd = result.end
  }
  return Buffer.concat(chunks).subarray(0, frontmatterEnd)
}

const readManifestFrontmatter = async (
  reader: ArchiveReader,
  entry: CentralEntry
): Promise<Buffer | undefined> => {
  const offset = await entryDataOffset(reader, entry)
  if (offset === undefined) return undefined

  return entry.method === 0
    ? readStoredFrontmatter(reader, offset, entry.compressedSize)
    : readDeflatedFrontmatter(reader, offset, entry.compressedSize, entry.uncompressedSize)
}

const manifestHasName = async (reader: ArchiveReader, entry: CentralEntry): Promise<boolean> => {
  const frontmatter = await readManifestFrontmatter(reader, entry)
  if (!frontmatter) return false

  try {
    return Boolean(parseSkillDocument(frontmatter.toString('utf8')).name?.trim())
  } catch {
    return false
  }
}

const owningRoot = (
  path: string,
  roots: ReadonlySet<string>,
  includeExactRoot: boolean
): string | undefined => {
  if (roots.has('')) return ''

  const segments = path.split('/')
  const maxSegments = Math.min(2, segments.length - (includeExactRoot ? 0 : 1))
  for (let length = 1; length <= maxSegments; length += 1) {
    const candidate = segments.slice(0, length).join('/')
    if (roots.has(candidate)) return candidate
  }
  return undefined
}

const inspectManifestRoots = async (
  reader: ArchiveReader,
  scan: ArchiveScan,
  requireCompleteLooseRoot: boolean,
  maxCandidates: number
): Promise<ManifestRootInspection> => {
  const manifestEntries = scan.accepted.filter(
    (entry) => !isNestedArchive(entry.name) && skillManifestRootPath(entry.name) !== undefined
  )
  const ownerRoots = selectSkillManifestRoots(manifestEntries.map((entry) => entry.name))
  const rootSet = new Set(ownerRoots)
  const manifestByRoot = new Map<string, CentralEntry>()
  for (const entry of manifestEntries) {
    const root = skillManifestRootPath(entry.name)
    if (root !== undefined && !manifestByRoot.has(root)) manifestByRoot.set(root, entry)
  }

  const rejectedRoots = new Set<string>()
  const rootCounts = new Map<string, { files: number; bytes: number }>()
  if (requireCompleteLooseRoot) {
    for (const path of scan.skippedPaths) {
      const root = owningRoot(path, rootSet, true)
      if (root !== undefined) rejectedRoots.add(root)
    }
    for (const entry of scan.accepted) {
      const root = owningRoot(entry.name, rootSet, false)
      if (root === undefined) continue
      const stats = rootCounts.get(root) ?? { files: 0, bytes: 0 }
      const size = extractedEntrySize(entry)
      stats.files += 1
      stats.bytes += size
      rootCounts.set(root, stats)
      if (
        stats.files > SKILL_IMPORT_LIMITS.maxFiles ||
        size > SKILL_IMPORT_LIMITS.maxFileBytes ||
        stats.bytes > SKILL_IMPORT_LIMITS.maxTotalBytes
      ) {
        rejectedRoots.add(root)
      }
    }
  }

  const candidateRoots: string[] = []
  const named: boolean[] = []

  for (const root of ownerRoots) {
    if (rejectedRoots.has(root) || candidateRoots.length >= maxCandidates) continue
    candidateRoots.push(root)

    // Full preview uses the first case-insensitive SKILL.md at the selected root, so duplicate-cased
    // entries cannot let the sniffer pick a different manifest than the importer.
    const manifest = manifestByRoot.get(root)
    named.push(manifest ? await manifestHasName(reader, manifest) : false)
  }

  return { ownerRoots, candidateRoots, named }
}

const nestedArchiveReader = async (
  parent: ArchiveReader,
  entry: CentralEntry
): Promise<ArchiveReader | undefined> => {
  const offset = await entryDataOffset(parent, entry)
  if (offset === undefined) return undefined

  if (entry.method === 0) {
    if (entry.compressedSize > SKILL_IMPORT_LIMITS.maxSkillArchiveBytes) return undefined
    return subrangeReader(parent, offset, entry.compressedSize)
  }

  const bytes = await readEntry(parent, entry, SKILL_IMPORT_LIMITS.maxSkillArchiveBytes)
  return bytes ? bufferReader(bytes) : undefined
}

const inspectNestedArchive = async (
  parent: ArchiveReader,
  entry: CentralEntry,
  maxCandidates: number
): Promise<boolean[]> => {
  const nested = await nestedArchiveReader(parent, entry)
  if (!nested) return []

  const scan = await scanArchive(nested, INNER_SCAN_LIMITS)
  if (!scan) return []
  return (await inspectManifestRoots(nested, scan, false, maxCandidates)).named
}

const inspectOuterArchive = async (reader: ArchiveReader): Promise<boolean> => {
  const scan = await scanArchive(reader, OUTER_SCAN_LIMITS)
  if (!scan) return false

  const candidateLimit = SKILL_IMPORT_LIMITS.maxSkillsPerBundle
  const loose = await inspectManifestRoots(reader, scan, true, candidateLimit)
  if (loose.named.some(Boolean)) return true

  let remainingCandidates = Math.max(0, candidateLimit - loose.candidateRoots.length)
  if (remainingCandidates === 0) return false

  const ownerRoots = new Set(loose.ownerRoots)
  const standaloneArchives = scan.accepted.filter(
    (entry) =>
      isNestedArchive(entry.name) && owningRoot(entry.name, ownerRoots, false) === undefined
  )

  for (const archive of standaloneArchives) {
    const nestedCandidates = await inspectNestedArchive(reader, archive, remainingCandidates)
    if (nestedCandidates.some(Boolean)) return true
    remainingCandidates -= nestedCandidates.length
    if (remainingCandidates <= 0) break
  }

  return false
}

// Classifies a ZIP without loading the whole upload or inflating unrelated assets. Central records
// are streamed; only selected manifests are inflated, plus one importer-supported level of nested
// archive (asynchronously and under the same 64 MB cap as full discovery). Any ambiguity fails closed
// to the ordinary resource path; the real importer still performs full preview/validation on approval.
const isImportableSkillArchivePath = async (filePath: string): Promise<boolean> => {
  let handle: FileHandle | undefined
  try {
    handle = await open(filePath, 'r')
    const { size } = await handle.stat()
    if (size > SKILL_IMPORT_LIMITS.maxBundleBytes) return false
    return await inspectOuterArchive(fileReader(handle, size))
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export { inspectOuterArchive, isImportableSkillArchivePath }
