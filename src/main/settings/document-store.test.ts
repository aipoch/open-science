import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({
  failReadOnceWith: undefined as Error | undefined,
  failRenameOnce: false
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
      if (faults.failRenameOnce) {
        faults.failRenameOnce = false
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
  faults.failRenameOnce = false
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

  it('recovers its mutation queue after an atomic rename failure', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-settings-store-'))
    const store = new SettingsDocumentStore(storageRoot)
    faults.failRenameOnce = true

    await expect(
      store.mutate((settings) => ({ ...settings, notificationsEnabled: true }))
    ).rejects.toThrow('temporarily locked')
    await expect(
      store.mutate((settings) => ({ ...settings, conversationSkillImportEnabled: true }))
    ).resolves.toMatchObject({ conversationSkillImportEnabled: true })
    await expect(store.read()).resolves.toMatchObject({ conversationSkillImportEnabled: true })
  })
})
