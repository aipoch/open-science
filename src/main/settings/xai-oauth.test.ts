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
    expect(store.save).toHaveBeenCalledWith(undefined, 'refresh', 'researcher@example.com')
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
})
