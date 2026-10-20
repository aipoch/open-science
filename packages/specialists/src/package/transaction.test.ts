import { randomUUID } from 'node:crypto'
import { mkdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpecialistPackageValidationPlan } from '../archive-contracts'
import { emptyFullAccessConfig, emptySelectedConfig } from '../contracts'
import { SpecialistRepository } from '../repository'
import { fakeSkillParticipant as NOOP_SPECIALIST_PACKAGE_SKILL_PORT } from '../../test/fixtures'
import { SpecialistPackageTransaction as Transaction } from './transaction'

const encoder = new TextEncoder()
let storageDir: string
let repository: SpecialistRepository

const plan = (): SpecialistPackageValidationPlan => ({
  specialistId: 'imported-specialist',
  packageVersion: '1.0.0',
  source: 'zip',
  contentHash: 'a'.repeat(64),
  manifest: {
    schema_version: 1,
    id: 'imported-specialist',
    version: '1.0.0',
    exported_with_app_version: '0.9.2'
  },
  payload: {
    name: 'IMPORTED_SPECIALIST',
    displayName: 'Imported Specialist',
    description: 'Imported description.',
    systemPrompt: 'Imported instructions.'
  },
  skillIds: ['bundled-analysis'],
  connectorIds: [],
  skills: [
    {
      id: 'bundled-analysis',
      version: '0.1.0',
      disposition: 'install',
      files: ['SKILL.md'],
      contentHash: 'b'.repeat(64),
      filesToInstall: [{ path: 'SKILL.md', bytes: encoder.encode('Bundled skill') }]
    }
  ]
})

const planWithCapabilities = (): SpecialistPackageValidationPlan => ({
  ...plan(),
  skillIds: ['bundled-analysis', 'existing-analysis'],
  connectorIds: ['reference-library']
})

beforeEach(async () => {
  storageDir = join(tmpdir(), `specialist-transaction-${randomUUID()}`)
  await mkdir(storageDir, { recursive: true })
  repository = new SpecialistRepository(storageDir)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(storageDir, { recursive: true, force: true })
})

describe('SpecialistPackageTransaction imported setup lifecycle', () => {
  it('releases the Skill mutation lock before committed relationship cleanup', async () => {
    await repository.insert({
      id: 'imported-specialist',
      name: 'IMPORTED_SPECIALIST',
      displayName: 'Imported Specialist',
      description: 'Imported description.',
      systemPrompt: 'Imported instructions.',
      enabled: false,
      setupPending: false,
      capabilityMode: 'selected',
      fullAccess: emptyFullAccessConfig(),
      selectedCapabilities: emptySelectedConfig(),
      revision: 1,
      packageVersion: '1.0.0',
      origin: 'imported',
      ownedSkillIds: []
    })
    let skillMutationLocked = false
    const calls: string[] = []
    const transaction = new SpecialistPackageTransaction(
      storageDir,
      repository,
      randomUUID,
      {
        ...NOOP_SPECIALIST_PACKAGE_SKILL_PORT,
        beginMutation: async () => {
          calls.push('lock')
          skillMutationLocked = true
        },
        endMutation: async () => {
          calls.push('unlock')
          skillMutationLocked = false
        }
      },
      async () => {
        calls.push('cleanup')
        expect(skillMutationLocked).toBe(false)
      }
    )

    await expect(
      transaction.deleteSpecialist('imported-specialist', 1, [])
    ).resolves.toBeUndefined()
    expect(calls).toEqual(['lock', 'unlock', 'cleanup'])
  })

  it('serializes an external recovery barrier behind an active package transaction', async () => {
    let signalPrepareStarted!: () => void
    let releasePrepare!: () => void
    const prepareStarted = new Promise<void>((resolve) => {
      signalPrepareStarted = resolve
    })
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve
    })
    const calls: string[] = []
    const transaction = new SpecialistPackageTransaction(storageDir, repository, randomUUID, {
      ...NOOP_SPECIALIST_PACKAGE_SKILL_PORT,
      prepare: async () => {
        calls.push('prepare')
        signalPrepareStarted()
        await prepareGate
      },
      commit: async () => {
        calls.push('commit')
      }
    })
    const installing = transaction.install(
      plan(),
      new Date('2026-08-04T00:00:00.000Z'),
      'archive-digest'
    )
    await prepareStarted

    const barrier = transaction.withRecoveryBarrier(async () => {
      calls.push('barrier')
    })
    await Promise.resolve()
    expect(calls).toEqual(['prepare'])

    releasePrepare()
    await installing
    await barrier

    expect(calls).toEqual(['prepare', 'commit', 'barrier'])
  })

  it('persists a new import disabled and pending with inferred bundled Skills selected', async () => {
    const installed = await new SpecialistPackageTransaction(storageDir, repository).install(
      plan(),
      new Date('2026-08-04T00:00:00.000Z'),
      'archive-digest'
    )

    expect(installed).toMatchObject({
      enabled: false,
      setupPending: true,
      capabilityMode: 'selected',
      fullAccess: emptyFullAccessConfig(),
      selectedCapabilities: {
        skillIds: ['bundled-analysis'],
        connectorIds: [],
        connectorTools: []
      }
    })
    expect(installed.iconKey).toBeUndefined()
    expect(installed.colorKey).toBeUndefined()
    await expect(repository.getAll()).resolves.toMatchObject({
      specialists: [{ id: 'imported-specialist', enabled: false, setupPending: true }]
    })
  })

  it('persists declared capabilities together with Skills discovered from the package', async () => {
    const installed = await new SpecialistPackageTransaction(storageDir, repository).install(
      planWithCapabilities(),
      new Date('2026-08-04T00:00:00.000Z'),
      'archive-digest'
    )

    expect(installed).toMatchObject({
      capabilityMode: 'selected',
      selectedCapabilities: {
        skillIds: ['bundled-analysis', 'existing-analysis'],
        connectorIds: ['reference-library'],
        connectorTools: []
      }
    })
  })

  it('activates a new Marketplace import without requiring a separate setup save', async () => {
    const installed = await new SpecialistPackageTransaction(storageDir, repository).install(
      plan(),
      new Date('2026-08-04T00:00:00.000Z'),
      'archive-digest',
      undefined,
      undefined,
      { activateAfterInstall: true }
    )

    expect(installed).toMatchObject({
      enabled: true,
      setupPending: false,
      selectedCapabilities: {
        skillIds: ['bundled-analysis'],
        connectorIds: [],
        connectorTools: []
      }
    })
  })

  it('checks the approved impact against the authoritative pre-commit document', async () => {
    const transaction = new SpecialistPackageTransaction(storageDir, repository)
    const approvedImpactChanged = new Error('approved impact changed')

    await expect(
      transaction.install(
        plan(),
        new Date('2026-08-04T00:00:00.000Z'),
        'archive-digest',
        undefined,
        async (document) => {
          expect(document.specialists).toEqual([])
          throw approvedImpactChanged
        }
      )
    ).rejects.toBe(approvedImpactChanged)
    await expect(repository.getAll()).resolves.toMatchObject({ specialists: [] })
  })

  it('returns an overwritten Specialist to disabled pending setup and replaces local capabilities', async () => {
    await repository.insert({
      id: 'imported-specialist',
      name: 'IMPORTED_SPECIALIST',
      displayName: 'Previously configured',
      description: 'Old description.',
      systemPrompt: 'Old instructions.',
      iconKey: 'dna',
      colorKey: 'blue',
      enabled: true,
      setupPending: false,
      capabilityMode: 'full',
      fullAccess: { ...emptyFullAccessConfig(), excludedSkillIds: ['old-skill'] },
      selectedCapabilities: {
        ...emptySelectedConfig(),
        connectorIds: ['old-connector']
      },
      revision: 4,
      packageVersion: '0.9.0',
      origin: 'imported',
      ownedSkillIds: ['previously-owned']
    })

    const overwritten = await new SpecialistPackageTransaction(storageDir, repository).install(
      plan(),
      new Date('2026-08-04T00:00:00.000Z'),
      'archive-digest',
      { expectedRevision: 4 }
    )

    expect(overwritten).toMatchObject({
      enabled: false,
      setupPending: true,
      revision: 5,
      capabilityMode: 'selected',
      fullAccess: emptyFullAccessConfig(),
      selectedCapabilities: {
        skillIds: ['bundled-analysis'],
        connectorIds: [],
        connectorTools: []
      },
      ownedSkillIds: ['previously-owned', 'bundled-analysis']
    })
    expect(overwritten.iconKey).toBeUndefined()
    expect(overwritten.colorKey).toBeUndefined()
  })

  it('keeps an existing Marketplace Specialist disabled while completing an update', async () => {
    await repository.insert({
      id: 'imported-specialist',
      name: 'IMPORTED_SPECIALIST',
      displayName: 'Imported Specialist',
      description: 'Old description.',
      systemPrompt: 'Old instructions.',
      enabled: false,
      setupPending: false,
      capabilityMode: 'selected',
      fullAccess: emptyFullAccessConfig(),
      selectedCapabilities: emptySelectedConfig(),
      revision: 4,
      packageVersion: '0.9.0',
      origin: 'imported',
      ownedSkillIds: []
    })

    const updated = await new SpecialistPackageTransaction(storageDir, repository).install(
      plan(),
      new Date('2026-08-04T00:00:00.000Z'),
      'archive-digest',
      { expectedRevision: 4 },
      undefined,
      { activateAfterInstall: true }
    )

    expect(updated).toMatchObject({
      enabled: false,
      setupPending: false,
      revision: 5
    })
  })
})

class SpecialistPackageTransaction extends Transaction {
  constructor(...args: ConstructorParameters<typeof Transaction>) {
    super(
      args[0],
      args[1],
      args[2],
      args[3] ?? NOOP_SPECIALIST_PACKAGE_SKILL_PORT,
      args[4],
      args[5],
      args[6]
    )
  }
}

describe('participant enablement ordering', () => {
  it('disables new local Skill IDs before publication while preserving every existing setting', async () => {
    const disabled = new Set<string>()
    const settings = {
      disabledSkillIds: async () => [...disabled],
      setSkillsEnabled: async (ids: readonly string[], enabled: boolean) => {
        for (const id of ids) enabled ? disabled.delete(id) : disabled.add(id)
      }
    }
    const disabledIds = async (): Promise<string[]> => [...disabled].sort()
    await settings.setSkillsEnabled(['already-disabled', 'existing-off'], false)
    const incoming = plan()
    incoming.skills = [
      { ...incoming.skills[0], localId: 'personal-bundled-analysis' },
      { ...incoming.skills[0], id: 'already-disabled' },
      ...(
        ['reuse-owned', 'reuse-standalone', 'reuse-existing', 'replace-existing'] as const
      ).flatMap((disposition) =>
        ['existing-on', 'existing-off'].map((id) => ({ ...incoming.skills[0], id, disposition }))
      )
    ]
    const transaction = new Transaction(
      storageDir,
      repository,
      randomUUID,
      {
        ...NOOP_SPECIALIST_PACKAGE_SKILL_PORT,
        commit: async () => {
          expect(await disabledIds()).toEqual([
            'already-disabled',
            'existing-off',
            'personal-bundled-analysis'
          ])
          const journal = JSON.parse(
            await readFile(join(storageDir, 'specialist-package-transaction.json'), 'utf8')
          )
          expect(journal.newlyDisabledSkillIds).toEqual(['personal-bundled-analysis'])
        }
      },
      undefined,
      settings,
      true
    )
    await transaction.install(incoming, new Date(), 'digest')
    expect(await disabledIds()).toEqual([
      'already-disabled',
      'existing-off',
      'personal-bundled-analysis'
    ])
  })
})
