import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CodexAuthControllerPort, CodexAuthStatus } from './codex-auth'
import type { ClaudeIsolatedAuthControllerPort } from './claude-isolated-auth'
import type { ClaudeSharedAuthControllerPort, ClaudeSharedAuthStatus } from './claude-shared-auth'
import type { XaiOAuthControllerPort } from './xai-oauth'
import type { ValidateProviderResult } from '../../shared/settings'
import type { ResolvedProvider } from './provider-env'
import type { StoredSettings } from './types'
import { getAgentFramework } from '../agent-framework'
import { codexSubscriptionStorageDir } from '../agent-framework/codex'
import { buildConfiguredModelCatalog } from '../../shared/configured-model-catalog'

vi.mock('electron', () => ({
  net: {
    fetch: (input: string, init?: RequestInit) => globalThis.fetch(input, init)
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`cipher:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').slice('cipher:'.length)
  },
  app: { getPath: () => '/home', getAppPath: () => '/home/no-such-app-root', isPackaged: false }
}))

const { ProviderAccountsModule } = await import('./provider-accounts')
const { SettingsRepository } = await import('./repository')

const deferred = <T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('ProviderAccountsModule', () => {
  let dir: string
  let repository: InstanceType<typeof SettingsRepository>
  let codexAuth: CodexAuthControllerPort
  let claudeIsolatedAuth: ClaudeIsolatedAuthControllerPort
  let claudeSharedAuth: ClaudeSharedAuthControllerPort
  let xaiOAuth: XaiOAuthControllerPort
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
    xaiOAuth = {
      beginLogin: vi.fn(async () => ({
        userCode: 'GROK-1234',
        verificationUri: 'https://auth.x.ai/activate',
        expiresAt: Date.now() + 300_000,
        intervalSeconds: 5
      })),
      waitForLogin: vi.fn(async () => ({ accountEmail: 'researcher@example.com' })),
      cancelLogin: vi.fn(),
      getAccessToken: vi.fn(async () => 'access-token'),
      logout: vi.fn(async () => undefined)
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
      claudeSharedAuth,
      xaiOAuth
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
      maskedKey: '••••-key',
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

  it.each([
    ['id', 'p'.repeat(129), 'Provider ID must not exceed 128 characters.'],
    ['name', 'n'.repeat(129), 'Provider name must not exceed 128 characters.'],
    [
      'baseUrl',
      `https://gateway.example/${'x'.repeat(2_049)}`,
      'Base URL must not exceed 2048 characters.'
    ],
    ['model', 'm'.repeat(513), 'Model ID must not exceed 512 characters.'],
    ['key', 'k'.repeat(16 * 1024 + 1), 'API key must not exceed 16384 bytes.']
  ] as const)(
    'rejects an oversized provider %s before persistence',
    async (field, value, message) => {
      await expect(
        module.upsertProvider({
          type: 'custom',
          name: 'Lab gateway',
          baseUrl: 'https://lab.example/v1',
          model: 'lab-model',
          key: 'secret-key',
          apiEndpoints: ['openai'],
          [field]: value
        })
      ).rejects.toThrow(message)

      expect((await repository.getSettings()).providers).toEqual([])
    }
  )

  it.each([
    ['gateway.example/v1', 'Base URL must be a valid HTTP or HTTPS URL.'],
    ['ftp://gateway.example/v1', 'Base URL must be a valid HTTP or HTTPS URL.'],
    [
      'https://user:password@gateway.example/v1',
      'Remove credentials from the Base URL and use the API key field.'
    ],
    [
      'https://gateway.example/v1?api_key=secret-key',
      'Remove credentials from the Base URL and use the API key field.'
    ],
    [
      'https://gateway.example/v1?tenant=lab',
      'Base URL must not include query parameters or fragments.'
    ],
    [
      'https://gateway.example/v1#fragment',
      'Base URL must not include query parameters or fragments.'
    ]
  ])(
    'rejects an unsafe custom provider Base URL before persistence: %s',
    async (baseUrl, error) => {
      await expect(
        module.upsertProvider({
          type: 'custom',
          name: 'Lab gateway',
          baseUrl,
          model: 'lab-model',
          key: 'secret-key',
          apiEndpoints: ['openai']
        })
      ).rejects.toThrow(error)

      expect((await repository.getSettings()).providers).toEqual([])
    }
  )

  it('rejects an oversized unsaved validation draft before provider probing', async () => {
    await expect(
      module.validateProvider({
        draft: {
          type: 'custom',
          name: 'n'.repeat(129),
          baseUrl: 'https://lab.example/v1',
          model: 'lab-model',
          key: 'secret-key',
          apiEndpoints: ['responses']
        }
      })
    ).rejects.toThrow('Provider name must not exceed 128 characters.')
  })

  it('rejects creating a provider after the durable provider limit is reached', async () => {
    for (let index = 0; index < 64; index += 1) {
      await module.upsertProvider({
        type: 'custom',
        name: `Provider ${index}`,
        baseUrl: `https://provider-${index}.example/v1`,
        model: `model-${index}`,
        key: `key-${index}`,
        apiEndpoints: ['openai']
      })
    }

    await expect(
      module.upsertProvider({
        type: 'custom',
        name: 'Provider 65',
        baseUrl: 'https://provider-65.example/v1',
        model: 'model-65',
        key: 'key-65',
        apiEndpoints: ['openai']
      })
    ).rejects.toThrow('Provider limit of 64 reached.')

    expect((await repository.getSettings()).providers).toHaveLength(64)
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

  it('serializes isolated Codex logout with a concurrent authentication-mode edit', async () => {
    const userCodexDir = join(dir, 'user-codex')
    await mkdir(userCodexDir, { recursive: true })
    await writeFile(join(userCodexDir, 'auth.json'), JSON.stringify({ tokens: { access: 'user' } }))
    await module.upsertProvider({ type: 'codex-isolated' })

    const logoutCancellation = deferred<void>()
    const editCancellation = deferred<void>()
    const editEntered = deferred<void>()
    vi.mocked(codexAuth.cancelLogin)
      .mockImplementationOnce(() => logoutCancellation.promise)
      .mockImplementationOnce(() => {
        editEntered.resolve()
        return editCancellation.promise
      })

    const logout = module.logoutIsolatedCodex()
    await vi.waitFor(() => expect(codexAuth.cancelLogin).toHaveBeenCalledOnce())
    const originalGetSettings = repository.getSettings.bind(repository)
    const editRead = deferred<StoredSettings>()
    const getSettings = vi.spyOn(repository, 'getSettings').mockImplementation(async () => {
      const settings = await originalGetSettings()
      editRead.resolve(settings)
      return settings
    })
    const edit = module.upsertProvider({
      id: 'builtin-codex-subscription',
      type: 'codex-shared',
      requireExisting: true,
      reimportCodexAuthentication: true
    })

    const editEnteredDuringLogout = await Promise.race([
      editRead.promise.then(() => true),
      new Promise<false>((resolve) => setImmediate(() => resolve(false)))
    ])
    if (editEnteredDuringLogout) {
      editCancellation.resolve()
      await edit
      logoutCancellation.resolve()
    } else {
      logoutCancellation.resolve()
      await editEntered.promise
      editCancellation.resolve()
    }
    await Promise.all([logout, edit])
    getSettings.mockRestore()

    expect(editEnteredDuringLogout).toBe(false)
    expect((await repository.getSettings()).providers[0]).toMatchObject({
      id: 'builtin-codex-subscription',
      codexAuthMode: 'imported'
    })
    await expect(
      readFile(join(codexSubscriptionStorageDir(dir), 'auth.json'), 'utf8')
    ).resolves.toContain('user')
  })

  it('does not restore isolated Codex validation after a concurrent logout', async () => {
    await module.upsertProvider({ type: 'codex-isolated' })
    const staleSettings = await repository.getSettings()
    const staleRead = deferred<StoredSettings>()
    vi.spyOn(repository, 'getSettings').mockImplementationOnce(() => staleRead.promise)

    const login = module.loginIsolatedCodex()
    await vi.waitFor(() => expect(codexAuth.loginIsolated).toHaveBeenCalledOnce())
    await module.logoutIsolatedCodex()
    staleRead.resolve(staleSettings)

    await expect(login).resolves.toMatchObject({ ok: true, applied: false })
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.codexAuthMode).toBe('isolated')
    expect(stored.lastValidatedAt).toBeUndefined()
    expect(stored.lastValidationFailure).toBeUndefined()
  })

  it('does not restore isolated Codex mode after a concurrent shared-mode edit', async () => {
    const userCodexDir = join(dir, 'user-codex')
    await mkdir(userCodexDir, { recursive: true })
    await writeFile(join(userCodexDir, 'auth.json'), JSON.stringify({ tokens: { access: 'user' } }))
    await module.upsertProvider({ type: 'codex-isolated' })
    const staleSettings = await repository.getSettings()
    const staleRead = deferred<StoredSettings>()
    vi.spyOn(repository, 'getSettings').mockImplementationOnce(() => staleRead.promise)

    const login = module.loginIsolatedCodex()
    await vi.waitFor(() => expect(codexAuth.loginIsolated).toHaveBeenCalledOnce())
    await module.upsertProvider({
      id: 'builtin-codex-subscription',
      type: 'codex-shared',
      requireExisting: true,
      reimportCodexAuthentication: true
    })
    staleRead.resolve(staleSettings)

    await expect(login).resolves.toMatchObject({ ok: true, applied: false })
    expect((await repository.getSettings()).providers[0]).toMatchObject({
      id: 'builtin-codex-subscription',
      codexAuthMode: 'imported'
    })
  })

  it('persists and projects the Codex subscription transport preference', async () => {
    await module.upsertProvider({ type: 'codex-isolated', codexTransport: 'https' })

    let stored = (await repository.getSettings()).providers[0]
    expect(stored.codexTransport).toBe('https')
    expect(module.toProviderView(stored).codexTransport).toBe('https')

    await module.upsertProvider({
      id: stored.id,
      type: 'codex-isolated',
      codexTransport: 'websocket',
      requireExisting: true
    })
    stored = (await repository.getSettings()).providers[0]
    expect(stored.codexTransport).toBe('websocket')
  })

  it.each([
    ['auto', 'https'],
    ['auto', 'websocket'],
    ['https', 'auto'],
    ['websocket', 'auto']
  ] as const)(
    'clears learned transport state when the preference changes from %s to %s',
    async (initialTransport, nextTransport) => {
      await module.upsertProvider({
        type: 'codex-isolated',
        codexTransport: initialTransport
      })
      const initial = (await repository.getSettings()).providers[0]
      await repository.upsertProvider({
        ...initial,
        codexAutoUseHttps: true
      })

      await module.upsertProvider({
        id: 'builtin-codex-subscription',
        type: 'codex-isolated',
        codexTransport: nextTransport,
        requireExisting: true
      })

      expect((await repository.getSettings()).providers[0].codexAutoUseHttps).toBeUndefined()
    }
  )

  it('does not retain learned transport state while a manual preference is resaved', async () => {
    await module.upsertProvider({ type: 'codex-isolated', codexTransport: 'https' })
    const manual = (await repository.getSettings()).providers[0]
    await repository.upsertProvider({
      ...manual,
      codexAutoUseHttps: true
    })

    await module.upsertProvider({
      id: 'builtin-codex-subscription',
      type: 'codex-isolated',
      codexTransport: 'https',
      requireExisting: true
    })

    expect((await repository.getSettings()).providers[0].codexAutoUseHttps).toBeUndefined()
  })

  it('preserves learned HTTPS while an Auto preference is resaved', async () => {
    await module.upsertProvider({ type: 'codex-isolated', codexTransport: 'auto' })
    const stored = (await repository.getSettings()).providers[0]
    await repository.upsertProvider({
      ...stored,
      codexAutoUseHttps: true
    })

    await module.upsertProvider({
      id: stored.id,
      type: 'codex-isolated',
      codexTransport: 'auto',
      requireExisting: true
    })

    expect((await repository.getSettings()).providers[0].codexAutoUseHttps).toBe(true)
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
      { kind: 'configured', requestedModel: 'lab-model' },
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

  it('keeps another model selectable after a model-specific validation failure', async () => {
    await module.upsertProvider({
      type: 'custom',
      name: 'Lab gateway',
      baseUrl: 'https://lab.example/v1',
      model: 'model-a',
      key: 'secret-key',
      apiEndpoints: ['anthropic']
    })
    const providerId = (await repository.getSettings()).providers[0].id
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'pong' }],
              usage: { input_tokens: 1, output_tokens: 1 }
            }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(new Response('', { status: 404 }))
    )

    await expect(module.validateProvider({ providerId, model: 'model-a' })).resolves.toMatchObject({
      ok: true,
      category: 'ok'
    })

    await expect(module.validateProvider({ providerId, model: 'model-b' })).resolves.toMatchObject({
      ok: false,
      category: 'model-not-found'
    })

    const stored = (await repository.getSettings()).providers[0]
    expect(stored.lastValidatedAt).toBeTypeOf('number')
    expect(stored.lastValidatedTarget).toEqual({ model: 'model-a', endpoint: 'anthropic' })
    expect(stored.lastValidationFailure?.target).toEqual({
      model: 'model-b',
      endpoint: 'anthropic'
    })
    const catalog = buildConfiguredModelCatalog({
      providers: [module.toProviderView(stored)],
      frameworkId: 'claude-code',
      frameworkEndpoints: ['anthropic']
    })
    expect(catalog.map((entry) => entry.model)).toEqual(['model-a'])
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

  it('owns the single xAI OAuth provider lifecycle without persisting an access token', async () => {
    await module.upsertProvider({ type: 'xai-subscription' })
    const stored = (await repository.getSettings()).providers[0]

    expect(stored).toMatchObject({
      id: 'builtin-xai-subscription',
      type: 'xai-subscription',
      name: 'xAI (Grok) OAuth',
      model: 'grok-4.6',
      apiEndpoints: ['anthropic', 'openai', 'responses']
    })
    expect(stored.keyRef).toBeUndefined()
    await expect(module.beginXaiOAuthLogin()).resolves.toMatchObject({ userCode: 'GROK-1234' })
    await expect(module.waitXaiOAuthLogin()).resolves.toEqual({
      accountEmail: 'researcher@example.com'
    })
    await expect(module.getXaiOAuthAccessToken()).resolves.toBe('access-token')

    await module.deleteProvider(stored.id)
    expect(xaiOAuth.logout).toHaveBeenCalledOnce()
    expect((await repository.getSettings()).providers).toEqual([])
  })

  it('does not apply an in-flight xAI validation after logout', async () => {
    await module.upsertProvider({ type: 'xai-subscription' })
    const pendingToken = deferred<string>()
    vi.mocked(xaiOAuth.getAccessToken).mockImplementationOnce(() => pendingToken.promise)

    const pending = module.validateProvider({ providerId: 'builtin-xai-subscription' })
    await vi.waitFor(() => expect(xaiOAuth.getAccessToken).toHaveBeenCalledOnce())
    await module.logoutXaiOAuth()
    pendingToken.reject(new Error('Sign in to xAI (Grok) OAuth to continue.'))

    await expect(pending).resolves.toMatchObject({ ok: false, applied: false })
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.lastValidatedAt).toBeUndefined()
    expect(stored.lastValidationFailure).toBeUndefined()
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

  it('cancels every provider login when its application owner is disposed', async () => {
    await module.dispose()

    expect(codexAuth.cancelLogin).toHaveBeenCalledOnce()
    expect(claudeIsolatedAuth.cancelLogin).toHaveBeenCalledOnce()
    expect(claudeSharedAuth.cancelLogin).toHaveBeenCalledOnce()
    expect(xaiOAuth.cancelLogin).toHaveBeenCalledOnce()
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

  it('discards a model catalog fetched for a provider target changed during refresh', async () => {
    await module.upsertProvider({
      type: 'official',
      name: 'DeepSeek',
      vendorId: 'deepseek',
      model: 'deepseek-v4-pro',
      key: 'old-key'
    })
    const original = (await repository.getSettings()).providers[0]
    const requestStarted = deferred<void>()
    const response = deferred<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        requestStarted.resolve()
        return response.promise
      })
    )

    const refresh = module.refreshProviderModels({ providerId: original.id })
    await requestStarted.promise
    await module.upsertProvider({
      id: original.id,
      requireExisting: true,
      type: 'official',
      name: 'OpenAI replacement',
      vendorId: 'openai',
      key: 'new-key'
    })
    const edited = (await repository.getSettings()).providers[0]
    response.resolve(Response.json({ data: [{ id: 'deepseek-v5' }] }))

    await expect(refresh).resolves.toMatchObject({ ok: true, models: ['deepseek-v5'] })
    await expect(repository.getSettings()).resolves.toMatchObject({
      providers: [
        expect.objectContaining({
          id: original.id,
          name: 'OpenAI replacement',
          vendorId: 'openai',
          keyRef: edited.keyRef
        })
      ]
    })
    expect((await repository.getSettings()).providers[0].fetchedModels).toBeUndefined()
  })

  it('preserves unrelated provider edits while applying a pending model catalog refresh', async () => {
    await module.upsertProvider({
      type: 'official',
      name: 'DeepSeek',
      vendorId: 'deepseek',
      key: 'old-key'
    })
    const original = (await repository.getSettings()).providers[0]
    const requestStarted = deferred<void>()
    const response = deferred<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        requestStarted.resolve()
        return response.promise
      })
    )

    const refresh = module.refreshProviderModels({ providerId: original.id })
    await requestStarted.promise
    await module.upsertProvider({
      id: original.id,
      requireExisting: true,
      type: 'official',
      name: 'Renamed DeepSeek',
      vendorId: 'deepseek'
    })
    response.resolve(Response.json({ data: [{ id: 'deepseek-v5' }] }))

    await expect(refresh).resolves.toMatchObject({ ok: true, models: ['deepseek-v5'] })
    await expect(repository.getSettings()).resolves.toMatchObject({
      providers: [
        expect.objectContaining({
          id: original.id,
          name: 'Renamed DeepSeek',
          keyRef: original.keyRef,
          fetchedModels: ['deepseek-v5']
        })
      ]
    })
  })

  it('refuses to resolve a configured model removed by a catalog refresh', async () => {
    await module.upsertProvider({
      type: 'official',
      name: 'DeepSeek',
      vendorId: 'deepseek',
      key: 'key'
    })
    const providerId = (await repository.getSettings()).providers[0].id
    await module.setActiveProvider(providerId, 'deepseek-v4-pro')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'replacement-model' }] }))
    )

    await expect(module.refreshProviderModels({ providerId })).resolves.toMatchObject({
      ok: true,
      models: ['replacement-model']
    })
    const settings = await repository.getSettings()
    const provider = settings.providers[0]
    expect(settings.activeModel).toBe('deepseek-v4-pro')

    let outcome: string
    try {
      const target = module.resolveRuntimeTarget(
        provider,
        { kind: 'configured', requestedModel: settings.activeModel },
        getAgentFramework('codex')
      )
      outcome = `resolved ${target.effectiveModel}`
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error)
    }

    expect(outcome).toBe(
      'The configured model is no longer available from provider "DeepSeek": "deepseek-v4-pro". Pick another model in Settings → Model.'
    )
  })

  it('does not recreate a provider deleted while its model catalog refresh is pending', async () => {
    await module.upsertProvider({
      type: 'official',
      name: 'DeepSeek',
      vendorId: 'deepseek',
      key: 'old-key'
    })
    const providerId = (await repository.getSettings()).providers[0].id
    const requestStarted = deferred<void>()
    const response = deferred<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        requestStarted.resolve()
        return response.promise
      })
    )

    const refresh = module.refreshProviderModels({ providerId })
    await requestStarted.promise
    await module.deleteProvider(providerId)
    response.resolve(Response.json({ data: [{ id: 'deepseek-v5' }] }))

    await expect(refresh).resolves.toMatchObject({ ok: true, models: ['deepseek-v5'] })
    await expect(repository.getSettings()).resolves.toMatchObject({ providers: [] })
  })

  it.each(['contextWindow', 'maxInputTokens', 'maxOutputTokens'] as const)(
    'rejects an invalid %s on an unsaved validation draft',
    async (field) => {
      await expect(
        module.validateProvider({
          draft: {
            type: 'custom',
            baseUrl: 'https://lab.example/v1',
            model: 'lab-model',
            key: 'secret-key',
            apiEndpoints: ['openai'],
            [field]: 0
          }
        })
      ).rejects.toThrow(/positive whole number of tokens/)
    }
  )
})
