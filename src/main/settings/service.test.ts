import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { execPath } from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CLAUDE_ISOLATED_PROVIDER_ID,
  CLAUDE_SHARED_PROVIDER_ID,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  type ClaudeDetectResult
} from '../../shared/settings'
import type { CodexAuthControllerPort } from './codex-auth'
import type {
  ClaudeIsolatedAuthControllerPort,
  ClaudeIsolatedAuthStatus
} from './claude-isolated-auth'
import type { ClaudeSharedAuthControllerPort } from './claude-shared-auth'
import type { UserSkillRepository } from '../skills/user-skill-repository'
import type { ResponsesBridge } from './responses-bridge'

// Reversible fake safeStorage so provider keys can be encrypted/decrypted without an OS keychain.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`cipher:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const decoded = buffer.toString('utf8')

      if (!decoded.startsWith('cipher:')) throw new Error('bad ciphertext')

      return decoded.slice('cipher:'.length)
    }
  },
  app: { getPath: () => '/home', getAppPath: () => '/home/no-such-app-root', isPackaged: false },
  // The provider-validation probe fetches over net.fetch (proxy-aware in production). Delegate to the
  // global fetch each test stubs, so the existing vi.stubGlobal('fetch', …) probe expectations hold.
  net: { fetch: vi.fn((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) }
}))

const { SettingsService } = await import('./service')
const { ResponsesBridge: ResponsesBridgeClass } = await import('./responses-bridge')
const { SettingsRepository } = await import('./repository')
const { getAppClaudeConfigDir } = await import('./provider-env')
const { SkillRegistry } = await import('../skills/registry')
const { managedClaudeDir } = await import('./managed-claude')
const { managedOpencodeDir } = await import('./managed-opencode')
const { netFetch } = await import('../skills/net-fetch')
const { net: mockedNet } = (await import('electron')) as unknown as {
  net: { fetch: ReturnType<typeof vi.fn> }
}

let storageRoot: string
let repository: InstanceType<typeof SettingsRepository>
const CODEX_SHARED_PROVIDER_ID = CODEX_SUBSCRIPTION_PROVIDER_ID
const CODEX_ISOLATED_PROVIDER_ID = CODEX_SUBSCRIPTION_PROVIDER_ID

const validAnthropicResponse = (): Response =>
  new Response(
    JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'o' }],
      usage: { input_tokens: 1, output_tokens: 1 }
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )

type ManagedInstallImpl = (options: {
  installId: string
  onEvent: (event: { kind: string; installId: string }) => void
  dataRoot: string
  registries?: string[]
}) => Promise<{
  result: { installId: string; ok: boolean; error?: string }
  resolvedPath?: string
  version?: string
}>

type ManagedCodexInstallImpl = (options: {
  installId: string
  onEvent: (event: { kind: string; installId: string }) => void
  dataRoot: string
}) => Promise<{
  result: { installId: string; ok: boolean; error?: string }
  adapterPath?: string
  adapterVersion?: string
  codexPath?: string
  codexVersion?: string
}>

const createService = (
  detectResult: ClaudeDetectResult = { found: true, path: '/bin/claude', version: '2.1.0' },
  options: {
    installManagedClaudeImpl?: ManagedInstallImpl
    installManagedOpencodeImpl?: ManagedInstallImpl
    installManagedCodexImpl?: ManagedCodexInstallImpl
    // When set, opencode detection resolves this path/version; otherwise it finds nothing.
    opencodeDetected?: { path: string; version: string }
    codexDetected?: { path: string; version: string; nativePath?: string; nativeVersion?: string }
    // Simulates an external native Codex CLI reachable only via the augmented PATH (e.g. Homebrew),
    // so getCodexVersion resolves for this path even though it's not the managed nativePath.
    codexExternalNative?: { path: string; version: string }
    // When false, the ACP smoke test fails (adapter present but can't initialize).
    codexSmokeOk?: boolean
    codexAuth?: CodexAuthControllerPort
    claudeIsolatedAuth?: ClaudeIsolatedAuthControllerPort
    claudeSharedAuth?: ClaudeSharedAuthControllerPort
    executeClaudeProbe?: (
      executablePath: string,
      env: NodeJS.ProcessEnv,
      runtimeArgs?: string[]
    ) => Promise<void>
    userClaudeDir?: string
    userCodexDir?: string
  } = {}
): InstanceType<typeof SettingsService> =>
  new SettingsService({
    repository,
    storageRoot,
    // Point at a non-existent user Claude dir so tests never read the real ~/.claude. The same
    // path is now used by claude-isolated skill-scanning; claude-default is gone.
    userClaudeDir: options.userClaudeDir ?? join(storageRoot, 'no-user-claude'),
    userCodexDir: options.userCodexDir ?? join(storageRoot, 'no-user-codex'),
    executeClaudeProbe: options.executeClaudeProbe,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installManagedClaudeImpl: options.installManagedClaudeImpl as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installManagedOpencodeImpl: options.installManagedOpencodeImpl as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installManagedCodexImpl: options.installManagedCodexImpl as any,
    detectDeps: {
      env: {},
      homePath: '/home',
      platform: 'linux',
      isExecutable: () => Promise.resolve(true),
      getVersion: () => Promise.resolve(detectResult.version),
      resolveNpmBinDirs: () => Promise.resolve([])
    },
    // Isolated so opencode detection never probes the real host during tests. Finds nothing unless the
    // caller declares an installed path (isExecutable/getVersion then answer for exactly that path).
    opencodeDetectDeps: {
      env: options.opencodeDetected ? { PATH: dirname(options.opencodeDetected.path) } : {},
      homePath: '/home',
      platform: 'linux',
      isExecutable: (path) => Promise.resolve(path === options.opencodeDetected?.path),
      getVersion: (path) =>
        Promise.resolve(
          path === options.opencodeDetected?.path ? options.opencodeDetected.version : undefined
        ),
      resolveNpmBinDirs: () => Promise.resolve([])
    },
    codexDetectDeps: {
      env: options.codexDetected ? { PATH: dirname(options.codexDetected.path) } : {},
      homePath: '/home',
      platform: 'linux',
      isRunnable: (path) => Promise.resolve(path === options.codexDetected?.path),
      getAdapterVersion: (path) =>
        Promise.resolve(
          path === options.codexDetected?.path ? options.codexDetected.version : undefined
        ),
      getCodexVersion: (path) =>
        Promise.resolve(
          path === options.codexDetected?.nativePath
            ? options.codexDetected.nativeVersion
            : path === options.codexExternalNative?.path
              ? options.codexExternalNative.version
              : undefined
        ),
      smokeInitialize: () => Promise.resolve(options.codexSmokeOk ?? true),
      resolveNpmBinDirs: () => Promise.resolve([]),
      managedAdapterPath: options.codexDetected?.nativePath
        ? options.codexDetected.path
        : undefined,
      managedCodexPath: options.codexDetected?.nativePath
    },
    codexAuth: options.codexAuth,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    claudeIsolatedAuth: options.claudeIsolatedAuth as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    claudeSharedAuth: options.claudeSharedAuth as any
  })

beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-settings-service-'))
  repository = new SettingsRepository(storageRoot)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(storageRoot, { recursive: true, force: true })
})

describe('SettingsService: providers', () => {
  it.each([
    ['codex-shared', CODEX_SHARED_PROVIDER_ID, 'Codex subscription'],
    ['codex-isolated', CODEX_ISOLATED_PROVIDER_ID, 'Codex subscription']
  ] as const)('persists %s as one fixed built-in provider', async (type, id, name) => {
    const service = createService()

    await service.upsertProvider({ type, name: 'ignored', key: 'ignored', model: 'ignored' })
    const snapshot = await service.upsertProvider({ type, name: 'duplicate attempt' })

    expect(snapshot.providers.filter((provider) => provider.id === id)).toEqual([
      expect.objectContaining({
        id,
        type,
        name,
        apiEndpoints: ['responses'],
        models: [
          'gpt-5.6-sol',
          'gpt-5.6-terra',
          'gpt-5.6-luna',
          'gpt-5.5',
          'gpt-5.4',
          'gpt-5.4-mini'
        ],
        hasKey: false
      })
    ])
    expect((await repository.getSettings()).providers).toEqual([
      expect.objectContaining({ id, type, name, apiEndpoints: ['responses'] })
    ])
  })

  it.each([
    ['codex-shared', CODEX_SHARED_PROVIDER_ID],
    ['codex-isolated', CODEX_ISOLATED_PROVIDER_ID]
  ] as const)('deletes an added %s provider', async (type, id) => {
    const service = createService()
    await service.upsertProvider({ type })

    await expect(service.deleteProvider(id)).resolves.toMatchObject({ providers: [] })
    expect((await repository.getSettings()).providers).toEqual([])
  })

  it.each([
    [CLAUDE_SHARED_PROVIDER_ID, CLAUDE_ISOLATED_PROVIDER_ID, 'claude-isolated-model'],
    [CLAUDE_ISOLATED_PROVIDER_ID, CLAUDE_SHARED_PROVIDER_ID, 'claude-shared-model']
  ] as const)(
    'deleting %s through the collapsed card also removes its active sibling',
    async (deletedId, activeId, activeModel) => {
      const service = createService()
      await service.upsertProvider({ type: 'claude-shared', model: 'claude-shared-model' })
      await service.upsertProvider({ type: 'claude-isolated', model: 'claude-isolated-model' })
      await service.setActiveProvider(activeId, activeModel)

      const snapshot = await service.deleteProvider(deletedId)

      expect(snapshot.providers).toEqual([])
      expect(snapshot.claudeSubscriptionProviderId).toBeUndefined()
      expect(snapshot.activeProviderId).toBeUndefined()
      expect(snapshot.activeModel).toBeUndefined()
      const stored = await repository.getSettings()
      expect(stored.providers).toEqual([])
      expect(stored.activeProviderId).toBeUndefined()
      expect(stored.activeModel).toBeUndefined()
      expect(stored.claudeSubscriptionProviderId).toBeUndefined()
    }
  )

  it.each([CLAUDE_SHARED_PROVIDER_ID, CLAUDE_ISOLATED_PROVIDER_ID])(
    'cancels both Claude login controllers before deleting the collapsed provider through %s',
    async (providerId) => {
      const claudeIsolatedAuth: ClaudeIsolatedAuthControllerPort = {
        getStatus: vi.fn(),
        loginIsolatedBrowser: vi.fn(),
        loginIsolated: vi.fn(),
        cancelLogin: vi.fn(),
        logoutIsolated: vi.fn()
      }
      const claudeSharedAuth: ClaudeSharedAuthControllerPort = {
        getStatus: vi.fn(),
        loginShared: vi.fn(),
        cancelLogin: vi.fn()
      }
      const service = createService(undefined, { claudeIsolatedAuth, claudeSharedAuth })
      await service.upsertProvider({ type: 'claude-shared' })
      await service.upsertProvider({ type: 'claude-isolated' })

      await service.deleteProvider(providerId)

      expect(claudeIsolatedAuth.cancelLogin).toHaveBeenCalledOnce()
      expect(claudeSharedAuth.cancelLogin).toHaveBeenCalledOnce()
      expect((await repository.getSettings()).providers).toEqual([])
    }
  )

  it('discards a browser login token that arrives after the Claude provider is deleted', async () => {
    let finishBrowserLogin: (() => Promise<void>) | undefined
    const claudeIsolatedAuth: ClaudeIsolatedAuthControllerPort = {
      getStatus: vi.fn(),
      loginIsolatedBrowser: vi.fn(
        () =>
          new Promise<ClaudeIsolatedAuthStatus>((resolve) => {
            finishBrowserLogin = async () => {
              const applied = await repository.updateClaudeIsolatedCredentialsIfExists({
                keyRef: 'enc:late-browser-token',
                keyMask: 'sk-ant-…late'
              })
              resolve({
                supported: true,
                authenticated: applied,
                message: applied
                  ? undefined
                  : 'The Claude provider was removed before sign-in completed.'
              })
            }
          })
      ),
      loginIsolated: vi.fn(),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn()
    }
    const service = createService(undefined, { claudeIsolatedAuth })
    await service.upsertProvider({ type: 'claude-isolated' })

    const login = service.loginIsolatedClaudeBrowser()
    await vi.waitFor(() => expect(claudeIsolatedAuth.loginIsolatedBrowser).toHaveBeenCalledOnce())
    await service.deleteProvider(CLAUDE_ISOLATED_PROVIDER_ID)
    await finishBrowserLogin?.()

    expect(await login).toMatchObject({ ok: false, applied: false })
    expect(claudeIsolatedAuth.cancelLogin).toHaveBeenCalledOnce()
    expect((await repository.getSettings()).providers).toEqual([])
  })

  it('does not recreate a deleted Claude provider when a late token save completes', async () => {
    const service = createService(undefined, {
      executeClaudeProbe: vi.fn().mockResolvedValue(undefined)
    })
    await service.upsertProvider({ type: 'claude-isolated' })
    await service.deleteProvider(CLAUDE_ISOLATED_PROVIDER_ID)

    const result = await service.loginIsolatedClaude('sk-ant-late')

    expect(result).toMatchObject({ ok: false, applied: false })
    expect((await repository.getSettings()).providers).toEqual([])
  })

  it('validates shared and isolated subscriptions through read-only status checks', async () => {
    const codexAuth: CodexAuthControllerPort = {
      getStatus: vi.fn().mockResolvedValue({
        mode: 'shared',
        supported: true,
        authenticated: true
      }),
      loginIsolated: vi.fn().mockResolvedValue({
        mode: 'isolated',
        supported: true,
        authenticated: true
      }),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn()
    }
    const service = createService(undefined, { codexAuth })
    await service.upsertProvider({ type: 'codex-shared' })

    await expect(
      service.validateProvider({ providerId: CODEX_SHARED_PROVIDER_ID })
    ).resolves.toMatchObject({ ok: true })
    await service.upsertProvider({ type: 'codex-isolated' })
    await expect(
      service.validateProvider({ providerId: CODEX_ISOLATED_PROVIDER_ID })
    ).resolves.toMatchObject({ ok: true })
    expect(codexAuth.getStatus).toHaveBeenCalledWith('shared')
    expect(codexAuth.getStatus).toHaveBeenCalledWith('isolated')
    // Validation never opens the browser login; that is the explicit sign-in action's job.
    expect(codexAuth.loginIsolated).not.toHaveBeenCalled()

    const stored = await repository.getSettings()
    expect(stored.providers.every((provider) => provider.lastValidatedAt !== undefined)).toBe(true)
  })

  it('reports an unauthenticated isolated status without triggering sign-in', async () => {
    const codexAuth: CodexAuthControllerPort = {
      getStatus: vi.fn().mockResolvedValue({
        mode: 'isolated',
        supported: true,
        authenticated: false
      }),
      loginIsolated: vi.fn(),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn()
    }
    const service = createService(undefined, { codexAuth })
    await service.upsertProvider({ type: 'codex-isolated' })

    const result = await service.validateProvider({ providerId: CODEX_ISOLATED_PROVIDER_ID })

    expect(result).toMatchObject({
      ok: false,
      category: 'auth',
      message: 'Not signed in. Use Sign in to connect your ChatGPT account.'
    })
    expect(codexAuth.loginIsolated).not.toHaveBeenCalled()
    expect((await repository.getSettings()).providers[0].lastValidationFailure).toMatchObject({
      category: 'auth'
    })
  })

  it('records the explicit isolated sign-in outcome on the provider', async () => {
    const codexAuth: CodexAuthControllerPort = {
      getStatus: vi.fn(),
      loginIsolated: vi.fn().mockResolvedValue({
        mode: 'isolated',
        supported: true,
        authenticated: true
      }),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn()
    }
    const service = createService(undefined, { codexAuth })
    await service.upsertProvider({ type: 'codex-isolated' })

    await expect(service.loginIsolatedCodex()).resolves.toMatchObject({
      ok: true,
      category: 'ok',
      applied: true
    })
    expect((await repository.getSettings()).providers[0].lastValidatedAt).toBeDefined()

    // A failed attempt (e.g. the user dismisses the browser flow) clears the verified stamp and
    // records the reason, so the card flags the provider as unverified until a retry succeeds.
    codexAuth.loginIsolated = vi.fn().mockResolvedValue({
      mode: 'isolated',
      supported: true,
      authenticated: false,
      message: 'Codex sign-in was cancelled.'
    })
    await expect(service.loginIsolatedCodex()).resolves.toMatchObject({
      ok: false,
      category: 'auth',
      message: 'Codex sign-in was cancelled.'
    })
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.lastValidatedAt).toBeUndefined()
    expect(stored.lastValidationFailure).toMatchObject({
      category: 'auth',
      message: 'Codex sign-in was cancelled.'
    })
  })

  it('discards the sign-in outcome when the provider was switched to shared mid-flow', async () => {
    let resolveLogin!: (status: {
      mode: 'isolated'
      supported: boolean
      authenticated: boolean
    }) => void
    const codexAuth: CodexAuthControllerPort = {
      getStatus: vi.fn(),
      loginIsolated: vi.fn(
        () =>
          new Promise<{ mode: 'isolated'; supported: boolean; authenticated: boolean }>(
            (resolve) => {
              resolveLogin = resolve
            }
          )
      ),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn()
    }
    const service = createService(undefined, { codexAuth })
    await service.upsertProvider({ type: 'codex-isolated' })

    // The provider is switched to shared while the browser flow is still open; the success landing
    // afterwards must not stamp the (unauthenticated) shared profile as verified.
    const pending = service.loginIsolatedCodex()
    await service.upsertProvider({ type: 'codex-shared' })
    resolveLogin({ mode: 'isolated', supported: true, authenticated: true })

    // ok reflects the sign-in itself, but applied:false marks it as discarded so a success-gated
    // caller (onboarding) does not advance on a profile the store never recorded it against.
    await expect(pending).resolves.toMatchObject({ ok: true, applied: false })
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.type).toBe('codex-shared')
    expect(stored.lastValidatedAt).toBeUndefined()
    expect(stored.lastValidationFailure).toBeUndefined()
  })

  it('keeps the Codex account default when a subscription is activated without a model', async () => {
    const service = createService()
    const provider = (await service.upsertProvider({ type: 'codex-shared' })).providers[0]

    const snapshot = await service.setActiveProvider(provider.id)

    expect(snapshot.activeModel).toBeUndefined()
  })

  it.each([
    ['codex-shared', 'codex-isolated'],
    ['codex-isolated', 'codex-shared']
  ] as const)(
    'requires fresh validation after switching the Codex subscription from %s to %s',
    async (initialType, nextType) => {
      const codexAuth: CodexAuthControllerPort = {
        getStatus: vi.fn().mockResolvedValue({
          mode: 'shared',
          supported: true,
          authenticated: true
        }),
        loginIsolated: vi.fn().mockResolvedValue({
          mode: 'isolated',
          supported: true,
          authenticated: true
        }),
        cancelLogin: vi.fn(),
        logoutIsolated: vi.fn()
      }
      const service = createService(undefined, { codexAuth })
      await service.upsertProvider({ type: initialType })
      await service.validateProvider({ providerId: CODEX_SUBSCRIPTION_PROVIDER_ID })
      expect((await service.getSettingsView()).providers[0].lastValidatedAt).toBeDefined()

      const snapshot = await service.upsertProvider({ type: nextType })

      expect(snapshot.providers[0].type).toBe(nextType)
      expect(snapshot.providers[0].lastValidatedAt).toBeUndefined()
    }
  )

  it('cancels isolated login and clears provider readiness on logout', async () => {
    const codexAuth: CodexAuthControllerPort = {
      getStatus: vi.fn(),
      loginIsolated: vi.fn().mockResolvedValue({
        mode: 'isolated',
        supported: true,
        authenticated: true
      }),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn().mockResolvedValue({
        mode: 'isolated',
        supported: true,
        authenticated: false
      })
    }
    const service = createService(undefined, { codexAuth })
    await service.upsertProvider({ type: 'codex-isolated' })
    await service.loginIsolatedCodex()

    service.cancelCodexLogin()
    await service.logoutIsolatedCodex()

    expect(codexAuth.cancelLogin).toHaveBeenCalledOnce()
    expect(codexAuth.logoutIsolated).toHaveBeenCalledOnce()
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.lastValidatedAt).toBeUndefined()
    expect(stored.lastValidationFailure).toBeUndefined()
  })

  it('preserves the verified markers when isolated sign-out times out', async () => {
    // The P1 fix: a timed-out sign-out never called logout(), so the credential may still be in the
    // isolated home. Clearing lastValidatedAt would falsely mark the provider as signed out while
    // the credential is usable — instead preserve the verified state and return the failure so the
    // user knows to retry.
    const codexAuth = {
      getStatus: vi.fn(),
      loginIsolated: vi.fn().mockResolvedValue({
        mode: 'isolated',
        supported: true,
        authenticated: true
      }),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn().mockResolvedValue({
        mode: 'isolated',
        supported: true,
        authenticated: false,
        message: 'Codex sign-out timed out.'
      })
    }
    const service = createService(undefined, { codexAuth })
    await service.upsertProvider({ type: 'codex-isolated' })
    await service.loginIsolatedCodex()

    const result = await service.logoutIsolatedCodex()

    expect(result).toEqual({ ok: false, category: 'timeout', message: 'Codex sign-out timed out.' })
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.lastValidatedAt).toBeGreaterThan(0)
    expect(stored.lastValidationFailure).toBeUndefined()
  })

  it('returns success when isolated sign-out completes cleanly', async () => {
    const codexAuth = {
      getStatus: vi.fn(),
      loginIsolated: vi.fn().mockResolvedValue({
        mode: 'isolated',
        supported: true,
        authenticated: true
      }),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn().mockResolvedValue({
        mode: 'isolated',
        supported: true,
        authenticated: false
      })
    }
    const service = createService(undefined, { codexAuth })
    await service.upsertProvider({ type: 'codex-isolated' })
    await service.loginIsolatedCodex()

    const result = await service.logoutIsolatedCodex()

    expect(result).toEqual({ ok: true, category: 'ok' })
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.lastValidatedAt).toBeUndefined()
    expect(stored.lastValidationFailure).toBeUndefined()
  })

  it('encrypts the key on upsert and never exposes plaintext in the view', async () => {
    const service = createService()

    const snapshot = await service.upsertProvider({
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'https://g/v1',
      model: 'm',
      key: 'sk-super-secret'
    })

    const view = snapshot.providers[0]
    expect(view.hasKey).toBe(true)
    expect(view.maskedKey).toBe('sk-s…cret')
    expect(JSON.stringify(view)).not.toContain('sk-super-secret')

    // The stored record holds ciphertext, not the plaintext key.
    const stored = (await repository.getSettings()).providers[0]
    expect(stored.keyRef?.startsWith('enc:')).toBe(true)
    expect(JSON.stringify(stored)).not.toContain('sk-super-secret')
  })

  it('persists a custom context window and carries it into the OpenCode model metadata', async () => {
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'opencode')
    await repository.setAgentFramework('opencode')
    const service = createService(undefined, {
      opencodeDetected: { path: '/usr/local/bin/opencode', version: '1.18.3' }
    })

    const snapshot = await service.upsertProvider({
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'https://g',
      model: 'm',
      contextWindow: 64_000,
      key: 'k'
    })
    const view = snapshot.providers[0]
    expect(view.contextWindow).toBe(64_000)
    expect((await repository.getSettings()).providers[0].contextWindow).toBe(64_000)

    await repository.upsertProvider({
      ...(await repository.getSettings()).providers[0],
      lastValidatedAt: Date.now()
    })
    await service.setActiveProvider(view.id)
    const backend = await service.resolveActiveAgentBackend()
    const content = JSON.parse(backend.env?.OPENCODE_CONFIG_CONTENT ?? '{}')
    expect(content.provider.anthropic.models.m.limit.context).toBe(64_000)
  })

  it('uses a 200k runtime default when a custom context window is omitted', async () => {
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'opencode')
    await repository.setAgentFramework('opencode')
    const service = createService(undefined, {
      opencodeDetected: { path: '/usr/local/bin/opencode', version: '1.18.3' }
    })
    const view = (
      await service.upsertProvider({
        type: 'custom',
        name: 'Gateway',
        baseUrl: 'https://g',
        model: 'm',
        key: 'k'
      })
    ).providers[0]
    expect(view.contextWindow).toBeUndefined()

    await repository.upsertProvider({
      ...(await repository.getSettings()).providers[0],
      lastValidatedAt: Date.now()
    })
    await service.setActiveProvider(view.id)
    const backend = await service.resolveActiveAgentBackend()
    const content = JSON.parse(backend.env?.OPENCODE_CONFIG_CONTENT ?? '{}')
    expect(content.provider.anthropic.models.m.limit.context).toBe(200_000)
  })

  it('keeps OpenCode connector details in on-demand skills instead of baseline context', async () => {
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'opencode')
    await repository.setAgentFramework('opencode')
    const service = createService(undefined, {
      opencodeDetected: { path: '/usr/local/bin/opencode', version: '1.18.3' }
    })
    const provider = (
      await service.upsertProvider({
        type: 'official',
        name: 'DeepSeek',
        vendorId: 'deepseek',
        key: 'k'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id)

    await service.resolveActiveAgentBackend()

    const baseline = await readFile(
      join(storageRoot, 'opencode', 'config', 'opencode', 'instructions', 'connectors.md'),
      'utf8'
    )
    expect(baseline).toContain('host.mcp')
    expect(baseline).toContain('mcp-*')
    expect(baseline).not.toContain('pubchem_get_compounds')
    expect(baseline).not.toContain('```json')
    expect(baseline.length).toBeLessThan(2_500)

    const chemistrySkill = await readFile(
      join(storageRoot, 'opencode', 'config', 'opencode', 'skills', 'mcp-chemistry', 'SKILL.md'),
      'utf8'
    )
    expect(chemistrySkill).toContain('pubchem_get_compounds')
    expect(chemistrySkill).toContain('```json')
  })

  it('rejects an invalid custom context window when IPC bypasses the form', async () => {
    const service = createService()
    const base = {
      type: 'custom' as const,
      name: 'Gateway',
      baseUrl: 'https://g',
      model: 'm',
      key: 'k'
    }

    await expect(service.upsertProvider({ ...base, contextWindow: 0 })).rejects.toThrow(
      /positive whole number/i
    )
    await expect(service.upsertProvider({ ...base, contextWindow: 1.5 })).rejects.toThrow(
      /positive whole number/i
    )
  })

  it('keeps the stored key when an edit omits a new key', async () => {
    const service = createService()
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k1'
      })
    ).providers[0]

    await service.upsertProvider({ id: created.id, type: 'custom', name: 'Renamed' })

    const stored = (await repository.getSettings()).providers[0]
    expect(stored.name).toBe('Renamed')
    expect(stored.keyRef).toBeDefined()
  })

  it('rejects an incomplete custom provider and never persists it', async () => {
    const service = createService()

    // Missing base URL / model / key each block the save with a clear error.
    await expect(
      service.upsertProvider({ type: 'custom', name: 'No base URL', model: 'm', key: 'k' })
    ).rejects.toThrow(/base url is required/i)
    await expect(
      service.upsertProvider({
        type: 'custom',
        name: 'No model',
        baseUrl: 'https://g/v1',
        key: 'k'
      })
    ).rejects.toThrow(/model is required/i)
    await expect(
      service.upsertProvider({
        type: 'custom',
        name: 'No key',
        baseUrl: 'https://g/v1',
        model: 'm'
      })
    ).rejects.toThrow(/api key is required/i)

    // None of the rejected drafts reached disk.
    expect((await repository.getSettings()).providers).toEqual([])
  })

  it('accepts a custom Responses-compatible gateway', async () => {
    const service = createService()

    const snapshot = await service.upsertProvider({
      type: 'custom',
      name: 'Responses gateway',
      apiEndpoints: ['responses'],
      baseUrl: 'https://gateway.example/v1',
      model: 'codex-model',
      key: 'k'
    })

    expect(snapshot.providers[0]).toMatchObject({
      apiEndpoints: ['responses'],
      baseUrl: 'https://gateway.example/v1'
    })
  })
})

describe('SettingsService: validation', () => {
  it('records lastValidatedAt for a saved provider on success', async () => {
    const service = createService()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(validAnthropicResponse()))

    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    const result = await service.validateProvider({ providerId: created.id })

    expect(result.ok).toBe(true)
    expect((await repository.getSettings()).providers[0].lastValidatedAt).toBeGreaterThan(0)
  })

  it('probes over the proxy-aware net.fetch, not Node global fetch directly', async () => {
    const service = createService()
    // A direct undici fetch ignores the system proxy, so an official vendor reachable only through a
    // proxy fails as a false network error. The probe must go through net.fetch (Chromium stack).
    mockedNet.fetch.mockClear()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }))

    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    await service.validateProvider({ providerId: created.id })

    expect(mockedNet.fetch).toHaveBeenCalledTimes(1)
    expect(mockedNet.fetch.mock.calls[0][0]).toContain('https://g')
  })

  it('records the failure (not lastValidatedAt) for a saved provider on failure', async () => {
    const service = createService()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401 }))

    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    const result = await service.validateProvider({ providerId: created.id })

    expect(result).toMatchObject({ ok: false, category: 'auth' })

    const stored = (await repository.getSettings()).providers[0]

    expect(stored.lastValidatedAt).toBeUndefined()
    expect(stored.lastValidationFailure).toMatchObject({ category: 'auth' })
    expect(stored.lastValidationFailure?.at).toBeGreaterThan(0)
  })

  it('reports incompatible (no network probe) when the provider cannot drive the active framework', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    // Default framework is Claude Code (Anthropic /v1/messages only); an OpenAI-only gateway can't drive
    // it, so testing must fail with the pairing reason rather than firing a misleading /v1/messages probe.
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g',
        model: 'm',
        key: 'k',
        apiEndpoints: ['openai']
      })
    ).providers[0]

    const result = await service.validateProvider({ providerId: created.id })

    expect(result).toMatchObject({ ok: false, category: 'incompatible', applied: true })
    expect(result.message).toContain('/v1/chat/completions')
    expect(fetchMock).not.toHaveBeenCalled()

    const stored = (await repository.getSettings()).providers.find((p) => p.id === created.id)
    expect(stored?.lastValidatedAt).toBeUndefined()
    expect(stored?.lastValidationFailure).toMatchObject({ category: 'incompatible' })
  })

  it('probes normally once the active framework can drive the provider', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g',
        model: 'm',
        key: 'k',
        apiEndpoints: ['openai']
      })
    ).providers[0]

    // OpenCode accepts /v1/chat/completions, so the same provider now validates over the network.
    await service.setAgentFramework('opencode')
    const result = await service.validateProvider({ providerId: created.id })

    expect(result).toMatchObject({ ok: true, category: 'ok' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/chat/completions')
  })

  it('probes the route the active framework drives for a multi-route provider', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    // A provider that speaks both routes. preferredEndpoint would pick OpenAI globally, but Claude Code
    // runs /v1/messages — so the probe must hit that, or a passing test wouldn't prove the real route.
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g',
        model: 'm',
        key: 'k',
        apiEndpoints: ['anthropic', 'openai']
      })
    ).providers[0]

    // Default framework is Claude Code (Anthropic only).
    await service.validateProvider({ providerId: created.id })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/messages')

    // The same provider under OpenCode should instead be probed on the OpenAI route it will run.
    await service.setAgentFramework('opencode')
    await service.validateProvider({ providerId: created.id })
    expect(fetchMock.mock.calls[1][0]).toContain('/v1/chat/completions')
  })

  it('clears a recorded failure once a later validation succeeds', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue({ status: 401 })
    vi.stubGlobal('fetch', fetchMock)

    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    await service.validateProvider({ providerId: created.id })
    expect((await repository.getSettings()).providers[0].lastValidationFailure).toBeDefined()

    fetchMock.mockResolvedValue(validAnthropicResponse())
    await service.validateProvider({ providerId: created.id })

    const stored = (await repository.getSettings()).providers[0]

    expect(stored.lastValidationFailure).toBeUndefined()
    expect(stored.lastValidatedAt).toBeGreaterThan(0)
  })

  it('invalidates an earlier success when the latest validation fails', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue(validAnthropicResponse())
    vi.stubGlobal('fetch', fetchMock)
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    await service.validateProvider({ providerId: created.id })
    fetchMock.mockResolvedValue({ status: 401 })
    await service.validateProvider({ providerId: created.id })

    const stored = (await repository.getSettings()).providers[0]
    expect(stored.lastValidatedAt).toBeUndefined()
    expect(stored.lastValidationFailure).toMatchObject({ category: 'auth' })
  })

  it('marks a superseded validation as not applied and leaves the newer stamp intact', async () => {
    const service = createService()
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    // A slow probe lets a second, faster validation start and bump the generation before the first
    // resolves. The first is stale: it must report applied:false and never write over the newer run.
    let releaseSlow!: () => void
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSlow = () => resolve({ status: 401 } as Response)
          })
      )
      .mockResolvedValue(validAnthropicResponse())
    vi.stubGlobal('fetch', fetchMock)

    const slow = service.validateProvider({ providerId: created.id })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const fast = await service.validateProvider({ providerId: created.id })
    expect(fast).toMatchObject({ ok: true, applied: true })

    releaseSlow()
    await expect(slow).resolves.toMatchObject({ ok: false, applied: false })

    // The newer success stands: the superseded failure must not have cleared it.
    expect((await repository.getSettings()).providers[0].lastValidatedAt).toBeGreaterThan(0)
  })

  it.each([
    ['base URL', { baseUrl: 'https://other.example/v1' }],
    ['model', { model: 'm2' }],
    ['API format', { apiEndpoints: ['responses' as const] }]
  ])('invalidates prior validation when the custom provider %s changes', async (_label, change) => {
    const service = createService()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(validAnthropicResponse()))
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        apiEndpoints: ['openai'],
        key: 'k'
      })
    ).providers[0]
    await service.validateProvider({ providerId: created.id })

    await service.upsertProvider({ id: created.id, type: 'custom', name: 'G', ...change })

    expect((await repository.getSettings()).providers[0].lastValidatedAt).toBeUndefined()
  })

  it('drops a recorded failure when credentials change on edit', async () => {
    const service = createService()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401 }))

    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    await service.validateProvider({ providerId: created.id })
    expect((await repository.getSettings()).providers[0].lastValidationFailure).toBeDefined()

    // Editing with a new key changes credentials, so the stale failure is dropped (re-test needed).
    await service.upsertProvider({ id: created.id, type: 'custom', name: 'G', key: 'k2' })

    expect((await repository.getSettings()).providers[0].lastValidationFailure).toBeUndefined()
  })

  it('does not let a late validation overwrite a provider edited while the request was in flight', async () => {
    const service = createService()
    let resolveFetch!: (response: { status: number }) => void
    const fetchMock = vi.fn(
      () => new Promise<{ status: number }>((resolve) => (resolveFetch = resolve))
    )
    vi.stubGlobal('fetch', fetchMock)
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm1',
        key: 'k'
      })
    ).providers[0]

    const validation = service.validateProvider({ providerId: created.id })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await service.upsertProvider({ id: created.id, type: 'custom', name: 'G', model: 'm2' })
    resolveFetch({ status: 200 })
    await validation

    const stored = (await repository.getSettings()).providers[0]
    expect(stored.model).toBe('m2')
    expect(stored.lastValidatedAt).toBeUndefined()
  })

  it('does not let a late validation recreate a deleted provider', async () => {
    const service = createService()
    let resolveFetch!: (response: { status: number }) => void
    const fetchMock = vi.fn(
      () => new Promise<{ status: number }>((resolve) => (resolveFetch = resolve))
    )
    vi.stubGlobal('fetch', fetchMock)
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    const validation = service.validateProvider({ providerId: created.id })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await service.deleteProvider(created.id)
    resolveFetch({ status: 200 })
    await validation

    expect((await repository.getSettings()).providers).toEqual([])
  })

  it('ignores an older validation result that finishes after a newer success', async () => {
    const service = createService()
    const resolvers: Array<(response: Response) => void> = []
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => resolvers.push(resolve)))
    vi.stubGlobal('fetch', fetchMock)
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    const older = service.validateProvider({ providerId: created.id })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const newer = service.validateProvider({ providerId: created.id })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    resolvers[1](validAnthropicResponse())
    await newer
    resolvers[0](new Response(null, { status: 401 }))
    await older

    const stored = (await repository.getSettings()).providers[0]
    expect(stored.lastValidatedAt).toBeGreaterThan(0)
    expect(stored.lastValidationFailure).toBeUndefined()
  })

  it('runs a plain connectivity probe under Codex without a per-model capability check', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'Chat Gateway',
        apiEndpoints: ['openai'],
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    // Under Codex a provider test stays a connectivity/key check: a basic non-streaming ping on the
    // provider's endpoint, not a strict streaming function-tool probe. Per-model bridge support is a
    // static registry mark (bridgeUnsupportedModels), so there is no runtime capability to record.
    await repository.setAgentFramework('codex')
    await service.validateProvider({ providerId: created.id })

    const stored = (await repository.getSettings()).providers[0]
    expect(stored.lastValidatedAt).toBeGreaterThan(0)
    expect(stored.lastValidationFailure).toBeUndefined()

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(fetchMock.mock.calls[0][0]).toBe('https://g/v1/chat/completions')
    expect(body).toMatchObject({ stream: false, messages: [{ role: 'user', content: 'ping' }] })
    expect(body).not.toHaveProperty('tools')
  })
})

describe('SettingsService: preflight & spawn config', () => {
  it('gates on a detected claude and a validated active provider', async () => {
    const service = createService()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(validAnthropicResponse()))

    // Seed an existing executable path so the launch re-check passes.
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]

    // Before validation/activation the provider gate is closed.
    expect(await service.getPreflight()).toMatchObject({
      claudeReady: true,
      activeProviderReady: false
    })

    await service.validateProvider({ providerId: created.id })
    await service.setActiveProvider(created.id)

    expect(await service.getPreflight()).toEqual({
      claudeReady: true,
      opencodeReady: false,
      codexReady: false,
      agentFrameworkId: 'claude-code',
      agentReady: true,
      activeProviderReady: true
    })
  })

  it('closes the provider gate when the active shared Claude session is signed out', async () => {
    const claudeSharedAuth: ClaudeSharedAuthControllerPort = {
      getStatus: vi.fn().mockResolvedValue({
        supported: true,
        authenticated: false
      }),
      loginShared: vi.fn().mockResolvedValue({
        supported: true,
        authenticated: true
      }),
      cancelLogin: vi.fn()
    }
    const service = createService(undefined, {
      claudeSharedAuth,
      executeClaudeProbe: vi.fn().mockResolvedValue(undefined)
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await service.upsertProvider({ type: 'claude-shared' })
    await service.loginClaudeShared()
    await service.setActiveProvider(CLAUDE_SHARED_PROVIDER_ID)

    await expect(service.getPreflight()).resolves.toMatchObject({
      claudeReady: true,
      activeProviderReady: false
    })
    expect(claudeSharedAuth.getStatus).toHaveBeenCalledOnce()
  })

  it('briefly caches shared Claude auth status and rechecks it after the cache expires', async () => {
    let now = 1_000
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now)

    try {
      const claudeSharedAuth: ClaudeSharedAuthControllerPort = {
        getStatus: vi.fn().mockResolvedValue({
          supported: true,
          authenticated: true
        }),
        loginShared: vi.fn(),
        cancelLogin: vi.fn()
      }
      const service = createService(undefined, { claudeSharedAuth })
      await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
      await repository.upsertProvider({
        id: CLAUDE_SHARED_PROVIDER_ID,
        type: 'claude-shared',
        name: 'Claude subscription',
        lastValidatedAt: 1
      })
      await service.setActiveProvider(CLAUDE_SHARED_PROVIDER_ID)

      await service.getPreflight()
      await service.getPreflight()

      expect(claudeSharedAuth.getStatus).toHaveBeenCalledOnce()

      now += 5_001
      await service.getPreflight()

      expect(claudeSharedAuth.getStatus).toHaveBeenCalledTimes(2)
    } finally {
      dateNow.mockRestore()
    }
  })

  it('shares one in-flight shared Claude status check across concurrent preflights', async () => {
    let resolveStatus:
      ((status: { supported: boolean; authenticated: boolean }) => void) | undefined
    const claudeSharedAuth: ClaudeSharedAuthControllerPort = {
      getStatus: vi.fn(
        () =>
          new Promise<{ supported: boolean; authenticated: boolean }>((resolve) => {
            resolveStatus = resolve
          })
      ),
      loginShared: vi.fn(),
      cancelLogin: vi.fn()
    }
    const service = createService(undefined, {
      claudeSharedAuth,
      executeClaudeProbe: vi.fn().mockResolvedValue(undefined)
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await repository.upsertProvider({
      id: CLAUDE_SHARED_PROVIDER_ID,
      type: 'claude-shared',
      name: 'Claude subscription',
      lastValidatedAt: 1
    })
    await service.setActiveProvider(CLAUDE_SHARED_PROVIDER_ID)

    const first = service.getPreflight()
    const second = service.getPreflight()
    await vi.waitFor(() => expect(claudeSharedAuth.getStatus).toHaveBeenCalled())

    expect(claudeSharedAuth.getStatus).toHaveBeenCalledOnce()
    resolveStatus?.({ supported: true, authenticated: true })
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ activeProviderReady: true }),
      expect.objectContaining({ activeProviderReady: true })
    ])
  })

  it('does not cache a shared Claude status that resolves after login invalidation', async () => {
    let resolveStaleStatus:
      ((status: { supported: boolean; authenticated: boolean }) => void) | undefined
    const claudeSharedAuth: ClaudeSharedAuthControllerPort = {
      getStatus: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<{ supported: boolean; authenticated: boolean }>((resolve) => {
              resolveStaleStatus = resolve
            })
        )
        .mockResolvedValueOnce({ supported: true, authenticated: true }),
      loginShared: vi.fn().mockResolvedValue({ supported: true, authenticated: true }),
      cancelLogin: vi.fn()
    }
    const service = createService(undefined, {
      claudeSharedAuth,
      executeClaudeProbe: vi.fn().mockResolvedValue(undefined)
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await repository.upsertProvider({
      id: CLAUDE_SHARED_PROVIDER_ID,
      type: 'claude-shared',
      name: 'Claude subscription',
      lastValidatedAt: 1
    })
    await service.setActiveProvider(CLAUDE_SHARED_PROVIDER_ID)

    const stalePreflight = service.getPreflight()
    await vi.waitFor(() => expect(claudeSharedAuth.getStatus).toHaveBeenCalledOnce())
    await service.loginClaudeShared()
    resolveStaleStatus?.({ supported: true, authenticated: false })
    await expect(stalePreflight).resolves.toMatchObject({ activeProviderReady: false })

    await expect(service.getPreflight()).resolves.toMatchObject({ activeProviderReady: true })
    expect(claudeSharedAuth.getStatus).toHaveBeenCalledTimes(2)
  })

  it('invalidates a stale shared Claude status after browser login', async () => {
    const claudeSharedAuth: ClaudeSharedAuthControllerPort = {
      getStatus: vi
        .fn()
        .mockResolvedValueOnce({ supported: true, authenticated: false })
        .mockResolvedValueOnce({ supported: true, authenticated: true }),
      loginShared: vi.fn().mockResolvedValue({ supported: true, authenticated: true }),
      cancelLogin: vi.fn()
    }
    const service = createService(undefined, {
      claudeSharedAuth,
      executeClaudeProbe: vi.fn().mockResolvedValue(undefined)
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await repository.upsertProvider({
      id: CLAUDE_SHARED_PROVIDER_ID,
      type: 'claude-shared',
      name: 'Claude subscription',
      lastValidatedAt: 1
    })
    await service.setActiveProvider(CLAUDE_SHARED_PROVIDER_ID)

    await expect(service.getPreflight()).resolves.toMatchObject({ activeProviderReady: false })
    await service.loginClaudeShared()
    await expect(service.getPreflight()).resolves.toMatchObject({ activeProviderReady: true })

    expect(claudeSharedAuth.getStatus).toHaveBeenCalledTimes(2)
  })

  it('reuses an explicit shared Claude status check in the next preflight', async () => {
    const claudeSharedAuth: ClaudeSharedAuthControllerPort = {
      getStatus: vi.fn().mockResolvedValue({ supported: true, authenticated: true }),
      loginShared: vi.fn(),
      cancelLogin: vi.fn()
    }
    const service = createService(undefined, {
      claudeSharedAuth,
      executeClaudeProbe: vi.fn().mockResolvedValue(undefined)
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await repository.upsertProvider({
      id: CLAUDE_SHARED_PROVIDER_ID,
      type: 'claude-shared',
      name: 'Claude subscription',
      lastValidatedAt: 1
    })
    await service.setActiveProvider(CLAUDE_SHARED_PROVIDER_ID)

    await expect(service.getClaudeSharedStatus()).resolves.toMatchObject({ ok: true })
    await expect(service.getPreflight()).resolves.toMatchObject({ activeProviderReady: true })

    expect(claudeSharedAuth.getStatus).toHaveBeenCalledOnce()
  })

  it('does not reuse an authenticated shared Claude cache after app disconnect', async () => {
    const claudeSharedAuth: ClaudeSharedAuthControllerPort = {
      getStatus: vi
        .fn()
        .mockResolvedValueOnce({ supported: true, authenticated: true })
        .mockResolvedValueOnce({ supported: true, authenticated: false }),
      loginShared: vi.fn(),
      cancelLogin: vi.fn()
    }
    const service = createService(undefined, { claudeSharedAuth })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await repository.upsertProvider({
      id: CLAUDE_SHARED_PROVIDER_ID,
      type: 'claude-shared',
      name: 'Claude subscription',
      lastValidatedAt: 1
    })
    await service.setActiveProvider(CLAUDE_SHARED_PROVIDER_ID)

    await expect(service.getPreflight()).resolves.toMatchObject({ activeProviderReady: true })
    await service.logoutClaudeShared()
    const disconnectedProvider = (await repository.getSettings()).providers.find(
      (provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID
    )
    if (!disconnectedProvider) throw new Error('shared Claude provider not found')
    await repository.upsertProvider({ ...disconnectedProvider, lastValidatedAt: 2 })

    await expect(service.getPreflight()).resolves.toMatchObject({ activeProviderReady: false })
    expect(claudeSharedAuth.getStatus).toHaveBeenCalledOnce()
  })

  it('does not report claude ready when the recorded binary exists but fails --version', async () => {
    // Executable-but-corrupt runtime: execPath is a real file (X_OK passes) yet `--version` fails.
    // Preflight must validate via --version like the env check, so this must NOT pass as ready.
    const service = createService({ found: false })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })

    const preflight = await service.getPreflight()

    expect(preflight.claudeReady).toBe(false)
    expect(preflight.agentReady).toBe(false)
  })

  it('does not report opencode ready when the recorded binary exists but fails --version', async () => {
    // Same for OpenCode: the recorded path is a real executable, but its --version probe fails
    // (no opencodeDetected declared, so the injected getVersion returns undefined for it).
    const service = createService({ found: true, path: '/bin/claude', version: '2.1.0' })
    await repository.setOpencodeInfo(execPath, '1.18.3')

    const preflight = await service.getPreflight()

    expect(preflight.opencodeReady).toBe(false)
  })

  it('detects Codex and exposes readiness for its selected adapter', async () => {
    const adapterPath = '/data/codex-managed/adapter/dist/index.js'
    const nativePath = '/data/codex-managed/codex/vendor/target/bin/codex'
    const service = createService(undefined, {
      codexDetected: {
        path: adapterPath,
        version: 'codex-acp 1.1.4',
        nativePath,
        nativeVersion: 'codex-cli 0.144.6'
      }
    })

    await repository.setAgentFramework('codex')
    const snapshot = await service.detectCodex()

    expect(snapshot.codex).toEqual({
      resolvedPath: adapterPath,
      version: '1.1.4',
      nativeVersion: '0.144.6'
    })
    expect(await service.getPreflight()).toMatchObject({ codexReady: true, agentReady: true })
  })

  it('reports both Codex components ready for an external adapter whose native CLI is on the augmented PATH', async () => {
    // Regression (spec P1): an external adapter pairs successfully via the augmented PATH, but the
    // independent native-CLI probe must search the SAME dirs (/usr/local/bin here) so it agrees with
    // the smoke test. Otherwise native CLI would show missing and block Continue.
    await repository.setAgentFramework('codex')
    const service = createService(undefined, {
      codexDetected: { path: '/opt/tools/codex-acp', version: 'codex-acp 1.1.4' },
      codexExternalNative: { path: '/usr/local/bin/codex', version: 'codex-cli 0.144.6' }
    })

    const result = await service.checkEnvironment()
    const agentRows = result.checks.filter((check) => check.id === 'agent')
    const codexRows = agentRows.filter((row) => row.label.startsWith('Codex'))

    expect(codexRows.map((row) => `${row.label}:${row.status}`)).toEqual([
      'Codex native CLI:passed',
      'Codex ACP adapter:passed'
    ])
    const nativeRow = codexRows.find((row) => row.label === 'Codex native CLI')
    expect(nativeRow?.detail).toBe('/usr/local/bin/codex')
    expect(result.ready).toBe(true)
  })

  it('trusts a paired external adapter for native readiness even when the path probe misses it', async () => {
    // Regression (spec P1): the ACP handshake proves a working native CLI exists. If the independent
    // probe can't pinpoint it (unusual install dir), native CLI must still count as found so a
    // successful pairing never blocks Continue.
    await repository.setAgentFramework('codex')
    const service = createService(undefined, {
      codexDetected: { path: '/opt/tools/codex-acp', version: 'codex-acp 1.1.4' }
      // No codexExternalNative: probe finds nothing, but smoke test passed.
    })

    const result = await service.checkEnvironment()
    const codexRows = result.checks
      .filter((check) => check.id === 'agent')
      .filter((row) => row.label.startsWith('Codex'))

    expect(codexRows.map((row) => `${row.label}:${row.status}`)).toEqual([
      'Codex native CLI:passed',
      'Codex ACP adapter:passed'
    ])
    expect(result.ready).toBe(true)
  })

  it('marks the Codex adapter row failed when it is present but fails the ACP handshake', async () => {
    // Regression (spec P1): an adapter whose --version succeeds but whose ACP initialize fails must
    // surface as failed, not "ready". Full detection returns nothing, so component-level detection
    // records adapterFound=true with a smoke-test-failed reason that the UI must honor.
    await repository.setAgentFramework('codex')
    const service = createService(undefined, {
      codexDetected: { path: '/opt/tools/codex-acp', version: 'codex-acp 1.1.4' },
      codexSmokeOk: false
    })

    const result = await service.checkEnvironment()
    const adapterRow = result.checks.find(
      (check) => check.id === 'agent' && check.label === 'Codex ACP adapter'
    )

    expect(adapterRow?.status).toBe('failed')
    expect(adapterRow?.summary).toContain('failed to initialize')
    expect(result.ready).toBe(false)
  })

  it('does not mark an app-managed Codex pair ready when its native binary is broken', async () => {
    const { managedCodexAdapterEntry, managedCodexBinary } = await import('./managed-codex')
    const service = createService(undefined, {
      codexDetected: {
        path: managedCodexAdapterEntry(storageRoot),
        version: 'codex-acp 1.1.4',
        nativePath: managedCodexBinary(storageRoot)
      }
    })
    await repository.setAgentFramework('codex')
    await service.detectCodex()

    expect(await service.getPreflight()).toMatchObject({ codexReady: false, agentReady: false })
  })

  it('resolves a forced Codex backend only for a Responses provider', async () => {
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, '', 'utf8')
    const service = createService(undefined, {
      codexDetected: { path: adapterPath, version: 'codex-acp 1.1.4' }
    })
    await service.detectCodex()
    await repository.setCodexInfo({
      resolvedPath: adapterPath,
      version: '1.1.4',
      nativePath: '/data/codex-managed/native/codex',
      nativeVersion: '0.144.6'
    })
    const provider = (
      await service.upsertProvider({
        type: 'custom',
        name: 'OpenAI Responses',
        apiEndpoints: ['responses'],
        baseUrl: 'https://api.openai.com/v1/responses',
        model: 'gpt-5-codex',
        key: 'test-key'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id)
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'codex')

    const backend = await service.resolveActiveAgentBackend()
    const selection = await service.captureActiveAgentBackendSelection()

    expect(backend.framework.id).toBe('codex')
    expect(backend.executablePath).toBe(adapterPath)
    // Responses provider ⇒ no bridge ⇒ Codex runs the provider's own model, not the bridge catalog model.
    expect(backend.sessionModel).toBe('gpt-5-codex')
    expect(backend.env).toMatchObject({
      CODEX_HOME: join(storageRoot, 'codex'),
      CODEX_PATH: '/data/codex-managed/native/codex',
      NO_BROWSER: '1'
    })
    expect(backend.env.CODEX_API_KEY).toBeUndefined()
    expect(backend.authentication).toEqual({
      methodId: 'api-key',
      _meta: { 'api-key': { apiKey: 'test-key' } }
    })

    expect(selection).toEqual({ frameworkId: 'codex' })
    expect(selection).not.toHaveProperty('key')

    // The generation stays on Codex after global framework settings move elsewhere; credentials are
    // decrypted again from the active provider only when another spawn is actually needed.
    await repository.setAgentFramework('claude-code')
    const pinnedBackend = await service.resolveAgentBackend(selection)
    expect(pinnedBackend.framework.id).toBe('codex')
    expect(pinnedBackend.backendId).toBe(`codex:${provider.id}`)
    expect(pinnedBackend.authentication).toEqual({
      methodId: 'api-key',
      _meta: { 'api-key': { apiKey: 'test-key' } }
    })
  })

  it('patches an existing app-managed Codex adapter before returning the backend', async () => {
    const { managedCodexAdapterEntry } = await import('./managed-codex')
    const adapterPath = managedCodexAdapterEntry(storageRoot)
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(
      adapterPath,
      [
        '  createUsageUpdate(params) {',
        '    const used = this.sessionState.lastTokenUsage?.totalTokens;',
        '  }'
      ].join('\n')
    )
    await chmod(adapterPath, 0o755)
    await repository.setCodexInfo({
      resolvedPath: adapterPath,
      version: '1.1.4',
      nativePath: '/data/codex-managed/native/codex',
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('codex')
    const service = createService()
    const provider = (
      await service.upsertProvider({
        type: 'custom',
        name: 'Managed Responses',
        apiEndpoints: ['responses'],
        baseUrl: 'https://api.openai.com/v1/responses',
        model: 'gpt-5-codex',
        key: 'test-key'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id)

    const backend = await service.resolveActiveAgentBackend()

    expect(backend.executablePath).toBe(adapterPath)
    expect(await readFile(adapterPath, 'utf8')).toContain(
      'lastTokenUsage.inputTokens + (lastTokenUsage.cachedInputTokens ?? 0)'
    )
  })

  it.each([
    ['codex-shared', CODEX_SHARED_PROVIDER_ID],
    ['codex-isolated', CODEX_ISOLATED_PROVIDER_ID]
  ] as const)('resolves a validated %s subscription without API routing', async (type, id) => {
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, '', 'utf8')
    const service = createService(undefined, {
      codexDetected: { path: adapterPath, version: 'codex-acp 1.1.4' }
    })
    await repository.setCodexInfo({
      resolvedPath: adapterPath,
      version: '1.1.4',
      nativePath: '/data/codex-managed/native/codex',
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('codex')
    await repository.upsertProvider({
      id,
      type,
      name: type,
      apiEndpoints: ['responses'],
      lastValidatedAt: 100
    })
    await service.setActiveProvider(id, 'gpt-5.6-terra')
    if (type === 'codex-isolated') {
      const configPath = join(storageRoot, 'codex', 'config.toml')
      await mkdir(dirname(configPath), { recursive: true })
      await writeFile(
        configPath,
        'model = "account-default"\ncli_auth_credentials_store = "ephemeral"\n',
        'utf8'
      )
    }

    expect(await service.getPreflight()).toMatchObject({ activeProviderReady: true })
    const backend = await service.resolveActiveAgentBackend()

    expect(backend.backendId).toBe(`codex:builtin-${type}`)
    expect(backend.sessionModel).toBe('gpt-5.6-terra')
    expect(backend.sessionModelRequired).toBe(true)
    expect(backend.authentication).toBeUndefined()
    expect(backend.providerConfiguration).toBeUndefined()
    expect(backend.env.CODEX_API_KEY).toBeUndefined()
    if (type === 'codex-isolated') {
      // Seed the selected model into CODEX_CONFIG so codex-acp uses it from session start and the
      // first prompt doesn't wait for the late session/set_config_option model switch (issue #277).
      // The ChatGPT subscription is codex-acp's default provider, so no model_provider override.
      expect(JSON.parse(backend.env.CODEX_CONFIG ?? '{}')).toEqual({ model: 'gpt-5.6-terra' })
      expect(backend.env.MODEL_PROVIDER).toBeUndefined()
    } else {
      expect(backend.env.CODEX_CONFIG).toBeUndefined()
      expect(backend.env.MODEL_PROVIDER).toBeUndefined()
    }
    expect(backend.env.NO_BROWSER).toBeUndefined()
    expect(backend.env.CODEX_PATH).toBe('/data/codex-managed/native/codex')
    expect(backend.env.CODEX_HOME).toBe(
      type === 'codex-isolated' ? join(storageRoot, 'codex-subscription') : undefined
    )
    if (type === 'codex-isolated') {
      expect(await readFile(join(storageRoot, 'codex', 'config.toml'), 'utf8')).toBe(
        'model = "account-default"\ncli_auth_credentials_store = "ephemeral"\n'
      )
    }
  })

  it('resolves an unpinned subscription backend to the Codex account default', async () => {
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, '', 'utf8')
    const service = createService(undefined, {
      codexDetected: { path: adapterPath, version: 'codex-acp 1.1.4' }
    })
    await repository.setCodexInfo({
      resolvedPath: adapterPath,
      version: '1.1.4',
      nativePath: '/data/codex-managed/native/codex',
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('codex')
    await repository.upsertProvider({
      id: CODEX_SHARED_PROVIDER_ID,
      type: 'codex-shared',
      name: 'Codex subscription',
      apiEndpoints: ['responses'],
      lastValidatedAt: 100
    })
    await service.setActiveProvider(CODEX_SHARED_PROVIDER_ID)

    const backend = await service.resolveActiveAgentBackend()

    expect(backend.sessionModel).toBeUndefined()
    expect(backend.sessionModelRequired).toBeUndefined()
  })

  it('declares the model image capability in the resolved OpenCode backend config', async () => {
    // resolveActiveAgentBackend honors this forced-framework env above stored settings; set it
    // explicitly (a prior Codex test leaves it stubbed to 'codex') so this resolves OpenCode.
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'opencode')
    await repository.setAgentFramework('opencode')
    const service = createService(undefined, {
      opencodeDetected: { path: '/usr/local/bin/opencode', version: '1.19.0' }
    })
    const provider = (
      await service.upsertProvider({ type: 'official', name: 'Kimi', vendorId: 'kimi', key: 'k' })
    ).providers[0]
    await service.setActiveProvider(provider.id)

    const backend = await service.resolveActiveAgentBackend()

    // End-to-end guard for the whole capability chain: resolveProvider must carry supportsImageInput
    // for the multimodal default (kimi-k3) and prepareModelConfig must surface it, so OpenCode receives
    // the model as image-capable instead of a bare entry whose image parts it would strip. Deleting the
    // wiring in resolveProvider or buildModelCapabilities makes this fail.
    const content = JSON.parse(backend.env?.OPENCODE_CONFIG_CONTENT ?? '{}')
    expect(content.provider['openai-compatible'].models['kimi-k3']).toEqual({
      attachment: true,
      modalities: { input: ['text', 'image'] },
      limit: { context: 1_000_000, output: 32_000 }
    })
  })

  it('injects the selected official model context window into OpenCode', async () => {
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'opencode')
    await repository.setAgentFramework('opencode')
    const service = createService(undefined, {
      opencodeDetected: { path: '/usr/local/bin/opencode', version: '1.19.0' }
    })
    const provider = (
      await service.upsertProvider({ type: 'official', name: 'GLM', vendorId: 'zhipu', key: 'k' })
    ).providers[0]

    await service.setActiveProvider(provider.id, 'glm-5.1')
    const smallBackend = await service.resolveActiveAgentBackend()
    const smallConfig = JSON.parse(smallBackend.env?.OPENCODE_CONFIG_CONTENT ?? '{}')
    expect(smallBackend.contextWindow).toBe(200_000)
    expect(smallConfig.provider['openai-compatible'].models['glm-5.1'].limit.context).toBe(200_000)

    await service.setActiveProvider(provider.id, 'glm-5.2')
    const largeBackend = await service.resolveActiveAgentBackend()
    const largeConfig = JSON.parse(largeBackend.env?.OPENCODE_CONFIG_CONTENT ?? '{}')
    expect(largeBackend.contextWindow).toBe(1_000_000)
    expect(largeConfig.provider['openai-compatible'].models['glm-5.2'].limit.context).toBe(
      1_000_000
    )
  })

  it('resolves a Chat Completions provider through the Codex Responses bridge', async () => {
    const localFetch = globalThis.fetch
    let upstreamRequest: Record<string, unknown> | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        upstreamRequest = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(
          [
            'data: ' +
              JSON.stringify({
                id: 'chat-service-bridge',
                model: 'deepseek-v4-flash',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
              }),
            '',
            'data: [DONE]',
            ''
          ].join('\n'),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      })
    )
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, '', 'utf8')
    const service = createService(undefined, {
      codexDetected: { path: adapterPath, version: 'codex-acp 1.1.4' }
    })
    await repository.setCodexInfo({
      resolvedPath: adapterPath,
      version: '1.1.4',
      nativePath: '/data/codex-managed/native/codex',
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('codex')
    const provider = (
      await service.upsertProvider({
        type: 'official',
        name: 'DeepSeek',
        vendorId: 'deepseek',
        key: 'test-key'
      })
    ).providers[0]
    const storedProvider = (await repository.getSettings()).providers[0]
    await repository.upsertProvider({
      ...storedProvider,
      lastValidatedAt: Date.now()
    })
    await service.setActiveProvider(provider.id, 'deepseek-v4-flash')

    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'codex')
    const backend = await service.resolveActiveAgentBackend()

    // Chat Completions provider ⇒ bridge ⇒ Codex runs the classic-tool-mode catalog model so it
    // advertises the shell_command function tool the bridge can forward (CODEX_BRIDGE_MODEL).
    expect(backend.sessionModel).toBe('gpt-5.4')
    expect(backend.contextWindow).toBe(1_000_000)
    expect(backend.providerConfiguration).toEqual({
      providerId: 'custom-gateway',
      apiType: 'openai',
      baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1$/),
      headers: { authorization: expect.stringMatching(/^Bearer [a-f0-9]+$/) }
    })
    expect(backend.env.CODEX_CONFIG).toContain('"wire_api":"responses"')
    expect(backend.env.CODEX_CONFIG).not.toContain('test-key')

    const bridgeResponse = await localFetch(`${backend.providerConfiguration?.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        authorization: backend.providerConfiguration?.headers.authorization ?? '',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-5.5',
        input: 'Use PubMed to find cancer papers',
        stream: true
      })
    })
    await bridgeResponse.text()
    expect(upstreamRequest).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({
          type: 'function',
          function: expect.objectContaining({
            name: 'mcp__open_science_notebook__notebook_execute',
            description: expect.stringContaining('MUST call host.mcp')
          })
        }),
        expect.objectContaining({
          type: 'function',
          function: expect.objectContaining({
            name: 'mcp__open_science_artifacts__write_artifact_file'
          })
        }),
        expect.objectContaining({
          type: 'function',
          function: expect.objectContaining({
            name: 'mcp__open_science_activity__begin_activity_group'
          })
        })
      ])
    })
    expect(upstreamRequest?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('host.mcp("pubmed", "search_articles"')
        })
      ])
    )

    // Connector skill docs (host.mcp guidance) must be materialized into Codex's own home, not only
    // the Claude config dir, or bridged Codex never learns to reach connectors via the notebook.
    const pubmedSkill = await readFile(
      join(storageRoot, 'codex', 'skills', 'mcp-pubmed', 'SKILL.md'),
      'utf8'
    )
    expect(pubmedSkill).toContain('host.mcp')
  })

  it('keeps bridged Codex backends pinned to the provider target they were created for', async () => {
    const localFetch = globalThis.fetch
    const upstreamRequests: Array<{ url: string; authorization: string; model: unknown }> = []
    const upstreamToolNames: string[][] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        const tools = Array.isArray(body.tools) ? body.tools : []
        upstreamToolNames.push(
          tools.map((tool) =>
            String((tool as { function?: { name?: unknown } }).function?.name ?? '')
          )
        )
        upstreamRequests.push({
          url: String(url),
          authorization: String((init?.headers as Record<string, string>)?.authorization ?? ''),
          model: body.model
        })
        return new Response(
          [
            `data: ${JSON.stringify({
              id: `chat-${upstreamRequests.length}`,
              model: body.model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
            })}`,
            '',
            'data: [DONE]',
            ''
          ].join('\n'),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      })
    )
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, '', 'utf8')
    const service = createService(undefined, {
      codexDetected: { path: adapterPath, version: 'codex-acp 1.1.4' }
    })
    await repository.setCodexInfo({ resolvedPath: adapterPath, version: '1.1.4' })
    await repository.setAgentFramework('codex')
    const first = (
      await service.upsertProvider({
        type: 'custom',
        name: 'Provider One',
        apiEndpoints: ['openai'],
        baseUrl: 'https://one.example/v1',
        model: 'model-one',
        key: 'key-one'
      })
    ).providers[0]
    const second = (
      await service.upsertProvider({
        type: 'custom',
        name: 'Provider Two',
        apiEndpoints: ['openai'],
        baseUrl: 'https://two.example/v1',
        model: 'model-two',
        key: 'key-two'
      })
    ).providers.find((provider) => provider.name === 'Provider Two')!
    for (const provider of (await repository.getSettings()).providers) {
      await repository.upsertProvider({ ...provider, lastValidatedAt: Date.now() })
    }
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'codex')

    await service.setActiveProvider(first.id)
    const firstBackend = await service.resolveActiveAgentBackend()
    const firstBackendPeer = await service.resolveActiveAgentBackend()
    await service.setActiveProvider(second.id)
    const secondBackend = await service.resolveActiveAgentBackend()

    expect(firstBackend.providerConfiguration?.baseUrl).not.toBe(
      secondBackend.providerConfiguration?.baseUrl
    )

    const bridges = Array.from(
      (
        service as unknown as {
          responsesBridges: Map<string, { bridge: ResponsesBridge }>
        }
      ).responsesBridges.values(),
      (entry) => entry.bridge
    )
    bridges[0].registerReviewerSession('reviewer-one')
    bridges[1].registerReviewerSession('reviewer-two')

    const send = async (backend: typeof firstBackend, promptCacheKey: string): Promise<void> => {
      const response = await localFetch(`${backend.providerConfiguration?.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: backend.providerConfiguration?.headers.authorization ?? '',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          input: 'hello',
          prompt_cache_key: promptCacheKey,
          stream: true,
          tools: [{ type: 'tool_search' }]
        })
      })
      await response.text()
    }
    await send(firstBackend, 'reviewer-one')
    await send(secondBackend, 'reviewer-two')

    expect(upstreamRequests).toEqual([
      {
        url: 'https://one.example/v1/chat/completions',
        authorization: 'Bearer key-one',
        model: 'model-one'
      },
      {
        url: 'https://two.example/v1/chat/completions',
        authorization: 'Bearer key-two',
        model: 'model-two'
      }
    ])
    expect(upstreamToolNames).toEqual([
      expect.arrayContaining(['mcp__open_science_reviewer__submit_findings']),
      expect.arrayContaining(['mcp__open_science_reviewer__submit_findings'])
    ])

    const bridgePool = (
      service as unknown as {
        responsesBridges: Map<string, unknown>
      }
    ).responsesBridges
    expect(bridgePool.size).toBe(2)
    await firstBackend.responsesBridgeLease?.release()
    expect(bridgePool.size).toBe(2)
    await firstBackendPeer.responsesBridgeLease?.release()
    expect(bridgePool.size).toBe(1)
    await secondBackend.responsesBridgeLease?.release()
    expect(bridgePool.size).toBe(0)
  })

  it('closes and evicts a responses bridge whose start fails', async () => {
    const startError = new Error('bridge start failed')
    const startSpy = vi.spyOn(ResponsesBridgeClass.prototype, 'start').mockRejectedValue(startError)
    const closeSpy = vi.spyOn(ResponsesBridgeClass.prototype, 'close').mockResolvedValue(undefined)
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, '', 'utf8')
    const service = createService(undefined, {
      codexDetected: { path: adapterPath, version: 'codex-acp 1.1.4' }
    })
    await repository.setCodexInfo({ resolvedPath: adapterPath, version: '1.1.4' })
    await repository.setAgentFramework('codex')
    const provider = (
      await service.upsertProvider({
        type: 'custom',
        name: 'Broken bridge provider',
        apiEndpoints: ['openai'],
        baseUrl: 'https://broken.example/v1',
        model: 'model-one',
        key: 'key-one'
      })
    ).providers[0]
    const storedProvider = (await repository.getSettings()).providers[0]
    await repository.upsertProvider({ ...storedProvider, lastValidatedAt: Date.now() })
    await service.setActiveProvider(provider.id)
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'codex')

    await expect(service.resolveActiveAgentBackend()).rejects.toBe(startError)

    const bridgePool = (service as unknown as { responsesBridges: Map<string, unknown> })
      .responsesBridges
    expect(closeSpy).toHaveBeenCalledOnce()
    expect(bridgePool.size).toBe(0)
    startSpy.mockRestore()
    closeSpy.mockRestore()
  })

  it('drives a native-Responses official vendor directly, without starting the bridge', async () => {
    // MiniMax advertises anthropic + openai + responses. Codex must drive native Responses on the
    // vendor's own OpenAI /v1 base with the vendor key — NOT spin up the Chat Completions bridge and
    // post to its local URL (which would authenticate with the vendor key instead of the bridge token).
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, '', 'utf8')
    const service = createService(undefined, {
      codexDetected: { path: adapterPath, version: 'codex-acp 1.1.4' }
    })
    await repository.setCodexInfo({ resolvedPath: adapterPath, version: '1.1.4' })
    await repository.setAgentFramework('codex')
    const provider = (
      await service.upsertProvider({
        type: 'official',
        name: 'MiniMax',
        vendorId: 'minimax',
        region: 'global',
        key: 'mm-secret'
      })
    ).providers[0]
    const storedProvider = (await repository.getSettings()).providers[0]
    await repository.upsertProvider({ ...storedProvider, lastValidatedAt: Date.now() })
    await service.setActiveProvider(provider.id)

    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'codex')
    const backend = await service.resolveActiveAgentBackend()

    // No bridge: no local provider-configuration, no bridge session model.
    expect(backend.providerConfiguration).toBeUndefined()
    expect(backend.sessionModel).toBe('MiniMax-M3')
    // Codex posts native Responses to the vendor's own /v1 base with the vendor key.
    const codexConfig = JSON.parse(backend.env.CODEX_CONFIG ?? '{}')
    expect(codexConfig.model_providers['open-science']).toMatchObject({
      base_url: 'https://api.minimax.io/v1',
      wire_api: 'responses',
      requires_openai_auth: true
    })
    expect(backend.authentication).toEqual({
      methodId: 'api-key',
      _meta: { 'api-key': { apiKey: 'mm-secret' } }
    })
    expect(backend.env.CODEX_CONFIG).not.toContain('127.0.0.1')
    expect(backend.env.CODEX_CONFIG).not.toContain('mm-secret')
  })

  it('builds spawn env from the active provider with the decrypted key', async () => {
    const service = createService()

    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'm',
        key: 'test-key'
      })
    ).providers[0]
    await service.setActiveProvider(created.id)

    const config = await service.resolveActiveSpawnConfig()

    expect(config.executablePath).toBe(execPath)
    expect(config.envOverrides).toMatchObject({
      // A user-supplied trailing /v1 is normalized away; the client appends /v1/messages itself.
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_AUTH_TOKEN: 'test-key',
      ANTHROPIC_MODEL: 'm',
      CLAUDE_CONFIG_DIR: getAppClaudeConfigDir(storageRoot)
    })
    // Custom providers always use the bearer token variable, never x-api-key.
    expect(config.envOverrides.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('throws a clear error when no active provider is configured', async () => {
    const service = createService()
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })

    await expect(service.resolveActiveSpawnConfig()).rejects.toThrow(/active model provider/i)
  })
})

describe('SettingsService: official vendors', () => {
  it('stores vendor/region + key and exposes the vendor catalog in the view', async () => {
    const service = createService()

    const snapshot = await service.upsertProvider({
      type: 'official',
      name: 'MiniMax',
      vendorId: 'minimax',
      region: 'china',
      key: 'sk-mm'
    })

    const view = snapshot.providers[0]
    expect(view).toMatchObject({
      type: 'official',
      vendorId: 'minimax',
      region: 'china',
      hasKey: true
    })
    // Catalog comes from the registry, not the user; base URL is not stored on the record.
    expect(view.models).toContain('MiniMax-M3[1m]')
    expect(view.baseUrl).toBeUndefined()

    const stored = (await repository.getSettings()).providers[0]
    expect(stored.keyRef?.startsWith('enc:')).toBe(true)
    expect(JSON.stringify(stored)).not.toContain('sk-mm')
  })

  it('rejects an official provider with no vendor or no key', async () => {
    const service = createService()

    await expect(
      service.upsertProvider({ type: 'official', name: 'No vendor', key: 'k' })
    ).rejects.toThrow(/vendor is required/i)
    await expect(
      service.upsertProvider({ type: 'official', name: 'No key', vendorId: 'deepseek' })
    ).rejects.toThrow(/api key is required/i)

    expect((await repository.getSettings()).providers).toEqual([])
  })

  it('does not store a per-official model; the catalog + global selection cover it', async () => {
    const service = createService()
    const created = (
      await service.upsertProvider({ type: 'official', name: 'GLM', vendorId: 'zhipu', key: 'k' })
    ).providers[0]

    // No model is persisted on the provider; the composer/selector picks from the registry catalog.
    expect(created.model).toBeUndefined()
    expect(created.models).toContain('glm-5.2')
  })

  it('activates a chosen catalog model, falling back to the default for an unknown one', async () => {
    const service = createService()
    const created = (
      await service.upsertProvider({ type: 'official', name: 'GLM', vendorId: 'zhipu', key: 'k' })
    ).providers[0]

    // A model in the catalog is honored.
    let snapshot = await service.setActiveProvider(created.id, 'glm-5.2')
    expect(snapshot.activeModel).toBe('glm-5.2')

    // An unknown model falls back to the vendor's first catalog entry.
    snapshot = await service.setActiveProvider(created.id, 'not-a-model')
    expect(snapshot.activeModel).toBe('glm-5.2')

    // No model given also defaults to the first catalog entry.
    snapshot = await service.setActiveProvider(created.id)
    expect(snapshot.activeModel).toBe('glm-5.2')
  })

  it('builds spawn env from the registry base URL and the active model', async () => {
    const service = createService()
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const created = (
      await service.upsertProvider({
        type: 'official',
        name: 'DeepSeek',
        vendorId: 'deepseek',
        key: 'sk-ds'
      })
    ).providers[0]
    await service.setActiveProvider(created.id, 'deepseek-v4-flash')

    const config = await service.resolveActiveSpawnConfig()

    expect(config.envOverrides).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-ds',
      ANTHROPIC_MODEL: 'deepseek-v4-flash'
    })
    expect(config.contextWindow).toBe(1_000_000)
  })

  it('refreshes models from the vendor and persists them over the bundled catalog', async () => {
    const service = createService()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        json: () => Promise.resolve({ data: [{ id: 'deepseek-v5' }, { id: 'deepseek-v4-pro' }] })
      })
    )

    const created = (
      await service.upsertProvider({
        type: 'official',
        name: 'DeepSeek',
        vendorId: 'deepseek',
        key: 'k'
      })
    ).providers[0]
    // Before refresh the view exposes the bundled catalog.
    expect(created.models).toContain('deepseek-v4-pro')
    expect(created.models).not.toContain('deepseek-v5')

    const result = await service.refreshProviderModels({ providerId: created.id })
    expect(result).toMatchObject({ ok: true, models: ['deepseek-v5', 'deepseek-v4-pro'] })

    // The fetched list now backs the provider view (and persists).
    const view = (await service.getSettingsView()).providers[0]
    expect(view.models).toEqual(['deepseek-v5', 'deepseek-v4-pro'])
  })

  it('reports a refresh failure without changing the bundled catalog', async () => {
    const service = createService()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 401, json: () => Promise.resolve({}) })
    )

    const created = (
      await service.upsertProvider({
        type: 'official',
        name: 'DeepSeek',
        vendorId: 'deepseek',
        key: 'k'
      })
    ).providers[0]

    const result = await service.refreshProviderModels({ providerId: created.id })
    expect(result).toMatchObject({ ok: false, category: 'auth' })

    // Catalog unchanged.
    expect((await service.getSettingsView()).providers[0].models).toContain('deepseek-v4-pro')
  })

  it('hides refresh for a vendor without a model-list endpoint', async () => {
    const service = createService()
    const created = (
      await service.upsertProvider({ type: 'official', name: 'GLM', vendorId: 'zhipu', key: 'k' })
    ).providers[0]

    const result = await service.refreshProviderModels({ providerId: created.id })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/no model-list endpoint/i)
  })

  it('uses a basic Chat Completions probe outside Codex', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    // OpenCode drives DeepSeek's OpenAI route, so the probe hits /v1/chat/completions — but as a plain
    // non-streaming ping (the bridge streaming function-tool probe is Codex-only).
    await service.setAgentFramework('opencode')
    const result = await service.validateProvider({
      draft: { type: 'official', vendorId: 'deepseek', key: 'sk-ds' }
    })

    expect(result.ok).toBe(true)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      stream: false,
      max_tokens: 1
    })
  })

  it('probes DeepSeek on its OpenAI route as a plain connectivity check under Codex', async () => {
    const service = createService()
    await repository.setAgentFramework('codex')
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    const result = await service.validateProvider({
      draft: { type: 'official', vendorId: 'deepseek', key: 'sk-ds' }
    })

    expect(result.ok).toBe(true)
    // The dual-endpoint vendor is probed on its OpenAI /v1/chat/completions route, but with a basic
    // non-streaming ping — not a strict streaming function-tool probe. Bridge compatibility is static.
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body).toMatchObject({ stream: false, messages: [{ role: 'user', content: 'ping' }] })
    expect(body).not.toHaveProperty('tools')
  })

  it('validates an anthropic-only official draft against its /v1/messages route', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    // Claude (anthropic-only) keeps the Anthropic Messages probe.
    await service.validateProvider({
      draft: { type: 'official', vendorId: 'anthropic', key: 'sk-a' }
    })

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages')
  })
})

// The provider view's supportsImageInput drives whether the composer accepts image attachments.
// These cover every branch of SettingsService.providerSupportsImageInput end to end across all
// provider types: the type branches, the official default-model fallback, active-model switching,
// and live-fetched models.
describe('SettingsService: image-input capability', () => {
  it('reflects the custom provider flag (true only when explicitly enabled)', async () => {
    const service = createService()

    const withImagesSnapshot = await service.upsertProvider({
      type: 'custom',
      name: 'Vision gateway',
      baseUrl: 'https://g/v1',
      model: 'm',
      key: 'k',
      supportsImageInput: true
    })
    const withImages = withImagesSnapshot.providers.at(-1)
    expect(withImages?.supportsImageInput).toBe(true)

    const textOnlySnapshot = await service.upsertProvider({
      type: 'custom',
      name: 'Text gateway',
      baseUrl: 'https://t/v1',
      model: 'm',
      key: 'k'
    })
    const textOnly = textOnlySnapshot.providers.find((p) => p.name === 'Text gateway')
    expect(textOnly?.supportsImageInput).toBe(false)
  })

  it('uses the vendor default model when the provider is not the active one', async () => {
    const service = createService()

    // Claude's whole catalog is vision-capable, so its default model reports true.
    const claudeSnapshot = await service.upsertProvider({
      type: 'official',
      name: 'Claude',
      vendorId: 'anthropic',
      key: 'k'
    })
    const claude = claudeSnapshot.providers.find((p) => p.vendorId === 'anthropic')
    expect(claude?.supportsImageInput).toBe(true)

    // DeepSeek's default model is text-only.
    const deepseekSnapshot = await service.upsertProvider({
      type: 'official',
      name: 'DeepSeek',
      vendorId: 'deepseek',
      key: 'k'
    })
    const deepseek = deepseekSnapshot.providers.find((p) => p.vendorId === 'deepseek')
    expect(deepseek?.supportsImageInput).toBe(false)
  })

  it('tracks the active model for a vendor with mixed vision support (GLM)', async () => {
    const service = createService()
    const created = (
      await service.upsertProvider({ type: 'official', name: 'GLM', vendorId: 'zhipu', key: 'k' })
    ).providers[0]

    // The vision variant flips the active provider's view to true.
    let view = (await service.setActiveProvider(created.id, 'glm-5v-turbo')).providers.find(
      (provider) => provider.id === created.id
    )
    expect(view?.supportsImageInput).toBe(true)

    // Switching to a text-only model flips it back to false.
    view = (await service.setActiveProvider(created.id, 'glm-5.2')).providers.find(
      (provider) => provider.id === created.id
    )
    expect(view?.supportsImageInput).toBe(false)
  })

  it('honors live-fetched Claude models the bundled catalog does not list', async () => {
    const service = createService()
    // A refresh surfaces a Claude id not shipped in the registry; it must still count as vision.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        json: () => Promise.resolve({ data: [{ id: 'claude-opus-5-unreleased' }] })
      })
    )

    const created = (
      await service.upsertProvider({
        type: 'official',
        name: 'Claude',
        vendorId: 'anthropic',
        key: 'k'
      })
    ).providers[0]

    await service.refreshProviderModels({ providerId: created.id })
    // Activate the fetched model, then read the active provider's view.
    const view = (
      await service.setActiveProvider(created.id, 'claude-opus-5-unreleased')
    ).providers.find((provider) => provider.id === created.id)

    expect(view?.models).toEqual(['claude-opus-5-unreleased'])
    expect(view?.supportsImageInput).toBe(true)
  })

  it('uses the vendor default model, not the refreshed catalog head, for the capability fallback', async () => {
    const service = createService()
    // A refresh reorders Kimi's catalog so a text-only id leads, while the spawned default stays kimi-k3.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        json: () => Promise.resolve({ data: [{ id: 'kimi-k2.7-code' }, { id: 'kimi-k3' }] })
      })
    )
    const created = (
      await service.upsertProvider({ type: 'official', name: 'Kimi', vendorId: 'kimi', key: 'k' })
    ).providers[0]
    await service.refreshProviderModels({ providerId: created.id })

    // With no active model, the capability must match the model resolveProvider actually spawns — the
    // vendor default kimi-k3 (multimodal) — not the refreshed list head kimi-k2.7-code (text-only), or
    // OpenCode would keep stripping images from a default that supports them.
    const view = (await service.getSettingsView()).providers.find((p) => p.id === created.id)
    expect(view?.models[0]).toBe('kimi-k2.7-code')
    expect(view?.supportsImageInput).toBe(true)
  })
})

describe('SettingsService: onboarding', () => {
  it('marks onboarding complete and surfaces it in the snapshot', async () => {
    const service = createService()

    const snapshot = await service.markOnboardingComplete()
    expect(snapshot.onboardingCompletedAt).toBeTypeOf('number')

    // The persisted value is visible on a fresh read too.
    const view = await service.getSettingsView()
    expect(view.onboardingCompletedAt).toBe(snapshot.onboardingCompletedAt)
  })

  it('marks legacy paths normalized and persists it across a fresh read', async () => {
    const service = createService()

    await service.markPathsNormalized()

    const settings = await service.getStoredSettings()
    expect(settings.pathsNormalizedAt).toBeTypeOf('number')
  })

  it('persists a new dataRoot across a fresh read', async () => {
    const service = createService()

    // The repository canonicalizes dataRoot to the host separator on read (for samePath comparisons),
    // so build the fixture the same way — a bare POSIX literal comes back with backslashes on Windows
    // and would fail the round-trip.
    const dataRoot = normalize('/mnt/new-data')
    await service.setDataRoot(dataRoot)

    const settings = await service.getStoredSettings()
    expect(settings.dataRoot).toBe(dataRoot)
  })
})

describe('SettingsService: skills', () => {
  // Seeds a bundled-skills root with one "demo" skill + manifest for an injectable registry.
  const seedBundle = async (): Promise<string> => {
    const bundle = await mkdtemp(join(tmpdir(), 'os-skills-bundle-'))
    await mkdir(join(bundle, 'demo'), { recursive: true })
    await writeFile(
      join(bundle, 'demo', 'SKILL.md'),
      ['---', 'name: demo', 'description: A demo skill.', '---', '', 'demo body'].join('\n'),
      'utf8'
    )
    await writeFile(
      join(bundle, 'manifest.json'),
      JSON.stringify({
        version: 1,
        skills: [
          { id: 'demo', name: 'Demo', source: 'featured', updatedAt: '2026-01-01T00:00:00.000Z' }
        ]
      }),
      'utf8'
    )
    return bundle
  }

  const createSkillService = async (): Promise<InstanceType<typeof SettingsService>> =>
    new SettingsService({
      repository,
      storageRoot,
      skillRegistry: new SkillRegistry(await seedBundle())
    })

  it('lists skills with enabled reflecting disabledSkillIds and returns detail body', async () => {
    const service = await createSkillService()

    let skills = await service.listSkills()
    expect(skills).toEqual([
      expect.objectContaining({
        id: 'demo',
        name: 'Demo',
        description: 'A demo skill.',
        enabled: true
      })
    ])

    skills = await service.setSkillEnabled({ id: 'demo', enabled: false })
    expect(skills[0].enabled).toBe(false)

    const detail = await service.getSkillDetail('demo')
    expect(detail.body).toContain('demo body')
  })

  it('creates, edits, and deletes a personal skill alongside featured skills', async () => {
    const service = await createSkillService()

    let skills = await service.createSkill({
      name: 'My Skill',
      description: 'Mine.',
      body: '# Mine'
    })
    // Featured (demo) + the new personal skill, both enabled by default.
    expect(skills.map((skill) => skill.id).sort()).toEqual(['demo', 'personal-my-skill'])
    const personal = skills.find((skill) => skill.id === 'personal-my-skill')
    expect(personal).toMatchObject({ source: 'personal', enabled: true })

    const detail = await service.getSkillDetail('personal-my-skill')
    expect(detail.body).toContain('# Mine')

    skills = await service.updateSkill({
      id: 'personal-my-skill',
      name: 'My Skill',
      description: 'Edited.',
      body: '# Edited'
    })
    expect(skills.find((skill) => skill.id === 'personal-my-skill')?.description).toBe('Edited.')

    skills = await service.deleteSkill({ id: 'personal-my-skill' })
    expect(skills.map((skill) => skill.id)).toEqual(['demo'])
  })

  it('creates with a custom slug and reconciles references reported by the detail view', async () => {
    const service = await createSkillService()
    const b64 = (text: string): string => Buffer.from(text).toString('base64')

    await service.createSkill({
      name: 'Ref Skill',
      description: 'd',
      body: '# body',
      slug: 'ref-skill-id',
      references: [
        { path: 'keep.py', dataBase64: b64('keep') },
        { path: 'drop.py', dataBase64: b64('drop') }
      ]
    })

    let detail = await service.getSkillDetail('personal-ref-skill-id')
    expect(detail.references.map((ref) => ref.path)).toEqual(['drop.py', 'keep.py'])

    // Editing keeps one file, drops one, and adds one.
    await service.updateSkill({
      id: 'personal-ref-skill-id',
      name: 'Ref Skill',
      description: 'd',
      body: '# body',
      references: [{ path: 'keep.py' }, { path: 'new.py', dataBase64: b64('new') }]
    })

    detail = await service.getSkillDetail('personal-ref-skill-id')
    expect(detail.references.map((ref) => ref.path)).toEqual(['keep.py', 'new.py'])
  })

  it('force-loads a disabled picked skill for the turn without mutating stored settings', async () => {
    const service = await createSkillService()

    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const created = (
      await service.upsertProvider({
        type: 'custom',
        name: 'Local',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]
    await service.setActiveProvider(created.id)
    await service.setSkillEnabled({ id: 'demo', enabled: false })

    const skillDir = join(getAppClaudeConfigDir(storageRoot), 'skills', 'os-demo')
    const exists = async (path: string): Promise<boolean> =>
      readFile(join(path, 'SKILL.md'), 'utf8').then(
        () => true,
        () => false
      )

    // Disabled: the skill is not materialized on a normal spawn.
    await service.resolveActiveSpawnConfig()
    expect(await exists(skillDir)).toBe(false)

    // Turn-forced: the disabled skill is materialized for this spawn only.
    await service.resolveActiveSpawnConfig({ forcedSkillIds: ['demo'] })
    expect(await exists(skillDir)).toBe(true)

    // The stored disabled set is untouched, so the skill still lists as disabled.
    const skills = await service.listSkills()
    expect(skills.find((skill) => skill.id === 'demo')?.enabled).toBe(false)

    // Clearing the force set removes it again on the next spawn.
    await service.resolveActiveSpawnConfig()
    expect(await exists(skillDir)).toBe(false)
  })

  it('provisions Open Science assets into the shared Claude runtime directory', async () => {
    const userClaudeDir = join(storageRoot, 'shared-claude')
    const userSkillDir = join(userClaudeDir, 'skills', 'os-user-owned')
    const userConnectorDir = join(userClaudeDir, 'skills', 'mcp-pubmed')
    const appClaudeDir = getAppClaudeConfigDir(storageRoot)
    const customConnectorDir = join(appClaudeDir, 'skills', 'mcp-custom-server')
    await mkdir(userSkillDir, { recursive: true })
    await mkdir(userConnectorDir, { recursive: true })
    await mkdir(customConnectorDir, { recursive: true })
    await writeFile(join(userSkillDir, 'SKILL.md'), '# User skill', 'utf8')
    await writeFile(join(userConnectorDir, 'SKILL.md'), '# User connector skill', 'utf8')
    await writeFile(join(customConnectorDir, 'SKILL.md'), '# Custom connector doc', 'utf8')
    await writeFile(
      join(userClaudeDir, 'settings.json'),
      JSON.stringify({ model: 'keep-user-model' }),
      'utf8'
    )
    const service = new SettingsService({
      repository,
      storageRoot,
      userClaudeDir,
      skillRegistry: new SkillRegistry(await seedBundle())
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await service.upsertProvider({ type: 'claude-shared' })
    await service.setActiveProvider(CLAUDE_SHARED_PROVIDER_ID)

    const managedSkillDir = join(appClaudeDir, 'skills', 'os-demo')
    const managedSkillFile = join(managedSkillDir, 'SKILL.md')
    try {
      const config = await service.resolveActiveSpawnConfig()

      expect(config.envOverrides.CLAUDE_CONFIG_DIR).toBe(userClaudeDir)
      expect(config.sessionOptions).toEqual({
        settings: join(appClaudeDir, 'settings.json'),
        plugins: [{ type: 'local', path: appClaudeDir, skipMcpDiscovery: true }]
      })
      expect(await readFile(managedSkillFile, 'utf8')).toContain('demo body')
      expect(await readFile(join(userSkillDir, 'SKILL.md'), 'utf8')).toBe('# User skill')
      expect(await readFile(join(userConnectorDir, 'SKILL.md'), 'utf8')).toBe(
        '# User connector skill'
      )
      expect(
        await readFile(join(appClaudeDir, 'skills', 'mcp-pubmed', 'SKILL.md'), 'utf8')
      ).toContain('name: mcp-pubmed')
      expect(await readFile(join(customConnectorDir, 'SKILL.md'), 'utf8')).toBe(
        '# Custom connector doc'
      )
      expect(JSON.parse(await readFile(join(userClaudeDir, 'settings.json'), 'utf8'))).toEqual({
        model: 'keep-user-model'
      })
      const appSettings = JSON.parse(await readFile(join(appClaudeDir, 'settings.json'), 'utf8'))
      expect(appSettings.disableBundledSkills).toBe(true)
      expect(appSettings.permissions.deny).toEqual(
        expect.arrayContaining([expect.stringMatching(/^Read/)])
      )
    } finally {
      await chmod(managedSkillFile, 0o644).catch(() => undefined)
      await chmod(managedSkillDir, 0o755).catch(() => undefined)
    }
  })

  it('materializes enabled skills into the app-owned CODEX_HOME before spawn', async () => {
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, '', 'utf8')
    const service = new SettingsService({
      repository,
      storageRoot,
      skillRegistry: new SkillRegistry(await seedBundle()),
      codexDetectDeps: {
        env: { PATH: dirname(adapterPath) },
        homePath: '/home',
        // Detection walks PATH with the host's path rules; this test's adapterPath/PATH are real
        // on-disk host paths, so mock the host platform (a fixed 'linux' shreds a Windows drive letter
        // like C:\… when splitting PATH on ':' , so detection would never match the file it created).
        platform: process.platform,
        isRunnable: (path) => Promise.resolve(path === adapterPath),
        getAdapterVersion: () => Promise.resolve('codex-acp 1.1.4'),
        getCodexVersion: () => Promise.resolve(undefined),
        smokeInitialize: () => Promise.resolve(true),
        resolveNpmBinDirs: () => Promise.resolve([])
      }
    })
    await repository.setCodexInfo({ resolvedPath: adapterPath, version: '1.1.4' })
    await repository.setAgentFramework('codex')
    const provider = (
      await service.upsertProvider({
        type: 'custom',
        name: 'Responses',
        apiEndpoints: ['responses'],
        baseUrl: 'https://api.openai.com',
        model: 'gpt-5-codex',
        key: 'k'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id)

    await service.resolveActiveAgentBackend()

    const materializedDir = join(storageRoot, 'codex', 'skills', 'os-demo')
    const materializedFile = join(materializedDir, 'SKILL.md')
    expect(await readFile(materializedFile, 'utf8')).toContain('demo body')
    // The materializer intentionally makes agent-visible skills read-only; restore permissions so the
    // test temp root can be removed on every platform.
    await chmod(materializedFile, 0o644)
    await chmod(materializedDir, 0o755)
  })

  it('does not synchronize app skills into the user-owned shared Codex profile', async () => {
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, '', 'utf8')
    await chmod(adapterPath, 0o755)
    const service = new SettingsService({
      repository,
      storageRoot,
      skillRegistry: new SkillRegistry(await seedBundle()),
      codexDetectDeps: {
        env: {},
        homePath: '/home',
        platform: 'linux',
        isRunnable: (path) => Promise.resolve(path === adapterPath),
        getAdapterVersion: () => Promise.resolve('codex-acp 1.1.4'),
        getCodexVersion: () => Promise.resolve(undefined),
        smokeInitialize: () => Promise.resolve(true),
        resolveNpmBinDirs: () => Promise.resolve([])
      }
    })
    await repository.setCodexInfo({ resolvedPath: adapterPath, version: '1.1.4' })
    await repository.setAgentFramework('codex')
    await repository.upsertProvider({
      id: CODEX_SHARED_PROVIDER_ID,
      type: 'codex-shared',
      name: 'Existing Codex profile',
      apiEndpoints: ['responses'],
      lastValidatedAt: 1
    })
    await service.setActiveProvider(CODEX_SHARED_PROVIDER_ID)

    await service.resolveActiveAgentBackend()

    await expect(
      readFile(join(storageRoot, 'codex', 'skills', 'os-demo', 'SKILL.md'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports disabled picks and resolves agent-readable skill nudge names', async () => {
    const service = await createSkillService()

    await service.createSkill({ name: 'My Skill', description: 'Mine.', body: '# Mine' })
    await service.setSkillEnabled({ id: 'demo', enabled: false })

    // Only the disabled pick (demo) needs a respawn; the enabled personal skill does not.
    expect(await service.skillsNeedingForceLoad(['demo', 'personal-my-skill'])).toEqual(['demo'])
    expect(await service.skillsNeedingForceLoad(['personal-my-skill'])).toEqual([])

    // Featured ids are the agent-facing frontmatter names, but user-skill ids carry an app prefix.
    expect(await service.skillNudgeNamesForIds(['demo', 'personal-my-skill', 'nope'])).toEqual([
      'demo',
      'My Skill'
    ])
  })

  it('uses the frontmatter name when nudging an imported skill', async () => {
    const service = new SettingsService({
      repository,
      storageRoot,
      skillRegistry: new SkillRegistry(await seedBundle()),
      userSkills: {
        list: () =>
          Promise.resolve([
            {
              id: 'imported-data-explorer',
              name: 'Data Explorer',
              description: 'Explore imported data.',
              source: 'imported' as const,
              updatedAt: '2026-07-23T00:00:00.000Z',
              sourceDir: join(storageRoot, 'skills', 'imported', 'data-explorer')
            }
          ])
      } as unknown as UserSkillRepository
    })

    expect(await service.skillNudgeNamesForIds(['imported-data-explorer'])).toEqual([
      'Data Explorer'
    ])
  })

  // GitHub scan/import must go through the proxy-aware net.fetch, not Node's global fetch (which
  // ignores the system/VPN proxy and gets a 403 in proxied environments). These lock the wiring so a
  // regression back to the default fetch is caught.
  it('imports a GitHub skill through the proxy-aware net.fetch', async () => {
    const importFromGitHub = vi.fn().mockResolvedValue({ status: 'imported', id: 'imported-x' })
    const service = new SettingsService({
      repository,
      storageRoot,
      skillRegistry: new SkillRegistry(await seedBundle()),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userSkills: { importFromGitHub, list: () => Promise.resolve([]) } as any
    })

    await service.importSkill({ url: 'https://github.com/o/r/tree/main/skills/demo' })

    expect(importFromGitHub).toHaveBeenCalledWith(
      'https://github.com/o/r/tree/main/skills/demo',
      netFetch
    )
  })

  it('scans a GitHub repo through the proxy-aware net.fetch', async () => {
    const scanRepo = vi.fn().mockResolvedValue([])
    const service = new SettingsService({
      repository,
      storageRoot,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userSkills: { scanRepo } as any
    })

    await service.scanRepoSkills({ repo: 'o/r' })

    expect(scanRepo).toHaveBeenCalledWith('o/r', netFetch)
  })
})

describe('installClaude (app-managed source)', () => {
  it('routes managed installs through the managed installer and persists the resolved path', async () => {
    const service = createService(undefined, {
      installManagedClaudeImpl: async ({ installId }) => ({
        result: { installId, ok: true },
        resolvedPath: '/data/claude-code/bin/claude',
        version: '2.1.209'
      })
    })

    const result = await service.installClaude({ source: 'managed' }, () => undefined)

    expect(result.ok).toBe(true)
    const snapshot = await service.getSettingsView()
    expect(snapshot.claude).toEqual({
      resolvedPath: '/data/claude-code/bin/claude',
      version: '2.1.209'
    })
  })

  it('does not persist claude info when the managed install fails', async () => {
    const service = createService(undefined, {
      installManagedClaudeImpl: async ({ installId }) => ({
        result: { installId, ok: false, error: 'all registries failed' }
      })
    })

    const result = await service.installClaude({ source: 'managed' }, () => undefined)

    expect(result.ok).toBe(false)
    const snapshot = await service.getSettingsView()
    expect(snapshot.claude).toEqual({})
  })

  it('logs a version error and rejects an incompatible managed runtime', async () => {
    const logs: string[] = []
    const service = createService(
      { found: false, path: undefined, version: undefined },
      {
        installManagedClaudeImpl: async ({ installId }) => ({
          result: { installId, ok: true },
          resolvedPath: '/data/claude-code/bin/claude',
          version: '9.9.9'
        })
      }
    )

    const result = await service.installClaude({ source: 'managed' }, (event) => {
      if (event.kind === 'log') logs.push(event.chunk)
    })

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('version') })
    expect(logs.at(-1)).toContain('incompatible or incomplete')
    expect((await service.getSettingsView()).claude).toEqual({})
  })

  it('puts an explicitly requested China-friendly mirror first', async () => {
    const installManagedClaudeImpl = vi.fn<ManagedInstallImpl>(async ({ installId }) => ({
      result: { installId, ok: false }
    }))
    const service = createService(undefined, { installManagedClaudeImpl })

    await service.installClaude(
      { source: 'managed', managedRegistry: 'npmmirror' },
      () => undefined
    )

    expect(installManagedClaudeImpl.mock.calls[0]?.[0].registries).toEqual([
      'https://registry.npmmirror.com',
      'https://registry.npmjs.org'
    ])
  })
})

describe('installOpencode', () => {
  it('routes a managed install through the managed installer and persists path + version', async () => {
    const service = createService(undefined, {
      installManagedOpencodeImpl: async ({ installId }) => ({
        result: { installId, ok: true },
        resolvedPath: '/data/opencode-managed/bin/opencode',
        version: '1.18.3'
      })
    })

    const result = await service.installOpencode({ source: 'managed' }, () => undefined)

    expect(result.ok).toBe(true)
    expect((await service.getSettingsView()).opencode).toEqual({
      resolvedPath: '/data/opencode-managed/bin/opencode',
      version: '1.18.3'
    })
  })

  it('does not persist opencode info when the managed install fails', async () => {
    const service = createService(undefined, {
      installManagedOpencodeImpl: async ({ installId }) => ({
        result: { installId, ok: false, error: 'all registries failed' }
      })
    })

    const result = await service.installOpencode({ source: 'managed' }, () => undefined)

    expect(result.ok).toBe(false)
    expect((await service.getSettingsView()).opencode).toEqual({})
  })
})

describe('installCodex', () => {
  it('persists the managed adapter and native Codex pair', async () => {
    const service = createService(undefined, {
      installManagedCodexImpl: async ({ installId }) => ({
        result: { installId, ok: true },
        adapterPath: '/data/codex-managed/adapter/dist/index.js',
        adapterVersion: '1.1.4',
        codexPath: '/data/codex-managed/codex/vendor/target/bin/codex',
        codexVersion: '0.144.6'
      })
    })

    const result = await service.installCodex({ source: 'managed' }, () => undefined)

    expect(result.ok).toBe(true)
    expect((await repository.getSettings()).codex).toEqual({
      resolvedPath: '/data/codex-managed/adapter/dist/index.js',
      version: '1.1.4',
      nativePath: '/data/codex-managed/codex/vendor/target/bin/codex',
      nativeVersion: '0.144.6'
    })
  })
})

describe('detectOpencode', () => {
  it('clears a stale record when nothing runnable is found (e.g. after an uninstall)', async () => {
    // Simulate a prior install still recorded in settings.
    await repository.setOpencodeInfo('/gone/bin/opencode', '1.18.3')
    const service = createService() // default deps find nothing

    const snapshot = await service.detectOpencode()

    // The stale path/version are forgotten so the card and gates reflect the uninstall.
    expect(snapshot.opencode).toEqual({})
    expect((await repository.getSettings()).opencodePath).toBeUndefined()
  })

  it('records the detected path + version when opencode is present', async () => {
    const service = createService(undefined, {
      opencodeDetected: { path: '/usr/local/bin/opencode', version: '1.19.0' }
    })

    const snapshot = await service.detectOpencode()

    expect(snapshot.opencode).toEqual({
      resolvedPath: '/usr/local/bin/opencode',
      version: '1.19.0'
    })
  })

  it('keeps a still-present record when the live probe misses (GUI PATH gap, not an uninstall)', async () => {
    // A real executable the probe fails to see (e.g. narrower GUI PATH). The record must survive.
    const present = join(storageRoot, 'opencode-present')
    await writeFile(present, '', 'utf8')
    await chmod(present, 0o755)
    await repository.setOpencodeInfo(present, '1.18.3')
    const service = createService() // default deps find nothing

    const snapshot = await service.detectOpencode()

    expect(snapshot.opencode).toEqual({ resolvedPath: present, version: '1.18.3' })
  })
})

describe('detectClaude hardening', () => {
  it('forgets the recorded claude when its binary is gone from disk (uninstall)', async () => {
    await repository.setClaudeInfo({ resolvedPath: '/gone/bin/claude', version: '2.1.0' })
    // found:false + version:undefined makes the injected probe report nothing runnable.
    const service = createService({ found: false, path: undefined, version: undefined })

    await service.detectClaude()

    // The stale path is forgotten (an empty claude record sanitizes away to undefined on read).
    expect((await repository.getSettings()).claude?.resolvedPath).toBeUndefined()
  })

  it('keeps the cached claude on a transient probe miss when its binary still exists', async () => {
    const present = join(storageRoot, 'claude-present')
    await writeFile(present, '', 'utf8')
    await chmod(present, 0o755)
    await repository.setClaudeInfo({ resolvedPath: present, version: '2.1.0' })
    const service = createService({ found: false, path: undefined, version: undefined })

    await service.detectClaude()

    // A GUI PATH gap must not wipe a still-installed claude.
    expect((await repository.getSettings()).claude).toEqual({
      resolvedPath: present,
      version: '2.1.0'
    })
  })
})

describe('checkEnvironment', () => {
  it('keeps a cached executable that still runs when a GUI PATH cannot rediscover it', async () => {
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const service = new SettingsService({
      repository,
      storageRoot,
      detectDeps: {
        env: {},
        homePath: '/home',
        platform: 'linux',
        // PATH scan finds nothing, but the cached path still reports a version.
        isExecutable: () => Promise.resolve(false),
        getVersion: (path) => Promise.resolve(path === execPath ? '2.1.0' : undefined),
        resolveNpmBinDirs: () => Promise.resolve([])
      }
    })

    const result = await service.checkEnvironment()

    expect(result.runtime).toEqual({ found: true, path: execPath, version: '2.1.0' })
    expect(result.checks.find((check) => check.id === 'agent')?.status).toBe('passed')
  })

  it('does not overwrite a healthy recorded executable with a freshly detected PATH entry', async () => {
    // Pinned platform is 'linux', so use posix literals; a host join() would splice a win32 drive
    // letter into PATH and be mis-split on ':' by the posix delimiter.
    const other = '/other-bin/claude'
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const service = new SettingsService({
      repository,
      storageRoot,
      detectDeps: {
        env: { PATH: '/other-bin' },
        homePath: '/home',
        platform: 'linux',
        // A different claude is discoverable on PATH, but the cached one is still healthy.
        isExecutable: (path) => Promise.resolve(path === other),
        getVersion: (path) =>
          Promise.resolve(path === execPath ? '2.1.0' : path === other ? '9.9.9' : undefined),
        resolveNpmBinDirs: () => Promise.resolve([])
      }
    })

    const result = await service.checkEnvironment()

    // The recorded runtime is retained rather than being replaced by the PATH discovery.
    expect(result.runtime).toEqual({ found: true, path: execPath, version: '2.1.0' })
    expect((await repository.getSettings()).claude?.resolvedPath).toBe(execPath)
  })

  it('re-detects when the recorded executable no longer reports a version', async () => {
    // Pinned platform is 'linux', so use posix literals (see the note above about PATH splitting).
    const stale = '/stale/claude'
    const found = '/found-bin/claude'
    await repository.setClaudeInfo({ resolvedPath: stale, version: '2.1.0' })
    const service = new SettingsService({
      repository,
      storageRoot,
      detectDeps: {
        env: { PATH: '/found-bin' },
        homePath: '/home',
        platform: 'linux',
        isExecutable: (path) => Promise.resolve(path === found),
        // The cached path is dead (no version); detection finds a live one on PATH.
        getVersion: (path) => Promise.resolve(path === found ? '2.2.0' : undefined),
        resolveNpmBinDirs: () => Promise.resolve([])
      }
    })

    const result = await service.checkEnvironment()

    expect(result.runtime).toEqual({ found: true, path: found, version: '2.2.0' })
    expect((await repository.getSettings()).claude?.resolvedPath).toBe(found)
  })

  it('checks both framework runtimes together and gates on the selected one (OpenCode)', async () => {
    await repository.setAgentFramework('opencode')
    // Claude is detectable (default detectDeps) and OpenCode is declared installed; both rows appear,
    // but the result's runtime + gating reflect the SELECTED framework (OpenCode).
    const service = createService(undefined, {
      opencodeDetected: { path: '/usr/local/bin/opencode', version: '1.19.0' }
    })

    const result = await service.checkEnvironment()

    const agentRows = result.checks.filter((check) => check.id === 'agent')
    expect(agentRows.map((row) => row.label)).toEqual([
      'Claude Code runtime',
      'OpenCode runtime',
      'Codex native CLI',
      'Codex ACP adapter'
    ])
    expect(agentRows.map((row) => row.status)).toEqual(['passed', 'passed', 'warning', 'warning'])
    expect(result.agentFrameworkId).toBe('opencode')
    expect(result.runtime).toEqual({
      found: true,
      path: '/usr/local/bin/opencode',
      version: '1.19.0'
    })
  })

  it('persists a freshly detected OpenCode runtime discovered during the dual probe', async () => {
    // No recorded opencode; the parallel probe detects one on PATH and must record it so later
    // gates/cards read the same runtime without re-probing.
    const service = createService(undefined, {
      opencodeDetected: { path: '/usr/local/bin/opencode', version: '1.19.0' }
    })

    await service.checkEnvironment()

    const settings = await repository.getSettings()
    expect(settings.opencodePath).toBe('/usr/local/bin/opencode')
    expect(settings.opencodeVersion).toBe('1.19.0')
  })

  it('gates on the selected framework: OpenCode selected but missing blocks while Claude passes', async () => {
    await repository.setAgentFramework('opencode')
    // Claude is detectable (default detectDeps); OpenCode is declared absent (no opencodeDetected).
    const service = createService()

    const result = await service.checkEnvironment()

    const agentRows = result.checks.filter((check) => check.id === 'agent')
    expect(agentRows.map((row) => `${row.label}:${row.status}`)).toEqual([
      'Claude Code runtime:passed',
      'OpenCode runtime:failed',
      'Codex native CLI:warning',
      'Codex ACP adapter:warning'
    ])
    // Selection drives readiness: the missing selected runtime blocks Continue even though Claude runs.
    expect(result.agentFrameworkId).toBe('opencode')
    expect(result.ready).toBe(false)
    expect(result.runtime).toEqual({ found: false })
  })
})

describe('SettingsService: managed-runtime flags', () => {
  it('reports claudeManaged when the resolved path is the app-managed install, opencode as non-managed', async () => {
    await repository.setClaudeInfo({
      resolvedPath: join(managedClaudeDir(storageRoot), 'claude'),
      version: '2.1.0'
    })
    // A user's own PATH opencode is never treated as managed.
    await repository.setOpencodeInfo('/usr/local/bin/opencode', '1.18.3')
    const service = createService()

    const snapshot = await service.getSettingsView()

    expect(snapshot.claudeManaged).toBe(true)
    expect(snapshot.opencodeManaged).toBe(false)
  })
})

describe('SettingsService: uninstall managed runtime', () => {
  it('uninstalls app-managed Codex and falls back to ready Claude', async () => {
    const { managedCodexAdapterEntry } = await import('./managed-codex')
    const adapterPath = managedCodexAdapterEntry(storageRoot)
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, '', 'utf8')
    await repository.setCodexInfo({ resolvedPath: adapterPath, version: '1.1.4' })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await repository.setAgentFramework('codex')
    const service = createService()

    const { snapshot, activeBackendAffected } = await service.uninstallCodex()

    await expect(readFile(adapterPath)).rejects.toThrow()
    expect(snapshot.codex).toEqual({})
    expect(snapshot.agentFrameworkId).toBe('claude-code')
    expect(activeBackendAffected).toBe(true)
  })

  it('uninstallClaude is a no-op for a non-managed (PATH/npm) install', async () => {
    await repository.setClaudeInfo({ resolvedPath: '/usr/local/bin/claude', version: '2.1.0' })
    const service = createService()

    const { snapshot, activeBackendAffected } = await service.uninstallClaude()

    // The install we did not own is left untouched, and nothing about the active backend changed.
    expect(snapshot.claude).toEqual({ resolvedPath: '/usr/local/bin/claude', version: '2.1.0' })
    expect(snapshot.claudeManaged).toBe(false)
    expect(activeBackendAffected).toBe(false)
  })

  it('uninstallOpencode removes the managed install, clears the record, and auto-switches to Claude when it was active', async () => {
    // A real managed opencode binary on disk, recorded and selected as the active backend.
    const opencodeBin = join(managedOpencodeDir(storageRoot), 'opencode')
    await mkdir(managedOpencodeDir(storageRoot), { recursive: true })
    await writeFile(opencodeBin, '', 'utf8')
    await chmod(opencodeBin, 0o755)
    await repository.setOpencodeInfo(opencodeBin, '1.18.3')
    // A separate Claude still present on disk, so the active framework can fall back to it.
    const claudeBin = join(storageRoot, 'fake-claude', 'claude')
    await mkdir(dirname(claudeBin), { recursive: true })
    await writeFile(claudeBin, '', 'utf8')
    await chmod(claudeBin, 0o755)
    await repository.setClaudeInfo({ resolvedPath: claudeBin, version: '2.1.0' })
    await repository.setAgentFramework('opencode')
    const service = createService()

    const { snapshot, activeBackendAffected } = await service.uninstallOpencode()

    // The managed tree is gone, the record is cleared, and the active backend fell back to Claude.
    await expect(readFile(opencodeBin)).rejects.toThrow()
    expect(snapshot.opencode).toEqual({})
    expect(snapshot.opencodeManaged).toBe(false)
    expect(snapshot.agentFrameworkId).toBe('claude-code')
    // OpenCode was the active backend, so the caller must reconnect.
    expect(activeBackendAffected).toBe(true)
  })

  it('does not flag the active backend when the uninstalled runtime was not active', async () => {
    // Managed OpenCode installed but Claude is the active framework.
    const opencodeBin = join(managedOpencodeDir(storageRoot), 'opencode')
    await mkdir(managedOpencodeDir(storageRoot), { recursive: true })
    await writeFile(opencodeBin, '', 'utf8')
    await repository.setOpencodeInfo(opencodeBin, '1.18.3')
    await repository.setAgentFramework('claude-code')
    const service = createService()

    const { activeBackendAffected } = await service.uninstallOpencode()

    // Removing the inactive runtime leaves the live (Claude) agent untouched — no reconnect.
    expect(activeBackendAffected).toBe(false)
  })

  it('does not auto-switch to the other runtime when it exists but cannot report a version (not ready)', async () => {
    const opencodeBin = join(managedOpencodeDir(storageRoot), 'opencode')
    await mkdir(managedOpencodeDir(storageRoot), { recursive: true })
    await writeFile(opencodeBin, '', 'utf8')
    await repository.setOpencodeInfo(opencodeBin, '1.18.3')
    // A Claude binary present on disk but broken — it exists yet reports no version.
    const claudeBin = join(storageRoot, 'fake-claude', 'claude')
    await mkdir(dirname(claudeBin), { recursive: true })
    await writeFile(claudeBin, '', 'utf8')
    await repository.setClaudeInfo({ resolvedPath: claudeBin, version: '2.1.0' })
    await repository.setAgentFramework('opencode')
    // getVersion resolves undefined for every path, so Claude reads as not ready (like preflight).
    const service = createService({ found: false, path: undefined, version: undefined })

    const { snapshot } = await service.uninstallOpencode()

    // A broken runtime is never auto-selected: the selection stays put and the gate will flag it.
    expect(snapshot.agentFrameworkId).toBe('opencode')
  })

  it('falls through to ready Codex when earlier fallback runtimes are unavailable', async () => {
    const opencodeBin = join(managedOpencodeDir(storageRoot), 'opencode')
    const codexAdapter = join(storageRoot, 'fallback', 'codex-acp')
    await mkdir(dirname(opencodeBin), { recursive: true })
    await mkdir(dirname(codexAdapter), { recursive: true })
    await writeFile(opencodeBin, '', 'utf8')
    await writeFile(codexAdapter, '', 'utf8')
    await repository.setOpencodeInfo(opencodeBin, '1.18.3')
    await repository.setCodexInfo({ resolvedPath: codexAdapter, version: '1.1.4' })
    await repository.setAgentFramework('opencode')
    const service = createService(
      { found: false },
      {
        codexDetected: { path: codexAdapter, version: 'codex-acp 1.1.4' }
      }
    )

    const { snapshot } = await service.uninstallOpencode()

    expect(snapshot.agentFrameworkId).toBe('codex')
  })
})

describe('SettingsService: reasoning effort', () => {
  it("projects 'default' when no reasoning effort is stored", async () => {
    const service = createService()

    expect((await service.getSettingsView()).reasoningEffort).toBe('default')
  })

  it('projects the stored level into the settings view', async () => {
    const service = createService()

    await repository.setReasoningEffort('low')

    expect((await service.getSettingsView()).reasoningEffort).toBe('low')
  })

  it('persists the level and returns the refreshed snapshot', async () => {
    const service = createService()

    const snapshot = await service.setReasoningEffort('max')

    expect(snapshot.reasoningEffort).toBe('max')
    expect((await repository.getSettings()).reasoningEffort).toBe('max')
  })

  it('surfaces the stored level as sessionEffort on the resolved OpenCode backend', async () => {
    // resolveActiveAgentBackend honors this forced-framework env above stored settings; set it
    // explicitly (a prior test may leave it stubbed) so this resolves OpenCode.
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'opencode')
    await repository.setAgentFramework('opencode')
    const service = createService(undefined, {
      opencodeDetected: { path: '/usr/local/bin/opencode', version: '1.19.0' }
    })
    const provider = (
      await service.upsertProvider({ type: 'official', name: 'Kimi', vendorId: 'kimi', key: 'k' })
    ).providers[0]
    await service.setActiveProvider(provider.id)
    await repository.setReasoningEffort('high')

    const backend = await service.resolveActiveAgentBackend()

    expect(backend.sessionEffort).toBe('high')
    // The level also reaches the framework's own config channel (opencode model options).
    const content = JSON.parse(backend.env?.OPENCODE_CONFIG_CONTENT ?? '{}')
    expect(content.provider['openai-compatible'].models['kimi-k3']).toEqual(
      expect.objectContaining({ options: { reasoningEffort: 'high' } })
    )
  })

  it('surfaces sessionEffort on the Claude backend too (the early-return path)', async () => {
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'claude-code')
    const service = createService()
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const provider = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id)
    await repository.setReasoningEffort('low')

    const backend = await service.resolveActiveAgentBackend()

    expect(backend.framework.id).toBe('claude-code')
    expect(backend.sessionEffort).toBe('low')
  })

  it("leaves sessionEffort undefined when the level is 'default' or unset", async () => {
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'claude-code')
    const service = createService()
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const provider = (
      await service.upsertProvider({
        type: 'custom',
        name: 'G',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id)

    // Unset: nothing stored yet.
    expect((await service.resolveActiveAgentBackend()).sessionEffort).toBeUndefined()

    // 'default' means "don't override": the agent keeps its own default effort.
    await repository.setReasoningEffort('default')
    expect((await service.resolveActiveAgentBackend()).sessionEffort).toBeUndefined()
  })

  it('updates the live bridge forwarding policy when the level changes', async () => {
    const localFetch = globalThis.fetch
    let upstreamRequest: Record<string, unknown> | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        upstreamRequest = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(
          [
            'data: ' +
              JSON.stringify({
                id: 'chat-effort-policy',
                model: 'deepseek-v4-flash',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
              }),
            '',
            'data: [DONE]',
            ''
          ].join('\n'),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      })
    )
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, '', 'utf8')
    const service = createService(undefined, {
      codexDetected: { path: adapterPath, version: 'codex-acp 1.1.4' }
    })
    await repository.setCodexInfo({
      resolvedPath: adapterPath,
      version: '1.1.4',
      nativePath: '/data/codex-managed/native/codex',
      nativeVersion: '0.144.6'
    })
    await repository.setAgentFramework('codex')
    const provider = (
      await service.upsertProvider({
        type: 'custom',
        name: 'DeepSeek',
        apiEndpoints: ['openai'],
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        key: 'test-key'
      })
    ).providers[0]
    await service.setActiveProvider(provider.id)
    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'codex')
    const backend = await service.resolveActiveAgentBackend()
    const post = (): Promise<string> =>
      localFetch(`${backend.providerConfiguration?.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: backend.providerConfiguration?.headers.authorization ?? '',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          input: 'hi',
          reasoning: { effort: 'high' },
          stream: true
        })
      }).then((response) => response.text())

    // No explicit choice yet: Codex's own default effort is stripped, as pre-feature.
    await post()
    expect(upstreamRequest).not.toHaveProperty('reasoning_effort')

    // An explicit level forwards — Codex applies it live over ACP, no reconnect touches the bridge.
    await service.setReasoningEffort('high')
    await post()
    expect(upstreamRequest).toMatchObject({ reasoning_effort: 'high' })

    // Back to 'default': stripping is restored so Codex's own effort can't leak upstream.
    await service.setReasoningEffort('default')
    await post()
    expect(upstreamRequest).not.toHaveProperty('reasoning_effort')
  })
})

describe('SettingsService: notifications preference', () => {
  it('projects enabled when no preference is stored', async () => {
    const service = createService()

    expect((await service.getSettingsView()).notificationsEnabled).toBe(true)
    expect(await service.getNotificationsEnabled()).toBe(true)
  })

  it('projects the stored preference into the settings view', async () => {
    const service = createService()

    await repository.setNotificationsEnabled(false)

    expect((await service.getSettingsView()).notificationsEnabled).toBe(false)
    expect(await service.getNotificationsEnabled()).toBe(false)
  })

  it('persists the preference and returns the refreshed snapshot', async () => {
    const service = createService()

    const snapshot = await service.setNotificationsEnabled(false)

    expect(snapshot.notificationsEnabled).toBe(false)
    expect((await repository.getSettings()).notificationsEnabled).toBe(false)
  })
})

describe('SettingsService: close preference', () => {
  it('projects, persists, and resets the Windows titlebar-close behavior', async () => {
    const service = createService()

    expect(await service.getClosePreference()).toBeUndefined()

    const saved = await service.setClosePreference('quit')
    expect(saved.closePreference).toBe('quit')
    expect(await service.getClosePreference()).toBe('quit')

    const reset = await service.setClosePreference(undefined)
    expect(reset.closePreference).toBeUndefined()
  })
})

describe('SettingsService: listAgentHomeSkills framework routing', () => {
  // The agent-home skill import is framework-agnostic: claude-code scans `~/.claude/skills/`,
  // codex scans `~/.codex/skills/`, and opencode (which has no global skills convention) returns
  // an empty list. The active framework is read from settings on every call so switching the
  // agent framework takes effect without restarting the service.

  // Seeds a fake skill at <agentHome>/skills/<slug>/SKILL.md so the scanner picks it up.
  const seedSkill = async (agentHome: string, slug: string): Promise<void> => {
    const skillDir = join(agentHome, 'skills', slug)
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${slug}\ndescription: Test skill ${slug}\n---\nBody of ${slug}.\n`
    )
  }

  it('scans the user Claude home when the active framework is claude-code', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-list-agent-claude-'))
    const userCodexDir = await mkdtemp(join(tmpdir(), 'os-list-agent-codex-'))
    await seedSkill(userClaudeDir, 'alpha')
    // A Codex skill in the Codex home must not be picked up while the active framework is Claude.
    await seedSkill(userCodexDir, 'should-not-appear')
    const service = createService(undefined, { userClaudeDir, userCodexDir })
    await repository.setAgentFramework('claude-code')

    const items = await service.listAgentHomeSkills()

    expect(items.map((item) => item.slug)).toEqual(['alpha'])
    expect(items[0].path).toBe(join(userClaudeDir, 'skills', 'alpha'))
  })

  it('scans the user Codex home when the active framework is codex', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-list-agent-claude-'))
    const userCodexDir = await mkdtemp(join(tmpdir(), 'os-list-agent-codex-'))
    await seedSkill(userCodexDir, 'beta')
    // A Claude skill in the Claude home must not be picked up while the active framework is Codex.
    await seedSkill(userClaudeDir, 'should-not-appear')
    const service = createService(undefined, { userClaudeDir, userCodexDir })
    await repository.setAgentFramework('codex')

    const items = await service.listAgentHomeSkills()

    expect(items.map((item) => item.slug)).toEqual(['beta'])
    expect(items[0].path).toBe(join(userCodexDir, 'skills', 'beta'))
  })

  it('returns an empty list when the active framework is opencode (no global home)', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-list-agent-claude-'))
    const userCodexDir = await mkdtemp(join(tmpdir(), 'os-list-agent-codex-'))
    // Even with skills present, opencode's lack of a global skills convention must hide the source.
    await seedSkill(userClaudeDir, 'hidden-1')
    await seedSkill(userCodexDir, 'hidden-2')
    const service = createService(undefined, { userClaudeDir, userCodexDir })
    await repository.setAgentFramework('opencode')

    expect(await service.listAgentHomeSkills()).toEqual([])
  })

  it('re-reads the active framework on every call (no cached home dir)', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-list-agent-claude-'))
    const userCodexDir = await mkdtemp(join(tmpdir(), 'os-list-agent-codex-'))
    await seedSkill(userClaudeDir, 'claude-only')
    await seedSkill(userCodexDir, 'codex-only')
    const service = createService(undefined, { userClaudeDir, userCodexDir })

    await repository.setAgentFramework('claude-code')
    expect((await service.listAgentHomeSkills()).map((i) => i.slug)).toEqual(['claude-only'])

    await repository.setAgentFramework('codex')
    expect((await service.listAgentHomeSkills()).map((i) => i.slug)).toEqual(['codex-only'])
  })
})

describe('SettingsService: claude-isolated edit preserves the stored token', () => {
  // P1 from the Codex correctness review: editing the provider must carry the encrypted token
  // through. Before the fix, the claude-isolated branch of upsertProvider did not propagate
  // existing.keyRef / existing.keyMask, so a model edit silently invalidated the stored credential
  // while the verified-marker stayed.

  it('keeps keyRef + keyMask on a model edit', async () => {
    const service = createService()
    // Seed the encrypted token directly via the repository — the only path that writes keyRef
    // onto the fixed builtin record, and it sidesteps the controller contract so the test stays
    // focused on the upsert branch under test.
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('test-token-xyz'),
      keyMask: maskKey('test-token-xyz')
    })

    const before = (await repository.getSettings()).providers.find(
      (p) => p.id === 'builtin-claude-isolated'
    )
    expect(before?.keyRef).toBeTruthy()
    expect(before?.keyMask).toBeTruthy()

    await service.upsertProvider({ type: 'claude-isolated', model: 'claude-sonnet-4-5' })

    const after = (await repository.getSettings()).providers.find(
      (p) => p.id === 'builtin-claude-isolated'
    )
    expect(after?.keyRef).toBe(before?.keyRef)
    expect(after?.keyMask).toBe(before?.keyMask)
    expect(after?.model).toBe('claude-sonnet-4-5')
  })
})

describe('SettingsService: logoutIsolatedClaude error propagation', () => {
  // P1 from the Codex correctness review: a controller-level error must surface as a failed
  // result regardless of `authenticated`. Before the fix the `status.message` branch was gated on
  // `authenticated !== false`, so a failed logout that left the token in storage still
  // returned `{ ok: true }` and the UI reconnected as if sign-out had succeeded.

  it('surfaces the controller message even when authenticated stays false', async () => {
    const claudeIsolatedAuth = {
      getStatus: vi.fn(),
      loginIsolatedBrowser: vi.fn(),
      loginIsolated: vi.fn(),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn().mockResolvedValue({
        mode: 'isolated',
        supported: true,
        authenticated: false,
        message: 'Codex sign-out timed out.'
      })
    }
    const service = createService(undefined, { claudeIsolatedAuth })

    const result = await service.logoutIsolatedClaude()

    expect(result).toMatchObject({ ok: false, message: 'Codex sign-out timed out.' })
  })

  it('clears credential metadata when the controller signs out successfully', async () => {
    const claudeIsolatedAuth = {
      getStatus: vi.fn(),
      loginIsolatedBrowser: vi.fn(),
      loginIsolated: vi.fn(),
      cancelLogin: vi.fn(),
      logoutIsolated: vi.fn().mockResolvedValue({
        mode: 'isolated',
        supported: true,
        authenticated: false
      })
    }
    const service = createService(undefined, { claudeIsolatedAuth })
    await repository.upsertProvider({
      id: 'builtin-claude-isolated',
      type: 'claude-isolated',
      name: 'Claude subscription',
      expiresAt: Date.now() + 1_000,
      lastValidatedAt: Date.now()
    })

    const result = await service.logoutIsolatedClaude()
    const stored = (await repository.getSettings()).providers.find(
      (provider) => provider.id === 'builtin-claude-isolated'
    )

    expect(result).toEqual({ ok: true, category: 'ok' })
    expect(stored?.expiresAt).toBeUndefined()
    expect(stored?.lastValidatedAt).toBeUndefined()
    expect(stored?.lastValidationFailure).toBeUndefined()
  })
})

describe('SettingsService: importAgentHomeSkill path containment', () => {
  // P1 / Medium from the Codex + Claude reviews: path authority lives in main. The renderer
  // supplies a slug; the service resolves it against the active agent's skills dir and refuses
  // any slug that escapes the configured home directory.

  const seedSkill = async (agentHome: string, slug: string): Promise<string> => {
    const skillDir = join(agentHome, 'skills', slug)
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${slug}\ndescription: Test\n---\nBody.\n`
    )
    return skillDir
  }

  it('imports the skill that lives under the active agent home', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-import-agent-ok-'))
    await seedSkill(userClaudeDir, 'alpha')
    const service = createService(undefined, { userClaudeDir })
    await repository.setAgentFramework('claude-code')

    const result = await service.importAgentHomeSkill({ slug: 'alpha' })

    expect(result.status).toBe('imported')
    expect(result.id).toBe('imported-alpha')
  })

  it('rejects slugs that fail the SAFE_SLUG check before reaching the path resolver', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-import-agent-escape-'))
    const service = createService(undefined, { userClaudeDir })
    await repository.setAgentFramework('claude-code')

    // Path-traversal payloads are caught by the SAFE_SLUG regex (no '/', '.', etc.), so the
    // containment check downstream is defense-in-depth and is not exercised by valid slugs.
    await expect(service.importAgentHomeSkill({ slug: '../../etc' })).rejects.toThrow(/unsafe slug/)
    await expect(service.importAgentHomeSkill({ slug: '../sibling' })).rejects.toThrow(
      /unsafe slug/
    )
    await expect(service.importAgentHomeSkill({ slug: 'has spaces' })).rejects.toThrow(
      /unsafe slug/
    )
  })

  it('rejects when the active framework has no global skills directory', async () => {
    const service = createService()
    await repository.setAgentFramework('opencode')

    await expect(service.importAgentHomeSkill({ slug: 'alpha' })).rejects.toThrow(
      /no global skills directory/
    )
  })
})

describe('SettingsService: claude-isolated login + status coordination', () => {
  // Round 4 of the AI review: the controller's post-save roundtrip check + the service's
  // "awaiting first Claude session" placeholder combine so the Settings card does not show a
  // green verified check for a credential Claude has not actually accepted. These tests pin that
  // contract end-to-end.

  const successAuth = {
    getStatus: vi.fn().mockResolvedValue({ supported: true, authenticated: true }),
    loginIsolatedBrowser: vi.fn(async () => ({ supported: true, authenticated: true })),
    loginIsolated: vi.fn(async (token: string) => {
      if (token.trim() === 'sk-ant-valid') return { supported: true, authenticated: true }
      return { supported: true, authenticated: false, message: 'invalid token' }
    }),
    cancelLogin: vi.fn(),
    logoutIsolated: vi.fn().mockResolvedValue({ supported: true, authenticated: false })
  }

  it('verifies a pasted token with Claude under the app-owned config before reporting success', async () => {
    const probe = vi.fn<(executablePath: string, env: NodeJS.ProcessEnv) => Promise<void>>()
    probe.mockResolvedValue(undefined)
    const service = createService(undefined, {
      claudeIsolatedAuth: successAuth,
      executeClaudeProbe: probe
    })
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('sk-ant-valid'),
      keyMask: maskKey('sk-ant-valid')
    })

    const result = await service.loginIsolatedClaude('sk-ant-valid')

    expect(result).toMatchObject({ ok: true, category: 'ok', applied: true })
    expect(probe).toHaveBeenCalledOnce()
    expect(probe).toHaveBeenCalledWith(
      '/bin/claude',
      expect.objectContaining({
        CLAUDE_CONFIG_DIR: getAppClaudeConfigDir(storageRoot),
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-valid'
      })
    )
  })

  it('keeps a rejected setup token unverified and records an actionable auth failure', async () => {
    const probe = vi.fn<(executablePath: string, env: NodeJS.ProcessEnv) => Promise<void>>()
    probe.mockRejectedValue(
      Object.assign(new Error('Command failed with exit code 1'), {
        stdout: 'Invalid API key. Please run /login.'
      })
    )
    const service = createService(undefined, {
      claudeIsolatedAuth: successAuth,
      executeClaudeProbe: probe
    })
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('sk-ant-valid'),
      keyMask: maskKey('sk-ant-valid')
    })

    const result = await service.loginIsolatedClaude('sk-ant-valid')

    expect(result).toMatchObject({ ok: false, category: 'auth', applied: true })
    expect(result.message).toMatch(/rejected the setup token/i)
    const stored = (await repository.getSettings()).providers.find(
      (provider) => provider.id === 'builtin-claude-isolated'
    )
    expect(stored?.lastValidatedAt).toBeUndefined()
    expect(stored?.lastValidationFailure).toMatchObject({
      category: 'auth',
      message: expect.stringMatching(/rejected the setup token/i)
    })
  })

  it('does not misreport a missing Claude executable as a rejected token', async () => {
    const probe = vi.fn<(executablePath: string, env: NodeJS.ProcessEnv) => Promise<void>>()
    probe.mockRejectedValue(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    const service = createService(undefined, {
      claudeIsolatedAuth: successAuth,
      executeClaudeProbe: probe
    })
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.setClaudeInfo({ resolvedPath: '/missing/claude', version: '2.1.0' })
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('sk-ant-valid'),
      keyMask: maskKey('sk-ant-valid')
    })

    const result = await service.loginIsolatedClaude('sk-ant-valid')

    expect(result).toMatchObject({ ok: false, category: 'unknown', applied: true })
    expect(result.message).toMatch(/could not run.*re-detect Claude/i)
    expect(result.message).not.toMatch(/rejected.*token/i)
  })

  it('reports a terminated Claude credential probe as a timeout', async () => {
    const probe = vi.fn<(executablePath: string, env: NodeJS.ProcessEnv) => Promise<void>>()
    probe.mockRejectedValue(
      Object.assign(new Error('Command timed out'), { killed: true, signal: 'SIGTERM' })
    )
    const service = createService(undefined, {
      claudeIsolatedAuth: successAuth,
      executeClaudeProbe: probe
    })
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('sk-ant-valid'),
      keyMask: maskKey('sk-ant-valid')
    })

    const result = await service.loginIsolatedClaude('sk-ant-valid')

    expect(result).toMatchObject({ ok: false, category: 'timeout', applied: true })
    expect(result.message).toMatch(/validation timed out/i)
  })

  it('reports a Claude credential probe DNS failure as a network error', async () => {
    const probe = vi.fn<(executablePath: string, env: NodeJS.ProcessEnv) => Promise<void>>()
    probe.mockRejectedValue(
      Object.assign(new Error('getaddrinfo EAI_AGAIN api.anthropic.com'), { code: 'EAI_AGAIN' })
    )
    const service = createService(undefined, {
      claudeIsolatedAuth: successAuth,
      executeClaudeProbe: probe
    })
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('sk-ant-valid'),
      keyMask: maskKey('sk-ant-valid')
    })

    const result = await service.loginIsolatedClaude('sk-ant-valid')

    expect(result).toMatchObject({ ok: false, category: 'network', applied: true })
    expect(result.message).toMatch(/could not reach Anthropic.*check your network/i)
  })

  it('re-probes a previously verified token so later expiry is reported', async () => {
    const probe = vi.fn<(executablePath: string, env: NodeJS.ProcessEnv) => Promise<void>>()
    probe.mockRejectedValue(new Error('token expired'))
    const service = createService(undefined, {
      claudeIsolatedAuth: successAuth,
      executeClaudeProbe: probe
    })
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('sk-ant-valid'),
      keyMask: maskKey('sk-ant-valid')
    })
    const stored = (await repository.getSettings()).providers.find(
      (provider) => provider.id === 'builtin-claude-isolated'
    )
    if (!stored) throw new Error('claude-isolated provider not found')
    await repository.upsertProvider({
      ...stored,
      lastValidatedAt: Date.now(),
      lastValidationFailure: undefined
    })

    const result = await service.getClaudeIsolatedStatus()

    expect(probe).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ ok: false, category: 'auth' })
    expect(result.message).toMatch(/rejected the setup token/i)
  })

  it('does not restore a token cleared while its login probe is still running', async () => {
    let finishProbe: (() => void) | undefined
    const probe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishProbe = resolve
        })
    )
    const service = createService(undefined, { executeClaudeProbe: probe })
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await repository.upsertProvider({
      id: 'builtin-claude-isolated',
      type: 'claude-isolated',
      name: 'Claude subscription'
    })

    const login = service.loginIsolatedClaude('sk-ant-valid')
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    await service.logoutIsolatedClaude()
    finishProbe?.()

    const result = await login
    const stored = (await repository.getSettings()).providers.find(
      (provider) => provider.id === 'builtin-claude-isolated'
    )
    expect(result).toMatchObject({ ok: true, applied: false })
    expect(stored?.keyRef).toBeUndefined()
    expect(stored?.lastValidatedAt).toBeUndefined()
  })

  it('discards an older probe when a newer setup-token login wins', async () => {
    const finishProbes: Array<() => void> = []
    const probe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishProbes.push(resolve)
        })
    )
    const service = createService(undefined, { executeClaudeProbe: probe })
    const { encryptKey } = await import('./crypto.js')
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await repository.upsertProvider({
      id: 'builtin-claude-isolated',
      type: 'claude-isolated',
      name: 'Claude subscription'
    })

    const olderLogin = service.loginIsolatedClaude('sk-ant-older')
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
    const newerLogin = service.loginIsolatedClaude('sk-ant-newer')
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))

    finishProbes[1]?.()
    expect(await newerLogin).toMatchObject({ ok: true, applied: true })
    finishProbes[0]?.()
    expect(await olderLogin).toMatchObject({ ok: true, applied: false })

    const stored = (await repository.getSettings()).providers.find(
      (provider) => provider.id === 'builtin-claude-isolated'
    )
    expect(stored?.keyRef).toBe(encryptKey('sk-ant-newer'))
    expect(stored?.lastValidatedAt).toBeGreaterThan(0)
  })

  it('records expiresAt and a verified timestamp after a successful token probe', async () => {
    const probe = vi.fn<(executablePath: string, env: NodeJS.ProcessEnv) => Promise<void>>()
    probe.mockResolvedValue(undefined)
    const service = createService(undefined, {
      claudeIsolatedAuth: successAuth,
      executeClaudeProbe: probe
    })
    // Seed the provider card. The loginIsolatedClaude path requires an existing record to find
    // (the early-return for a missing card is the "applied: false" branch).
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('sk-ant-valid'),
      keyMask: maskKey('sk-ant-valid')
    })

    const before = Date.now()
    const result = await service.loginIsolatedClaude('sk-ant-valid')
    const after = Date.now()

    expect(result.ok).toBe(true)
    expect(result.applied).toBe(true)
    const stored = (await repository.getSettings()).providers.find(
      (p) => p.id === 'builtin-claude-isolated'
    )
    // Estimated one-year expiry: must be within the window the service set, not "now exactly".
    expect(stored?.expiresAt).toBeGreaterThanOrEqual(before + 364 * 24 * 60 * 60 * 1000)
    expect(stored?.expiresAt).toBeLessThanOrEqual(after + 366 * 24 * 60 * 60 * 1000)
    expect(stored?.lastValidatedAt).toBeGreaterThanOrEqual(before)
    expect(stored?.lastValidationFailure).toBeUndefined()
  })

  it('logoutIsolatedClaude on error does NOT clear the stored validation markers', async () => {
    // A failed logout must leave lastValidationFailure / lastValidatedAt alone: a transient store
    // error that flips the markers to "cleared" would lie to the next status check (the token is
    // still in storage, and any pending failure marker is the truthful state to keep).
    const failingLogout = {
      ...successAuth,
      logoutIsolated: vi.fn().mockResolvedValue({
        supported: true,
        authenticated: false,
        message: 'keychain delete failed'
      })
    }
    const service = createService(undefined, { claudeIsolatedAuth: failingLogout })
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('test-token-seed'),
      keyMask: maskKey('test-token-seed')
    })
    // Stamp a real failure marker on the record so we can verify it survives the failed logout.
    const originalFailureMessage = 'Claude rejected the setup token.'
    await repository.upsertProvider({
      id: 'builtin-claude-isolated',
      type: 'claude-isolated',
      name: 'Claude subscription',
      lastValidationFailure: {
        at: Date.now(),
        category: 'auth',
        message: originalFailureMessage
      }
    })

    const result = await service.logoutIsolatedClaude()

    expect(result.ok).toBe(false)
    const stored = (await repository.getSettings()).providers.find(
      (p) => p.id === 'builtin-claude-isolated'
    )
    // Marker is the original — not cleared, not replaced with an "ok" record.
    expect(stored?.lastValidationFailure?.message).toBe(originalFailureMessage)
  })
})

describe('SettingsService: claude-isolated validation flow', () => {
  const successAuth = {
    getStatus: vi.fn().mockResolvedValue({ supported: true, authenticated: true }),
    loginIsolatedBrowser: vi.fn(async () => ({ supported: true, authenticated: true })),
    loginIsolated: vi.fn(async () => ({ supported: true, authenticated: true })),
    cancelLogin: vi.fn(),
    logoutIsolated: vi.fn().mockResolvedValue({ supported: true, authenticated: false })
  }

  const seedStoredToken = async (): Promise<void> => {
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('test-token-seed'),
      keyMask: maskKey('test-token-seed')
    })
  }

  it('validateProvider re-probes claude-isolated and records the successful result', async () => {
    const probe = vi.fn<(executablePath: string, env: NodeJS.ProcessEnv) => Promise<void>>()
    probe.mockResolvedValue(undefined)
    const service = createService(undefined, {
      claudeIsolatedAuth: successAuth,
      executeClaudeProbe: probe
    })
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await seedStoredToken()

    const storedId = 'builtin-claude-isolated'
    const result = await service.validateProvider({ providerId: storedId })

    expect(result.ok).toBe(true)
    expect(probe).toHaveBeenCalledOnce()
    const after = (await repository.getSettings()).providers.find((p) => p.id === storedId)
    expect(after?.lastValidatedAt).toBeGreaterThan(0)
    expect(after?.lastValidationFailure).toBeUndefined()
  })
})

describe('SettingsService: claude-isolated edit preserves expiresAt + keyRef', () => {
  // Round 6 of the AI review: editing the provider (changing the model) must not drop the
  // credential's estimated expiry. The setup-token lifetime is one of the few signals a user has
  // that the credential is approaching its limit, so the Settings card's "Expires <date>" must
  // survive a model edit on the same stored record.

  it('keeps existing.expiresAt through an edit that only changes the model', async () => {
    const service = createService(undefined, {
      executeClaudeProbe: vi.fn().mockResolvedValue(undefined)
    })
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('test-token-seed'),
      keyMask: maskKey('test-token-seed')
    })
    // Mirror the production flow: loginIsolatedClaude seeds expiresAt on a fresh paste.
    await service.loginIsolatedClaude('test-token-seed')

    const before = (await repository.getSettings()).providers.find(
      (p) => p.id === 'builtin-claude-isolated'
    )
    expect(before?.expiresAt).toBeGreaterThan(0)
    const originalExpiresAt = before!.expiresAt

    // The renderer submits an edit that only changes the model — no key, no name, no type flip.
    await service.upsertProvider({ type: 'claude-isolated', model: 'claude-sonnet-4-5' })

    const after = (await repository.getSettings()).providers.find(
      (p) => p.id === 'builtin-claude-isolated'
    )
    expect(after?.expiresAt).toBe(originalExpiresAt)
    expect(after?.model).toBe('claude-sonnet-4-5')
  })
})

describe('SettingsService: importAgentHomeSkill realpath containment', () => {
  // Round 6 of the AI review: a symlink that points outside the agent home is a containment
  // escape even when `resolve()` (lexical) is satisfied. The realpath fallback closes the gap.
  const seedSkill = async (agentHome: string, slug: string): Promise<string> => {
    const dir = join(agentHome, 'skills', slug)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${slug}\ndescription: Test\n---\nBody.\n`)
    return dir
  }

  it('rejects a symlink inside the agent home that points outside it', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-import-symlink-'))
    const outside = await mkdtemp(join(tmpdir(), 'os-import-outside-'))
    // Create a symlink at `<home>/skills/payload -> <outside>` so the basename is a valid slug
    // and `resolve(home, slug)` would land at the symlink target.
    const linkPath = join(userClaudeDir, 'skills', 'payload')
    await mkdir(join(userClaudeDir, 'skills'), { recursive: true })
    await symlink(outside, linkPath)
    const service = createService(undefined, { userClaudeDir })
    await repository.setAgentFramework('claude-code')

    await expect(service.importAgentHomeSkill({ slug: 'payload' })).rejects.toThrow(
      /outside its home/
    )
  })

  it('accepts a symlink that stays within the agent home', async () => {
    // Sanity: a benign symlink (a sub-directory pointing to a sibling sub-directory) is still
    // allowed. realpath-based containment is "escapes the home", not "uses a symlink at all".
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-import-symlink-benign-'))
    const target = await seedSkill(userClaudeDir, 'real-skill')
    const linkDir = join(userClaudeDir, 'skills', 'linked-skill')
    await mkdir(join(userClaudeDir, 'skills'), { recursive: true })
    await symlink(target, linkDir)
    const service = createService(undefined, { userClaudeDir })
    await repository.setAgentFramework('claude-code')

    const result = await service.importAgentHomeSkill({ slug: 'linked-skill' })
    expect(result.status).toBe('imported')
  })
})

describe('SettingsService: claude-shared login orchestration', () => {
  const sharedAuth = (
    opts: {
      loginOk?: boolean
      loginMsg?: string
    } = {}
  ): ClaudeSharedAuthControllerPort => ({
    getStatus: vi.fn(),
    loginShared: vi.fn().mockResolvedValue({
      supported: true,
      authenticated: opts.loginOk ?? true,
      message: opts.loginMsg
    }),
    cancelLogin: vi.fn()
  })

  it('persists claude-shared with the fixed builtin-claude-shared id on upsert', async () => {
    const service = createService()
    const snap = await service.upsertProvider({ type: 'claude-shared', name: 'ignored' })
    expect(snap.providers.find((p) => p.id === CLAUDE_SHARED_PROVIDER_ID)).toBeDefined()
    expect(snap.providers.filter((p) => p.id === CLAUDE_SHARED_PROVIDER_ID)).toHaveLength(1)
  })

  it('preserves both Claude auth records and moves the active selection between them', async () => {
    const service = createService()
    await service.upsertProvider({ type: 'claude-isolated', model: 'claude-sonnet-4-5' })
    const { encryptKey, maskKey } = await import('./crypto.js')
    await repository.upsertClaudeIsolatedProvider({
      keyRef: encryptKey('sk-ant-preserved'),
      keyMask: maskKey('sk-ant-preserved')
    })
    await service.setActiveProvider(CLAUDE_ISOLATED_PROVIDER_ID, 'claude-sonnet-4-5')

    const snapshot = await service.upsertProvider({
      type: 'claude-shared',
      model: 'claude-sonnet-4-5'
    })

    expect(snapshot.providers.map((provider) => provider.id)).toEqual(
      expect.arrayContaining([CLAUDE_ISOLATED_PROVIDER_ID, CLAUDE_SHARED_PROVIDER_ID])
    )
    expect(
      snapshot.providers.find((provider) => provider.id === CLAUDE_ISOLATED_PROVIDER_ID)?.hasKey
    ).toBe(true)
    expect(snapshot.activeProviderId).toBe(CLAUDE_SHARED_PROVIDER_ID)
    expect(snapshot.activeModel).toBe('claude-sonnet-4-5')

    const switchedBack = await service.upsertProvider({ type: 'claude-isolated' })
    expect(switchedBack.providers.map((provider) => provider.id)).toEqual(
      expect.arrayContaining([CLAUDE_ISOLATED_PROVIDER_ID, CLAUDE_SHARED_PROVIDER_ID])
    )
    expect(
      switchedBack.providers.find((provider) => provider.id === CLAUDE_ISOLATED_PROVIDER_ID)?.hasKey
    ).toBe(true)
    expect(switchedBack.activeProviderId).toBe(CLAUDE_ISOLATED_PROVIDER_ID)
    expect(switchedBack.activeModel).toBe('claude-sonnet-4-5')
  })

  it('loginClaudeShared records verified marker and returns applied:true', async () => {
    const auth = sharedAuth({ loginOk: true })
    const probe = vi.fn().mockResolvedValue(undefined)
    const service = createService(undefined, {
      claudeSharedAuth: auth,
      executeClaudeProbe: probe
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await service.upsertProvider({
      type: 'claude-shared',
      name: 'Claude subscription',
      model: 'claude-opus-4-6'
    })

    const result = await service.loginClaudeShared()
    expect(result.ok).toBe(true)
    expect(result.applied).toBe(true)

    const settings = await service.getSettingsView()
    const provider = settings.providers.find((p) => p.id === CLAUDE_SHARED_PROVIDER_ID)
    expect(provider?.lastValidatedAt).toBeGreaterThan(0)
    expect(probe).toHaveBeenCalledWith(
      execPath,
      expect.objectContaining({ ANTHROPIC_MODEL: 'claude-opus-4-6' }),
      [
        '--settings',
        join(getAppClaudeConfigDir(storageRoot), 'settings.json'),
        '--plugin-dir',
        getAppClaudeConfigDir(storageRoot)
      ]
    )
  })

  it('discards a shared login result after the provider is edited and isolated mode is selected', async () => {
    let finishProbe: (() => void) | undefined
    const probe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishProbe = resolve
        })
    )
    const service = createService(undefined, {
      claudeSharedAuth: sharedAuth({ loginOk: true }),
      executeClaudeProbe: probe
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await service.upsertProvider({ type: 'claude-shared', model: 'claude-opus-4-6' })

    const login = service.loginClaudeShared()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())

    await service.upsertProvider({ type: 'claude-shared', model: 'claude-sonnet-4-5' })
    await service.upsertProvider({ type: 'claude-isolated' })
    await service.setActiveProvider(CLAUDE_ISOLATED_PROVIDER_ID)
    finishProbe?.()

    await expect(login).resolves.toMatchObject({ ok: true, applied: false })
    const settings = await repository.getSettings()
    expect(settings.claudeSubscriptionProviderId).toBe(CLAUDE_ISOLATED_PROVIDER_ID)
    expect(settings.activeProviderId).toBe(CLAUDE_ISOLATED_PROVIDER_ID)
    const sharedProvider = settings.providers.find(
      (provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID
    )
    expect(sharedProvider?.model).toBe('claude-sonnet-4-5')
    expect(sharedProvider?.lastValidatedAt).toBeUndefined()
  })

  it('loginClaudeShared returns applied:false when no shared provider record exists', async () => {
    const auth = sharedAuth({ loginOk: true })
    const service = createService(undefined, { claudeSharedAuth: auth })
    // Do NOT create the provider first → lookup returns undefined.
    const result = await service.loginClaudeShared()
    expect(result.applied).toBe(false)
  })

  it('loginClaudeShared records failure marker on a failed login', async () => {
    const auth = sharedAuth({ loginOk: false, loginMsg: 'OAuth rejected' })
    const service = createService(undefined, { claudeSharedAuth: auth })
    await service.upsertProvider({ type: 'claude-shared', name: 'Claude subscription' })

    const result = await service.loginClaudeShared()
    expect(result.ok).toBe(false)
    expect(result.applied).toBe(true)
    const settings = await service.getSettingsView()
    const provider = settings.providers.find((p) => p.id === CLAUDE_SHARED_PROVIDER_ID)
    expect(provider?.lastValidationFailure?.message).toContain('OAuth rejected')
  })

  it('clears the local disconnect after browser auth succeeds even when the probe fails', async () => {
    const service = createService(undefined, {
      claudeSharedAuth: sharedAuth({ loginOk: true }),
      executeClaudeProbe: vi.fn().mockRejectedValue(new Error('temporary network failure'))
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await service.upsertProvider({ type: 'claude-shared' })
    await service.logoutClaudeShared()
    expect(
      (await repository.getSettings()).providers.find(
        (provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID
      )?.disconnectedAt
    ).toBeGreaterThan(0)

    await expect(service.loginClaudeShared()).resolves.toMatchObject({
      ok: false,
      applied: true
    })

    const provider = (await repository.getSettings()).providers.find(
      (candidate) => candidate.id === CLAUDE_SHARED_PROVIDER_ID
    )
    expect(provider?.disconnectedAt).toBeUndefined()
    expect(provider?.lastValidationFailure?.category).toBe('network')
  })

  it('validateProvider probes the shared Claude runtime with the resolved model', async () => {
    const auth = sharedAuth()
    vi.mocked(auth.getStatus).mockResolvedValue({ supported: true, authenticated: true })
    const probe = vi.fn().mockRejectedValue(new Error('Unknown model: claude-bad-model'))
    const service = createService(undefined, {
      claudeSharedAuth: auth,
      executeClaudeProbe: probe
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await service.upsertProvider({ type: 'claude-shared', model: 'claude-bad-model' })

    const result = await service.validateProvider({ providerId: CLAUDE_SHARED_PROVIDER_ID })

    expect(result).toMatchObject({ ok: false, category: 'unknown', applied: true })
    expect(probe).toHaveBeenCalledWith(
      execPath,
      expect.objectContaining({ ANTHROPIC_MODEL: 'claude-bad-model' }),
      [
        '--settings',
        join(getAppClaudeConfigDir(storageRoot), 'settings.json'),
        '--plugin-dir',
        getAppClaudeConfigDir(storageRoot)
      ]
    )
    expect(
      (await service.getSettingsView()).providers.find(
        (provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID
      )?.lastValidationFailure?.message
    ).toContain('shared-profile validation probe')
  })

  it('does not replace a verified shared login with a cancellation failure', async () => {
    const auth = sharedAuth({ loginOk: true })
    const loginShared = vi.mocked(auth.loginShared)
    const service = createService(undefined, {
      claudeSharedAuth: auth,
      executeClaudeProbe: vi.fn().mockResolvedValue(undefined)
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await service.upsertProvider({ type: 'claude-shared', name: 'Claude subscription' })
    await service.loginClaudeShared()
    const validatedAt = (await service.getSettingsView()).providers.find(
      (provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID
    )?.lastValidatedAt

    loginShared.mockResolvedValueOnce({
      supported: true,
      authenticated: false,
      message: 'Sign-in cancelled.',
      cancelled: true
    })

    await expect(service.loginClaudeShared()).resolves.toMatchObject({
      ok: false,
      applied: false,
      cancelled: true
    })
    const provider = (await service.getSettingsView()).providers.find(
      (candidate) => candidate.id === CLAUDE_SHARED_PROVIDER_ID
    )
    expect(provider?.lastValidatedAt).toBe(validatedAt)
    expect(provider?.lastValidationFailure).toBeUndefined()
  })

  it('logoutClaudeShared disconnects locally without logging out the global CLI profile', async () => {
    const globalLogout = vi.fn().mockResolvedValue({ supported: true, authenticated: false })
    const auth = { ...sharedAuth(), logoutShared: globalLogout }
    const service = createService(undefined, {
      claudeSharedAuth: auth,
      executeClaudeProbe: vi.fn().mockResolvedValue(undefined)
    })
    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    await service.upsertProvider({ type: 'claude-shared', name: 'Claude subscription' })
    await service.loginClaudeShared()
    await service.setActiveProvider(CLAUDE_SHARED_PROVIDER_ID)

    const beforeDisconnect = await service.getSettingsView()
    expect(
      beforeDisconnect.providers.find((p) => p.id === CLAUDE_SHARED_PROVIDER_ID)?.lastValidatedAt
    ).toBeGreaterThan(0)

    const result = await service.logoutClaudeShared()
    expect(result.ok).toBe(true)
    expect(globalLogout).not.toHaveBeenCalled()
    const afterDisconnect = await service.getSettingsView()
    expect(
      afterDisconnect.providers.find((p) => p.id === CLAUDE_SHARED_PROVIDER_ID)?.lastValidatedAt
    ).toBeUndefined()
    expect(
      (await repository.getSettings()).providers.find(
        (provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID
      )?.disconnectedAt
    ).toBeGreaterThan(0)
    await expect(service.getClaudeSharedStatus()).resolves.toMatchObject({
      ok: false,
      category: 'auth',
      message: expect.stringContaining('disconnected from Open Science')
    })
    await expect(service.resolveActiveSpawnConfig()).rejects.toThrow(
      /disconnected from Open Science/
    )

    await expect(service.loginClaudeShared()).resolves.toMatchObject({ ok: true, applied: true })
    await expect(service.resolveActiveSpawnConfig()).resolves.toMatchObject({
      envOverrides: expect.objectContaining({
        CLAUDE_CONFIG_DIR: join(storageRoot, 'no-user-claude')
      })
    })
    expect(
      (await repository.getSettings()).providers.find(
        (provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID
      )?.disconnectedAt
    ).toBeUndefined()
  })

  it('invalidates shared Claude verification when its model override changes or is cleared', async () => {
    const service = createService()
    await service.upsertProvider({ type: 'claude-shared', model: 'claude-opus-4-6' })
    const stored = (await repository.getSettings()).providers.find(
      (provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID
    )
    if (!stored) throw new Error('shared Claude provider not found')
    await repository.upsertProvider({ ...stored, lastValidatedAt: 1 })

    const changed = await service.upsertProvider({
      type: 'claude-shared',
      model: 'claude-sonnet-4-5'
    })
    expect(changed.providers.find((provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID)).toEqual(
      expect.objectContaining({ model: 'claude-sonnet-4-5', lastValidatedAt: undefined })
    )

    const cleared = await service.upsertProvider({ type: 'claude-shared', model: '' })
    expect(
      cleared.providers.find((provider) => provider.id === CLAUDE_SHARED_PROVIDER_ID)?.model
    ).toBeUndefined()
  })

  it('cancelClaudeLogin delegates to the shared auth controller', () => {
    const auth = sharedAuth()
    const service = createService(undefined, { claudeSharedAuth: auth })
    service.cancelClaudeLogin()
    expect(auth.cancelLogin).toHaveBeenCalledOnce()
  })
})
