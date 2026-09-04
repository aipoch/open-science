import { open, type FileHandle } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createInflateRaw } from 'node:zlib'

import { parseSkillDocument } from './frontmatter'
import { SKILL_IMPORT_LIMITS } from './import-limits'
import { selectSkillManifestRoots, skillManifestRootPath } from './skill-bundle-paths'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_MIN_SIZE = 22
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
  localOffset: number
}

type ArchiveScan = {
  accepted: CentralEntry[]
  skippedPaths: string[]
  actualSizes: Map<CentralEntry, number>
  dataRanges: Map<CentralEntry, { offset: number; compressedSize: number }>
}

type ManifestRootInspection = {
  ownerRoots: string[]
  candidateRoots: string[]
  named: boolean[]
}

type InflateBudget = {
  maxBytes: number
  readBytes: number
  inflatedBytes: number
  exhausted: boolean
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

// Match zip-extract's last-signature semantics without loading the whole bounded upload. Windows
// overlap by the remainder of the fixed EOCD record so a signature split across reads is still found.
const findEocd = async (reader: ArchiveReader): Promise<number | undefined> => {
  let end = reader.size
  while (end >= EOCD_MIN_SIZE) {
    const start = Math.max(0, end - CENTRAL_READ_CHUNK_BYTES)
    const chunk = await reader.read(start, end - start)
    if (!chunk) return undefined

    for (let offset = chunk.length - EOCD_MIN_SIZE; offset >= 0; offset -= 1) {
      if (chunk.readUInt32LE(offset) === EOCD_SIGNATURE) return start + offset
    }

    if (start === 0) break
    end = start + EOCD_MIN_SIZE - 1
  }
  return undefined
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

// Sequential, fixed-size buffering keeps a ZIP with thousands of directory/metadata records from
// turning into two random-access reads per record. It also avoids allocating the full central
// directory, whose raw record count is not capped by the importer (only accepted files are capped).
const centralCursor = (
  reader: ArchiveReader,
  start: number,
  end: number
): {
  read: (length: number) => Promise<Buffer | undefined>
  remaining: () => number
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
    remaining: () => Math.max(0, end - position),
    skip: (length) => {
      if (!Number.isSafeInteger(length) || length < 0 || position + length > end) return false
      position += length
      return true
    }
  }
}

// Streams central-directory records instead of reading the whole ZIP. This pass keeps structural path
// decisions in central order; local-header readability, actual inflate sizes, and file/total caps are
// applied by validateArchiveEntries so untrusted central size/count claims cannot change eligibility.
const scanArchive = async (
  reader: ArchiveReader,
  limits: ScanLimits
): Promise<ArchiveScan | undefined> => {
  const eocd = await findEocd(reader)
  if (eocd === undefined) return undefined
  const eocdRecord = await reader.read(eocd, EOCD_MIN_SIZE)
  if (!eocdRecord) return undefined

  const diskNumber = eocdRecord.readUInt16LE(4)
  const centralDisk = eocdRecord.readUInt16LE(6)
  const entriesOnDisk = eocdRecord.readUInt16LE(8)
  const entryCount = eocdRecord.readUInt16LE(10)
  const centralSize = eocdRecord.readUInt32LE(12)
  const centralOffset = eocdRecord.readUInt32LE(16)
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
  // The real extractors walk from centralOffset against the complete buffer and do not use the EOCD
  // central-size field as their cursor boundary. Keep the same boundary here for classification parity.
  const cursor = centralCursor(reader, centralOffset, reader.size)

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor.remaining() < 46) break
    const header = await cursor.read(46)
    // Match extractZip/extractZipLenient: a malformed trailing central record ends the walk but does
    // not discard entries that were already decoded successfully.
    if (!header) return undefined
    if (header.readUInt32LE(0) !== CENTRAL_SIGNATURE) break

    const method = header.readUInt16LE(10)
    const compressedSize = header.readUInt32LE(20)
    const nameLength = header.readUInt16LE(28)
    const extraLength = header.readUInt16LE(30)
    const commentLength = header.readUInt16LE(32)
    const startDisk = header.readUInt16LE(34)
    const localOffset = header.readUInt32LE(42)
    if (startDisk !== 0) return undefined

    // Buffer#toString clamps an overlong name range, so the importer still handles the current entry
    // before its now-out-of-range pointer stops the next iteration. Reproduce that behavior without
    // reading outside the bounded file.
    const readableNameLength = Math.min(nameLength, cursor.remaining())
    const nameBytes = await cursor.read(readableNameLength)
    if (!nameBytes) return undefined
    const name = nameBytes.toString('utf8')
    const canContinue =
      readableNameLength === nameLength && cursor.skip(extraLength + commentLength)

    // Match zip-extract's silent skips for directories, metadata, unsafe paths, and unsupported
    // methods. The outer lenient walk records real unsafe/method failures so a containing loose root
    // is rejected rather than classified from an incomplete bundle.
    if (name.endsWith('/') || isMetadataPath(name)) {
      if (!canContinue) break
      continue
    }
    if (isUnsafeArchivePath(name) || (method !== 0 && method !== 8)) {
      if (!limits.strictCaps) skippedPaths.push(name)
      if (!canContinue) break
      continue
    }

    const depth = name.split('/').length - 1
    if (depth > limits.maxDepth) {
      if (limits.strictCaps) return undefined
      skippedPaths.push(name)
      if (!canContinue) break
      continue
    }

    accepted.push({ name, method, compressedSize, localOffset })
    if (!canContinue) break
  }

  return { accepted, skippedPaths, actualSizes: new Map(), dataRanges: new Map() }
}

type LocalEntryData =
  | { kind: 'valid'; offset: number; availableSize: number; complete: boolean }
  | { kind: 'wrong-signature' }
  | { kind: 'unreadable' }

const locateEntryData = async (
  reader: ArchiveReader,
  entry: CentralEntry
): Promise<LocalEntryData> => {
  const header = await reader.read(entry.localOffset, 30)
  if (!header) return { kind: 'unreadable' }
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) return { kind: 'wrong-signature' }

  const offset = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > reader.size) {
    return { kind: 'unreadable' }
  }

  const availableSize = Math.min(entry.compressedSize, reader.size - offset)
  return {
    kind: 'valid',
    offset,
    availableSize,
    complete: availableSize === entry.compressedSize
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

const consumeReadBudget = (budget: InflateBudget, bytes: number): boolean => {
  budget.readBytes += bytes
  if (budget.readBytes <= budget.maxBytes) return true

  budget.exhausted = true
  return false
}

const consumeInflateBudget = (budget: InflateBudget, bytes: number): boolean => {
  budget.inflatedBytes += bytes
  if (budget.inflatedBytes <= budget.maxBytes) return true

  budget.exhausted = true
  return false
}

const resetInflateBudget = (budget: InflateBudget): void => {
  budget.readBytes = 0
  budget.inflatedBytes = 0
  budget.exhausted = false
}

const compressedEntryChunks = async function* (
  reader: ArchiveReader,
  offset: number,
  size: number,
  budget: InflateBudget
): AsyncGenerator<Buffer> {
  let consumed = 0
  while (consumed < size) {
    const length = Math.min(ENTRY_READ_CHUNK_BYTES, size - consumed)
    const chunk = await reader.read(offset + consumed, length)
    if (!chunk) throw new Error('Unreadable ZIP entry.')
    if (!consumeReadBudget(budget, chunk.length)) {
      throw new Error('ZIP entry read budget exhausted.')
    }
    yield chunk
    consumed += length
  }
}

const inflatedEntryChunks = async function* (
  reader: ArchiveReader,
  offset: number,
  compressedSize: number,
  budget: InflateBudget
): AsyncGenerator<Buffer> {
  const source = Readable.from(compressedEntryChunks(reader, offset, compressedSize, budget))
  const output = source.pipe(createInflateRaw())
  // pipe() does not forward source errors. A file truncated between stat/scan/read must reject this
  // candidate through the consumed transform instead of becoming an unhandled main-process error.
  source.on('error', (error: Error) => output.destroy(error))

  try {
    for await (const value of output) {
      yield Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
    }
  } finally {
    output.destroy()
    source.destroy()
  }
}

const readInflatedEntry = async (
  reader: ArchiveReader,
  offset: number,
  compressedSize: number,
  maxOutputBytes: number,
  inflateBudget: InflateBudget
): Promise<Buffer | undefined> => {
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of inflatedEntryChunks(reader, offset, compressedSize, inflateBudget)) {
      if (!consumeInflateBudget(inflateBudget, chunk.length)) return undefined
      total += chunk.length
      if (total > maxOutputBytes) return undefined
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, total)
  } catch {
    return undefined
  }
}

const readStoredFrontmatter = async (
  reader: ArchiveReader,
  offset: number,
  size: number,
  budget: InflateBudget
): Promise<Buffer | undefined> => {
  if (size > MAX_SNIFF_FRONTMATTER_BYTES) return undefined

  const scanner = createFrontmatterScanner()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of compressedEntryChunks(reader, offset, size, budget)) {
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
  inflateBudget: InflateBudget
): Promise<Buffer | undefined> => {
  const scanner = createFrontmatterScanner()
  const chunks: Buffer[] = []
  let total = 0

  try {
    for await (const chunk of inflatedEntryChunks(reader, offset, compressedSize, inflateBudget)) {
      if (!consumeInflateBudget(inflateBudget, chunk.length)) return undefined
      total += chunk.length
      if (total > MAX_SNIFF_FRONTMATTER_BYTES) return undefined

      chunks.push(chunk)
      const result = scanner.push(chunk)
      if (result === 'invalid') return undefined
      // Entry validation already consumed the complete body. Stop this second, classification-only
      // inflate as soon as the frontmatter closes so a large valid body is not charged twice against
      // the shared automatic-sniff work budget.
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

const readManifestFrontmatter = async (
  reader: ArchiveReader,
  entry: CentralEntry,
  range: { offset: number; compressedSize: number },
  inflateBudget: InflateBudget
): Promise<Buffer | undefined> => {
  return entry.method === 0
    ? readStoredFrontmatter(reader, range.offset, range.compressedSize, inflateBudget)
    : readDeflatedFrontmatter(reader, range.offset, range.compressedSize, inflateBudget)
}

const manifestHasName = async (
  reader: ArchiveReader,
  entry: CentralEntry,
  range: { offset: number; compressedSize: number },
  inflateBudget: InflateBudget
): Promise<boolean> => {
  const frontmatter = await readManifestFrontmatter(reader, entry, range, inflateBudget)
  if (!frontmatter) return false

  try {
    return Boolean(parseSkillDocument(frontmatter.toString('utf8')).name?.trim())
  } catch {
    return false
  }
}

const validatedEntrySizeAtOffset = async (
  reader: ArchiveReader,
  entry: CentralEntry,
  offset: number,
  compressedSize: number,
  maxFileBytes: number,
  inflateBudget: InflateBudget
): Promise<number | undefined> => {
  if (entry.method === 0) {
    if (compressedSize > maxFileBytes) return undefined

    let total = 0
    try {
      for await (const chunk of compressedEntryChunks(
        reader,
        offset,
        compressedSize,
        inflateBudget
      )) {
        total += chunk.length
      }
      return total
    } catch {
      return undefined
    }
  }

  let total = 0
  try {
    for await (const chunk of inflatedEntryChunks(reader, offset, compressedSize, inflateBudget)) {
      if (!consumeInflateBudget(inflateBudget, chunk.length)) return undefined
      total += chunk.length
      if (total > maxFileBytes) return undefined
    }
    return total
  } catch {
    return undefined
  }
}

const validateArchiveEntries = async (
  reader: ArchiveReader,
  scan: ArchiveScan,
  limits: ScanLimits,
  inflateBudget: InflateBudget
): Promise<ArchiveScan | undefined> => {
  const accepted: CentralEntry[] = []
  const skippedPaths = [...scan.skippedPaths]
  const actualSizes = new Map<CentralEntry, number>()
  const dataRanges = new Map<CentralEntry, { offset: number; compressedSize: number }>()
  let total = 0

  for (const entry of scan.accepted) {
    if (accepted.length >= limits.maxFiles) {
      if (limits.strictCaps) return undefined
      skippedPaths.push(entry.name)
      continue
    }

    const location = await locateEntryData(reader, entry)
    if (location.kind === 'wrong-signature') {
      // Strict extractZip silently skips an in-bounds local header with the wrong signature; the
      // lenient outer extractor records it so any owning loose root is rejected as incomplete.
      if (!limits.strictCaps) skippedPaths.push(entry.name)
      continue
    }
    if (location.kind === 'unreadable' || (!location.complete && !limits.strictCaps)) {
      if (limits.strictCaps) return undefined
      skippedPaths.push(entry.name)
      continue
    }

    const size = await validatedEntrySizeAtOffset(
      reader,
      entry,
      location.offset,
      location.availableSize,
      limits.maxFileBytes,
      inflateBudget
    )
    // Unlike importer preview, sniffing happens automatically. Bound total inflate work across both
    // accepted and rejected entries so many individually-skipped bombs cannot multiply the CPU budget.
    if (inflateBudget.exhausted) return undefined
    if (size === undefined || total + size > limits.maxTotalBytes) {
      if (limits.strictCaps) return undefined
      skippedPaths.push(entry.name)
      continue
    }

    total += size
    accepted.push(entry)
    actualSizes.set(entry, size)
    dataRanges.set(entry, {
      offset: location.offset,
      compressedSize: location.availableSize
    })
  }

  return { accepted, skippedPaths, actualSizes, dataRanges }
}

const looseRootIsWithinCaps = (entries: CentralEntry[], scan: ArchiveScan): boolean => {
  if (entries.length > SKILL_IMPORT_LIMITS.maxFiles) return false

  let total = 0
  for (const entry of entries) {
    const size = scan.actualSizes.get(entry)
    if (size === undefined || size > SKILL_IMPORT_LIMITS.maxFileBytes) return false
    total += size
    if (total > SKILL_IMPORT_LIMITS.maxTotalBytes) return false
  }
  return true
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
  maxCandidates: number,
  inflateBudget: InflateBudget
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
  const entriesByRoot = new Map<string, CentralEntry[]>()
  if (requireCompleteLooseRoot) {
    for (const path of scan.skippedPaths) {
      const root = owningRoot(path, rootSet, true)
      if (root !== undefined) rejectedRoots.add(root)
    }
    for (const entry of scan.accepted) {
      const root = owningRoot(entry.name, rootSet, false)
      if (root === undefined) continue
      const rootEntries = entriesByRoot.get(root) ?? []
      rootEntries.push(entry)
      entriesByRoot.set(root, rootEntries)
      if (rootEntries.length > SKILL_IMPORT_LIMITS.maxFiles) rejectedRoots.add(root)
    }
  }

  const candidateRoots: string[] = []
  const named: boolean[] = []

  for (const root of ownerRoots) {
    if (inflateBudget.exhausted) break
    if (rejectedRoots.has(root) || candidateRoots.length >= maxCandidates) continue
    if (requireCompleteLooseRoot && !looseRootIsWithinCaps(entriesByRoot.get(root) ?? [], scan)) {
      continue
    }
    candidateRoots.push(root)

    // Full preview uses the first case-insensitive SKILL.md at the selected root, so duplicate-cased
    // entries cannot let the sniffer pick a different manifest than the importer.
    const manifest = manifestByRoot.get(root)
    const range = manifest ? scan.dataRanges.get(manifest) : undefined
    named.push(
      manifest && range ? await manifestHasName(reader, manifest, range, inflateBudget) : false
    )
    if (inflateBudget.exhausted) break
  }

  return { ownerRoots, candidateRoots, named }
}

const nestedArchiveReader = async (
  parent: ArchiveReader,
  entry: CentralEntry,
  range: { offset: number; compressedSize: number },
  inflateBudget: InflateBudget
): Promise<ArchiveReader | undefined> => {
  if (entry.method === 0) {
    if (range.compressedSize > SKILL_IMPORT_LIMITS.maxSkillArchiveBytes) return undefined
    return subrangeReader(parent, range.offset, range.compressedSize)
  }

  const bytes = await readInflatedEntry(
    parent,
    range.offset,
    range.compressedSize,
    SKILL_IMPORT_LIMITS.maxSkillArchiveBytes,
    inflateBudget
  )
  return bytes ? bufferReader(bytes) : undefined
}

const inspectNestedArchive = async (
  parent: ArchiveReader,
  entry: CentralEntry,
  range: { offset: number; compressedSize: number },
  maxCandidates: number,
  inflateBudget: InflateBudget
): Promise<boolean[]> => {
  const nested = await nestedArchiveReader(parent, entry, range, inflateBudget)
  if (!nested) return []

  const scan = await scanArchive(nested, INNER_SCAN_LIMITS)
  if (!scan) return []
  const validated = await validateArchiveEntries(nested, scan, INNER_SCAN_LIMITS, inflateBudget)
  if (!validated) return []
  return (await inspectManifestRoots(nested, validated, false, maxCandidates, inflateBudget)).named
}

const inspectOuterArchive = async (
  reader: ArchiveReader,
  maxAttemptedInflateBytes: number = OUTER_SCAN_LIMITS.maxTotalBytes
): Promise<boolean> => {
  const inflateBudget: InflateBudget = {
    maxBytes: maxAttemptedInflateBytes,
    readBytes: 0,
    inflatedBytes: 0,
    exhausted: false
  }
  const parsed = await scanArchive(reader, OUTER_SCAN_LIMITS)
  if (!parsed) return false
  const scan = await validateArchiveEntries(reader, parsed, OUTER_SCAN_LIMITS, inflateBudget)
  if (!scan) return false

  // Complete entry validation and post-validation classification are each independently bounded.
  // Give metadata/nested-candidate reads their own pass so an importer-valid archive at the outer
  // decompressed-size cap is not rejected merely because its manifest must be read again for `name`.
  resetInflateBudget(inflateBudget)

  const candidateLimit = SKILL_IMPORT_LIMITS.maxSkillsPerBundle
  const loose = await inspectManifestRoots(reader, scan, true, candidateLimit, inflateBudget)
  if (inflateBudget.exhausted) return false
  if (loose.named.some(Boolean)) return true

  let remainingCandidates = Math.max(0, candidateLimit - loose.candidateRoots.length)
  if (remainingCandidates === 0) return false

  const ownerRoots = new Set(loose.ownerRoots)
  const standaloneArchives = scan.accepted.filter(
    (entry) =>
      isNestedArchive(entry.name) && owningRoot(entry.name, ownerRoots, false) === undefined
  )

  for (const archive of standaloneArchives) {
    const range = scan.dataRanges.get(archive)
    if (!range) continue
    const nestedCandidates = await inspectNestedArchive(
      reader,
      archive,
      range,
      remainingCandidates,
      inflateBudget
    )
    if (inflateBudget.exhausted) return false
    if (nestedCandidates.some(Boolean)) return true
    remainingCandidates -= nestedCandidates.length
    if (remainingCandidates <= 0) break
  }

  return false
}

const isImportableSkillArchive = async (reader: ArchiveReader): Promise<boolean> => {
  try {
    if (reader.size > SKILL_IMPORT_LIMITS.maxBundleBytes) return false
    return await inspectOuterArchive(reader)
  } catch {
    return false
  }
}

// Classifies a ZIP without loading the whole upload. Central records and entry validation are streamed;
// validated bodies are discarded, while only selected frontmatter and one importer-supported nested
// archive are retained under the same caps as full discovery. Any ambiguity fails closed to the ordinary
// resource path; the real importer still performs full preview/validation on approval.
const isImportableSkillArchivePath = async (filePath: string): Promise<boolean> => {
  let handle: FileHandle | undefined
  try {
    handle = await open(filePath, 'r')
    const { size } = await handle.stat()
    return await isImportableSkillArchive(fileReader(handle, size))
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export { inspectOuterArchive, isImportableSkillArchive, isImportableSkillArchivePath }
export type { ArchiveReader }
