import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { strFromU8, strToU8, unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SpecialistPackageCatalogSnapshot } from '../../../shared/specialist-package'
import { UserSkillSpecialistPackageAdapter } from '../../skills/specialist-package-adapter'
import { SpecialistRepository } from '../repository'
import { SpecialistService } from '../service'
import {
  buildContributionTemplateZip,
  buildDeterministicSpecialistZip
} from './contribution-template'
import { SpecialistPackageService } from './service'
import { SpecialistPackageTransaction } from './transaction'

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

const packageFromTemplate = (input: {
  id: string
  bundledSkill?: string
  builtinSkill?: string
}): Uint8Array => {
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
  it('turns the contribution template into installable no-Skill and bundled-Skill journeys', async () => {
    const repository = new SpecialistRepository(storageRoot)
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
    const packages = new SpecialistPackageService({
      storageDir: storageRoot,
      repository,
      skillPort,
      catalog
    })

    for (const archive of [
      packageFromTemplate({ id: 'template-no-skills' }),
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

    await expect(new SpecialistService(repository).list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'template-no-skills', ownedSkillIds: [] }),
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

  it('exports before a confirmed overwrite and round-trips the new baseline into clean storage', async () => {
    const repository = new SpecialistRepository(storageRoot)
    const skillPort = new UserSkillSpecialistPackageAdapter(storageRoot)
    const builtinSkill = {
      id: 'builtin-reader',
      appVersion: '0.9.2',
      compatibility: 'app:0.9.2:builtin-reader'
    }
    const catalog = async (): Promise<SpecialistPackageCatalogSnapshot> => ({
      appVersion: '0.9.2',
      builtinSkills: [builtinSkill],
      skills: [
        { id: builtinSkill.id, builtin: true },
        ...(await skillPort.snapshot()).map((skill) => ({
          ...skill,
          name: skill.id.startsWith('personal-') ? skill.id.slice('personal-'.length) : skill.id,
          builtin: false
        }))
      ],
      connectorIds: [],
      protectedSpecialistIds: ['reviewer']
    })
    const packages = new SpecialistPackageService({
      storageDir: storageRoot,
      repository,
      skillPort,
      catalog
    })
    const archive = packageFromTemplate({
      id: 'overwrite-roundtrip',
      bundledSkill: 'portable-analysis',
      builtinSkill: builtinSkill.id
    })
    const firstPreview = await packages.preview(archive)
    await expect(
      packages.install({ candidateToken: firstPreview.candidateToken })
    ).resolves.toMatchObject({
      status: 'installed'
    })

    const profiles = new SpecialistService(repository)
    const imported = await profiles.getById('overwrite-roundtrip')
    await profiles.update({
      id: imported.id,
      revision: imported.revision,
      description: 'Locally edited before overwrite.'
    })
    const edited = await profiles.getById(imported.id)
    expect(edited.modifiedSinceImport).toBe(true)
    const beforeOverwrite = await packages.previewExport(imported.id)
    const backup = await packages.export({
      specialistId: imported.id,
      expectedRevision: beforeOverwrite.expectedRevision,
      includedSkillIds: ['personal-portable-analysis']
    })
    expect(decoder.decode(unzipSync(backup.archiveBytes)['specialist.json'])).toContain(
      'Locally edited before overwrite.'
    )

    const overwrite = await packages.preview(archive)
    expect(overwrite.overwrite).toMatchObject({
      currentVersion: '0.1.0',
      incomingVersion: '0.1.0',
      modifiedSinceImport: true
    })
    expect(overwrite.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        'specialist.overwrite-same-version',
        'specialist.overwrite-local-modifications'
      ])
    )
    await expect(packages.install({ candidateToken: overwrite.candidateToken })).resolves.toEqual({
      status: 'failed',
      code: 'overwrite-confirmation-required'
    })
    await expect(
      packages.install({ candidateToken: overwrite.candidateToken, confirmOverwrite: true })
    ).resolves.toMatchObject({ status: 'installed' })
    const replaced = await profiles.getById(imported.id)
    expect(replaced).toMatchObject({
      description: 'Portable overwrite-roundtrip',
      modifiedSinceImport: false,
      ownedSkillIds: ['personal-portable-analysis']
    })

    const exportPreview = await packages.previewExport(replaced.id)
    const exported = await packages.export({
      specialistId: replaced.id,
      expectedRevision: exportPreview.expectedRevision,
      includedSkillIds: ['personal-portable-analysis']
    })
    const targetRoot = join(storageRoot, 'clean-target')
    await mkdir(targetRoot)
    const targetRepository = new SpecialistRepository(targetRoot)
    const targetSkillPort = new UserSkillSpecialistPackageAdapter(targetRoot)
    const targetCatalog = async (): Promise<SpecialistPackageCatalogSnapshot> => ({
      appVersion: '0.9.2',
      builtinSkills: [builtinSkill],
      skills: [
        { id: builtinSkill.id, builtin: true },
        ...(await targetSkillPort.snapshot()).map((skill) => ({
          ...skill,
          name: skill.id.startsWith('personal-') ? skill.id.slice('personal-'.length) : skill.id,
          builtin: false
        }))
      ],
      connectorIds: [],
      protectedSpecialistIds: ['reviewer']
    })
    const targetPackages = new SpecialistPackageService({
      storageDir: targetRoot,
      repository: targetRepository,
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

    const restored = await new SpecialistService(targetRepository).getById(replaced.id)
    expect(restored).toMatchObject({
      id: replaced.id,
      packageVersion: replaced.packageVersion,
      name: replaced.name,
      description: replaced.description,
      systemPrompt: replaced.systemPrompt,
      selectedCapabilities: replaced.selectedCapabilities,
      ownedSkillIds: replaced.ownedSkillIds,
      modifiedSinceImport: false
    })
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
    { checkpoint: 'prepared', phase: 'prepared', specialistLive: false, skillLive: false },
    {
      checkpoint: 'committing before Specialist swap',
      phase: 'committing',
      specialistLive: false,
      skillLive: false
    },
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
    { checkpoint: 'committed', phase: 'committed', specialistLive: true, skillLive: true },
    {
      checkpoint: 'rolling back',
      phase: 'rolling-back',
      specialistLive: false,
      skillLive: false
    },
    { checkpoint: 'rolled back', phase: 'rolled-back', specialistLive: false, skillLive: false }
  ] as const)(
    'recovers a complete old or new package after restart at $checkpoint',
    async ({ checkpoint, phase, specialistLive, skillLive }) => {
      const root = join(storageRoot, checkpoint.replaceAll(' ', '-'))
      await mkdir(root)
      const repository = new SpecialistRepository(root)
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
          files: ['SKILL.md'],
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
      if (phase === 'rolling-back' || phase === 'rolled-back') {
        await skillPort.rollback(transactionId)
        await repository.replaceAll(before)
      }
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

      await new SpecialistPackageTransaction(
        root,
        repository,
        () => randomUUID(),
        skillPort
      ).recover()

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
