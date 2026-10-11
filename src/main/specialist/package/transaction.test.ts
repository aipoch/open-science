import { SpecialistStorageFixture } from '../../../../test/specialist-fixtures'
import { createHostSpecialistPackages } from './environment'
import { zipSync } from 'fflate'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsRepository } from '../../settings/repository'
import { UserSkillSpecialistPackageAdapter } from '@aipoch/skills'
import type { SpecialistPackageService } from '@aipoch/specialists/node'

const encoder = new TextEncoder()
let storageDir: string
let repository: SpecialistStorageFixture

const archive = (): Uint8Array =>
  zipSync({
    'manifest.json': encoder.encode(
      JSON.stringify({
        schema_version: 1,
        id: 'imported-specialist',
        version: '1.0.0',
        exported_with_app_version: '1.0.0'
      })
    ),
    'specialist.json': encoder.encode(
      JSON.stringify({
        name: 'IMPORTED_SPECIALIST',
        description: 'Imported description.',
        system_prompt: 'Imported instructions.',
        skill_ids: [],
        connector_ids: []
      })
    ),
    'skills/bundled-analysis/SKILL.md': encoder.encode(
      '---\nname: bundled-analysis\ndescription: Analysis\nversion: 0.1.0\n---\nBundled skill'
    )
  })

beforeEach(async () => {
  storageDir = join(tmpdir(), `specialist-transaction-${randomUUID()}`)
  await mkdir(storageDir, { recursive: true })
  repository = new SpecialistStorageFixture(storageDir)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(storageDir, { recursive: true, force: true })
})

describe('Specialist package Main Skill defaults', () => {
  const fixture = (): {
    port: UserSkillSpecialistPackageAdapter
    settings: SettingsRepository
    transaction: SpecialistPackageService
  } => {
    const port = new UserSkillSpecialistPackageAdapter(storageDir)
    const settings = new SettingsRepository(storageDir, (operation) =>
      port.runMutationExclusive(operation)
    )
    const transaction = createHostSpecialistPackages({
      storageDir,
      domain: repository.restart(),
      skillPort: port,
      skillSettings: settings,
      catalog: async () => ({
        appVersion: '1.0.0',
        builtinSkills: [],
        skills: [],
        connectorIds: [],
        protectedSpecialistIds: []
      })
    })
    return { port, settings, transaction }
  }
  const install = async (transaction: SpecialistPackageService): Promise<void> => {
    const preview = await transaction.preview(archive())
    expect(preview.installable).toBe(true)
    const result = await transaction.install({ candidateToken: preview.candidateToken })
    if (result.status === 'failed') throw new Error(result.code)
    expect(result.status).toBe('installed')
  }
  const disabledIds = async (): Promise<string[]> =>
    (await new SettingsRepository(storageDir).getSettings()).disabledSkillIds ?? []

  it('rolls back promoted files and only the settings introduced by a failed install', async () => {
    const { port, settings, transaction } = fixture()
    await settings.setSkillsEnabled(['unrelated'], false)
    const commit = port.commit.bind(port)
    vi.spyOn(port, 'commit').mockImplementation(async (id) => {
      await commit(id)
      throw new Error('Interrupted publication')
    })
    await expect(install(transaction)).rejects.toThrow('commit-failed')
    expect(await disabledIds()).toEqual(['unrelated'])
    expect(await port.snapshot()).toEqual([])
    expect((await repository.getAll()).specialists).toEqual([])
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
    expect(await disabledIds()).toEqual(['personal-bundled-analysis'])
    let toggled = false
    const toggling = settings.setSkillsEnabled(['personal-bundled-analysis'], true).then(() => {
      toggled = true
    })
    await Promise.resolve()
    expect(toggled).toBe(false)
    resume()
    await Promise.all([installing, toggling])
    expect(await disabledIds()).toEqual([])
  })
  it.each(['committing'])(
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
      expect(await disabledIds()).toEqual(['unrelated', 'personal-bundled-analysis'])
      const restarted = fixture()
      await restarted.transaction.recover()
      await restarted.transaction.recover()
      expect(await disabledIds()).toEqual(['unrelated'])
      expect(await restarted.port.snapshot()).toEqual([])
      expect((await repository.getAll()).specialists).toEqual([])
    }
  )
})
