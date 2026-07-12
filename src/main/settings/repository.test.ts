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

    await expect(repository.getSettings()).resolves.toEqual({ version: 2, providers: [] })
  })

  it('writes settings.json atomically and reads it back', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await repository.upsertProvider(provider())

    const raw = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')) as {
      version: number
    }
    expect(raw.version).toBe(2)

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

  it('round-trips a recorded validation failure across a reload', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await repository.upsertProvider(
      provider({
        lastValidationFailure: {
          at: 1717000000000,
          category: 'auth',
          status: 401,
          message: 'nope'
        }
      })
    )

    const reloaded = await new SettingsRepository(root).getSettings()
    expect(reloaded.providers[0].lastValidationFailure).toEqual({
      at: 1717000000000,
      category: 'auth',
      status: 401,
      message: 'nope'
    })
  })

  it('drops a malformed validation failure (bad category or missing timestamp) on load', async () => {
    const root = await createStorageRoot()

    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        version: 2,
        providers: [
          {
            id: 'a',
            type: 'custom',
            name: 'A',
            lastValidationFailure: { at: 1, category: 'bogus' }
          },
          { id: 'b', type: 'custom', name: 'B', lastValidationFailure: { category: 'auth' } }
        ]
      }),
      'utf8'
    )

    const settings = await new SettingsRepository(root).getSettings()
    expect(settings.providers.map((item) => item.id)).toEqual(['a', 'b'])
    expect(settings.providers[0].lastValidationFailure).toBeUndefined()
    expect(settings.providers[1].lastValidationFailure).toBeUndefined()
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

  it('stamps onboardingCompletedAt once and is idempotent', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    const first = await repository.markOnboardingComplete(1000)
    expect(first.onboardingCompletedAt).toBe(1000)

    // A second call must not overwrite or move the existing timestamp.
    const second = await repository.markOnboardingComplete(2000)
    expect(second.onboardingCompletedAt).toBe(1000)
  })

  it('preserves onboardingCompletedAt across a reload', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await repository.markOnboardingComplete(1234)

    const reloaded = await new SettingsRepository(root).getSettings()
    expect(reloaded.onboardingCompletedAt).toBe(1234)
  })
})

describe('settings repository: v2 official providers & activeModel migration', () => {
  it('backfills activeModel from the active provider when a pre-v2 file omits it', async () => {
    const root = await createStorageRoot()

    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        version: 1,
        activeProviderId: 'p1',
        providers: [
          { id: 'p1', type: 'custom', name: 'G', baseUrl: 'https://g', model: 'legacy-m' }
        ]
      }),
      'utf8'
    )

    const settings = await new SettingsRepository(root).getSettings()
    expect(settings.version).toBe(2)
    expect(settings.activeModel).toBe('legacy-m')
  })

  it('keeps an explicit activeModel from a v2 file', async () => {
    const root = await createStorageRoot()

    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        version: 2,
        activeProviderId: 'p1',
        activeModel: 'glm-4.7',
        providers: [{ id: 'p1', type: 'official', name: 'GLM', vendorId: 'zhipu', keyRef: 'enc:x' }]
      }),
      'utf8'
    )

    const settings = await new SettingsRepository(root).getSettings()
    expect(settings.activeModel).toBe('glm-4.7')
    expect(settings.providers[0]).toMatchObject({ type: 'official', vendorId: 'zhipu' })
  })

  it('drops an official provider with an unknown or missing vendor', async () => {
    const root = await createStorageRoot()

    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        version: 2,
        providers: [
          { id: 'ok', type: 'official', name: 'DeepSeek', vendorId: 'deepseek', keyRef: 'enc:x' },
          { id: 'bad1', type: 'official', name: 'Bogus', vendorId: 'openai', keyRef: 'enc:x' },
          { id: 'bad2', type: 'official', name: 'No vendor', keyRef: 'enc:x' }
        ]
      }),
      'utf8'
    )

    const settings = await new SettingsRepository(root).getSettings()
    expect(settings.providers.map((item) => item.id)).toEqual(['ok'])
  })

  it('clears activeModel when the active provider is deleted', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    await repository.upsertProvider(provider())
    await repository.setActiveProvider('p1', 'm')
    expect((await repository.getSettings()).activeModel).toBe('m')

    await repository.deleteProvider('p1')
    expect((await repository.getSettings()).activeModel).toBeUndefined()
  })

  it('persists the active provider + model across a reload (app restart)', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    await repository.upsertProvider(provider())
    await repository.setActiveProvider('p1', 'my-model')

    // A fresh repository on the same storage dir models an app restart: the selection is read back.
    const reloaded = await new SettingsRepository(root).getSettings()
    expect(reloaded.activeProviderId).toBe('p1')
    expect(reloaded.activeModel).toBe('my-model')
  })
})
