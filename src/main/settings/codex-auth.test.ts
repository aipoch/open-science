import { describe, expect, it, vi } from 'vitest'

import {
  CodexAuthController,
  createCodexAuthEnvironment,
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
  it('prefers an existing shared Codex login before the isolated Open Science profile', async () => {
    const shared = session({ status: vi.fn().mockResolvedValue({ type: 'chat-gpt' }) })
    const isolated = session({ status: vi.fn().mockResolvedValue({ type: 'chat-gpt' }) })
    const controller = new CodexAuthController({
      openSession: vi.fn().mockImplementation((mode) =>
        Promise.resolve(mode === 'shared' ? shared : isolated)
      )
    })

    await expect(controller.getPreferredStatus()).resolves.toMatchObject({
      mode: 'shared',
      authenticated: true
    })
    expect(isolated.initialize).not.toHaveBeenCalled()
  })

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
