import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { XaiOAuthController, type XaiOAuthCredentialStore } from './xai-oauth'
import { AUTHENTICATION_QUIT_BUDGET_MS, createQuitPreparation } from '../lifecycle-shutdown'
import { shutdownApplicationSurfaces } from '../application-runtime'
import { LOCAL_SERVICE_STOP_BUDGET_MS } from '../local-service-lifetime'

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
        return stored.keyRef!
      }),
      clear: vi.fn(async () => {
        stored = {}
      })
    }
  })

  afterEach(() => vi.useRealTimers())

  it('settles a slow rotation before the five-second disposal phase and resumes after a refused quit', async () => {
    vi.useFakeTimers()
    stored = { keyRef: 'old', refreshToken: 'old-refresh' }
    store.save = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      stored = { keyRef: 'new', refreshToken: 'rotated' }
      return 'new'
    })
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url).includes('openid-configuration')) return Response.json(discovery)
      await new Promise((resolve) => setTimeout(resolve, 14_000))
      return Response.json({ access_token: 'access', refresh_token: 'rotated' })
    })
    const controller = new XaiOAuthController({ store, fetch })
    const access = controller.getAccessToken()
    await vi.advanceTimersByTimeAsync(0)
    const preparation = createQuitPreparation({
      quiesceAuthentication: () => controller.quiesce(),
      prepareAgent: async () => 'completed',
      prepareBackends: async () => 'completed',
      abortAgent: vi.fn(),
      resumeSideChat: vi.fn()
    })
    let completed = false
    const ready = preparation.prepareForQuit().then((result) => {
      completed = true
      return result
    })
    await vi.advanceTimersByTimeAsync(5001)
    expect(completed).toBe(false)
    await expect(controller.getAccessToken()).rejects.toThrow('paused for shutdown')
    await vi.advanceTimersByTimeAsync(10_999)
    await expect(ready).resolves.toBe('completed')
    await expect(access).resolves.toBe('access')
    expect(stored.refreshToken).toBe('rotated')
    preparation.abortQuitPreparation()
    await expect(controller.getAccessToken()).resolves.toBe('access')
    expect(fetch).toHaveBeenCalledTimes(2)
    await expect(preparation.prepareForQuit()).resolves.toBe('completed')
    await expect(
      shutdownApplicationSurfaces({
        disposeApplicationRuntime: () => controller.dispose(),
        disposeWebController: vi.fn(),
        shutdownRemoteAccess: vi.fn(),
        disposeIpcHandlers: vi.fn()
      })
    ).resolves.toBe('completed')
    expect(LOCAL_SERVICE_STOP_BUDGET_MS).toBeGreaterThan(AUTHENTICATION_QUIT_BUDGET_MS + 5000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports a timed-out write without abandoning it or admitting a second refresh', async () => {
    vi.useFakeTimers()
    stored = { keyRef: 'old', refreshToken: 'old-refresh' }
    let finish!: () => void
    store.save = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      stored = { keyRef: 'new', refreshToken: 'rotated' }
      return 'new'
    })
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(discovery))
      .mockResolvedValueOnce(Response.json({ access_token: 'access', refresh_token: 'rotated' }))
    const controller = new XaiOAuthController({ store, fetch })
    const access = controller.getAccessToken()
    await vi.advanceTimersByTimeAsync(0)
    const preparation = createQuitPreparation({
      quiesceAuthentication: () => controller.quiesce(),
      prepareAgent: async () => 'completed',
      prepareBackends: async () => 'completed',
      abortAgent: vi.fn(),
      resumeSideChat: vi.fn()
    })
    const ready = preparation.prepareForQuit()
    await vi.advanceTimersByTimeAsync(AUTHENTICATION_QUIT_BUDGET_MS)
    await expect(ready).resolves.toBe('timeout')
    expect(stored.refreshToken).toBe('old-refresh')
    await expect(controller.getAccessToken()).rejects.toThrow('paused for shutdown')
    preparation.abortQuitPreparation()
    const resumed = controller.getAccessToken()
    finish()
    await expect(Promise.all([access, resumed])).resolves.toEqual(['access', 'access'])
    expect(stored.refreshToken).toBe('rotated')
    expect(store.save).toHaveBeenCalledOnce()
    await controller.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps admission held until every quit lease is released and propagates write failure', async () => {
    let fail!: (reason: Error) => void
    store.clear = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject
        })
    )
    const controller = new XaiOAuthController({ store })
    const removal = expect(controller.logout()).rejects.toThrow('storage failed')
    const first = controller.quiesce()
    const second = controller.quiesce()
    const settled = Promise.all([
      expect(first.settled).rejects.toThrow('storage failed'),
      expect(second.settled).rejects.toThrow('storage failed')
    ])
    first.release()
    first.release()
    await expect(controller.beginLogin()).rejects.toThrow('paused for shutdown')
    fail(new Error('storage failed'))
    await removal
    await settled
    second.release()
    await expect(controller.getAccessToken()).rejects.toThrow('Sign in to xAI')
    await controller.dispose()
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
    expect(store.save).toHaveBeenCalledWith(
      undefined,
      'refresh',
      'researcher@example.com',
      true,
      expect.any(Function)
    )
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
    expect(store.save).toHaveBeenCalledWith(
      'old-ref',
      'new-refresh',
      undefined,
      false,
      expect.any(Function)
    )
  })

  it('does not write a second force-refresh with a stale expected key ref after the first refresh settles', async () => {
    stored = { keyRef: 'ref-0', refreshToken: 'refresh-1' }
    store.save = vi.fn(async (expectedKeyRef, refreshToken, accountEmail) => {
      if (stored.keyRef !== expectedKeyRef) return false
      stored = { keyRef: `ref-after-${refreshToken}`, refreshToken, accountEmail }
      return stored.keyRef!
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
    expect(store.save).toHaveBeenNthCalledWith(
      1,
      'ref-0',
      'refresh-2',
      undefined,
      false,
      expect.any(Function)
    )
    expect(store.save).toHaveBeenNthCalledWith(
      2,
      'ref-after-refresh-2',
      'refresh-3',
      undefined,
      false,
      expect.any(Function)
    )
    expect(store.save).not.toHaveBeenCalledWith('ref-0', 'refresh-3')
    expect(stored).toEqual({
      keyRef: 'ref-after-refresh-3',
      refreshToken: 'refresh-3'
    })
  })

  it.each([3540000, 3600001])(
    'automatically refreshes at clock offset %i without replaying a stale access token',
    async (offset) => {
      let now = 1000
      stored = { keyRef: 'ref-0', refreshToken: 'refresh-0' }
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(discovery)))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: 'access-1',
              refresh_token: 'refresh-1',
              expires_in: 3600
            })
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: 'access-2',
              refresh_token: 'refresh-2',
              expires_in: 3600
            })
          )
        )
      const controller = new XaiOAuthController({ store, fetch, now: () => now })
      try {
        await expect(controller.getAccessToken()).resolves.toBe('access-1')
        now += 3539999
        await expect(controller.getAccessToken()).resolves.toBe('access-1')
        expect(fetch).toHaveBeenCalledTimes(2)

        now = 1000 + offset
        await expect(
          Promise.all(Array.from({ length: 8 }, () => controller.getAccessToken()))
        ).resolves.toEqual(Array(8).fill('access-2'))
        expect(fetch).toHaveBeenCalledTimes(3)
        const body = new URLSearchParams(fetch.mock.calls[2][1].body)
        expect(body.get('grant_type')).toBe('refresh_token')
        expect(body.get('refresh_token')).toBe('refresh-1')
        expect(store.save).toHaveBeenLastCalledWith(
          'encrypted',
          'refresh-2',
          undefined,
          false,
          expect.any(Function)
        )
        expect(stored.refreshToken).toBe('refresh-2')
        await expect(controller.getAccessToken()).resolves.toBe('access-2')
        expect(fetch).toHaveBeenCalledTimes(3)
      } finally {
        await controller.dispose()
      }
    }
  )

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

  it.each(['headers', 'body'])(
    'bounds a refresh stalled at %s and allows a later explicit retry',
    async (phase) => {
      vi.useFakeTimers()
      stored = { keyRef: 'old-ref', refreshToken: 'old-refresh' }
      let signal: AbortSignal | undefined
      const cancel = vi.fn()
      const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
        if (String(url).includes('openid-configuration')) return Response.json(discovery)
        signal = init?.signal ?? undefined
        if (phase === 'body') return new Response(new ReadableStream({ cancel }))
        return new Promise((_resolve, reject) =>
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
        )
      })
      const controller = new XaiOAuthController({ store, fetch })
      const failed = expect(controller.getAccessToken()).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(15_001)
      await failed
      expect(signal?.aborted).toBe(true)
      if (phase === 'body') expect(cancel).toHaveBeenCalledOnce()
      expect(store.save).not.toHaveBeenCalled()
      fetch.mockResolvedValue(Response.json({ access_token: 'retry-access', expires_in: 3600 }))
      await expect(controller.getAccessToken()).resolves.toBe('retry-access')
      await controller.dispose()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('uses one network deadline across discovery and token exchange', async () => {
    vi.useFakeTimers()
    stored = { refreshToken: 'refresh' }
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (String(url).includes('openid-configuration')) {
        await new Promise((resolve) => setTimeout(resolve, 10_000))
        return Response.json(discovery)
      }
      const signal = init!.signal!
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      )
    })
    const controller = new XaiOAuthController({ store, fetch })
    const failed = expect(controller.getAccessToken()).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(15_001)
    await failed
    expect(fetch).toHaveBeenCalledTimes(2)
    await controller.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['redirect', 'oversized', 'malformed', 'array'])(
    'rejects %s OAuth responses without persisting or leaking body content',
    async (kind) => {
      stored = { refreshToken: 'refresh' }
      const response =
        kind === 'redirect'
          ? new Response(null, { status: 302, headers: { location: 'https://untrusted.example/' } })
          : kind === 'oversized'
            ? new Response('secret-token', {
                headers: { 'content-length': String(1024 * 1024 + 1) }
              })
            : kind === 'array'
              ? Response.json(['secret-token'])
              : new Response('secret-token: invalid JSON')
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(Response.json(discovery))
        .mockResolvedValueOnce(response)
      const controller = new XaiOAuthController({ store, fetch })
      await expect(controller.getAccessToken()).rejects.toThrow(
        kind === 'redirect' ? 'redirects are not supported' : 'invalid OAuth response'
      )
      expect(fetch.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true)
      expect(store.save).not.toHaveBeenCalled()
      await controller.dispose()
    }
  )

  it('coalesces all refresh callers and drains the rotated credential write before disposal completes', async () => {
    vi.useFakeTimers()
    stored = { keyRef: 'old-ref', refreshToken: 'old-refresh' }
    let save!: () => void
    store.save = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        save = resolve
      })
      stored = { keyRef: 'new-ref', refreshToken: 'rotated' }
      return 'new-ref'
    })
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(discovery))
      .mockResolvedValueOnce(
        Response.json({ access_token: 'access', refresh_token: 'rotated', expires_in: 3600 })
      )
    const controller = new XaiOAuthController({ store, fetch })
    const requests = Array.from({ length: 32 }, () => controller.getAccessToken())
    await vi.advanceTimersByTimeAsync(0)
    expect(store.save).toHaveBeenCalledOnce()
    const disposed = vi.fn()
    const closing = controller.dispose()
    expect(controller.dispose()).toBe(closing)
    void closing.then(disposed)
    await expect(controller.getAccessToken()).rejects.toThrow('disposed')
    await expect(controller.beginLogin()).rejects.toThrow('disposed')
    await expect(controller.waitForLogin()).rejects.toThrow('disposed')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(disposed).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    save()
    await expect(Promise.all(requests)).resolves.toEqual(Array(32).fill('access'))
    await closing
    expect(stored.refreshToken).toBe('rotated')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('drains a refresh hidden by logout without restoring the signed-out account', async () => {
    stored = { keyRef: 'old-ref', refreshToken: 'old-refresh' }
    let finish!: (response: Response) => void
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(discovery))
      .mockImplementationOnce(
        async () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
    const controller = new XaiOAuthController({ store, fetch })
    const result = expect(controller.getAccessToken()).rejects.toThrow('Sign in to xAI')
    await vi.waitFor(() => expect(finish).toBeDefined())
    await controller.logout()
    const done = vi.fn()
    const closing = controller.dispose().then(done)
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    finish(Response.json({ access_token: 'stale', refresh_token: 'stale-rotation' }))
    await result
    await closing
    expect(stored).toEqual({})
    expect(store.save).not.toHaveBeenCalled()
  })

  it('does not cache access after a credential persistence failure', async () => {
    stored = { keyRef: 'old-ref', refreshToken: 'old-refresh' }
    store.save = vi.fn(async () => {
      throw new Error('storage failed')
    })
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(discovery))
      .mockImplementation(async () =>
        Response.json({ access_token: 'access', refresh_token: 'rotation', expires_in: 3600 })
      )
    const controller = new XaiOAuthController({ store, fetch })
    await expect(controller.getAccessToken()).rejects.toThrow('storage failed')
    await expect(controller.getAccessToken()).rejects.toThrow('storage failed')
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(store.save).toHaveBeenCalledTimes(2)
    expect(stored.refreshToken).toBe('old-refresh')
    await controller.dispose()
  })

  it('drains a logout credential removal already in progress', async () => {
    let finish!: () => void
    store.clear = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const controller = new XaiOAuthController({ store })
    const logout = controller.logout()
    const done = vi.fn()
    const closing = controller.dispose().then(done)
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    finish()
    await logout
    await closing
    expect(done).toHaveBeenCalledOnce()
  })

  it('lets a refresh already sent to the provider persist its rotation during shutdown', async () => {
    stored = { keyRef: 'old-ref', refreshToken: 'old-refresh' }
    let finish!: (response: Response) => void
    let signal!: AbortSignal
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(discovery))
      .mockImplementationOnce(async (_url, init) => {
        signal = init!.signal!
        return new Promise((resolve) => {
          finish = resolve
        })
      })
    const controller = new XaiOAuthController({ store, fetch })
    const token = controller.getAccessToken()
    await vi.waitFor(() => expect(finish).toBeDefined())
    const done = vi.fn()
    const closing = controller.dispose().then(done)
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    expect(signal.aborted).toBe(false)
    finish(Response.json({ access_token: 'access', refresh_token: 'rotated' }))
    await expect(token).resolves.toBe('access')
    await closing
    expect(stored.refreshToken).toBe('rotated')
  })

  it('coalesces device-login waiters into one poll and one credential write', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ ...discovery, userinfo_endpoint: undefined }))
      .mockResolvedValueOnce(
        Response.json({
          device_code: 'device',
          user_code: 'code',
          verification_uri: 'https://auth.x.ai/activate',
          interval: 1
        })
      )
      .mockResolvedValueOnce(Response.json({ access_token: 'access', refresh_token: 'refresh' }))
    const controller = new XaiOAuthController({ store, fetch, wait: async () => undefined })
    await controller.beginLogin()
    await expect(
      Promise.all([controller.waitForLogin(), controller.waitForLogin()])
    ).resolves.toEqual([{}, {}])
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(store.save).toHaveBeenCalledOnce()
    await controller.dispose()
  })

  it('expires a device code before a longer poll interval without issuing another request', async () => {
    vi.useFakeTimers()
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(discovery))
      .mockResolvedValueOnce(
        Response.json({
          device_code: 'device',
          user_code: 'code',
          verification_uri: 'https://auth.x.ai/activate',
          expires_in: 1,
          interval: 5
        })
      )
    const controller = new XaiOAuthController({ store, fetch })
    await controller.beginLogin()
    const expired = expect(controller.waitForLogin()).rejects.toThrow('device code expired')
    await vi.advanceTimersByTimeAsync(1000)
    await expired
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(store.save).not.toHaveBeenCalled()
    await controller.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['dispose', 'quiesce'] as const)(
    'cancels and drains a login poll at %s',
    async (mode) => {
      let entered = false
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(Response.json(discovery))
        .mockResolvedValueOnce(
          Response.json({
            device_code: 'device',
            user_code: 'code',
            verification_uri: 'https://auth.x.ai/activate',
            interval: 1
          })
        )
        .mockImplementationOnce(
          async (_url, init) =>
            new Promise((_resolve, reject) => {
              entered = true
              init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
                once: true
              })
            })
        )
      const controller = new XaiOAuthController({ store, fetch, wait: async () => undefined })
      await controller.beginLogin()
      const result = expect(controller.waitForLogin()).rejects.toBeDefined()
      await vi.waitFor(() => expect(entered).toBe(true))
      if (mode === 'dispose') await controller.dispose()
      else {
        const lease = controller.quiesce()
        await expect(lease.settled).resolves.toBeUndefined()
        lease.release()
        await controller.dispose()
      }
      await result
      expect(store.save).not.toHaveBeenCalled()
    }
  )
})
