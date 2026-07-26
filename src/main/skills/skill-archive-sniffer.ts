import { open, type FileHandle } from 'node:fs/promises'
import { inflateRaw } from 'node:zlib'

import { parseSkillDocument } from './frontmatter'
import { isSkillManifestPath } from './skill-bundle-paths'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_MIN_SIZE = 22
const MAX_ZIP_COMMENT_BYTES = 0xffff

// Prompt assembly needs only enough evidence to choose the Skill-import reference path. These caps
// are deliberately much smaller than the real import limits: the importer performs the complete,
// user-approved archive validation later, while this sniff must stay cheap on Electron's main thread.
const SKILL_ARCHIVE_SNIFF_LIMITS = {
  maxCentralDirectoryBytes: 1024 * 1024,
  maxEntries: 4096,
  maxManifestCandidates: 32,
  maxManifestBytes: 512 * 1024,
  maxCompressedManifestBytes: 512 * 1024,
  maxTotalCompressedManifestBytes: 1024 * 1024,
  maxDepth: 8
} as const

type CentralEntry = {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

const readExact = async (
  handle: FileHandle,
  position: number,
  length: number
): Promise<Buffer | undefined> => {
  if (!Number.isSafeInteger(position) || position < 0 || length < 0) return undefined

  const buffer = Buffer.allocUnsafe(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  return bytesRead === length ? buffer : undefined
}

const findEocd = (tail: Buffer): number => {
  for (let offset = tail.length - EOCD_MIN_SIZE; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue

    const commentLength = tail.readUInt16LE(offset + 20)
    if (offset + EOCD_MIN_SIZE + commentLength === tail.length) return offset
  }
  return -1
}

const isSafeArchivePath = (path: string): boolean =>
  path.length > 0 &&
  !path.includes('\\') &&
  !path.startsWith('/') &&
  !path.startsWith('.') &&
  !path.startsWith('__MACOSX/') &&
  !/^[A-Za-z]:/.test(path) &&
  !path.split('/').some((segment) => segment === '..') &&
  path.split('/').length - 1 <= SKILL_ARCHIVE_SNIFF_LIMITS.maxDepth

const readCentralEntries = async (
  handle: FileHandle,
  fileSize: number
): Promise<CentralEntry[] | undefined> => {
  const tailSize = Math.min(fileSize, EOCD_MIN_SIZE + MAX_ZIP_COMMENT_BYTES)
  const tail = await readExact(handle, fileSize - tailSize, tailSize)
  if (!tail) return undefined

  const eocd = findEocd(tail)
  if (eocd < 0) return undefined

  const diskNumber = tail.readUInt16LE(eocd + 4)
  const centralDisk = tail.readUInt16LE(eocd + 6)
  const entriesOnDisk = tail.readUInt16LE(eocd + 8)
  const entryCount = tail.readUInt16LE(eocd + 10)
  const centralSize = tail.readUInt32LE(eocd + 12)
  const centralOffset = tail.readUInt32LE(eocd + 16)

  // Multi-disk and ZIP64 archives are outside this prompt-time sniff. They remain ordinary resources
  // and can still be inspected without doing expensive or ambiguous work in the main process.
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    entryCount > SKILL_ARCHIVE_SNIFF_LIMITS.maxEntries ||
    centralSize > SKILL_ARCHIVE_SNIFF_LIMITS.maxCentralDirectoryBytes ||
    centralOffset + centralSize > fileSize
  ) {
    return undefined
  }

  const directory = await readExact(handle, centralOffset, centralSize)
  if (!directory) return undefined

  const entries: CentralEntry[] = []
  let pointer = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (pointer + 46 > directory.length || directory.readUInt32LE(pointer) !== CENTRAL_SIGNATURE) {
      return undefined
    }

    const method = directory.readUInt16LE(pointer + 10)
    const compressedSize = directory.readUInt32LE(pointer + 20)
    const uncompressedSize = directory.readUInt32LE(pointer + 24)
    const nameLength = directory.readUInt16LE(pointer + 28)
    const extraLength = directory.readUInt16LE(pointer + 30)
    const commentLength = directory.readUInt16LE(pointer + 32)
    const localOffset = directory.readUInt32LE(pointer + 42)
    const next = pointer + 46 + nameLength + extraLength + commentLength
    if (next > directory.length) return undefined

    entries.push({
      name: directory.toString('utf8', pointer + 46, pointer + 46 + nameLength),
      method,
      compressedSize,
      uncompressedSize,
      localOffset
    })
    pointer = next
  }

  return entries
}

const inflateManifest = (compressed: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    inflateRaw(
      compressed,
      { maxOutputLength: SKILL_ARCHIVE_SNIFF_LIMITS.maxManifestBytes },
      (error, result) => {
        if (error) reject(error)
        else resolve(result)
      }
    )
  })

const readManifest = async (
  handle: FileHandle,
  fileSize: number,
  entry: CentralEntry
): Promise<Buffer | undefined> => {
  if (
    (entry.method !== 0 && entry.method !== 8) ||
    entry.uncompressedSize > SKILL_ARCHIVE_SNIFF_LIMITS.maxManifestBytes ||
    entry.compressedSize > SKILL_ARCHIVE_SNIFF_LIMITS.maxCompressedManifestBytes
  ) {
    return undefined
  }

  const localHeader = await readExact(handle, entry.localOffset, 30)
  if (!localHeader || localHeader.readUInt32LE(0) !== LOCAL_SIGNATURE) return undefined

  const nameLength = localHeader.readUInt16LE(26)
  const extraLength = localHeader.readUInt16LE(28)
  const dataOffset = entry.localOffset + 30 + nameLength + extraLength
  if (dataOffset + entry.compressedSize > fileSize) return undefined

  const compressed = await readExact(handle, dataOffset, entry.compressedSize)
  if (!compressed) return undefined

  try {
    return entry.method === 0 ? compressed : await inflateManifest(compressed)
  } catch {
    return undefined
  }
}

// Classifies a ZIP by reading only its bounded central directory and candidate SKILL.md entries. It
// never loads the whole archive or inflates unrelated assets. False is intentionally a safe fallback:
// the attachment remains a generic resource instead of advertising an import path we cannot confirm.
const isImportableSkillArchivePath = async (filePath: string): Promise<boolean> => {
  let handle: FileHandle | undefined
  try {
    handle = await open(filePath, 'r')
    const { size } = await handle.stat()
    const entries = await readCentralEntries(handle, size)
    if (!entries) return false

    let candidateCount = 0
    let totalCompressedBytes = 0
    for (const entry of entries) {
      if (!isSafeArchivePath(entry.name) || entry.name.endsWith('/')) continue

      if (!isSkillManifestPath(entry.name)) continue

      candidateCount += 1
      totalCompressedBytes += entry.compressedSize
      if (
        candidateCount > SKILL_ARCHIVE_SNIFF_LIMITS.maxManifestCandidates ||
        totalCompressedBytes > SKILL_ARCHIVE_SNIFF_LIMITS.maxTotalCompressedManifestBytes
      ) {
        return false
      }

      const manifest = await readManifest(handle, size, entry)
      if (!manifest) continue

      try {
        if (parseSkillDocument(manifest.toString('utf8')).name?.trim()) return true
      } catch {
        // A malformed candidate does not prevent a later valid Skill root in the same bundle.
      }
    }

    return false
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export { SKILL_ARCHIVE_SNIFF_LIMITS, isImportableSkillArchivePath }
