import { describe, expect, it, vi } from 'vitest'

import { ComputeHostRepository, type ComputeHostClient } from './repository'

const createRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'host-1',
  providerId: 'ssh:biowulf',
  displayName: 'biowulf',
  shape: 'direct_ssh',
  sshAlias: 'biowulf',
  sshOverrides: null,
  scratchRoot: null,
  scratchPinned: false,
  concurrencyLimit: null,
  probeResult: null,
  detailsDoc: '',
  detailsUpdatedAt: null,
  detailsUpdatedBy: null,
  createdAt: new Date(1710000000000),
  updatedAt: new Date(1710000000100),
  ...overrides
})

// Builds a mock computeHost delegate; each method is a spy the tests can assert against.
const createMockClient = (
  methods: Partial<Record<'findMany' | 'findUnique' | 'create' | 'delete', unknown>>
): { client: ComputeHostClient; computeHost: Record<string, ReturnType<typeof vi.fn>> } => {
  const computeHost = {
    findMany: vi.fn(methods.findMany as never),
    findUnique: vi.fn(methods.findUnique as never),
    create: vi.fn(methods.create as never),
    delete: vi.fn(methods.delete as never)
  }

  return { client: { computeHost } as unknown as ComputeHostClient, computeHost }
}

describe('compute host repository', () => {
  it('lists hosts most-recently-created first as epoch-ms timestamps', async () => {
    const { client, computeHost } = createMockClient({
      findMany: () => Promise.resolve([createRow()])
    })
    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    await expect(repository.list()).resolves.toEqual([
      {
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
        createdAt: 1710000000000,
        updatedAt: 1710000000100
      }
    ])
    expect(computeHost.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' } })
  })

  it('parses JSON columns (overrides, probeResult) when present', async () => {
    const { client } = createMockClient({
      findUnique: () =>
        Promise.resolve(
          createRow({
            sshOverrides: JSON.stringify({ user: 'argocd', port: 2222 }),
            probeResult: JSON.stringify({
              ok: true,
              probedAt: '2026-01-01T00:00:00Z',
              exitCode: 0,
              errorTail: null,
              cpus: 64
            }),
            detailsUpdatedAt: new Date(1710000000200),
            detailsUpdatedBy: 'user'
          })
        )
    })
    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    const host = await repository.get('ssh:biowulf')
    expect(host?.sshOverrides).toEqual({ user: 'argocd', port: 2222 })
    expect(host?.probeResult?.cpus).toBe(64)
    expect(host?.detailsUpdatedAt).toBe(1710000000200)
    expect(host?.detailsUpdatedBy).toBe('user')
  })

  it('returns null when a host is not found', async () => {
    const { client, computeHost } = createMockClient({
      findUnique: () => Promise.resolve(null)
    })
    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    await expect(repository.get('ssh:missing')).resolves.toBeNull()
    expect(computeHost.findUnique).toHaveBeenCalledWith({ where: { providerId: 'ssh:missing' } })
  })

  it('creates a host: derives provider_id, defaults display name to alias, seeds details as user', async () => {
    const { client, computeHost } = createMockClient({
      // No existing host with this providerId → create proceeds.
      findUnique: () => Promise.resolve(null),
      create: () => Promise.resolve(createRow({ displayName: 'biowulf' }))
    })
    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    await repository.create({ sshAlias: '  biowulf  ', detailsDoc: 'runs slurm' })

    const call = computeHost.create.mock.calls[0]![0] as { data: Record<string, unknown> }
    expect(call.data.providerId).toBe('ssh:biowulf')
    expect(call.data.sshAlias).toBe('biowulf')
    expect(call.data.displayName).toBe('biowulf')
    expect(call.data.detailsDoc).toBe('runs slurm')
    expect(call.data.detailsUpdatedBy).toBe('user')
    expect(call.data.detailsUpdatedAt).toBeInstanceOf(Date)
  })

  it('uses the provided display name when given', async () => {
    const { client, computeHost } = createMockClient({
      findUnique: () => Promise.resolve(null),
      create: () => Promise.resolve(createRow())
    })
    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    await repository.create({ sshAlias: 'biowulf', displayName: 'NIH Biowulf' })

    const call = computeHost.create.mock.calls[0]![0] as { data: Record<string, unknown> }
    expect(call.data.displayName).toBe('NIH Biowulf')
  })

  it('serializes ssh overrides to JSON and omits empty overrides', async () => {
    const { client, computeHost } = createMockClient({
      findUnique: () => Promise.resolve(null),
      create: () => Promise.resolve(createRow())
    })
    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    await repository.create({
      sshAlias: 'lab-gpu',
      sshOverrides: { user: 'argocd', port: 22, identityFile: '~/.ssh/id_ed25519' }
    })

    const call = computeHost.create.mock.calls[0]![0] as { data: Record<string, unknown> }
    expect(JSON.parse(call.data.sshOverrides as string)).toEqual({
      user: 'argocd',
      port: 22,
      identityFile: '~/.ssh/id_ed25519'
    })

    // An empty overrides object stores null (not "{}").
    computeHost.create.mockClear()
    await repository.create({ sshAlias: 'plain', sshOverrides: {} })
    const call2 = computeHost.create.mock.calls[0]![0] as { data: Record<string, unknown> }
    expect(call2.data.sshOverrides).toBeNull()
  })

  it('rejects a blank alias without touching the database', async () => {
    const { client, computeHost } = createMockClient({})
    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    await expect(repository.create({ sshAlias: '   ' })).rejects.toThrow(/alias/i)
    expect(computeHost.create).not.toHaveBeenCalled()
  })

  it('rejects a duplicate alias with a readable error before inserting', async () => {
    const { client, computeHost } = createMockClient({
      findUnique: () => Promise.resolve(createRow()),
      create: () => Promise.resolve(createRow())
    })
    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    await expect(repository.create({ sshAlias: 'biowulf' })).rejects.toThrow(
      /already (registered|exists)/i
    )
    expect(computeHost.create).not.toHaveBeenCalled()
  })

  it('rejects a details doc over the 32768-char limit', async () => {
    const { client, computeHost } = createMockClient({
      findUnique: () => Promise.resolve(null)
    })
    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    await expect(
      repository.create({ sshAlias: 'big', detailsDoc: 'x'.repeat(32769) })
    ).rejects.toThrow(/32768/)
    expect(computeHost.create).not.toHaveBeenCalled()
  })

  it('deletes a host by provider id', async () => {
    const { client, computeHost } = createMockClient({
      delete: () => Promise.resolve(createRow())
    })
    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    await repository.delete('ssh:biowulf')

    expect(computeHost.delete).toHaveBeenCalledWith({ where: { providerId: 'ssh:biowulf' } })
  })
})
