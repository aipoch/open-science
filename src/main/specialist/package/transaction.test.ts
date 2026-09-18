import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SpecialistPackageValidationPlan } from '../../../shared/specialist-package'
import { emptyFullAccessConfig, emptySelectedConfig } from '../../../shared/specialist'
import { SpecialistRepository } from '../repository'
import { SettingsRepository } from '../../settings/repository'
import { UserSkillSpecialistPackageAdapter } from '../../skills/specialist-package-adapter'
import { NOOP_SPECIALIST_PACKAGE_SKILL_PORT } from './skill-port'
import { SpecialistPackageTransaction } from './transaction'

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

describe('Specialist package Main Skill defaults', () => {
  const fixture = (): {
    port: UserSkillSpecialistPackageAdapter
    settings: SettingsRepository
    transaction: SpecialistPackageTransaction
  } => {
    const port = new UserSkillSpecialistPackageAdapter(storageDir)
    const settings = new SettingsRepository(storageDir, (operation) =>
      port.runMutationExclusive(operation)
    )
    const transaction = new SpecialistPackageTransaction(
      storageDir,
      repository,
      randomUUID,
      port,
      undefined,
      settings
    )
    return { port, settings, transaction }
  }
  const install = (
    transaction: SpecialistPackageTransaction
  ): ReturnType<SpecialistPackageTransaction['install']> =>
    transaction.install(plan(), new Date('2026-09-18T00:00:00Z'), 'archive-digest')
  const disabledIds = async (): Promise<string[]> =>
    (await new SettingsRepository(storageDir).getSettings()).disabledSkillIds ?? []

  it('disables new local Skill IDs before publication while preserving every existing setting', async () => {
    const settings = new SettingsRepository(storageDir)
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
    const transaction = new SpecialistPackageTransaction(
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
      settings
    )
    await transaction.install(incoming, new Date(), 'digest')
    expect(await disabledIds()).toEqual([
      'already-disabled',
      'existing-off',
      'personal-bundled-analysis'
    ])
  })

  it('does not publish files when settings persistence fails, even after an uncertain write', async () => {
    const { port, settings, transaction } = fixture()
    const set = settings.setSkillsEnabled.bind(settings)
    vi.spyOn(settings, 'setSkillsEnabled').mockImplementationOnce(async (ids, enabled) => {
      await set(ids, enabled)
      throw new Error('Settings write acknowledgement lost')
    })
    const publish = vi.spyOn(port, 'commit')
    await expect(install(transaction)).rejects.toThrow('Settings write acknowledgement lost')
    expect(publish).not.toHaveBeenCalled()
    expect(await disabledIds()).toEqual([])
    expect((await repository.getAll()).specialists).toEqual([])
  })

  it('rolls back promoted files and only the settings introduced by a failed install', async () => {
    const { port, settings, transaction } = fixture()
    await settings.setSkillsEnabled(['unrelated'], false)
    const commit = port.commit.bind(port)
    vi.spyOn(port, 'commit').mockImplementation(async (id) => {
      await commit(id)
      throw new Error('Interrupted publication')
    })
    await expect(install(transaction)).rejects.toThrow('Interrupted publication')
    expect(await disabledIds()).toEqual(['unrelated'])
    expect(await port.snapshot()).toEqual([])
    expect((await repository.getAll()).specialists).toEqual([])
  })

  it.each(['committing', 'rolling-back'])(
    'recovers %s settings and files after restarting the owner',
    async (phase) => {
      const { port, settings, transaction } = fixture()
      await settings.setSkillsEnabled(['unrelated'], false)
      const commit = port.commit.bind(port)
      vi.spyOn(port, 'commit').mockImplementation(async (id) => {
        await commit(id)
        throw new Error('crash')
      })
      vi.spyOn(port, 'rollback').mockRejectedValue(new Error('process stopped'))
      await expect(install(transaction)).rejects.toThrow()
      const path = join(storageDir, 'specialist-package-transaction.json')
      const journal = JSON.parse(await readFile(path, 'utf8'))
      await writeFile(path, JSON.stringify({ ...journal, phase }))
      expect(await disabledIds()).toEqual(['unrelated', 'bundled-analysis'])
      const restarted = fixture()
      await restarted.transaction.recover()
      await restarted.transaction.recover()
      expect(await disabledIds()).toEqual(['unrelated'])
      expect(await restarted.port.snapshot()).toEqual([])
      expect((await repository.getAll()).specialists).toEqual([])
    }
  )

  it('does not reinterpret settings when recovering a historical journal without the new list', async () => {
    const { port, settings, transaction } = fixture()
    await settings.setSkillsEnabled(['bundled-analysis'], false)
    vi.spyOn(port, 'commit').mockRejectedValue(new Error('crash'))
    vi.spyOn(port, 'rollback').mockRejectedValue(new Error('process stopped'))
    await expect(install(transaction)).rejects.toThrow()
    const path = join(storageDir, 'specialist-package-transaction.json')
    const journal = JSON.parse(await readFile(path, 'utf8'))
    delete journal.newlyDisabledSkillIds
    await writeFile(path, JSON.stringify(journal))
    await fixture().transaction.recover()
    expect(await disabledIds()).toEqual(['bundled-analysis'])
  })

  it('preserves subsequent user choices when retrying committed cleanup', async () => {
    const { port, settings, transaction } = fixture()
    const recover = port.recover.bind(port)
    vi.spyOn(port, 'recover').mockImplementation(async (id, outcome) => {
      if (id && outcome === 'commit') throw new Error('cleanup interrupted')
      return recover(id, outcome)
    })
    await expect(install(transaction)).rejects.toThrow('recovery failed')
    expect(await disabledIds()).toEqual(['bundled-analysis'])
    await settings.setSkillsEnabled(['bundled-analysis'], true)
    await fixture().transaction.recover()
    expect(await disabledIds()).toEqual([])
    expect((await repository.getAll()).specialists).toHaveLength(1)
  })

  it('serializes a user toggle behind publication without deadlocking the settings guard', async () => {
    const { port, settings, transaction } = fixture()
    let entered!: () => void
    let resume!: () => void
    const publishing = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    const commit = port.commit.bind(port)
    vi.spyOn(port, 'commit').mockImplementation(async (id) => {
      entered()
      await gate
      return commit(id)
    })
    const installing = install(transaction)
    await publishing
    expect(await disabledIds()).toEqual(['bundled-analysis'])
    let toggled = false
    const toggling = settings.setSkillsEnabled(['bundled-analysis'], true).then(() => {
      toggled = true
    })
    await Promise.resolve()
    expect(toggled).toBe(false)
    resume()
    await Promise.all([installing, toggling])
    expect(await disabledIds()).toEqual([])
  })
})
