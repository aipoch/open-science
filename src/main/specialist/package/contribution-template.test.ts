import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createContributionTemplateExporter,
  resolveContributionTemplateReadmePath
} from './contribution-template'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('contribution template ZIP', () => {
  it('returns quietly without reading or writing template content when save is cancelled', async () => {
    const readReadme = vi.fn()
    const writeFile = vi.fn()
    const publishUserFile = vi.fn()
    const exportContributionTemplate = createContributionTemplateExporter({
      appVersion: '0.9.2',
      showSaveDialog: vi.fn().mockResolvedValue({ canceled: true }),
      readReadme,
      writeFile,
      publishUserFile
    })

    await expect(exportContributionTemplate()).resolves.toEqual({ saved: false })
    expect(publishUserFile).not.toHaveBeenCalled()
    expect(readReadme).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('uses the fixed filename and writes the generated archive after confirmation', async () => {
    const showSaveDialog = vi
      .fn()
      .mockResolvedValue({ canceled: false, filePath: '/chosen/template.zip' })
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const exportContributionTemplate = createContributionTemplateExporter({
      appVersion: '0.9.2',
      showSaveDialog,
      readReadme: vi.fn().mockResolvedValue('# 中文\n\n# English\n'),
      generatePackageId: () => '00000000-0000-4000-8000-000000000002',
      writeFile,
      publishUserFile: async (destinationPath, write) => {
        await write(destinationPath)
      }
    })

    await expect(exportContributionTemplate()).resolves.toEqual({ saved: true })
    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: 'open-science-specialist-template.zip' })
    )
    expect(writeFile).toHaveBeenCalledWith('/chosen/template.zip', expect.any(Uint8Array))
  })

  it('sanitizes write failures so the renderer never receives the absolute target path', async () => {
    const exportContributionTemplate = createContributionTemplateExporter({
      appVersion: '0.9.2',
      showSaveDialog: vi
        .fn()
        .mockResolvedValue({ canceled: false, filePath: '/secret/user/location/template.zip' }),
      readReadme: vi.fn().mockResolvedValue('# Guide'),
      writeFile: vi.fn().mockRejectedValue(new Error('EACCES /secret/user/location/template.zip')),
      publishUserFile: async (destinationPath, write) => {
        await write(destinationPath)
      }
    })

    await expect(exportContributionTemplate()).rejects.toThrow(
      'Could not save contribution template.'
    )
    await expect(exportContributionTemplate()).rejects.not.toThrow('/secret/user/location')
  })

  it('resolves versioned contributor guidance in development and packaged resources', async () => {
    const repositoryRoot = join(import.meta.dirname, '..', '..', '..', '..')
    const developmentPath = resolveContributionTemplateReadmePath(repositoryRoot)
    const packagedPath = resolveContributionTemplateReadmePath(
      '/Applications/Open-Science.app/Contents/Resources/app.asar'
    )

    await expect(readFile(developmentPath, 'utf8')).resolves.toContain('50 MB')
    expect(developmentPath).toBe(
      join(repositoryRoot, 'resources', 'specialists', 'template', 'v1', 'README.txt')
    )
    expect(packagedPath).toContain(
      join('app.asar.unpacked', 'resources', 'specialists', 'template', 'v1', 'README.txt')
    )
  })
})
