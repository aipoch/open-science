import { UserSkillRepository } from '@aipoch/skills'
import { link, mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

import { buildSkillExportArchive } from '@aipoch/skills/sources'
import { skillExportFileName } from '@aipoch/skills/sources'
import { SKILL_IMPORT_LIMITS } from '@aipoch/skills/document'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Skill ZIP export', () => {
  it('uses a sanitized Skill display name with a stable fallback', () => {
    expect(skillExportFileName('RNA / 研究助手:*', 'personal-fallback')).toBe('rna-研究助手.zip')
    expect(skillExportFileName(' :* ', 'personal-fallback')).toBe('personal-fallback.zip')
    expect(skillExportFileName('CON', 'personal-fallback')).toBe('skill-con.zip')
  })

  it('refuses to export a Skill tree containing hard links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-export-hard-link-'))
    roots.push(root)
    await mkdir(join(root, 'references'))
    await writeFile(join(root, 'SKILL.md'), '# Safe')
    await link(join(root, 'SKILL.md'), join(root, 'references', 'shared.md'))

    await expect(
      buildSkillExportArchive({
        id: 'personal-safe',
        name: 'Safe',
        displayName: 'Safe',
        description: '',
        source: 'personal',
        updatedAt: '2026-08-07T00:00:00.000Z',
        sourceDir: root
      })
    ).rejects.toThrow('Unsafe Skill filesystem entry.')
  })

  it('refuses to read a Skill file larger than the portable import limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-export-large-file-'))
    roots.push(root)
    await writeFile(join(root, 'SKILL.md'), '# Large')
    await truncate(join(root, 'SKILL.md'), SKILL_IMPORT_LIMITS.maxFileBytes + 1)

    await expect(
      buildSkillExportArchive({
        id: 'personal-large',
        name: 'Large',
        displayName: 'Large',
        description: '',
        source: 'personal',
        updatedAt: '2026-08-07T00:00:00.000Z',
        sourceDir: root
      })
    ).rejects.toThrow('Skill file exceeds the export size limit.')
  })

  it('omits app-only metadata and displayName from a portable archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-export-metadata-'))
    roots.push(root)
    await writeFile(
      join(root, 'SKILL.md'),
      '---\nname: portable-skill\ndisplayName: >\n  Portable Skill\ndescription: Portable.\n---\nBody.'
    )
    await writeFile(join(root, '.specialist-package.json'), '{"ownerIds":["specialist"]}')

    const exported = await buildSkillExportArchive({
      id: 'portable-skill',
      name: 'Portable',
      displayName: 'Portable',
      description: '',
      source: 'personal',
      updatedAt: '2026-08-07T00:00:00.000Z',
      sourceDir: root
    })

    const archive = unzipSync(exported.archiveBytes)
    expect(Object.keys(archive)).toEqual(['SKILL.md'])
    expect(strFromU8(archive['SKILL.md']!)).not.toContain('displayName')
    expect(strFromU8(archive['SKILL.md']!)).toContain('name: Portable')
    expect(strFromU8(archive['SKILL.md']!)).toContain('Body.')
  })

  it('exports a Skill ZIP in a negative UTC timezone', async () => {
    vi.stubEnv('TZ', 'America/Los_Angeles')
    const root = await mkdtemp(join(tmpdir(), 'skill-export-negative-timezone-'))
    roots.push(root)
    await writeFile(join(root, 'SKILL.md'), '# Portable')

    await expect(
      buildSkillExportArchive({
        id: 'personal-portable',
        name: 'Portable',
        displayName: 'Portable',
        description: '',
        source: 'personal',
        updatedAt: '2026-08-07T00:00:00.000Z',
        sourceDir: root
      })
    ).resolves.toEqual({
      fileName: 'portable.zip',
      archiveBytes: expect.any(Uint8Array)
    })
  })

  it.each(['.hidden', '__MACOSX/metadata'])(
    'refuses to export the importer-incompatible path %s',
    async (path) => {
      const root = await mkdtemp(join(tmpdir(), 'skill-export-unsafe-path-'))
      roots.push(root)
      await writeFile(join(root, 'SKILL.md'), '# Portable')
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), 'not portable')

      await expect(
        buildSkillExportArchive({
          id: 'personal-portable',
          name: 'Portable',
          displayName: 'Portable',
          description: '',
          source: 'personal',
          updatedAt: '2026-08-07T00:00:00.000Z',
          sourceDir: root
        })
      ).rejects.toThrow('Skill path cannot be imported safely.')
    }
  )

  it.runIf(process.platform !== 'win32')(
    'refuses to export a POSIX filename containing a backslash',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'skill-export-backslash-'))
      roots.push(root)
      await writeFile(join(root, 'SKILL.md'), '# Portable')
      await writeFile(join(root, 'references\\helper.py'), 'not portable')

      await expect(
        buildSkillExportArchive({
          id: 'personal-portable',
          name: 'Portable',
          displayName: 'Portable',
          description: '',
          source: 'personal',
          updatedAt: '2026-08-07T00:00:00.000Z',
          sourceDir: root
        })
      ).rejects.toThrow('Skill path cannot be imported safely.')
    }
  )
})

it('exports a personal Skill as a portable ZIP archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-export-repository-'))
  roots.push(root)
  const repo = new UserSkillRepository(root)
  await repo.createPersonal({
    name: 'my-skill',
    description: 'Mine.',
    body: '# Mine',
    references: [
      { path: 'example.txt', dataBase64: Buffer.from('example reference').toString('base64') }
    ]
  })

  const exported = await repo.withSkillReadLock('personal-my-skill', (skill) =>
    buildSkillExportArchive(skill)
  )
  const files = unzipSync(exported!.archiveBytes)

  expect(exported!.fileName).toBe('my-skill.zip')
  expect(strFromU8(files['SKILL.md'])).toContain('# Mine')
  expect(strFromU8(files['references/example.txt'])).toBe('example reference')
  expect(
    (await repo.withSkillReadLock('personal-my-skill', (skill) => buildSkillExportArchive(skill)))!
      .archiveBytes
  ).toEqual(exported!.archiveBytes)
})

it('omits imported-Skill provenance from the exported ZIP archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-export-imported-'))
  roots.push(root)
  const repo = new UserSkillRepository(root)
  const importedZip = zipSync({
    'SKILL.md': strToU8(
      ['---', 'name: Imported Skill', 'description: Imported.', '---', '', '# Imported'].join('\n')
    )
  })
  const imported = await repo.importFromZip(Buffer.from(importedZip))

  const exported = await repo.withSkillReadLock(imported.id, (skill) =>
    buildSkillExportArchive(skill)
  )
  const files = unzipSync(exported!.archiveBytes)

  expect(Object.keys(files)).toEqual(['SKILL.md'])
  expect(strFromU8(files['SKILL.md'])).toContain('name: imported-skill')
})
