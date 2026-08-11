import { describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import { EnabledComputeHostsRegistry } from './enabled-hosts-registry'
import { SessionEnabledComputeHostsOwner } from './session-enabled-hosts-owner'

const createSession = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  filesRevision: 1,
  createdAt: 1,
  updatedAt: 2,
  ...overrides
})

const passthroughDataRootWrite = <Result>(operation: () => Promise<Result>): Promise<Result> =>
  operation()
const createPruneResult = (
  sessions: PersistedChatSession[] = []
): { sessions: PersistedChatSession[]; previousSelections: [] } => ({
  sessions,
  previousSelections: []
})
type PruneResult = ReturnType<typeof createPruneResult>

describe('SessionEnabledComputeHostsOwner', () => {
  it('projects only the enabled hosts committed by Session authority', async () => {
    const registry = new EnabledComputeHostsRegistry()
    registry.set('session-1', ['ssh:old'])
    const durable = createSession({ enabledComputeHosts: ['ssh:new'], updatedAt: 3 })
    const setSessionEnabledComputeHosts = vi.fn(async () => {
      expect(registry.get('session-1')).toEqual(['ssh:old'])
      return durable
    })
    const owner = new SessionEnabledComputeHostsOwner({
      registry,
      hostExists: async (providerId) => providerId === 'ssh:new',
      listHostIds: async () => ['ssh:new'],
      sessionAuthority: {
        sessionProjectId: async () => 'project-1',
        setSessionEnabledComputeHosts,
        pruneSessionEnabledComputeHosts: async () => createPruneResult()
      },
      withDataRootWrite: passthroughDataRootWrite
    })

    await expect(owner.set('session-1', ['ssh:new'])).resolves.toEqual(durable)

    expect(setSessionEnabledComputeHosts).toHaveBeenCalledWith('project-1', 'session-1', [
      'ssh:new'
    ])
    expect(owner.get('session-1')).toEqual(['ssh:new'])
  })

  it('runs durable mutations inside the data-root write boundary', async () => {
    let insideWriteBoundary = false
    let writeBoundaryCalls = 0
    const withDataRootWrite = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
      writeBoundaryCalls += 1
      insideWriteBoundary = true
      try {
        return await operation()
      } finally {
        insideWriteBoundary = false
      }
    }
    const durable = createSession({ enabledComputeHosts: ['ssh:cluster'], updatedAt: 3 })
    const setSessionEnabledComputeHosts = vi.fn(async () => {
      expect(insideWriteBoundary).toBe(true)
      return durable
    })
    const pruneSessionEnabledComputeHosts = vi.fn(async () => {
      expect(insideWriteBoundary).toBe(true)
      return createPruneResult([durable])
    })
    const owner = new SessionEnabledComputeHostsOwner({
      registry: new EnabledComputeHostsRegistry(),
      hostExists: async () => true,
      listHostIds: async () => ['ssh:cluster'],
      sessionAuthority: {
        sessionProjectId: async () => 'project-1',
        setSessionEnabledComputeHosts,
        pruneSessionEnabledComputeHosts
      },
      withDataRootWrite
    })

    await owner.set('session-1', ['ssh:cluster'])
    await owner.pruneProvider('ssh:deleted')

    expect(writeBoundaryCalls).toBe(2)
  })

  it('projects a committed first Session save without accepting another intent', () => {
    const registry = new EnabledComputeHostsRegistry()
    const owner = new SessionEnabledComputeHostsOwner({
      registry,
      hostExists: async () => true,
      listHostIds: async () => [],
      sessionAuthority: {
        sessionProjectId: async () => undefined,
        setSessionEnabledComputeHosts: async () => {
          throw new Error('not expected')
        },
        pruneSessionEnabledComputeHosts: async () => createPruneResult()
      },
      withDataRootWrite: passthroughDataRootWrite
    })

    owner.project(createSession({ enabledComputeHosts: ['ssh:cluster'] }))

    expect(owner.get('session-1')).toEqual(['ssh:cluster'])
  })

  it('validates and projects a first Session creation through the owner', async () => {
    const registry = new EnabledComputeHostsRegistry()
    const owner = new SessionEnabledComputeHostsOwner({
      registry,
      hostExists: async (providerId) => providerId === 'ssh:cluster',
      listHostIds: async () => ['ssh:cluster'],
      sessionAuthority: {
        sessionProjectId: async () => undefined,
        setSessionEnabledComputeHosts: async () => {
          throw new Error('not expected')
        },
        pruneSessionEnabledComputeHosts: async () => createPruneResult()
      },
      withDataRootWrite: passthroughDataRootWrite
    })
    const durable = createSession({ enabledComputeHosts: ['ssh:cluster'], updatedAt: 3 })
    const commit = vi.fn(async () => durable)

    await expect(
      owner.createSession(
        createSession({ enabledComputeHosts: ['ssh:cluster', 'ssh:cluster'] }),
        commit
      )
    ).resolves.toEqual(durable)
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ enabledComputeHosts: ['ssh:cluster'] })
    )
    expect(owner.get('session-1')).toEqual(['ssh:cluster'])

    await expect(
      owner.createSession(createSession({ enabledComputeHosts: ['ssh:missing'] }), commit)
    ).rejects.toThrow('Compute Host not found')
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('replaces the derived cache from a complete Session catalog', async () => {
    const registry = new EnabledComputeHostsRegistry()
    registry.set('stale-session', ['ssh:old'])
    const owner = new SessionEnabledComputeHostsOwner({
      registry,
      hostExists: async () => true,
      listHostIds: async () => ['ssh:cluster'],
      sessionAuthority: {
        sessionProjectId: async () => undefined,
        setSessionEnabledComputeHosts: async () => {
          throw new Error('not expected')
        },
        pruneSessionEnabledComputeHosts: async () => createPruneResult()
      },
      withDataRootWrite: passthroughDataRootWrite
    })

    await owner.reconcile([createSession({ enabledComputeHosts: ['ssh:cluster'] })], true)

    expect(owner.get('session-1')).toEqual(['ssh:cluster'])
    expect(owner.get('stale-session')).toEqual([])
  })

  it('durably prunes missing hosts before replacing a complete cache', async () => {
    const registry = new EnabledComputeHostsRegistry()
    registry.set('stale-session', ['ssh:old'])
    const repaired = createSession({ enabledComputeHosts: ['ssh:cluster'], updatedAt: 3 })
    const pruneSessionEnabledComputeHosts = vi.fn(async () => createPruneResult([repaired]))
    const owner = new SessionEnabledComputeHostsOwner({
      registry,
      hostExists: async () => true,
      listHostIds: async () => ['ssh:cluster'],
      sessionAuthority: {
        sessionProjectId: async () => undefined,
        setSessionEnabledComputeHosts: async () => {
          throw new Error('not expected')
        },
        pruneSessionEnabledComputeHosts
      },
      withDataRootWrite: passthroughDataRootWrite
    })

    await expect(
      owner.reconcile(
        [createSession({ enabledComputeHosts: ['ssh:cluster', 'ssh:deleted'] })],
        true
      )
    ).resolves.toEqual([repaired])

    expect(pruneSessionEnabledComputeHosts).toHaveBeenCalledWith(['ssh:cluster'])
    expect(owner.get('session-1')).toEqual(['ssh:cluster'])
    expect(owner.get('stale-session')).toEqual([])
  })

  it('filters a partial cache without pruning unseen durable Sessions', async () => {
    const registry = new EnabledComputeHostsRegistry()
    registry.set('unseen-session', ['ssh:cluster'])
    const pruneSessionEnabledComputeHosts = vi.fn(async () => createPruneResult())
    const owner = new SessionEnabledComputeHostsOwner({
      registry,
      hostExists: async () => true,
      listHostIds: async () => ['ssh:cluster'],
      sessionAuthority: {
        sessionProjectId: async () => undefined,
        setSessionEnabledComputeHosts: async () => {
          throw new Error('not expected')
        },
        pruneSessionEnabledComputeHosts
      },
      withDataRootWrite: passthroughDataRootWrite
    })

    const sessions = [createSession({ enabledComputeHosts: ['ssh:cluster', 'ssh:deleted'] })]
    await expect(owner.reconcile(sessions, false)).resolves.toEqual(sessions)

    expect(pruneSessionEnabledComputeHosts).not.toHaveBeenCalled()
    expect(owner.get('session-1')).toEqual(['ssh:cluster'])
    expect(owner.get('unseen-session')).toEqual(['ssh:cluster'])
  })

  it('clears deleted Sessions from the cache', async () => {
    const registry = new EnabledComputeHostsRegistry()
    registry.set('session-1', ['ssh:cluster'])
    const owner = new SessionEnabledComputeHostsOwner({
      registry,
      hostExists: async () => true,
      listHostIds: async () => ['ssh:cluster'],
      sessionAuthority: {
        sessionProjectId: async () => undefined,
        setSessionEnabledComputeHosts: async () => {
          throw new Error('not expected')
        },
        pruneSessionEnabledComputeHosts: async () => createPruneResult()
      },
      withDataRootWrite: passthroughDataRootWrite
    })

    await owner.clear(['session-1'])

    expect(owner.get('session-1')).toEqual([])
  })

  it('serializes Session deletion cache clears after in-flight reconciliation', async () => {
    const registry = new EnabledComputeHostsRegistry()
    registry.set('session-1', ['ssh:cluster'])
    let finishHostList: ((providerIds: readonly string[]) => void) | undefined
    const listHostIds = vi.fn(
      () =>
        new Promise<readonly string[]>((resolve) => {
          finishHostList = resolve
        })
    )
    const owner = new SessionEnabledComputeHostsOwner({
      registry,
      hostExists: async () => true,
      listHostIds,
      sessionAuthority: {
        sessionProjectId: async () => undefined,
        setSessionEnabledComputeHosts: async () => {
          throw new Error('not expected')
        },
        pruneSessionEnabledComputeHosts: async () => createPruneResult()
      },
      withDataRootWrite: passthroughDataRootWrite
    })

    const reconciling = owner.reconcile(
      [createSession({ enabledComputeHosts: ['ssh:cluster'] })],
      true
    )
    await vi.waitFor(() => expect(listHostIds).toHaveBeenCalledOnce())
    const clearing = owner.clear(['session-1'])
    finishHostList?.(['ssh:cluster'])

    await Promise.all([reconciling, clearing])

    expect(owner.get('session-1')).toEqual([])
  })

  it('removes a deleted or reusable provider only after repairing durable Sessions', async () => {
    const registry = new EnabledComputeHostsRegistry()
    registry.set('session-1', ['ssh:deleted', 'ssh:kept'])
    let finishPrune: ((result: PruneResult) => void) | undefined
    const pruneSessionEnabledComputeHosts = vi.fn(
      () =>
        new Promise<PruneResult>((resolve) => {
          finishPrune = resolve
        })
    )
    const owner = new SessionEnabledComputeHostsOwner({
      registry,
      hostExists: async () => true,
      listHostIds: async () => ['ssh:deleted', 'ssh:kept'],
      sessionAuthority: {
        sessionProjectId: async () => undefined,
        setSessionEnabledComputeHosts: async () => {
          throw new Error('not expected')
        },
        pruneSessionEnabledComputeHosts
      },
      withDataRootWrite: passthroughDataRootWrite
    })

    const pruning = owner.pruneProvider('ssh:deleted')
    expect(owner.get('session-1')).toEqual(['ssh:deleted', 'ssh:kept'])
    await vi.waitFor(() =>
      expect(pruneSessionEnabledComputeHosts).toHaveBeenCalledWith(['ssh:kept'])
    )

    const repaired = createSession({ enabledComputeHosts: ['ssh:kept'] })
    finishPrune?.(createPruneResult([repaired]))
    await expect(pruning).resolves.toEqual([repaired])
    expect(owner.get('session-1')).toEqual(['ssh:kept'])
  })

  it('keeps the cache unchanged when durable provider pruning fails', async () => {
    const registry = new EnabledComputeHostsRegistry()
    registry.set('session-1', ['ssh:deleted', 'ssh:kept'])
    const owner = new SessionEnabledComputeHostsOwner({
      registry,
      hostExists: async () => true,
      listHostIds: async () => ['ssh:deleted', 'ssh:kept'],
      sessionAuthority: {
        sessionProjectId: async () => undefined,
        setSessionEnabledComputeHosts: async () => {
          throw new Error('not expected')
        },
        pruneSessionEnabledComputeHosts: async () => {
          throw new Error('Session prune failed')
        }
      },
      withDataRootWrite: passthroughDataRootWrite
    })

    await expect(owner.pruneProvider('ssh:deleted')).rejects.toThrow('Session prune failed')

    expect(owner.get('session-1')).toEqual(['ssh:deleted', 'ssh:kept'])
  })

  it('returns loaded Sessions without changing the cache when the Host catalog is unavailable', async () => {
    const registry = new EnabledComputeHostsRegistry()
    registry.set('cached-session', ['ssh:cached'])
    const sessions = [createSession({ enabledComputeHosts: ['ssh:cluster'] })]
    const owner = new SessionEnabledComputeHostsOwner({
      registry,
      hostExists: async () => true,
      listHostIds: async () => {
        throw new Error('Compute database unavailable')
      },
      sessionAuthority: {
        sessionProjectId: async () => undefined,
        setSessionEnabledComputeHosts: async () => {
          throw new Error('not expected')
        },
        pruneSessionEnabledComputeHosts: async () => {
          throw new Error('not expected')
        }
      },
      withDataRootWrite: passthroughDataRootWrite
    })

    await expect(owner.reconcile(sessions, true)).resolves.toEqual(sessions)

    expect(owner.get('cached-session')).toEqual(['ssh:cached'])
    expect(owner.get('session-1')).toEqual([])
  })

  it('holds the owner queue through provider deletion before validating a queued enable', async () => {
    let hostExists = true
    let finishPrune: ((result: PruneResult) => void) | undefined
    const pruneSessionEnabledComputeHosts = vi.fn(
      () =>
        new Promise<PruneResult>((resolve) => {
          finishPrune = resolve
        })
    )
    const setSessionEnabledComputeHosts = vi.fn(async () => createSession())
    const deleteProvider = vi.fn(async () => {
      hostExists = false
    })
    const owner = new SessionEnabledComputeHostsOwner({
      registry: new EnabledComputeHostsRegistry(),
      hostExists: async () => hostExists,
      listHostIds: async () => (hostExists ? ['ssh:cluster'] : []),
      sessionAuthority: {
        sessionProjectId: async () => 'project-1',
        setSessionEnabledComputeHosts,
        pruneSessionEnabledComputeHosts
      },
      withDataRootWrite: async (operation) => operation()
    })

    const deleting = owner.pruneProvider('ssh:cluster', deleteProvider)
    await vi.waitFor(() => expect(pruneSessionEnabledComputeHosts).toHaveBeenCalledOnce())
    const enabling = owner.set('session-1', ['ssh:cluster'])
    finishPrune?.(createPruneResult())

    await expect(deleting).resolves.toEqual([])
    await expect(enabling).rejects.toThrow('Compute Host not found')
    expect(deleteProvider).toHaveBeenCalledOnce()
    expect(setSessionEnabledComputeHosts).not.toHaveBeenCalled()
  })

  it('restores durable selections and the cache when provider deletion fails', async () => {
    const registry = new EnabledComputeHostsRegistry()
    registry.set('session-1', ['ssh:cluster', 'ssh:kept'])
    const repaired = createSession({ enabledComputeHosts: ['ssh:kept'], updatedAt: 3 })
    const restored = createSession({
      enabledComputeHosts: ['ssh:cluster', 'ssh:kept'],
      updatedAt: 4
    })
    const setSessionEnabledComputeHosts = vi.fn(async () => restored)
    const owner = new SessionEnabledComputeHostsOwner({
      registry,
      hostExists: async () => true,
      listHostIds: async () => ['ssh:cluster', 'ssh:kept'],
      sessionAuthority: {
        sessionProjectId: async () => 'project-1',
        setSessionEnabledComputeHosts,
        pruneSessionEnabledComputeHosts: async () => ({
          sessions: [repaired],
          previousSelections: [
            {
              projectId: 'project-1',
              sessionId: 'session-1',
              providerIds: ['ssh:cluster', 'ssh:kept']
            }
          ]
        })
      },
      withDataRootWrite: passthroughDataRootWrite
    })

    await expect(
      owner.pruneProvider('ssh:cluster', async () => {
        throw new Error('Host delete failed')
      })
    ).rejects.toThrow('Host delete failed')

    expect(setSessionEnabledComputeHosts).toHaveBeenCalledWith('project-1', 'session-1', [
      'ssh:cluster',
      'ssh:kept'
    ])
    expect(owner.get('session-1')).toEqual(['ssh:cluster', 'ssh:kept'])
  })
})
