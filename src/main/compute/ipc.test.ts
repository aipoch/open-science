import { describe, expect, it, vi } from 'vitest'

import type { ComputeHost, CreateComputeHostRequest } from '../../shared/compute'
import type { ComputeService } from './compute-service'
import { createComputeHandlers } from './ipc'
import type { ComputeHostRepository } from './repository'

const sampleHost = (overrides: Partial<ComputeHost> = {}): ComputeHost => ({
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

// A minimal repository double exposing only the methods the handlers call.
const mockRepository = (impl: Partial<ComputeHostRepository>): ComputeHostRepository =>
  impl as ComputeHostRepository

// A minimal ComputeService double.
const mockService = (impl: Partial<ComputeService>): ComputeService => impl as ComputeService

describe('compute handlers', () => {
  it('list delegates to the repository', async () => {
    const list = vi.fn(() => Promise.resolve([sampleHost()]))
    const handlers = createComputeHandlers(mockRepository({ list }))

    await expect(handlers.list()).resolves.toHaveLength(1)
    expect(list).toHaveBeenCalledOnce()
  })

  it('get passes the provider id through', async () => {
    const get = vi.fn(() => Promise.resolve(sampleHost()))
    const handlers = createComputeHandlers(mockRepository({ get }))

    await handlers.get('ssh:biowulf')
    expect(get).toHaveBeenCalledWith('ssh:biowulf')
  })

  it('create passes the request through and returns the created host', async () => {
    const create = vi.fn((request: CreateComputeHostRequest) =>
      Promise.resolve(sampleHost({ sshAlias: request.sshAlias }))
    )
    const handlers = createComputeHandlers(mockRepository({ create }))

    const host = await handlers.create({ sshAlias: 'lab-gpu' })
    expect(create).toHaveBeenCalledWith({ sshAlias: 'lab-gpu' })
    expect(host.sshAlias).toBe('lab-gpu')
  })

  it('propagates a duplicate-alias error from the repository', async () => {
    const create = vi.fn(() =>
      Promise.reject(new Error('A host with alias "biowulf" is already registered.'))
    )
    const handlers = createComputeHandlers(mockRepository({ create }))

    await expect(handlers.create({ sshAlias: 'biowulf' })).rejects.toThrow(/already registered/i)
  })

  it('delete passes the provider id through', async () => {
    const del = vi.fn(() => Promise.resolve())
    const handlers = createComputeHandlers(mockRepository({ delete: del }))

    await handlers.delete('ssh:biowulf')
    expect(del).toHaveBeenCalledWith('ssh:biowulf')
  })

  it('sshConfigAliases uses the injected alias lister', async () => {
    const lister = vi.fn(() => Promise.resolve(['biowulf', 'lab-gpu']))
    const handlers = createComputeHandlers(mockRepository({}), lister)

    await expect(handlers.sshConfigAliases()).resolves.toEqual(['biowulf', 'lab-gpu'])
  })

  it('probe delegates to the injected ComputeService', async () => {
    const probeResult = {
      ok: true,
      probedAt: '2026-01-01T00:00:00Z',
      exitCode: 0,
      errorTail: null,
      cpus: 64,
      detectedScheduler: 'slurm' as const
    }
    const probe = vi.fn(() => Promise.resolve(probeResult))
    const handlers = createComputeHandlers(mockRepository({}), undefined, mockService({ probe }))

    const result = await handlers.probe('ssh:biowulf')
    expect(probe).toHaveBeenCalledWith('ssh:biowulf')
    expect(result.ok).toBe(true)
    expect(result.cpus).toBe(64)
  })
})
