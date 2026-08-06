import { afterEach, describe, it, expect, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { McpClientManager, buildTransport } from './mcp-client-manager'
import type { CustomMcpServerConfig } from './mcp-client-manager'
import { OAuthCallbackServer, type PersistentOAuthClientProvider } from './oauth-client'

afterEach(() => vi.restoreAllMocks())

// Builds an in-memory MCP server with one echo tool and one always-erroring tool, and an
// injectable createClient that links a fresh Client to it via InMemoryTransport — no process
// spawn, no network.
function makeTestServer(): { createClient: () => Promise<Client> } {
  const server = new McpServer({ name: 'test-server', version: '0.0.0' })

  server.registerTool(
    'echo',
    { description: 'Echoes back its args as JSON.', inputSchema: { value: z.string() } },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(args) }] })
  )

  server.registerTool('boom', { description: 'Always fails.' }, async () => ({
    content: [{ type: 'text', text: 'kaboom' }],
    isError: true
  }))

  const createClient = async (): Promise<Client> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    return client
  }

  return { createClient }
}

const config: CustomMcpServerConfig = {
  id: 'srv-1',
  name: 'test-server',
  transport: 'stdio',
  command: 'unused'
}

describe('McpClientManager', () => {
  it('lists tools registered on the server', async () => {
    const { createClient } = makeTestServer()
    const manager = new McpClientManager({ createClient: () => createClient() })

    const tools = await manager.listTools(config)

    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['boom', 'echo'])
    expect(tools.find((t) => t.name === 'echo')?.description).toMatch(/Echoes/)
  })

  it('calls a tool and returns the parsed JSON dict', async () => {
    const { createClient } = makeTestServer()
    const manager = new McpClientManager({ createClient: () => createClient() })

    const out = await manager.call(config, 'echo', { value: 'hello' })

    expect(out).toEqual({ value: 'hello' })
  })

  it('throws when the tool result has isError set', async () => {
    const { createClient } = makeTestServer()
    const manager = new McpClientManager({ createClient: () => createClient() })

    await expect(manager.call(config, 'boom', {})).rejects.toThrow(/kaboom/)
  })

  it('dedupes concurrent connects for the same server id', async () => {
    let connectCount = 0
    const { createClient } = makeTestServer()
    const manager = new McpClientManager({
      createClient: async () => {
        connectCount += 1
        return createClient()
      }
    })

    await Promise.all([manager.listTools(config), manager.call(config, 'echo', { value: 'x' })])

    expect(connectCount).toBe(1)
  })

  it('closeAll drops cached clients so a later call reconnects', async () => {
    let connectCount = 0
    const { createClient } = makeTestServer()
    const manager = new McpClientManager({
      createClient: async () => {
        connectCount += 1
        return createClient()
      }
    })

    await manager.listTools(config)
    await manager.closeAll()
    await manager.listTools(config)

    expect(connectCount).toBe(2)
  })

  it('completes an interactive OAuth callback, clears PKCE, and reconnects', async () => {
    const saveOAuthState = vi.fn(async () => undefined)
    const openExternal = vi.fn(async (authorizationUrl: string) => {
      const url = new URL(authorizationUrl)
      const redirectUrl = url.searchParams.get('redirect_uri')
      const state = url.searchParams.get('state')
      if (!redirectUrl || !state) throw new Error('test authorization URL is incomplete')
      const response = await fetch(`${redirectUrl}?code=code-1&state=${state}`)
      expect(response.status).toBe(200)
    })
    const connect = vi.spyOn(Client.prototype, 'connect')
    connect
      .mockImplementationOnce(async (transport) => {
        const provider = (transport as unknown as { _authProvider: PersistentOAuthClientProvider })
          ._authProvider
        const authorizationUrl = new URL('https://auth.example.test/authorize')
        authorizationUrl.searchParams.set('redirect_uri', String(provider.redirectUrl))
        authorizationUrl.searchParams.set('state', provider.state())
        provider.saveCodeVerifier('verifier-1')
        await provider.redirectToAuthorization(authorizationUrl)
        throw new UnauthorizedError()
      })
      .mockResolvedValueOnce(undefined)
    const finishAuth = vi
      .spyOn(StreamableHTTPClientTransport.prototype, 'finishAuth')
      .mockImplementation(async function (this: StreamableHTTPClientTransport, code) {
        expect(code).toBe('code-1')
        const provider = (this as unknown as { _authProvider: PersistentOAuthClientProvider })
          ._authProvider
        await provider.saveTokens({ access_token: 'access-1', token_type: 'Bearer' })
      })
    const manager = new McpClientManager({ openExternal, saveOAuthState })

    try {
      await manager.authenticate({
        id: 'oauth-1',
        name: 'OAuth server',
        transport: 'streamable_http',
        url: 'https://mcp.example.test',
        oauth: {}
      })

      expect(openExternal).toHaveBeenCalledOnce()
      expect(finishAuth).toHaveBeenCalledWith('code-1')
      expect(connect).toHaveBeenCalledTimes(2)
      expect(saveOAuthState).toHaveBeenCalledWith(
        'oauth-1',
        expect.objectContaining({
          tokens: { access_token: 'access-1', token_type: 'Bearer' }
        })
      )
    } finally {
      await manager.closeAll()
    }
  })

  it.each([
    { callbackError: 'access_denied', expected: 'OAuth authorization failed: access_denied' },
    { callbackError: undefined, expected: 'OAuth callback did not include an authorization code' }
  ])('rejects an incomplete OAuth callback: $expected', async ({ callbackError, expected }) => {
    const openExternal = vi.fn(async (authorizationUrl: string) => {
      const url = new URL(authorizationUrl)
      const redirectUrl = url.searchParams.get('redirect_uri')
      const state = url.searchParams.get('state')
      if (!redirectUrl || !state) throw new Error('test authorization URL is incomplete')
      const callbackUrl = new URL(redirectUrl)
      callbackUrl.searchParams.set('state', state)
      if (callbackError) callbackUrl.searchParams.set('error', callbackError)
      await fetch(callbackUrl)
    })
    vi.spyOn(Client.prototype, 'connect').mockImplementationOnce(async (transport) => {
      const provider = (transport as unknown as { _authProvider: PersistentOAuthClientProvider })
        ._authProvider
      const authorizationUrl = new URL('https://auth.example.test/authorize')
      authorizationUrl.searchParams.set('redirect_uri', String(provider.redirectUrl))
      authorizationUrl.searchParams.set('state', provider.state())
      provider.saveCodeVerifier('verifier-1')
      await provider.redirectToAuthorization(authorizationUrl)
      throw new UnauthorizedError()
    })
    const finishAuth = vi.spyOn(StreamableHTTPClientTransport.prototype, 'finishAuth')
    const manager = new McpClientManager({ openExternal })

    try {
      await expect(
        manager.authenticate({
          id: 'oauth-incomplete',
          name: 'OAuth server',
          transport: 'streamable_http',
          url: 'https://mcp.example.test',
          oauth: {}
        })
      ).rejects.toThrow(expected)
      expect(finishAuth).not.toHaveBeenCalled()
    } finally {
      await manager.closeAll()
    }
  })

  it('cancels an interactive OAuth attempt waiting for its callback', async () => {
    let markBrowserOpened!: () => void
    const browserOpened = new Promise<void>((resolve) => {
      markBrowserOpened = resolve
    })
    const openExternal = vi.fn(async () => markBrowserOpened())
    const saveOAuthState = vi.fn(async () => undefined)
    vi.spyOn(Client.prototype, 'connect').mockImplementationOnce(async (transport) => {
      const provider = (transport as unknown as { _authProvider: PersistentOAuthClientProvider })
        ._authProvider
      const authorizationUrl = new URL('https://auth.example.test/authorize')
      authorizationUrl.searchParams.set('redirect_uri', String(provider.redirectUrl))
      authorizationUrl.searchParams.set('state', provider.state())
      provider.saveCodeVerifier('verifier-1')
      await provider.redirectToAuthorization(authorizationUrl)
      throw new UnauthorizedError()
    })
    const manager = new McpClientManager({ openExternal, saveOAuthState })
    const oauthConfig: CustomMcpServerConfig = {
      id: 'oauth-cancel',
      name: 'OAuth server',
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: { state: { tokens: { access_token: 'stale', token_type: 'Bearer' } } }
    }

    try {
      const pending = manager.authenticate(oauthConfig)
      await browserOpened

      await manager.cancelAuthentication(oauthConfig.id)

      await expect(pending).rejects.toThrow('OAuth authorization failed: authorization_cancelled')
      expect(saveOAuthState).toHaveBeenCalledWith('oauth-cancel', {})
    } finally {
      await manager.closeAll()
    }
  })

  it('cancels an interactive OAuth attempt before its callback listener starts', async () => {
    const openExternal = vi.fn(async () => undefined)
    const manager = new McpClientManager({ openExternal })
    const oauthConfig: CustomMcpServerConfig = {
      id: 'oauth-early-cancel',
      name: 'OAuth server',
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: {}
    }

    const pending = manager.authenticate(oauthConfig)
    await manager.cancelAuthentication(oauthConfig.id)

    await expect(pending).rejects.toThrow('connection was superseded')
    expect(openExternal).not.toHaveBeenCalled()
    await manager.closeAll()
  })

  it('lets closeAll supersede OAuth authentication before its first await completes', async () => {
    let finishInitialClose!: () => void
    const initialClose = new Promise<void>((resolve) => {
      finishInitialClose = resolve
    })
    const manager = new McpClientManager()
    const close = vi.spyOn(manager, 'close').mockImplementationOnce(() => initialClose)
    const ensureStarted = vi.spyOn(OAuthCallbackServer.prototype, 'ensureStarted')
    const connect = vi.spyOn(Client.prototype, 'connect')
    const oauthConfig: CustomMcpServerConfig = {
      id: 'oauth-shutdown',
      name: 'OAuth server',
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: {}
    }

    const pending = manager.authenticate(oauthConfig)
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith(oauthConfig.id))
    await manager.closeAll()
    finishInitialClose()

    await expect(pending).rejects.toThrow('connection was superseded')
    expect(ensureStarted).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it('honors cancellation while the OAuth callback server is starting', async () => {
    let finishStartup!: (redirectUrl: string) => void
    const startup = new Promise<string>((resolve) => {
      finishStartup = resolve
    })
    const ensureStarted = vi
      .spyOn(OAuthCallbackServer.prototype, 'ensureStarted')
      .mockReturnValue(startup)
    const waitFor = vi.spyOn(OAuthCallbackServer.prototype, 'waitFor')
    const connect = vi.spyOn(Client.prototype, 'connect')
    const manager = new McpClientManager()
    const oauthConfig: CustomMcpServerConfig = {
      id: 'oauth-startup-cancel',
      name: 'OAuth server',
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: {}
    }

    const pending = manager.authenticate(oauthConfig)
    await vi.waitFor(() => expect(ensureStarted).toHaveBeenCalledOnce())
    await manager.cancelAuthentication(oauthConfig.id)
    finishStartup('http://127.0.0.1:4567/oauth/callback')

    await expect(pending).rejects.toThrow('connection was superseded')
    expect(waitFor).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
    await manager.closeAll()
  })

  it('closes the active OAuth client when authentication is cancelled', async () => {
    let markConnectStarted!: () => void
    let rejectConnect!: (error: Error) => void
    const connectStarted = new Promise<void>((resolve) => {
      markConnectStarted = resolve
    })
    vi.spyOn(Client.prototype, 'connect').mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectConnect = reject
          markConnectStarted()
        })
    )
    const close = vi.spyOn(Client.prototype, 'close').mockImplementationOnce(async () => {
      rejectConnect(new Error('connection cancelled'))
    })
    const manager = new McpClientManager()
    const oauthConfig: CustomMcpServerConfig = {
      id: 'oauth-active-cancel',
      name: 'OAuth server',
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: {}
    }

    const pending = manager.authenticate(oauthConfig)
    await connectStarted
    await manager.cancelAuthentication(oauthConfig.id)

    await expect(pending).rejects.toThrow('connection cancelled')
    expect(close).toHaveBeenCalled()
    await manager.closeAll()
  })

  it('cancels the OAuth callback when transport setup fails', async () => {
    const cancel = vi.fn()
    vi.spyOn(OAuthCallbackServer.prototype, 'ensureStarted').mockResolvedValue(
      'http://127.0.0.1:4567/oauth/callback'
    )
    vi.spyOn(OAuthCallbackServer.prototype, 'waitFor').mockReturnValue({
      promise: new Promise(() => undefined),
      cancel
    })
    const manager = new McpClientManager()

    await expect(
      manager.authenticate({
        id: 'oauth-invalid-url',
        name: 'OAuth server',
        transport: 'streamable_http',
        url: 'not a url',
        oauth: {}
      })
    ).rejects.toThrow()
    expect(cancel).toHaveBeenCalledOnce()
    await manager.closeAll()
  })

  it('does not open a browser during a background OAuth connection', async () => {
    const openExternal = vi.fn(async () => undefined)
    const saveOAuthState = vi.fn(async () => undefined)
    const manager = new McpClientManager({
      openExternal,
      saveOAuthState,
      createClient: async (_config, provider) => {
        await provider?.redirectToAuthorization(new URL('https://auth.example.test/authorize'))
        throw new Error('expected redirectToAuthorization to reject')
      }
    })

    await expect(
      manager.listTools({
        id: 'oauth-background',
        name: 'OAuth server',
        transport: 'streamable_http',
        url: 'https://mcp.example.test',
        oauth: { state: { tokens: { access_token: 'stale', token_type: 'Bearer' } } }
      })
    ).rejects.toThrow('OAuth authentication required. Sign in from Settings > Connectors.')
    expect(openExternal).not.toHaveBeenCalled()
    expect(saveOAuthState).toHaveBeenLastCalledWith('oauth-background', {})
    await manager.closeAll()
  })

  it('ignores OAuth state from a background connection invalidated by close', async () => {
    let releaseConnection!: () => void
    let markStarted!: () => void
    const connectionReleased = new Promise<void>((resolve) => {
      releaseConnection = resolve
    })
    const connectionStarted = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const close = vi.fn(async () => undefined)
    const saveOAuthState = vi.fn(async () => undefined)
    const manager = new McpClientManager({
      saveOAuthState,
      createClient: async (_config, provider) => {
        markStarted()
        await connectionReleased
        await provider?.saveTokens({ access_token: 'stale', token_type: 'Bearer' })
        return { close } as unknown as Client
      }
    })
    const oauthConfig: CustomMcpServerConfig = {
      id: 'oauth-race',
      name: 'OAuth race',
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: {}
    }

    const pending = manager.listTools(oauthConfig)
    await connectionStarted
    await manager.close(oauthConfig.id)
    releaseConnection()

    await expect(pending).rejects.toThrow('connection was superseded')
    expect(saveOAuthState).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
    await manager.closeAll()
  })
})

describe('buildTransport', () => {
  it('builds a StdioClientTransport for a stdio config', () => {
    const transport = buildTransport({
      id: 'srv-stdio',
      name: 'stdio-server',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'some-mcp-server']
    })

    expect(transport).toBeInstanceOf(StdioClientTransport)
  })

  it('throws when a stdio config is missing a command', () => {
    expect(() =>
      buildTransport({ id: 'srv-stdio', name: 'stdio-server', transport: 'stdio' })
    ).toThrow()
  })

  it('builds a StreamableHTTPClientTransport for a streamable_http config', () => {
    const transport = buildTransport({
      id: 'srv-http',
      name: 'http-server',
      transport: 'streamable_http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' }
    })

    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport)
  })

  it('throws when a streamable_http config is missing a url', () => {
    expect(() =>
      buildTransport({ id: 'srv-http', name: 'http-server', transport: 'streamable_http' })
    ).toThrow()
  })

  it('builds an SSEClientTransport for an sse config', () => {
    const transport = buildTransport({
      id: 'srv-sse',
      name: 'sse-server',
      transport: 'sse',
      url: 'https://example.com/sse'
    })

    expect(transport).toBeInstanceOf(SSEClientTransport)
  })

  it('throws when an sse config is missing a url', () => {
    expect(() => buildTransport({ id: 'srv-sse', name: 'sse-server', transport: 'sse' })).toThrow()
  })
})
