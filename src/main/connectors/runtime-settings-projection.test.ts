import { describe, expect, it, vi } from 'vitest'

import type { StoredConnectors } from '../settings/types'
import { ConnectorRuntimeSettingsProjection } from './runtime-settings-projection'

const connectors = (overrides: Partial<StoredConnectors> = {}): StoredConnectors => ({
  enabledIds: [],
  autoAllowIds: [],
  ...overrides
})

describe('ConnectorRuntimeSettingsProjection', () => {
  it('owns the current snapshot and synchronizes bundled and enabled custom Skill docs', async () => {
    const stored = connectors({
      disabledConnectorIds: ['chemistry'],
      customMcpServers: [
        {
          id: 'server-id',
          name: 'enabled',
          displayName: 'Enabled',
          transport: 'stdio',
          command: 'mcp',
          enabled: true
        },
        {
          id: 'disabled-id',
          name: 'disabled',
          displayName: 'Disabled',
          transport: 'stdio',
          command: 'mcp',
          enabled: false
        }
      ]
    })
    const listTools = vi.fn().mockResolvedValue([])
    const syncBundledSkillDocs = vi.fn().mockResolvedValue(undefined)
    const syncCustomSkillDocs = vi.fn(async (_dir, servers, loadTools) => {
      await loadTools(servers[0])
      return { materializedNames: ['enabled'], failures: [] }
    })
    const projection = new ConnectorRuntimeSettingsProjection({
      readConnectors: vi.fn().mockResolvedValue(stored),
      skillsDir: '/config/skills',
      mcpClientManager: { listTools },
      syncBundledSkillDocs,
      syncCustomSkillDocs
    })

    await projection.refresh()

    expect(projection.current()).toBe(stored)
    expect(syncBundledSkillDocs).toHaveBeenCalledWith(
      '/config/skills',
      expect.not.arrayContaining(['chemistry'])
    )
    expect(syncCustomSkillDocs).toHaveBeenCalledWith(
      '/config/skills',
      [stored.customMcpServers?.[0]],
      expect.any(Function)
    )
    expect(listTools).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'server-id', command: 'mcp', transport: 'stdio' })
    )
    expect(projection.materializedCustomSkillNames()).toEqual(['mcp-enabled'])
  })

  it('refreshes and reports checking for only the requested custom server', async () => {
    const target = {
      id: 'target-id',
      name: 'target',
      displayName: 'Target',
      transport: 'stdio' as const,
      command: 'mcp',
      enabled: true
    }
    const unrelated = {
      id: 'unrelated-id',
      name: 'unrelated',
      displayName: 'Unrelated',
      transport: 'stdio' as const,
      command: 'mcp',
      enabled: true
    }
    let finishTargetedSync: (() => void) | undefined
    const targetedSync = new Promise<{ materializedNames: string[]; failures: [] }>((resolve) => {
      finishTargetedSync = () => resolve({ materializedNames: ['target'], failures: [] })
    })
    const syncCustomSkillDocs = vi
      .fn()
      .mockResolvedValueOnce({ materializedNames: ['target', 'unrelated'], failures: [] })
      .mockReturnValueOnce(targetedSync)
    const projection = new ConnectorRuntimeSettingsProjection({
      readConnectors: vi.fn().mockResolvedValue(
        connectors({
          customMcpServers: [target, unrelated]
        })
      ),
      skillsDir: '/config/skills',
      mcpClientManager: { listTools: vi.fn().mockResolvedValue([]) },
      syncBundledSkillDocs: vi.fn().mockResolvedValue(undefined),
      syncCustomSkillDocs
    })

    await projection.refresh()
    const refresh = projection.refreshCustomServer(target.id)

    expect(projection.isRefreshing(target.id)).toBe(true)
    expect(projection.isRefreshing(unrelated.id)).toBe(false)
    await vi.waitFor(() =>
      expect(syncCustomSkillDocs).toHaveBeenLastCalledWith(
        '/config/skills',
        [target],
        expect.any(Function),
        ['target']
      )
    )

    finishTargetedSync?.()
    await refresh

    expect(projection.materializedCustomSkillNames()).toEqual(['mcp-target', 'mcp-unrelated'])
  })

  it('advertises only custom Skills that materialized when one enabled server is unavailable', async () => {
    const unavailable = {
      id: 'unavailable-id',
      name: 'unavailable',
      displayName: 'Unavailable',
      transport: 'stdio' as const,
      command: 'node',
      enabled: true
    }
    const healthy = {
      id: 'healthy-id',
      name: 'healthy',
      displayName: 'Healthy',
      transport: 'stdio' as const,
      command: 'node',
      enabled: true
    }
    const failure = new Error('MCP error -32000: Connection closed')
    const reportError = vi.fn()
    const projection = new ConnectorRuntimeSettingsProjection({
      readConnectors: vi.fn().mockResolvedValue(
        connectors({
          customMcpServers: [unavailable, healthy]
        })
      ),
      skillsDir: '/config/skills',
      mcpClientManager: { listTools: vi.fn().mockResolvedValue([]) },
      syncBundledSkillDocs: vi.fn().mockResolvedValue(undefined),
      syncCustomSkillDocs: vi.fn().mockResolvedValue({
        materializedNames: ['healthy'],
        failures: [{ server: unavailable, error: failure }]
      }),
      reportError
    })

    await projection.refresh()

    expect(projection.materializedCustomSkillNames()).toEqual(['mcp-healthy'])
    expect(projection.customServerAvailability('unavailable-id')).toBe('unavailable')
    expect(reportError).toHaveBeenCalledOnce()
    expect(reportError.mock.calls[0]?.[0]).toMatchObject({
      message: 'Failed to sync custom MCP server "unavailable" skill docs',
      cause: failure
    })
  })

  it('classifies authentication discovery failures without exposing transport details', async () => {
    const server = {
      id: 'oauth-id',
      name: 'oauth',
      displayName: 'OAuth',
      transport: 'streamable_http' as const,
      url: 'https://mcp.example.test',
      enabled: true
    }
    const projection = new ConnectorRuntimeSettingsProjection({
      readConnectors: vi.fn().mockResolvedValue(connectors({ customMcpServers: [server] })),
      skillsDir: '/config/skills',
      mcpClientManager: { listTools: vi.fn().mockResolvedValue([]) },
      syncBundledSkillDocs: vi.fn().mockResolvedValue(undefined),
      syncCustomSkillDocs: vi.fn().mockResolvedValue({
        materializedNames: [],
        failures: [{ server, error: new Error('401 invalid_token for a secret endpoint') }]
      }),
      reportError: vi.fn()
    })

    await projection.refresh()

    expect(projection.customServerAvailability(server.id)).toBe('unauthenticated')
  })

  it('clears a runtime failure after a successful retry refresh', async () => {
    const server = {
      id: 'recovering-id',
      name: 'recovering',
      displayName: 'Recovering',
      transport: 'stdio' as const,
      command: 'node',
      enabled: true
    }
    const syncCustomSkillDocs = vi
      .fn()
      .mockResolvedValueOnce({
        materializedNames: [],
        failures: [{ server, error: new Error('Connection closed') }]
      })
      .mockResolvedValueOnce({ materializedNames: ['recovering'], failures: [] })
    const projection = new ConnectorRuntimeSettingsProjection({
      readConnectors: vi.fn().mockResolvedValue(connectors({ customMcpServers: [server] })),
      skillsDir: '/config/skills',
      mcpClientManager: { listTools: vi.fn().mockResolvedValue([]) },
      syncBundledSkillDocs: vi.fn().mockResolvedValue(undefined),
      syncCustomSkillDocs,
      reportError: vi.fn()
    })

    await projection.refresh()
    expect(projection.customServerAvailability(server.id)).toBe('unavailable')

    await projection.refresh()
    expect(projection.customServerAvailability(server.id)).toBeUndefined()
    expect(projection.materializedCustomSkillNames()).toEqual(['mcp-recovering'])
  })

  it('publishes checking and settled states without blocking snapshot reads', async () => {
    let finishSync: (() => void) | undefined
    const sync = new Promise<{ materializedNames: string[]; failures: [] }>((resolve) => {
      finishSync = () => resolve({ materializedNames: ['checking'], failures: [] })
    })
    const notifyStatusChanged = vi.fn()
    const projection = new ConnectorRuntimeSettingsProjection({
      readConnectors: vi.fn().mockResolvedValue(connectors()),
      skillsDir: '/config/skills',
      mcpClientManager: { listTools: vi.fn().mockResolvedValue([]) },
      syncBundledSkillDocs: vi.fn().mockResolvedValue(undefined),
      syncCustomSkillDocs: vi.fn().mockReturnValue(sync),
      notifyStatusChanged
    })

    const refresh = projection.refresh()
    expect(projection.isRefreshing()).toBe(true)
    expect(notifyStatusChanged).toHaveBeenCalledOnce()

    finishSync?.()
    await refresh

    expect(projection.isRefreshing()).toBe(false)
    expect(notifyStatusChanged).toHaveBeenCalledTimes(2)
  })

  it('keeps discovery status when a newer dispatch failure is cleared', async () => {
    const server = {
      id: 'server-id',
      name: 'server',
      displayName: 'Server',
      transport: 'stdio' as const,
      command: 'mcp',
      enabled: true
    }
    const notifyStatusChanged = vi.fn()
    const projection = new ConnectorRuntimeSettingsProjection({
      readConnectors: vi.fn().mockResolvedValue(connectors({ customMcpServers: [server] })),
      skillsDir: '/config/skills',
      mcpClientManager: { listTools: vi.fn().mockResolvedValue([]) },
      syncBundledSkillDocs: vi.fn().mockResolvedValue(undefined),
      syncCustomSkillDocs: vi.fn().mockResolvedValue({
        materializedNames: [],
        failures: [{ server, error: new Error('Connection closed') }]
      }),
      notifyStatusChanged
    })

    await projection.refresh()
    projection.setCustomServerDispatchAvailability('server-id', 'unauthenticated')
    expect(projection.customServerAvailability('server-id')).toBe('unauthenticated')

    projection.setCustomServerDispatchAvailability('server-id', undefined)
    expect(projection.customServerAvailability('server-id')).toBe('unavailable')
    expect(notifyStatusChanged).toHaveBeenCalledTimes(4)
  })

  it('contains refresh errors while retaining the last snapshot reached by the refresh', async () => {
    const first = connectors({ disabledConnectorIds: ['chemistry'] })
    const second = connectors({ disabledConnectorIds: ['literature'] })
    const readConnectors = vi
      .fn<() => Promise<StoredConnectors | undefined>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockRejectedValueOnce(new Error('read failed'))
    const syncBundledSkillDocs = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('sync failed'))
    const reportError = vi.fn()
    const projection = new ConnectorRuntimeSettingsProjection({
      readConnectors,
      skillsDir: '/config/skills',
      mcpClientManager: { listTools: vi.fn().mockResolvedValue([]) },
      syncBundledSkillDocs,
      syncCustomSkillDocs: vi.fn().mockResolvedValue({ materializedNames: [], failures: [] }),
      reportError
    })

    await projection.refresh()
    expect(projection.current()).toBe(first)

    await expect(projection.refresh()).rejects.toThrow('sync failed')
    expect(projection.current()).toBe(second)
    expect(projection.materializedCustomSkillNames()).toEqual([])
    expect(reportError).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ message: 'sync failed' })
    )

    await expect(projection.refresh()).rejects.toThrow('read failed')
    expect(projection.current()).toBe(second)
    expect(reportError).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ message: 'read failed' })
    )
  })

  it('rejects an explicit failed refresh without discarding the last materialized catalog', async () => {
    const syncBundledSkillDocs = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('sync failed'))
      .mockResolvedValue(undefined)
    const projection = new ConnectorRuntimeSettingsProjection({
      readConnectors: vi.fn().mockResolvedValue(connectors()),
      skillsDir: '/config/skills',
      mcpClientManager: { listTools: vi.fn().mockResolvedValue([]) },
      syncBundledSkillDocs,
      syncCustomSkillDocs: vi
        .fn()
        .mockResolvedValue({ materializedNames: ['existing'], failures: [] }),
      reportError: vi.fn()
    })
    await projection.refresh()

    const outcome = await projection.refresh().then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error })
    )

    expect.soft(outcome).toMatchObject({
      status: 'rejected',
      error: expect.objectContaining({ message: 'sync failed' })
    })
    expect(projection.materializedCustomSkillNames()).toEqual(['mcp-existing'])
    expect(projection.isDegraded()).toBe(true)

    await projection.refresh()
    expect(projection.isDegraded()).toBe(false)
  })

  it('serializes simultaneous refresh pipelines so an older write cannot replace newer docs', async () => {
    const first = connectors({ disabledConnectorIds: ['chemistry'] })
    const second = connectors({ disabledConnectorIds: ['literature'] })
    const readConnectors = vi
      .fn<() => Promise<StoredConnectors | undefined>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    let finishFirstSync: (() => void) | undefined
    const firstSync = new Promise<void>((resolve) => {
      finishFirstSync = resolve
    })
    const syncBundledSkillDocs = vi
      .fn()
      .mockReturnValueOnce(firstSync)
      .mockResolvedValueOnce(undefined)
    const projection = new ConnectorRuntimeSettingsProjection({
      readConnectors,
      skillsDir: '/config/skills',
      mcpClientManager: { listTools: vi.fn().mockResolvedValue([]) },
      syncBundledSkillDocs,
      syncCustomSkillDocs: vi.fn().mockResolvedValue({ materializedNames: [], failures: [] })
    })

    const olderRefresh = projection.refresh()
    await vi.waitFor(() => expect(syncBundledSkillDocs).toHaveBeenCalledOnce())
    const newerRefresh = projection.refresh()
    let currentRefreshSettled = false
    const currentRefresh = newerRefresh.then(() => {
      currentRefreshSettled = true
    })

    // The newer read and all of its writes stay behind the older full pipeline.
    await Promise.resolve()
    expect(readConnectors).toHaveBeenCalledOnce()
    expect(projection.current()).toBe(first)
    expect(currentRefreshSettled).toBe(false)

    finishFirstSync?.()
    await olderRefresh
    await newerRefresh
    await currentRefresh

    expect(readConnectors).toHaveBeenCalledTimes(2)
    expect(projection.current()).toBe(second)
    expect(currentRefreshSettled).toBe(true)
    expect(projection.isRefreshing()).toBe(false)
  })

  it('continues the refresh queue after an earlier pipeline fails', async () => {
    const first = connectors({ disabledConnectorIds: ['chemistry'] })
    const second = connectors({ disabledConnectorIds: ['literature'] })
    const reportError = vi.fn()
    const projection = new ConnectorRuntimeSettingsProjection({
      readConnectors: vi
        .fn<() => Promise<StoredConnectors | undefined>>()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second),
      skillsDir: '/config/skills',
      mcpClientManager: { listTools: vi.fn().mockResolvedValue([]) },
      syncBundledSkillDocs: vi
        .fn()
        .mockRejectedValueOnce(new Error('older sync failed'))
        .mockResolvedValueOnce(undefined),
      syncCustomSkillDocs: vi.fn().mockResolvedValue({ materializedNames: [], failures: [] }),
      reportError
    })

    const [older, newer] = await Promise.allSettled([projection.refresh(), projection.refresh()])

    expect(older).toMatchObject({ status: 'rejected', reason: { message: 'older sync failed' } })
    expect(newer).toMatchObject({ status: 'fulfilled' })
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'older sync failed' })
    )
    expect(projection.current()).toBe(second)
  })
})
