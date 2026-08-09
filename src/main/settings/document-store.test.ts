import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({ failRenameOnce: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
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
  faults.failRenameOnce = false
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

describe('settings document store', () => {
  it('exposes one atomic document owner', async () => {
    expect(Object.keys(await import('./document-store')).sort()).toEqual(['SettingsDocumentStore'])
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
