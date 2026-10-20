import fileSystem from 'node:fs/promises'
import { SpecialistStorageFixture } from '../../../../test/specialist-fixtures'
import { parseSkillDocument } from '@aipoch/skills/document'
import { createHostSpecialistPackages } from './environment'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, unzipSync, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SpecialistPackageCatalogSnapshot,
  SpecialistPackageSkillPlan
} from '@aipoch/specialists'
import { UserSkillSpecialistPackageAdapter } from '@aipoch/skills'
import { UserSkillRepository } from '../../skills/user-skill-repository'
import type { FetchLike } from '@aipoch/skills/sources'
import { SettingsRepository } from '../../settings/repository'
import { MarketplaceOperationCoordinator } from '../marketplace/operation-coordinator'
import { validateSpecialistZip } from '@aipoch/specialists/node'

const encoder = new TextEncoder()
const catalog: SpecialistPackageCatalogSnapshot = {
  appVersion: '0.9.2',
  builtinSkills: [],
  skills: [],
  connectorIds: [],
  protectedSpecialistIds: ['reviewer']
}

const validZip = (
  overrides: { version?: string; description?: string; connectorIds?: readonly string[] } = {}
): Uint8Array =>
  zipSync({
    'manifest.json': encoder.encode(
      JSON.stringify({
        schema_version: 1,
        id: 'research-synth',
        version: overrides.version ?? '1.3.0',
        exported_with_app_version: '0.9.2'
      })
    ),
    'specialist.json': encoder.encode(
      JSON.stringify({
        name: 'Research Synthesizer',
        description: overrides.description ?? 'Synthesizes research.',
        system_prompt: 'Private imported instructions.',
        skill_ids: [],
        connector_ids: overrides.connectorIds ?? []
      })
    )
  })

const bundledZip = (overrides: { skillVersion?: string; skillBody?: string } = {}): Uint8Array =>
  zipSync({
    'manifest.json': encoder.encode(
      JSON.stringify({
        schema_version: 1,
        id: 'research-synth',
        version: '1.3.0',
        exported_with_app_version: '0.9.2'
      })
    ),
    'specialist.json': encoder.encode(
      JSON.stringify({
        name: 'Research Synthesizer',
        description: 'Synthesizes research.',
        system_prompt: 'Private imported instructions.',
        skill_ids: [],
        connector_ids: []
      })
    ),
    'skills/analysis-tools/SKILL.md': encoder.encode(
      `---\nname: analysis-tools\ndescription: Analyze data\nversion: ${overrides.skillVersion ?? '1.0.0'}\n---\n${overrides.skillBody ?? 'Use the tools.'}`
    ),
    'skills/analysis-tools/scripts/run.sh': encoder.encode('exit 99')
  })

const deletionSkillPlan = (id: string): SpecialistPackageSkillPlan => ({
  id,
  version: '1.0.0',
  disposition: 'install',
  files: ['SKILL.md'],
  contentHash: id.padEnd(64, 'a').slice(0, 64),
  filesToInstall: [
    {
      path: 'SKILL.md',
      bytes: encoder.encode(`---\nname: ${id}\ndescription: ${id}\n---\n${id}`)
    }
  ]
})

const githubSkill =
  (body: string): FetchLike =>
  async (url: string) => {
    if (url.includes('/contents/')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            type: 'file',
            name: 'SKILL.md',
            path: 'analysis-tools/SKILL.md',
            download_url: 'https://raw.example/analysis-tools'
          }
        ],
        arrayBuffer: async () => new ArrayBuffer(0)
      }
    }
    const bytes = encoder.encode(body)
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    }
  }

let storageDir: string

beforeEach(async () => {
  storageDir = join(tmpdir(), `specialist-package-${randomUUID()}`)
  await mkdir(storageDir, { recursive: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(storageDir, { recursive: true, force: true })
})

describe('SpecialistPackageService', () => {
  it('keeps newly imported Skills off for Main and preserves later user choices on overwrite', async () => {
    const repository = new SpecialistStorageFixture(storageDir)
    const skillPort = new UserSkillSpecialistPackageAdapter(storageDir)
    const settings = new SettingsRepository(storageDir, (operation) =>
      skillPort.runMutationExclusive(operation)
    )
    const service = createHostSpecialistPackages({
      storageDir,
      domain: repository.domain,
      skillPort,
      skillSettings: settings,
      catalog: async () => ({
        ...catalog,
        skills: (await skillPort.snapshot()).map((skill) => ({
          ...skill,
          name: skill.id.replace(/^personal-/, ''),
          builtin: false,
          mainEnabled: true
        }))
      })
    })
    const preview = await service.preview(bundledZip())
    await expect(
      service.install({ candidateToken: preview.candidateToken })
    ).resolves.toMatchObject({
      status: 'installed',
      specialist: { enabled: false, setupPending: true }
    })
    expect((await settings.getSettings()).disabledSkillIds).toEqual(['personal-analysis-tools'])
    await settings.setSkillEnabled('personal-analysis-tools', true)
    const overwrite = await service.preview(bundledZip())
    expect(overwrite.summary?.skills[0].disposition).toBe('reuse-owned')
    await expect(
      service.install({ candidateToken: overwrite.candidateToken, confirmOverwrite: true })
    ).resolves.toMatchObject({ status: 'installed' })
    expect((await settings.getSettings()).disabledSkillIds).toBeUndefined()
    const withAdditionalSkill = zipSync({
      ...unzipSync(bundledZip()),
      'manifest.json': encoder.encode(
        JSON.stringify({
          schema_version: 1,
          id: 'research-synth',
          version: '1.4.0',
          exported_with_app_version: '0.9.2'
        })
      ),
      'skills/new-analysis/SKILL.md': encoder.encode(
        '---\nname: new-analysis\ndescription: Additional analysis\nversion: 1.0.0\n---\nNew analysis.'
      )
    })
    const adding = await service.preview(withAdditionalSkill)
    expect(adding.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    await expect(
      service.install({ candidateToken: adding.candidateToken, confirmOverwrite: true })
    ).resolves.toMatchObject({ status: 'installed' })
    expect((await settings.getSettings()).disabledSkillIds).toEqual(['personal-new-analysis'])
  })

  it('preserves the real installed Skill body when the caller chooses the installed version', async () => {
    const repository = new SpecialistStorageFixture(storageDir)
    const skillPort = new UserSkillSpecialistPackageAdapter(storageDir)
    const userSkills = new UserSkillRepository(storageDir)
    const installedPlan = validateSpecialistZip(bundledZip(), catalog, parseSkillDocument).plan!
      .skills[0]
    await skillPort.prepare('seed-conflict', 'former-owner', [installedPlan])
    await skillPort.commit('seed-conflict')
    await skillPort.recover('seed-conflict', 'commit')
    const service = createHostSpecialistPackages({
      storageDir,
      domain: repository.domain,
      skillPort,
      catalog: async () => ({
        ...catalog,
        skills: (await skillPort.snapshot()).map((skill) => ({
          ...skill,
          name: skill.id.replace(/^personal-/, ''),
          builtin: false,
          mainEnabled: true
        }))
      })
    })

    const preview = await service.preview(
      bundledZip({ skillVersion: '2.0.0', skillBody: 'Use the replacement.' })
    )
    const result = await service.install({
      candidateToken: preview.candidateToken,
      skillConflictResolutions: [{ skillId: 'analysis-tools', resolution: 'use-installed' }]
    })
    expect(result).toMatchObject({
      status: 'installed',
      specialist: {
        selectedCapabilities: { skillIds: ['personal-analysis-tools'] },
        ownedSkillIds: []
      }
    })
    await expect(userSkills.body('personal-analysis-tools')).resolves.toContain('Use the tools.')
  })

  it('atomically replaces an installed Skill while the live catalog shares the mutation owner', async () => {
    const repository = new SpecialistStorageFixture(storageDir)
    const skillPort = new UserSkillSpecialistPackageAdapter(storageDir)
    const userSkills = new UserSkillRepository(storageDir)
    const installedPlan = validateSpecialistZip(bundledZip(), catalog, parseSkillDocument).plan!
      .skills[0]
    await skillPort.prepare('seed-replacement', 'former-owner', [installedPlan])
    await skillPort.commit('seed-replacement')
    await skillPort.recover('seed-replacement', 'commit')
    const service = createHostSpecialistPackages({
      storageDir,
      domain: repository.domain,
      skillPort,
      catalog: () =>
        skillPort.runMutationExclusive(async () => ({
          ...catalog,
          skills: (await skillPort.snapshot()).map((skill) => ({
            ...skill,
            name: skill.id.replace(/^personal-/, ''),
            builtin: false
          }))
        }))
    })
    const preview = await service.preview(
      bundledZip({ skillVersion: '2.0.0', skillBody: 'Use the replacement.' })
    )

    const result = await service.install({
      candidateToken: preview.candidateToken,
      skillConflictResolutions: [{ skillId: 'analysis-tools', resolution: 'use-incoming' }]
    })

    expect(result).toMatchObject({
      status: 'installed',
      specialist: { ownedSkillIds: ['personal-analysis-tools'] }
    })
    await expect(userSkills.body('personal-analysis-tools')).resolves.toContain(
      'Use the replacement.'
    )
    await expect(skillPort.snapshot()).resolves.toEqual([
      expect.objectContaining({
        id: 'personal-analysis-tools',
        version: '2.0.0',
        standalone: false,
        ownerIds: ['former-owner', 'research-synth']
      })
    ])
  }, 2_000)

  it('coexists with a same-ID GitHub import that lands while package Skill preparation is paused', async () => {
    const repository = new SpecialistStorageFixture(storageDir)
    const skillPort = new UserSkillSpecialistPackageAdapter(storageDir)
    const userSkills = new UserSkillRepository(storageDir)
    const originalPrepare = skillPort.prepare.bind(skillPort)
    let prepared!: () => void
    const preparedSignal = new Promise<void>((resolve) => {
      prepared = resolve
    })
    let continueInstall!: () => void
    const installBarrier = new Promise<void>((resolve) => {
      continueInstall = resolve
    })
    vi.spyOn(skillPort, 'prepare').mockImplementation(async (...args) => {
      await originalPrepare(...args)
      prepared()
      await installBarrier
    })
    const service = createHostSpecialistPackages({
      storageDir,
      domain: repository.domain,
      skillPort,
      catalog: async () => ({
        ...catalog,
        skills: (await skillPort.snapshot()).map((skill) => ({
          ...skill,
          name: skill.id.replace(/^personal-/, ''),
          builtin: false
        }))
      })
    })
    const preview = await service.preview(bundledZip())
    const installation = service.install({ candidateToken: preview.candidateToken })
    await preparedSignal

    await userSkills.importFromGitHub(
      'https://github.com/acme/skills/tree/main/analysis-tools',
      githubSkill(
        '---\nname: analysis-tools\ndescription: Standalone\n---\nKeep the GitHub version.'
      )
    )
    continueInstall()

    // Package Skills install under Personal while the GitHub copy stays under Imported:
    // same ID, independent sources.
    await expect(installation).resolves.toEqual({
      status: 'installed',
      specialist: expect.objectContaining({ id: 'research-synth' })
    })
    await expect(userSkills.body('imported-analysis-tools')).resolves.toContain(
      'Keep the GitHub version.'
    )
    await expect(userSkills.body('personal-analysis-tools')).resolves.toContain('Use the tools.')
  })

  it('keeps a reused standalone Skill when direct deletion races the durable Specialist commit', async () => {
    const repository = new SpecialistStorageFixture(storageDir)
    const skillPort = new UserSkillSpecialistPackageAdapter(storageDir)
    const userSkills = new UserSkillRepository(storageDir)
    const bundledPlan = validateSpecialistZip(bundledZip(), catalog, parseSkillDocument).plan!
      .skills[0]
    await skillPort.prepare('seed-standalone', 'former-owner', [bundledPlan])
    await skillPort.commit('seed-standalone')
    await skillPort.recover('seed-standalone', 'commit')
    await skillPort.prepareDeletion(
      'release-standalone',
      'former-owner',
      ['personal-analysis-tools'],
      []
    )
    await skillPort.commit('release-standalone')
    await skillPort.recover('release-standalone', 'commit')

    const service = createHostSpecialistPackages({
      storageDir,
      domain: repository.domain,
      skillPort,
      catalog: async () => ({
        ...catalog,
        skills: (await skillPort.snapshot()).map((skill) => ({
          ...skill,
          name: skill.id.replace(/^personal-/, ''),
          builtin: false
        }))
      })
    })
    const preview = await service.preview(bundledZip())
    expect(preview.summary?.skills).toEqual([
      expect.objectContaining({ id: 'analysis-tools', disposition: 'reuse-standalone' })
    ])

    const originalBegin = skillPort.beginMutation.bind(skillPort)
    let mutationBegun!: () => void
    const mutationSignal = new Promise<void>((resolve) => {
      mutationBegun = resolve
    })
    let continueCommit!: () => void
    const commitBarrier = new Promise<void>((resolve) => {
      continueCommit = resolve
    })
    vi.spyOn(skillPort, 'beginMutation').mockImplementation(async (...args) => {
      await originalBegin(...args)
      mutationBegun()
      await commitBarrier
    })

    const installation = service.install({ candidateToken: preview.candidateToken })
    await mutationSignal
    const deletion = userSkills.delete('personal-analysis-tools', (skillId) =>
      service.assertSkillDeletionAllowed(skillId)
    )
    continueCommit()

    await expect(installation).resolves.toMatchObject({ status: 'installed' })
    await expect(deletion).rejects.toMatchObject({
      code: 'protected-skill',
      skillId: 'personal-analysis-tools',
      specialistIds: ['research-synth']
    })
    await expect(userSkills.body('personal-analysis-tools')).resolves.toContain('Use the tools.')
  })

  it('exports a personal Skill under its portable ID without the personal source prefix', async () => {
    const repository = new SpecialistStorageFixture(storageDir)
    const skillPort = new UserSkillSpecialistPackageAdapter(storageDir)
    const skillDirectory = join(storageDir, 'skills', 'personal', 'literature-review')
    await mkdir(skillDirectory, { recursive: true })
    await writeFile(
      join(skillDirectory, 'SKILL.md'),
      '---\nname: Literature Review\ndescription: Review literature\n---\nReview.'
    )
    await repository.insert({
      id: 'research-synth',
      name: 'RESEARCH_SYNTH',
      description: 'Synthesizes research.',
      systemPrompt: 'Portable instructions.',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: {
        skillIds: ['personal-literature-review'],
        connectorIds: [],
        connectorTools: []
      },
      revision: 1,
      packageVersion: '1.0.0',
      origin: 'local',
      ownedSkillIds: []
    })
    const service = createHostSpecialistPackages({
      storageDir,
      domain: repository.domain,
      skillPort,
      catalog: async () => ({
        ...catalog,
        skills: (await skillPort.snapshot()).map((skill) => ({
          ...skill,
          name: skill.id.replace(/^(?:personal|imported)-/, ''),
          builtin: false
        }))
      })
    })

    const exported = await service.export({
      specialistId: 'research-synth',
      expectedRevision: 1,
      includedSkillIds: ['personal-literature-review']
    })
    expect(exported.fileName).toBe('open-science-specialist-research-synth-v1.0.0.zip')
    const archive = unzipSync(exported.archiveBytes)
    const payload = JSON.parse(strFromU8(archive['specialist.json']!)) as {
      skill_ids: string[]
    }

    expect(payload.skill_ids).toEqual(['literature-review'])
    expect(archive['skills/literature-review/SKILL.md']).toBeDefined()
    expect(archive['skills/personal-literature-review/SKILL.md']).toBeUndefined()
  })

  it('protects Marketplace packages while preserving local presentation across updates', async () => {
    const repository = new SpecialistStorageFixture(storageDir)
    const service = createHostSpecialistPackages({
      storageDir,
      domain: repository.domain,
      catalog: async () => catalog
    })
    const initial = await service.preview(validZip(), undefined, { origin: 'marketplace' })
    await expect(
      service.install({ candidateToken: initial.candidateToken }, undefined, {
        activateAfterInstall: true,
        origin: 'marketplace'
      })
    ).resolves.toMatchObject({
      status: 'installed',
      specialist: { origin: 'marketplace', enabled: true }
    })
    await repository.domain.catalog.update({
      id: 'research-synth',
      revision: 1,
      iconKey: 'dna',
      colorKey: 'blue'
    })

    const update = await service.preview(
      validZip({ version: '1.4.0', description: 'Publisher update.' }),
      undefined,
      { origin: 'marketplace' }
    )
    expect(update.installable).toBe(true)
    await service.install(
      { candidateToken: update.candidateToken, confirmOverwrite: true },
      undefined,
      { activateAfterInstall: true, origin: 'marketplace' }
    )
    await expect(repository.domain.catalog.getById('research-synth')).resolves.toMatchObject({
      origin: 'marketplace',
      packageVersion: '1.4.0',
      description: 'Publisher update.',
      iconKey: 'dna',
      colorKey: 'blue'
    })

    const manualOverwrite = await service.preview(
      validZip({ version: '1.5.0', description: 'Manual replacement.' })
    )
    expect(manualOverwrite.installable).toBe(false)
    expect(manualOverwrite.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'specialist.overwrite-marketplace-managed' })
    )
  })

  it('forwards Marketplace activation to the package transaction', async () => {
    const repository = new SpecialistStorageFixture(storageDir)
    const service = createHostSpecialistPackages({
      storageDir,
      domain: repository.domain,
      catalog: async () => catalog
    })
    const preview = await service.preview(validZip())

    await expect(
      service.install({ candidateToken: preview.candidateToken }, undefined, {
        activateAfterInstall: true
      })
    ).resolves.toMatchObject({
      status: 'installed',
      specialist: {
        id: 'research-synth',
        enabled: true,
        setupPending: false
      }
    })
    await expect(repository.domain.catalog.getById('research-synth')).resolves.toMatchObject({
      enabled: true,
      setupPending: false
    })
  })

  it('atomically deletes selected exclusive Skills and makes retained owned Skills standalone', async () => {
    const repository = new SpecialistStorageFixture(storageDir)
    await repository.insert({
      id: 'research-synth',
      name: 'Research Synthesizer',
      description: '',
      systemPrompt: 'Private instructions.',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: {
        skillIds: ['exclusive', 'retained'],
        connectorIds: [],
        connectorTools: []
      },
      revision: 3,
      packageVersion: '1.0.0',
      origin: 'imported',
      ownedSkillIds: ['exclusive', 'retained']
    })
    const skillPort = new UserSkillSpecialistPackageAdapter(storageDir)
    await skillPort.prepare('seed-skills', 'research-synth', [
      deletionSkillPlan('exclusive'),
      deletionSkillPlan('retained')
    ])
    await skillPort.commit('seed-skills')
    await skillPort.recover('seed-skills', 'commit')
    const service = createHostSpecialistPackages({
      storageDir,
      domain: repository.domain,
      skillPort,
      catalog: async () => ({
        ...catalog,
        skills: (await skillPort.snapshot()).map((skill) => ({ ...skill, builtin: false }))
      })
    })

    await expect(
      service.deleteSpecialist({
        id: 'research-synth',
        expectedRevision: 3,
        deleteSkillIds: ['exclusive']
      })
    ).resolves.toEqual({ status: 'deleted' })
    await expect(repository.domain.catalog.getById('research-synth')).rejects.toThrow(/not found/i)
    await expect(new UserSkillRepository(storageDir).list()).resolves.toEqual([
      expect.objectContaining({ id: 'retained' })
    ])
    await expect(skillPort.snapshot()).resolves.toEqual([
      expect.objectContaining({ id: 'retained', standalone: true, ownerIds: [] })
    ])
  })

  it('waits for an in-flight Marketplace operation before deleting a Specialist', async () => {
    const repository = new SpecialistStorageFixture(storageDir)
    await repository.insert({
      id: 'managed-specialist',
      name: 'MANAGED_SPECIALIST',
      description: 'Publisher description.',
      systemPrompt: 'Publisher instructions.',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
      revision: 1,
      packageVersion: '1.0.0',
      origin: 'marketplace',
      ownedSkillIds: []
    })
    const coordinator = new MarketplaceOperationCoordinator()
    let releaseOperation: (() => void) | undefined
    let operationStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      operationStarted = resolve
    })
    const inFlight = coordinator.runExclusive(
      () =>
        new Promise<void>((resolve) => {
          releaseOperation = resolve
          operationStarted?.()
        })
    )
    await started
    const service = createHostSpecialistPackages({
      storageDir,
      domain: repository.domain,
      catalog: async () => catalog,
      operationCoordinator: coordinator
    })

    let deletionSettled = false
    const deletion = service
      .deleteSpecialist({
        id: 'managed-specialist',
        expectedRevision: 1,
        deleteSkillIds: []
      })
      .finally(() => {
        deletionSettled = true
      })
    await Promise.resolve()

    expect(deletionSettled).toBe(false)
    await expect(repository.domain.catalog.getById('managed-specialist')).resolves.toBeDefined()

    releaseOperation?.()
    await inFlight
    await expect(deletion).resolves.toEqual({ status: 'deleted' })
  })

  it('atomically deletes a standalone Skill used only by the deleted Specialist', async () => {
    const repository = new SpecialistStorageFixture(storageDir)
    const userSkills = new UserSkillRepository(storageDir)
    const skillId = await userSkills.createPersonal({
      name: 'standalone-exclusive',
      description: 'Used only by one Specialist.',
      body: 'Exclusive instructions.'
    })
    const settings = new SettingsRepository(storageDir)
    await settings.setSkillEnabled(skillId, false)
    await repository.insert({
      id: 'research-synth',
      name: 'Research Synthesizer',
      description: '',
      systemPrompt: '',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [skillId], connectorIds: [], connectorTools: [] },
      revision: 1,
      packageVersion: '1.0.0',
      origin: 'imported',
      ownedSkillIds: []
    })
    const skillPort = new UserSkillSpecialistPackageAdapter(storageDir)
    const service = createHostSpecialistPackages({
      storageDir,
      domain: repository.domain,
      skillPort,
      catalog: async () => ({
        ...catalog,
        skills: (await skillPort.snapshot()).map((skill) => ({
          ...skill,
          builtin: false,
          mainEnabled: false
        }))
      }),
      onSkillsDeleted: async (skillIds) => {
        await settings.setSkillsEnabled([...skillIds], true)
      }
    })
    const preview = await service.previewSpecialistDelete({ id: 'research-synth' })
    expect(preview.skills).toEqual([
      expect.objectContaining({ id: skillId, kind: 'exclusive', deletable: true, reasons: [] })
    ])

    await expect(
      service.deleteSpecialist({
        id: 'research-synth',
        expectedRevision: preview.expectedRevision,
        deleteSkillIds: [skillId]
      })
    ).resolves.toEqual({ status: 'deleted' })
    await expect(repository.domain.catalog.getById('research-synth')).rejects.toThrow(/not found/i)
    await expect(userSkills.list()).resolves.toEqual([])
    await expect(settings.getSettings()).resolves.not.toHaveProperty('disabledSkillIds')
  })

  it('completes deletion when the live catalog shares the Skill mutation owner', async () => {
    const repository = new SpecialistStorageFixture(storageDir)
    const userSkills = new UserSkillRepository(storageDir)
    const skillId = await userSkills.createPersonal({
      name: 'locked-delete',
      description: 'Exercises the production Skill catalog lock path.',
      body: 'Locked deletion instructions.'
    })
    await repository.insert({
      id: 'owner',
      name: 'Owner',
      description: '',
      systemPrompt: '',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [skillId], connectorIds: [], connectorTools: [] },
      revision: 1,
      packageVersion: '1.0.0',
      origin: 'imported',
      ownedSkillIds: []
    })
    const skillPort = new UserSkillSpecialistPackageAdapter(storageDir)
    const service = createHostSpecialistPackages({
      storageDir,
      domain: repository.domain,
      skillPort,
      catalog: () =>
        skillPort.runMutationExclusive(async () => ({
          ...catalog,
          skills: (await skillPort.snapshot()).map((skill) => ({
            ...skill,
            builtin: false,
            mainEnabled: false
          }))
        }))
    })
    const preview = await service.previewSpecialistDelete({ id: 'owner' })

    await expect(
      service.deleteSpecialist({
        id: 'owner',
        expectedRevision: preview.expectedRevision,
        deleteSkillIds: [skillId]
      })
    ).resolves.toEqual({ status: 'deleted' })
    await expect(repository.domain.catalog.getById('owner')).rejects.toThrow(/not found/i)
    await expect(userSkills.list()).resolves.toEqual([])
  }, 2_000)

  it('keeps committed relationship cleanup recoverable instead of reporting deletion success', async () => {
    const repository = new SpecialistStorageFixture(storageDir)
    const userSkills = new UserSkillRepository(storageDir)
    const skillId = await userSkills.createPersonal({
      name: 'recoverable-cleanup',
      description: 'Exercises committed deletion cleanup recovery.',
      body: 'Recovery instructions.'
    })
    await repository.insert({
      id: 'cleanup-owner',
      name: 'Cleanup Owner',
      description: '',
      systemPrompt: '',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [skillId], connectorIds: [], connectorTools: [] },
      revision: 1,
      packageVersion: '0.1.0',
      origin: 'marketplace',
      ownedSkillIds: []
    })
    const skillPort = new UserSkillSpecialistPackageAdapter(storageDir)
    const catalogWithSkill = async (): Promise<SpecialistPackageCatalogSnapshot> => ({
      ...catalog,
      skills: (await skillPort.snapshot()).map((skill) => ({
        ...skill,
        builtin: false,
        mainEnabled: false
      }))
    })
    const onSpecialistDeleted = vi
      .fn<(specialistId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('Marketplace unavailable'))
      .mockRejectedValueOnce(new Error('Marketplace still unavailable'))
      .mockRejectedValueOnce(new Error('Marketplace remains unavailable'))
      .mockResolvedValue(undefined)
    const onSkillsDeleted = vi.fn<(skillIds: readonly string[]) => Promise<void>>()
    const onResourcesDeleted =
      vi.fn<(specialistId: string, skillIds: readonly string[]) => Promise<void>>()
    const onCommitted = vi.fn()
    const options = {
      storageDir,
      domain: repository.domain,
      skillPort,
      catalog: catalogWithSkill,
      onSpecialistDeleted,
      onSkillsDeleted,
      onResourcesDeleted,
      onCommitted
    }
    const service = createHostSpecialistPackages(options)
    const preview = await service.previewSpecialistDelete({ id: 'cleanup-owner' })

    const result = await service.deleteSpecialist({
      id: 'cleanup-owner',
      expectedRevision: preview.expectedRevision,
      deleteSkillIds: [skillId]
    })

    expect(result).toEqual({ status: 'failed', code: 'recovery-failed' })
    expect(onCommitted).toHaveBeenCalledOnce()
    await expect(repository.domain.catalog.getById('cleanup-owner')).rejects.toThrow(/not found/i)
    await expect(userSkills.list()).resolves.toEqual([])
    const recoveryService = createHostSpecialistPackages({
      ...options,
      domain: repository.restart()
    })
    const guardedSpecialists = repository.domain.catalog
    await expect(guardedSpecialists.create({ name: 'Cleanup Owner' })).rejects.toThrow(
      /recovery failed/i
    )
    // Simulate a legacy external writer while the new owner keeps its recovery barrier closed.
    const unrelated = {
      ...(await repository.getAll()).specialists[0],
      id: 'unrelated-edit',
      name: 'Unrelated Edit',
      description: '',
      systemPrompt: '',
      enabled: true,
      capabilityMode: 'selected' as const,
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
      revision: 1,
      packageVersion: '0.1.0',
      origin: 'local' as const,
      ownedSkillIds: []
    }
    await repository.insert(unrelated)
    const guardedUserSkills = new UserSkillRepository(storageDir, {
      withExternalRecoveryBarrier: (operation) => recoveryService.withRecoveryBarrier(operation)
    })

    await expect(
      guardedUserSkills.createPersonal({
        name: 'recoverable-cleanup',
        description: 'Must not appear before cleanup succeeds.',
        body: 'Blocked recreation instructions.'
      })
    ).rejects.toThrow(/recovery failed/i)
    await guardedUserSkills.createPersonal({
      name: 'recoverable-cleanup',
      description: 'Recreated after cleanup.',
      body: 'Safe recreation instructions.'
    })

    expect(onSpecialistDeleted).toHaveBeenCalledTimes(4)
    expect(onSpecialistDeleted).toHaveBeenLastCalledWith('cleanup-owner')
    expect(onSkillsDeleted).toHaveBeenCalledWith([skillId])
    expect(onResourcesDeleted).toHaveBeenCalledWith('cleanup-owner', [skillId])
    await expect(guardedUserSkills.list()).resolves.toEqual([
      expect.objectContaining({ id: skillId, description: 'Recreated after cleanup.' })
    ])
    await expect(repository.domain.catalog.getById(unrelated.id)).resolves.toMatchObject({
      id: unrelated.id,
      name: 'Unrelated Edit'
    })
  })

  it('rolls back prepared Skill deletion when the Specialist document swap fails', async () => {
    const repository = new SpecialistStorageFixture(storageDir)
    await repository.insert({
      id: 'rollback-owner',
      name: 'Rollback Owner',
      description: '',
      systemPrompt: '',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: ['rollback-skill'], connectorIds: [], connectorTools: [] },
      revision: 1,
      packageVersion: '1.0.0',
      origin: 'imported',
      ownedSkillIds: ['rollback-skill']
    })
    const skillPort = new UserSkillSpecialistPackageAdapter(storageDir)
    await skillPort.prepare('seed-rollback', 'rollback-owner', [
      deletionSkillPlan('rollback-skill')
    ])
    await skillPort.commit('seed-rollback')
    await skillPort.recover('seed-rollback', 'commit')
    const service = createHostSpecialistPackages({
      storageDir,
      domain: repository.domain,
      skillPort,
      catalog: async () => ({
        ...catalog,
        skills: (await skillPort.snapshot()).map((skill) => ({ ...skill, builtin: false }))
      })
    })
    const preview = await service.previewSpecialistDelete({ id: 'rollback-owner' })
    const rename = fileSystem.rename
    vi.spyOn(fileSystem, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination) === join(storageDir, 'specialists.json'))
        throw new Error('durable write failed')
      return rename(source, destination)
    })

    await expect(
      service.deleteSpecialist({
        id: 'rollback-owner',
        expectedRevision: preview.expectedRevision,
        deleteSkillIds: ['rollback-skill']
      })
    ).resolves.toEqual({ status: 'failed', code: 'commit-failed' })
    await expect(repository.domain.catalog.getById('rollback-owner')).resolves.toBeDefined()
    await expect(skillPort.snapshot()).resolves.toEqual([
      expect.objectContaining({ id: 'rollback-skill', ownerIds: ['rollback-owner'] })
    ])
  })
})
