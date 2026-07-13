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
