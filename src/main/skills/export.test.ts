import { link, mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'

import { buildSkillExportArchive, saveSkillExport, skillExportFileName } from './export'
import { SKILL_IMPORT_LIMITS } from '../../shared/skill-import-limits'

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

  it('saves the archive selected by the user', async () => {
    const showSaveDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePath: '/chosen/my-skill.zip'
    })
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const archiveBytes = new Uint8Array([1, 2, 3])

    await expect(
      saveSkillExport({ showSaveDialog, writeFile }, { fileName: 'my-skill.zip', archiveBytes })
    ).resolves.toEqual({ saved: true })
    expect(showSaveDialog).toHaveBeenCalledWith({
      title: 'Export Skill',
      defaultPath: 'my-skill.zip',
      filters: [{ name: 'Skill ZIP', extensions: ['zip'] }]
    })
    expect(writeFile).toHaveBeenCalledWith('/chosen/my-skill.zip', archiveBytes)
  })

  it('does not write an archive when Save As is cancelled', async () => {
    const writeFile = vi.fn()

    await expect(
      saveSkillExport(
        {
          showSaveDialog: vi.fn().mockResolvedValue({ canceled: true }),
          writeFile
        },
        { fileName: 'my-skill.zip', archiveBytes: new Uint8Array([1, 2, 3]) }
      )
    ).resolves.toEqual({ saved: false })
    expect(writeFile).not.toHaveBeenCalled()
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
