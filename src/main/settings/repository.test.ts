import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

import { SettingsRepository, sanitizeSettings } from './repository'
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

  it('keeps provider order stable when an existing provider is updated in place', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    await repository.upsertProvider(provider({ id: 'p1', name: 'One' }))
    await repository.upsertProvider(provider({ id: 'p2', name: 'Two' }))
    await repository.upsertProvider(provider({ id: 'p3', name: 'Three' }))

    // Editing p1 (or recording a test result on it) must not move it to the end of the list.
    await repository.upsertProvider(provider({ id: 'p1', name: 'One (edited)' }))

    const settings = await repository.getSettings()
    expect(settings.providers.map((item) => item.id)).toEqual(['p1', 'p2', 'p3'])
    expect(settings.providers[0].name).toBe('One (edited)')
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

  it('stamps pathsNormalizedAt once, is idempotent, and survives a reload', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    const first = await repository.markPathsNormalized(1000)
    expect(first.pathsNormalizedAt).toBe(1000)

    // A second call must not overwrite or move the existing timestamp.
    const second = await repository.markPathsNormalized(2000)
    expect(second.pathsNormalizedAt).toBe(1000)

    const reloaded = await new SettingsRepository(root).getSettings()
    expect(reloaded.pathsNormalizedAt).toBe(1000)
  })

  it('sets dataRoot, overwrites on a later call, and survives a reload', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    const first = await repository.setDataRoot('/mnt/data-a')
    expect(first.dataRoot).toBe('/mnt/data-a')

    // Unlike the marker fields above, dataRoot is not idempotent-once: a later call must move it.
    const second = await repository.setDataRoot('/mnt/data-b')
    expect(second.dataRoot).toBe('/mnt/data-b')

    // getSettings reads through sanitizeSettings, which normalizes the stored path (backslashes on
    // Windows), so compare against the platform-normalized form rather than the literal.
    const reloaded = await new SettingsRepository(root).getSettings()
    expect(reloaded.dataRoot).toBe(normalize('/mnt/data-b'))
  })

  it('sanitizeSettings drops a relative dataRoot and keeps only an absolute, normalized one', () => {
    // A relative dataRoot (corrupt or hand-edited settings.json) must be dropped so the data tree
    // never resolves against process.cwd(); initDataRoot then falls back to the default.
    expect(sanitizeSettings({ dataRoot: 'relative/path' }).dataRoot).toBeUndefined()
    expect(sanitizeSettings({ dataRoot: './OpenScience' }).dataRoot).toBeUndefined()

    // Whitespace-only is not a path.
    expect(sanitizeSettings({ dataRoot: '   ' }).dataRoot).toBeUndefined()

    // Build an absolute path with platform-correct roots so isAbsolute holds on POSIX and Windows.
    const absolute = isAbsolute('/mnt/data') ? '/mnt/data' : `C:${sep}mnt${sep}data`
    // Surrounding whitespace is trimmed, then the path is kept.
    expect(sanitizeSettings({ dataRoot: `  ${absolute} ` }).dataRoot).toBe(normalize(absolute))

    // A redundant separator AND a trailing separator collapse to the canonical no-trailing-slash form.
    const messy = `${absolute}${sep}${sep}x${sep}`
    expect(sanitizeSettings({ dataRoot: messy }).dataRoot).toBe(normalize(`${absolute}${sep}x`))
  })

  it('never strips a trailing separator past a filesystem root', () => {
    // A drive/filesystem root ("C:\" on Windows, "/" on POSIX) must survive intact: stripping its
    // trailing separator would turn an absolute path into a drive-relative one.
    const rootPath = isAbsolute('C:\\') ? 'C:\\' : '/'
    expect(sanitizeSettings({ dataRoot: rootPath }).dataRoot).toBe(normalize(rootPath))
  })

  it('stamps legacyDataMovePromptDismissedAt once, is idempotent, and survives a reload', async () => {
    const root = await createStorageRoot()
    const repository = new SettingsRepository(root)

    const first = await repository.markLegacyDataMovePromptDismissed(1000)
    expect(first.legacyDataMovePromptDismissedAt).toBe(1000)

    // Answering again must never move the timestamp — the prompt stays dismissed for good.
    const second = await repository.markLegacyDataMovePromptDismissed(2000)
    expect(second.legacyDataMovePromptDismissedAt).toBe(1000)

    const reloaded = await new SettingsRepository(root).getSettings()
    expect(reloaded.legacyDataMovePromptDismissedAt).toBe(1000)
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

  it('persists and clears disabledSkillIds via setSkillEnabled', async () => {
    const repository = new SettingsRepository(await createStorageRoot())

    await repository.setSkillEnabled('citation-formatter', false)
    expect((await repository.getSettings()).disabledSkillIds).toEqual(['citation-formatter'])

    // Re-enabling removes the id (and drops the field when the set becomes empty).
    await repository.setSkillEnabled('citation-formatter', true)
    expect((await repository.getSettings()).disabledSkillIds).toBeUndefined()
  })

  it('drops non-string / duplicate disabledSkillIds on read', async () => {
    const root = await createStorageRoot()

    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({ version: 2, providers: [], disabledSkillIds: ['a', 'a', 3, '', 'b'] }),
      'utf8'
    )

    expect((await new SettingsRepository(root).getSettings()).disabledSkillIds).toEqual(['a', 'b'])
  })
})
