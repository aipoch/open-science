import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, expect, it, vi } from 'vitest'
import { SpecialistRepository } from '../repository'
import { SpecialistPackageService } from './service'
import type { SpecialistPackageCatalogSnapshot } from '../archive-contracts'
import { fakeSkillParticipant, fixtureSkillParser } from '../../test/fixtures'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const emptyCatalog: SpecialistPackageCatalogSnapshot = {
  appVersion: '0.9.2',
  builtinSkills: [],
  skills: [],
  connectorIds: [],
  protectedSpecialistIds: []
}
const archive = (id: string, bundled = true, connectorIds: string[] = []): Uint8Array =>
  zipSync({
    'manifest.json': strToU8(
      JSON.stringify({
        schema_version: 1,
        id,
        version: '1.0.0',
        exported_with_app_version: '0.9.2'
      })
    ),
    'specialist.json': strToU8(
      JSON.stringify({
        name: id.toUpperCase().replaceAll('-', '_'),
        description: 'Research helper.',
        system_prompt: 'Help with research.',
        skill_ids: [],
        connector_ids: connectorIds
      })
    ),
    ...(bundled
      ? {
          'skills/analysis-tools/SKILL.md': strToU8(
            '---\nname: analysis-tools\ndescription: Analyze data\nversion: 1.0.0\n---\nORIGINAL SKILL CONTENT'
          )
        }
      : {})
  })

async function fixture(): Promise<{
  repository: SpecialistRepository
  liveCatalog: SpecialistPackageCatalogSnapshot
  packages: SpecialistPackageService
  skillPort: typeof fakeSkillParticipant & { exportSnapshot: ReturnType<typeof vi.fn> }
}> {
  const storageDir = await mkdtemp(join(tmpdir(), 'specialist-candidate-'))
  roots.push(storageDir)
  const repository = new SpecialistRepository(storageDir)
  const liveCatalog = { ...emptyCatalog }
  const skillPort = {
    ...fakeSkillParticipant,
    exportSnapshot: vi.fn(async () => {
      throw new Error('Skill unavailable')
    })
  }
  const packages = new SpecialistPackageService({
    storageDir,
    repository,
    catalog: async () => liveCatalog,
    skillPort,
    parseSkillDocument: fixtureSkillParser
  })
  return { repository, liveCatalog, packages, skillPort }
}
it('K03 refuses installation when an approved connector disappears after preview', async () => {
  const { packages, liveCatalog, repository } = await fixture()
  liveCatalog.connectorIds = ['demo']
  const preview = await packages.preview(archive('first-specialist', false, ['demo']))
  expect(preview.installable).toBe(true)
  expect(preview.summary?.connectorIds).toEqual(['demo'])
  liveCatalog.connectorIds = []
  const result = await packages.install({ candidateToken: preview.candidateToken })
  expect.soft(result).toMatchObject({ status: 'failed', code: 'stale-candidate' })
  expect.soft((await repository.getAll()).specialists).toEqual([])
})

it.each(['alias', 'unrelated', 'initially-missing'] as const)(
  'K03 only invalidates relevant capability changes: %s',
  async (change) => {
    const { packages, liveCatalog } = await fixture()
    liveCatalog.connectorIds = change === 'initially-missing' ? [] : ['first', 'second']
    liveCatalog.connectorAliases = { first: 'demo' }
    const preview = await packages.preview(archive('first-specialist', false, ['demo']))
    expect(preview.installable).toBe(true)
    if (change === 'alias') liveCatalog.connectorAliases = { second: 'demo' }
    else liveCatalog.connectorIds = [...liveCatalog.connectorIds, 'unrelated']
    const result = await packages.install({ candidateToken: preview.candidateToken })
    expect(result).toMatchObject(
      change === 'alias' ? { status: 'failed', code: 'stale-candidate' } : { status: 'installed' }
    )
  }
)

it('K03 rejects removal of a referenced unbundled Skill', async () => {
  const { packages, liveCatalog } = await fixture()
  liveCatalog.skills = [{ id: 'personal-analysis-tools', name: 'analysis-tools', builtin: false }]
  const bytes = zipSync({
    'manifest.json': strToU8(
      JSON.stringify({
        schema_version: 1,
        id: 'first-specialist',
        version: '1.0.0',
        exported_with_app_version: '0.9.2'
      })
    ),
    'specialist.json': strToU8(
      JSON.stringify({
        name: 'FIRST_SPECIALIST',
        description: 'Research helper.',
        system_prompt: 'Help.',
        skill_ids: ['analysis-tools'],
        connector_ids: []
      })
    )
  })
  const preview = await packages.preview(bytes)
  expect(preview.installable).toBe(true)
  liveCatalog.skills = []
  expect(await packages.install({ candidateToken: preview.candidateToken })).toMatchObject({
    status: 'failed',
    code: 'stale-candidate'
  })
})

it.each(['Skill unavailable', 'invalid version'])(
  'keeps excluded participant failures out of exports: %s',
  async (reason) => {
    const { packages, skillPort } = await fixture()
    const preview = await packages.preview(archive('first-specialist'))
    expect(await packages.install({ candidateToken: preview.candidateToken })).toMatchObject({
      status: 'installed'
    })
    skillPort.exportSnapshot.mockRejectedValue(new Error(reason))
    const exportPreview = await packages.previewExport('first-specialist')
    expect(exportPreview.canExport).toBe(false)
    expect(exportPreview.diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'specialist.export-validation-failed' })
    )
    expect(exportPreview.skills).toContainEqual(
      expect.objectContaining({ selected: true, kind: 'owned' })
    )
    const result = await packages.export({
      specialistId: exportPreview.specialistId,
      expectedRevision: exportPreview.expectedRevision,
      includedSkillIds: []
    })
    expect(skillPort.exportSnapshot).not.toHaveBeenCalledWith([])
    expect(result.archiveBytes.byteLength).toBeGreaterThan(0)
    expect((await packages.previewExport('first-specialist', [])).canExport).toBe(true)
    expect(
      (await packages.previewExport('first-specialist', ['personal-analysis-tools'])).canExport
    ).toBe(false)
  }
)

it('honors participant revalidation failure after prepare before publishing the Specialist', async () => {
  const { packages, repository, skillPort } = await fixture()
  const preview = await packages.preview(archive('first-specialist'))
  let prepared = false
  skillPort.prepare = vi.fn(async () => {
    prepared = true
  })
  skillPort.beginMutation = vi.fn(async () => {
    expect(prepared).toBe(true)
    throw new Error('Skill changed after preparation')
  })
  skillPort.commit = vi.fn(async () => {})
  skillPort.rollback = vi.fn(async () => {})
  expect(await packages.install({ candidateToken: preview.candidateToken })).toMatchObject({
    status: 'failed'
  })
  expect(skillPort.commit).not.toHaveBeenCalled()
  expect(skillPort.rollback).toHaveBeenCalledOnce()
  expect((await repository.getAll()).specialists).toEqual([])
})
