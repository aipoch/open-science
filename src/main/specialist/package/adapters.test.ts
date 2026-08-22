import { link, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import {
  SPECIALIST_PACKAGE_ARCHIVE_LIMITS,
  type SpecialistPackageCatalogSnapshot
} from '../../../shared/specialist-package'
import { validateSpecialistDirectory } from './directory-adapter'
import { validateSpecialistZip } from './zip-adapter'
import { UserSkillSpecialistPackageAdapter } from '../../skills/specialist-package-adapter'

const fixtureRoot = join(import.meta.dirname, 'test-fixtures', 'valid')
const invalidFixtureRoot = join(import.meta.dirname, 'test-fixtures', 'invalid')
const multiErrorFixtureRoot = join(import.meta.dirname, 'test-fixtures', 'multi-error')
const encoder = new TextEncoder()
const catalog: SpecialistPackageCatalogSnapshot = {
  appVersion: '0.9.2',
  builtinSkills: [],
  skills: [],
  connectorIds: [],
  protectedSpecialistIds: ['reviewer']
}

describe('Specialist package source adapters', () => {
  it('reads a complete stable Skill directory for export without sidecar metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'specialist-export-snapshot-'))
    try {
      const skill = join(root, 'skills', 'personal', 'analysis-tools')
      await mkdir(join(skill, 'references'), { recursive: true })
      await writeFile(
        join(skill, 'SKILL.md'),
        '---\nname: analysis-tools\ndescription: Analyze data\n---\nUse the tools.'
      )
      await writeFile(join(skill, 'references', 'guide.md'), 'Complete reference.')
      await writeFile(
        join(skill, '.specialist-package.json'),
        JSON.stringify({
          id: 'analysis-tools',
          version: '1.2.3',
          contentHash: 'stale-sidecar-hash',
          standalone: false,
          ownerIds: ['research-synth']
        })
      )

      const adapter = new UserSkillSpecialistPackageAdapter(root)
      const snapshot = await adapter.exportSnapshot(['analysis-tools'])

      expect(snapshot).toEqual([
        expect.objectContaining({
          localId: 'analysis-tools',
          name: 'analysis-tools',
          version: '1.2.3',
          files: [
            expect.objectContaining({ path: 'references/guide.md' }),
            expect.objectContaining({ path: 'SKILL.md' })
          ]
        })
      ])
      expect(snapshot[0].files.map((file) => file.path)).not.toContain('.specialist-package.json')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('exports a Personal Skill with its immutable name instead of the storage source prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'specialist-export-snapshot-'))
    try {
      const skill = join(root, 'skills', 'personal', 'literature-review')
      await mkdir(skill, { recursive: true })
      await writeFile(
        join(skill, 'SKILL.md'),
        '---\nname: literature-review\ndescription: Review literature\n---\nReview.'
      )

      const adapter = new UserSkillSpecialistPackageAdapter(root)
      const snapshot = await adapter.exportSnapshot(['personal-literature-review'])

      expect(snapshot).toEqual([
        expect.objectContaining({
          localId: 'personal-literature-review',
          name: 'literature-review'
        })
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects ZIP entries marked as symbolic links', async () => {
    const zip = zipSync({
      'manifest.json': new Uint8Array(await readFile(join(fixtureRoot, 'manifest.json'))),
      'specialist.json': new Uint8Array(await readFile(join(fixtureRoot, 'specialist.json')))
    })
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    let centralOffset = -1
    for (let index = 0; index <= zip.length - 4; index += 1) {
      if (view.getUint32(index, true) === 0x02014b50) {
        centralOffset = index
        break
      }
    }
    expect(centralOffset).toBeGreaterThanOrEqual(0)
    zip[centralOffset + 5] = 3
    view.setUint32(centralOffset + 38, 0o120777 << 16, true)

    const result = validateSpecialistZip(zip, catalog)

    expect(result.preview.installable).toBe(false)
    expect(result.preview.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'package.symbolic-link-forbidden'
      })
    )
  })

  it('rejects an oversized compressed archive before attempting to unzip it', () => {
    const actual = SPECIALIST_PACKAGE_ARCHIVE_LIMITS.compressedBytes + 1

    const result = validateSpecialistZip(new Uint8Array(actual), catalog)

    expect(result.preview).toMatchObject({
      installable: false,
      archive: {
        compressedBytes: actual,
        limits: SPECIALIST_PACKAGE_ARCHIVE_LIMITS
      },
      diagnostics: [
        {
          severity: 'error',
          code: 'package.archive-compressed-size-exceeded',
          actual,
          limit: SPECIALIST_PACKAGE_ARCHIVE_LIMITS.compressedBytes,
          unit: 'bytes'
        }
      ]
    })
  })

  it('rejects an oversized entry from ZIP metadata before expanding it', () => {
    const actual = SPECIALIST_PACKAGE_ARCHIVE_LIMITS.fileBytes + 1
    const zip = zipSync({
      'manifest.json': encoder.encode('{}'),
      'specialist.json': encoder.encode('{}'),
      'skills/large/reference.bin': [new Uint8Array(actual), { level: 0 }]
    })

    const result = validateSpecialistZip(zip, catalog)

    expect(result.preview.installable).toBe(false)
    expect(result.preview.archive).toMatchObject({ uncompressedBytes: actual + 4, fileCount: 3 })
    expect(result.preview.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'package.archive-file-size-exceeded',
        path: 'skills/large/reference.bin',
        actual,
        limit: SPECIALIST_PACKAGE_ARCHIVE_LIMITS.fileBytes,
        unit: 'bytes'
      })
    )
  })

  it('blocks a symbolic-link ZIP entry without exposing its target', () => {
    const zip = zipSync({
      'manifest.json': encoder.encode('{}'),
      'specialist.json': encoder.encode('{}'),
      'skills/unsafe-link': [encoder.encode('/private/secret'), { os: 3, attrs: 0o120777 << 16 }]
    })

    const result = validateSpecialistZip(zip, catalog)

    expect(result.preview.installable).toBe(false)
    expect(result.preview.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'package.symbolic-link-forbidden',
        path: 'skills/unsafe-link'
      })
    )
    expect(JSON.stringify(result.preview)).not.toContain('/private/secret')
  })

  it('aggregates POSIX and Windows path violations and normalized duplicates', () => {
    const zip = zipSync({
      'manifest.json': encoder.encode('{}'),
      'specialist.json': encoder.encode('{}'),
      '/absolute.txt': encoder.encode('x'),
      'C:\\drive.txt': encoder.encode('x'),
      'folder\\backslash.txt': encoder.encode('x'),
      '../traversal.txt': encoder.encode('x'),
      'skills/Case.md': encoder.encode('x'),
      'skills/case.md': encoder.encode('x')
    })

    const result = validateSpecialistZip(zip, catalog)
    const codes = result.preview.diagnostics.map((item) => item.code)

    expect(codes).toEqual(
      expect.arrayContaining([
        'package.archive-path-absolute',
        'package.archive-path-drive',
        'package.archive-path-backslash',
        'package.archive-path-traversal',
        'package.archive-path-duplicate'
      ])
    )
    expect(result.preview.installable).toBe(false)
    expect(result.plan).toBeUndefined()
    expect(JSON.stringify(result.preview)).not.toContain('C:\\drive.txt')
  })

  it('accepts the file-count boundary and blocks the first file above it', () => {
    const entries = Object.fromEntries(
      Array.from({ length: SPECIALIST_PACKAGE_ARCHIVE_LIMITS.fileCount - 2 }, (_, index) => [
        `skills/example/references/${index}.md`,
        new Uint8Array()
      ])
    )
    const base = {
      'manifest.json': encoder.encode('{}'),
      'specialist.json': encoder.encode('{}'),
      ...entries
    }
    const atLimit = validateSpecialistZip(zipSync(base), catalog)
    const aboveLimit = validateSpecialistZip(
      zipSync({ ...base, 'skills/example/references/overflow.md': new Uint8Array() }),
      catalog
    )

    expect(atLimit.preview.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'package.archive-file-count-exceeded' })
    )
    expect(aboveLimit.preview.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'package.archive-file-count-exceeded',
        actual: SPECIALIST_PACKAGE_ARCHIVE_LIMITS.fileCount + 1,
        limit: SPECIALIST_PACKAGE_ARCHIVE_LIMITS.fileCount
      })
    )
  })

  it('blocks a highly compressible ZIP-bomb entry from expansion', () => {
    const zip = zipSync({
      'manifest.json': encoder.encode('{}'),
      'specialist.json': encoder.encode('{}'),
      'skills/example/references/bomb.txt': new Uint8Array(4 * 1024 * 1024)
    })

    const result = validateSpecialistZip(zip, catalog)

    expect(result.preview.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'package.archive-compression-ratio-exceeded',
        path: 'skills/example/references/bomb.txt',
        limit: SPECIALIST_PACKAGE_ARCHIVE_LIMITS.compressionRatio,
        unit: 'ratio'
      })
    )
    expect(result.preview.installable).toBe(false)
  })

  it('feeds directory files and real ZIP bytes through the same validation core', async () => {
    const zip = zipSync({
      'manifest.json': new Uint8Array(await readFile(join(fixtureRoot, 'manifest.json'))),
      'specialist.json': new Uint8Array(await readFile(join(fixtureRoot, 'specialist.json'))),
      'README.txt': new Uint8Array(await readFile(join(fixtureRoot, 'README.txt')))
    })

    const directory = await validateSpecialistDirectory(fixtureRoot, catalog)
    const archive = validateSpecialistZip(zip, catalog)

    expect(directory.preview.installable).toBe(true)
    expect(archive.preview.installable).toBe(true)
    expect(directory.preview.diagnostics).toEqual(archive.preview.diagnostics)
    expect(directory.plan?.contentHash).toBe(archive.plan?.contentHash)
    expect(directory.preview.summary).toEqual({
      ...archive.preview.summary,
      source: 'directory'
    })
  })

  it('accepts Finder-created wrapper archives with macOS metadata', async () => {
    const packageFiles = Object.fromEntries(
      await Promise.all(
        ['manifest.json', 'specialist.json', 'README.txt'].map(async (fileName) => [
          `openscience-specialist-template/${fileName}`,
          new Uint8Array(await readFile(join(fixtureRoot, fileName)))
        ])
      )
    )
    const zip = zipSync({
      ...packageFiles,
      '__MACOSX/openscience-specialist-template/._manifest.json': new Uint8Array([1, 2, 3]),
      '__MACOSX/openscience-specialist-template/._specialist.json': new Uint8Array([4, 5, 6])
    })

    const archive = validateSpecialistZip(zip, catalog)

    expect(archive.preview.installable).toBe(true)
    expect(archive.preview.summary).toMatchObject({
      id: 'fixture-specialist',
      name: 'Fixture Specialist'
    })
  })

  it('accepts Finder directory entries in wrapper archives', async () => {
    const packageFiles = Object.fromEntries(
      await Promise.all(
        ['manifest.json', 'specialist.json', 'README.txt'].map(async (fileName) => [
          `openscience-specialist-template/${fileName}`,
          new Uint8Array(await readFile(join(fixtureRoot, fileName)))
        ])
      )
    )
    const zip = zipSync({
      'openscience-specialist-template/': new Uint8Array(),
      ...packageFiles,
      '__MACOSX/': new Uint8Array(),
      '__MACOSX/openscience-specialist-template/': new Uint8Array(),
      '__MACOSX/openscience-specialist-template/._manifest.json': new Uint8Array([1, 2, 3])
    })

    const archive = validateSpecialistZip(zip, catalog)

    expect(archive.preview.installable).toBe(true)
    expect(archive.preview.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'package.archive-path-traversal' })
    )
  })

  it('rejects forbidden root content identically without executing it', async () => {
    const zip = zipSync({
      'manifest.json': new Uint8Array(await readFile(join(invalidFixtureRoot, 'manifest.json'))),
      'specialist.json': new Uint8Array(
        await readFile(join(invalidFixtureRoot, 'specialist.json'))
      ),
      'run.sh': new Uint8Array(await readFile(join(invalidFixtureRoot, 'run.sh')))
    })

    const directory = await validateSpecialistDirectory(invalidFixtureRoot, catalog)
    const archive = validateSpecialistZip(zip, catalog)
    const expected = {
      severity: 'error',
      code: 'package.top-level-content-forbidden',
      message: 'The package contains unsupported top-level content.',
      path: 'run.sh'
    }

    expect(directory.preview.diagnostics).toContainEqual(expected)
    expect(archive.preview.diagnostics).toEqual(directory.preview.diagnostics)
    expect(directory.preview.installable).toBe(false)
  })

  it('aggregates the same multi-error fixture diagnostics through either adapter', async () => {
    const zip = zipSync({
      'manifest.json': new Uint8Array(await readFile(join(multiErrorFixtureRoot, 'manifest.json'))),
      'specialist.json': new Uint8Array(
        await readFile(join(multiErrorFixtureRoot, 'specialist.json'))
      )
    })

    const directory = await validateSpecialistDirectory(multiErrorFixtureRoot, catalog)
    const archive = validateSpecialistZip(zip, catalog)

    expect(directory.preview.diagnostics).toEqual(archive.preview.diagnostics)
    expect(
      directory.preview.diagnostics.filter((item) => item.severity === 'error').length
    ).toBeGreaterThan(8)
    expect(JSON.stringify(directory.preview)).not.toContain('must-not-leak')
  })

  it('rejects hard-linked package files before validation reads their content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'specialist-hardlink-'))
    try {
      await mkdir(join(root, 'skills', 'analysis-tools', 'assets'), { recursive: true })
      await writeFile(
        join(root, 'manifest.json'),
        await readFile(join(fixtureRoot, 'manifest.json'))
      )
      await writeFile(
        join(root, 'specialist.json'),
        await readFile(join(fixtureRoot, 'specialist.json'))
      )
      await writeFile(join(root, 'skills', 'analysis-tools', 'assets', 'source.txt'), 'secret')
      await link(
        join(root, 'skills', 'analysis-tools', 'assets', 'source.txt'),
        join(root, 'skills', 'analysis-tools', 'assets', 'linked.txt')
      )

      const result = await validateSpecialistDirectory(root, catalog)

      expect(result.preview.installable).toBe(false)
      expect(result.preview.diagnostics).toEqual([
        expect.objectContaining({ code: 'package.hard-link-forbidden' })
      ])
      expect(JSON.stringify(result.preview)).not.toContain('secret')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts the directory file-count boundary and blocks the first file above it', async () => {
    const extraAtLimit = SPECIALIST_PACKAGE_ARCHIVE_LIMITS.fileCount - 3
    const writePackage = async (root: string, extraFiles: number): Promise<void> => {
      await writeFile(
        join(root, 'manifest.json'),
        await readFile(join(fixtureRoot, 'manifest.json'))
      )
      await writeFile(
        join(root, 'specialist.json'),
        await readFile(join(fixtureRoot, 'specialist.json'))
      )
      await writeFile(join(root, 'README.txt'), await readFile(join(fixtureRoot, 'README.txt')))
      await mkdir(join(root, 'skills', 'example', 'references'), { recursive: true })
      await Promise.all(
        Array.from({ length: extraFiles }, (_, index) =>
          writeFile(join(root, 'skills', 'example', 'references', `${index}.md`), '')
        )
      )
    }
    const atLimitRoot = await mkdtemp(join(tmpdir(), 'specialist-dir-count-limit-'))
    const aboveLimitRoot = await mkdtemp(join(tmpdir(), 'specialist-dir-count-overflow-'))
    try {
      await writePackage(atLimitRoot, extraAtLimit)
      await writePackage(aboveLimitRoot, extraAtLimit + 1)

      const atLimit = await validateSpecialistDirectory(atLimitRoot, catalog)
      const aboveLimit = await validateSpecialistDirectory(aboveLimitRoot, catalog)

      expect(atLimit.preview.diagnostics).not.toContainEqual(
        expect.objectContaining({ code: 'package.archive-file-count-exceeded' })
      )
      expect(aboveLimit.preview.installable).toBe(false)
      expect(aboveLimit.preview.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'package.archive-file-count-exceeded',
          actual: SPECIALIST_PACKAGE_ARCHIVE_LIMITS.fileCount + 1,
          limit: SPECIALIST_PACKAGE_ARCHIVE_LIMITS.fileCount,
          unit: 'files'
        })
      )
      expect(aboveLimit.preview.diagnostics).not.toContainEqual(
        expect.objectContaining({ code: 'skill.document-missing' })
      )
    } finally {
      await rm(atLimitRoot, { recursive: true, force: true })
      await rm(aboveLimitRoot, { recursive: true, force: true })
    }
  })

  it('rejects an oversized directory file from metadata before reading it', async () => {
    const actual = SPECIALIST_PACKAGE_ARCHIVE_LIMITS.fileBytes + 1
    const root = await mkdtemp(join(tmpdir(), 'specialist-dir-file-size-'))
    try {
      await writeFile(
        join(root, 'manifest.json'),
        await readFile(join(fixtureRoot, 'manifest.json'))
      )
      await writeFile(
        join(root, 'specialist.json'),
        await readFile(join(fixtureRoot, 'specialist.json'))
      )
      const handle = await open(join(root, 'payload.bin'), 'w')
      await handle.truncate(actual)
      await handle.close()

      const result = await validateSpecialistDirectory(root, catalog)

      expect(result.preview.installable).toBe(false)
      expect(result.preview.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'package.archive-file-size-exceeded',
          path: 'payload.bin',
          actual,
          limit: SPECIALIST_PACKAGE_ARCHIVE_LIMITS.fileBytes,
          unit: 'bytes'
        })
      )
      expect(result.preview.diagnostics).not.toContainEqual(
        expect.objectContaining({ code: 'package.top-level-content-forbidden' })
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
