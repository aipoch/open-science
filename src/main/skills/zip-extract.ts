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

// One entry the lenient extractor declined to unpack, with a plain-English reason (for surfacing to
// the user as a skipped item rather than failing the whole import).
export type SkippedZipEntry = { path: string; reason: string }

// The lenient extractor's outcome: the entries it did unpack, plus the ones it skipped and why.
export type LenientExtractOutcome = { files: ExtractedZipFile[]; skipped: SkippedZipEntry[] }

// Caps the lenient extractor enforces per call. Split out so the OUTER bundle walk can allow larger
// single entries (nested skill archives) than the per-file cap used for a single skill's own files.
export type LenientExtractLimits = {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
  maxDepth: number
}

// Rounds a byte count to whole MB for a user-facing size-limit reason.
const mb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`

// Rejects paths that would escape the extraction root (zip-slip) or aren't real bundle files.
const isUnsafePath = (path: string): boolean => {
  if (path.length === 0) return true
  // ZIP entry names are required to use forward slashes. A backslash is never legitimate and is a
  // known zip-slip vector on Windows (where `\` is a real separator), so reject the raw name rather
  // than normalizing it — normalizing would also silently collapse `a\b` and `a/b` onto one target.
  if (path.includes('\\')) return true
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

    // Bound directory nesting the same way the GitHub walk does. Depth counts directory levels, not
    // the file itself, so `a/b/.../file` with N leading directories matches GitHub's "N deep".
    if (name.split('/').length - 1 > SKILL_IMPORT_LIMITS.maxDepth) {
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

// Lenient sibling of extractZip: instead of throwing when a single entry violates a cap, it SKIPS that
// entry (recording a plain-English reason) and keeps going, so one oversized/unsupported/too-deep
// entry can't sink an otherwise-importable bundle. Only a structurally invalid archive (no central
// directory) still throws. Used for the OUTER walk of a multi-skill bundle, where each entry is
// either a nested skill archive or a loose skill file and failures should be reported, not fatal.
const extractZipLenient = (buffer: Buffer, limits: LenientExtractLimits): LenientExtractOutcome => {
  const eocd = findEocd(buffer)
  if (eocd < 0) throw new Error('Not a valid ZIP archive.')

  const entryCount = buffer.readUInt16LE(eocd + 10)
  let pointer = buffer.readUInt32LE(eocd + 16)
  const files: ExtractedZipFile[] = []
  const skipped: SkippedZipEntry[] = []
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

    // Directory records and archive metadata carry no importable content — drop them silently.
    if (name.endsWith('/')) continue
    if (isUnsafePath(name)) {
      // Metadata entries were never part of a skill. Real unsafe paths, though, must be recorded so a
      // loose skill root that owned one is rejected instead of imported silently incomplete.
      if (!name.startsWith('__MACOSX/') && !name.startsWith('.')) {
        skipped.push({ path: name, reason: 'unsafe path' })
      }
      continue
    }
    if (method !== 0 && method !== 8) {
      skipped.push({ path: name, reason: 'unsupported compression method' })
      continue
    }
    if (name.split('/').length - 1 > limits.maxDepth) {
      skipped.push({ path: name, reason: `nested deeper than ${limits.maxDepth} levels` })
      continue
    }
    if (files.length >= limits.maxFiles) {
      skipped.push({ path: name, reason: `bundle has too many entries (limit ${limits.maxFiles})` })
      continue
    }

    // Read the local header to find where the data starts. A malformed/out-of-range offset must be
    // RECORDED as skipped, never left to throw a RangeError (which would abort the whole bundle) and
    // never silently dropped (which would let a loose skill root import missing this file).
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      skipped.push({ path: name, reason: 'malformed local header' })
      continue
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + compressedSize > buffer.length) {
      skipped.push({ path: name, reason: 'entry data extends past end of archive' })
      continue
    }
    const data = buffer.subarray(dataStart, dataStart + compressedSize)

    // For a STORE entry the decompressed size is known up front, so an oversized one is skipped
    // WITHOUT copying its bytes into memory (the common case for a nested, already-compressed .zip).
    if (method === 0 && data.length > limits.maxFileBytes) {
      skipped.push({ path: name, reason: `too large (limit ${mb(limits.maxFileBytes)})` })
      continue
    }
    let content: Buffer
    try {
      content =
        method === 0
          ? Buffer.from(data)
          : inflateRawSync(data, { maxOutputLength: limits.maxFileBytes })
    } catch {
      // A DEFLATE entry that would expand past maxFileBytes throws here (a bomb): skip it.
      skipped.push({ path: name, reason: `too large (limit ${mb(limits.maxFileBytes)})` })
      continue
    }

    if (totalBytes + content.length > limits.maxTotalBytes) {
      skipped.push({ path: name, reason: `bundle exceeds the ${mb(limits.maxTotalBytes)} limit` })
      continue
    }
    totalBytes += content.length
    files.push({ path: name, content })
  }

  return { files, skipped }
}

export { extractZip, extractZipLenient }
