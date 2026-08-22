import { describe, it, expect } from 'vitest'
import { sanitizeConnectors, sanitizeCustomMcpServer } from './repository'

describe('sanitizeCustomMcpServer', () => {
  it('round-trips a valid stdio server with args/env/trustedAt', () => {
    expect(
      sanitizeCustomMcpServer({
        id: 'srv-1',
        name: 'My Server',
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
      name: 'My Server',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'some-mcp-server'],
      env: { FOO: 'bar' },
      enabled: true,
      trustedAt: 1700000000000,
      description: 'A test server'
    })
  })

  it('keeps a safe explicit slug and drops an invalid legacy value', () => {
    const base = {
      id: 'srv-1',
      name: 'Example OAuth E2E',
      transport: 'stdio',
      command: 'npx',
      enabled: true
    }

    expect(sanitizeCustomMcpServer({ ...base, slug: 'example-oauth-e2e' })).toMatchObject({
      slug: 'example-oauth-e2e'
    })
    expect(sanitizeCustomMcpServer({ ...base, slug: '../unsafe' })).not.toHaveProperty('slug')
  })

  it('drops a stdio server missing command', () => {
    expect(
      sanitizeCustomMcpServer({
        id: 'srv-1',
        name: 'My Server',
        transport: 'stdio',
        enabled: true
      })
    ).toBeUndefined()
  })

  it('drops an entry with an invalid transport', () => {
    expect(
      sanitizeCustomMcpServer({
        id: 'srv-1',
        name: 'My Server',
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
      name: 'My Server',
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
        name: 'Remote Server',
        transport: 'streamable_http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer token' },
        enabled: true
      })
    ).toEqual({
      id: 'srv-remote',
      name: 'Remote Server',
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
        name: 'SSE Server',
        transport: 'sse',
        url: 'https://example.com/sse',
        enabled: true
      })
    ).toEqual({
      id: 'srv-sse',
      name: 'SSE Server',
      transport: 'sse',
      url: 'https://example.com/sse',
      enabled: true
    })
  })

  it('drops a remote server missing a url', () => {
    expect(
      sanitizeCustomMcpServer({
        id: 'srv-remote',
        name: 'Remote Server',
        transport: 'streamable_http',
        enabled: true
      })
    ).toBeUndefined()
    expect(
      sanitizeCustomMcpServer({
        id: 'srv-sse',
        name: 'SSE Server',
        transport: 'sse',
        enabled: true
      })
    ).toBeUndefined()
  })

  it('strips non-string header values', () => {
    expect(
      sanitizeCustomMcpServer({
        id: 'srv-remote',
        name: 'Remote Server',
        transport: 'streamable_http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer token', BAD: 42 },
        enabled: true
      })
    ).toEqual({
      id: 'srv-remote',
      name: 'Remote Server',
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
        name: 'OAuth Server',
        transport: 'streamable_http',
        url: 'https://example.com/mcp',
        enabled: true,
        headers: { Authorization: 'Bearer stale' },
        headerRefs: { Authorization: 'encrypted-stale' },
        oauth: {
          clientMetadataUrl: 'https://client.example.test/metadata.json',
          authorizationServerUrl: 42,
          scopes: ['openid', ' openid ', 'profile', 42]
        },
        oauthRef: 'encrypted-oauth-state'
      })
    ).toEqual({
      id: 'srv-oauth',
      name: 'OAuth Server',
      transport: 'streamable_http',
      url: 'https://example.com/mcp',
      enabled: true,
      oauth: {
        clientMetadataUrl: 'https://client.example.test/metadata.json',
        scopes: ['openid', 'profile']
      },
      oauthRef: 'encrypted-oauth-state'
    })
  })

  it('preserves valid redirectPort in oauth config', () => {
    expect(
      sanitizeCustomMcpServer({
        id: 'srv-oauth-port',
        name: 'OAuth Server with Port',
        transport: 'streamable_http',
        url: 'https://example.com/mcp',
        enabled: true,
        oauth: {
          authorizationServerUrl: 'https://auth.example.com',
          scopes: ['read'],
          redirectPort: 8080
        }
      })
    ).toMatchObject({
      oauth: {
        authorizationServerUrl: 'https://auth.example.com',
        scopes: ['read'],
        redirectPort: 8080
      }
    })
  })

  it('drops invalid redirectPort values', () => {
    // Port 0 is invalid
    const result = sanitizeCustomMcpServer({
      id: 'srv-oauth-port-invalid',
      name: 'OAuth Server',
      transport: 'streamable_http',
      url: 'https://example.com/mcp',
      enabled: true,
      oauth: {
        authorizationServerUrl: 'https://auth.example.com',
        redirectPort: 0
      }
    })
    expect(result?.oauth).not.toHaveProperty('redirectPort')

    // Port > 65535 is invalid
    const result2 = sanitizeCustomMcpServer({
      id: 'srv-oauth-port-invalid2',
      name: 'OAuth Server',
      transport: 'streamable_http',
      url: 'https://example.com/mcp',
      enabled: true,
      oauth: {
        authorizationServerUrl: 'https://auth.example.com',
        redirectPort: 70000
      }
    })
    expect(result2?.oauth).not.toHaveProperty('redirectPort')
  })
})

describe('sanitizeConnectors customMcpServers', () => {
  it('collects valid custom servers and filters out invalid ones', () => {
    const result = sanitizeConnectors({
      enabledIds: [],
      autoAllowIds: [],
      customMcpServers: [
        { id: 'srv-1', name: 'Valid', transport: 'stdio', command: 'npx', enabled: true },
        { id: 'srv-2', name: 'Missing command', transport: 'stdio', enabled: true },
        { id: '', name: 'No id', transport: 'stdio', command: 'npx', enabled: true }
      ]
    })

    expect(result?.customMcpServers).toEqual([
      { id: 'srv-1', name: 'Valid', transport: 'stdio', command: 'npx', enabled: true }
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
})
