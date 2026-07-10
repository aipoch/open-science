import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

import { SettingsRepository } from './repository'
import type { StoredProvider } from './types'

let storageRoot: string | undefined

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-settings-'))
  return storageRoot
}

const provider = (overrides: Partial<StoredProvider> = {}): StoredProvider => ({
  id: 'p1',
  type: 'custom',
  name: 'Gateway',
  baseUrl: 'https://g/v1',
  model: 'm',
  keyRef: 'enc:abc',
  keyMask: 'sk-…abcd',
  ...overrides
})

afterEach(async () => {
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('settings repository', () => {
  it('returns empty settings when nothing is stored yet', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    await expect(repository.getSettings()).resolves.toEqual({ version: 1, providers: [] })
  })

  it('writes settings.json atomically and reads it back', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await repository.upsertProvider(provider())

    const raw = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')) as {
      version: number
    }
    expect(raw.version).toBe(1)

    const settings = await repository.getSettings()
    expect(settings.claude).toEqual({ resolvedPath: '/bin/claude', version: '2.1.0' })
    expect(settings.providers).toHaveLength(1)
    expect(settings.providers[0]).toMatchObject({ id: 'p1', keyRef: 'enc:abc' })
  })

  it('replaces a provider in place on upsert by id', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    await repository.upsertProvider(provider({ name: 'First' }))
    await repository.upsertProvider(provider({ name: 'Renamed' }))

    const settings = await repository.getSettings()
    expect(settings.providers).toHaveLength(1)
    expect(settings.providers[0].name).toBe('Renamed')
  })

  it('clears the active pointer when the active provider is deleted', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    await repository.upsertProvider(provider())
    await repository.setActiveProvider('p1')
    expect((await repository.getSettings()).activeProviderId).toBe('p1')

    await repository.deleteProvider('p1')
    const settings = await repository.getSettings()
    expect(settings.providers).toEqual([])
    expect(settings.activeProviderId).toBeUndefined()
  })

  it('ignores an active pointer that references an unknown provider', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    await repository.upsertProvider(provider())
    await repository.setActiveProvider('does-not-exist')

    expect((await repository.getSettings()).activeProviderId).toBeUndefined()
  })

  it('drops unknown fields and invalid providers on load', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        version: 1,
        activeProviderId: 'p1',
        claude: { resolvedPath: '/bin/claude', junk: 'drop' },
        providers: [
          { id: 'p1', type: 'custom', name: 'Ok', secretPlaintext: 'should not persist' },
          { id: 'p2', type: 'not-a-type', name: 'Bad' },
          { type: 'custom', name: 'No id' }
        ]
      }),
      'utf8'
    )

    const settings = await repository.getSettings()
    expect(settings.providers.map((item) => item.id)).toEqual(['p1'])
    expect(settings.providers[0]).not.toHaveProperty('secretPlaintext')
    expect(settings.claude).toEqual({ resolvedPath: '/bin/claude' })
  })

  it('serializes concurrent mutations without losing writes', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    await Promise.all([
      repository.upsertProvider(provider({ id: 'p1', name: 'One' })),
      repository.upsertProvider(provider({ id: 'p2', name: 'Two' })),
      repository.upsertProvider(provider({ id: 'p3', name: 'Three' }))
    ])

    const settings = await repository.getSettings()
    expect(settings.providers.map((item) => item.id).sort()).toEqual(['p1', 'p2', 'p3'])
  })
})
