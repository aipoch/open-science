import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CLAUDE_ISOLATED_PROVIDER_ID,
  CLAUDE_SHARED_PROVIDER_ID,
  CODEX_SUBSCRIPTION_PROVIDER_ID
} from '../../shared/settings'
import type { CodexAuthControllerPort, CodexAuthStatus } from './codex-auth'
import type { ClaudeIsolatedAuthControllerPort } from './claude-isolated-auth'
import type { ClaudeSharedAuthControllerPort, ClaudeSharedAuthStatus } from './claude-shared-auth'
import type { ProviderAuthLifecycleOwnerOptions } from './provider-auth-lifecycle'
import { ProviderRuntimeProjectionOwner } from './provider-runtime-projection'
import type { ValidateProviderResult } from '../../shared/settings'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`cipher:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').slice('cipher:'.length)
  },
  app: { getPath: () => '/home', getAppPath: () => '/home/no-such-app-root', isPackaged: false }
}))

const codexFiles = vi.hoisted(() => ({
  ensureAuthHome: vi.fn(async () => undefined),
  importAuthentication: vi.fn(async () => undefined)
}))

vi.mock('./codex-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./codex-auth')>()
  return {
    ...actual,
    ensureCodexAuthHome: codexFiles.ensureAuthHome,
    importCodexAuthentication: codexFiles.importAuthentication
  }
})

const { ProviderAuthLifecycleOwner } = await import('./provider-auth-lifecycle')
const { SettingsRepository } = await import('./repository')

const deferred = <T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('ProviderAuthLifecycleOwner', () => {
  let dir: string
  let repository: InstanceType<typeof SettingsRepository>
  let codexAuth: CodexAuthControllerPort
  let claudeIsolatedAuth: ClaudeIsolatedAuthControllerPort
  let claudeSharedAuth: ClaudeSharedAuthControllerPort
  let runClaudeSubscriptionProbe: ProviderAuthLifecycleOwnerOptions['runClaudeSubscriptionProbe']
  let owner: InstanceType<typeof ProviderAuthLifecycleOwner>

  beforeEach(async () => {
    vi.useRealTimers()
    codexFiles.ensureAuthHome.mockReset().mockResolvedValue(undefined)
    codexFiles.importAuthentication.mockReset().mockResolvedValue(undefined)
    dir = await mkdtemp(join(tmpdir(), 'osci-provider-auth-'))
    repository = new SettingsRepository(dir)
    await repository.upsertProvider({
      id: CLAUDE_SHARED_PROVIDER_ID,
      type: 'claude-shared',
      name: 'Claude shared',
      apiEndpoints: ['anthropic']
    })
    codexAuth = {
      getStatus: vi.fn(async (mode: CodexAuthStatus['mode'] = 'isolated') => ({
        mode,
        supported: true,
        authenticated: true
      })),
      loginIsolated: vi.fn(async (): Promise<CodexAuthStatus> => ({
        mode: 'isolated',
        supported: true,
        authenticated: true
      })),
      cancelLogin: vi.fn(async () => undefined),
      logoutIsolated: vi.fn(async (): Promise<CodexAuthStatus> => ({
        mode: 'isolated',
        supported: true,
        authenticated: false
      }))
    }
    claudeIsolatedAuth = {
      getStatus: vi.fn(async () => ({ supported: true, authenticated: false })),
      loginIsolatedBrowser: vi.fn(async () => ({ supported: true, authenticated: false })),
      loginIsolated: vi.fn(async () => ({ supported: true, authenticated: false })),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn(async () => ({ supported: true, authenticated: false }))
    }
    claudeSharedAuth = {
      getStatus: vi.fn(async () => ({ supported: true, authenticated: true })),
      loginShared: vi.fn(async () => ({ supported: true, authenticated: true })),
      cancelLogin: vi.fn()
    }
    runClaudeSubscriptionProbe = vi.fn(async () => ({ ok: true, category: 'ok' as const }))
    const projection = new ProviderRuntimeProjectionOwner()
    owner = new ProviderAuthLifecycleOwner({
      repository,
      storageRoot: dir,
      userClaudeDir: join(dir, 'user-claude'),
      userCodexDir: join(dir, 'user-codex'),
      resolveCodexExecutable: vi.fn(async () => '/codex-acp'),
      resolveCodexProxyEnvironment: vi.fn(async () => undefined),
      runClaudeSubscriptionProbe,
      resolveProvider: (provider, model) => projection.resolveProvider(provider, model),
      codexAuth,
      claudeIsolatedAuth,
      claudeSharedAuth
    })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await rm(dir, { recursive: true, force: true })
  })

  it('coalesces shared status reads and invalidates them across logout and login', async () => {
    const stored = (await repository.getSettings()).providers[0]
    const firstStatus = deferred<ClaudeSharedAuthStatus>()
    vi.mocked(claudeSharedAuth.getStatus).mockImplementationOnce(() => firstStatus.promise)

    const first = owner.isProviderKeyUsable(stored)
    const second = owner.isProviderKeyUsable(stored)
    expect(claudeSharedAuth.getStatus).toHaveBeenCalledOnce()
    firstStatus.resolve({ supported: true, authenticated: true })
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])

    await owner.logoutClaudeShared()
    const disconnected = (await repository.getSettings()).providers[0]
    await expect(owner.isProviderKeyUsable(disconnected)).resolves.toBe(false)
    expect(claudeSharedAuth.getStatus).toHaveBeenCalledOnce()

    await owner.loginClaudeShared()
    const reconnected = (await repository.getSettings()).providers[0]
    await expect(owner.isProviderKeyUsable(reconnected)).resolves.toBe(true)
    expect(reconnected.lastValidatedTarget).toEqual({ endpoint: 'anthropic' })
    expect(claudeSharedAuth.getStatus).toHaveBeenCalledTimes(2)
  })

  it('cancels the matching authentication owners before cleanup completes', async () => {
    await owner.cleanupProviderBeforeDelete('builtin-codex-subscription')
    expect(codexAuth.cancelLogin).toHaveBeenCalledOnce()
    expect(claudeIsolatedAuth.cancelLogin).not.toHaveBeenCalled()
    expect(claudeSharedAuth.cancelLogin).not.toHaveBeenCalled()

    await owner.cleanupProviderBeforeDelete(CLAUDE_SHARED_PROVIDER_ID)
    expect(claudeIsolatedAuth.cancelLogin).toHaveBeenCalledOnce()
    expect(claudeSharedAuth.cancelLogin).toHaveBeenCalledOnce()
  })

  it('does not apply a shared login result after its provider target changes', async () => {
    const login = deferred<ClaudeSharedAuthStatus>()
    vi.mocked(claudeSharedAuth.loginShared).mockImplementationOnce(() => login.promise)

    const result = owner.loginClaudeShared()
    await vi.waitFor(() => expect(claudeSharedAuth.loginShared).toHaveBeenCalledOnce())
    const stored = (await repository.getSettings()).providers[0]
    await repository.upsertProvider({ ...stored, name: 'Changed while signing in' })
    login.resolve({ supported: true, authenticated: true })

    await expect(result).resolves.toMatchObject({ ok: true, applied: false })
    expect((await repository.getSettings()).providers[0].name).toBe('Changed while signing in')
  })

  it('invalidates reimported Codex validation before auth-home finalization can fail', async () => {
    const ensure = deferred<undefined>()
    codexFiles.ensureAuthHome.mockImplementationOnce(() => ensure.promise)
    const invalidated = vi.fn()
    const prepared = owner.prepareCodexProviderUpsert(
      { type: 'codex-shared', reimportCodexAuthentication: true },
      undefined,
      invalidated
    )
    const failed = expect(prepared).rejects.toThrow('auth home failed')

    await vi.waitFor(() => expect(codexFiles.importAuthentication).toHaveBeenCalledOnce())
    expect(invalidated).toHaveBeenCalledOnce()
    ensure.reject(new Error('auth home failed'))
    await failed
  })

  it('applies an isolated Codex login result to the current provider', async () => {
    await repository.deleteProvider(CLAUDE_SHARED_PROVIDER_ID)
    await repository.upsertProvider({
      id: CODEX_SUBSCRIPTION_PROVIDER_ID,
      type: 'codex-isolated',
      codexAuthMode: 'isolated',
      name: 'Open Science Codex login',
      apiEndpoints: ['responses']
    })

    await expect(owner.loginIsolatedCodex()).resolves.toMatchObject({
      ok: true,
      category: 'ok',
      applied: true
    })
    expect((await repository.getSettings()).providers[0].lastValidatedAt).toBeTypeOf('number')
  })

  it('does not apply an isolated Claude probe after its credential changes', async () => {
    await repository.deleteProvider(CLAUDE_SHARED_PROVIDER_ID)
    await repository.upsertProvider({
      id: CLAUDE_ISOLATED_PROVIDER_ID,
      type: 'claude-isolated',
      name: 'Open Science Claude login',
      apiEndpoints: ['anthropic'],
      keyRef: 'plain:old-token'
    })
    vi.mocked(claudeIsolatedAuth.loginIsolated).mockResolvedValueOnce({
      supported: true,
      authenticated: true
    })
    const probe = deferred<ValidateProviderResult>()
    vi.mocked(runClaudeSubscriptionProbe).mockImplementationOnce(() => probe.promise)

    const result = owner.loginIsolatedClaude('old-token')
    await vi.waitFor(() => expect(runClaudeSubscriptionProbe).toHaveBeenCalledOnce())
    const stored = (await repository.getSettings()).providers[0]
    await repository.upsertProvider({ ...stored, keyRef: 'plain:new-token' })
    probe.resolve({ ok: true, category: 'ok' })

    await expect(result).resolves.toMatchObject({ ok: true, applied: false })
    expect((await repository.getSettings()).providers[0].keyRef).toBe('plain:new-token')
  })

  it('reports isolated Claude logout failure and clears validation only on logout truth', async () => {
    await repository.deleteProvider(CLAUDE_SHARED_PROVIDER_ID)
    await repository.upsertProvider({
      id: CLAUDE_ISOLATED_PROVIDER_ID,
      type: 'claude-isolated',
      name: 'Open Science Claude login',
      apiEndpoints: ['anthropic'],
      expiresAt: 123,
      lastValidatedAt: 456
    })
    vi.mocked(claudeIsolatedAuth.logoutIsolated).mockResolvedValueOnce({
      supported: true,
      authenticated: true,
      message: 'Logout timed out.'
    })

    await expect(owner.logoutIsolatedClaude()).resolves.toMatchObject({
      ok: false,
      category: 'timeout',
      message: 'Logout timed out.'
    })
    expect((await repository.getSettings()).providers[0]).toMatchObject({
      expiresAt: 123,
      lastValidatedAt: 456
    })

    vi.mocked(claudeIsolatedAuth.logoutIsolated).mockResolvedValueOnce({
      supported: true,
      authenticated: false
    })
    await expect(owner.logoutIsolatedClaude()).resolves.toMatchObject({ ok: true, category: 'ok' })
    expect((await repository.getSettings()).providers[0]).not.toHaveProperty('expiresAt')
    expect((await repository.getSettings()).providers[0]).not.toHaveProperty('lastValidatedAt')
  })

  it('refreshes the shared Claude status after its cache TTL', async () => {
    vi.useFakeTimers()
    const stored = (await repository.getSettings()).providers[0]

    await expect(owner.isProviderKeyUsable(stored)).resolves.toBe(true)
    await expect(owner.isProviderKeyUsable(stored)).resolves.toBe(true)
    expect(claudeSharedAuth.getStatus).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(5_001)
    await expect(owner.isProviderKeyUsable(stored)).resolves.toBe(true)
    expect(claudeSharedAuth.getStatus).toHaveBeenCalledTimes(2)
  })

  it('reports shared and isolated Claude status through the lifecycle Interface', async () => {
    await expect(owner.getClaudeSharedStatus()).resolves.toMatchObject({
      ok: true,
      category: 'ok'
    })
    expect(runClaudeSubscriptionProbe).toHaveBeenCalledOnce()

    await repository.deleteProvider(CLAUDE_SHARED_PROVIDER_ID)
    await expect(owner.getClaudeSharedStatus()).resolves.toEqual({
      ok: false,
      category: 'unknown',
      message: 'Claude subscription provider is not configured.'
    })

    await repository.upsertProvider({
      id: CLAUDE_ISOLATED_PROVIDER_ID,
      type: 'claude-isolated',
      name: 'Open Science Claude login',
      apiEndpoints: ['anthropic'],
      keyRef: 'plain:setup-token'
    })
    vi.mocked(claudeIsolatedAuth.getStatus).mockResolvedValueOnce({
      supported: true,
      authenticated: true
    })
    await expect(owner.getClaudeIsolatedStatus()).resolves.toMatchObject({
      ok: true,
      category: 'ok'
    })
    expect(runClaudeSubscriptionProbe).toHaveBeenCalledTimes(2)
  })

  it('owns browser cancellation and explicit login cancellation', async () => {
    await repository.deleteProvider(CLAUDE_SHARED_PROVIDER_ID)
    await repository.upsertProvider({
      id: CLAUDE_ISOLATED_PROVIDER_ID,
      type: 'claude-isolated',
      name: 'Open Science Claude login',
      apiEndpoints: ['anthropic']
    })
    vi.mocked(claudeIsolatedAuth.loginIsolatedBrowser).mockResolvedValueOnce({
      supported: true,
      authenticated: false,
      cancelled: true,
      message: 'Sign-in cancelled.'
    })

    await expect(owner.loginIsolatedClaudeBrowser()).resolves.toEqual({
      ok: false,
      category: 'unknown',
      message: 'Sign-in cancelled.',
      applied: false,
      cancelled: true
    })

    owner.cancelCodexLogin()
    owner.cancelClaudeLogin()
    await owner.cancelClaudeIsolatedLogin()
    expect(codexAuth.cancelLogin).toHaveBeenCalledOnce()
    expect(claudeSharedAuth.cancelLogin).toHaveBeenCalledOnce()
    expect(claudeIsolatedAuth.cancelLogin).toHaveBeenCalledOnce()
  })
})
