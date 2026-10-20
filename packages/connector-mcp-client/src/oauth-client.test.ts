import { describe, expect, it, vi } from 'vitest'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js'

import { OAuthCallbackServer, PersistentOAuthClientProvider } from './oauth-client'

describe('OAuthCallbackServer', () => {
  it('keeps the existing callback URI compatible across loopback ports', async () => {
    const server = new OAuthCallbackServer()

    try {
      const redirectUrl = await server.ensureStarted()

      expect(redirectUriMatches(redirectUrl, 'http://127.0.0.1:8080/oauth/callback')).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('uses a pre-registered callback URI with the runtime loopback port', async () => {
    const server = new OAuthCallbackServer()

    try {
      const registeredRedirectUrl = 'http://127.0.0.1:1/callback'
      const redirectUrl = await server.ensureStarted(registeredRedirectUrl)

      expect(new URL(redirectUrl).port).not.toBe('1')
      expect(redirectUriMatches(redirectUrl, registeredRedirectUrl)).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('accepts authorization responses on the pre-registered callback path', async () => {
    const server = new OAuthCallbackServer()
    const redirectUrl = await server.ensureStarted('http://127.0.0.1:8080/callback')
    const pending = server.waitFor('state-registered')

    try {
      const response = await fetch(`${redirectUrl}?code=code-registered&state=state-registered`)

      expect(response.status).toBe(200)
      await expect(pending.promise).resolves.toEqual({
        code: 'code-registered',
        error: undefined,
        state: 'state-registered'
      })
    } finally {
      pending.cancel()
      await server.close()
    }
  })

  it('reuses one listener for concurrent startup', async () => {
    const server = new OAuthCallbackServer()

    const redirectUrls = await Promise.all([server.ensureStarted(), server.ensureStarted()])

    expect(new Set(redirectUrls).size).toBe(1)
    await server.close()
  })

  it('accepts only the pending state and returns the authorization code', async () => {
    const server = new OAuthCallbackServer()
    const redirectUrl = await server.ensureStarted()
    const pending = server.waitFor('state-1')

    const unknown = await fetch(`${redirectUrl}?code=wrong&state=unknown`)
    expect(unknown.status).toBe(400)
    const response = await fetch(`${redirectUrl}?code=code-1&state=state-1`)
    expect(response.status).toBe(200)
    await expect(pending.promise).resolves.toEqual({
      code: 'code-1',
      error: undefined,
      state: 'state-1'
    })

    await server.close()
  })

  it('returns an OAuth error to the matching pending flow', async () => {
    const server = new OAuthCallbackServer()
    const redirectUrl = await server.ensureStarted()
    const pending = server.waitFor('state-error')

    const response = await fetch(`${redirectUrl}?error=access_denied&state=state-error`)

    expect(response.status).toBe(400)
    await expect(pending.promise).resolves.toEqual({
      code: undefined,
      error: 'access_denied',
      state: 'state-error'
    })
    await server.close()
  })

  it('rejects an abandoned authorization attempt after the timeout', async () => {
    const server = new OAuthCallbackServer()
    await server.ensureStarted()
    const pending = server.waitFor('state-timeout', 5)

    await expect(pending.promise).rejects.toThrow(
      'OAuth authorization timed out. Try Sign in again.'
    )
    await server.close()
  })

  it('settles a cancelled authorization attempt immediately', async () => {
    const server = new OAuthCallbackServer()
    await server.ensureStarted()
    const pending = server.waitFor('state-cancelled')

    pending.cancel()

    await expect(pending.promise).resolves.toEqual({
      error: 'authorization_cancelled',
      state: 'state-cancelled'
    })
    await server.close()
  })
})

describe('PersistentOAuthClientProvider', () => {
  it('returns pre-registered client information without persisting the secret', async () => {
    const saveState = vi.fn(async () => undefined)
    const provider = new PersistentOAuthClientProvider({
      serverId: 'server-static',
      redirectUrl: 'http://127.0.0.1:4000/oauth/callback',
      config: {
        authorizationServerUrl: 'https://auth.example.test',
        clientId: 'registered-client'
      },
      clientSecret: 'registered-secret',
      saveState
    })

    await expect(provider.clientInformation()).resolves.toEqual({
      client_id: 'registered-client',
      issuer: 'https://auth.example.test',
      client_secret: 'registered-secret'
    })
    expect(saveState).not.toHaveBeenCalled()
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('none')
  })

  it('rejects discovered authorization servers that do not match static client registration', async () => {
    const provider = new PersistentOAuthClientProvider({
      serverId: 'server-static',
      redirectUrl: 'http://127.0.0.1:4000/oauth/callback',
      config: {
        authorizationServerUrl: 'https://auth.example.test',
        clientId: 'registered-client'
      }
    })

    await expect(
      provider.saveDiscoveryState({
        authorizationServerUrl: 'https://other-auth.example.test',
        authorizationServerMetadata: {
          issuer: 'https://other-auth.example.test',
          authorization_endpoint: 'https://other-auth.example.test/authorize',
          token_endpoint: 'https://other-auth.example.test/token',
          response_types_supported: ['code']
        }
      })
    ).rejects.toThrow('does not match the pre-registered client issuer')
  })

  it('persists client information, tokens, and discovery without exposing them in metadata', async () => {
    const saveState = vi.fn(async () => undefined)
    const provider = new PersistentOAuthClientProvider({
      serverId: 'server-1',
      redirectUrl: 'http://127.0.0.1:4000/oauth/callback',
      config: { scopes: ['openid', 'profile'] },
      saveState
    })

    expect(provider.clientMetadata).toMatchObject({
      client_name: 'connector-mcp-client',
      token_endpoint_auth_method: 'none',
      scope: 'openid profile'
    })
    await provider.saveTokens({
      access_token: 'access',
      token_type: 'Bearer',
      issuer: 'https://auth.example.test'
    })
    expect((await provider.tokens())?.access_token).toBe('access')
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: {
          access_token: 'access',
          token_type: 'Bearer',
          issuer: 'https://auth.example.test'
        }
      })
    )
    expect(JSON.stringify(provider.clientMetadata)).not.toContain('access')
  })

  it.each([undefined, '', ' ', 42, null])(
    'discards credentials with an invalid issuer (%s) before exposing a bearer token',
    async (issuer) => {
      const state = {
        tokens: { access_token: 'legacy-access', token_type: 'Bearer', issuer: issuer as string },
        clientInformation: {
          client_id: 'legacy-client',
          client_secret: 'legacy-secret',
          issuer: 'https://auth.example.test'
        }
      }
      const saveState = vi.fn(async () => undefined)
      const provider = new PersistentOAuthClientProvider({
        serverId: 'legacy',
        redirectUrl: 'http://127.0.0.1:4000/oauth/callback',
        config: {},
        state,
        saveState
      })

      await expect(provider.tokens()).resolves.toBeUndefined()
      await expect(provider.clientInformation()).resolves.toBeUndefined()
      expect(saveState).toHaveBeenCalledExactlyOnceWith({})
      expect(state.tokens.access_token).toBe('legacy-access')
    }
  )

  it('discards a bound token together with an unbound dynamic registration', async () => {
    const saveState = vi.fn(async () => undefined)
    const provider = new PersistentOAuthClientProvider({
      serverId: 'legacy',
      redirectUrl: 'http://127.0.0.1:4000/oauth/callback',
      config: {},
      state: {
        tokens: {
          access_token: 'bound-access',
          token_type: 'Bearer',
          issuer: 'https://auth.example.test'
        },
        clientInformation: { client_id: 'legacy-client', client_secret: 'legacy-secret' }
      },
      saveState
    })

    await expect(provider.clientInformation()).resolves.toBeUndefined()
    await expect(provider.tokens()).resolves.toBeUndefined()
    expect(saveState).toHaveBeenCalledExactlyOnceWith({})
  })

  it('propagates a failed legacy-credential removal before returning tokens', async () => {
    const provider = new PersistentOAuthClientProvider({
      serverId: 'legacy',
      redirectUrl: 'http://127.0.0.1:4000/oauth/callback',
      config: {},
      state: { tokens: { access_token: 'legacy-access', token_type: 'Bearer' } },
      saveState: async () => {
        throw new Error('storage unavailable')
      }
    })

    await expect(provider.tokens()).rejects.toThrow('storage unavailable')
  })

  it.each([undefined, 'https://original-auth.example.test'])(
    'does not send credentials bound to %s to a newly selected issuer',
    async (oldIssuer) => {
      const issuer = 'https://new-auth.example.test'
      const cachedIssuer = oldIssuer ? issuer : 'https://obsolete-auth.example.test'
      const redirectUrl = 'http://127.0.0.1:4000/oauth/callback'
      const saveState = vi.fn<(state: import('./types').McpOAuthState) => Promise<void>>(
        async () => undefined
      )
      const openExternal = vi.fn<(url: string) => Promise<void>>(async () => undefined)
      const provider = new PersistentOAuthClientProvider({
        serverId: 'oauth',
        redirectUrl,
        config: {},
        state: {
          clientInformation: {
            client_id: 'old-client',
            client_secret: 'old-secret',
            issuer: oldIssuer
          },
          tokens: {
            access_token: 'old-access',
            refresh_token: 'old-refresh',
            token_type: 'Bearer',
            issuer: oldIssuer
          },
          discoveryState: {
            authorizationServerUrl: cachedIssuer,
            resourceMetadata: {
              resource: 'https://mcp.example.test',
              authorization_servers: [cachedIssuer]
            },
            authorizationServerMetadata: {
              issuer: cachedIssuer,
              authorization_endpoint: `${cachedIssuer}/authorize`,
              token_endpoint: `${cachedIssuer}/token`,
              registration_endpoint: `${cachedIssuer}/register`,
              response_types_supported: ['code'],
              code_challenge_methods_supported: ['S256']
            }
          }
        },
        saveState,
        openExternal
      })
      const fetchFn = vi.fn<typeof fetch>(async (input) => {
        if (String(input) === 'https://mcp.example.test/.well-known/oauth-protected-resource') {
          return Response.json({
            resource: 'https://mcp.example.test',
            authorization_servers: [issuer]
          })
        }
        if (String(input) === `${issuer}/.well-known/oauth-authorization-server`) {
          return Response.json({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            registration_endpoint: `${issuer}/register`,
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256']
          })
        }
        if (String(input) === `${issuer}/register`) {
          return Response.json({
            client_id: 'new-client',
            redirect_uris: [redirectUrl],
            token_endpoint_auth_method: 'none'
          })
        }
        if (String(input) === `${issuer}/token`) {
          return Response.json({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            token_type: 'Bearer'
          })
        }
        throw new Error(`Unexpected OAuth request: ${String(input)}`)
      })
      const options = { serverUrl: new URL('https://mcp.example.test'), fetchFn }

      await expect(auth(provider, options)).resolves.toBe('REDIRECT')
      expect(openExternal).toHaveBeenCalledOnce()
      expect(new URL(openExternal.mock.calls[0][0]).origin).toBe(issuer)
      expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual(
        oldIssuer
          ? [`${issuer}/register`]
          : [
              'https://mcp.example.test/.well-known/oauth-protected-resource',
              `${issuer}/.well-known/oauth-authorization-server`,
              `${issuer}/register`
            ]
      )
      await expect(auth(provider, { ...options, authorizationCode: 'new-code' })).resolves.toBe(
        'AUTHORIZED'
      )
      const requests = fetchFn.mock.calls
        .map(([url, init]) => `${url} ${String(init?.body)} ${JSON.stringify(init?.headers)}`)
        .join('\n')
      for (const secret of ['old-client', 'old-secret', 'old-access', 'old-refresh']) {
        expect(requests).not.toContain(secret)
      }
      await expect(provider.tokens()).resolves.toMatchObject({ access_token: 'new-access', issuer })
      await expect(provider.clientInformation()).resolves.toMatchObject({
        client_id: 'new-client',
        issuer
      })
      const persisted = saveState.mock.calls.at(-1)?.[0]
      const restarted = new PersistentOAuthClientProvider({
        serverId: 'oauth',
        redirectUrl,
        config: {},
        state: JSON.parse(JSON.stringify(persisted))
      })
      await expect(restarted.tokens()).resolves.toMatchObject({
        access_token: 'new-access',
        issuer
      })
      await expect(restarted.clientInformation()).resolves.toMatchObject({
        client_id: 'new-client',
        issuer
      })
    }
  )

  it('clears stale tokens instead of opening a browser outside an interactive sign-in', async () => {
    const saveState = vi.fn(async () => undefined)
    const provider = new PersistentOAuthClientProvider({
      serverId: 'server-1',
      redirectUrl: 'http://127.0.0.1:4000/oauth/callback',
      config: {},
      state: { tokens: { access_token: 'stale', token_type: 'Bearer' } },
      saveState
    })

    await expect(
      provider.redirectToAuthorization(new URL('https://auth.example.test/authorize'))
    ).rejects.toThrow('OAuth authentication required. Start an interactive authorization flow.')
    await expect(provider.tokens()).resolves.toBeUndefined()
    expect(saveState).toHaveBeenLastCalledWith({})
  })

  it('opens only HTTPS and loopback HTTP authorization URLs', async () => {
    const openExternal = vi.fn(async () => undefined)
    const provider = new PersistentOAuthClientProvider({
      serverId: 'server-1',
      redirectUrl: 'http://127.0.0.1:4000/oauth/callback',
      config: {},
      openExternal
    })

    for (const authorizationUrl of [
      'https://auth.example.test/authorize',
      'http://localhost:4000/authorize',
      'http://127.0.0.2:4000/authorize',
      'http://[::1]:4000/authorize'
    ]) {
      await provider.redirectToAuthorization(new URL(authorizationUrl))
    }
    expect(openExternal.mock.calls).toEqual([
      ['https://auth.example.test/authorize'],
      ['http://localhost:4000/authorize'],
      ['http://127.0.0.2:4000/authorize'],
      ['http://[::1]:4000/authorize']
    ])

    openExternal.mockClear()
    for (const authorizationUrl of [
      'http://auth.example.test/authorize',
      'http://localhost.example.test/authorize',
      'http://127.example.test/authorize',
      'file:///tmp/oauth-authorization'
    ]) {
      await expect(provider.redirectToAuthorization(new URL(authorizationUrl))).rejects.toThrow(
        'OAuth authorization URL must use HTTPS or loopback HTTP.'
      )
    }
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('clears a stale token before rejecting an unsafe authorization URL', async () => {
    const saveState = vi.fn(async () => undefined)
    const provider = new PersistentOAuthClientProvider({
      serverId: 'server-1',
      redirectUrl: 'http://127.0.0.1:4000/oauth/callback',
      config: {},
      state: { tokens: { access_token: 'stale', token_type: 'Bearer' } },
      saveState,
      openExternal: vi.fn()
    })

    await expect(
      provider.redirectToAuthorization(new URL('http://auth.example.test/authorize'))
    ).rejects.toThrow('OAuth authorization URL must use HTTPS or loopback HTTP.')
    await expect(provider.tokens()).resolves.toBeUndefined()
    expect(saveState).toHaveBeenLastCalledWith({})
  })

  it('retains tokens until auth reads a dynamic registration tied to an old callback', async () => {
    const saveState = vi.fn(async () => undefined)
    const provider = new PersistentOAuthClientProvider({
      serverId: 'server-1',
      redirectUrl: 'http://127.0.0.1:5000/oauth/callback',
      config: {},
      state: {
        clientInformation: {
          client_id: 'registered-client',
          issuer: 'https://auth.example.test',
          redirect_uris: ['http://127.0.0.1:4000/oauth/callback']
        },
        tokens: {
          access_token: 'rejected',
          token_type: 'Bearer',
          issuer: 'https://auth.example.test'
        }
      },
      saveState
    })

    expect((await provider.tokens())?.access_token).toBe('rejected')
    expect(saveState).not.toHaveBeenCalled()

    await expect(provider.clientInformation()).resolves.toBeUndefined()
    await expect(provider.tokens()).resolves.toBeUndefined()
    expect(saveState).toHaveBeenLastCalledWith({})

    await provider.saveClientInformation({
      client_id: 'replacement-client',
      issuer: 'https://auth.example.test',
      redirect_uris: ['http://127.0.0.1:5000/oauth/callback']
    })
    await expect(provider.clientInformation()).resolves.toMatchObject({
      client_id: 'replacement-client'
    })
  })

  it('keeps callback-independent client information across loopback ports', async () => {
    const saveState = vi.fn(async () => undefined)
    const provider = new PersistentOAuthClientProvider({
      serverId: 'server-1',
      redirectUrl: 'http://127.0.0.1:5000/oauth/callback',
      config: { clientMetadataUrl: 'https://client.example.test/metadata' },
      state: {
        clientInformation: {
          client_id: 'https://client.example.test/metadata',
          issuer: 'https://auth.example.test'
        }
      },
      saveState
    })

    await expect(provider.clientInformation()).resolves.toEqual({
      client_id: 'https://client.example.test/metadata',
      issuer: 'https://auth.example.test'
    })
    expect(saveState).not.toHaveBeenCalled()
  })
})
