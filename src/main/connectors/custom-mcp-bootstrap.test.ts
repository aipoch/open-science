import { describe, it, expect } from 'vitest'
import { selectEnabledCustomServers, toCustomMcpConfig } from './custom-mcp-bootstrap'
import type { StoredConnectors, StoredCustomMcpServer } from '../settings/types'

describe('toCustomMcpConfig', () => {
  it('maps a stored stdio server to a McpClientManager config', () => {
    const server: StoredCustomMcpServer = {
      id: 'srv-1',
      name: 'My Server',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'some-mcp-server'],
      env: { FOO: 'bar' },
      enabled: true
    }

    expect(toCustomMcpConfig(server)).toEqual({
      id: 'srv-1',
      name: 'My Server',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'some-mcp-server'],
      env: { FOO: 'bar' },
      url: undefined,
      headers: undefined
    })
  })

  it('falls back to an empty command when the stored server has none', () => {
    const server: StoredCustomMcpServer = {
      id: 'srv-1',
      name: 'My Server',
      transport: 'stdio',
      enabled: true
    }

    expect(toCustomMcpConfig(server).command).toBe('')
  })

  it('maps a remote server url/headers/transport', () => {
    const server: StoredCustomMcpServer = {
      id: 'srv-remote',
      name: 'Remote Server',
      transport: 'streamable_http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      enabled: true
    }

    expect(toCustomMcpConfig(server)).toEqual({
      id: 'srv-remote',
      name: 'Remote Server',
      transport: 'streamable_http',
      command: '',
      args: undefined,
      env: undefined,
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' }
    })
  })
})

describe('selectEnabledCustomServers', () => {
  const stdioServer: StoredCustomMcpServer = {
    id: 'srv-stdio',
    name: 'Stdio Server',
    transport: 'stdio',
    command: 'npx',
    enabled: true
  }
  const disabledServer: StoredCustomMcpServer = { ...stdioServer, id: 'srv-off', enabled: false }
  const remoteServer: StoredCustomMcpServer = {
    id: 'srv-remote',
    name: 'Remote Server',
    transport: 'streamable_http',
    url: 'https://example.com/mcp',
    enabled: true
  }
  const sseServer: StoredCustomMcpServer = {
    id: 'srv-sse',
    name: 'SSE Server',
    transport: 'sse',
    url: 'https://example.com/sse',
    enabled: true
  }

  it('returns enabled servers across all supported transports', () => {
    const connectors: StoredConnectors = {
      enabledIds: [],
      autoAllowIds: [],
      customMcpServers: [stdioServer, disabledServer, remoteServer, sseServer]
    }

    expect(selectEnabledCustomServers(connectors)).toEqual([stdioServer, remoteServer, sseServer])
  })

  it('returns an empty array when connectors is undefined', () => {
    expect(selectEnabledCustomServers(undefined)).toEqual([])
  })

  it('returns an empty array when there are no custom servers', () => {
    expect(selectEnabledCustomServers({ enabledIds: [], autoAllowIds: [] })).toEqual([])
  })
})
