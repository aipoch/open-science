import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { strFromU8, unzipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SpecialistPackageCatalogSnapshot } from '../../../shared/specialist-package'
import {
  buildContributionTemplateZip,
  buildDeterministicSpecialistZip,
  createContributionTemplateExporter,
  resolveContributionTemplateReadmePath
} from './contribution-template'
import { validateSpecialistZip } from './zip-adapter'

const catalog: SpecialistPackageCatalogSnapshot = {
  appVersion: '0.9.2',
  builtinSkills: [],
  skills: [],
  connectorIds: [],
  protectedSpecialistIds: ['reviewer']
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('contribution template ZIP', () => {
  it('builds the fixed root package with valid application-generated metadata', () => {
    const archiveBytes = buildContributionTemplateZip({
      appVersion: '0.9.2',
      readme: '中文指南\n\nEnglish guide\n',
      packageId: '00000000-0000-4000-8000-000000000001'
    })
    const archive = unzipSync(archiveBytes)

    expect(Object.keys(archive).sort()).toEqual(['README.txt', 'manifest.json', 'specialist.json'])
    expect(JSON.parse(strFromU8(archive['manifest.json']))).toEqual({
      schema_version: 1,
      id: '00000000-0000-4000-8000-000000000001',
      version: '0.1.0',
      exported_with_app_version: '0.9.2'
    })
    expect(JSON.parse(strFromU8(archive['specialist.json']))).toEqual({
      name: '',
      description: '',
      system_prompt: '',
      skill_ids: [],
      connector_ids: []
    })
    expect(strFromU8(archive['README.txt'])).toContain('中文指南')
    expect(strFromU8(archive['README.txt'])).toContain('English guide')

    const result = validateSpecialistZip(archiveBytes, catalog)
    expect(result.preview.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'specialist.name-invalid', path: 'specialist.json' }),
        expect.objectContaining({
          code: 'specialist.description-invalid',
          path: 'specialist.json'
        }),
        expect.objectContaining({
          code: 'specialist.system-prompt-invalid',
          path: 'specialist.json'
        })
      ])
    )
  })

  it('returns quietly without reading or writing template content when save is cancelled', async () => {
    const readReadme = vi.fn()
    const writeFile = vi.fn()
    const exportContributionTemplate = createContributionTemplateExporter({
      appVersion: '0.9.2',
      showSaveDialog: vi.fn().mockResolvedValue({ canceled: true }),
      readReadme,
      writeFile
    })

    await expect(exportContributionTemplate()).resolves.toEqual({ saved: false })
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
      writeFile
    })

    await expect(exportContributionTemplate()).resolves.toEqual({ saved: true })
    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: 'openscience-specialist-template.zip' })
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
      writeFile: vi.fn().mockRejectedValue(new Error('EACCES /secret/user/location/template.zip'))
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
      '/Applications/Open Science.app/Contents/Resources/app.asar'
    )

    await expect(readFile(developmentPath, 'utf8')).resolves.toContain('50 MB')
    expect(developmentPath).toBe(
      join(repositoryRoot, 'resources', 'specialists', 'template', 'v1', 'README.txt')
    )
    expect(packagedPath).toContain(
      join('app.asar.unpacked', 'resources', 'specialists', 'template', 'v1', 'README.txt')
    )
  })

  it('keeps the deterministic ZIP writer reusable without injecting the generic template README', () => {
    const files = {
      'manifest.json': new TextEncoder().encode('{}\n'),
      'specialist.json': new TextEncoder().encode('{}\n')
    }

    const first = buildDeterministicSpecialistZip(files)
    const second = buildDeterministicSpecialistZip(files)

    expect(first).toEqual(second)
    expect(Object.keys(unzipSync(first)).sort()).toEqual(['manifest.json', 'specialist.json'])
  })

  it('builds a deterministic Specialist ZIP in a negative UTC timezone', () => {
    vi.stubEnv('TZ', 'UTC')
    const utcArchive = buildDeterministicSpecialistZip({
      'specialist.json': new TextEncoder().encode('{}\n')
    })
    vi.stubEnv('TZ', 'America/Los_Angeles')

    expect(
      buildDeterministicSpecialistZip({
        'specialist.json': new TextEncoder().encode('{}\n')
      })
    ).toEqual(utcArchive)
  })
})
