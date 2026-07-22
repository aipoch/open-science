import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeHost } from '../../../shared/compute'
import { createInitialComputeState, useComputeStore } from './compute-store'

const createHost = (overrides: Partial<ComputeHost> = {}): ComputeHost => ({
  id: 'host-1',
  providerId: 'ssh:biowulf',
  displayName: 'biowulf',
  shape: 'direct_ssh',
  sshAlias: 'biowulf',
  sshOverrides: undefined,
  scratchRoot: undefined,
  scratchPinned: false,
  concurrencyLimit: undefined,
  probeResult: undefined,
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const setComputeApi = (api: Partial<Window['api']['compute']>): void => {
  ;(globalThis as unknown as { window: { api: { compute: unknown } } }).window = {
    api: { compute: api }
  } as never
}

beforeEach(() => {
  useComputeStore.setState(createInitialComputeState())
})

describe('compute store', () => {
  it('loads hosts newest-first', async () => {
    setComputeApi({
      list: vi
        .fn()
        .mockResolvedValue([
          createHost({ providerId: 'ssh:old', createdAt: 10 }),
          createHost({ providerId: 'ssh:new', createdAt: 99 })
        ])
    })

    await useComputeStore.getState().loadHosts()

    expect(useComputeStore.getState().isLoaded).toBe(true)
    expect(useComputeStore.getState().loadError).toBeUndefined()
    expect(useComputeStore.getState().hosts.map((h) => h.providerId)).toEqual([
      'ssh:new',
      'ssh:old'
    ])
  })

  it('records a load error instead of throwing', async () => {
    setComputeApi({ list: vi.fn().mockRejectedValue(new Error('db down')) })

    await useComputeStore.getState().loadHosts()

    expect(useComputeStore.getState().isLoaded).toBe(true)
    expect(useComputeStore.getState().loadError).toBe('db down')
  })

  it('loads ssh aliases and degrades to empty on failure', async () => {
    setComputeApi({ sshConfigAliases: vi.fn().mockResolvedValue(['biowulf', 'lab-gpu']) })
    await useComputeStore.getState().loadSshAliases()
    expect(useComputeStore.getState().sshAliases).toEqual(['biowulf', 'lab-gpu'])

    setComputeApi({ sshConfigAliases: vi.fn().mockRejectedValue(new Error('no file')) })
    await useComputeStore.getState().loadSshAliases()
    expect(useComputeStore.getState().sshAliases).toEqual([])
  })

  it('creates a host and merges it into the cache', async () => {
    const created = createHost({ providerId: 'ssh:lab-gpu', createdAt: 50 })
    setComputeApi({ create: vi.fn().mockResolvedValue(created) })
    useComputeStore.setState({ hosts: [createHost({ providerId: 'ssh:old', createdAt: 10 })] })

    const result = await useComputeStore.getState().createHost({ sshAlias: 'lab-gpu' })

    expect(result.providerId).toBe('ssh:lab-gpu')
    expect(useComputeStore.getState().hosts.map((h) => h.providerId)).toEqual([
      'ssh:lab-gpu',
      'ssh:old'
    ])
  })

  it('propagates a create rejection (e.g. duplicate alias)', async () => {
    setComputeApi({
      create: vi
        .fn()
        .mockRejectedValue(new Error('A host with alias "biowulf" is already registered.'))
    })

    await expect(useComputeStore.getState().createHost({ sshAlias: 'biowulf' })).rejects.toThrow(
      /already registered/i
    )
  })

  it('deletes a host and drops it from the cache', async () => {
    const del = vi.fn().mockResolvedValue(undefined)
    setComputeApi({ delete: del })
    useComputeStore.setState({
      hosts: [createHost({ providerId: 'ssh:a' }), createHost({ providerId: 'ssh:b' })]
    })

    await useComputeStore.getState().deleteHost('ssh:a')

    expect(del).toHaveBeenCalledWith({ providerId: 'ssh:a' })
    expect(useComputeStore.getState().hosts.map((h) => h.providerId)).toEqual(['ssh:b'])
  })
})

describe('compute store — details', () => {
  it('saveDetails calls detailsSave and re-fetches the host', async () => {
    const updatedHost = createHost({ detailsDoc: 'new content', detailsUpdatedBy: 'user' })
    const detailsSave = vi.fn().mockResolvedValue(undefined)
    const get = vi.fn().mockResolvedValue(updatedHost)
    setComputeApi({ detailsSave, get })
    useComputeStore.setState({ hosts: [createHost()] })

    await useComputeStore.getState().saveDetails('ssh:biowulf', 'new content', '')

    expect(detailsSave).toHaveBeenCalledWith('ssh:biowulf', 'new content', '', 'user')
    expect(useComputeStore.getState().hosts[0].detailsDoc).toBe('new content')
  })

  it('saveDetails propagates errors', async () => {
    setComputeApi({
      detailsSave: vi.fn().mockRejectedValue(new Error('old_text mismatch'))
    })

    await expect(
      useComputeStore.getState().saveDetails('ssh:biowulf', 'new', 'wrong old')
    ).rejects.toThrow(/old_text|mismatch/i)
  })
})

describe('compute store — scratch root', () => {
  it('setScratch calls scratchSet and re-fetches the host', async () => {
    const pinnedHost = createHost({ scratchRoot: '/my/scratch', scratchPinned: true })
    const scratchSet = vi.fn().mockResolvedValue(undefined)
    const get = vi.fn().mockResolvedValue(pinnedHost)
    setComputeApi({ scratchSet, get })
    useComputeStore.setState({ hosts: [createHost()] })

    await useComputeStore.getState().setScratch('ssh:biowulf', '/my/scratch')

    expect(scratchSet).toHaveBeenCalledWith('ssh:biowulf', '/my/scratch')
    expect(useComputeStore.getState().hosts[0].scratchPinned).toBe(true)
  })
})

describe('compute store — concurrency limit', () => {
  it('setConcurrency calls concurrencySet and re-fetches the host', async () => {
    const updatedHost = createHost({ concurrencyLimit: 20 })
    const concurrencySet = vi.fn().mockResolvedValue(undefined)
    const get = vi.fn().mockResolvedValue(updatedHost)
    setComputeApi({ concurrencySet, get })
    useComputeStore.setState({ hosts: [createHost()] })

    await useComputeStore.getState().setConcurrency('ssh:biowulf', 20)

    expect(concurrencySet).toHaveBeenCalledWith('ssh:biowulf', 20)
    expect(useComputeStore.getState().hosts[0].concurrencyLimit).toBe(20)
  })
})
