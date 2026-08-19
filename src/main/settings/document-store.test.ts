import { mkdtemp, readFile, readdir, rename as renameFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({
  failReadOnceWith: undefined as Error | undefined,
  renameFailuresRemaining: 0
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
      if (faults.failReadOnceWith) {
        const error = faults.failReadOnceWith
        faults.failReadOnceWith = undefined
        throw error
      }
      return actual.readFile(...args)
    }),
    rename: vi.fn(async (source: string, destination: string) => {
      if (faults.renameFailuresRemaining > 0) {
        faults.renameFailuresRemaining -= 1
        throw Object.assign(new Error('EPERM: settings file is temporarily locked'), {
          code: 'EPERM'
        })
      }
      await actual.rename(source, destination)
    })
  }
})

import { SettingsDocumentStore } from './document-store'

let storageRoot: string | undefined

afterEach(async () => {
  faults.failReadOnceWith = undefined
  faults.renameFailuresRemaining = 0
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
    faults.failReadOnceWith = readFailure

    await expect(store.mutate(update)).rejects.toBe(readFailure)
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
