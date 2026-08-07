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
          name: 'Enabled',
          transport: 'stdio',
          command: 'mcp',
          enabled: true
        },
        {
          id: 'disabled-id',
          name: 'Disabled',
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
      return { materializedSlugs: ['enabled'], failures: [] }
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

  it('advertises only custom Skills that materialized when one enabled server is unavailable', async () => {
    const unavailable = {
      id: 'unavailable-id',
      slug: 'unavailable',
      name: 'Unavailable',
      transport: 'stdio' as const,
      command: 'node',
      enabled: true
    }
    const healthy = {
      id: 'healthy-id',
      slug: 'healthy',
      name: 'Healthy',
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
        materializedSlugs: ['healthy'],
        failures: [{ server: unavailable, error: failure }]
      }),
      reportError
    })

    await projection.refresh()

    expect(projection.materializedCustomSkillNames()).toEqual(['mcp-healthy'])
    expect(reportError).toHaveBeenCalledOnce()
    expect(reportError.mock.calls[0]?.[0]).toMatchObject({
      message: 'Failed to sync custom MCP server "unavailable" skill docs',
      cause: failure
    })
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
      syncCustomSkillDocs: vi.fn().mockResolvedValue({ materializedSlugs: [], failures: [] }),
      reportError
    })

    await projection.refresh()
    expect(projection.current()).toBe(first)

    await projection.refresh()
    expect(projection.current()).toBe(second)
    expect(projection.materializedCustomSkillNames()).toEqual([])
    expect(reportError).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ message: 'sync failed' })
    )

    await projection.refresh()
    expect(projection.current()).toBe(second)
    expect(reportError).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ message: 'read failed' })
    )
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
      syncCustomSkillDocs: vi.fn().mockResolvedValue({ materializedSlugs: [], failures: [] })
    })

    const olderRefresh = projection.refresh()
    await vi.waitFor(() => expect(syncBundledSkillDocs).toHaveBeenCalledOnce())
    const newerRefresh = projection.refresh()

    // The newer read and all of its writes stay behind the older full pipeline.
    await Promise.resolve()
    expect(readConnectors).toHaveBeenCalledOnce()
    expect(projection.current()).toBe(first)

    finishFirstSync?.()
    await olderRefresh
    await newerRefresh

    expect(readConnectors).toHaveBeenCalledTimes(2)
    expect(projection.current()).toBe(second)
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
      syncCustomSkillDocs: vi.fn().mockResolvedValue({ materializedSlugs: [], failures: [] }),
      reportError
    })

    await Promise.all([projection.refresh(), projection.refresh()])

    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'older sync failed' })
    )
    expect(projection.current()).toBe(second)
  })
})
