import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSpecialistDomain } from '../domain'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, expect, it, vi } from 'vitest'
import {
  buildContributionTemplateZip,
  buildDeterministicSpecialistZip
} from './contribution-template'
import { validateSpecialistZip } from './zip-adapter'
import type { SpecialistPackageCatalogSnapshot } from '../archive-contracts'
const catalog: SpecialistPackageCatalogSnapshot = {
  appVersion: '0.9.2',
  builtinSkills: [],
  skills: [],
  connectorIds: [],
  protectedSpecialistIds: []
}
afterEach(() => vi.unstubAllEnvs())
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

it('installs a completed no-Skill template without a host adapter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'specialist-template-'))
  try {
    const files = unzipSync(
      buildContributionTemplateZip({
        appVersion: '0.9.2',
        readme: 'Guide',
        packageId: 'template-no-skills'
      })
    )
    files['specialist.json'] = new TextEncoder().encode(
      JSON.stringify({
        name: 'Template Specialist',
        description: 'Completed template',
        system_prompt: 'Research',
        skill_ids: [],
        connector_ids: []
      })
    )
    const domain = createSpecialistDomain({ storageDir: root })
    const archives = domain.createArchives({ catalog: async () => catalog })
    const preview = await archives.preview(buildDeterministicSpecialistZip(files))
    expect(preview.installable).toBe(true)
    expect(await archives.install({ candidateToken: preview.candidateToken })).toMatchObject({
      status: 'installed',
      specialist: { id: 'template-no-skills', ownedSkillIds: [] }
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
