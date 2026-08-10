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
        pruneSessionEnabledComputeHosts: async () => []
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
      return [durable]
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
        pruneSessionEnabledComputeHosts: async () => []
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
        pruneSessionEnabledComputeHosts: async () => []
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
        pruneSessionEnabledComputeHosts: async () => []
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
    const pruneSessionEnabledComputeHosts = vi.fn(async () => [repaired])
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
    const pruneSessionEnabledComputeHosts = vi.fn(async () => [])
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

  it('clears deleted Sessions from the cache', () => {
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
        pruneSessionEnabledComputeHosts: async () => []
      },
      withDataRootWrite: passthroughDataRootWrite
    })

    owner.clear(['session-1'])

    expect(owner.get('session-1')).toEqual([])
  })

  it('removes a deleted or reusable provider before repairing durable Sessions', async () => {
    const registry = new EnabledComputeHostsRegistry()
    registry.set('session-1', ['ssh:deleted', 'ssh:kept'])
    let finishPrune: ((sessions: PersistedChatSession[]) => void) | undefined
    const pruneSessionEnabledComputeHosts = vi.fn(
      () =>
        new Promise<PersistedChatSession[]>((resolve) => {
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
    expect(owner.get('session-1')).toEqual(['ssh:kept'])
    await vi.waitFor(() =>
      expect(pruneSessionEnabledComputeHosts).toHaveBeenCalledWith(['ssh:kept'])
    )

    const repaired = createSession({ enabledComputeHosts: ['ssh:kept'] })
    finishPrune?.([repaired])
    await expect(pruning).resolves.toEqual([repaired])
    expect(owner.get('session-1')).toEqual(['ssh:kept'])
  })

  it('holds the owner queue through provider deletion before validating a queued enable', async () => {
    let hostExists = true
    let finishPrune: ((sessions: PersistedChatSession[]) => void) | undefined
    const pruneSessionEnabledComputeHosts = vi.fn(
      () =>
        new Promise<PersistedChatSession[]>((resolve) => {
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
    finishPrune?.([])

    await expect(deleting).resolves.toEqual([])
    await expect(enabling).rejects.toThrow('Compute Host not found')
    expect(deleteProvider).toHaveBeenCalledOnce()
    expect(setSessionEnabledComputeHosts).not.toHaveBeenCalled()
  })
})
