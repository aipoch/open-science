import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { inspectOuterArchive, isImportableSkillArchivePath } from './skill-archive-sniffer'
import { UserSkillRepository } from './user-skill-repository'

type ZipInput = { path: string; content: Buffer; method?: number }

const crc32 = (buffer: Buffer): number => {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    let current = (crc ^ buffer[index]) & 0xff
    for (let bit = 0; bit < 8; bit += 1) {
      current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1
    }
    crc = (crc >>> 8) ^ current
  }
  return (crc ^ 0xffffffff) >>> 0
}

const buildZip = (inputs: ZipInput[]): Buffer => {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const input of inputs) {
    const method = input.method ?? 8
    const name = Buffer.from(input.path, 'utf8')
    const compressed = method === 8 ? deflateRawSync(input.content) : input.content
    const checksum = crc32(input.content)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(input.content.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    locals.push(local, compressed)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(input.content.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)
    offset += local.length + compressed.length
  }

  const localBytes = Buffer.concat(locals)
  const centralBytes = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(inputs.length, 8)
  eocd.writeUInt16LE(inputs.length, 10)
  eocd.writeUInt32LE(centralBytes.length, 12)
  eocd.writeUInt32LE(localBytes.length, 16)
  return Buffer.concat([localBytes, centralBytes, eocd])
}

const inspect = async (archive: Buffer): Promise<boolean> => {
  const root = await mkdtemp(join(tmpdir(), 'skill-archive-sniff-'))
  const filePath = join(root, 'bundle.zip')
  await writeFile(filePath, archive)

  try {
    return await isImportableSkillArchivePath(filePath)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const expectMatchesPreview = async (archive: Buffer, expected: boolean): Promise<void> => {
  const storage = await mkdtemp(join(tmpdir(), 'skill-archive-preview-'))
  try {
    const preview = await new UserSkillRepository(storage).previewZip(archive)
    await expect(inspect(archive)).resolves.toBe(expected)
    expect(preview.previews.length > 0).toBe(expected)
  } finally {
    await rm(storage, { recursive: true, force: true })
  }
}

const incompressibleBytes = (size: number): Buffer => {
  const bytes = Buffer.allocUnsafe(size)
  let state = 0x12345678
  for (let index = 0; index < size; index += 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    bytes[index] = state & 0xff
  }
  return bytes
}

describe('isImportableSkillArchivePath', () => {
  it('finds a named Skill manifest without inflating unrelated large entries', async () => {
    const archive = buildZip([
      { path: 'paper-finder/assets/model.bin', content: Buffer.alloc(2 * 1024 * 1024), method: 0 },
      {
        path: 'paper-finder/SKILL.md',
        content: Buffer.from('---\nname: Paper Finder\ndescription: Finds papers.\n---\nRun it.')
      }
    ])

    await expect(inspect(archive)).resolves.toBe(true)
  })

  it('rejects ordinary, unnamed, and corrupt archives', async () => {
    const ordinary = buildZip([{ path: 'README.md', content: Buffer.from('dataset archive') }])
    const unnamed = buildZip([
      { path: 'SKILL.md', content: Buffer.from('---\ndescription: Missing name.\n---\nBody') }
    ])
    await expect(inspect(ordinary)).resolves.toBe(false)
    await expect(inspect(unnamed)).resolves.toBe(false)
    await expect(inspect(Buffer.from('not a zip'))).resolves.toBe(false)
  })

  it('does not classify an ordinary ZIP by a nested filename or an ineligible deep manifest', async () => {
    const nestedFilename = buildZip([
      {
        path: 'bundles/paper-finder.skill',
        content: Buffer.from('nested archive bytes'),
        method: 0
      }
    ])
    const deepManifest = buildZip([
      {
        path: 'a/b/c/SKILL.md',
        content: Buffer.from('---\nname: Too Deep\ndescription: hidden\n---\nBody')
      }
    ])

    await expect(inspect(nestedFilename)).resolves.toBe(false)
    await expect(inspect(deepManifest)).resolves.toBe(false)
  })

  it('uses the same shallowest-root selection as full bundle discovery', async () => {
    const archive = buildZip([
      {
        path: 'a/SKILL.md',
        content: Buffer.from('---\ndescription: Missing name.\n---\nBody')
      },
      {
        path: 'a/b/SKILL.md',
        content: Buffer.from('---\nname: Hidden Nested Skill\n---\nBody')
      }
    ])

    await expectMatchesPreview(archive, false)
  })

  it('recognizes one importer-supported level of nested Skill archive', async () => {
    const inner = buildZip([
      {
        path: 'SKILL.md',
        content: Buffer.from('---\nname: Nested Skill\ndescription: nested\n---\nBody')
      }
    ])
    const storedOuter = buildZip([{ path: 'nested/alpha.zip', content: inner, method: 0 }])
    const deflatedOuter = buildZip([{ path: 'nested/alpha.zip', content: inner }])

    await expectMatchesPreview(storedOuter, true)
    await expectMatchesPreview(deflatedOuter, true)
  })

  it('streams raw central records that the importer does not count as files', async () => {
    const directories = Array.from({ length: 5_000 }, (_, index): ZipInput => ({
      path: `metadata-${index}/`,
      content: Buffer.alloc(0),
      method: 0
    }))
    const archive = buildZip([
      ...directories,
      {
        path: 'valid/SKILL.md',
        content: Buffer.from('---\nname: Valid After Directories\n---\nBody')
      }
    ])

    await expectMatchesPreview(archive, true)
  })

  it('fails closed when a deflated entry becomes unreadable during streaming', async () => {
    const path = 'racy/SKILL.md'
    const archive = buildZip([
      {
        path,
        content: Buffer.concat([
          Buffer.from('---\nname: Racy Skill\n---\n'),
          incompressibleBytes(256 * 1024)
        ])
      }
    ])
    const dataOffset = 30 + Buffer.byteLength(path)
    let dataReads = 0

    await expect(
      inspectOuterArchive({
        size: archive.length,
        read: async (position, length) => {
          if (position === dataOffset || position === dataOffset + 64 * 1024) {
            dataReads += 1
            if (dataReads === 2) throw new Error('file truncated during read')
          }
          if (position < 0 || length < 0 || position + length > archive.length) return undefined
          return archive.subarray(position, position + length)
        }
      })
    ).resolves.toBe(false)
    expect(dataReads).toBe(2)
  })

  it('accepts importer-supported candidate counts and manifest sizes', async () => {
    const candidates = Array.from({ length: 33 }, (_, index) => ({
      path: `skill-${index.toString().padStart(2, '0')}/SKILL.md`,
      content: Buffer.from(
        index === 32 ? '---\nname: Candidate 33\n---\nBody' : '---\ndescription: no name\n---\nBody'
      )
    }))
    const largeManifest = Buffer.concat([
      Buffer.from('---\nname: Large Manifest\n---\n'),
      Buffer.alloc(8 * 1024 * 1024, 97)
    ])
    const largeDeflatedManifest = Buffer.concat([
      Buffer.from('---\nname: Large Deflated Manifest\n---\n'),
      Buffer.alloc(8 * 1024 * 1024, 98)
    ])
    const largeFrontmatter = Buffer.concat([
      Buffer.from('---\nname: Large Frontmatter\ndescription: |\n  '),
      Buffer.alloc(4 * 1024 * 1024 + 1, 97),
      Buffer.from('\n---\nBody')
    ])

    await expectMatchesPreview(buildZip(candidates), true)
    await expectMatchesPreview(
      buildZip([{ path: 'large/SKILL.md', content: largeManifest, method: 0 }]),
      true
    )
    await expectMatchesPreview(
      buildZip([{ path: 'large-deflated/SKILL.md', content: largeDeflatedManifest }]),
      true
    )
    await expectMatchesPreview(
      buildZip([{ path: 'large-frontmatter/SKILL.md', content: largeFrontmatter }]),
      true
    )
    await expectMatchesPreview(
      buildZip([
        {
          path: 'cr-only/SKILL.md',
          content: Buffer.from('---\rname: CR-only Manifest\r---\rBody')
        }
      ]),
      true
    )
  })

  it('does not charge rejected loose roots against the nested candidate budget', async () => {
    const rejectedLooseRoots = Array.from({ length: 256 }, (_, index): ZipInput[] => [
      {
        path: `rejected-${index.toString().padStart(3, '0')}/SKILL.md`,
        content: Buffer.from(`---\nname: Rejected ${index}\n---\nBody`)
      },
      {
        path: `rejected-${index.toString().padStart(3, '0')}/unsupported.bin`,
        content: Buffer.from('cannot import'),
        method: 99
      }
    ]).flat()
    const nestedSkill = buildZip([
      {
        path: 'SKILL.md',
        content: Buffer.from('---\nname: Nested After Rejections\n---\nBody')
      }
    ])

    await expectMatchesPreview(
      buildZip([...rejectedLooseRoots, { path: 'zz-valid.zip', content: nestedSkill, method: 0 }]),
      true
    )
  })
})
