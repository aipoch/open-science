import { SpecialistStorageFixture } from '../../../../test/specialist-fixtures'
import { SettingsRepository } from '../../settings/repository'
import { createHostSpecialistPackages } from './environment'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SpecialistPackageCatalogSnapshot } from '@aipoch/specialists'
import { UserSkillSpecialistPackageAdapter } from '@aipoch/skills'
import {
  buildContributionTemplateZip,
  buildDeterministicSpecialistZip
} from '@aipoch/specialists/node'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

let storageRoot: string

beforeEach(async () => {
  storageRoot = join(tmpdir(), `specialist-release-certification-${randomUUID()}`)
  await mkdir(storageRoot, { recursive: true })
})

afterEach(async () => {
  await rm(storageRoot, { recursive: true, force: true })
})

const packageFromTemplate = (input: { id: string; bundledSkill?: string }): Uint8Array => {
  const template = unzipSync(
    buildContributionTemplateZip({
      appVersion: '0.9.2',
      readme: 'Approved bilingual guidance.',
      packageId: input.id
    })
  )
  const manifest = JSON.parse(strFromU8(template['manifest.json'])) as { id: string }
  const specialist = JSON.parse(strFromU8(template['specialist.json'])) as {
    name: string
    description: string
    system_prompt: string
  }
  specialist.name = input.id.toUpperCase().replaceAll('-', '_')
  specialist.description = `Portable ${input.id}`
  specialist.system_prompt = `Identity for ${input.id}`
  const files: Record<string, Uint8Array> = {
    ...template,
    'manifest.json': strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
    'specialist.json': strToU8(`${JSON.stringify(specialist, null, 2)}\n`)
  }
  if (input.bundledSkill) {
    files[`skills/${input.bundledSkill}/SKILL.md`] = encoder.encode(
      `---\nname: ${input.bundledSkill}\ndescription: Certified bundled Skill\nversion: 1.0.0\n---\nUse it.`
    )
  }
  return buildDeterministicSpecialistZip(files)
}

describe('Specialist contribution release certification', () => {
  it('installs template-bundled Skills through the real ownership adapter', async () => {
    const repository = new SpecialistStorageFixture(storageRoot)
    const skillPort = new UserSkillSpecialistPackageAdapter(storageRoot)
    const catalog = async (): Promise<SpecialistPackageCatalogSnapshot> => ({
      appVersion: '0.9.2',
      builtinSkills: [],
      skills: (await skillPort.snapshot()).map((skill) => ({
        ...skill,
        name: skill.id.startsWith('personal-') ? skill.id.slice('personal-'.length) : skill.id,
        builtin: false
      })),
      connectorIds: [],
      protectedSpecialistIds: ['reviewer']
    })
    const packages = createHostSpecialistPackages({
      storageDir: storageRoot,
      domain: repository.domain,
      skillPort,
      catalog
    })

    for (const archive of [
      packageFromTemplate({ id: 'template-with-skills', bundledSkill: 'certified-analysis' })
    ]) {
      const preview = await packages.preview(archive)
      expect(preview.installable, preview.diagnostics.map((item) => item.code).join(', ')).toBe(
        true
      )
      await expect(
        packages.install({ candidateToken: preview.candidateToken })
      ).resolves.toMatchObject({
        status: 'installed'
      })
    }

    await expect(repository.domain.catalog.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'template-with-skills',
          ownedSkillIds: ['personal-certified-analysis']
        })
      ])
    )
    const installedSkills = await skillPort.exportSnapshot?.(['personal-certified-analysis'])
    expect(installedSkills).toHaveLength(1)
    expect(decoder.decode(installedSkills?.[0].files[0].bytes)).toContain('Certified bundled Skill')
  })

  it('round-trips real Skill bytes and ownership into a clean host store', async () => {
    const repository = new SpecialistStorageFixture(storageRoot)
    const skillPort = new UserSkillSpecialistPackageAdapter(storageRoot)
    const catalog = async (): Promise<SpecialistPackageCatalogSnapshot> => ({
      appVersion: '0.9.2',
      builtinSkills: [],
      skills: [
        ...(await skillPort.snapshot()).map((skill) => ({
          ...skill,
          name: skill.id.startsWith('personal-') ? skill.id.slice('personal-'.length) : skill.id,
          builtin: false
        }))
      ],
      connectorIds: [],
      protectedSpecialistIds: ['reviewer']
    })
    const packages = createHostSpecialistPackages({
      storageDir: storageRoot,
      domain: repository.domain,
      skillPort,
      catalog
    })
    const archive = packageFromTemplate({
      id: 'overwrite-roundtrip',
      bundledSkill: 'portable-analysis'
    })
    const firstPreview = await packages.preview(archive)
    await expect(
      packages.install({ candidateToken: firstPreview.candidateToken })
    ).resolves.toMatchObject({
      status: 'installed'
    })

    const replaced = await repository.domain.catalog.getById('overwrite-roundtrip')
    const exportPreview = await packages.previewExport(replaced.id)
    const exported = await packages.export({
      specialistId: replaced.id,
      expectedRevision: exportPreview.expectedRevision,
      includedSkillIds: ['personal-portable-analysis']
    })
    const targetRoot = join(storageRoot, 'clean-target')
    await mkdir(targetRoot)
    const targetRepository = new SpecialistStorageFixture(targetRoot)
    const targetSkillPort = new UserSkillSpecialistPackageAdapter(targetRoot)
    const targetCatalog = async (): Promise<SpecialistPackageCatalogSnapshot> => ({
      appVersion: '0.9.2',
      builtinSkills: [],
      skills: [
        ...(await targetSkillPort.snapshot()).map((skill) => ({
          ...skill,
          name: skill.id.startsWith('personal-') ? skill.id.slice('personal-'.length) : skill.id,
          builtin: false
        }))
      ],
      connectorIds: [],
      protectedSpecialistIds: ['reviewer']
    })
    const targetPackages = createHostSpecialistPackages({
      storageDir: targetRoot,
      domain: targetRepository.domain,
      skillPort: targetSkillPort,
      catalog: targetCatalog
    })
    const targetPreview = await targetPackages.preview(exported.archiveBytes)
    expect(
      targetPreview.installable,
      targetPreview.diagnostics.map((item) => item.code).join(', ')
    ).toBe(true)
    await expect(
      targetPackages.install({ candidateToken: targetPreview.candidateToken })
    ).resolves.toMatchObject({ status: 'installed' })

    const restored = await targetRepository.domain.catalog.getById(replaced.id)
    expect(restored).toMatchObject({
      id: replaced.id,
      packageVersion: replaced.packageVersion,
      name: replaced.name,
      description: replaced.description,
      systemPrompt: replaced.systemPrompt,
      selectedCapabilities: replaced.selectedCapabilities,
      ownedSkillIds: replaced.ownedSkillIds
    })
    const targetFiles = (await targetSkillPort.exportSnapshot(['personal-portable-analysis']))[0]
      .files
    const archivedFiles = unzipSync(exported.archiveBytes)
    expect(targetFiles).toEqual([
      { path: 'SKILL.md', bytes: archivedFiles['skills/portable-analysis/SKILL.md'] }
    ])
    expect(decoder.decode(targetFiles[0].bytes)).toContain('Use it.')
    const restoredSkills = await targetSkillPort.snapshot()
    expect(restoredSkills).toEqual([
      expect.objectContaining({
        id: 'personal-portable-analysis',
        version: '1.0.0',
        standalone: false,
        ownerIds: ['overwrite-roundtrip']
      })
    ])
  })

  it.each([
    {
      checkpoint: 'committing after Specialist swap',
      phase: 'committing',
      specialistLive: true,
      skillLive: false
    },
    {
      checkpoint: 'committing after Skill swap',
      phase: 'committing',
      specialistLive: true,
      skillLive: true
    },
    { checkpoint: 'committed', phase: 'committed', specialistLive: true, skillLive: true }
  ] as const)(
    'recovers a complete old or new package after restart at $checkpoint',
    async ({ checkpoint, phase, specialistLive, skillLive }) => {
      const root = join(storageRoot, checkpoint.replaceAll(' ', '-'))
      await mkdir(root)
      const repository = new SpecialistStorageFixture(root)
      const skillPort = new UserSkillSpecialistPackageAdapter(root)
      const before = await repository.getAll()
      const after = {
        ...before,
        specialists: [
          {
            id: 'interrupted-specialist',
            name: 'INTERRUPTED_SPECIALIST',
            displayName: 'Interrupted Specialist',
            description: 'A complete new state.',
            systemPrompt: 'Certified identity.',
            enabled: false,
            setupPending: true,
            capabilityMode: 'selected' as const,
            fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
            selectedCapabilities: {
              skillIds: ['interrupted-skill'],
              connectorIds: [],
              connectorTools: []
            },
            revision: 1,
            packageVersion: '1.0.0',
            origin: 'imported' as const,
            ownedSkillIds: ['interrupted-skill']
          }
        ]
      }
      const transactionId = `restart-${checkpoint.toLowerCase().replaceAll(' ', '-').slice(0, 40)}`
      await skillPort.prepare(transactionId, 'interrupted-specialist', [
        {
          id: 'interrupted-skill',
          version: '1.0.0',
          disposition: 'install',
          contentHash: 'a'.repeat(64),
          filesToInstall: [
            {
              path: 'SKILL.md',
              bytes: encoder.encode(
                '---\nname: interrupted-skill\ndescription: Restart fixture\n---\nComplete.'
              )
            }
          ]
        }
      ])
      if (specialistLive) await repository.replaceAll(after)
      if (skillLive) await skillPort.commit(transactionId)
      await writeFile(
        join(root, 'specialist-package-transaction.json'),
        `${JSON.stringify({
          transactionId,
          phase,
          specialistId: 'interrupted-specialist',
          before,
          after
        })}\n`,
        'utf8'
      )

      await createHostSpecialistPackages({
        storageDir: root,
        domain: repository.domain,
        skillPort,
        skillSettings: new SettingsRepository(root),
        catalog: async () => ({
          appVersion: '1.0.0',
          builtinSkills: [],
          skills: [],
          connectorIds: [],
          protectedSpecialistIds: []
        })
      }).recover()

      const recovered = await repository.getAll()
      const recoveredSkills = await skillPort.snapshot()
      if (phase === 'committed') {
        expect(recovered.specialists).toEqual(after.specialists)
        expect(recoveredSkills).toEqual([
          expect.objectContaining({
            id: 'interrupted-skill',
            ownerIds: ['interrupted-specialist']
          })
        ])
      } else {
        expect(recovered).toEqual(before)
        expect(recoveredSkills).toEqual([])
      }
    }
  )
})
