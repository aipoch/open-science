import {
  mkdtemp,
  open as openFile,
  readFile,
  readdir,
  rename as renameFile,
  rm,
  stat as statFile,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({
  failOpenOnceWith: undefined as Error | undefined,
  renameFailuresRemaining: 0,
  reportedSize: undefined as number | undefined
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      if (faults.failOpenOnceWith) {
        const error = faults.failOpenOnceWith
        faults.failOpenOnceWith = undefined
        throw error
      }
      return actual.open(...args)
    }),
    readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => actual.readFile(...args)),
    rename: vi.fn(async (source: string, destination: string) => {
      if (faults.renameFailuresRemaining > 0) {
        faults.renameFailuresRemaining -= 1
        throw Object.assign(new Error('EPERM: settings file is temporarily locked'), {
          code: 'EPERM'
        })
      }
      await actual.rename(source, destination)
    }),
    stat: vi.fn(async (...args: Parameters<typeof actual.stat>) => {
      const result = await actual.stat(...args)
      return faults.reportedSize === undefined ? result : { ...result, size: faults.reportedSize }
    })
  }
})

import { SettingsDocumentStore } from './document-store'

let storageRoot: string | undefined

afterEach(async () => {
  faults.failOpenOnceWith = undefined
  faults.renameFailuresRemaining = 0
  faults.reportedSize = undefined
  vi.clearAllMocks()
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

describe('settings document store', () => {
  it('exposes one atomic document owner', async () => {
    expect(Object.keys(await import('./document-store')).sort()).toEqual(['SettingsDocumentStore'])
  })

  it('treats a missing settings document as an uninitialized store', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-settings-store-'))
    const store = new SettingsDocumentStore(storageRoot)

    await expect(store.read()).resolves.toEqual({ version: 2, providers: [] })
    await expect(
      store.mutate((settings) => ({ ...settings, notificationsEnabled: false }))
    ).resolves.toMatchObject({ providers: [], notificationsEnabled: false })
  })

  it('rejects an oversized settings document before reading its contents', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-settings-store-'))
    const settingsPath = join(storageRoot, 'settings.json')
    await writeFile(settingsPath, '{"version":2,"providers":[]}\n', 'utf8')
    faults.reportedSize = 128 * 1024 * 1024 + 1
    vi.mocked(readFile).mockClear()

    await expect(new SettingsDocumentStore(storageRoot).read()).rejects.toThrow(
      'settings.json exceeds the 134217728 byte read limit.'
    )
    expect(readFile).not.toHaveBeenCalled()
    expect(statFile).toHaveBeenCalledWith(settingsPath)
  })

  it('migrates a version 1 settings document through the registered pipeline', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-settings-store-'))
    await writeFile(
      join(storageRoot, 'settings.json'),
      JSON.stringify({
        version: 1,
        providers: [{ id: 'provider-1', type: 'custom', name: 'Provider', model: 'model-1' }],
        activeProviderId: 'provider-1'
      }),
      'utf8'
    )

    await expect(new SettingsDocumentStore(storageRoot).read()).resolves.toMatchObject({
      version: 2,
      activeProviderId: 'provider-1',
      activeModel: 'model-1'
    })
  })

  it('recovers a valid historical Settings temp when the primary is missing', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-settings-store-temp-'))
    await writeFile(
      join(storageRoot, 'settings.json.1700000000000-1.tmp'),
      JSON.stringify({
        version: 2,
        providers: [],
        notificationsEnabled: false
      }),
      'utf8'
    )

    await expect(new SettingsDocumentStore(storageRoot).read()).resolves.toMatchObject({
      notificationsEnabled: false
    })
    await expect(readdir(storageRoot)).resolves.toEqual(['settings.json'])
  })

  it('does not skip a future Settings temp and recover an older format', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-settings-store-temp-'))
    const temporaryName = 'settings.json.1700000000000-1.tmp'
    const futureContents = '{"version":3,"futurePreference":"must-survive"}\n'
    await writeFile(join(storageRoot, temporaryName), futureContents, 'utf8')

    await expect(new SettingsDocumentStore(storageRoot).read()).rejects.toThrow(
      'Settings document version 3 is newer than supported version 2.'
    )
    await expect(readFile(join(storageRoot, temporaryName), 'utf8')).resolves.toBe(futureContents)
    await expect(readdir(storageRoot)).resolves.toEqual([temporaryName])
  })

  it('does not delete a future Settings temp when an older primary exists', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-settings-store-temp-'))
    const settingsPath = join(storageRoot, 'settings.json')
    const temporaryName = 'settings.json.1700000000000-1.tmp'
    const primaryContents = '{"version":2,"providers":[]}\n'
    const futureContents = '{"version":3,"futurePreference":"must-survive"}\n'
    await writeFile(settingsPath, primaryContents, 'utf8')
    await writeFile(join(storageRoot, temporaryName), futureContents, 'utf8')

    await expect(new SettingsDocumentStore(storageRoot).read()).rejects.toThrow(
      'Settings document version 3 is newer than supported version 2.'
    )
    await expect(readFile(settingsPath, 'utf8')).resolves.toBe(primaryContents)
    await expect(readFile(join(storageRoot, temporaryName), 'utf8')).resolves.toBe(futureContents)
  })

  it('rejects corrupt JSON and prevents a mutation from publishing over it', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-settings-store-'))
    const settingsPath = join(storageRoot, 'settings.json')
    const corruptContents = '{"providers":['
    await writeFile(settingsPath, corruptContents, 'utf8')
    const store = new SettingsDocumentStore(storageRoot)
    const update = vi.fn((settings) => ({ ...settings, notificationsEnabled: false }))

    await expect(store.read()).rejects.toBeInstanceOf(SyntaxError)
    await expect(store.mutate(update)).rejects.toBeInstanceOf(SyntaxError)

    expect(update).not.toHaveBeenCalled()
    await expect(readFile(settingsPath, 'utf8')).resolves.toBe(corruptContents)
  })

  it('rejects mutation of a future settings document without overwriting its fields', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-settings-store-'))
    const settingsPath = join(storageRoot, 'settings.json')
    const futureContents = `${JSON.stringify({
      version: 3,
      providers: [],
      futurePreference: 'must-survive'
    })}\n`
    await writeFile(settingsPath, futureContents, 'utf8')
    const store = new SettingsDocumentStore(storageRoot)
    const update = vi.fn((settings) => ({ ...settings, notificationsEnabled: false }))

    await expect(store.mutate(update)).rejects.toThrow(
      'Settings document version 3 is newer than supported version 2.'
    )

    expect(update).not.toHaveBeenCalled()
    await expect(readFile(settingsPath, 'utf8')).resolves.toBe(futureContents)
  })

  it('rejects an unversioned settings document', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-settings-store-'))
    const settingsPath = join(storageRoot, 'settings.json')
    const unversionedContents = '{"providers":[]}\n'
    await writeFile(settingsPath, unversionedContents, 'utf8')

    await expect(new SettingsDocumentStore(storageRoot).read()).rejects.toThrow(
      'Settings document is corrupt.'
    )
    await expect(readFile(settingsPath, 'utf8')).resolves.toBe(unversionedContents)
  })

  it('propagates a read I/O failure without publishing and recovers its mutation queue', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-settings-store-'))
    const settingsPath = join(storageRoot, 'settings.json')
    const originalContents = `${JSON.stringify({
      version: 2,
      providers: [],
      conversationSkillImportEnabled: false
    })}\n`
    await writeFile(settingsPath, originalContents, 'utf8')
    const store = new SettingsDocumentStore(storageRoot)
    const update = vi.fn((settings) => ({ ...settings, notificationsEnabled: false }))
    const readFailure = Object.assign(new Error('EACCES: settings file is unreadable'), {
      code: 'EACCES'
    })
    faults.failOpenOnceWith = readFailure

    await expect(store.mutate(update)).rejects.toBe(readFailure)
    expect(openFile).toHaveBeenCalledWith(settingsPath, 'r')
    expect(update).not.toHaveBeenCalled()
    await expect(readFile(settingsPath, 'utf8')).resolves.toBe(originalContents)

    await expect(
      store.mutate((settings) => ({ ...settings, notificationsEnabled: false }))
    ).resolves.toMatchObject({
      conversationSkillImportEnabled: false,
      notificationsEnabled: false
    })
  })

  it('retries a transient Windows file-replacement denial without losing the Settings save', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-settings-store-'))
    const store = new SettingsDocumentStore(storageRoot)
    faults.renameFailuresRemaining = 1

    await expect(
      store.mutate((settings) => ({ ...settings, notificationsEnabled: true }))
    ).resolves.toMatchObject({ notificationsEnabled: true })

    expect(vi.mocked(renameFile)).toHaveBeenCalledTimes(2)
    await expect(store.read()).resolves.toMatchObject({ notificationsEnabled: true })
  })

  it('fails closed and removes its temporary file after persistent replacement denial', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-settings-store-'))
    const store = new SettingsDocumentStore(storageRoot)
    faults.renameFailuresRemaining = Number.POSITIVE_INFINITY

    await expect(
      store.mutate((settings) => ({ ...settings, notificationsEnabled: true }))
    ).rejects.toThrow('temporarily locked')

    await expect(readdir(storageRoot)).resolves.not.toEqual(
      expect.arrayContaining([expect.stringContaining('.tmp')])
    )
    expect(vi.mocked(renameFile)).toHaveBeenCalledTimes(6)
  })

  it('keeps independent store instances from colliding on a temporary path', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-settings-store-collision-'))
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    try {
      const first = new SettingsDocumentStore(storageRoot)
      const second = new SettingsDocumentStore(storageRoot)

      await expect(
        Promise.all([
          first.mutate((settings) => ({ ...settings, notificationsEnabled: true })),
          second.mutate((settings) => ({ ...settings, telemetryEnabled: false }))
        ])
      ).resolves.toHaveLength(2)

      await expect(new SettingsDocumentStore(storageRoot).read()).resolves.toMatchObject({
        version: 2,
        providers: []
      })
      await expect(readdir(storageRoot)).resolves.toEqual(['settings.json'])
    } finally {
      now.mockRestore()
    }
  })
})
