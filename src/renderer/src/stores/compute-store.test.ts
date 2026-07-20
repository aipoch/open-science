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
