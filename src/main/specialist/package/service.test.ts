import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { strFromU8, unzipSync, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  SpecialistPackageCatalogSnapshot,
  SpecialistPackageSkillPlan
} from '../../../shared/specialist-package'
import { UserSkillSpecialistPackageAdapter } from '../../skills/specialist-package-adapter'
import { UserSkillRepository } from '../../skills/user-skill-repository'
import type { FetchLike } from '../../skills/github-import'
import { SettingsRepository } from '../../settings/repository'
import { SpecialistRepository } from '../repository'
import { ProfileService } from '../service'
import { MarketplaceOperationCoordinator } from '../marketplace/operation-coordinator'
import { SpecialistPackageService, specialistExportFileName } from './service'
import { NOOP_SPECIALIST_PACKAGE_SKILL_PORT, type SpecialistPackageSkillPort } from './skill-port'
import { specialistLegacyPayloadContentHash } from './validator'
import { validateSpecialistZip } from './zip-adapter'

const encoder = new TextEncoder()
const catalog: SpecialistPackageCatalogSnapshot = {
  appVersion: '0.9.2',
  builtinSkills: [],
  skills: [],
  connectorIds: [],
  protectedSpecialistIds: ['reviewer']
}

describe('specialistExportFileName', () => {
  it('uses a readable Unicode-safe display name and strips filesystem punctuation', () => {
    expect(specialistExportFileName('RNA / 研究助手:*', '1.2.3', 'fallback-id')).toBe(
      'open-science-specialist-rna-研究助手-v1.2.3.zip'
    )
  })
})

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
  await rm(storageDir, { recursive: true, force: true })
})

describe('SpecialistPackageService', () => {
  it('requires a conflict decision and can keep the installed Skill', async () => {
    const repository = new SpecialistRepository(storageDir)
    const skillPort = new UserSkillSpecialistPackageAdapter(storageDir)
    const userSkills = new UserSkillRepository(storageDir)
    const installedPlan = validateSpecialistZip(bundledZip(), catalog).plan!.skills[0]
    await skillPort.prepare('seed-conflict', 'former-owner', [installedPlan])
    await skillPort.commit('seed-conflict')
    await skillPort.recover('seed-conflict', 'commit')
    await repository.insert({
      id: 'existing-user',
      name: 'Existing User',
      description: 'Uses the installed Skill.',
      systemPrompt: 'Use the current Skill.',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: {
        skillIds: ['personal-analysis-tools'],
        connectorIds: [],
        connectorTools: []
      },
      revision: 1,
      packageVersion: '1.0.0',
      origin: 'local',
      ownedSkillIds: []
    })
    const service = new SpecialistPackageService({
      storageDir,
      repository,
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
    expect(preview.installable).toBe(false)
    expect(preview.summary?.skills[0]).toMatchObject({
      disposition: 'conflict',
      conflict: {
        localId: 'personal-analysis-tools',
        installedVersion: '1.0.0',
        mainEnabled: true,
        specialists: [{ id: 'existing-user', name: 'Existing User' }]
      }
    })
    expect(service.candidateNewSkillIds(preview.candidateToken)).toEqual([])
    await expect(service.install({ candidateToken: preview.candidateToken })).resolves.toEqual({
      status: 'failed',
      code: 'skill-conflict-resolution-required'
    })
    await repository.insert({
      id: 'late-user',
      name: 'Late User',
      description: 'Started using the Skill after preview.',
      systemPrompt: 'Use the installed Skill.',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: {
        skillIds: ['personal-analysis-tools'],
        connectorIds: [],
        connectorTools: []
      },
      revision: 1,
      packageVersion: '1.0.0',
      origin: 'local',
      ownedSkillIds: []
    })
    await expect(
      service.install({
        candidateToken: preview.candidateToken,
        skillConflictResolutions: [{ skillId: 'analysis-tools', resolution: 'use-installed' }]
      })
    ).resolves.toEqual({ status: 'failed', code: 'stale-candidate' })
    const retriedPreview = await service.preview(
      bundledZip({ skillVersion: '2.0.0', skillBody: 'Use the replacement.' })
    )

    const result = await service.install({
      candidateToken: retriedPreview.candidateToken,
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
    const repository = new SpecialistRepository(storageDir)
    const skillPort = new UserSkillSpecialistPackageAdapter(storageDir)
    const userSkills = new UserSkillRepository(storageDir)
    const installedPlan = validateSpecialistZip(bundledZip(), catalog).plan!.skills[0]
    await skillPort.prepare('seed-replacement', 'former-owner', [installedPlan])
    await skillPort.commit('seed-replacement')
    await skillPort.recover('seed-replacement', 'commit')
    const service = new SpecialistPackageService({
      storageDir,
      repository,
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
    const repository = new SpecialistRepository(storageDir)
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
    const service = new SpecialistPackageService({
      storageDir,
      repository,
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
    const repository = new SpecialistRepository(storageDir)
    const skillPort = new UserSkillSpecialistPackageAdapter(storageDir)
    const userSkills = new UserSkillRepository(storageDir)
    const bundledPlan = validateSpecialistZip(bundledZip(), catalog).plan!.skills[0]
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

    const service = new SpecialistPackageService({
      storageDir,
      repository,
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

  it('previews a custom export with owned portable Skills selected by default', async () => {
    const repository = new SpecialistRepository(storageDir)
    await repository.insert({
      id: 'research-synth',
      name: 'RESEARCH_SYNTH',
      displayName: 'Research Synthesizer',
      description: 'Synthesizes research.',
      systemPrompt: 'Portable instructions.',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: {
        skillIds: ['document-reader', 'analysis-tools', 'citation-manager'],
        connectorIds: ['reference-library'],
        connectorTools: [{ connectorId: 'reference-library', includedMethods: ['search'] }]
      },
      revision: 3,
      packageVersion: '1.3.0',
      origin: 'local',
      ownedSkillIds: ['analysis-tools']
    })
    const exportCatalog: SpecialistPackageCatalogSnapshot = {
      appVersion: '0.9.2',
      builtinSkills: [
        {
          id: 'document-reader',
          appVersion: '0.9.2',
          compatibility: 'app:0.9.2:document-reader'
        }
      ],
      skills: [
        { id: 'document-reader', name: 'document-reader', builtin: true },
        {
          id: 'analysis-tools',
          name: 'analysis-tools',
          version: '1.2.3',
          builtin: false,
          ownerIds: ['research-synth']
        },
        { id: 'citation-manager', name: 'citation-manager', builtin: false, standalone: true }
      ],
      connectorIds: ['reference-library'],
      protectedSpecialistIds: ['reviewer']
    }
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => exportCatalog,
      skillPort: {
        snapshot: async () => [],
        prepare: async () => undefined,
        commit: async () => undefined,
        rollback: async () => undefined,
        recover: async () => undefined,
        exportSnapshot: async () => [
          {
            localId: 'analysis-tools',
            name: 'analysis-tools',
            version: '1.2.3',
            contentHash: 'stable',
            files: [
              {
                path: 'SKILL.md',
                bytes: encoder.encode(
                  '---\nname: analysis-tools\ndescription: Analyze data\n---\nUse the tools.'
                )
              }
            ]
          }
        ]
      }
    })

    await expect(service.previewExport('research-synth')).resolves.toMatchObject({
      specialistId: 'research-synth',
      version: '1.3.0',
      fileName: 'open-science-specialist-research-synthesizer-v1.3.0.zip',
      expectedRevision: 3,
      canExport: true,
      skills: [
        { id: 'analysis-tools', kind: 'owned', selected: true, version: '1.2.3' },
        { id: 'citation-manager', kind: 'referenced', selected: false, version: '0.1.0' },
        { id: 'document-reader', kind: 'builtin', selected: false, selectable: false }
      ],
      connectorIds: ['reference-library']
    })
  })

  it('keeps full-access Connector exclusions canonical across legacy aliases', async () => {
    const repository = new SpecialistRepository(storageDir)
    await repository.insert({
      id: 'legacy-exclusion',
      name: 'LEGACY_EXCLUSION',
      displayName: 'Legacy exclusion',
      description: '',
      systemPrompt: '',
      enabled: true,
      capabilityMode: 'full',
      fullAccess: {
        excludedSkillIds: [],
        excludedConnectorIds: ['Example Connector'],
        connectorTools: []
      },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
      revision: 1,
      packageVersion: '1.0.0',
      origin: 'local',
      ownedSkillIds: []
    })
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => ({
        ...catalog,
        connectorIds: ['example-connector'],
        connectorAliases: { 'Example Connector': 'example-connector' }
      })
    })

    await expect(service.previewExport('legacy-exclusion')).resolves.toMatchObject({
      connectorIds: []
    })
  })

  it('blocks package export with actionable diagnostics when the profile is incomplete', async () => {
    const repository = new SpecialistRepository(storageDir)
    await repository.insert({
      id: 'draft-specialist',
      name: 'DRAFT_SPECIALIST',
      displayName: 'Draft Specialist',
      description: '',
      systemPrompt: '',
      enabled: false,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
      revision: 1,
      packageVersion: '1.0.0',
      origin: 'local',
      ownedSkillIds: []
    })
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog
    })

    await expect(service.previewExport('draft-specialist')).resolves.toMatchObject({
      canExport: false,
      diagnostics: [
        {
          severity: 'error',
          code: 'specialist.description-invalid',
          message: expect.stringContaining('description')
        },
        {
          severity: 'error',
          code: 'specialist.system-prompt-invalid',
          message: expect.stringContaining('system prompt')
        }
      ]
    })
    await expect(
      service.export({
        specialistId: 'draft-specialist',
        expectedRevision: 1,
        includedSkillIds: []
      })
    ).rejects.toThrow(/description.*system prompt/i)
  })

  it('exports builtin and owned Skills with exact IDs and editable capability references only', async () => {
    const repository = new SpecialistRepository(storageDir)
    await repository.insert({
      id: 'research-synth',
      name: 'RESEARCH_SYNTH',
      displayName: 'Research Synthesizer',
      description: 'Synthesizes research.',
      systemPrompt: 'Portable instructions.',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: {
        skillIds: ['document-reader', 'analysis-tools'],
        connectorIds: ['reference-library'],
        connectorTools: []
      },
      revision: 3,
      packageVersion: '1.3.0',
      origin: 'local',
      ownedSkillIds: ['analysis-tools']
    })
    const exportCatalog: SpecialistPackageCatalogSnapshot = {
      appVersion: '0.9.2',
      builtinSkills: [
        {
          id: 'document-reader',
          appVersion: '0.9.2',
          compatibility: 'app:0.9.2:document-reader'
        }
      ],
      skills: [
        { id: 'document-reader', name: 'document-reader', builtin: true },
        {
          id: 'analysis-tools',
          name: 'analysis-tools',
          version: '1.2.3',
          builtin: false,
          ownerIds: ['research-synth']
        }
      ],
      connectorIds: ['reference-library'],
      protectedSpecialistIds: ['reviewer']
    }
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => exportCatalog,
      skillPort: {
        snapshot: async () => [],
        prepare: async () => undefined,
        commit: async () => undefined,
        rollback: async () => undefined,
        recover: async () => undefined,
        exportSnapshot: async () => [
          {
            localId: 'analysis-tools',
            name: 'analysis-tools',
            version: '1.2.3',
            contentHash: 'stable',
            files: [
              {
                path: 'SKILL.md',
                bytes: encoder.encode(
                  '---\nname: analysis-tools\ndisplayName: Analysis Tools\ndescription: Analyze data\n---\nUse the tools.'
                )
              }
            ]
          }
        ]
      }
    })

    const exported = await service.export({
      specialistId: 'research-synth',
      expectedRevision: 3,
      includedSkillIds: ['analysis-tools']
    })
    const archive = unzipSync(exported.archiveBytes)
    const payload = JSON.parse(strFromU8(archive['specialist.json']!)) as Record<string, unknown>

    expect(Object.keys(payload).sort()).toEqual([
      'connector_ids',
      'description',
      'display_name',
      'name',
      'skill_ids',
      'system_prompt'
    ])
    expect(payload.skill_ids).toEqual(['document-reader', 'analysis-tools'])
    expect(payload.connector_ids).toEqual(['reference-library'])
    expect(archive['skills/document-reader/SKILL.md']).toBeUndefined()
    expect(archive['skills/analysis-tools/SKILL.md']).toBeDefined()
    expect(archive['skills/os-document-reader/SKILL.md']).toBeUndefined()
    expect(strFromU8(archive['skills/analysis-tools/SKILL.md']!)).not.toContain('displayName')
  })

  it('exports a personal Skill under its portable ID without the personal source prefix', async () => {
    const repository = new SpecialistRepository(storageDir)
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
    const service = new SpecialistPackageService({
      storageDir,
      repository,
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
    const archive = unzipSync(exported.archiveBytes)
    const payload = JSON.parse(strFromU8(archive['specialist.json']!)) as {
      skill_ids: string[]
    }

    expect(payload.skill_ids).toEqual(['literature-review'])
    expect(archive['skills/literature-review/SKILL.md']).toBeDefined()
    expect(archive['skills/personal-literature-review/SKILL.md']).toBeUndefined()
  })

  it('warns without auto-bumping when imported content changed at the same version', async () => {
    const repository = new SpecialistRepository(storageDir)
    await repository.insert({
      id: 'research-synth',
      name: 'RESEARCH_SYNTH',
      description: 'Edited after import.',
      systemPrompt: 'Portable instructions.',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
      revision: 4,
      packageVersion: '1.3.0',
      origin: 'imported',
      ownedSkillIds: [],
      importBaseline: {
        importedAt: '2026-08-03T00:00:00.000Z',
        archiveDigest: 'archive',
        contentDigest: 'different-content',
        packageVersion: '1.3.0'
      }
    })
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog
    })

    const preview = await service.previewExport('research-synth')
    expect(preview.version).toBe('1.3.0')
    expect(preview.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'specialist.export-version-unchanged'
      })
    )

    const profiles = new ProfileService(repository)
    const bumped = await profiles.update({
      id: 'research-synth',
      revision: 4,
      packageVersion: '2.0.0'
    })
    const bumpedPreview = await service.previewExport('research-synth')
    expect(bumpedPreview.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'specialist.export-version-unchanged' })
    )
    const exported = await service.export({
      specialistId: 'research-synth',
      expectedRevision: bumped.revision,
      includedSkillIds: []
    })
    expect(exported.fileName).toBe('open-science-specialist-research-synth-v2.0.0.zip')
    expect(JSON.parse(strFromU8(unzipSync(exported.archiveBytes)['manifest.json']))).toMatchObject({
      id: 'research-synth',
      version: '2.0.0',
      exported_with_app_version: '0.9.2'
    })
  })

  it('rejects an import whose name is already used by another custom profile', async () => {
    const repository = new SpecialistRepository(storageDir)
    await repository.insert({
      id: 'existing-profile',
      name: 'Research Synthesizer',
      description: '',
      systemPrompt: '',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
      revision: 1,
      packageVersion: '0.1.0',
      origin: 'local',
      ownedSkillIds: []
    })
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog
    })

    const preview = await service.preview(validZip())

    expect(preview.installable).toBe(false)
    expect(preview.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'specialist.name-duplicate' })
    )
  })

  it('rejects protected and missing IDs and fails a save snapshot changed during Skill reads', async () => {
    const repository = new SpecialistRepository(storageDir)
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog
    })
    await expect(service.previewExport('reviewer')).rejects.toThrow(/protected/i)
    await expect(service.previewExport('missing')).rejects.toThrow(/not found/i)

    await repository.insert({
      id: 'research-synth',
      name: 'RESEARCH_SYNTH',
      description: 'Before.',
      systemPrompt: 'Portable instructions.',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: ['analysis-tools'], connectorIds: [], connectorTools: [] },
      revision: 1,
      packageVersion: '1.3.0',
      origin: 'local',
      ownedSkillIds: ['analysis-tools']
    })
    const changingCatalog: SpecialistPackageCatalogSnapshot = {
      ...catalog,
      skills: [{ id: 'analysis-tools', version: '1.0.0', builtin: false }]
    }
    const racing = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => changingCatalog,
      skillPort: {
        snapshot: async () => [],
        prepare: async () => undefined,
        commit: async () => undefined,
        rollback: async () => undefined,
        recover: async () => undefined,
        exportSnapshot: async () => {
          await repository.update('research-synth', { description: 'Changed concurrently.' }, 1)
          return [
            {
              localId: 'analysis-tools',
              name: 'analysis-tools',
              version: '1.0.0',
              contentHash: 'stable',
              files: [
                {
                  path: 'SKILL.md',
                  bytes: encoder.encode(
                    '---\nname: analysis-tools\ndescription: Analyze data\n---\nUse the tools.'
                  )
                }
              ]
            }
          ]
        }
      }
    })
    await expect(
      racing.export({
        specialistId: 'research-synth',
        expectedRevision: 1,
        includedSkillIds: ['analysis-tools']
      })
    ).rejects.toThrow(/changed during export/i)
  })

  it('builds a deterministic canonical archive that round-trips through the import preview', async () => {
    const repository = new SpecialistRepository(storageDir)
    await repository.insert({
      id: 'research-synth',
      name: 'RESEARCH_SYNTH',
      displayName: 'Research Synthesizer',
      description: 'Synthesizes research.',
      systemPrompt: 'Portable user-authored instructions.',
      enabled: false,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: {
        skillIds: ['document-reader', 'analysis-tools', 'citation-manager'],
        connectorIds: ['reference-library'],
        connectorTools: [{ connectorId: 'reference-library', includedMethods: ['search'] }]
      },
      revision: 3,
      packageVersion: '1.3.0',
      origin: 'local',
      ownedSkillIds: ['analysis-tools']
    })
    const exportCatalog: SpecialistPackageCatalogSnapshot = {
      appVersion: '0.9.2',
      builtinSkills: [
        {
          id: 'document-reader',
          appVersion: '0.9.2',
          compatibility: 'app:0.9.2:document-reader'
        }
      ],
      skills: [
        { id: 'document-reader', name: 'document-reader', builtin: true },
        {
          id: 'analysis-tools',
          name: 'analysis-tools',
          version: '1.2.3',
          builtin: false,
          ownerIds: ['research-synth']
        },
        { id: 'citation-manager', name: 'citation-manager', builtin: false, standalone: true }
      ],
      connectorIds: ['reference-library'],
      protectedSpecialistIds: ['reviewer']
    }
    const skillPort: SpecialistPackageSkillPort = {
      snapshot: async () => [],
      prepare: async () => undefined,
      commit: async () => undefined,
      rollback: async () => undefined,
      recover: async () => undefined,
      exportSnapshot: async () => [
        {
          localId: 'analysis-tools',
          name: 'analysis-tools',
          version: '1.2.3',
          contentHash: 'snapshot-hash',
          files: [
            {
              path: 'SKILL.md',
              bytes: encoder.encode(
                '---\nname: Human Analysis Tools\ndescription: Analyze data\n---\nUse the tools.'
              )
            },
            { path: 'references/guide.md', bytes: encoder.encode('Complete reference.') }
          ]
        }
      ]
    }
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => exportCatalog,
      skillPort
    })
    const request = {
      specialistId: 'research-synth',
      expectedRevision: 3,
      includedSkillIds: ['analysis-tools']
    }

    const first = await service.export(request)
    const second = await service.export(request)
    expect(first.fileName).toBe('open-science-specialist-research-synthesizer-v1.3.0.zip')
    expect(second.archiveBytes).toEqual(first.archiveBytes)
    const files = unzipSync(first.archiveBytes)
    expect(Object.keys(files).sort()).toEqual([
      'manifest.json',
      'skills/analysis-tools/SKILL.md',
      'skills/analysis-tools/references/guide.md',
      'specialist.json'
    ])
    const manifest = JSON.parse(strFromU8(files['manifest.json']))
    expect(manifest).not.toHaveProperty('skills')
    expect(strFromU8(files['skills/analysis-tools/SKILL.md'])).toContain('name: "analysis-tools"\n')
    expect(strFromU8(files['skills/analysis-tools/SKILL.md'])).toContain('version: "1.2.3"\n')
    expect(strFromU8(files['specialist.json'])).not.toMatch(
      /enabled|revision|origin|ownedSkillIds|credential|token|permissionGrant|iconKey|colorKey|capabilityMode|fullAccess|selectedCapabilities/i
    )
    const targetStorage = join(storageDir, 'target')
    await mkdir(targetStorage)
    const target = new SpecialistPackageService({
      storageDir: targetStorage,
      repository: new SpecialistRepository(targetStorage),
      catalog: async () => ({
        ...exportCatalog,
        skills: exportCatalog.skills.filter((skill) => skill.id !== 'analysis-tools')
      })
    })
    const targetPreview = await target.preview(first.archiveBytes)
    expect(targetPreview).toMatchObject({
      installable: true,
      summary: {
        id: 'research-synth',
        version: '1.3.0',
        bundledSkillIds: ['analysis-tools'],
        requiredSkillIds: ['document-reader', 'personal-analysis-tools', 'citation-manager'],
        builtinSkillIds: ['document-reader'],
        skills: [expect.objectContaining({ id: 'analysis-tools', version: '1.2.3' })]
      }
    })
    await expect(
      target.install({ candidateToken: targetPreview.candidateToken })
    ).resolves.toMatchObject({
      status: 'installed',
      specialist: {
        id: 'research-synth',
        packageVersion: '1.3.0',
        importBaseline: { packageVersion: '1.3.0' },
        enabled: false,
        setupPending: true,
        ownedSkillIds: ['personal-analysis-tools'],
        systemPrompt: 'Portable user-authored instructions.',
        selectedCapabilities: {
          skillIds: ['document-reader', 'personal-analysis-tools', 'citation-manager'],
          connectorIds: ['reference-library'],
          connectorTools: []
        }
      }
    })
  })

  it('commits bundled Skills and ownership through one package transaction', async () => {
    const live = new Set<string>()
    const staged = new Map<string, readonly string[]>()
    const skillPort: SpecialistPackageSkillPort = {
      snapshot: async () => [],
      prepare: async (transactionId, _specialistId, skills) => {
        staged.set(
          transactionId,
          skills.map((skill) => skill.localId ?? skill.id)
        )
      },
      commit: async (transactionId) => {
        for (const id of staged.get(transactionId) ?? []) live.add(id)
      },
      rollback: async (transactionId) => {
        for (const id of staged.get(transactionId) ?? []) live.delete(id)
        staged.delete(transactionId)
      },
      recover: async (transactionId, outcome) => {
        if (transactionId === undefined) return
        if (outcome === 'rollback') {
          for (const id of staged.get(transactionId) ?? []) live.delete(id)
        }
        staged.delete(transactionId)
      }
    }
    const repository = new SpecialistRepository(storageDir)
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog,
      skillPort
    })

    const preview = await service.preview(bundledZip())
    expect(preview.summary?.skills).toEqual([
      expect.objectContaining({ id: 'analysis-tools', disposition: 'install' })
    ])
    expect(preview.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        'package.executable-content-present',
        'skill.executable-content-present'
      ])
    )
    expect(JSON.stringify(service.report(preview.candidateToken))).not.toContain('exit 99')
    await expect(
      service.install({ candidateToken: preview.candidateToken })
    ).resolves.toMatchObject({
      status: 'installed',
      specialist: { ownedSkillIds: ['personal-analysis-tools'] }
    })
    expect([...live]).toEqual(['personal-analysis-tools'])
  })

  it('preserves prior Skill ownership when a confirmed overwrite adds a bundled Skill', async () => {
    const repository = new SpecialistRepository(storageDir)
    await repository.insert({
      id: 'research-synth',
      name: 'Existing Research Synthesizer',
      description: 'Existing content.',
      systemPrompt: 'Keep existing.',
      enabled: true,
      capabilityMode: 'full',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
      revision: 4,
      packageVersion: '1.2.0',
      origin: 'imported',
      ownedSkillIds: ['previously-owned']
    })
    const skillPort: SpecialistPackageSkillPort = {
      snapshot: async () => [],
      prepare: async () => undefined,
      commit: async () => undefined,
      rollback: async () => undefined,
      recover: async () => undefined
    }
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog,
      skillPort
    })

    const preview = await service.preview(bundledZip())
    await expect(
      service.install({ candidateToken: preview.candidateToken, confirmOverwrite: true })
    ).resolves.toMatchObject({
      status: 'installed',
      specialist: {
        ownedSkillIds: ['previously-owned', 'personal-analysis-tools'],
        revision: 5
      }
    })
  })

  it('exposes a candidate-bound report without the token, prompt, archive bytes, or source path', async () => {
    const service = new SpecialistPackageService({
      storageDir,
      repository: new SpecialistRepository(storageDir),
      catalog: async () => catalog,
      token: () => 'candidate-secret-token'
    })

    const preview = await service.preview(validZip())
    const report = service.report(preview.candidateToken)

    expect(report).toMatchObject({
      schemaVersion: 1,
      summary: { id: 'research-synth', version: '1.3.0' },
      diagnostics: [],
      installable: true
    })
    expect(JSON.stringify(report)).not.toMatch(
      /candidate-secret-token|Private imported instructions|archiveBytes|\/private\//
    )
    expect(service.report('unknown-token')).toBeUndefined()
  })

  it('isolates package candidates and cleanup by renderer owner', async () => {
    let tokenSequence = 0
    const service = new SpecialistPackageService({
      storageDir,
      repository: new SpecialistRepository(storageDir),
      catalog: async () => catalog,
      token: () => `candidate-${++tokenSequence}`
    })

    const first = await service.preview(validZip(), 101)
    const second = await service.preview(validZip(), 202)

    expect(service.report(first.candidateToken, 101)).toBeDefined()
    expect(service.report(first.candidateToken, 202)).toBeUndefined()
    service.dispose(202)
    expect(service.report(second.candidateToken, 202)).toBeUndefined()
    expect(service.report(first.candidateToken, 101)).toBeDefined()
  })

  it('previews and explicitly confirms an atomic overwrite while preserving local enabled state', async () => {
    const repository = new SpecialistRepository(storageDir)
    await repository.insert({
      id: 'research-synth',
      name: 'Existing Research Synthesizer',
      description: 'Existing content.',
      systemPrompt: 'Keep existing.',
      enabled: false,
      capabilityMode: 'full',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
      revision: 4,
      packageVersion: '1.2.0',
      origin: 'local',
      ownedSkillIds: []
    })
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog
    })

    const preview = await service.preview(validZip())
    expect(preview).toMatchObject({
      installable: true,
      overwrite: {
        id: 'research-synth',
        target: 'custom',
        currentVersion: '1.2.0',
        incomingVersion: '1.3.0',
        modifiedSinceImport: false,
        hasImportBaseline: false
      }
    })
    await expect(service.install({ candidateToken: preview.candidateToken })).resolves.toEqual({
      status: 'failed',
      code: 'overwrite-confirmation-required'
    })
    await expect(
      service.install({ candidateToken: preview.candidateToken, confirmOverwrite: true })
    ).resolves.toMatchObject({
      status: 'installed',
      specialist: {
        id: 'research-synth',
        systemPrompt: 'Private imported instructions.',
        enabled: false,
        revision: 5,
        packageVersion: '1.3.0',
        origin: 'imported'
      }
    })
    await expect(new ProfileService(repository).getById('research-synth')).resolves.toMatchObject({
      systemPrompt: 'Private imported instructions.',
      enabled: false,
      revision: 5,
      importBaseline: {
        importedAt: expect.any(String),
        archiveDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        packageContentDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    })
  })

  it('derives modified provenance from the live portable profile and reports version risks', async () => {
    const repository = new SpecialistRepository(storageDir)
    const initial = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog,
      now: () => new Date('2026-08-03T09:00:00.000Z')
    })
    const installed = await initial.preview(validZip())
    await initial.install({ candidateToken: installed.candidateToken })

    const unchanged = await initial.preview(validZip())
    expect(unchanged.overwrite).toMatchObject({ modifiedSinceImport: false })
    expect(unchanged.diagnostics.map((item) => item.code)).toContain(
      'specialist.overwrite-same-version'
    )

    await new ProfileService(repository).update({
      id: 'research-synth',
      revision: 1,
      description: 'Locally edited.'
    })
    const modified = await initial.preview(validZip())
    expect(modified.overwrite).toMatchObject({ modifiedSinceImport: true })
    expect(modified.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'specialist.overwrite-local-modifications',
        'specialist.overwrite-same-version'
      ])
    )

    const changedWithoutBump = await initial.preview(
      validZip({ description: 'Changed package content.' })
    )
    expect(changedWithoutBump.diagnostics.map((item) => item.code)).toContain(
      'specialist.overwrite-content-without-version-bump'
    )
    expect(changedWithoutBump.installable).toBe(false)
    await expect(
      initial.install({ candidateToken: changedWithoutBump.candidateToken, confirmOverwrite: true })
    ).resolves.toMatchObject({ status: 'failed', code: 'candidate-not-installable' })
    const downgrade = await initial.preview(validZip({ version: '1.2.0' }))
    expect(downgrade.diagnostics.map((item) => item.code)).toContain(
      'specialist.overwrite-downgrade'
    )
  })

  it('blocks same-version payload changes for legacy import baselines', async () => {
    const repository = new SpecialistRepository(storageDir)
    const legacyPayload = {
      name: 'Research Synthesizer',
      description: 'Synthesizes research.',
      systemPrompt: 'Private imported instructions.',
      skillIds: [],
      connectorIds: []
    }
    await repository.insert({
      id: 'research-synth',
      ...legacyPayload,
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
      revision: 1,
      packageVersion: '1.3.0',
      origin: 'imported',
      ownedSkillIds: [],
      importBaseline: {
        importedAt: '2026-08-03T00:00:00.000Z',
        archiveDigest: 'legacy-archive-digest',
        contentDigest: specialistLegacyPayloadContentHash(legacyPayload),
        packageVersion: '1.3.0'
      }
    })
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog
    })

    const unchanged = await service.preview(validZip())
    expect(unchanged.installable).toBe(true)
    expect(unchanged.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'specialist.overwrite-content-without-version-bump' })
    )

    const changed = await service.preview(validZip({ description: 'Changed package content.' }))
    expect(changed.installable).toBe(false)
    expect(changed.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'specialist.overwrite-content-without-version-bump' })
    )
  })

  it('protects Marketplace packages while preserving local presentation across updates', async () => {
    const repository = new SpecialistRepository(storageDir)
    const service = new SpecialistPackageService({
      storageDir,
      repository,
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
    await new ProfileService(repository).update({
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
    await expect(new ProfileService(repository).getById('research-synth')).resolves.toMatchObject({
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

  it('ignores local presentation but reports capability setup as modified before overwrite', async () => {
    const repository = new SpecialistRepository(storageDir)
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog
    })
    const initial = await service.preview(validZip())
    await service.install({ candidateToken: initial.candidateToken })

    await new ProfileService(repository).update({
      id: 'research-synth',
      revision: 1,
      iconKey: 'dna',
      colorKey: 'blue'
    })
    const appearanceOnly = await service.preview(validZip())
    expect(appearanceOnly.overwrite).toMatchObject({ modifiedSinceImport: false })
    expect(appearanceOnly.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'specialist.overwrite-local-modifications' })
    )

    await new ProfileService(repository).update({
      id: 'research-synth',
      revision: 2,
      capabilityMode: 'full',
      fullAccess: {
        excludedSkillIds: ['excluded-locally'],
        excludedConnectorIds: [],
        connectorTools: []
      }
    })

    const overwrite = await service.preview(validZip())
    expect(overwrite.overwrite).toMatchObject({ modifiedSinceImport: true })
    expect(overwrite.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'specialist.overwrite-local-modifications' })
    )
  })

  it('warns when a same-version package changes only its Connector references', async () => {
    const repository = new SpecialistRepository(storageDir)
    const packageCatalog = { ...catalog, connectorIds: ['reference-library'] }
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => packageCatalog
    })
    const initial = await service.preview(validZip())
    await service.install({ candidateToken: initial.candidateToken })

    const unchanged = await service.preview(validZip())
    expect(unchanged.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'specialist.overwrite-content-without-version-bump' })
    )
    const changed = await service.preview(validZip({ connectorIds: ['reference-library'] }))
    expect(changed.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'specialist.overwrite-content-without-version-bump' })
    )
  })

  it('keeps legacy import baselines unchanged when their portable payload still matches', async () => {
    const repository = new SpecialistRepository(storageDir)
    const legacyPayload = {
      name: 'Research Synthesizer',
      displayName: 'Research Synthesizer',
      description: 'Synthesizes research.',
      systemPrompt: 'Private imported instructions.'
    }
    const legacyDigest = createHash('sha256').update(JSON.stringify(legacyPayload)).digest('hex')
    await repository.insert({
      id: 'research-synth',
      ...legacyPayload,
      enabled: false,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
      revision: 1,
      packageVersion: '1.3.0',
      origin: 'imported',
      ownedSkillIds: [],
      importBaseline: {
        importedAt: '2026-08-01T00:00:00.000Z',
        archiveDigest: 'legacy-archive',
        contentDigest: legacyDigest,
        packageVersion: '1.3.0'
      }
    })
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog
    })

    const preview = await service.preview(validZip())
    expect(preview.overwrite).toMatchObject({ modifiedSinceImport: false })
    expect(preview.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'specialist.overwrite-content-without-version-bump' })
    )
  })

  it('rejects overwrite confirmation after revision drift without changing the edited profile', async () => {
    const repository = new SpecialistRepository(storageDir)
    await repository.insert({
      id: 'research-synth',
      name: 'Existing Research Synthesizer',
      description: 'Existing content.',
      systemPrompt: 'Keep existing.',
      enabled: true,
      capabilityMode: 'full',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
      revision: 2,
      packageVersion: '1.2.0',
      origin: 'local',
      ownedSkillIds: []
    })
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog
    })
    const preview = await service.preview(validZip())
    await new ProfileService(repository).update({
      id: 'research-synth',
      revision: 2,
      systemPrompt: 'Concurrent edit must survive.'
    })

    await expect(
      service.install({ candidateToken: preview.candidateToken, confirmOverwrite: true })
    ).resolves.toEqual({ status: 'failed', code: 'revision-conflict' })
    await expect(new ProfileService(repository).getById('research-synth')).resolves.toMatchObject({
      systemPrompt: 'Concurrent edit must survive.',
      revision: 3
    })
  })

  it('installs the exact previewed package once as a durable pending Specialist', async () => {
    const repository = new SpecialistRepository(storageDir)
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog,
      token: () => 'one-time-token',
      now: () => new Date('2026-08-03T10:00:00.000Z')
    })

    const preview = await service.preview(validZip())
    expect(preview).toMatchObject({
      candidateToken: 'one-time-token',
      installable: true,
      summary: {
        id: 'research-synth',
        version: '1.3.0',
        bundledSkillIds: [],
        connectorIds: []
      }
    })

    await expect(
      service.install({ candidateToken: preview.candidateToken })
    ).resolves.toMatchObject({
      status: 'installed',
      specialist: {
        id: 'research-synth',
        enabled: false,
        setupPending: true,
        packageVersion: '1.3.0',
        origin: 'imported'
      }
    })
    await expect(service.install({ candidateToken: preview.candidateToken })).resolves.toEqual({
      status: 'failed',
      code: 'stale-candidate'
    })

    const restarted = new ProfileService(new SpecialistRepository(storageDir))
    await expect(restarted.getById('research-synth')).resolves.toMatchObject({
      name: 'Research Synthesizer',
      systemPrompt: 'Private imported instructions.',
      revision: 1
    })
    const edited = await restarted.update({
      id: 'research-synth',
      revision: 1,
      description: 'Edited after import.',
      completeSetup: true
    })
    expect(edited).toMatchObject({
      description: 'Edited after import.',
      enabled: true,
      setupPending: false,
      origin: 'imported',
      packageVersion: '1.3.0',
      ownedSkillIds: []
    })
    const duplicateDraft = await restarted.duplicate('research-synth')
    const duplicate = await restarted.create(duplicateDraft)
    expect(duplicate).toMatchObject({ origin: 'local', packageVersion: '0.1.0', ownedSkillIds: [] })
  })

  it('forwards Marketplace activation to the package transaction', async () => {
    const repository = new SpecialistRepository(storageDir)
    const service = new SpecialistPackageService({
      storageDir,
      repository,
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
    await expect(new ProfileService(repository).getById('research-synth')).resolves.toMatchObject({
      enabled: true,
      setupPending: false
    })
  })

  it('does not erase a profile created while package Skill preparation is paused', async () => {
    const repository = new SpecialistRepository(storageDir)
    const profiles = new ProfileService(repository)
    let preparationStarted!: () => void
    let resumePreparation!: () => void
    const started = new Promise<void>((resolve) => {
      preparationStarted = resolve
    })
    const resume = new Promise<void>((resolve) => {
      resumePreparation = resolve
    })
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog,
      skillPort: {
        snapshot: async () => [],
        prepare: async () => {
          preparationStarted()
          await resume
        },
        commit: async () => undefined,
        rollback: async () => undefined,
        recover: async () => undefined
      }
    })
    const preview = await service.preview(validZip())

    const installing = service.install({ candidateToken: preview.candidateToken })
    await started
    const concurrent = await profiles.create({ name: 'CONCURRENT_PROFILE' })
    resumePreparation()

    await expect(installing).resolves.toEqual({ status: 'failed', code: 'commit-failed' })
    await expect(profiles.getById(concurrent.id)).resolves.toMatchObject({
      name: 'CONCURRENT_PROFILE',
      revision: 1
    })
    await expect(profiles.getById('research-synth')).rejects.toThrow(/not found/i)
  })

  it('does not erase a profile update made while package Skill preparation is paused', async () => {
    const repository = new SpecialistRepository(storageDir)
    const profiles = new ProfileService(repository)
    const existing = await profiles.create({
      name: 'EXISTING_PROFILE',
      description: 'Before concurrent update.'
    })
    let preparationStarted!: () => void
    let resumePreparation!: () => void
    const started = new Promise<void>((resolve) => {
      preparationStarted = resolve
    })
    const resume = new Promise<void>((resolve) => {
      resumePreparation = resolve
    })
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog,
      skillPort: {
        snapshot: async () => [],
        prepare: async () => {
          preparationStarted()
          await resume
        },
        commit: async () => undefined,
        rollback: async () => undefined,
        recover: async () => undefined
      }
    })
    const preview = await service.preview(validZip())

    const installing = service.install({ candidateToken: preview.candidateToken })
    await started
    await profiles.update({
      id: existing.id,
      revision: existing.revision,
      description: 'Concurrent update survives.'
    })
    resumePreparation()

    await expect(installing).resolves.toEqual({ status: 'failed', code: 'commit-failed' })
    await expect(profiles.getById(existing.id)).resolves.toMatchObject({
      description: 'Concurrent update survives.',
      revision: 2
    })
    await expect(profiles.getById('research-synth')).rejects.toThrow(/not found/i)
  })

  it('cleans candidates on cancel and expiry and serializes concurrent replay attempts', async () => {
    const repository = new SpecialistRepository(storageDir)
    let now = new Date('2026-08-03T10:00:00.000Z')
    let tokenNumber = 0
    const onCommitted = vi.fn()
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog,
      token: () => `candidate-${++tokenNumber}`,
      now: () => now,
      onCommitted
    })

    const cancelled = await service.preview(validZip())
    service.cancel(cancelled.candidateToken)
    await expect(service.install({ candidateToken: cancelled.candidateToken })).resolves.toEqual({
      status: 'failed',
      code: 'stale-candidate'
    })

    const expired = await service.preview(validZip())
    now = new Date('2026-08-03T11:00:00.000Z')
    await expect(service.install({ candidateToken: expired.candidateToken })).resolves.toEqual({
      status: 'failed',
      code: 'candidate-expired'
    })

    const live = await service.preview(validZip())
    const results = await Promise.all([
      service.install({ candidateToken: live.candidateToken }),
      service.install({ candidateToken: live.candidateToken })
    ])
    expect(results.map((result) => result.status).sort()).toEqual(['failed', 'installed'])
    expect(results).toContainEqual({ status: 'failed', code: 'stale-candidate' })
    expect(onCommitted).toHaveBeenCalledOnce()
  })

  it('preserves old durable state and blocks later package mutation when recovery cannot complete', async () => {
    const repository = new SpecialistRepository(storageDir)
    const profiles = new ProfileService(repository)
    const existing = await profiles.create({
      name: 'EXISTING_SPECIALIST',
      systemPrompt: 'Keep me.'
    })
    await mkdir(join(storageDir, 'specialist-package-transaction.json'))
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog,
      token: () => randomUUID()
    })

    const first = await service.preview(validZip())
    await expect(service.install({ candidateToken: first.candidateToken })).resolves.toEqual({
      status: 'failed',
      code: 'recovery-failed'
    })
    await expect(profiles.getById(existing.id)).resolves.toMatchObject({ systemPrompt: 'Keep me.' })
    await expect(profiles.getById('research-synth')).rejects.toThrow(/not found/i)

    const second = await service.preview(validZip())
    await expect(service.install({ candidateToken: second.candidateToken })).resolves.toEqual({
      status: 'failed',
      code: 'recovery-failed'
    })
  })

  it('rolls back a failed Specialist document swap without changing the old durable state', async () => {
    const repository = new SpecialistRepository(storageDir)
    const profiles = new ProfileService(repository)
    const existing = await profiles.create({
      name: 'EXISTING_SPECIALIST',
      systemPrompt: 'Keep me.'
    })
    const replace = vi.spyOn(repository, 'replaceAllIfUnchanged')
    replace.mockRejectedValueOnce(new Error('simulated durable write failure'))
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog
    })
    const preview = await service.preview(validZip())

    await expect(service.install({ candidateToken: preview.candidateToken })).resolves.toEqual({
      status: 'failed',
      code: 'commit-failed'
    })
    await expect(profiles.getById(existing.id)).resolves.toMatchObject({ systemPrompt: 'Keep me.' })
    await expect(profiles.getById('research-synth')).rejects.toThrow(/not found/i)
  })

  it('distinguishes rollback failure from the commit that triggered it', async () => {
    const repository = new SpecialistRepository(storageDir)
    const replaceAllIfUnchanged = repository.replaceAllIfUnchanged.bind(repository)
    vi.spyOn(repository, 'replaceAllIfUnchanged')
      .mockImplementationOnce(replaceAllIfUnchanged)
      .mockRejectedValueOnce(new Error('storage unavailable'))
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog,
      skillPort: {
        snapshot: async () => [],
        prepare: async () => undefined,
        commit: async () => {
          throw new Error('Skill commit failed.')
        },
        rollback: async () => undefined,
        recover: async () => undefined
      }
    })
    const preview = await service.preview(validZip())

    await expect(service.install({ candidateToken: preview.candidateToken })).resolves.toEqual({
      status: 'failed',
      code: 'rollback-failed'
    })
  })

  it('rolls back an interrupted Specialist transaction on restart before accepting a new mutation', async () => {
    const repository = new SpecialistRepository(storageDir)
    const profiles = new ProfileService(repository)
    const existing = await profiles.create({ name: 'EXISTING_SPECIALIST' })
    const before = await repository.getAll()
    const partial = {
      ...before.specialists[0],
      id: 'partial-specialist',
      name: 'PARTIAL_SPECIALIST'
    }
    await writeFile(
      join(storageDir, 'specialist-package-transaction.json'),
      JSON.stringify({
        transactionId: 'interrupted-transaction',
        phase: 'committing',
        specialistId: partial.id,
        before,
        after: { ...before, specialists: [...before.specialists, partial] }
      }),
      'utf8'
    )
    await repository.replaceAll({ ...before, specialists: [...before.specialists, partial] })

    const restarted = new SpecialistPackageService({
      storageDir,
      repository: new SpecialistRepository(storageDir),
      catalog: async () => catalog
    })
    const preview = await restarted.preview(validZip())
    await expect(
      restarted.install({ candidateToken: preview.candidateToken })
    ).resolves.toMatchObject({
      status: 'installed'
    })

    const recoveredProfiles = new ProfileService(new SpecialistRepository(storageDir))
    await expect(recoveredProfiles.getById(existing.id)).resolves.toBeDefined()
    await expect(recoveredProfiles.getById('partial-specialist')).rejects.toThrow(/not found/i)
    await expect(recoveredProfiles.getById('research-synth')).resolves.toBeDefined()
  })

  it('previews every exclusively used Skill separately from retained relationships', async () => {
    const repository = new SpecialistRepository(storageDir)
    await repository.insert({
      id: 'research-synth',
      name: 'Research Synthesizer',
      description: '',
      systemPrompt: 'Private instructions.',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: {
        skillIds: [
          'exclusive',
          'builtin-tool',
          'standalone-tool',
          'main-enabled-tool',
          'shared-tool',
          'referenced-tool'
        ],
        connectorIds: [],
        connectorTools: []
      },
      revision: 7,
      packageVersion: '1.0.0',
      origin: 'imported',
      ownedSkillIds: ['exclusive', 'main-enabled-tool', 'shared-tool', 'referenced-tool']
    })
    await repository.insert({
      id: 'other-specialist',
      name: 'Other Specialist',
      description: '',
      systemPrompt: '',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: ['referenced-tool'], connectorIds: [], connectorTools: [] },
      revision: 1,
      packageVersion: '0.1.0',
      origin: 'local',
      ownedSkillIds: ['shared-tool']
    })
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => ({
        ...catalog,
        skills: [
          {
            id: 'exclusive',
            displayName: 'Exclusive Skill',
            source: 'personal',
            builtin: false,
            mainEnabled: false,
            standalone: false,
            ownerIds: ['research-synth']
          },
          { id: 'builtin-tool', builtin: true },
          {
            id: 'standalone-tool',
            displayName: 'Standalone Tool',
            source: 'personal',
            builtin: false,
            mainEnabled: false,
            standalone: true,
            ownerIds: []
          },
          {
            id: 'main-enabled-tool',
            displayName: 'Main Enabled Tool',
            source: 'personal',
            builtin: false,
            mainEnabled: true,
            standalone: false,
            ownerIds: ['research-synth']
          },
          {
            id: 'shared-tool',
            displayName: 'Shared Tool',
            source: 'personal',
            builtin: false,
            mainEnabled: false,
            standalone: false,
            ownerIds: ['research-synth', 'other-specialist']
          },
          {
            id: 'referenced-tool',
            displayName: 'Referenced Tool',
            source: 'imported',
            builtin: false,
            mainEnabled: false,
            standalone: false,
            ownerIds: ['research-synth']
          }
        ]
      })
    })

    await expect(service.previewSpecialistDelete({ id: 'research-synth' })).resolves.toEqual({
      specialistId: 'research-synth',
      specialistName: 'Research Synthesizer',
      expectedRevision: 7,
      skills: [
        {
          id: 'exclusive',
          displayName: 'Exclusive Skill',
          source: 'personal',
          kind: 'exclusive',
          deletable: true,
          reasons: []
        },
        {
          id: 'main-enabled-tool',
          displayName: 'Main Enabled Tool',
          source: 'personal',
          kind: 'main-enabled',
          deletable: false,
          reasons: [{ code: 'main-enabled', specialistIds: [] }]
        },
        {
          id: 'referenced-tool',
          displayName: 'Referenced Tool',
          source: 'imported',
          kind: 'referenced',
          deletable: false,
          reasons: [{ code: 'referenced', specialistIds: ['other-specialist'] }]
        },
        {
          id: 'shared-tool',
          displayName: 'Shared Tool',
          source: 'personal',
          kind: 'shared-owner',
          deletable: false,
          reasons: [{ code: 'shared-owner', specialistIds: ['other-specialist'] }]
        },
        {
          id: 'standalone-tool',
          displayName: 'Standalone Tool',
          source: 'personal',
          kind: 'exclusive',
          deletable: true,
          reasons: []
        }
      ]
    })
  })

  it('atomically deletes selected exclusive Skills and makes retained owned Skills standalone', async () => {
    const repository = new SpecialistRepository(storageDir)
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
    const service = new SpecialistPackageService({
      storageDir,
      repository,
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
    await expect(new ProfileService(repository).getById('research-synth')).rejects.toThrow(
      /not found/i
    )
    await expect(new UserSkillRepository(storageDir).list()).resolves.toEqual([
      expect.objectContaining({ id: 'retained' })
    ])
    await expect(skillPort.snapshot()).resolves.toEqual([
      expect.objectContaining({ id: 'retained', standalone: true, ownerIds: [] })
    ])
  })

  it('waits for an in-flight Marketplace operation before deleting a Specialist', async () => {
    const repository = new SpecialistRepository(storageDir)
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
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog,
      marketplaceOperationCoordinator: coordinator
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
    await expect(
      new ProfileService(repository).getById('managed-specialist')
    ).resolves.toBeDefined()

    releaseOperation?.()
    await inFlight
    await expect(deletion).resolves.toEqual({ status: 'deleted' })
  })

  it('atomically deletes a standalone Skill used only by the deleted Specialist', async () => {
    const repository = new SpecialistRepository(storageDir)
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
    const service = new SpecialistPackageService({
      storageDir,
      repository,
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
    await expect(new ProfileService(repository).getById('research-synth')).rejects.toThrow(
      /not found/i
    )
    await expect(userSkills.list()).resolves.toEqual([])
    await expect(settings.getSettings()).resolves.not.toHaveProperty('disabledSkillIds')
  })

  it('guards direct Skill deletion from live selected and full-access Specialist references', async () => {
    const repository = new SpecialistRepository(storageDir)
    for (const specialist of [
      {
        id: 'selected-specialist',
        name: 'Selected Specialist',
        capabilityMode: 'selected' as const,
        fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
        selectedCapabilities: {
          skillIds: ['referenced-tool'],
          connectorIds: [],
          connectorTools: []
        }
      },
      {
        id: 'full-specialist',
        name: 'Full Specialist',
        capabilityMode: 'full' as const,
        fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
        selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] }
      }
    ]) {
      await repository.insert({
        ...specialist,
        description: '',
        systemPrompt: '',
        enabled: true,
        revision: 1,
        packageVersion: '0.1.0',
        origin: 'local',
        ownedSkillIds: []
      })
    }
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => ({
        ...catalog,
        skills: [{ id: 'referenced-tool', builtin: false, standalone: true, ownerIds: [] }]
      })
    })

    await expect(service.assertSkillDeletionAllowed('referenced-tool')).rejects.toMatchObject({
      code: 'protected-skill',
      skillId: 'referenced-tool',
      specialistIds: ['full-specialist', 'selected-specialist']
    })
  })

  it('rejects a dangerous selected deletion when a concurrent Specialist adds a reference', async () => {
    const repository = new SpecialistRepository(storageDir)
    await repository.insert({
      id: 'owner',
      name: 'Owner',
      description: '',
      systemPrompt: '',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: ['linked-skill'], connectorIds: [], connectorTools: [] },
      revision: 2,
      packageVersion: '1.0.0',
      origin: 'imported',
      ownedSkillIds: ['linked-skill']
    })
    await repository.insert({
      id: 'concurrent',
      name: 'Concurrent',
      description: '',
      systemPrompt: '',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
      revision: 1,
      packageVersion: '0.1.0',
      origin: 'local',
      ownedSkillIds: []
    })
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => ({
        ...catalog,
        skills: [
          {
            id: 'linked-skill',
            builtin: false,
            standalone: false,
            ownerIds: ['owner']
          }
        ]
      })
    })
    const preview = await service.previewSpecialistDelete({ id: 'owner' })
    await new ProfileService(repository).update({
      id: 'concurrent',
      revision: 1,
      selectedCapabilities: {
        skillIds: ['linked-skill'],
        connectorIds: [],
        connectorTools: []
      }
    })

    await expect(
      service.deleteSpecialist({
        id: 'owner',
        expectedRevision: preview.expectedRevision,
        deleteSkillIds: ['linked-skill']
      })
    ).resolves.toEqual({ status: 'failed', code: 'stale-preview' })
    await expect(new ProfileService(repository).getById('owner')).resolves.toBeDefined()
  })

  it('rejects a selected deletion when the Main Agent starts using the Skill', async () => {
    const repository = new SpecialistRepository(storageDir)
    await repository.insert({
      id: 'owner',
      name: 'Owner',
      description: '',
      systemPrompt: '',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: ['linked-skill'], connectorIds: [], connectorTools: [] },
      revision: 1,
      packageVersion: '1.0.0',
      origin: 'imported',
      ownedSkillIds: ['linked-skill']
    })
    let mainEnabled = false
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => ({
        ...catalog,
        skills: [
          {
            id: 'linked-skill',
            builtin: false,
            mainEnabled,
            standalone: false,
            ownerIds: ['owner']
          }
        ]
      })
    })
    const preview = await service.previewSpecialistDelete({ id: 'owner' })
    mainEnabled = true

    await expect(
      service.deleteSpecialist({
        id: 'owner',
        expectedRevision: preview.expectedRevision,
        deleteSkillIds: ['linked-skill']
      })
    ).resolves.toEqual({ status: 'failed', code: 'stale-preview' })
    await expect(new ProfileService(repository).getById('owner')).resolves.toBeDefined()
  })

  it('rechecks Main Agent usage after acquiring the Skill mutation lock', async () => {
    const repository = new SpecialistRepository(storageDir)
    await repository.insert({
      id: 'owner',
      name: 'Owner',
      description: '',
      systemPrompt: '',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: ['linked-skill'], connectorIds: [], connectorTools: [] },
      revision: 1,
      packageVersion: '1.0.0',
      origin: 'imported',
      ownedSkillIds: ['linked-skill']
    })
    let mainEnabled = false
    const prepareDeletion = vi.fn(async () => undefined)
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      skillPort: {
        ...NOOP_SPECIALIST_PACKAGE_SKILL_PORT,
        beginMutation: async () => {
          mainEnabled = true
        },
        prepareDeletion
      },
      catalog: async () => ({
        ...catalog,
        skills: [
          {
            id: 'linked-skill',
            builtin: false,
            mainEnabled,
            standalone: false,
            ownerIds: ['owner']
          }
        ]
      })
    })
    const preview = await service.previewSpecialistDelete({ id: 'owner' })

    await expect(
      service.deleteSpecialist({
        id: 'owner',
        expectedRevision: preview.expectedRevision,
        deleteSkillIds: ['linked-skill']
      })
    ).resolves.toEqual({ status: 'failed', code: 'stale-preview' })
    expect(prepareDeletion).not.toHaveBeenCalled()
    await expect(new ProfileService(repository).getById('owner')).resolves.toBeDefined()
  })

  it('completes deletion when the live catalog shares the Skill mutation owner', async () => {
    const repository = new SpecialistRepository(storageDir)
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
    const service = new SpecialistPackageService({
      storageDir,
      repository,
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
    await expect(new ProfileService(repository).getById('owner')).rejects.toThrow(/not found/i)
    await expect(userSkills.list()).resolves.toEqual([])
  }, 2_000)

  it('keeps system prompts and paths out of the transaction journal', async () => {
    const repository = new SpecialistRepository(storageDir)
    await repository.insert({
      id: 'safe-owner',
      name: 'Safe Owner',
      description: '',
      systemPrompt: 'DO-NOT-LOG-THIS-PROMPT',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
      revision: 1,
      packageVersion: '0.1.0',
      origin: 'local',
      ownedSkillIds: []
    })
    let journal = ''
    const skillPort: SpecialistPackageSkillPort = {
      snapshot: async () => [],
      prepare: async () => undefined,
      prepareDeletion: async () => undefined,
      commit: async () => {
        journal = await import('node:fs/promises').then(({ readFile }) =>
          readFile(join(storageDir, 'specialist-package-transaction.json'), 'utf8')
        )
      },
      rollback: async () => undefined,
      recover: async () => undefined
    }
    const onResourcesDeleted = vi.fn().mockResolvedValue(undefined)
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      skillPort,
      catalog: async () => catalog,
      onResourcesDeleted
    })
    const preview = await service.previewSpecialistDelete({ id: 'safe-owner' })
    await service.deleteSpecialist({
      id: 'safe-owner',
      expectedRevision: preview.expectedRevision,
      deleteSkillIds: []
    })

    expect(journal).not.toContain('DO-NOT-LOG-THIS-PROMPT')
    expect(journal).not.toContain(storageDir)
    expect(journal).not.toContain('systemPrompt')
    expect(onResourcesDeleted).toHaveBeenCalledWith('safe-owner', [])
  })

  it('attempts Tag cleanup when deleted Skill settings cleanup fails', async () => {
    const repository = new SpecialistRepository(storageDir)
    await repository.insert({
      id: 'cleanup-owner',
      name: 'Cleanup Owner',
      description: '',
      systemPrompt: '',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
      revision: 1,
      packageVersion: '0.1.0',
      origin: 'local',
      ownedSkillIds: []
    })
    const onSkillsDeleted = vi.fn().mockRejectedValue(new Error('settings unavailable'))
    const onResourcesDeleted = vi.fn().mockResolvedValue(undefined)
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      catalog: async () => catalog,
      onSkillsDeleted,
      onResourcesDeleted
    })
    const preview = await service.previewSpecialistDelete({ id: 'cleanup-owner' })

    await expect(
      service.deleteSpecialist({
        id: 'cleanup-owner',
        expectedRevision: preview.expectedRevision,
        deleteSkillIds: []
      })
    ).resolves.toEqual({ status: 'deleted' })
    expect(onSkillsDeleted).toHaveBeenCalledWith([])
    expect(onResourcesDeleted).toHaveBeenCalledWith('cleanup-owner', [])
  })

  it('rolls back prepared Skill deletion when the Specialist document swap fails', async () => {
    const repository = new SpecialistRepository(storageDir)
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
    const service = new SpecialistPackageService({
      storageDir,
      repository,
      skillPort,
      catalog: async () => ({
        ...catalog,
        skills: (await skillPort.snapshot()).map((skill) => ({ ...skill, builtin: false }))
      })
    })
    const preview = await service.previewSpecialistDelete({ id: 'rollback-owner' })
    vi.spyOn(repository, 'replaceAllIfUnchanged').mockRejectedValueOnce(
      new Error('durable write failed')
    )

    await expect(
      service.deleteSpecialist({
        id: 'rollback-owner',
        expectedRevision: preview.expectedRevision,
        deleteSkillIds: ['rollback-skill']
      })
    ).resolves.toEqual({ status: 'failed', code: 'commit-failed' })
    await expect(new ProfileService(repository).getById('rollback-owner')).resolves.toBeDefined()
    await expect(skillPort.snapshot()).resolves.toEqual([
      expect.objectContaining({ id: 'rollback-skill', ownerIds: ['rollback-owner'] })
    ])
  })
})
