import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { z } from 'zod'
import { skillMarketplaceStableVersionPattern } from '../../shared/skill-marketplace'
import {
  isAppOwnedSkillRootFile,
  SKILL_IMPORT_LIMITS as limits
} from '../../shared/skill-import-limits'
import { parseSkillDocument } from './frontmatter'
import type { FetchedSkillFile } from './github-import'
import { marketplacePath, sha256 } from './marketplace-protocol'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const marketplaceReceiptSchema = z.strictObject({
  marketplace: z.literal('openscience-skills'),
  id: z
    .string()
    .max(128)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  version: z.string().max(128).regex(skillMarketplaceStableVersionPattern),
  // Signed catalog revision, not a transport-specific Git commit.
  snapshotId: hash,
  revision: hash,
  descriptorSha256: hash,
  artifactSha256: hash,
  contentSha256: hash,
  installedContentSha256: hash
})
export type MarketplaceReceipt = z.infer<typeof marketplaceReceiptSchema>
export type MarketplacePackage = {
  files: FetchedSkillFile[]
  receipt: Omit<MarketplaceReceipt, 'installedContentSha256'>
}

// Protocol v1 hashes exact UTF-8 path bytes and contents, with unsigned 64-bit length framing.
export function marketplaceContentDigest(files: readonly FetchedSkillFile[]): string {
  const digest = createHash('sha256').update('OpenScience Skill content digest v1\0')
  const length = (value: number): Buffer => {
    const bytes = Buffer.alloc(8)
    bytes.writeBigUInt64BE(BigInt(value))
    return bytes
  }
  for (const file of [...files].sort((a, b) =>
    Buffer.compare(Buffer.from(a.relativePath), Buffer.from(b.relativePath))
  )) {
    const path = Buffer.from(file.relativePath)
    digest
      .update(length(path.length))
      .update(path)
      .update(length(file.content.length))
      .update(file.content)
  }
  return digest.digest('hex')
}

// Published shards use ordinary, unencrypted STORE/DEFLATE ZIP records. Unlike manual imports,
// this boundary never skips a malformed, duplicate or unsupported entry. Inflation is bounded by
// actual output, not just the attacker-controlled central-directory size used by unzipSync.
export function verifyMarketplacePackage(
  bytes: Buffer,
  id: string,
  artifact: { sha256: string; bytes: number; skill_path: string },
  expected: { contentSha256: string; fileCount: number; uncompressedBytes: number }
): FetchedSkillFile[] {
  const reject = (): never => {
    throw new Error('Invalid Marketplace package')
  }
  if (
    bytes.length !== artifact.bytes ||
    bytes.length > limits.maxSkillArchiveBytes ||
    sha256(bytes) !== artifact.sha256 ||
    artifact.skill_path !== id
  )
    reject()
  let end = bytes.length - 22
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--
  if (
    end < 0 ||
    bytes.readUInt32LE(end) !== 0x06054b50 ||
    end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length
  )
    reject()
  const count = bytes.readUInt16LE(end + 10)
  const central = bytes.readUInt32LE(end + 16)
  if (
    !count ||
    count > limits.maxBundleEntries ||
    bytes.readUInt32LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 8) !== count ||
    central + bytes.readUInt32LE(end + 12) !== end
  )
    reject()
  let cursor = central
  let previousEnd = 0
  let total = 0
  const names = new Set<string>()
  const files: FetchedSkillFile[] = []
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) reject()
    const flags = bytes.readUInt16LE(cursor + 8)
    const method = bytes.readUInt16LE(cursor + 10)
    const compressed = bytes.readUInt32LE(cursor + 20)
    const expanded = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const next =
      cursor + 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32)
    const local = bytes.readUInt32LE(cursor + 42)
    const mode =
      bytes.readUInt16LE(cursor + 4) >>> 8 === 3
        ? (bytes.readUInt32LE(cursor + 38) >>> 16) & 0o170000
        : 0
    if (
      next > end ||
      flags & ~0x800 ||
      ![0, 8].includes(method) ||
      (mode !== 0 && mode !== 0o100000) ||
      bytes.readUInt16LE(cursor + 34) !== 0
    )
      reject()
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    const name = decoder.decode(rawName)
    if (
      !marketplacePath.safeParse(name).success ||
      name.split('/').length > limits.maxDepth + 1 ||
      names.has(name.toLowerCase()) ||
      expanded > limits.maxFileBytes
    )
      reject()
    names.add(name.toLowerCase())
    // The publisher emits only file entries, in local-record order; reject hidden/trailing records.
    if (
      local !== previousEnd ||
      local + 30 > central ||
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method ||
      bytes.readUInt32LE(local + 18) !== compressed ||
      bytes.readUInt32LE(local + 22) !== expanded ||
      bytes.readUInt32LE(local + 14) !== bytes.readUInt32LE(cursor + 16)
    )
      reject()
    const localNameLength = bytes.readUInt16LE(local + 26)
    const start = local + 30 + localNameLength + bytes.readUInt16LE(local + 28)
    if (
      start + compressed > central ||
      !bytes.subarray(local + 30, local + 30 + localNameLength).equals(rawName)
    )
      reject()
    const input = bytes.subarray(start, start + compressed)
    const content =
      method === 0
        ? Buffer.from(input)
        : inflateRawSync(input, {
            maxOutputLength: Math.min(limits.maxFileBytes, Math.max(1, expanded))
          })
    total += content.length
    if (content.length !== expanded || total > limits.maxBundleBytes) reject()
    const parts = name.split('/')
    if (parts.length < 2 || isAppOwnedSkillRootFile(parts.slice(1).join('/'))) reject()
    if (parts[0] === id) files.push({ relativePath: parts.slice(1).join('/'), content })
    previousEnd = start + compressed
    cursor = next
  }
  for (const name of names) {
    const parts = name.split('/')
    for (let n = 1; n < parts.length; n++) if (names.has(parts.slice(0, n).join('/'))) reject()
  }
  const document = files.find((file) => file.relativePath === 'SKILL.md')
  if (
    cursor !== end ||
    previousEnd !== central ||
    !document ||
    parseSkillDocument(decoder.decode(document.content)).name !== id ||
    files.some((file) => file.relativePath.toLowerCase().endsWith('/skill.md')) ||
    files.length !== expected.fileCount ||
    files.reduce((sum, file) => sum + file.content.length, 0) !== expected.uncompressedBytes ||
    marketplaceContentDigest(files) !== expected.contentSha256
  )
    reject()
  return files
}
