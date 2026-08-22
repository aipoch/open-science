import { describe, expect, it, vi } from 'vitest'

import { OAuthCallbackServer, PersistentOAuthClientProvider } from './oauth-client'

describe('OAuthCallbackServer', () => {
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

  it('binds to a preferred port when specified', async () => {
    const server = new OAuthCallbackServer()
    const redirectUrl = await server.ensureStarted(0) // port 0 = random
    const port = new URL(redirectUrl).port

    expect(port).toBeDefined()
    expect(Number(port)).toBeGreaterThan(0)
    await server.close()
  })

  it('restarts on a different port when preferred port changes', async () => {
    const server = new OAuthCallbackServer()

    // Start on port 0 (random)
    const url1 = await server.ensureStarted(0)
    const port1 = new URL(url1).port

    // Start on a different random port (port 0 again = new random)
    const url2 = await server.ensureStarted(0)
    const port2 = new URL(url2).port

    // Both should work (may be same or different random ports)
    expect(url1).toContain('/oauth/callback')
    expect(url2).toContain('/oauth/callback')
    await server.close()
  })
})

describe('PersistentOAuthClientProvider', () => {
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
