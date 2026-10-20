import { describe, expect, it, vi } from 'vitest'
import { buildSkillExportArchive, saveSkillExport } from './export'
import { buildSkillExportArchive as buildPackageArchive } from '@aipoch/skills/sources'
import type { BundledSkill } from '@aipoch/skills'
import { validateSkillHelper } from './helper-validation'

vi.mock('@aipoch/skills/sources', () => ({ buildSkillExportArchive: vi.fn() }))

describe('Skill ZIP export', () => {
  it('saves the archive selected by the user', async () => {
    const showSaveDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePath: '/chosen/my-skill.zip'
    })
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const archiveBytes = new Uint8Array([1, 2, 3])

    await expect(
      saveSkillExport(
        {
          showSaveDialog,
          writeFile,
          publishUserFile: async (destinationPath, write) => {
            await write(destinationPath)
          }
        },
        { fileName: 'my-skill.zip', archiveBytes }
      )
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
})

it('supplies the host helper validator and storage root to package export', async () => {
  const skill: BundledSkill = {
    id: 'personal-example',
    name: 'example',
    displayName: 'Example',
    description: '',
    source: 'personal',
    updatedAt: '',
    sourceDir: '/unused'
  }
  const archive = { fileName: 'example.zip', archiveBytes: new Uint8Array([1, 2, 3]) }
  vi.mocked(buildPackageArchive).mockResolvedValueOnce(archive)
  await expect(buildSkillExportArchive(skill, '/storage')).resolves.toBe(archive)
  expect(buildPackageArchive).toHaveBeenCalledExactlyOnceWith(
    skill,
    '/storage',
    validateSkillHelper
  )
})
