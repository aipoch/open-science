import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ExchangeCodeInput, LabApi } from './lab-api'
import { LabApiError } from './lab-api'
import type { LabCredentialStore } from './lab-credential-store'
import { LabLoopbackCallbackHost, LabOAuthController } from './lab-oauth'

const SERVER = 'https://lab.example.com'

const createApi = (): {
  api: Record<string, ReturnType<typeof vi.fn>>
  registered: () => Record<string, unknown> | undefined
} => {
  let registered: Record<string, unknown> | undefined
  const api = {
    registerLoginAttempt: vi.fn(async (input: Record<string, unknown>) => {
      registered = input
      return {
        requestId: 'req_1',
        authorizationUrl: `${SERVER}/oauth/authorize?request_id=req_1`,
        expiresAt: Date.now() + 5 * 60_000
      }
    }),
    exchangeCode: vi.fn(async (input: { codeVerifier: string; redirectUri: string }) => {
      void input
      return {
        accessToken: 'at_1',
        refreshToken: 'rt_1',
        expiresIn: 900,
        tokenExpiresAt: Date.now() + 900_000
      }
    }),
    refreshToken: vi.fn(),
    logout: vi.fn(),
    bootstrap: vi.fn()
  }
  return { api, registered: () => registered }
}

const createCredentials = (): Record<string, ReturnType<typeof vi.fn>> => ({
  ensureInstallationId: vi.fn(async () => 'i'.repeat(32)),
  saveSession: vi.fn(async () => undefined),
  readDocument: vi.fn(async () => ({ version: 1 as const, updatedAt: 0 })),
  readSession: vi.fn(async () => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Lab loopback callback host', () => {
  it('binds an explicit 127.0.0.1 port and matches the state before resolving', async () => {
    const host = new LabLoopbackCallbackHost()
    const redirectUri = await host.start()
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/u)
    const pending = host.waitFor('state-1', 5_000)
    const response = await fetch(`${redirectUri}?code=code_1&state=state-1`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('window.close()')
    await expect(pending).resolves.toEqual({ code: 'code_1' })

    const missingCode = host.waitFor('state-empty', 5_000)
    const invalid = await fetch(`${redirectUri}?state=state-empty`)
    expect(invalid.status).toBe(400)
    expect(await invalid.text()).not.toContain('window.close()')
    await expect(missingCode).resolves.toEqual({})

    const wrong = host.waitFor('state-2', 5_000)
    const rejected = await fetch(`${redirectUri}?code=code_2&state=state-wrong`)
    expect(rejected.status).toBe(400)
    await host.close()
    await expect(wrong).rejects.toMatchObject({ code: 'cancelled' })
  })
})

describe('Lab OAuth controller', () => {
  it('opens the system browser and exchanges the callback code with the PKCE verifier', async () => {
    const { api, registered } = createApi()
    const credentials = createCredentials()
    const openExternal = vi.fn(async () => undefined)
    const controller = new LabOAuthController({
      api: api as unknown as LabApi,
      credentials: credentials as unknown as LabCredentialStore,
      openExternal
    })

    const challenge = await controller.beginLogin(SERVER)
    expect(challenge.authorizationUrl).toBe(`${SERVER}/oauth/authorize?request_id=req_1`)
    expect(openExternal).toHaveBeenCalledWith(`${SERVER}/oauth/authorize?request_id=req_1`)

    const attempt = registered()!
    const redirectUri = String(attempt.redirectUri)
    const state = String(attempt.state)
    const waiting = controller.waitForLogin()
    await fetch(`${redirectUri}?code=code_1&state=${state}`)
    const session = await waiting

    expect(session).toMatchObject({ accessToken: 'at_1', refreshToken: 'rt_1' })
    expect(credentials.saveSession).toHaveBeenCalledTimes(1)
    const exchange = api.exchangeCode.mock.calls[0]![0] as unknown as {
      codeVerifier: string
      redirectUri: string
    }
    expect(exchange.redirectUri).toBe(redirectUri)
    const challengeFromVerifier = createHash('sha256')
      .update(exchange.codeVerifier)
      .digest('base64url')
    expect(attempt.codeChallenge).toBe(challengeFromVerifier)
  })

  it('accepts a browser callback that arrives before openExternal returns', async () => {
    const { api, registered } = createApi()
    const credentials = createCredentials()
    const openExternal = vi.fn(async () => {
      const attempt = registered()!
      await fetch(`${attempt.redirectUri}?code=fast_code&state=${attempt.state}`)
    })
    const controller = new LabOAuthController({
      api: api as unknown as LabApi,
      credentials: credentials as unknown as LabCredentialStore,
      openExternal
    })
    await expect(controller.beginLogin(SERVER)).resolves.toMatchObject({
      authorizationUrl: `${SERVER}/oauth/authorize?request_id=req_1`
    })
    await expect(controller.waitForLogin()).resolves.toMatchObject({ accessToken: 'at_1' })
  })

  it('does not persist credentials when cancelled while the code is being exchanged', async () => {
    const { api, registered } = createApi()
    let resolveExchange: ((value: unknown) => void) | undefined
    api.exchangeCode.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveExchange = resolve
        })
    )
    const credentials = createCredentials()
    const controller = new LabOAuthController({
      api: api as unknown as LabApi,
      credentials: credentials as unknown as LabCredentialStore,
      openExternal: vi.fn(async () => undefined)
    })
    await controller.beginLogin(SERVER)
    const waiting = controller.waitForLogin().catch((error: unknown) => error)
    const attempt = registered()!
    await fetch(`${attempt.redirectUri}?code=code_1&state=${attempt.state}`)
    await vi.waitFor(() => expect(api.exchangeCode).toHaveBeenCalledTimes(1))

    const cancelling = controller.cancelLogin()
    resolveExchange?.({
      accessToken: 'at_1',
      refreshToken: 'rt_1',
      expiresIn: 900,
      tokenExpiresAt: Date.now() + 900_000
    })
    const error = await waiting
    await cancelling
    expect(error).toBeInstanceOf(LabApiError)
    expect((error as LabApiError).code).toBe('cancelled')
    expect((api.exchangeCode.mock.calls[0]![0] as ExchangeCodeInput).signal?.aborted).toBe(true)
    expect(credentials.saveSession).not.toHaveBeenCalled()
  })

  it('cancels before the callback listener finishes starting', async () => {
    const { api } = createApi()
    const credentials = createCredentials()
    const openExternal = vi.fn(async () => undefined)
    let resolveStart: ((redirectUri: string) => void) | undefined
    const host = {
      start: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveStart = resolve
          })
      ),
      close: vi.fn(async () => undefined),
      waitFor: vi.fn()
    }
    const controller = new LabOAuthController({
      api: api as unknown as LabApi,
      credentials: credentials as unknown as LabCredentialStore,
      openExternal,
      createCallbackHost: () => host as unknown as LabLoopbackCallbackHost
    })
    const starting = controller.beginLogin(SERVER).catch((error: unknown) => error)
    await vi.waitFor(() => expect(host.start).toHaveBeenCalledTimes(1))
    await controller.cancelLogin()
    resolveStart?.('http://127.0.0.1:54321/oauth/callback')
    const error = await starting
    expect(error).toBeInstanceOf(LabApiError)
    expect((error as LabApiError).code).toBe('cancelled')
    expect(api.registerLoginAttempt).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('cancels the registration request before the browser is opened', async () => {
    const { api } = createApi()
    api.registerLoginAttempt.mockImplementation(
      (input: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          input.signal?.addEventListener('abort', () =>
            reject(new LabApiError('cancelled', 'cancelled'))
          )
        })
    )
    const openExternal = vi.fn(async () => undefined)
    const controller = new LabOAuthController({
      api: api as unknown as LabApi,
      credentials: createCredentials() as unknown as LabCredentialStore,
      openExternal
    })
    const starting = controller.beginLogin(SERVER).catch((error: unknown) => error)
    await vi.waitFor(() => expect(api.registerLoginAttempt).toHaveBeenCalledTimes(1))
    await controller.cancelLogin()
    const error = await starting
    expect(error).toBeInstanceOf(LabApiError)
    expect((error as LabApiError).code).toBe('cancelled')
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('cancels a pending sign-in without leaving a listener or promise behind', async () => {
    const { api } = createApi()
    const controller = new LabOAuthController({
      api: api as unknown as LabApi,
      credentials: createCredentials() as unknown as LabCredentialStore,
      openExternal: vi.fn(async () => undefined)
    })
    await controller.beginLogin(SERVER)
    const waiting = controller.waitForLogin().catch((error: unknown) => error)
    await controller.cancelLogin()
    const error = await waiting
    expect(error).toBeInstanceOf(LabApiError)
    expect((error as LabApiError).code).toBe('cancelled')
  })

  it('rejects an authorization address on a different host', async () => {
    const { api } = createApi()
    api.registerLoginAttempt.mockResolvedValueOnce({
      requestId: 'req_2',
      authorizationUrl: 'https://evil.example/oauth/authorize?request_id=req_2',
      expiresAt: Date.now() + 60_000
    })
    const controller = new LabOAuthController({
      api: api as unknown as LabApi,
      credentials: createCredentials() as unknown as LabCredentialStore,
      openExternal: vi.fn(async () => undefined)
    })
    await expect(controller.beginLogin(SERVER)).rejects.toMatchObject({ code: 'invalid-response' })
  })
})
