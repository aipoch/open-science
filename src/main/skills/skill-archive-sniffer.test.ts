import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import {
  inspectOuterArchive,
  isImportableSkillArchive,
  isImportableSkillArchivePath
} from './skill-archive-sniffer'
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
  it('classifies an importable Skill through an anchored reader', async () => {
    const archive = buildZip([
      {
        path: 'reader-skill/SKILL.md',
        content: Buffer.from('---\nname: Reader Skill\ndescription: From a lease.\n---\nRun it.')
      }
    ])

    await expect(
      isImportableSkillArchive({
        size: archive.byteLength,
        read: async (position, length) => archive.subarray(position, position + length)
      })
    ).resolves.toBe(true)
  })

  it('classifies a Skill under three wrapper directories', async () => {
    const archive = buildZip([
      {
        path: 'release/skills/ppt-master/SKILL.md',
        content: Buffer.from('---\nname: ppt-master\ndescription: d\n---\nRun it.')
      }
    ])

    await expectMatchesPreview(archive, true)
  })

  it('rejects an incomplete Skill under three wrapper directories', async () => {
    const archive = buildZip([
      {
        path: 'release/skills/ppt-master/SKILL.md',
        content: Buffer.from('---\nname: ppt-master\ndescription: d\n---\nRun it.')
      },
      {
        path: 'release/skills/ppt-master/unsupported.bin',
        content: Buffer.from('unsupported'),
        method: 99
      }
    ])

    await expectMatchesPreview(archive, false)
  })

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

  it('matches importer EOCD lookup when a valid bundle has trailing bytes', async () => {
    const bundle = buildZip([
      {
        path: 'trailing-data/SKILL.md',
        content: Buffer.from('---\nname: Trailing Data\n---\nBody')
      }
    ])
    const withTrailingData = Buffer.concat([bundle, Buffer.alloc(70 * 1024, 0x61)])

    await expectMatchesPreview(withTrailingData, true)
  })

  it('keeps earlier valid entries when a later central record is malformed', async () => {
    const manifestPath = 'central-tail/SKILL.md'
    const archive = buildZip([
      {
        path: manifestPath,
        content: Buffer.from('---\nname: Central Tail\n---\nBody')
      },
      { path: 'central-tail/README.md', content: Buffer.from('Ignored trailing entry') }
    ])
    const eocdOffset = archive.length - 22
    const centralOffset = archive.readUInt32LE(eocdOffset + 16)
    const secondCentralOffset = centralOffset + 46 + Buffer.byteLength(manifestPath)
    archive.writeUInt32LE(0xdeadbeef, secondCentralOffset)

    await expectMatchesPreview(archive, true)
  })

  it('classifies the current entry before an overlong central extra field stops the walk', async () => {
    const manifestPath = 'central-extra/SKILL.md'
    const rejectedPath = 'central-extra/bad.bin'
    const archive = buildZip([
      {
        path: manifestPath,
        content: Buffer.from('---\nname: Central Extra\n---\nBody')
      },
      { path: rejectedPath, content: Buffer.from('unsupported'), method: 99 }
    ])
    const eocdOffset = archive.length - 22
    const centralOffset = archive.readUInt32LE(eocdOffset + 16)
    const secondCentralOffset = centralOffset + 46 + Buffer.byteLength(manifestPath)
    archive.writeUInt16LE(0xffff, secondCentralOffset + 30)

    await expectMatchesPreview(archive, false)
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
        path: 'a/b/c/d/SKILL.md',
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

  it('rejects a nested archive when strict extraction cannot inflate a sibling', async () => {
    const manifestPath = 'SKILL.md'
    const siblingPath = 'resource.bin'
    const manifest = Buffer.from('---\nname: Broken Nested Skill\n---\nBody')
    const sibling = Buffer.from('resource')
    const inner = buildZip([
      { path: manifestPath, content: manifest, method: 0 },
      { path: siblingPath, content: sibling }
    ])
    const siblingLocalOffset = 30 + Buffer.byteLength(manifestPath) + manifest.length
    const siblingDataOffset = siblingLocalOffset + 30 + Buffer.byteLength(siblingPath)
    inner.fill(0xff, siblingDataOffset, siblingDataOffset + deflateRawSync(sibling).length)

    await expectMatchesPreview(
      buildZip([{ path: 'nested/broken.zip', content: inner, method: 0 }]),
      false
    )
    await expectMatchesPreview(buildZip([{ path: 'nested/broken.zip', content: inner }]), false)
  })

  it('rejects a nested archive with an out-of-range sibling local header', async () => {
    const manifestPath = 'SKILL.md'
    const siblingPath = 'resource.bin'
    const manifest = Buffer.from('---\nname: Out-of-range Nested Skill\n---\nBody')
    const sibling = Buffer.from('resource')
    const inner = buildZip([
      { path: manifestPath, content: manifest, method: 0 },
      { path: siblingPath, content: sibling, method: 0 }
    ])
    const centralOffset =
      30 +
      Buffer.byteLength(manifestPath) +
      manifest.length +
      30 +
      Buffer.byteLength(siblingPath) +
      sibling.length
    const siblingCentralOffset = centralOffset + 46 + Buffer.byteLength(manifestPath)
    inner.writeUInt32LE(inner.length + 1, siblingCentralOffset + 42)

    await expectMatchesPreview(
      buildZip([{ path: 'nested/out-of-range.zip', content: inner, method: 0 }]),
      false
    )
  })

  it('uses actual inflate size instead of an inner central-directory claim', async () => {
    const manifestPath = 'SKILL.md'
    const manifest = Buffer.from('---\nname: Inner Actual Size\n---\nBody')
    const compressedSize = deflateRawSync(manifest).length
    const inner = buildZip([{ path: manifestPath, content: manifest }])
    const centralOffset = 30 + Buffer.byteLength(manifestPath) + compressedSize
    inner.writeUInt32LE(51 * 1024 * 1024, centralOffset + 24)

    await expectMatchesPreview(
      buildZip([{ path: 'nested/actual-size.zip', content: inner, method: 0 }]),
      true
    )
  })

  it('matches importer clamping for an incomplete stored manifest entry', async () => {
    const manifestPath = 'SKILL.md'
    const manifest = Buffer.from('---\nname: Clamped Stored Manifest\n---\nBody')
    const inner = buildZip([{ path: manifestPath, content: manifest, method: 0 }])
    const centralOffset = 30 + Buffer.byteLength(manifestPath) + manifest.length
    inner.writeUInt32LE(inner.length, centralOffset + 20)

    await expectMatchesPreview(
      buildZip([{ path: 'nested/clamped.zip', content: inner, method: 0 }]),
      true
    )
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

  it('fails closed when a stored sibling becomes unreadable during streaming', async () => {
    const manifestPath = 'racy-stored/SKILL.md'
    const siblingPath = 'racy-stored/resource.bin'
    const manifest = Buffer.from('---\nname: Racy Stored Skill\n---\nBody')
    const sibling = incompressibleBytes(256 * 1024)
    const archive = buildZip([
      { path: manifestPath, content: manifest, method: 0 },
      { path: siblingPath, content: sibling, method: 0 }
    ])
    const siblingLocalOffset = 30 + Buffer.byteLength(manifestPath) + manifest.length
    const siblingDataOffset = siblingLocalOffset + 30 + Buffer.byteLength(siblingPath)
    let siblingReads = 0

    await expect(
      inspectOuterArchive({
        size: archive.length,
        read: async (position, length) => {
          if (position === siblingDataOffset || position === siblingDataOffset + 64 * 1024) {
            siblingReads += 1
            if (siblingReads === 2) throw new Error('file truncated during stored read')
          }
          if (position < 0 || length < 0 || position + length > archive.length) return undefined
          return archive.subarray(position, position + length)
        }
      })
    ).resolves.toBe(false)
    expect(siblingReads).toBe(2)
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

  it('rejects a loose root when a sibling has a malformed local header', async () => {
    const manifestPath = 'broken/SKILL.md'
    const manifest = Buffer.from('---\nname: Broken Resource Skill\n---\nBody')
    const archive = buildZip([
      { path: manifestPath, content: manifest, method: 0 },
      { path: 'broken/resource.txt', content: Buffer.from('resource'), method: 0 }
    ])
    const siblingLocalOffset = 30 + Buffer.byteLength(manifestPath) + manifest.length
    archive.writeUInt32LE(0, siblingLocalOffset)

    await expectMatchesPreview(archive, false)
  })

  it('rejects a loose root when a sibling cannot be inflated', async () => {
    const manifestPath = 'broken/SKILL.md'
    const siblingPath = 'broken/resource.txt'
    const manifest = Buffer.from('---\nname: Broken Deflate Skill\n---\nBody')
    const sibling = Buffer.from('resource')
    const archive = buildZip([
      { path: manifestPath, content: manifest, method: 0 },
      { path: siblingPath, content: sibling }
    ])
    const siblingLocalOffset = 30 + Buffer.byteLength(manifestPath) + manifest.length
    const siblingDataOffset = siblingLocalOffset + 30 + Buffer.byteLength(siblingPath)
    archive.fill(0xff, siblingDataOffset, siblingDataOffset + deflateRawSync(sibling).length)

    await expectMatchesPreview(archive, false)
  })

  it('uses the actual inflated sibling size for loose-root caps', async () => {
    const manifestPath = 'actual-size/SKILL.md'
    const siblingPath = 'actual-size/resource.txt'
    const manifest = Buffer.from('---\nname: Actual Size Skill\n---\nBody')
    const sibling = Buffer.from('small resource')
    const archive = buildZip([
      { path: manifestPath, content: manifest, method: 0 },
      { path: siblingPath, content: sibling }
    ])
    const siblingCompressedSize = deflateRawSync(sibling).length
    const centralOffset =
      30 +
      Buffer.byteLength(manifestPath) +
      manifest.length +
      30 +
      Buffer.byteLength(siblingPath) +
      siblingCompressedSize
    const siblingCentralOffset = centralOffset + 46 + Buffer.byteLength(manifestPath)
    archive.writeUInt32LE(65 * 1024 * 1024, siblingCentralOffset + 24)

    await expectMatchesPreview(archive, true)
  })

  it('does not count malformed local entries against the outer file cap', async () => {
    const malformed = Array.from({ length: 4_096 }, (_, index): ZipInput => ({
      path: `malformed-${index.toString().padStart(4, '0')}.txt`,
      content: Buffer.alloc(0),
      method: 0
    }))
    const manifestPath = 'after-malformed/SKILL.md'
    const archive = buildZip([
      ...malformed,
      {
        path: manifestPath,
        content: Buffer.from('---\nname: After Malformed Entries\n---\nBody'),
        method: 0
      }
    ])
    let localOffset = 0
    for (const input of malformed) {
      archive.writeUInt32LE(0, localOffset)
      localOffset += 30 + Buffer.byteLength(input.path)
    }

    await expectMatchesPreview(archive, true)
  })

  it('fails closed when cumulative attempted inflate output exhausts its work budget', async () => {
    const archive = buildZip([
      { path: 'first.bin', content: Buffer.alloc(48 * 1024, 97) },
      { path: 'second.bin', content: Buffer.alloc(48 * 1024, 98) },
      {
        path: 'after-work/SKILL.md',
        content: Buffer.from('---\nname: After Inflate Work\n---\nBody')
      }
    ])
    const reader = (): {
      size: number
      read: (position: number, length: number) => Promise<Buffer | undefined>
    } => ({
      size: archive.length,
      read: async (position: number, length: number): Promise<Buffer | undefined> => {
        if (position < 0 || length < 0 || position + length > archive.length) return undefined
        return archive.subarray(position, position + length)
      }
    })

    await expect(inspectOuterArchive(reader())).resolves.toBe(true)
    await expect(inspectOuterArchive(reader(), 64 * 1024)).resolves.toBe(false)
  })

  it('stops the second deflated manifest inflate after the frontmatter closes', async () => {
    const archive = buildZip([
      {
        path: 'large-body/SKILL.md',
        content: Buffer.concat([
          Buffer.from('---\nname: Large Body\n---\n'),
          Buffer.alloc(96 * 1024, 97)
        ])
      }
    ])
    const reader = (): {
      size: number
      read: (position: number, length: number) => Promise<Buffer | undefined>
    } => ({
      size: archive.length,
      read: async (position: number, length: number): Promise<Buffer | undefined> => {
        if (position < 0 || length < 0 || position + length > archive.length) return undefined
        return archive.subarray(position, position + length)
      }
    })

    // Full entry validation consumes about 96 KiB. The frontmatter-only reread fits in the remaining
    // budget, while re-inflating the whole manifest body a second time would exhaust it.
    await expect(inspectOuterArchive(reader(), 128 * 1024)).resolves.toBe(true)
  })

  it('reserves a separate bounded pass for manifest classification after entry validation', async () => {
    const archive = buildZip([
      {
        path: 'near-validation-cap/SKILL.md',
        content: Buffer.concat([
          Buffer.from('---\nname: Near Validation Cap\n---\n'),
          Buffer.alloc(120 * 1024, 97)
        ])
      }
    ])
    const reader = (): {
      size: number
      read: (position: number, length: number) => Promise<Buffer | undefined>
    } => ({
      size: archive.length,
      read: async (position: number, length: number): Promise<Buffer | undefined> => {
        if (position < 0 || length < 0 || position + length > archive.length) return undefined
        return archive.subarray(position, position + length)
      }
    })

    // Validation legitimately consumes almost this entire phase budget. Classification gets a fresh
    // budget of the same size instead of double-charging the accepted manifest entry.
    await expect(inspectOuterArchive(reader(), 128 * 1024)).resolves.toBe(true)
  })

  it('fails closed when cumulative stored-entry reads exhaust its work budget', async () => {
    const archive = buildZip([
      { path: 'first.bin', content: Buffer.alloc(48 * 1024, 97), method: 0 },
      { path: 'second.bin', content: Buffer.alloc(48 * 1024, 98), method: 0 },
      {
        path: 'after-reads/SKILL.md',
        content: Buffer.from('---\nname: After Stored Reads\n---\nBody'),
        method: 0
      }
    ])
    const reader = (): {
      size: number
      read: (position: number, length: number) => Promise<Buffer | undefined>
    } => ({
      size: archive.length,
      read: async (position: number, length: number): Promise<Buffer | undefined> => {
        if (position < 0 || length < 0 || position + length > archive.length) return undefined
        return archive.subarray(position, position + length)
      }
    })

    await expect(inspectOuterArchive(reader())).resolves.toBe(true)
    await expect(inspectOuterArchive(reader(), 64 * 1024)).resolves.toBe(false)
  })

  it('rejects an early named root when later manifest work exhausts the budget', async () => {
    const archive = buildZip([
      {
        path: 'a/SKILL.md',
        content: Buffer.from('---\nname: Early Named Root\n---\nBody'),
        method: 0
      },
      {
        path: 'b/SKILL.md',
        content: Buffer.concat([
          Buffer.from('---\ndescription: no name\n---\n'),
          Buffer.alloc(48 * 1024, 97)
        ])
      }
    ])
    const reader = (): {
      size: number
      read: (position: number, length: number) => Promise<Buffer | undefined>
    } => ({
      size: archive.length,
      read: async (position: number, length: number): Promise<Buffer | undefined> => {
        if (position < 0 || length < 0 || position + length > archive.length) return undefined
        return archive.subarray(position, position + length)
      }
    })

    await expect(inspectOuterArchive(reader())).resolves.toBe(true)
    await expect(inspectOuterArchive(reader(), 32 * 1024)).resolves.toBe(false)
  })

  it('rejects an early named nested root when later manifest work exhausts the budget', async () => {
    const inner = buildZip([
      {
        path: 'a/SKILL.md',
        content: Buffer.from('---\nname: Early Nested Root\n---\nBody'),
        method: 0
      },
      {
        path: 'b/SKILL.md',
        content: Buffer.concat([
          Buffer.from('---\ndescription: no name\n---\n'),
          Buffer.alloc(48 * 1024, 97)
        ])
      }
    ])
    const archive = buildZip([{ path: 'nested.zip', content: inner, method: 0 }])
    const reader = (): {
      size: number
      read: (position: number, length: number) => Promise<Buffer | undefined>
    } => ({
      size: archive.length,
      read: async (position: number, length: number): Promise<Buffer | undefined> => {
        if (position < 0 || length < 0 || position + length > archive.length) return undefined
        return archive.subarray(position, position + length)
      }
    })

    await expect(inspectOuterArchive(reader())).resolves.toBe(true)
    await expect(inspectOuterArchive(reader(), 64 * 1024)).resolves.toBe(false)
  })

  it('shares attempted inflate work across standalone nested archives', async () => {
    const first = buildZip([{ path: 'first.bin', content: Buffer.alloc(48 * 1024, 97) }])
    const second = buildZip([{ path: 'second.bin', content: Buffer.alloc(48 * 1024, 98) }])
    const valid = buildZip([
      {
        path: 'SKILL.md',
        content: Buffer.from('---\nname: After Nested Work\n---\nBody'),
        method: 0
      }
    ])
    const archive = buildZip([
      { path: 'first.zip', content: first, method: 0 },
      { path: 'second.zip', content: second, method: 0 },
      { path: 'valid.zip', content: valid, method: 0 }
    ])
    const reader = (): {
      size: number
      read: (position: number, length: number) => Promise<Buffer | undefined>
    } => ({
      size: archive.length,
      read: async (position: number, length: number): Promise<Buffer | undefined> => {
        if (position < 0 || length < 0 || position + length > archive.length) return undefined
        return archive.subarray(position, position + length)
      }
    })

    await expect(inspectOuterArchive(reader())).resolves.toBe(true)
    await expect(inspectOuterArchive(reader(), 64 * 1024)).resolves.toBe(false)
  })
})
