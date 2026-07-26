import { open, type FileHandle } from 'node:fs/promises'
import { inflateRaw } from 'node:zlib'

import { parseSkillDocument } from './frontmatter'
import { SKILL_IMPORT_LIMITS } from './import-limits'
import { selectSkillManifestRoots, skillManifestRootPath } from './skill-bundle-paths'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_MIN_SIZE = 22
const MAX_ZIP_COMMENT_BYTES = 0xffff

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
  let pointer = centralOffset

  for (let index = 0; index < entryCount; index += 1) {
    const header = await reader.read(pointer, 46)
    if (!header || header.readUInt32LE(0) !== CENTRAL_SIGNATURE) return undefined

    const method = header.readUInt16LE(10)
    const compressedSize = header.readUInt32LE(20)
    const uncompressedSize = header.readUInt32LE(24)
    const nameLength = header.readUInt16LE(28)
    const extraLength = header.readUInt16LE(30)
    const commentLength = header.readUInt16LE(32)
    const startDisk = header.readUInt16LE(34)
    const localOffset = header.readUInt32LE(42)
    const next = pointer + 46 + nameLength + extraLength + commentLength
    if (startDisk !== 0 || next > centralEnd) return undefined

    const nameBytes = await reader.read(pointer + 46, nameLength)
    if (!nameBytes) return undefined
    const name = nameBytes.toString('utf8')
    pointer = next

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

const manifestHasName = async (reader: ArchiveReader, entry: CentralEntry): Promise<boolean> => {
  const manifest = await readEntry(reader, entry, SKILL_IMPORT_LIMITS.maxFileBytes)
  if (!manifest) return false

  try {
    return Boolean(parseSkillDocument(manifest.toString('utf8')).name?.trim())
  } catch {
    return false
  }
}

const skippedPathBelongsToRoot = (root: string, path: string): boolean =>
  root === '' || path === root || path.startsWith(`${root}/`)

const acceptedPathBelongsToRoot = (root: string, path: string): boolean =>
  root === '' || path.startsWith(`${root}/`)

const looseRootIsComplete = (root: string, scan: ArchiveScan): boolean => {
  if (scan.skippedPaths.some((path) => skippedPathBelongsToRoot(root, path))) return false

  const files = scan.accepted.filter((entry) => acceptedPathBelongsToRoot(root, entry.name))
  return (
    files.length <= SKILL_IMPORT_LIMITS.maxFiles &&
    files.every((entry) => extractedEntrySize(entry) <= SKILL_IMPORT_LIMITS.maxFileBytes) &&
    files.reduce((total, entry) => total + extractedEntrySize(entry), 0) <=
      SKILL_IMPORT_LIMITS.maxTotalBytes
  )
}

const inspectManifestRoots = async (
  reader: ArchiveReader,
  scan: ArchiveScan,
  requireCompleteLooseRoot: boolean
): Promise<{ roots: string[]; named: boolean[] }> => {
  const manifestEntries = scan.accepted.filter(
    (entry) => !isNestedArchive(entry.name) && skillManifestRootPath(entry.name) !== undefined
  )
  const roots = selectSkillManifestRoots(manifestEntries.map((entry) => entry.name))
  const named: boolean[] = []

  for (const root of roots) {
    if (requireCompleteLooseRoot && !looseRootIsComplete(root, scan)) {
      named.push(false)
      continue
    }

    // Full preview uses the first case-insensitive SKILL.md at the selected root, so duplicate-cased
    // entries cannot let the sniffer pick a different manifest than the importer.
    const manifest = manifestEntries.find((entry) => skillManifestRootPath(entry.name) === root)
    named.push(manifest ? await manifestHasName(reader, manifest) : false)
  }

  return { roots, named }
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
  entry: CentralEntry
): Promise<boolean[]> => {
  const nested = await nestedArchiveReader(parent, entry)
  if (!nested) return []

  const scan = await scanArchive(nested, INNER_SCAN_LIMITS)
  if (!scan) return []
  return (await inspectManifestRoots(nested, scan, false)).named
}

const inspectOuterArchive = async (reader: ArchiveReader): Promise<boolean> => {
  const scan = await scanArchive(reader, OUTER_SCAN_LIMITS)
  if (!scan) return false

  const loose = await inspectManifestRoots(reader, scan, true)
  const candidateLimit = SKILL_IMPORT_LIMITS.maxSkillsPerBundle
  const consideredLoose = loose.named.slice(0, candidateLimit)
  if (consideredLoose.some(Boolean)) return true

  let remainingCandidates = Math.max(0, candidateLimit - loose.roots.length)
  if (remainingCandidates === 0) return false

  const rootPrefixes = loose.roots.map((root) => (root === '' ? '' : `${root}/`))
  const standaloneArchives = scan.accepted.filter(
    (entry) =>
      isNestedArchive(entry.name) &&
      !rootPrefixes.some((prefix) => prefix === '' || entry.name.startsWith(prefix))
  )

  for (const archive of standaloneArchives) {
    const nestedCandidates = await inspectNestedArchive(reader, archive)
    const considered = nestedCandidates.slice(0, remainingCandidates)
    if (considered.some(Boolean)) return true
    remainingCandidates -= considered.length
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
    return await inspectOuterArchive(fileReader(handle, size))
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export { isImportableSkillArchivePath }
