import { describe, expect, it, vi } from 'vitest'

import { ComputeHostRepository, type ComputeHostClient } from './repository'

const createRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'host-1',
  providerId: 'ssh:biowulf',
  displayName: 'biowulf',
  shape: 'direct_ssh',
  sshAlias: 'biowulf',
  sshOverrides: null,
  authenticationMode: 'ssh_config',
  authenticationRevision: 1,
  lastVerifiedAt: null,
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
  methods: Partial<Record<'findMany' | 'findUnique' | 'create' | 'update' | 'delete', unknown>>
): { client: ComputeHostClient; computeHost: Record<string, ReturnType<typeof vi.fn>> } => {
  const computeHost = {
    findMany: vi.fn(methods.findMany as never),
    findUnique: vi.fn(methods.findUnique as never),
    create: vi.fn(methods.create as never),
    update: vi.fn(methods.update as never),
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
        authentication: {
          mode: 'ssh_config',
          credentialStatus: 'missing',
          revision: 1,
          lastVerifiedAt: undefined
        },
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

  it('decodes current Compute JSON without exposing its persistence version', async () => {
    const { client } = createMockClient({
      findUnique: () =>
        Promise.resolve(
          createRow({
            sshOverrides: JSON.stringify({ schemaVersion: 1, user: 'argocd', port: 2222 }),
            probeResult: JSON.stringify({
              schemaVersion: 1,
              ok: true,
              probedAt: '2026-01-01T00:00:00Z',
              exitCode: 0,
              errorTail: null,
              cpus: 64
            })
          })
        )
    })
    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    await expect(repository.get('ssh:biowulf')).resolves.toMatchObject({
      sshOverrides: { user: 'argocd', port: 2222 },
      probeResult: { ok: true, cpus: 64 }
    })
  })

  it.each([
    [
      'future-version JSON',
      { sshOverrides: JSON.stringify({ schemaVersion: 2, user: 'future-user' }) }
    ],
    ['corrupt JSON', { sshOverrides: JSON.stringify({ schemaVersion: 1, port: 'not-a-number' }) }],
    ['an unsupported Host shape', { shape: 'future-cluster-shape' }],
    ['an unsupported details author', { detailsUpdatedBy: 'future-author' }]
  ])('fails the Host catalog for %s instead of treating it as missing', async (_label, row) => {
    const { client } = createMockClient({
      findMany: () => Promise.resolve([createRow(row)])
    })
    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    await expect(repository.list()).rejects.toThrow('Compute Host data is corrupt or unsupported')
  })

  it('fails the Host catalog when one row uses an unsupported authentication mode', async () => {
    const { client } = createMockClient({
      findMany: () =>
        Promise.resolve([
          createRow({ authenticationMode: 'future-authentication-mode' }),
          createRow({ id: 'healthy', providerId: 'ssh:healthy', sshAlias: 'healthy' })
        ])
    })
    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    await expect(repository.list()).rejects.toThrow(
      'This SSH authentication configuration is not supported.'
    )
  })

  it('returns null when a host is not found', async () => {
    const { client, computeHost } = createMockClient({
      findUnique: () => Promise.resolve(null)
    })
    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    await expect(repository.get('ssh:missing')).resolves.toBeNull()
    expect(computeHost.findUnique).toHaveBeenCalledWith({ where: { providerId: 'ssh:missing' } })
  })

  it('keeps historical aliases and scratch roots readable without rewriting them', async () => {
    const { client } = createMockClient({
      findUnique: () =>
        Promise.resolve(
          createRow({
            providerId: 'ssh:-legacy-option',
            sshAlias: '-legacy-option',
            scratchRoot: 'relative/legacy-scratch',
            scratchPinned: true
          })
        )
    })
    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    await expect(repository.get('ssh:-legacy-option')).resolves.toMatchObject({
      sshAlias: '-legacy-option',
      scratchRoot: 'relative/legacy-scratch',
      scratchPinned: true
    })
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
      schemaVersion: 1,
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

  it.each([-1, 1.5, 65_536])('rejects invalid SSH port %s before persistence', async (port) => {
    const { client, computeHost } = createMockClient({
      findUnique: () => Promise.resolve(null),
      create: () => Promise.resolve(createRow())
    })
    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    await expect(
      repository.create({ sshAlias: 'cluster', sshOverrides: { port } })
    ).rejects.toThrow(/port/i)
    expect(computeHost.create).not.toHaveBeenCalled()
  })

  it.each([
    ['alias', { sshAlias: 'cluster\nother' }],
    ['display name', { sshAlias: 'cluster', displayName: 'Cluster\0hidden' }],
    ['user', { sshAlias: 'cluster', sshOverrides: { user: 'researcher\rroot' } }],
    ['identity file', { sshAlias: 'cluster', sshOverrides: { identityFile: 'x'.repeat(256) } }]
  ])('rejects an invalid %s before persistence', async (_label, request) => {
    const { client, computeHost } = createMockClient({
      findUnique: () => Promise.resolve(null),
      create: () => Promise.resolve(createRow())
    })
    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    await expect(repository.create(request)).rejects.toThrow(/1.+255|control|characters/i)
    expect(computeHost.create).not.toHaveBeenCalled()
  })

  it('rejects a blank alias without touching the database', async () => {
    const { client, computeHost } = createMockClient({})
    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    await expect(repository.create({ sshAlias: '   ' })).rejects.toThrow(/alias/i)
    expect(computeHost.create).not.toHaveBeenCalled()
  })

  it('rejects an option-like alias without touching the database', async () => {
    const { client, computeHost } = createMockClient({})
    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    await expect(
      repository.create({ sshAlias: '-oProxyCommand=touch /tmp/not-approved' })
    ).rejects.toThrow(/alias/i)
    expect(computeHost.findUnique).not.toHaveBeenCalled()
    expect(computeHost.create).not.toHaveBeenCalled()
  })

  it.each(['relative/path', '/scratch/../other', '/scratch\nother'])(
    'rejects an invalid discovered scratch root before writing: %j',
    async (scratchRoot) => {
      const { client, computeHost } = createMockClient({})
      const repository = new ComputeHostRepository(() => Promise.resolve(client))

      await expect(repository.updateScratchRoot('ssh:biowulf', scratchRoot)).rejects.toThrow(
        /scratch root/i
      )
      expect(computeHost.update).not.toHaveBeenCalled()
    }
  )

  it('rejects an invalid pinned scratch root before writing', async () => {
    const { client, computeHost } = createMockClient({})
    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    await expect(repository.updateScratchPinned('ssh:biowulf', '~/scratch//other')).rejects.toThrow(
      /scratch root/i
    )
    expect(computeHost.update).not.toHaveBeenCalled()
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

  it('rejects a duplicate password-host alias during creation preparation', async () => {
    const client = {
      computeAuthOperation: { findUnique: vi.fn(async () => null) },
      computeHost: { findUnique: vi.fn(async () => createRow()) }
    } as unknown as ComputeHostClient
    const repository = new ComputeHostRepository(async () => client)

    await expect(
      repository.preparePasswordCreate({
        operationId: 'create-password-operation',
        requestFingerprint: 'test-protected-fingerprint',
        sshAlias: 'biowulf'
      })
    ).rejects.toThrow(/already (registered|exists)/i)
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

  it('clears the scratch root and unpins it in one persistence update', async () => {
    const update = vi.fn(async () => createRow({ scratchRoot: null, scratchPinned: false }))
    const client = { computeHost: { update } } as unknown as ComputeHostClient
    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    await repository.clearScratchRoot('ssh:biowulf')

    expect(update).toHaveBeenCalledWith({
      where: { providerId: 'ssh:biowulf' },
      data: { scratchRoot: null, scratchPinned: false }
    })
  })

  it('deletes a host by provider id', async () => {
    const computeHost = {
      findUnique: vi.fn(async () => createRow()),
      delete: vi.fn(async () => createRow())
    }
    const computeCredential = { deleteMany: vi.fn(async () => ({ count: 1 })) }
    const computeAuthOperation = { deleteMany: vi.fn(async () => ({ count: 1 })) }
    const $executeRawUnsafe = vi.fn(async () => 1)
    const transaction = { computeHost, computeCredential, computeAuthOperation, $executeRawUnsafe }
    const client = {
      computeHost,
      computeCredential,
      computeAuthOperation,
      $transaction: vi.fn(async (operation: (tx: typeof transaction) => unknown) =>
        operation(transaction)
      )
    } as unknown as ComputeHostClient
    const repository = new ComputeHostRepository(() => Promise.resolve(client))

    await repository.delete('ssh:biowulf')

    expect(computeCredential.deleteMany).toHaveBeenCalledWith({
      where: { computeHostId: 'host-1' }
    })
    expect(computeAuthOperation.deleteMany).toHaveBeenCalledWith({
      where: { providerId: 'ssh:biowulf' }
    })
    expect($executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM "PermissionGrant"'),
      'execution',
      'exec:compute/ssh:biowulf/%'
    )
    expect($executeRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(
      computeHost.delete.mock.invocationCallOrder[0]
    )
    expect(computeHost.delete).toHaveBeenCalledWith({ where: { providerId: 'ssh:biowulf' } })
  })

  it('rejects an operation id from password-host creation instead of replaying a reset', async () => {
    const client = {
      computeAuthOperation: {
        findUnique: vi.fn(async () => ({
          id: 'create-operation',
          providerId: 'ssh:biowulf',
          resultRevision: 1
        }))
      },
      computeHost: {
        findUnique: vi.fn(async () =>
          createRow({ authenticationMode: 'password', authenticationRevision: 1 })
        )
      }
    } as unknown as ComputeHostClient
    const repository = new ComputeHostRepository(async () => client)

    await expect(
      repository.preparePasswordReset({
        providerId: 'ssh:biowulf',
        operationId: 'create-operation',
        requestFingerprint: 'test-protected-fingerprint',
        expectedAuthenticationRevision: 1
      })
    ).rejects.toMatchObject({ code: 'credential_conflict' })
  })

  it('rejects replay when a later rotation has superseded the operation result', async () => {
    const client = {
      computeAuthOperation: {
        findUnique: vi.fn(async () => ({
          id: 'old-reset',
          providerId: 'ssh:biowulf',
          resultRevision: 2
        }))
      },
      computeHost: {
        findUnique: vi.fn(async () =>
          createRow({ authenticationMode: 'password', authenticationRevision: 3 })
        )
      }
    } as unknown as ComputeHostClient
    const repository = new ComputeHostRepository(async () => client)

    await expect(
      repository.preparePasswordReset({
        providerId: 'ssh:biowulf',
        operationId: 'old-reset',
        requestFingerprint: 'test-protected-fingerprint',
        expectedAuthenticationRevision: 1
      })
    ).rejects.toMatchObject({ code: 'credential_conflict' })
  })

  it('atomically upserts a missing Credential while advancing the reset revision', async () => {
    const current = createRow({
      authenticationMode: 'password',
      authenticationRevision: 1
    })
    const updated = createRow({
      authenticationMode: 'password',
      authenticationRevision: 2,
      lastVerifiedAt: new Date('2026-08-17T01:00:00.000Z'),
      probeResult: null
    })
    const upsert = vi.fn(async () => undefined)
    const transaction = {
      computeAuthOperation: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => undefined)
      },
      computeHost: {
        findUnique: vi.fn(async () => current),
        update: vi.fn(async () => updated)
      },
      computeCredential: { upsert }
    }
    const client = {
      $transaction: vi.fn(async (operation: (value: typeof transaction) => unknown) =>
        operation(transaction)
      )
    } as unknown as ComputeHostClient
    const repository = new ComputeHostRepository(async () => client)

    await expect(
      repository.resetPasswordHost({
        providerId: 'ssh:biowulf',
        operationId: 'reset-operation',
        requestFingerprint: 'test-protected-fingerprint',
        expectedAuthenticationRevision: 1,
        ciphertext: Buffer.from('replacement'),
        verifiedAt: new Date('2026-08-17T01:00:00.000Z')
      })
    ).resolves.toMatchObject({ authentication: { revision: 2 }, probeResult: undefined })
    expect(upsert).toHaveBeenCalledWith({
      where: { computeHostId: 'host-1' },
      create: {
        computeHostId: 'host-1',
        ciphertext: new Uint8Array(Buffer.from('replacement'))
      },
      update: { ciphertext: new Uint8Array(Buffer.from('replacement')) }
    })
    expect(transaction.computeAuthOperation.create).toHaveBeenCalledWith({
      data: {
        id: 'reset-operation',
        providerId: 'ssh:biowulf',
        operationKind: 'reset_password',
        requestFingerprint: 'test-protected-fingerprint',
        resultRevision: 2
      }
    })
  })

  it('rechecks pending remote cleanup inside the authentication-change transaction', async () => {
    const count = vi.fn(async () => 1)
    const transaction = {
      computeAuthOperation: { findUnique: vi.fn(async () => null) },
      computeHost: { findUnique: vi.fn(async () => createRow()) },
      computeJob: { count }
    }
    const client = {
      $transaction: vi.fn(async (operation: (value: typeof transaction) => unknown) =>
        operation(transaction)
      )
    } as unknown as ComputeHostClient
    const repository = new ComputeHostRepository(async () => client)

    await expect(
      repository.changeAuthentication({
        providerId: 'ssh:biowulf',
        expectedRevision: 1,
        operationId: 'change-operation',
        requestFingerprint: 'test-protected-fingerprint',
        authenticationMode: 'ssh_config',
        username: 'researcher',
        port: 22,
        verifiedAt: new Date('2026-08-17T01:00:00.000Z')
      })
    ).rejects.toMatchObject({ code: 'credential_change_blocked_by_jobs' })
    expect(count).toHaveBeenCalledWith({
      where: {
        providerId: 'ssh:biowulf',
        OR: expect.arrayContaining([{ remoteCleanupDisposition: 'pending' }])
      }
    })
  })

  it('does not record a reset operation when the credential transaction fails', async () => {
    const current = createRow({
      authenticationMode: 'password',
      authenticationRevision: 1
    })
    const createOperation = vi.fn()
    const transaction = {
      computeAuthOperation: {
        findUnique: vi.fn(async () => null),
        create: createOperation
      },
      computeHost: {
        findUnique: vi.fn(async () => current),
        update: vi.fn(async () => {
          throw new Error('transaction rolled back')
        })
      },
      computeCredential: { upsert: vi.fn(async () => undefined) }
    }
    const client = {
      $transaction: vi.fn(async (operation: (value: typeof transaction) => unknown) =>
        operation(transaction)
      )
    } as unknown as ComputeHostClient
    const repository = new ComputeHostRepository(async () => client)

    await expect(
      repository.resetPasswordHost({
        providerId: 'ssh:biowulf',
        operationId: 'failed-reset',
        requestFingerprint: 'test-protected-fingerprint',
        expectedAuthenticationRevision: 1,
        ciphertext: Buffer.from('candidate'),
        verifiedAt: new Date('2026-08-17T01:00:00.000Z')
      })
    ).rejects.toThrow('transaction rolled back')
    expect(createOperation).not.toHaveBeenCalled()
  })

  it('persists an authentication failure only while its authentication revision is current', async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }))
    const repository = new ComputeHostRepository(
      async () => ({ computeHost: { updateMany } }) as unknown as ComputeHostClient
    )
    const failure = {
      ok: false as const,
      probedAt: '2026-08-17T01:00:00.000Z',
      exitCode: null,
      errorTail: 'Authentication failed. Verify the username and password.',
      authenticationCode: 'authentication_failed' as const,
      authenticationRevision: 1
    }

    await expect(
      repository.updateAuthenticationFailure('ssh:biowulf', 1, failure, 'direct_ssh')
    ).resolves.toBe(false)
    expect(updateMany).toHaveBeenCalledWith({
      where: { providerId: 'ssh:biowulf', authenticationRevision: 1 },
      data: {
        probeResult: JSON.stringify({ schemaVersion: 1, ...failure }),
        shape: 'direct_ssh'
      }
    })
  })

  it('does not let a stale Probe overwrite a newer authentication identity', async () => {
    const update = vi.fn()
    const updateMany = vi.fn(async () => ({ count: 0 }))
    const repository = new ComputeHostRepository(
      async () => ({ computeHost: { update, updateMany } }) as unknown as ComputeHostClient
    )
    const staleProbe = {
      ok: true as const,
      probedAt: '2026-08-17T01:00:00.000Z',
      exitCode: 0,
      errorTail: null,
      os: 'Linux',
      authenticationRevision: 1
    }

    await expect(
      repository.updateProbeResult('ssh:biowulf', staleProbe, 'direct_ssh')
    ).resolves.toBeUndefined()
    expect(updateMany).toHaveBeenCalledWith({
      where: { providerId: 'ssh:biowulf', authenticationRevision: 1 },
      data: {
        probeResult: JSON.stringify({ schemaVersion: 1, ...staleProbe }),
        shape: 'direct_ssh'
      }
    })
    expect(update).not.toHaveBeenCalled()
  })

  it('removes orphan Credentials during startup recovery', async () => {
    const execute = vi.fn(async () => 2)
    const repository = new ComputeHostRepository(() =>
      Promise.resolve({ $executeRawUnsafe: execute } as unknown as ComputeHostClient)
    )

    await expect(repository.cleanupOrphanCredentials()).resolves.toBe(2)
    expect(execute).toHaveBeenCalledWith(
      expect.stringMatching(/DELETE FROM "ComputeCredential"[\s\S]*NOT EXISTS/)
    )
  })
})
