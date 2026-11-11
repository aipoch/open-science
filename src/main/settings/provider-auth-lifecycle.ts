import { isDeepStrictEqual } from 'node:util'

import type {
  AgentFrameworkId,
  UpsertProviderRequest,
  ValidateProviderResult
} from '../../shared/settings'
import {
  CLAUDE_ISOLATED_PROVIDER_ID,
  CLAUDE_SHARED_PROVIDER_ID,
  codexSubscriptionProviderIdentity,
  isClaudeSubscriptionProviderId,
  isCodexSubscriptionProvider,
  isCodexSubscriptionProviderId,
  resolveCodexSubscriptionType
} from '../../shared/settings'
import { customProviderRequiresKey } from '../../shared/provider-url-policy'
import { codexSubscriptionStorageDir } from '../agent-framework/codex'
import {
  clearAppOwnedCodexAuthentication,
  clearImportedCodexProviderRoute,
  CodexAuthController,
  ensureCodexAuthHome,
  importCodexAuthentication,
  inspectAppOwnedCodexAuthentication,
  openCodexAuthSession,
  resolveEffectiveCodexSubscriptionTransport,
  type CodexAuthControllerPort,
  type CodexAuthStatus
} from './codex-auth'
import {
  ClaudeIsolatedAuthController,
  type ClaudeIsolatedAuthControllerPort,
  type ClaudeIsolatedAuthStatus
} from './claude-isolated-auth'
import {
  ClaudeSharedAuthController,
  type ClaudeSharedAuthControllerPort,
  type ClaudeSharedAuthStatus
} from './claude-shared-auth'
import {
  CodexHarnessCompatibilityError,
  inspectCodexHarnessAvailability,
  readCodexHarnessConnection,
  type CodexHarnessAuthOptions
} from './codex-harness-auth'
import { encryptKey, isCredentialStorageAvailable, maskKey, tryDecryptKey } from './crypto'
import { getAppClaudeConfigDir, type ResolvedProvider } from './provider-env'
import {
  buildProviderValidationPatch,
  targetForValidationResult
} from './provider-validation-state'
import type { SettingsRepository } from './repository'
import type { SystemProxyEnvironment } from './system-proxy'
import type { StoredProvider, StoredSettings } from './types'

const CLAUDE_SHARED_AUTH_STATUS_TTL_MS = 5_000
const SETUP_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000
const CLAUDE_SHARED_DISCONNECTED_MESSAGE =
  'Claude is disconnected from Open-Science. Sign in again to use your shared Claude profile.'

type ProviderAuthLifecycleOwnerOptions = {
  repository: SettingsRepository
  storageRoot: string
  userClaudeDir: string
  userCodexDir: string
  resolveCodexExecutable: (
    adapterPath: string | undefined,
    nativePath: string | undefined,
    prepareForHarness?: boolean
  ) => Promise<string>
  resolveCodexProxyEnvironment: () => Promise<SystemProxyEnvironment | undefined>
  runClaudeSubscriptionProbe: (
    provider: ResolvedProvider,
    settings: StoredSettings
  ) => Promise<ValidateProviderResult>
  resolveProvider: (provider: StoredProvider, modelOverride?: string) => ResolvedProvider
  codexAuth?: CodexAuthControllerPort
  claudeIsolatedAuth?: ClaudeIsolatedAuthControllerPort
  claudeSharedAuth?: ClaudeSharedAuthControllerPort
}

class ProviderAuthLifecycleOwner {
  private readonly repository: SettingsRepository
  private readonly codexAuth: CodexAuthControllerPort
  private readonly claudeIsolatedAuth: ClaudeIsolatedAuthControllerPort
  private readonly claudeSharedAuth: ClaudeSharedAuthControllerPort
  private accountMutationTail: Promise<void> = Promise.resolve()
  private codexIsolatedLoginGeneration = 0
  private codexHarnessCredentials = new AbortController()
  private codexSignInPending = false
  private codexCredentialHolds = 0
  private claudeSharedAuthStatusCache: { authenticated: boolean; checkedAt: number } | undefined
  private claudeSharedAuthStatusGeneration = 0
  private claudeSharedAuthStatusPromise:
    { generation: number; promise: Promise<boolean> } | undefined

  constructor(private readonly options: ProviderAuthLifecycleOwnerOptions) {
    this.repository = options.repository
    this.codexAuth =
      options.codexAuth ??
      new CodexAuthController({
        openSession: async (mode) => {
          const settings = await this.repository.getSettings()
          const provider = settings.providers.find((candidate) =>
            isCodexSubscriptionProvider(candidate.type)
          )
          const adapterPath = await options.resolveCodexExecutable(
            settings.codex?.resolvedPath,
            settings.codex?.nativePath
          )
          // Preparing authentication may have installed the paired native runtime.
          const current = await this.repository.getSettings()
          return openCodexAuthSession({
            adapterPath,
            nativePath: current.codex?.nativePath,
            mode,
            storageRoot: options.storageRoot,
            transport: resolveEffectiveCodexSubscriptionTransport(provider ?? {}),
            proxyEnv: await options.resolveCodexProxyEnvironment()
          })
        }
      })
    this.claudeIsolatedAuth =
      options.claudeIsolatedAuth ??
      new ClaudeIsolatedAuthController({
        store: {
          loadToken: () => this.loadClaudeIsolatedToken(),
          saveToken: (token) => this.saveClaudeIsolatedToken(token),
          clearToken: () => this.clearClaudeIsolatedToken(),
          isEncryptionAvailable: () => isCredentialStorageAvailable()
        },
        claudePath: async () => {
          const settings = await this.repository.getSettings()
          return settings.claude?.resolvedPath ?? 'claude'
        },
        configDir: getAppClaudeConfigDir(options.storageRoot)
      })
    this.claudeSharedAuth =
      options.claudeSharedAuth ??
      new ClaudeSharedAuthController({
        claudePath: async () => {
          const settings = await this.repository.getSettings()
          return settings.claude?.resolvedPath ?? 'claude'
        },
        configDir: options.userClaudeDir
      })
  }

  serializeAccountMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.accountMutationTail.then(operation)
    this.accountMutationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  quiesceCodexHarnessCredentials(): { settled: Promise<void>; release: () => void } {
    this.codexCredentialHolds++
    let released = false
    return {
      settled: this.accountMutationTail,
      release: () => {
        if (!released) this.codexCredentialHolds--
        released = true
      }
    }
  }

  private revokeCodexHarnessCredentials(): void {
    this.codexHarnessCredentials.abort()
    this.codexHarnessCredentials = new AbortController()
  }

  bindCodexHarnessConnection(providerId: string, type: StoredProvider['type'], revision?: number) {
    const generation = this.codexHarnessCredentials.signal
    let boundAccount: string | undefined
    let boundEndpoint: string | undefined
    return (requestSignal: AbortSignal) => {
      const signal = AbortSignal.any([requestSignal, generation])
      return this.serializeAccountMutation(async () => {
        signal.throwIfAborted()
        const settings = await this.repository.getSettings()
        const provider = settings.providers.find(({ id }) => id === providerId)
        if (
          this.codexCredentialHolds > 0 ||
          this.codexSignInPending ||
          !provider ||
          !isCodexSubscriptionProvider(provider.type) ||
          provider.type !== type ||
          (provider.configRevision ?? 0) !== revision ||
          provider.disconnectedAt !== undefined
        ) {
          throw new Error('The Codex subscription connection is no longer available.')
        }
        const connection = await readCodexHarnessConnection(
          this.codexHarnessOptions(provider, settings),
          signal
        )
        signal.throwIfAborted()
        if (
          boundAccount &&
          (boundAccount !== connection.accountId || boundEndpoint !== connection.endpoint)
        )
          throw new Error('The Codex subscription connection changed. Reconnect the session.')
        boundEndpoint = connection.endpoint
        boundAccount = connection.accountId
        return connection
      })
    }
  }

  private codexHarnessOptions(
    provider: Pick<StoredProvider, 'codexTransport' | 'codexAutoUseHttps'>,
    settings: StoredSettings
  ): CodexHarnessAuthOptions {
    return {
      storageRoot: this.options.storageRoot,
      nativePath: settings.codex?.nativePath,
      transport: resolveEffectiveCodexSubscriptionTransport(provider),
      resolveProxyEnvironment: this.options.resolveCodexProxyEnvironment,
      resolveNativePath: async () => {
        const current = await this.repository.getSettings()
        await this.options.resolveCodexExecutable(
          current.codex?.resolvedPath,
          current.codex?.nativePath,
          true
        )
        return (await this.repository.getSettings()).codex?.nativePath
      }
    }
  }

  private async loadClaudeIsolatedToken(): Promise<string | undefined> {
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === CLAUDE_ISOLATED_PROVIDER_ID
    )
    return provider?.keyRef ? tryDecryptKey(provider.keyRef) : undefined
  }

  private async saveClaudeIsolatedToken(token: string): Promise<void> {
    const applied = await this.repository.updateClaudeIsolatedCredentialsIfExists({
      keyRef: encryptKey(token),
      keyMask: maskKey(token)
    })
    if (!applied) throw new Error('The Claude provider was removed before sign-in completed.')
  }

  private async clearClaudeIsolatedToken(): Promise<void> {
    await this.repository.updateClaudeIsolatedCredentialsIfExists({
      keyRef: undefined,
      keyMask: undefined
    })
  }

  async prepareCodexProviderUpsert(
    request: UpsertProviderRequest,
    existing: StoredProvider | undefined,
    onAuthenticationReimported: () => void
  ): Promise<void> {
    if (isCodexSubscriptionProvider(request.type)) this.codexIsolatedLoginGeneration += 1
    const reimport = request.type === 'codex-shared' && request.reimportCodexAuthentication === true
    if (request.type === 'codex-shared' && (existing?.codexAuthMode !== 'imported' || reimport)) {
      await this.codexAuth.cancelLogin()
      await importCodexAuthentication(
        this.options.userCodexDir,
        codexSubscriptionStorageDir(this.options.storageRoot)
      )
      this.revokeCodexHarnessCredentials()
      if (reimport) onAuthenticationReimported()
    } else if (request.type === 'codex-isolated' && existing?.codexAuthMode !== 'isolated') {
      this.revokeCodexHarnessCredentials()
      if (existing) await this.codexAuth.cancelLogin()
      const codexHome = codexSubscriptionStorageDir(this.options.storageRoot)
      await clearImportedCodexProviderRoute(codexHome)
      await clearAppOwnedCodexAuthentication(codexHome)
    }
    if (isCodexSubscriptionProvider(request.type)) {
      await ensureCodexAuthHome(
        request.type === 'codex-shared' ? 'shared' : 'isolated',
        this.options.storageRoot,
        request.codexTransport ?? existing?.codexTransport ?? 'auto'
      )
    }
  }

  async cleanupProviderBeforeDelete(id: string): Promise<void> {
    if (isCodexSubscriptionProviderId(id)) {
      this.revokeCodexHarnessCredentials()
      this.codexIsolatedLoginGeneration += 1
      await this.codexAuth.cancelLogin()
      const codexHome = codexSubscriptionStorageDir(this.options.storageRoot)
      await clearImportedCodexProviderRoute(codexHome)
      await clearAppOwnedCodexAuthentication(codexHome)
    }
    if (isClaudeSubscriptionProviderId(id)) {
      this.claudeIsolatedAuth.cancelLogin()
      this.claudeSharedAuth.cancelLogin()
    }
  }

  cancelCodexLogin(): void {
    this.codexIsolatedLoginGeneration += 1
    void this.codexAuth.cancelLogin()
  }

  cancelClaudeLogin(): void {
    this.claudeSharedAuth.cancelLogin()
  }

  async dispose(): Promise<void> {
    this.codexCredentialHolds++
    this.codexHarnessCredentials.abort()
    this.codexIsolatedLoginGeneration += 1
    await Promise.all([
      this.accountMutationTail,
      Promise.resolve().then(() => this.codexAuth.cancelLogin()),
      Promise.resolve().then(() => this.claudeIsolatedAuth.cancelLogin()),
      Promise.resolve().then(() => this.claudeSharedAuth.cancelLogin())
    ])
  }

  async loginIsolatedCodex(): Promise<ValidateProviderResult> {
    if (this.codexSignInPending)
      return { ok: false, category: 'unknown', message: 'A Codex sign-in is already in progress.' }
    const loginGeneration = ++this.codexIsolatedLoginGeneration
    this.revokeCodexHarnessCredentials()
    this.codexSignInPending = true
    let result: ValidateProviderResult
    try {
      // Let a cancelled credential refresh finish closing its writer before Codex starts login.
      await this.accountMutationTail
      if (loginGeneration !== this.codexIsolatedLoginGeneration)
        return {
          ok: false,
          category: 'unknown',
          applied: false,
          message: 'Codex sign-in cancelled.'
        }
      result = this.codexAuthValidationResult(await this.codexAuth.loginIsolated())
    } finally {
      this.codexSignInPending = false
      this.revokeCodexHarnessCredentials()
    }
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === codexSubscriptionProviderIdentity().id
    )
    if (provider?.type !== 'codex-isolated' || provider.codexAuthMode !== 'isolated') {
      return { ...result, applied: false }
    }

    if (result.ok && settings.agentFrameworkId === 'open-science-agent')
      result = (await this.validateProviderAuth(
        this.options.resolveProvider(provider),
        settings,
        provider
      ))!

    if (result.applied === false) return result
    if (result.frameworkIncompatible)
      return { ...result, applied: this.codexIsolatedLoginGeneration === loginGeneration }

    const applied = await this.serializeAccountMutation(() => {
      if (this.codexIsolatedLoginGeneration !== loginGeneration) return Promise.resolve(false)
      return this.repository.updateCodexIsolatedValidationIfIdentityMatches(
        provider,
        result.ok
          ? {
              lastValidatedAt: Date.now(),
              lastValidatedTarget: undefined,
              lastValidationFailure: undefined
            }
          : {
              lastValidatedAt: undefined,
              lastValidatedTarget: undefined,
              lastValidationFailure: {
                at: Date.now(),
                category: result.category,
                status: result.status,
                message: result.message
              }
            }
      )
    })
    return { ...result, applied }
  }

  async logoutIsolatedCodex(): Promise<ValidateProviderResult> {
    this.revokeCodexHarnessCredentials()
    this.codexIsolatedLoginGeneration += 1
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === codexSubscriptionProviderIdentity().id
    )
    if (provider?.type !== 'codex-isolated' || provider.codexAuthMode !== 'isolated') {
      return {
        ok: false,
        category: 'unknown',
        message: 'No isolated Open-Science Codex login is configured.'
      }
    }

    await this.codexAuth.cancelLogin()
    try {
      await ensureCodexAuthHome(
        'isolated',
        this.options.storageRoot,
        provider.codexTransport ?? 'auto'
      )
      await clearAppOwnedCodexAuthentication(codexSubscriptionStorageDir(this.options.storageRoot))
    } catch {
      return {
        ok: false,
        category: 'unknown',
        message: 'The Open-Science Codex login could not be removed.'
      }
    }

    await this.repository.clearCodexIsolatedValidationIfExists()
    return { ok: true, category: 'ok' }
  }

  async loginIsolatedClaude(token: string): Promise<ValidateProviderResult> {
    return this.finalizeClaudeIsolatedLogin(
      this.claudeIsolatedAuthValidationResult(await this.claudeIsolatedAuth.loginIsolated(token))
    )
  }

  async loginIsolatedClaudeBrowser(): Promise<ValidateProviderResult> {
    const authStatus = await this.claudeIsolatedAuth.loginIsolatedBrowser()
    if (authStatus.cancelled) {
      return {
        ok: false,
        category: 'unknown',
        message: authStatus.message,
        applied: false,
        cancelled: true
      }
    }
    return this.finalizeClaudeIsolatedLogin(this.claudeIsolatedAuthValidationResult(authStatus))
  }

  async cancelClaudeIsolatedLogin(): Promise<void> {
    this.claudeIsolatedAuth.cancelLogin()
  }

  private async finalizeClaudeIsolatedLogin(
    initialResult: ValidateProviderResult
  ): Promise<ValidateProviderResult> {
    let result = initialResult
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === CLAUDE_ISOLATED_PROVIDER_ID
    )
    if (!provider) return { ...result, applied: false }

    const resolvedTarget = this.options.resolveProvider(
      provider,
      settings.activeProviderId === provider.id ? settings.activeModel : undefined
    )
    const probeStarted = result.ok
    if (probeStarted)
      result = await this.options.runClaudeSubscriptionProbe(resolvedTarget, settings)
    const validationTarget = probeStarted
      ? targetForValidationResult(result, {
          model: resolvedTarget.model,
          endpoint: 'messages'
        })
      : undefined
    const validationPatch = buildProviderValidationPatch(provider, result, validationTarget)
    const applied = await this.repository.updateClaudeIsolatedValidationIfKeyMatches(
      provider.keyRef,
      {
        expiresAt: result.ok ? Date.now() + SETUP_TOKEN_LIFETIME_MS : undefined,
        ...validationPatch
      }
    )
    return { ...result, applied }
  }

  async logoutIsolatedClaude(): Promise<ValidateProviderResult> {
    const status = await this.claudeIsolatedAuth.logoutIsolated()
    if (status.message) {
      return {
        ok: false,
        category: status.message.toLowerCase().includes('timed out') ? 'timeout' : 'unknown',
        message: status.message
      }
    }

    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === CLAUDE_ISOLATED_PROVIDER_ID
    )
    if (provider && status.authenticated === false) {
      await this.repository.upsertProvider({
        ...provider,
        expiresAt: undefined,
        lastValidatedAt: undefined,
        lastValidatedTarget: undefined,
        lastValidationFailure: undefined
      })
    }
    return { ok: true, category: 'ok' }
  }

  async loginClaudeShared(): Promise<ValidateProviderResult> {
    const loginTarget = await this.repository.getSettings()
    const targetProvider = loginTarget.providers.find(
      (candidate) => candidate.id === CLAUDE_SHARED_PROVIDER_ID
    )
    this.invalidateClaudeSharedAuthStatus()
    const authStatus = await this.claudeSharedAuth.loginShared()
    this.invalidateClaudeSharedAuthStatus()
    let result = this.claudeSharedAuthValidationResult(authStatus)

    if (authStatus.cancelled) return { ...result, applied: false, cancelled: true }
    if (targetProvider?.type !== 'claude-shared') return { ...result, applied: false }

    const settings = await this.repository.getSettings()
    const currentProvider = settings.providers.find(
      (candidate) => candidate.id === CLAUDE_SHARED_PROVIDER_ID
    )
    if (
      settings.claudeSubscriptionProviderId !== loginTarget.claudeSubscriptionProviderId ||
      !isDeepStrictEqual(currentProvider, targetProvider)
    ) {
      return { ...result, applied: false }
    }

    const resolvedTarget = this.options.resolveProvider(
      targetProvider,
      settings.activeProviderId === targetProvider.id ? settings.activeModel : undefined
    )
    if (result.ok) {
      result = await this.options.runClaudeSubscriptionProbe(resolvedTarget, settings)
    }
    const validationTarget = authStatus.authenticated
      ? targetForValidationResult(result, {
          model: resolvedTarget.model,
          endpoint: 'messages'
        })
      : undefined
    const validationPatch = buildProviderValidationPatch(targetProvider, result, validationTarget)
    const applied = await this.repository.updateClaudeSharedValidationIfUnchanged(
      targetProvider,
      loginTarget.claudeSubscriptionProviderId,
      resolvedTarget.model,
      {
        disconnectedAt: authStatus.authenticated ? undefined : targetProvider.disconnectedAt,
        ...validationPatch
      }
    )

    return { ...result, applied }
  }

  async logoutClaudeShared(): Promise<ValidateProviderResult> {
    this.invalidateClaudeSharedAuthStatus()
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === CLAUDE_SHARED_PROVIDER_ID
    )
    if (provider) {
      const disconnectedAt = Date.now()
      await this.repository.upsertProvider({
        ...provider,
        disconnectedAt,
        lastValidatedAt: undefined,
        lastValidatedTarget: undefined,
        lastValidationFailure: {
          at: disconnectedAt,
          category: 'auth',
          message: CLAUDE_SHARED_DISCONNECTED_MESSAGE
        }
      })
    }

    return { ok: true, category: 'ok' }
  }

  async getClaudeSharedStatus(): Promise<ValidateProviderResult> {
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === CLAUDE_SHARED_PROVIDER_ID
    )
    if (provider?.type !== 'claude-shared') {
      return {
        ok: false,
        category: 'unknown',
        message: 'Claude subscription provider is not configured.'
      }
    }

    return this.validateClaudeSharedProvider(
      this.options.resolveProvider(
        provider,
        settings.activeProviderId === provider.id ? settings.activeModel : undefined
      ),
      settings,
      provider
    )
  }

  async getClaudeIsolatedStatus(): Promise<ValidateProviderResult> {
    const status = await this.claudeIsolatedAuth.getStatus()
    if (!status.authenticated) {
      return this.claudeIsolatedAuthValidationResult(
        status,
        'Not signed in. Run `claude setup-token` and paste the token to connect your Claude subscription.'
      )
    }

    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === CLAUDE_ISOLATED_PROVIDER_ID
    )
    if (!provider) {
      return {
        ok: false,
        category: 'unknown',
        message: 'Claude subscription provider is not configured.'
      }
    }

    return this.options.runClaudeSubscriptionProbe(
      this.options.resolveProvider(
        provider,
        settings.activeProviderId === provider.id ? settings.activeModel : undefined
      ),
      settings
    )
  }

  async validateProviderAuth(
    provider: ResolvedProvider,
    settings: StoredSettings,
    storedProvider?: StoredProvider
  ): Promise<ValidateProviderResult | undefined> {
    if (isCodexSubscriptionProvider(provider.type)) {
      if (settings.agentFrameworkId === 'open-science-agent') {
        const generation = this.codexHarnessCredentials.signal
        const interrupted: ValidateProviderResult = {
          ok: false,
          category: 'unknown',
          applied: false,
          message: 'The Codex subscription connection is no longer available.'
        }
        try {
          const checked = await this.serializeAccountMutation(async () => {
            generation.throwIfAborted()
            if (this.codexSignInPending || this.codexCredentialHolds > 0) return false
            await readCodexHarnessConnection(
              this.codexHarnessOptions(provider, settings),
              generation
            )
            return true
          })
          return checked ? { ok: true, category: 'ok' } : interrupted
        } catch (error) {
          if (generation.aborted) return interrupted
          const incompatible = error instanceof CodexHarnessCompatibilityError
          return {
            ok: false,
            category: incompatible ? 'incompatible' : 'auth',
            ...(incompatible ? { frameworkIncompatible: true } : {}),
            message: (error as Error).message
          }
        }
      }
      return this.codexAuthValidationResult(
        await this.codexAuth.getStatus(
          resolveCodexSubscriptionType(provider) === 'codex-shared' ? 'shared' : 'isolated'
        ),
        'Not signed in. Use Sign in to connect your ChatGPT account.'
      )
    }
    if (provider.type === 'claude-shared') {
      return this.validateClaudeSharedProvider(provider, settings, storedProvider)
    }
    if (provider.type === 'claude-isolated') return this.getClaudeIsolatedStatus()
    return undefined
  }

  async isProviderKeyUsable(
    provider: StoredProvider,
    frameworkId?: AgentFrameworkId
  ): Promise<boolean> {
    if (isCodexSubscriptionProvider(provider.type)) {
      if (frameworkId === 'open-science-agent') {
        if (this.codexSignInPending || this.codexCredentialHolds > 0) return false
        const settings = await this.repository.getSettings()
        return inspectCodexHarnessAvailability(this.codexHarnessOptions(provider, settings))
      }
      return (
        (await inspectAppOwnedCodexAuthentication(this.options.storageRoot)).state === 'present'
      )
    }
    if (provider.type === 'claude-shared') {
      if (provider.disconnectedAt !== undefined) return false
      return this.getClaudeSharedAuthStatus()
    }

    // A loopback custom gateway (local model server) serves without a key, so an absent key stays
    // usable and preflight does not block the spawn on a credential it will never have.
    if (provider.type === 'custom' && !provider.keyRef) {
      return !customProviderRequiresKey(provider.baseUrl)
    }
    return Boolean(provider.keyRef) && tryDecryptKey(provider.keyRef) !== undefined
  }

  private invalidateClaudeSharedAuthStatus(): void {
    this.claudeSharedAuthStatusCache = undefined
    this.claudeSharedAuthStatusGeneration += 1
  }

  private async getClaudeSharedAuthStatus(): Promise<boolean> {
    const cached = this.claudeSharedAuthStatusCache
    if (cached && Date.now() - cached.checkedAt < CLAUDE_SHARED_AUTH_STATUS_TTL_MS) {
      return cached.authenticated
    }
    const generation = this.claudeSharedAuthStatusGeneration
    const pending = this.claudeSharedAuthStatusPromise
    if (pending?.generation === generation) return pending.promise

    const promise = this.claudeSharedAuth
      .getStatus()
      .then((status) => {
        if (this.claudeSharedAuthStatusGeneration === generation) {
          this.claudeSharedAuthStatusCache = {
            authenticated: status.authenticated,
            checkedAt: Date.now()
          }
        }
        return status.authenticated
      })
      .finally(() => {
        if (this.claudeSharedAuthStatusPromise?.promise === promise) {
          this.claudeSharedAuthStatusPromise = undefined
        }
      })

    this.claudeSharedAuthStatusPromise = { generation, promise }
    return promise
  }

  private claudeSharedAuthValidationResult(
    status: ClaudeSharedAuthStatus,
    notSignedInMessage?: string
  ): ValidateProviderResult {
    if (status.authenticated) return { ok: true, category: 'ok' }

    return { ok: false, category: 'unknown', message: status.message ?? notSignedInMessage }
  }

  private async validateClaudeSharedProvider(
    provider: ResolvedProvider,
    settings: StoredSettings,
    storedProvider?: StoredProvider
  ): Promise<ValidateProviderResult> {
    if (storedProvider?.disconnectedAt !== undefined) {
      return { ok: false, category: 'auth', message: CLAUDE_SHARED_DISCONNECTED_MESSAGE }
    }

    const status = await this.claudeSharedAuth.getStatus()
    this.claudeSharedAuthStatusCache = {
      authenticated: status.authenticated,
      checkedAt: Date.now()
    }
    if (!status.authenticated) {
      const result = this.claudeSharedAuthValidationResult(
        status,
        'Not signed in. Sign in via browser OAuth in the Settings card to connect your Claude subscription.'
      )
      return status.supported ? { ...result, category: 'auth' } : result
    }
    return this.options.runClaudeSubscriptionProbe(provider, settings)
  }

  private claudeIsolatedAuthValidationResult(
    status: ClaudeIsolatedAuthStatus,
    notSignedInMessage?: string
  ): ValidateProviderResult {
    if (status.authenticated) return { ok: true, category: 'ok' }
    return { ok: false, category: 'unknown', message: status.message ?? notSignedInMessage }
  }

  private codexAuthValidationResult(
    status: CodexAuthStatus,
    isolatedFallback = 'Codex sign-in did not complete.'
  ): ValidateProviderResult {
    if (status.authenticated) return { ok: true, category: 'ok' }
    return {
      ok: false,
      category: status.message?.toLowerCase().includes('timed out')
        ? 'timeout'
        : status.supported
          ? 'auth'
          : 'unknown',
      message:
        status.message ??
        (status.mode === 'shared'
          ? 'No existing Codex login was found. Run `codex login` or use the isolated Open-Science login.'
          : isolatedFallback)
    }
  }
}

export { CLAUDE_SHARED_DISCONNECTED_MESSAGE, ProviderAuthLifecycleOwner }
export type { ProviderAuthLifecycleOwnerOptions }
