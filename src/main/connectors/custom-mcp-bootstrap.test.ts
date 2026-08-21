import { describe, it, expect } from 'vitest'
import { selectEnabledCustomServers, toCustomMcpConfig } from './custom-mcp-bootstrap'
import type { StoredConnectors, StoredCustomMcpServer } from '../settings/types'

describe('toCustomMcpConfig', () => {
  it('maps a stored stdio server to a McpClientManager config', () => {
    const server: StoredCustomMcpServer = {
      id: 'srv-1',
      name: 'my-server',
      displayName: 'My Server',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'some-mcp-server'],
      env: { FOO: 'bar' },
      enabled: true
    }

    expect(toCustomMcpConfig(server)).toEqual({
      id: 'srv-1',
      name: 'my-server',
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
      name: 'my-server',
      displayName: 'My Server',
      transport: 'stdio',
      enabled: true
    }

    expect(toCustomMcpConfig(server).command).toBe('')
  })

  it('maps a remote server url/headers/transport', () => {
    const server: StoredCustomMcpServer = {
      id: 'srv-remote',
      name: 'remote-server',
      displayName: 'Remote Server',
      transport: 'streamable_http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      enabled: true
    }

    expect(toCustomMcpConfig(server)).toEqual({
      id: 'srv-remote',
      name: 'remote-server',
      transport: 'streamable_http',
      command: '',
      args: undefined,
      env: undefined,
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' }
    })
  })

  it('maps OAuth configuration and decrypted state to the manager', () => {
    const server: StoredCustomMcpServer = {
      id: 'srv-oauth',
      name: 'oauth-server',
      displayName: 'OAuth Server',
      transport: 'streamable_http',
      url: 'https://example.com/mcp',
      oauth: {
        scopes: ['openid'],
        authorizationServerUrl: 'https://auth.example.test',
        clientId: 'registered-client'
      },
      oauthClientSecret: 'registered-secret',
      oauthState: { tokens: { access_token: 'access', token_type: 'Bearer' } },
      enabled: true
    }

    expect(toCustomMcpConfig(server)).toEqual({
      id: 'srv-oauth',
      name: 'oauth-server',
      transport: 'streamable_http',
      command: '',
      args: undefined,
      env: undefined,
      url: 'https://example.com/mcp',
      headers: undefined,
      oauth: {
        scopes: ['openid'],
        authorizationServerUrl: 'https://auth.example.test',
        clientId: 'registered-client',
        clientSecret: 'registered-secret',
        state: { tokens: { access_token: 'access', token_type: 'Bearer' } }
      }
    })
  })
})

describe('selectEnabledCustomServers', () => {
  const stdioServer: StoredCustomMcpServer = {
    id: 'srv-stdio',
    name: 'stdio-server',
    displayName: 'Stdio Server',
    transport: 'stdio',
    command: 'npx',
    enabled: true
  }
  const disabledServer: StoredCustomMcpServer = {
    ...stdioServer,
    id: 'srv-off',
    name: 'disabled-server',
    displayName: 'Disabled Server',
    enabled: false
  }
  const remoteServer: StoredCustomMcpServer = {
    id: 'srv-remote',
    name: 'remote-server',
    displayName: 'Remote Server',
    transport: 'streamable_http',
    url: 'https://example.com/mcp',
    enabled: true
  }
  const sseServer: StoredCustomMcpServer = {
    id: 'srv-sse',
    name: 'sse-server',
    displayName: 'SSE Server',
    transport: 'sse',
    url: 'https://example.com/sse',
    enabled: true
  }
  const unauthenticatedOAuthServer: StoredCustomMcpServer = {
    ...remoteServer,
    id: 'srv-oauth-waiting',
    name: 'oauth-waiting',
    displayName: 'OAuth Waiting',
    oauth: {}
  }
  const authenticatedOAuthServer: StoredCustomMcpServer = {
    ...unauthenticatedOAuthServer,
    id: 'srv-oauth-ready',
    name: 'oauth-ready',
    displayName: 'OAuth Ready',
    oauthState: { tokens: { access_token: 'access', token_type: 'Bearer' } }
  }
  const bundledRouteCollision: StoredCustomMcpServer = {
    ...stdioServer,
    id: 'srv-reserved-route',
    name: 'chemistry',
    displayName: 'Other Chemistry'
  }
  const duplicateRouteA: StoredCustomMcpServer = {
    ...stdioServer,
    id: 'srv-duplicate-a',
    name: 'duplicate-mcp',
    displayName: 'Duplicate A'
  }
  const duplicateRouteB: StoredCustomMcpServer = {
    ...stdioServer,
    id: 'srv-duplicate-b',
    name: 'duplicate-mcp',
    displayName: 'Duplicate B'
  }

  it('returns enabled servers across all supported transports', () => {
    const connectors: StoredConnectors = {
      enabledIds: [],
      autoAllowIds: [],
      customMcpServers: [
        stdioServer,
        disabledServer,
        remoteServer,
        sseServer,
        unauthenticatedOAuthServer,
        authenticatedOAuthServer,
        bundledRouteCollision,
        duplicateRouteA,
        duplicateRouteB
      ]
    }

    expect(selectEnabledCustomServers(connectors)).toEqual([
      stdioServer,
      remoteServer,
      sseServer,
      authenticatedOAuthServer
    ])
  })

  it('returns an empty array when connectors is undefined', () => {
    expect(selectEnabledCustomServers(undefined)).toEqual([])
  })

  it('returns an empty array when there are no custom servers', () => {
    expect(selectEnabledCustomServers({ enabledIds: [], autoAllowIds: [] })).toEqual([])
  })

  it('fails closed when custom Connectors have duplicate names', () => {
    const first: StoredCustomMcpServer = {
      ...stdioServer,
      id: 'first',
      name: 'same-name',
      displayName: 'First'
    }
    const second: StoredCustomMcpServer = {
      ...stdioServer,
      id: 'second',
      name: 'same-name',
      displayName: 'Second'
    }

    expect(
      selectEnabledCustomServers({
        enabledIds: [],
        autoAllowIds: [],
        customMcpServers: [first, second]
      })
    ).toEqual([])
  })
})
