import { SpecialistStorageFixture } from '../../../../test/specialist-fixtures'
import { parseSkillDocument } from '@aipoch/skills/document'
import { createHostSpecialistPackages } from './environment'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpecialistPackageCatalogSnapshot } from '@aipoch/specialists'
import { UserSkillSpecialistPackageAdapter } from '@aipoch/skills'
import { UserSkillRepository } from '../../skills/user-skill-repository'
import { SettingsRepository } from '../../settings/repository'
import { MarketplaceRepository, type MarketplaceInstallProvenance } from '../marketplace/repository'
import { MarketplaceService } from '../marketplace/service'
import { SpecialistPackageService } from '@aipoch/specialists/node'
import { validateSpecialistZip } from '@aipoch/specialists/node'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
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
  storageDir: string
  repository: SpecialistStorageFixture
  skillPort: UserSkillSpecialistPackageAdapter
  userSkills: UserSkillRepository
  liveCatalog: SpecialistPackageCatalogSnapshot
  catalog: () => Promise<SpecialistPackageCatalogSnapshot>
  packages: SpecialistPackageService
}> {
  const storageDir = await mkdtemp(join(tmpdir(), 'specialist-reported-'))
  roots.push(storageDir)
  const repository = new SpecialistStorageFixture(storageDir)
  const skillPort = new UserSkillSpecialistPackageAdapter(storageDir)
  const userSkills = new UserSkillRepository(storageDir)
  const liveCatalog = { ...emptyCatalog }
  const catalog = async (): Promise<SpecialistPackageCatalogSnapshot> => ({
    ...liveCatalog,
    skills: (await skillPort.snapshot()).map((skill) => ({
      ...skill,
      name: skill.id.replace(/^personal-/, ''),
      builtin: false,
      mainEnabled: false
    }))
  })
  const packages = createHostSpecialistPackages({
    storageDir,
    domain: repository.domain,
    skillPort,
    catalog
  })
  return { storageDir, repository, skillPort, userSkills, liveCatalog, catalog, packages }
}
const provenance = (digest = 'c'.repeat(64)): MarketplaceInstallProvenance => ({
  sourceId: 'official',
  specialistId: 'first-specialist',
  publisher: 'Example',
  version: '1.0.0',
  releasePath: 'releases/first-specialist/1.0.0.json',
  releaseDigest: 'a'.repeat(64),
  artifactDigest: 'b'.repeat(64),
  installedArchiveDigest: digest,
  upstreamCommit: 'd'.repeat(40),
  selectedSkillIds: ['analysis-tools'],
  selectedConnectorIds: [],
  installedAt: '2026-09-05T00:00:00.000Z'
})

describe('reported Specialist package regressions', () => {
  it('exports the edited Skill version shown by the current preview', async () => {
    const { packages, userSkills } = await fixture()
    const first = await packages.preview(archive('first-specialist'))
    expect(await packages.install({ candidateToken: first.candidateToken })).toMatchObject({
      status: 'installed'
    })
    await userSkills.updatePersonal('personal-analysis-tools', {
      name: 'analysis-tools',
      description: 'Analyze data',
      body: 'UPDATED SKILL',
      metadata: { version: '2.0.0' }
    })
    const preview = await packages.previewExport('first-specialist')
    expect(preview.skills[0].version).toBe('2.0.0')
    const exported = await packages.export({
      specialistId: preview.specialistId,
      expectedRevision: preview.expectedRevision,
      includedSkillIds: ['personal-analysis-tools']
    })
    const imported = validateSpecialistZip(exported.archiveBytes, emptyCatalog, parseSkillDocument)
    expect(imported.plan?.skills[0].version).toBe('2.0.0')
  })

  it('keeps unrelated package preview and export available when an owned Skill document is missing', async () => {
    const { packages, storageDir, skillPort } = await fixture()
    const first = await packages.preview(archive('first-specialist'))
    expect(await packages.install({ candidateToken: first.candidateToken })).toMatchObject({
      status: 'installed'
    })
    const directory = join(storageDir, 'skills', 'personal', 'analysis-tools')
    const sidecar = join(directory, '.specialist-package.json')
    const metadata = await readFile(sidecar, 'utf8')
    await rm(join(directory, 'SKILL.md'))

    await expect
      .soft(packages.preview(archive('unrelated-specialist', false)))
      .resolves.toMatchObject({ installable: true })
    await expect
      .soft(packages.previewExport('first-specialist', []))
      .resolves.toMatchObject({ canExport: true })
    await expect.soft(skillPort.snapshot()).resolves.toEqual([])
    expect(await readFile(sidecar, 'utf8')).toBe(metadata)
  })

  it('K05 requires conflict approval and retains an owned Skill edited through the personal editor', async () => {
    const { packages, userSkills } = await fixture()
    const first = await packages.preview(archive('first-specialist'))
    expect(await packages.install({ candidateToken: first.candidateToken })).toMatchObject({
      status: 'installed'
    })
    await userSkills.updatePersonal('personal-analysis-tools', {
      name: 'analysis-tools',
      description: 'Analyze data',
      body: 'USER LOCAL EDIT MUST SURVIVE'
    })
    expect(await userSkills.body('personal-analysis-tools')).toContain(
      'USER LOCAL EDIT MUST SURVIVE'
    )
    const second = await packages.preview(archive('second-specialist'))
    expect.soft(second.summary?.skills[0].disposition).toBe('conflict')
    expect.soft(second.installable).toBe(false)
    const result = await packages.install({ candidateToken: second.candidateToken })
    expect
      .soft(result)
      .toMatchObject({ status: 'failed', code: 'skill-conflict-resolution-required' })
    expect
      .soft(await userSkills.body('personal-analysis-tools'))
      .toContain('USER LOCAL EDIT MUST SURVIVE')
  })

  it.each([1, 2])(
    'K02 preserves Main isolation and provenance across %s committed cleanup failures',
    async (failures) => {
      const { packages, repository, skillPort, storageDir, userSkills } = await fixture()
      const marketRepository = new MarketplaceRepository(storageDir)
      const settings = new SettingsRepository(storageDir)
      const market = new MarketplaceService({
        repository: marketRepository,
        packages,
        fetch: vi.fn() as never,
        setSkillsMainEnabled: async (ids, enabled) => {
          await settings.setSkillsEnabled([...ids], enabled)
        },
        getInstalledSpecialists: async () =>
          (await repository.getAll()).specialists.map((item) => ({
            id: item.id,
            origin: item.origin,
            archiveDigest: item.importBaseline?.archiveDigest
          }))
      })
      const bytes = archive('first-specialist')
      const preview = await packages.preview(bytes, undefined, { origin: 'marketplace' })
      expect(preview.installable).toBe(true)
      // Match existing market tests: seed the already-reviewed candidate, bypassing only network/trust setup.
      Reflect.set(
        market,
        'installCandidates',
        new Map([
          [
            preview.candidateToken,
            {
              expiresAt: Date.now() + 60_000,
              sourceId: 'official',
              packageCandidateToken: preview.candidateToken,
              newSkillIds: packages.candidateNewSkillIds(preview.candidateToken),
              provenance: provenance(createHash('sha256').update(bytes).digest('hex'))
            }
          ]
        ])
      )
      const recover = skillPort.recover.bind(skillPort)
      let injected = 0
      vi.spyOn(skillPort, 'recover').mockImplementation(async (id, outcome) => {
        if (id && outcome === 'commit' && injected < failures) {
          injected += 1
          throw new Error('Transient committed cleanup failure')
        }
        return recover(id, outcome)
      })
      const result = await market.install({ candidateToken: preview.candidateToken })
      expect(injected).toBeGreaterThan(0)
      expect((await repository.getAll()).specialists).toHaveLength(1)
      expect(await userSkills.list()).toHaveLength(1)
      // Either an installed result or the existing recovery-failed result can preserve the obligation.
      if (result.status === 'failed') expect(result.code).toBe('recovery-failed')
      expect
        .soft((await settings.getSettings()).disabledSkillIds)
        .toEqual(['personal-analysis-tools'])
      const pending = await marketRepository.getAll()
      expect.soft(pending.pendingInstallations.length + pending.installations.length).toBe(1)
      // Retry through the market public boundary, including after a previous recovery attempt failed.
      await market.recover()
      await expect(
        readFile(join(storageDir, 'specialist-package-transaction.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await market.recover()
      await market.recover()
      expect.soft((await marketRepository.getAll()).installations).toHaveLength(1)
      expect
        .soft((await settings.getSettings()).disabledSkillIds)
        .toEqual(['personal-analysis-tools'])
    }
  )
})
