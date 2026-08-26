import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createEmptySettings } from './types'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getAppPath: () => tmpdir(), isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
  net: { fetch: vi.fn() }
}))

const { SettingsRepository } = await import('./repository')
const { SettingsService } = await import('./service')

describe('Network proxy settings persistence', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'network-proxy-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips a normalized manual proxy without credentials', async () => {
    const repository = new SettingsRepository(dir)

    await repository.setNetworkProxy({
      mode: 'manual',
      server: 'http://proxy.example:8080/',
      bypassRules: 'example.internal; localhost'
    })

    await expect(new SettingsRepository(dir).getSettings()).resolves.toMatchObject({
      networkProxy: {
        mode: 'manual',
        server: 'http://proxy.example:8080',
        bypassRules: 'example.internal,localhost'
      }
    })
  })

  it('removes the optional property when returning to System mode', async () => {
    const repository = new SettingsRepository(dir)
    await repository.setNetworkProxy({ mode: 'direct' })
    await repository.setNetworkProxy({ mode: 'system' })

    expect((await repository.getSettings()).networkProxy).toBeUndefined()
  })

  it('refuses to persist embedded credentials', async () => {
    const repository = new SettingsRepository(dir)

    await expect(
      repository.setNetworkProxy({
        mode: 'manual',
        server: 'http://user:password@proxy.example:8080'
      })
    ).rejects.toThrow('embedded usernames or passwords')
    expect((await repository.getSettings()).networkProxy).toBeUndefined()
  })

  it('projects old documents as System and applies saved changes only after persistence', async () => {
    const repository = new SettingsRepository(dir)
    const applyNetworkProxy = vi.fn().mockResolvedValue(undefined)
    const service = new SettingsService({ repository, storageRoot: dir, applyNetworkProxy })

    await expect(service.getSettingsView()).resolves.toMatchObject({
      networkProxy: { mode: 'system' }
    })
    await expect(service.setNetworkProxy({ mode: 'direct' })).resolves.toEqual({ mode: 'direct' })

    expect(applyNetworkProxy).toHaveBeenCalledWith({ mode: 'direct' })
    expect((await repository.getSettings()).networkProxy).toEqual({ mode: 'direct' })
  })

  it('does not persist a proxy setting that the runtime rejected', async () => {
    const repository = new SettingsRepository(dir)
    const applyNetworkProxy = vi.fn().mockRejectedValue(new Error('proxy session unavailable'))
    const service = new SettingsService({ repository, storageRoot: dir, applyNetworkProxy })

    await expect(service.setNetworkProxy({ mode: 'direct' })).rejects.toThrow(
      'proxy session unavailable'
    )

    expect((await repository.getSettings()).networkProxy).toBeUndefined()
  })

  it('keeps persisted and runtime proxy order aligned across concurrent saves', async () => {
    let stored = createEmptySettings()
    const repository = {
      getSettings: vi.fn(async () => stored),
      setNetworkProxy: vi.fn(async (networkProxy) => {
        stored = { ...stored, networkProxy }
        return stored
      })
    } as unknown as InstanceType<typeof SettingsRepository>
    let releaseFirstApply!: () => void
    const firstApply = new Promise<void>((resolve) => {
      releaseFirstApply = resolve
    })
    let runtimeMode = 'system'
    const applyNetworkProxy = vi.fn(async (settings: { mode: string }) => {
      if (settings.mode === 'direct') await firstApply
      runtimeMode = settings.mode
    })
    const service = new SettingsService({ repository, storageRoot: dir, applyNetworkProxy })

    const firstSave = service.setNetworkProxy({ mode: 'direct' })
    await vi.waitFor(() => expect(applyNetworkProxy).toHaveBeenCalledWith({ mode: 'direct' }))
    const secondSave = service.setNetworkProxy({
      mode: 'manual',
      server: 'http://proxy.example:8080'
    })
    await Promise.resolve()
    await Promise.resolve()
    releaseFirstApply()
    await Promise.all([firstSave, secondSave])

    expect(stored.networkProxy?.mode).toBe('manual')
    expect(runtimeMode).toBe('manual')
  })
})
