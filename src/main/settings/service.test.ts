import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { execPath } from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CODEX_SUBSCRIPTION_PROVIDER_ID, type ClaudeDetectResult } from '../../shared/settings'
import type { CodexAuthControllerPort } from './codex-auth'

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
  net: { fetch: vi.fn() }
}))

const { SettingsService } = await import('./service')
const { SettingsRepository } = await import('./repository')
const { getAppClaudeConfigDir } = await import('./provider-env')
const { SkillRegistry } = await import('../skills/registry')
const { managedClaudeDir } = await import('./managed-claude')
const { managedOpencodeDir } = await import('./managed-opencode')
const { netFetch } = await import('../skills/net-fetch')

let storageRoot: string
let repository: InstanceType<typeof SettingsRepository>
const CODEX_SHARED_PROVIDER_ID = CODEX_SUBSCRIPTION_PROVIDER_ID
const CODEX_ISOLATED_PROVIDER_ID = CODEX_SUBSCRIPTION_PROVIDER_ID

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
    userClaudeDir?: string
    executeClaudeProbe?: (executablePath: string, env: NodeJS.ProcessEnv) => Promise<void>
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
  } = {}
): InstanceType<typeof SettingsService> =>
  new SettingsService({
    repository,
    storageRoot,
    // Point at a non-existent user Claude dir so tests never read the real ~/.claude for local auth.
    userClaudeDir: options.userClaudeDir ?? join(storageRoot, 'no-user-claude'),
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
    codexAuth: options.codexAuth
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

  it('validates shared and isolated subscriptions through their distinct ACP auth flows', async () => {
    const codexAuth: CodexAuthControllerPort = {
      getStatus: vi.fn().mockResolvedValue({
        mode: 'shared',
        supported: true,
        authenticated: true
      }),
      getPreferredStatus: vi.fn().mockResolvedValue({
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
    expect(codexAuth.loginIsolated).toHaveBeenCalledOnce()

    const stored = await repository.getSettings()
    expect(stored.providers.every((provider) => provider.lastValidatedAt !== undefined)).toBe(true)
  })

  it('cancels isolated login and clears provider readiness on logout', async () => {
    const codexAuth: CodexAuthControllerPort = {
      getStatus: vi.fn(),
      getPreferredStatus: vi.fn().mockResolvedValue({
        mode: 'isolated',
        supported: true,
        authenticated: true
      }),
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
    await service.validateProvider({ providerId: CODEX_ISOLATED_PROVIDER_ID })

    service.cancelCodexLogin()
    await service.logoutIsolatedCodex()

    expect(codexAuth.cancelLogin).toHaveBeenCalledOnce()
    expect(codexAuth.logoutIsolated).toHaveBeenCalledOnce()
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

  it('allows a claude-default provider with no key or base URL', async () => {
    const service = createService()

    const snapshot = await service.upsertProvider({ type: 'claude-default', name: 'Local Claude' })

    expect(snapshot.providers).toHaveLength(1)
    expect(snapshot.providers[0]).toMatchObject({ type: 'claude-default', hasKey: false })
    expect(snapshot.providers[0].baseUrl).toBeUndefined()
  })
})

describe('SettingsService: validation', () => {
  it('tests Local Claude in the implicit default config when auth is OS-store-only', async () => {
    const probe = vi.fn<(executablePath: string, env: NodeJS.ProcessEnv) => Promise<void>>()
    probe.mockResolvedValue(undefined)
    const service = createService(undefined, { executeClaudeProbe: probe })
    await repository.setClaudeInfo({ resolvedPath: '/bin/claude', version: '2.1.0' })

    const result = await service.validateProvider({ draft: { type: 'claude-default' } })

    expect(result).toMatchObject({ ok: true, category: 'ok' })
    expect(probe).toHaveBeenCalledOnce()
    const probeEnv = probe.mock.calls[0][1]
    // No portable token/credentials fixture exists, so Claude must be allowed to use its native login.
    expect(Object.hasOwn(probeEnv, 'CLAUDE_CONFIG_DIR')).toBe(false)
  })

  it('records lastValidatedAt for a saved provider on success', async () => {
    const service = createService()
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

    const result = await service.validateProvider({ providerId: created.id })

    expect(result.ok).toBe(true)
    expect((await repository.getSettings()).providers[0].lastValidatedAt).toBeGreaterThan(0)
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

    fetchMock.mockResolvedValue({ status: 200 })
    await service.validateProvider({ providerId: created.id })

    const stored = (await repository.getSettings()).providers[0]

    expect(stored.lastValidationFailure).toBeUndefined()
    expect(stored.lastValidatedAt).toBeGreaterThan(0)
  })

  it('invalidates an earlier success when the latest validation fails', async () => {
    const service = createService()
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 })
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

  it.each([
    ['base URL', { baseUrl: 'https://other.example/v1' }],
    ['model', { model: 'm2' }],
    ['API format', { apiEndpoints: ['responses' as const] }]
  ])('invalidates prior validation when the custom provider %s changes', async (_label, change) => {
    const service = createService()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }))
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
    const resolvers: Array<(response: { status: number }) => void> = []
    const fetchMock = vi.fn(
      () => new Promise<{ status: number }>((resolve) => resolvers.push(resolve))
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

    const older = service.validateProvider({ providerId: created.id })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const newer = service.validateProvider({ providerId: created.id })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    resolvers[1]({ status: 200 })
    await newer
    resolvers[0]({ status: 401 })
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }))

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
    expect(backend.authentication).toBeUndefined()
    expect(backend.providerConfiguration).toBeUndefined()
    expect(backend.env.CODEX_API_KEY).toBeUndefined()
    expect(backend.env.CODEX_CONFIG).toBeUndefined()
    expect(backend.env.MODEL_PROVIDER).toBeUndefined()
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
      modalities: { input: ['text', 'image'] }
    })
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
        type: 'custom',
        name: 'DeepSeek',
        apiEndpoints: ['openai'],
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        key: 'test-key'
      })
    ).providers[0]
    const storedProvider = (await repository.getSettings()).providers[0]
    await repository.upsertProvider({
      ...storedProvider,
      lastValidatedAt: Date.now()
    })
    await service.setActiveProvider(provider.id)

    vi.stubEnv('OPEN_SCIENCE_AGENT_FRAMEWORK', 'codex')
    const backend = await service.resolveActiveAgentBackend()

    // Chat Completions provider ⇒ bridge ⇒ Codex runs the classic-tool-mode catalog model so it
    // advertises the shell_command function tool the bridge can forward (CODEX_BRIDGE_MODEL).
    expect(backend.sessionModel).toBe('gpt-5.5')
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

  it("uses Claude's implicit default config for a local provider with OS-store-only auth", async () => {
    const service = createService()

    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const created = (await service.upsertProvider({ type: 'claude-default', name: 'Local' }))
      .providers[0]
    await service.setActiveProvider(created.id)

    const config = await service.resolveActiveSpawnConfig()

    // No portable auth fixture exists, so the explicit app config is removed. This lets Claude Code
    // reuse native credential stores that are available only in its implicit default context.
    expect(config.envOverrides.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(config.envOverrides.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(config.envOverrides.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it('injects the local login (~/.claude token) for a local provider at spawn time', async () => {
    const userClaudeDir = await mkdtemp(join(tmpdir(), 'os-user-claude-'))
    await mkdir(userClaudeDir, { recursive: true })
    await writeFile(
      join(userClaudeDir, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-user', ANTHROPIC_BASE_URL: 'https://gw' } })
    )

    const service = new SettingsService({
      repository,
      storageRoot,
      userClaudeDir,
      detectDeps: {
        env: {},
        homePath: '/home',
        platform: 'linux',
        isExecutable: () => Promise.resolve(true),
        getVersion: () => Promise.resolve('2.1.0'),
        resolveNpmBinDirs: () => Promise.resolve([])
      }
    })

    await repository.setClaudeInfo({ resolvedPath: execPath, version: '2.1.0' })
    const created = (await service.upsertProvider({ type: 'claude-default', name: 'Local' }))
      .providers[0]
    await service.setActiveProvider(created.id)

    const config = await service.resolveActiveSpawnConfig()
    await rm(userClaudeDir, { recursive: true, force: true })

    expect(config.envOverrides.ANTHROPIC_AUTH_TOKEN).toBe('sk-user')
    expect(config.envOverrides.ANTHROPIC_BASE_URL).toBe('https://gw')
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
  it('is always true for a claude-default provider', async () => {
    const service = createService()
    const created = (await service.upsertProvider({ type: 'claude-default', name: 'Local Claude' }))
      .providers[0]

    expect(created.supportsImageInput).toBe(true)
  })

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
      userClaudeDir: join(storageRoot, 'no-user-claude'),
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
    const created = (await service.upsertProvider({ type: 'claude-default', name: 'Local' }))
      .providers[0]
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
    service.setTurnForcedSkillIds(['demo'])
    await service.resolveActiveSpawnConfig()
    expect(await exists(skillDir)).toBe(true)

    // The stored disabled set is untouched, so the skill still lists as disabled.
    const skills = await service.listSkills()
    expect(skills.find((skill) => skill.id === 'demo')?.enabled).toBe(false)

    // Clearing the force set removes it again on the next spawn.
    service.clearTurnForcedSkillIds()
    await service.resolveActiveSpawnConfig()
    expect(await exists(skillDir)).toBe(false)
  })

  it('materializes enabled skills into the app-owned CODEX_HOME before spawn', async () => {
    const adapterPath = join(storageRoot, 'bin', 'codex-acp')
    await mkdir(dirname(adapterPath), { recursive: true })
    await writeFile(adapterPath, '', 'utf8')
    const service = new SettingsService({
      repository,
      storageRoot,
      userClaudeDir: join(storageRoot, 'no-user-claude'),
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
      userClaudeDir: join(storageRoot, 'no-user-claude'),
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

  it('reports only disabled picks as needing force-load and maps ids to names', async () => {
    const service = await createSkillService()

    await service.createSkill({ name: 'My Skill', description: 'Mine.', body: '# Mine' })
    await service.setSkillEnabled({ id: 'demo', enabled: false })

    // Only the disabled pick (demo) needs a respawn; the enabled personal skill does not.
    expect(await service.skillsNeedingForceLoad(['demo', 'personal-my-skill'])).toEqual(['demo'])
    expect(await service.skillsNeedingForceLoad(['personal-my-skill'])).toEqual([])

    // Names resolve in the given id order, skipping unknown ids.
    expect(await service.skillNamesForIds(['personal-my-skill', 'demo', 'nope'])).toEqual([
      'My Skill',
      'Demo'
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
      userClaudeDir: join(storageRoot, 'no-user-claude'),
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
      userClaudeDir: join(storageRoot, 'no-user-claude'),
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
      userClaudeDir: join(storageRoot, 'no-user-claude'),
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
      userClaudeDir: join(storageRoot, 'no-user-claude'),
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
      userClaudeDir: join(storageRoot, 'no-user-claude'),
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
