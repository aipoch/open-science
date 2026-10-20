import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createSpecialistDomain,
  type SpecialistArchives as SpecialistPackageService
} from '../domain'
import { SpecialistRepository } from '../repository'
import { fakeSkillParticipant, fixtureSkillParser } from '../../test/fixtures'
const encoder = new TextEncoder()
let storageDir: string
let repository: SpecialistRepository
let disabled: Set<string>
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
  storageDir = join(tmpdir(), 'specialist-enablement-' + randomUUID())
  await mkdir(storageDir)
  repository = new SpecialistRepository(storageDir)
  disabled = new Set()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(storageDir, { recursive: true, force: true })
})
const disabledIds = async (): Promise<string[]> => [...disabled]
function fixture(): {
  port: typeof fakeSkillParticipant
  settings: {
    disabledSkillIds: () => Promise<string[]>
    setSkillsEnabled: (ids: readonly string[], enabled: boolean) => Promise<void>
  }
  transaction: SpecialistPackageService
} {
  const port = {
    ...fakeSkillParticipant,
    commit: fakeSkillParticipant.commit,
    rollback: fakeSkillParticipant.rollback
  }
  const settings = {
    disabledSkillIds: disabledIds,
    setSkillsEnabled: async (ids: readonly string[], enabled: boolean) => {
      for (const id of ids) enabled ? disabled.delete(id) : disabled.add(id)
    }
  }
  const transaction = createSpecialistDomain({ storageDir }).createArchives({
    skillPort: port,
    skillSettings: settings,
    disableNewSkills: true,
    parseSkillDocument: fixtureSkillParser,
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

it('does not publish files when settings persistence fails, even after an uncertain write', async () => {
  const { port, settings, transaction } = fixture()
  const set = settings.setSkillsEnabled.bind(settings)
  vi.spyOn(settings, 'setSkillsEnabled').mockImplementationOnce(async (ids, enabled) => {
    await set(ids, enabled)
    throw new Error('Settings write acknowledgement lost')
  })
  const publish = vi.spyOn(port, 'commit')
  await expect(install(transaction)).rejects.toThrow('commit-failed')
  expect(publish).not.toHaveBeenCalled()
  expect(await disabledIds()).toEqual([])
  expect((await repository.getAll()).specialists).toEqual([])
})

it.each(['committing', 'rolling-back'])(
  'recovers %s only transaction-owned enablement after restarting',
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
    const recovered = vi.spyOn(restarted.port, 'recover')
    await restarted.transaction.recover()
    await restarted.transaction.recover()
    expect(await disabledIds()).toEqual(['unrelated'])
    expect(recovered).toHaveBeenCalledWith(expect.any(String), 'rollback')
    expect((await repository.getAll()).specialists).toEqual([])
  }
)

it('does not reinterpret settings when recovering a historical journal without the new list', async () => {
  const { port, settings, transaction } = fixture()
  await settings.setSkillsEnabled(['personal-bundled-analysis'], false)
  vi.spyOn(port, 'commit').mockRejectedValue(new Error('crash'))
  vi.spyOn(port, 'rollback').mockRejectedValue(new Error('process stopped'))
  await expect(install(transaction)).rejects.toThrow()
  const path = join(storageDir, 'specialist-package-transaction.json')
  const journal = JSON.parse(await readFile(path, 'utf8'))
  delete journal.newlyDisabledSkillIds
  await writeFile(path, JSON.stringify(journal))
  await fixture().transaction.recover()
  expect(await disabledIds()).toEqual(['personal-bundled-analysis'])
})

it('preserves subsequent user choices when retrying committed cleanup', async () => {
  const { port, settings, transaction } = fixture()
  const recover = port.recover.bind(port)
  vi.spyOn(port, 'recover').mockImplementation(async (id, outcome) => {
    if (id && outcome === 'commit') throw new Error('cleanup interrupted')
    return recover(id, outcome)
  })
  await expect(install(transaction)).rejects.toThrow('recovery-failed')
  expect(await disabledIds()).toEqual(['personal-bundled-analysis'])
  await settings.setSkillsEnabled(['personal-bundled-analysis'], true)
  await fixture().transaction.recover()
  expect(await disabledIds()).toEqual([])
  expect((await repository.getAll()).specialists).toHaveLength(1)
})
