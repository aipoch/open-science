import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { gunzip, inflateRaw } from 'node:zlib'
import {
  isPortableResearchReproductionPath,
  validateResearchReproductionArchiveEntries,
  type ResearchReproductionArchiveEntry
} from '../../shared/research-reproduction'

const expandGzip = promisify(gunzip)
const expandDeflate = promisify(inflateRaw)
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
export type PreparedResearchEntry = ResearchReproductionArchiveEntry & { content?: Buffer }
export type ResearchArchiveLimits = { maxExpandedBytes: number; maxEntries: number }
export const researchMaterialEntryMetadata = (
  entry: PreparedResearchEntry
): ResearchReproductionArchiveEntry =>
  entry.type === 'directory'
    ? { path: entry.path, type: entry.type }
    : { path: entry.path, type: entry.type, sizeBytes: entry.sizeBytes, sha256: entry.sha256 }
const reject = (message: string): never => {
  throw new Error(`Research material archive: ${message}`)
}
const digest = (value: Buffer): string => createHash('sha256').update(value).digest('hex')

export const validateResearchMaterialPaths = (entries: PreparedResearchEntry[]): void => {
  if (
    entries.some(
      ({ path }) => !isPortableResearchReproductionPath(path) || path.normalize('NFC') !== path
    )
  )
    reject('a path is not a portable NFC relative path.')
  const result = validateResearchReproductionArchiveEntries(
    entries.map(researchMaterialEntryMetadata)
  )
  if (result.status !== 'valid') reject('duplicate, colliding or invalid paths.')
}

const entry = (path: string, directory: boolean, content: Buffer): PreparedResearchEntry => {
  if (directory) {
    if (content.length) reject('directory has a payload.')
    return { path, type: 'directory' }
  }
  return { path, type: 'file', sizeBytes: content.length, sha256: digest(content), content }
}

const readTar = (bytes: Buffer, limits: ResearchArchiveLimits): PreparedResearchEntry[] => {
  if (bytes.length % 512 || bytes.length < 1024) reject('invalid tar framing.')
  let cursor = 0
  let total = 0
  const entries: PreparedResearchEntry[] = []
  const field = (header: Buffer, offset: number, length: number): string => {
    const value = header.subarray(offset, offset + length)
    const zero = value.indexOf(0)
    if (zero >= 0 && value.subarray(zero).some((byte) => byte !== 0))
      reject('ambiguous tar string field.')
    return decoder.decode(zero < 0 ? value : value.subarray(0, zero))
  }
  const octal = (header: Buffer, offset: number, length: number): number => {
    if (header.subarray(offset, offset + length).some((byte) => byte > 127))
      reject('unsupported tar numeric encoding.')
    const value = header.subarray(offset, offset + length).toString('ascii')
    if (!/^[ 0-7]*[\0 ]*$/u.test(value)) reject('unsupported tar numeric field.')
    const number = parseInt(value.replace(/[\0 ]+$/u, '').trim() || '0', 8)
    if (!Number.isSafeInteger(number)) reject('oversized tar number.')
    return number
  }
  while (cursor + 512 <= bytes.length) {
    const header = bytes.subarray(cursor, cursor + 512)
    if (header.every((byte) => byte === 0)) {
      if (bytes.length - cursor < 1024 || bytes.subarray(cursor).some((byte) => byte !== 0))
        reject('missing tar terminator or trailing records.')
      if (!entries.length) reject('archive is empty.')
      return entries
    }
    if (entries.length >= limits.maxEntries) reject('entry limit exceeded.')
    if (
      !header.subarray(257, 263).equals(Buffer.from('ustar\0')) ||
      !header.subarray(263, 265).equals(Buffer.from('00'))
    )
      reject('only portable USTAR headers are supported.')
    const expected = octal(header, 148, 8)
    let checksum = 0
    for (let index = 0; index < 512; index++)
      checksum += index >= 148 && index < 156 ? 32 : header[index]
    if (checksum !== expected) reject('tar header checksum mismatch.')
    const type = header[156]
    if (type !== 0 && type !== 48 && type !== 53)
      reject('links, special files and tar metadata extensions are unsupported.')
    if (field(header, 157, 100)) reject('tar link target is present.')
    const directory = type === 53
    const size = octal(header, 124, 12)
    total += size
    if (total > limits.maxExpandedBytes) reject('expanded byte limit exceeded.')
    const start = cursor + 512
    const next = start + Math.ceil(size / 512) * 512
    if (next > bytes.length || bytes.subarray(start + size, next).some((byte) => byte !== 0))
      reject('truncated tar content or nonzero padding.')
    const prefix = field(header, 345, 155)
    let path = [prefix, field(header, 0, 100)].filter(Boolean).join('/')
    if (directory && path.endsWith('/')) path = path.slice(0, -1)
    entries.push(entry(path, directory, bytes.subarray(start, start + size)))
    cursor = next
  }
  return reject('missing tar terminator.')
}

const crc32 = (bytes: Buffer): number => {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// Accept the ordinary unencrypted STORE/DEFLATE subset, without ZIP64, descriptors or metadata
// extensions. Local and central records must agree; no hidden/trailing entries are ignored.
const readZip = async (
  bytes: Buffer,
  limits: ResearchArchiveLimits,
  signal?: AbortSignal
): Promise<PreparedResearchEntry[]> => {
  if (bytes.length < 22) reject('truncated zip.')
  let end = bytes.length - 22
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--
  if (
    end < 0 ||
    bytes.readUInt32LE(end) !== 0x06054b50 ||
    end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length
  )
    reject('invalid zip terminator.')
  const count = bytes.readUInt16LE(end + 10)
  const central = bytes.readUInt32LE(end + 16)
  if (
    !count ||
    count > limits.maxEntries ||
    count === 0xffff ||
    bytes.readUInt32LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 8) !== count ||
    central + bytes.readUInt32LE(end + 12) !== end
  )
    reject('unsupported zip directory.')
  let cursor = central
  let previousEnd = 0
  let total = 0
  const entries: PreparedResearchEntry[] = []
  for (let index = 0; index < count; index++) {
    signal?.throwIfAborted()
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50)
      reject('invalid zip central entry.')
    const flags = bytes.readUInt16LE(cursor + 8)
    const method = bytes.readUInt16LE(cursor + 10)
    const checksum = bytes.readUInt32LE(cursor + 16)
    const compressed = bytes.readUInt32LE(cursor + 20)
    const expanded = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const next = cursor + 46 + nameLength + extraLength + bytes.readUInt16LE(cursor + 32)
    const local = bytes.readUInt32LE(cursor + 42)
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16
    const fileType = mode & 0o170000
    if (
      next > end ||
      flags & ~0x800 ||
      ![0, 8].includes(method) ||
      extraLength ||
      ![0, 0o100000, 0o040000].includes(fileType) ||
      bytes.readUInt16LE(cursor + 34) !== 0
    )
      reject('links, encryption, special files or zip extensions are unsupported.')
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    const rawPath = decoder.decode(name)
    const directory = rawPath.endsWith('/')
    const dosDirectory = (bytes.readUInt32LE(cursor + 38) & 0x10) !== 0
    if (
      (fileType === 0o040000 && !directory) ||
      (fileType === 0o100000 && directory) ||
      (dosDirectory && !directory)
    )
      reject('zip entry type disagrees with its name.')
    total += expanded
    if (total > limits.maxExpandedBytes) reject('expanded byte limit exceeded.')
    if (
      local !== previousEnd ||
      local + 30 > central ||
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method ||
      bytes.readUInt32LE(local + 14) !== checksum ||
      bytes.readUInt32LE(local + 18) !== compressed ||
      bytes.readUInt32LE(local + 22) !== expanded ||
      bytes.readUInt16LE(local + 28) !== 0
    )
      reject('zip local entry does not match its directory.')
    const localNameLength = bytes.readUInt16LE(local + 26)
    const start = local + 30 + localNameLength
    if (start + compressed > central || !bytes.subarray(local + 30, start).equals(name))
      reject('zip name or payload mismatch.')
    const input = bytes.subarray(start, start + compressed)
    const content =
      method === 0 ? input : await expandDeflate(input, { maxOutputLength: Math.max(1, expanded) })
    signal?.throwIfAborted()
    if (content.length !== expanded || crc32(content) !== checksum)
      reject('zip content size or checksum mismatch.')
    entries.push(entry(directory ? rawPath.slice(0, -1) : rawPath, directory, content))
    previousEnd = start + compressed
    cursor = next
  }
  if (cursor !== end || previousEnd !== central) reject('hidden zip records.')
  return entries
}

export const inspectResearchMaterialArchive = async (
  bytes: Buffer,
  format: 'tar' | 'tar.gz' | 'zip',
  limits: ResearchArchiveLimits,
  signal?: AbortSignal
): Promise<PreparedResearchEntry[]> => {
  signal?.throwIfAborted()
  // Tar framing is bounded independently of claimed file sizes, including directories/padding.
  const tarLimit = limits.maxExpandedBytes + limits.maxEntries * 1024 + 1024
  const payload =
    format === 'tar.gz' ? await expandGzip(bytes, { maxOutputLength: tarLimit }) : bytes
  signal?.throwIfAborted()
  if (format !== 'zip' && payload.length > tarLimit) reject('tar framing limit exceeded.')
  const entries =
    format === 'zip' ? await readZip(payload, limits, signal) : readTar(payload, limits)
  validateResearchMaterialPaths(entries)
  return entries
}
