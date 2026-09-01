import { describe, it, expect } from 'vitest'
import { sanitizeConnectors, sanitizeCustomMcpServer } from './repository'

describe('sanitizeCustomMcpServer', () => {
  it('round-trips a valid stdio server with args/env/trustedAt', () => {
    expect(
      sanitizeCustomMcpServer({
        id: 'srv-1',
        name: 'my-server',
        displayName: 'My Server',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'some-mcp-server'],
        env: { FOO: 'bar' },
        enabled: true,
        trustedAt: 1700000000000,
        description: 'A test server'
      })
    ).toEqual({
      id: 'srv-1',
      name: 'my-server',
      displayName: 'My Server',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'some-mcp-server'],
      env: { FOO: 'bar' },
      enabled: true,
      trustedAt: 1700000000000,
      description: 'A test server'
    })
  })

  it('uses the canonical name and ignores a legacy slug', () => {
    const base = {
      id: 'srv-1',
      name: 'example-oauth-e2e',
      displayName: 'Example OAuth E2E',
      transport: 'stdio',
      command: 'npx',
      enabled: true
    }

    expect(sanitizeCustomMcpServer({ ...base, slug: 'different-name' })).toMatchObject(base)
    expect(sanitizeCustomMcpServer({ ...base, slug: '../unsafe' })).toMatchObject(base)
  })

  it('drops a stdio server missing command', () => {
    expect(
      sanitizeCustomMcpServer({
        id: 'srv-1',
        name: 'my-server',
        displayName: 'My Server',
        transport: 'stdio',
        enabled: true
      })
    ).toBeUndefined()
  })

  it('drops an entry with an invalid transport', () => {
    expect(
      sanitizeCustomMcpServer({
        id: 'srv-1',
        name: 'my-server',
        displayName: 'My Server',
        transport: 'websocket',
        command: 'npx',
        enabled: true
      })
    ).toBeUndefined()
  })

  it('strips non-string env values', () => {
    expect(
      sanitizeCustomMcpServer({
        id: 'srv-1',
        name: 'My Server',
        transport: 'stdio',
        command: 'npx',
        env: { FOO: 'bar', BAD: 42, ALSO_BAD: { nested: true } },
        enabled: true
      })
    ).toEqual({
      id: 'srv-1',
      name: 'my-server',
      displayName: 'My Server',
      transport: 'stdio',
      command: 'npx',
      env: { FOO: 'bar' },
      enabled: true
    })
  })

  it('round-trips a valid remote (streamable_http) server with url and headers', () => {
    expect(
      sanitizeCustomMcpServer({
        id: 'srv-remote',
        name: 'remote-server',
        displayName: 'Remote Server',
        transport: 'streamable_http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer token' },
        enabled: true
      })
    ).toEqual({
      id: 'srv-remote',
      name: 'remote-server',
      displayName: 'Remote Server',
      transport: 'streamable_http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      enabled: true
    })
  })

  it('round-trips a valid sse server with url', () => {
    expect(
      sanitizeCustomMcpServer({
        id: 'srv-sse',
        name: 'sse-server',
        displayName: 'SSE Server',
        transport: 'sse',
        url: 'https://example.com/sse',
        enabled: true
      })
    ).toEqual({
      id: 'srv-sse',
      name: 'sse-server',
      displayName: 'SSE Server',
      transport: 'sse',
      url: 'https://example.com/sse',
      enabled: true
    })
  })

  it('keeps a device-global OAuth reference without copying OAuth config onto the Connector', () => {
    expect(
      sanitizeCustomMcpServer({
        id: 'srv-shared-oauth',
        name: 'shared-oauth',
        displayName: 'Shared OAuth',
        transport: 'streamable_http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'must-be-dropped' },
        oauthRef: 'credential:credential-id',
        enabled: false
      })
    ).toEqual({
      id: 'srv-shared-oauth',
      name: 'shared-oauth',
      displayName: 'Shared OAuth',
      transport: 'streamable_http',
      url: 'https://example.com/mcp',
      oauthRef: 'credential:credential-id',
      enabled: false
    })
  })

  it('drops a remote server missing a url', () => {
    expect(
      sanitizeCustomMcpServer({
        id: 'srv-remote',
        name: 'remote-server',
        displayName: 'Remote Server',
        transport: 'streamable_http',
        enabled: true
      })
    ).toBeUndefined()
    expect(
      sanitizeCustomMcpServer({
        id: 'srv-sse',
        name: 'sse-server',
        displayName: 'SSE Server',
        transport: 'sse',
        enabled: true
      })
    ).toBeUndefined()
  })

  it('strips non-string header values', () => {
    expect(
      sanitizeCustomMcpServer({
        id: 'srv-remote',
        name: 'remote-server',
        displayName: 'Remote Server',
        transport: 'streamable_http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer token', BAD: 42 },
        enabled: true
      })
    ).toEqual({
      id: 'srv-remote',
      name: 'remote-server',
      displayName: 'Remote Server',
      transport: 'streamable_http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      enabled: true
    })
  })

  it('sanitizes OAuth fields and removes conflicting static headers', () => {
    expect(
      sanitizeCustomMcpServer({
        id: 'srv-oauth',
        name: 'oauth-server',
        displayName: 'OAuth Server',
        transport: 'streamable_http',
        url: 'https://example.com/mcp',
        enabled: true,
        headers: { Authorization: 'Bearer stale' },
        headerRefs: { Authorization: 'encrypted-stale' },
        oauth: {
          clientMetadataUrl: 'https://client.example.test/metadata.json',
          authorizationServerUrl: 42,
          scopes: ['openid', ' openid ', 'profile', 42],
          clientId: 'registered-client',
          redirectUri: 'https://example.com/callback',
          clientSecret: 'must-not-be-persisted'
        },
        oauthRef: 'encrypted-oauth-state',
        oauthClientSecretRef: 'encrypted-client-secret',
        oauthClientSecret: 'must-not-be-persisted-either'
      })
    ).toEqual({
      id: 'srv-oauth',
      name: 'oauth-server',
      displayName: 'OAuth Server',
      transport: 'streamable_http',
      url: 'https://example.com/mcp',
      enabled: true,
      oauth: {
        clientMetadataUrl: 'https://client.example.test/metadata.json',
        scopes: ['openid', 'profile'],
        clientId: 'registered-client'
      },
      oauthRef: 'encrypted-oauth-state',
      oauthClientSecretRef: 'encrypted-client-secret'
    })
  })
})

describe('sanitizeConnectors customMcpServers', () => {
  it('collects valid custom servers and filters out invalid ones', () => {
    const result = sanitizeConnectors({
      enabledIds: [],
      autoAllowIds: [],
      customMcpServers: [
        {
          id: 'srv-1',
          name: 'valid',
          displayName: 'Valid',
          transport: 'stdio',
          command: 'npx',
          enabled: true
        },
        { id: 'srv-2', name: 'Missing command', transport: 'stdio', enabled: true },
        { id: '', name: 'No id', transport: 'stdio', command: 'npx', enabled: true }
      ]
    })

    expect(result?.customMcpServers).toEqual([
      {
        id: 'srv-1',
        name: 'valid',
        displayName: 'Valid',
        transport: 'stdio',
        command: 'npx',
        enabled: true
      }
    ])
  })

  it('omits customMcpServers when the resulting list is empty', () => {
    const result = sanitizeConnectors({
      enabledIds: [],
      autoAllowIds: [],
      customMcpServers: []
    })

    expect(result?.customMcpServers).toBeUndefined()
  })

  it('does not treat a custom server UUID or displayName as a policy identity', () => {
    const result = sanitizeConnectors({
      enabledIds: [],
      autoAllowIds: ['chemistry', 'srv-1'],
      blockedToolIds: ['chemistry/search', 'srv-1/write'],
      askToolIds: ['chemistry/lookup', 'srv-1/read'],
      customMcpServers: [
        {
          id: 'srv-1',
          name: 'custom-chemistry',
          displayName: 'chemistry',
          transport: 'stdio',
          command: 'npx',
          enabled: true
        }
      ]
    })

    expect(result).toMatchObject({
      autoAllowIds: ['chemistry', 'srv-1'],
      blockedToolIds: ['chemistry/search', 'srv-1/write'],
      askToolIds: ['chemistry/lookup', 'srv-1/read']
    })
  })
})
