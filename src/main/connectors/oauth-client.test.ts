import { describe, expect, it, vi } from 'vitest'
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
      client_name: 'Open Science',
      token_endpoint_auth_method: 'none',
      scope: 'openid profile'
    })
    await provider.saveTokens({ access_token: 'access', token_type: 'Bearer' })
    expect(provider.tokens()?.access_token).toBe('access')
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({ tokens: { access_token: 'access', token_type: 'Bearer' } })
    )
    expect(JSON.stringify(provider.clientMetadata)).not.toContain('access')
  })

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
    ).rejects.toThrow('OAuth authentication required. Sign in from Settings > Connectors.')
    expect(provider.tokens()).toBeUndefined()
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
    expect(provider.tokens()).toBeUndefined()
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
          redirect_uris: ['http://127.0.0.1:4000/oauth/callback']
        },
        tokens: { access_token: 'rejected', token_type: 'Bearer' }
      },
      saveState
    })

    expect(provider.tokens()?.access_token).toBe('rejected')
    expect(saveState).not.toHaveBeenCalled()

    await expect(provider.clientInformation()).resolves.toBeUndefined()
    expect(provider.tokens()).toBeUndefined()
    expect(saveState).toHaveBeenLastCalledWith({})

    await provider.saveClientInformation({
      client_id: 'replacement-client',
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
      state: { clientInformation: { client_id: 'https://client.example.test/metadata' } },
      saveState
    })

    await expect(provider.clientInformation()).resolves.toEqual({
      client_id: 'https://client.example.test/metadata'
    })
    expect(saveState).not.toHaveBeenCalled()
  })
})
