import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { codexSubscriptionStorageDir } from '../agent-framework/codex'
import {
  CodexAuthController,
  createCodexAuthEnvironment,
  ensureCodexAuthHome,
  type CodexAuthSession
} from './codex-auth'

const session = (overrides: Partial<CodexAuthSession> = {}): CodexAuthSession => ({
  initialize: vi.fn().mockResolvedValue({
    authMethods: [{ id: 'api-key' }, { id: 'chat-gpt' }]
  }),
  status: vi.fn().mockResolvedValue({
    type: 'chat-gpt',
    email: 'private@example.test'
  }),
  authenticateChatGpt: vi.fn().mockResolvedValue(undefined),
  logout: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  ...overrides
})

describe('ensureCodexAuthHome', () => {
  it('creates the isolated home up front and never touches the shared profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-auth-home-'))
    try {
      // Shared mode uses the user's real ~/.codex; nothing may be created under the storage root.
      await ensureCodexAuthHome('shared', root)
      expect(existsSync(codexSubscriptionStorageDir(root))).toBe(false)

      // Codex exits hard when CODEX_HOME is missing (fatal on Windows), so the isolated home must
      // exist before the first sign-in ever spawns the process.
      await ensureCodexAuthHome('isolated', root)
      expect(existsSync(codexSubscriptionStorageDir(root))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('createCodexAuthEnvironment', () => {
  it('keeps the shared profile on native defaults and isolates the app login', () => {
    const source = {
      PATH: 'bin',
      CODEX_HOME: 'wrong',
      CODEX_PATH: 'wrong',
      CODEX_CONFIG: '{}',
      MODEL_PROVIDER: 'wrong',
      NO_BROWSER: '1',
      OPENAI_API_KEY: 'secret'
    }

    const shared = createCodexAuthEnvironment('shared', '/data', source)
    expect(shared).toMatchObject({ PATH: expect.stringContaining('bin') })
    expect(shared).not.toHaveProperty('CODEX_HOME')
    expect(shared).not.toHaveProperty('CODEX_PATH')
    expect(shared).not.toHaveProperty('CODEX_CONFIG')
    expect(shared).not.toHaveProperty('MODEL_PROVIDER')
    expect(shared).not.toHaveProperty('NO_BROWSER')
    expect(shared).not.toHaveProperty('OPENAI_API_KEY')

    expect(createCodexAuthEnvironment('isolated', '/data', source)).toMatchObject({
      PATH: expect.stringContaining('bin'),
      CODEX_HOME: expect.stringMatching(/[\\/]data[\\/]codex-subscription$/)
    })
  })
})

describe('CodexAuthController', () => {
  it('capability-gates subscription support and never exposes the account email', async () => {
    const supported = session()
    const controller = new CodexAuthController({
      openSession: vi.fn().mockResolvedValue(supported)
    })

    await expect(controller.getStatus('shared')).resolves.toEqual({
      mode: 'shared',
      supported: true,
      authenticated: true
    })
    expect(JSON.stringify(await controller.getStatus('shared'))).not.toContain(
      'private@example.test'
    )

    const unsupported = session({
      initialize: vi.fn().mockResolvedValue({ authMethods: [{ id: 'api-key' }] })
    })
    const unsupportedController = new CodexAuthController({
      openSession: vi.fn().mockResolvedValue(unsupported)
    })
    await expect(unsupportedController.getStatus('shared')).resolves.toEqual({
      mode: 'shared',
      supported: false,
      authenticated: false,
      message: 'The installed codex-acp does not advertise ChatGPT authentication.'
    })
  })

  it('treats api-key and gateway profiles as authenticated', async () => {
    for (const type of ['api-key', 'gateway'] as const) {
      const apiKeySession = session({
        status: vi.fn().mockResolvedValue({ type })
      })
      const controller = new CodexAuthController({
        openSession: vi.fn().mockResolvedValue(apiKeySession)
      })

      await expect(controller.getStatus('shared')).resolves.toEqual({
        mode: 'shared',
        supported: true,
        authenticated: true
      })

      await expect(controller.loginIsolated()).resolves.toEqual({
        mode: 'isolated',
        supported: true,
        authenticated: true
      })
      expect(apiKeySession.authenticateChatGpt).not.toHaveBeenCalled()
    }
  })

  it('signs into the isolated profile and confirms the resulting account', async () => {
    const isolated = session({
      status: vi
        .fn()
        .mockResolvedValueOnce({ type: 'unauthenticated' })
        .mockResolvedValueOnce({ type: 'chat-gpt', email: 'hidden@example.test' })
    })
    const controller = new CodexAuthController({
      openSession: vi.fn().mockResolvedValue(isolated)
    })

    await expect(controller.loginIsolated()).resolves.toEqual({
      mode: 'isolated',
      supported: true,
      authenticated: true
    })
    expect(isolated.authenticateChatGpt).toHaveBeenCalledOnce()
    expect(vi.mocked(isolated.close)).toHaveBeenCalledOnce()
  })

  it('cancels a pending isolated login and reports it without leaking the account', async () => {
    const isolated = session({
      status: vi.fn().mockResolvedValue({ type: 'unauthenticated' }),
      authenticateChatGpt: vi.fn(() => new Promise<void>(() => undefined))
    })
    const controller = new CodexAuthController({
      openSession: vi.fn().mockResolvedValue(isolated),
      loginTimeoutMs: 60_000
    })

    const pending = controller.loginIsolated()
    await vi.waitFor(() => expect(isolated.authenticateChatGpt).toHaveBeenCalledOnce())
    controller.cancelLogin()

    await expect(pending).resolves.toEqual({
      mode: 'isolated',
      supported: true,
      authenticated: false,
      message: 'Codex sign-in was cancelled.'
    })
    expect(vi.mocked(isolated.close)).toHaveBeenCalledOnce()
  })

  it('times out while isolated login initialization is stalled', async () => {
    vi.useFakeTimers()
    let resolveInitialize!: (value: { authMethods: { id: string }[] }) => void
    const initialize = new Promise<{ authMethods: { id: string }[] }>((resolve) => {
      resolveInitialize = resolve
    })
    const isolated = session({
      initialize: vi.fn(() => initialize)
    })
    const controller = new CodexAuthController({
      openSession: vi.fn().mockResolvedValue(isolated),
      loginTimeoutMs: 10
    })
    let outcome: Awaited<ReturnType<CodexAuthController['loginIsolated']>> | undefined
    const pending = controller.loginIsolated().then((result) => {
      outcome = result
    })

    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10)
    await Promise.resolve()

    try {
      expect(outcome).toEqual({
        mode: 'isolated',
        supported: true,
        authenticated: false,
        message: 'Codex sign-in timed out after five minutes.'
      })
      expect(vi.mocked(isolated.close)).toHaveBeenCalledOnce()
    } finally {
      resolveInitialize({ authMethods: [{ id: 'chat-gpt' }] })
      await pending
      vi.useRealTimers()
    }
  })

  it('times out before an auth session opens and closes the late session', async () => {
    vi.useFakeTimers()
    let resolveSession!: (value: CodexAuthSession) => void
    const sessionPromise = new Promise<CodexAuthSession>((resolve) => {
      resolveSession = resolve
    })
    const isolated = session()
    const controller = new CodexAuthController({
      openSession: vi.fn(() => sessionPromise),
      loginTimeoutMs: 10
    })
    let outcome: Awaited<ReturnType<CodexAuthController['loginIsolated']>> | undefined
    const pending = controller.loginIsolated().then((result) => {
      outcome = result
    })

    await vi.advanceTimersByTimeAsync(10)
    await pending

    try {
      expect(outcome?.message).toBe('Codex sign-in timed out after five minutes.')
      resolveSession(isolated)
      await Promise.resolve()
      await Promise.resolve()
      expect(vi.mocked(isolated.close)).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels isolated login while initialization is stalled', async () => {
    let resolveInitialize!: (value: { authMethods: { id: string }[] }) => void
    const initialize = new Promise<{ authMethods: { id: string }[] }>((resolve) => {
      resolveInitialize = resolve
    })
    const isolated = session({ initialize: vi.fn(() => initialize) })
    const controller = new CodexAuthController({
      openSession: vi.fn().mockResolvedValue(isolated),
      loginTimeoutMs: 60_000
    })
    const pending = controller.loginIsolated()
    await Promise.resolve()

    controller.cancelLogin()

    await expect(pending).resolves.toEqual({
      mode: 'isolated',
      supported: true,
      authenticated: false,
      message: 'Codex sign-in was cancelled.'
    })
    expect(vi.mocked(isolated.close)).toHaveBeenCalledOnce()
    resolveInitialize({ authMethods: [{ id: 'chat-gpt' }] })
  })

  it('cancels isolated login while authentication status is stalled', async () => {
    let resolveStatus!: (value: { type: 'unauthenticated' }) => void
    const status = new Promise<{ type: 'unauthenticated' }>((resolve) => {
      resolveStatus = resolve
    })
    const isolated = session({ status: vi.fn(() => status) })
    const controller = new CodexAuthController({
      openSession: vi.fn().mockResolvedValue(isolated),
      loginTimeoutMs: 60_000
    })
    const pending = controller.loginIsolated()
    await vi.waitFor(() => expect(isolated.status).toHaveBeenCalledOnce())

    controller.cancelLogin()

    await expect(pending).resolves.toMatchObject({
      authenticated: false,
      message: 'Codex sign-in was cancelled.'
    })
    expect(vi.mocked(isolated.close)).toHaveBeenCalledOnce()
    resolveStatus({ type: 'unauthenticated' })
  })

  it('logs out only the isolated profile', async () => {
    const isolated = session()
    const controller = new CodexAuthController({
      openSession: vi.fn().mockResolvedValue(isolated)
    })

    await expect(controller.logoutIsolated()).resolves.toEqual({
      mode: 'isolated',
      supported: true,
      authenticated: false
    })
    expect(vi.mocked(isolated.logout)).toHaveBeenCalledOnce()
  })
})
