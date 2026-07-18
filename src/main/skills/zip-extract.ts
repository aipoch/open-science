import { inflateRawSync } from 'node:zlib'

import { SKILL_IMPORT_LIMITS } from './import-limits'

// A dependency-free ZIP reader: parses the central directory + each local file header and inflates the
// entries with node:zlib. Supports the two methods a skill bundle ever uses — STORE (0) and DEFLATE
// (8); directory entries, other methods, and unsafe paths are skipped rather than throwing.
// Resource caps (SKILL_IMPORT_LIMITS) bound the file count and per-file/total decompressed size so a
// zip bomb can't exhaust memory during import.

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_MIN_SIZE = 22

// An extracted file: its posix-style path within the archive plus its decompressed bytes.
export type ExtractedZipFile = { path: string; content: Buffer }

// Rejects paths that would escape the extraction root (zip-slip) or aren't real bundle files.
const isUnsafePath = (path: string): boolean => {
  if (path.length === 0) return true
  // Absolute paths (posix or a Windows drive letter) must never be trusted.
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return true
  // Any `..` segment could climb out of the target directory.
  if (path.split('/').some((segment) => segment === '..')) return true
  // macOS archive metadata and root-level dotfiles aren't part of a skill bundle.
  if (path.startsWith('__MACOSX/')) return true
  if (path.startsWith('.')) return true
  return false
}

// Scans backwards for the End Of Central Directory record; its trailing comment is variable-length so
// it can't be read from a fixed offset. Returns its start offset, or -1 when absent.
const findEocd = (buffer: Buffer): number => {
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  return -1
}

// Extracts every supported file from a ZIP buffer. Directory entries, unsupported compression methods,
// and unsafe paths are skipped; a buffer with no central directory throws.
const extractZip = (buffer: Buffer): ExtractedZipFile[] => {
  const eocd = findEocd(buffer)
  if (eocd < 0) throw new Error('Not a valid ZIP archive.')

  const entryCount = buffer.readUInt16LE(eocd + 10)
  let pointer = buffer.readUInt32LE(eocd + 16)
  const files: ExtractedZipFile[] = []
  let totalBytes = 0

  for (let index = 0; index < entryCount; index += 1) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== CENTRAL_SIGNATURE) break

    const method = buffer.readUInt16LE(pointer + 10)
    const compressedSize = buffer.readUInt32LE(pointer + 20)
    const nameLength = buffer.readUInt16LE(pointer + 28)
    const extraLength = buffer.readUInt16LE(pointer + 30)
    const commentLength = buffer.readUInt16LE(pointer + 32)
    const localOffset = buffer.readUInt32LE(pointer + 42)
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength)

    // Advance to the next central-directory record before any skip.
    pointer += 46 + nameLength + extraLength + commentLength

    if (name.endsWith('/')) continue
    if (isUnsafePath(name)) continue
    if (method !== 0 && method !== 8) continue

    // Bound nesting the same way the GitHub walk does, so a deeply-nested path can't blow past the
    // depth other consumers assume.
    if (name.split('/').length > SKILL_IMPORT_LIMITS.maxDepth) {
      throw new Error(
        `ZIP entry ${name} is nested deeper than ${SKILL_IMPORT_LIMITS.maxDepth} levels.`
      )
    }

    if (files.length >= SKILL_IMPORT_LIMITS.maxFiles) {
      throw new Error(`ZIP bundle has too many files (limit ${SKILL_IMPORT_LIMITS.maxFiles}).`)
    }

    // Read the local header to find where the data actually starts: its filename/extra-field lengths
    // can differ from the central directory's, so the offset must be recomputed from it.
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) continue
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const data = buffer.subarray(dataStart, dataStart + compressedSize)

    // A STORE entry is verbatim, so its size is known up front; a DEFLATE entry is bounded by
    // maxOutputLength, which makes inflateRawSync throw rather than expand a bomb into memory.
    if (method === 0 && data.length > SKILL_IMPORT_LIMITS.maxFileBytes) {
      throw new Error(
        `ZIP entry ${name} exceeds the ${SKILL_IMPORT_LIMITS.maxFileBytes}-byte limit.`
      )
    }
    const content =
      method === 0
        ? Buffer.from(data)
        : inflateRawSync(data, { maxOutputLength: SKILL_IMPORT_LIMITS.maxFileBytes })

    totalBytes += content.length
    if (totalBytes > SKILL_IMPORT_LIMITS.maxTotalBytes) {
      throw new Error(
        `ZIP bundle exceeds the ${SKILL_IMPORT_LIMITS.maxTotalBytes}-byte decompressed limit.`
      )
    }
    files.push({ path: name, content })
  }

  return files
}

export { extractZip }
