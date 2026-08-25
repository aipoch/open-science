import { beforeEach, describe, expect, it, vi } from 'vitest'

import { XaiOAuthController, type XaiOAuthCredentialStore } from './xai-oauth'

const discovery = {
  issuer: 'https://auth.x.ai',
  device_authorization_endpoint: 'https://auth.x.ai/oauth2/device/code',
  token_endpoint: 'https://auth.x.ai/oauth2/token',
  userinfo_endpoint: 'https://auth.x.ai/oauth2/userinfo'
}

describe('XaiOAuthController', () => {
  let stored: { keyRef?: string; refreshToken?: string; accountEmail?: string }
  let store: XaiOAuthCredentialStore

  beforeEach(() => {
    stored = {}
    store = {
      load: vi.fn(async () => stored),
      save: vi.fn(async (_expected, refreshToken, accountEmail) => {
        stored = { keyRef: 'encrypted', refreshToken, accountEmail }
        return true
      }),
      clear: vi.fn(async () => {
        stored = {}
      })
    }
  })

  it('keeps the device code in main and persists only the refresh credential', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(discovery)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            device_code: 'secret-device-code',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://auth.x.ai/activate',
            expires_in: 900,
            interval: 1
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 })
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ email: 'researcher@example.com' })))
    const controller = new XaiOAuthController({
      store,
      fetch,
      wait: vi.fn(async () => undefined)
    })

    const session = await controller.beginLogin()
    expect(session).toEqual(
      expect.objectContaining({
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://auth.x.ai/activate'
      })
    )
    expect(session).not.toHaveProperty('deviceCode')
    await expect(controller.waitForLogin()).resolves.toEqual({
      accountEmail: 'researcher@example.com'
    })
    expect(store.save).toHaveBeenCalledWith(undefined, 'refresh', 'researcher@example.com', true)
  })

  it('coalesces refreshes and saves a rotated refresh token', async () => {
    stored = { keyRef: 'old-ref', refreshToken: 'old-refresh' }
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(discovery)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 60
          })
        )
      )
    const controller = new XaiOAuthController({ store, fetch })

    await expect(
      Promise.all([controller.getAccessToken(), controller.getAccessToken()])
    ).resolves.toEqual(['new-access', 'new-access'])
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(store.save).toHaveBeenCalledWith('old-ref', 'new-refresh')
  })

  it('does not write a second force-refresh with a stale expected key ref after the first refresh settles', async () => {
    stored = { keyRef: 'ref-0', refreshToken: 'refresh-1' }
    store.save = vi.fn(async (expectedKeyRef, refreshToken, accountEmail) => {
      if (stored.keyRef !== expectedKeyRef) return false
      stored = { keyRef: `ref-after-${refreshToken}`, refreshToken, accountEmail }
      return true
    })
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(discovery)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-1',
            refresh_token: 'refresh-2',
            expires_in: 3600
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-2',
            refresh_token: 'refresh-3',
            expires_in: 3600
          })
        )
      )
    const controller = new XaiOAuthController({ store, fetch })

    await expect(controller.getAccessToken(true)).resolves.toBe('access-1')
    await expect(controller.getAccessToken(true)).resolves.toBe('access-2')

    expect(fetch).toHaveBeenCalledTimes(3)
    expect(store.save).toHaveBeenNthCalledWith(1, 'ref-0', 'refresh-2')
    expect(store.save).toHaveBeenNthCalledWith(2, 'ref-after-refresh-2', 'refresh-3')
    expect(store.save).not.toHaveBeenCalledWith('ref-0', 'refresh-3')
    expect(stored).toEqual({
      keyRef: 'ref-after-refresh-3',
      refreshToken: 'refresh-3'
    })
  })

  it('accepts xAI account verification URLs on accounts.x.ai', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(discovery)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            device_code: 'secret-device-code',
            user_code: 'H5N5-ECSJ',
            verification_uri: 'https://accounts.x.ai/oauth2/device',
            verification_uri_complete: 'https://accounts.x.ai/oauth2/device?user_code=H5N5-ECSJ',
            expires_in: 1800,
            interval: 5
          })
        )
      )
    const controller = new XaiOAuthController({ store, fetch })

    await expect(controller.beginLogin()).resolves.toEqual(
      expect.objectContaining({
        userCode: 'H5N5-ECSJ',
        verificationUri: 'https://accounts.x.ai/oauth2/device',
        verificationUriComplete: 'https://accounts.x.ai/oauth2/device?user_code=H5N5-ECSJ'
      })
    )
  })

  it('rejects a verification page outside the xAI account origin', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(discovery)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            device_code: 'secret-device-code',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://example.com/activate'
          })
        )
      )
    const controller = new XaiOAuthController({ store, fetch })
    await expect(controller.beginLogin()).rejects.toThrow('untrusted OAuth endpoint')
  })

  it('rejects discovered endpoints outside the xAI authorization origin', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ...discovery, token_endpoint: 'https://example.com/oauth/token' })
        )
      )
    const controller = new XaiOAuthController({ store, fetch })
    await expect(controller.beginLogin()).rejects.toThrow('untrusted OAuth endpoint')
  })

  it('aborts discovery when device sign-in is cancelled before it starts', async () => {
    let requestSignal: AbortSignal | undefined
    const fetch = vi.fn(
      (_url: string | URL | globalThis.Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined
          requestSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          )
        })
    )
    const controller = new XaiOAuthController({ store, fetch })

    const pending = controller.beginLogin()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    controller.cancelLogin()

    expect(requestSignal?.aborted).toBe(true)
    await expect(pending).rejects.toThrow('xAI sign-in was cancelled')
  })

  it('discards an in-flight refresh so logout cannot reuse the signed-out token', async () => {
    stored = { keyRef: 'old-ref', refreshToken: 'old-refresh' }
    let finishRefresh: ((response: Response) => void) | undefined
    const fetch = vi.fn(async (url: string | URL | globalThis.Request) => {
      if (String(url).includes('openid-configuration')) {
        return new Response(JSON.stringify(discovery))
      }
      return await new Promise<Response>((resolve) => {
        finishRefresh = resolve
      })
    })
    const controller = new XaiOAuthController({ store, fetch })

    const pending = controller.getAccessToken()
    await vi.waitFor(() => expect(finishRefresh).toBeDefined())
    await controller.logout()
    finishRefresh!(new Response(JSON.stringify({ access_token: 'stale-access', expires_in: 3600 })))

    await expect(pending).rejects.toThrow('Sign in to xAI (Grok) OAuth to continue.')
    await expect(controller.getAccessToken()).rejects.toThrow(
      'Sign in to xAI (Grok) OAuth to continue.'
    )
    expect(store.save).not.toHaveBeenCalled()
    expect(stored).toEqual({})
  })
})
