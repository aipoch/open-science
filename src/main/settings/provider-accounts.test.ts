import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CodexAuthControllerPort, CodexAuthStatus } from './codex-auth'
import type { ClaudeIsolatedAuthControllerPort } from './claude-isolated-auth'
import type { ClaudeSharedAuthControllerPort, ClaudeSharedAuthStatus } from './claude-shared-auth'
import type { ValidateProviderResult } from '../../shared/settings'
import type { ResolvedProvider } from './provider-env'
import type { StoredSettings } from './types'
import { getAgentFramework } from '../agent-framework'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`cipher:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').slice('cipher:'.length)
  },
  app: { getPath: () => '/home', getAppPath: () => '/home/no-such-app-root', isPackaged: false }
}))

const { ProviderAccountsModule } = await import('./provider-accounts')
const { SettingsRepository } = await import('./repository')

const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('ProviderAccountsModule', () => {
  let dir: string
  let repository: InstanceType<typeof SettingsRepository>
  let codexAuth: CodexAuthControllerPort
  let claudeIsolatedAuth: ClaudeIsolatedAuthControllerPort
  let claudeSharedAuth: ClaudeSharedAuthControllerPort
  let module: InstanceType<typeof ProviderAccountsModule>
  let runClaudeSubscriptionProbe: (
    provider: ResolvedProvider,
    settings: StoredSettings
  ) => Promise<ValidateProviderResult>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'osci-provider-accounts-'))
    repository = new SettingsRepository(dir)
    let settingsIdSequence = 0
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
    runClaudeSubscriptionProbe = vi.fn(async (): Promise<ValidateProviderResult> => ({
      ok: true,
      category: 'ok'
    }))
    module = new ProviderAccountsModule({
      repository,
      storageRoot: dir,
      userClaudeDir: join(dir, 'user-claude'),
      userCodexDir: join(dir, 'user-codex'),
      allocateSettingsIdSequence: () => {
        settingsIdSequence += 1
        return settingsIdSequence
      },
      resolveCodexExecutable: vi.fn(async () => '/codex-acp'),
      resolveCodexProxyEnvironment: vi.fn(async () => undefined),
      runClaudeSubscriptionProbe,
      codexAuth,
      claudeIsolatedAuth,
      claudeSharedAuth
    })

    return async () => {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('owns custom provider persistence, projection, selection, and deletion', async () => {
    await module.upsertProvider({
      type: 'custom',
      name: 'Lab gateway',
      baseUrl: 'https://lab.example/v1',
      model: 'lab-model',
      key: 'secret-key',
      apiEndpoints: ['openai']
    })

    let settings = await repository.getSettings()
    const stored = settings.providers[0]
    expect(stored.id).toMatch(/^p_/)
    expect(stored.keyRef).toMatch(/^enc:/)
    expect(module.toProviderView(stored)).toMatchObject({
      id: stored.id,
      name: 'Lab gateway',
      models: ['lab-model'],
      maskedKey: 'secr…-key',
      hasKey: true,
      needsKey: false
    })

    await module.setActiveProvider(stored.id, 'unknown-model')
    settings = await repository.getSettings()
    expect(settings.activeProviderId).toBe(stored.id)
    expect(settings.activeModel).toBe('lab-model')

    await module.deleteProvider(stored.id)
    expect((await repository.getSettings()).providers).toEqual([])
  })

  it('projects an ephemeral runtime target without changing the stored provider selection', async () => {
    await module.upsertProvider({
      type: 'custom',
      name: 'Lab gateway',
      baseUrl: 'https://lab.example/v1',
      model: 'lab-model',
      key: 'secret-key',
      apiEndpoints: ['openai']
    })
    const before = await repository.getSettings()
    const stored = before.providers[0]

    const target = module.resolveRuntimeTarget(
      stored,
      { kind: 'configured', requestedModel: 'unavailable-model' },
      getAgentFramework('codex')
    )

    expect(target).toMatchObject({
      providerId: stored.id,
      effectiveModel: 'lab-model',
      provider: { model: 'lab-model', key: 'secret-key' },
      needsChatResponsesBridge: true
    })
    expect(module.resolveRuntimeReasoningEffortProfile(stored, 'lab-model')).toMatchObject({
      supported: true
    })
    expect(await repository.getSettings()).toEqual(before)
    expect(JSON.stringify(before)).not.toContain('secret-key')
  })

  it('rejects an unavailable required model instead of applying the configured fallback', async () => {
    await module.upsertProvider({
      type: 'custom',
      name: 'Lab gateway',
      baseUrl: 'https://lab.example/v1',
      model: 'lab-model',
      key: 'secret-key',
      apiEndpoints: ['openai']
    })
    const before = await repository.getSettings()
    const stored = before.providers[0]

    expect(() =>
      module.resolveRuntimeTarget(
        stored,
        { kind: 'required', model: 'unavailable-model' },
        getAgentFramework('codex')
      )
    ).toThrow(
      `The requested model "unavailable-model" is not available for provider "Lab gateway".`
    )
    expect(await repository.getSettings()).toEqual(before)
  })

  it('keeps an exact required model when a subscription catalog is unknown', async () => {
    await module.upsertProvider({ type: 'claude-shared' })
    const before = await repository.getSettings()
    const stored = before.providers[0]

    const target = module.resolveRuntimeTarget(
      stored,
      { kind: 'required', model: 'account-model' },
      getAgentFramework('claude-code')
    )

    expect(target).toMatchObject({
      effectiveModel: 'account-model',
      provider: { model: 'account-model' }
    })
    expect(await repository.getSettings()).toEqual(before)
  })

  it('keeps only the newest validation result for one provider id', async () => {
    await module.upsertProvider({ type: 'codex-isolated' })
    const firstStatus = deferred<CodexAuthStatus>()
    vi.mocked(codexAuth.getStatus)
      .mockImplementationOnce(() => firstStatus.promise)
      .mockResolvedValueOnce({
        mode: 'isolated',
        supported: true,
        authenticated: true
      })

    const first = module.validateProvider({ providerId: 'builtin-codex-subscription' })
    await vi.waitFor(() => expect(codexAuth.getStatus).toHaveBeenCalledOnce())
    const second = await module.validateProvider({ providerId: 'builtin-codex-subscription' })
    firstStatus.resolve({
      mode: 'isolated',
      supported: true,
      authenticated: false,
      message: 'old failure'
    })

    expect(second).toMatchObject({ ok: true, applied: true })
    await expect(first).resolves.toMatchObject({ ok: false, applied: false })
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.lastValidatedAt).toBeTypeOf('number')
    expect(stored.lastValidationFailure).toBeUndefined()
  })

  it('coalesces shared Claude status reads and invalidates them across logout and login', async () => {
    await module.upsertProvider({ type: 'claude-shared' })
    const stored = (await repository.getSettings()).providers[0]
    const firstStatus = deferred<ClaudeSharedAuthStatus>()
    vi.mocked(claudeSharedAuth.getStatus).mockImplementationOnce(() => firstStatus.promise)

    const first = module.isProviderKeyUsable(stored)
    const second = module.isProviderKeyUsable(stored)
    expect(claudeSharedAuth.getStatus).toHaveBeenCalledOnce()
    firstStatus.resolve({ supported: true, authenticated: true })
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])

    await module.logoutClaudeShared()
    const disconnected = (await repository.getSettings()).providers[0]
    await expect(module.isProviderKeyUsable(disconnected)).resolves.toBe(false)
    expect(claudeSharedAuth.getStatus).toHaveBeenCalledOnce()

    await module.loginClaudeShared()
    const reconnected = (await repository.getSettings()).providers[0]
    await expect(module.isProviderKeyUsable(reconnected)).resolves.toBe(true)
    expect(claudeSharedAuth.getStatus).toHaveBeenCalledTimes(2)
  })

  it('cancels the correct authentication owners before deleting subscription records', async () => {
    await module.upsertProvider({ type: 'codex-isolated' })
    await module.deleteProvider('builtin-codex-subscription')
    expect(codexAuth.cancelLogin).toHaveBeenCalledOnce()

    await module.upsertProvider({ type: 'claude-isolated' })
    await module.upsertProvider({ type: 'claude-shared' })
    await module.deleteProvider('builtin-claude-shared')
    expect(claudeIsolatedAuth.cancelLogin).toHaveBeenCalledOnce()
    expect(claudeSharedAuth.cancelLogin).toHaveBeenCalledOnce()
    expect((await repository.getSettings()).providers).toEqual([])
  })
})
