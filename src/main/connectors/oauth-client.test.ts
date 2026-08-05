import { describe, expect, it, vi } from 'vitest'

import { OAuthCallbackServer, PersistentOAuthClientProvider } from './oauth-client'

describe('OAuthCallbackServer', () => {
  it('accepts only the pending state and returns the authorization code', async () => {
    const server = new OAuthCallbackServer()
    const redirectUrl = await server.ensureStarted()
    const pending = server.waitFor('state-1')

    const response = await fetch(`${redirectUrl}?code=code-1&state=state-1`)
    expect(response.status).toBe(200)
    await expect(pending.promise).resolves.toEqual({
      code: 'code-1',
      error: undefined,
      state: 'state-1'
    })

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
})
