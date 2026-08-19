import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CodexAuthControllerPort, CodexAuthStatus } from './codex-auth'
import type { ClaudeIsolatedAuthControllerPort } from './claude-isolated-auth'
import type { ClaudeSharedAuthControllerPort, ClaudeSharedAuthStatus } from './claude-shared-auth'
import type { ValidateProviderResult } from '../../shared/settings'
import type { ResolvedProvider } from './provider-env'
import type { StoredSettings } from './types'
import { getAgentFramework } from '../agent-framework'
import { codexSubscriptionStorageDir } from '../agent-framework/codex'

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

  it('rejects a stale update without recreating the deleted provider', async () => {
    const draft = {
      type: 'custom' as const,
      name: 'Lab gateway',
      baseUrl: 'https://lab.example/v1',
      model: 'lab-model',
      key: 'secret-key',
      apiEndpoints: ['openai' as const]
    }
    await module.upsertProvider(draft)
    const providerId = (await repository.getSettings()).providers[0].id
    await module.deleteProvider(providerId)

    await expect(
      module.upsertProvider({ ...draft, id: providerId, requireExisting: true })
    ).rejects.toThrow('Provider no longer exists.')
    expect((await repository.getSettings()).providers).toEqual([])
  })

  it('serializes Codex edits with deletion so authentication is not restored after removal', async () => {
    const userCodexDir = join(dir, 'user-codex')
    await mkdir(userCodexDir, { recursive: true })
    await writeFile(join(userCodexDir, 'auth.json'), JSON.stringify({ tokens: { access: 'user' } }))
    await module.upsertProvider({ type: 'codex-isolated' })

    const editCancellation = deferred<void>()
    const deleteCancellation = deferred<void>()
    vi.mocked(codexAuth.cancelLogin)
      .mockImplementationOnce(() => editCancellation.promise)
      .mockImplementationOnce(() => deleteCancellation.promise)
    const edit = module
      .upsertProvider({
        id: 'builtin-codex-subscription',
        type: 'codex-shared',
        requireExisting: true
      })
      .then(
        () => 'saved' as const,
        () => 'rejected' as const
      )
    await vi.waitFor(() => expect(codexAuth.cancelLogin).toHaveBeenCalledOnce())

    const deletion = module.deleteProvider('builtin-codex-subscription')
    const deletionEnteredDuringEdit = vi.mocked(codexAuth.cancelLogin).mock.calls.length === 2
    if (deletionEnteredDuringEdit) {
      deleteCancellation.resolve()
      await deletion
      editCancellation.resolve()
    } else {
      editCancellation.resolve()
      await expect(edit).resolves.toBe('saved')
      await vi.waitFor(() => expect(codexAuth.cancelLogin).toHaveBeenCalledTimes(2))
      deleteCancellation.resolve()
    }
    await Promise.allSettled([edit, deletion])

    await expect(
      readFile(join(codexSubscriptionStorageDir(dir), 'auth.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(deletionEnteredDuringEdit).toBe(false)
    expect((await repository.getSettings()).providers).toEqual([])
  })

  it.each([
    {
      sourceType: 'claude-isolated',
      sourceId: 'builtin-claude-isolated',
      destinationType: 'claude-shared',
      destinationId: 'builtin-claude-shared'
    },
    {
      sourceType: 'claude-shared',
      sourceId: 'builtin-claude-shared',
      destinationType: 'claude-isolated',
      destinationId: 'builtin-claude-isolated'
    }
  ] as const)(
    'allows a require-existing edit from $sourceType to $destinationType',
    async ({ sourceType, sourceId, destinationType, destinationId }) => {
      await module.upsertProvider({ type: sourceType })

      await expect(
        module.upsertProvider({ id: sourceId, type: destinationType, requireExisting: true })
      ).resolves.toBeUndefined()

      expect((await repository.getSettings()).providers.map((provider) => provider.id)).toEqual(
        expect.arrayContaining([sourceId, destinationId])
      )
    }
  )

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
    expect(module.resolveProviderApiEndpoints(stored)).toEqual(['openai'])
    expect(module.resolveProvider(stored)).toMatchObject({
      baseUrl: 'https://lab.example/v1',
      model: 'lab-model',
      key: 'secret-key'
    })
    expect(module.resolveRuntimeModelCatalog(stored, getAgentFramework('codex'))).toEqual([
      expect.objectContaining({ providerId: stored.id, effectiveModel: 'lab-model' })
    ])
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

  it('exposes authentication lifecycle operations through the Module Interface', async () => {
    await module.upsertProvider({ type: 'codex-isolated' })

    module.cancelCodexLogin()
    expect(codexAuth.cancelLogin).toHaveBeenCalledOnce()
    await expect(module.loginIsolatedCodex()).resolves.toMatchObject({
      ok: true,
      category: 'ok',
      applied: true
    })

    await module.upsertProvider({ type: 'claude-isolated' })
    vi.mocked(claudeIsolatedAuth.loginIsolated).mockResolvedValueOnce({
      supported: true,
      authenticated: true
    })
    vi.mocked(claudeIsolatedAuth.loginIsolatedBrowser).mockResolvedValueOnce({
      supported: true,
      authenticated: false,
      cancelled: true,
      message: 'Sign-in cancelled.'
    })

    await expect(module.loginIsolatedClaude('setup-token')).resolves.toMatchObject({
      ok: true,
      category: 'ok',
      applied: true
    })
    await expect(module.loginIsolatedClaudeBrowser()).resolves.toMatchObject({
      ok: false,
      applied: false,
      cancelled: true
    })
    await module.cancelClaudeIsolatedLogin()
    expect(claudeIsolatedAuth.cancelLogin).toHaveBeenCalledOnce()

    module.cancelClaudeLogin()
    expect(claudeSharedAuth.cancelLogin).toHaveBeenCalledOnce()
  })

  it('returns bounded failures for missing model catalogs and incompatible drafts', async () => {
    await expect(module.refreshProviderModels({ providerId: 'missing-provider' })).resolves.toEqual(
      {
        ok: false,
        category: 'unknown',
        message: 'Provider not found.'
      }
    )

    await module.upsertProvider({
      type: 'custom',
      name: 'No catalog',
      baseUrl: 'https://lab.example/v1',
      model: 'lab-model',
      key: 'secret-key',
      apiEndpoints: ['openai']
    })
    const providerId = (await repository.getSettings()).providers[0].id
    await expect(module.refreshProviderModels({ providerId })).resolves.toEqual({
      ok: false,
      category: 'unknown',
      message: 'This provider has no model-list endpoint.'
    })

    await expect(
      module.validateProvider({
        draft: {
          type: 'custom',
          baseUrl: 'https://lab.example/v1',
          model: 'lab-model',
          key: 'secret-key',
          apiEndpoints: ['openai']
        }
      })
    ).resolves.toMatchObject({ ok: false, category: 'incompatible' })
  })
})
