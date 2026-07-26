import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { isImportableSkillArchivePath } from './skill-archive-sniffer'
import { UserSkillRepository } from './user-skill-repository'

type ZipInput = { path: string; content: Buffer; method?: 0 | 8 }

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
    const compressed = method === 0 ? input.content : deflateRawSync(input.content)
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

  it('accepts importer-supported candidate counts and manifest sizes', async () => {
    const candidates = Array.from({ length: 33 }, (_, index) => ({
      path: `skill-${index.toString().padStart(2, '0')}/SKILL.md`,
      content: Buffer.from(
        index === 32 ? '---\nname: Candidate 33\n---\nBody' : '---\ndescription: no name\n---\nBody'
      )
    }))
    const largeManifest = Buffer.concat([
      Buffer.from('---\nname: Large Manifest\n---\n'),
      Buffer.alloc(512 * 1024 + 1, 97)
    ])

    await expectMatchesPreview(buildZip(candidates), true)
    await expectMatchesPreview(buildZip([{ path: 'large/SKILL.md', content: largeManifest }]), true)
  })
})
