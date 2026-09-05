import { isDeepStrictEqual } from 'node:util'

import type { UpsertProviderRequest, ValidateProviderResult } from '../../shared/settings'
import {
  CLAUDE_ISOLATED_PROVIDER_ID,
  CLAUDE_SHARED_PROVIDER_ID,
  codexSubscriptionProviderIdentity,
  isClaudeSubscriptionProviderId,
  isCodexSubscriptionProvider,
  isCodexSubscriptionProviderId,
  resolveCodexSubscriptionType
} from '../../shared/settings'
import { codexSubscriptionStorageDir } from '../agent-framework/codex'
import {
  clearAppOwnedCodexAuthentication,
  clearImportedCodexProviderRoute,
  CodexAuthController,
  ensureCodexAuthHome,
  importCodexAuthentication,
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
import { encryptKey, isEncryptionAvailable, maskKey, tryDecryptKey } from './crypto'
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
  'Claude is disconnected from Open Science. Sign in again to use your shared Claude profile.'

type ProviderAuthLifecycleOwnerOptions = {
  repository: SettingsRepository
  storageRoot: string
  userClaudeDir: string
  userCodexDir: string
  resolveCodexExecutable: (
    adapterPath: string | undefined,
    nativePath: string | undefined
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
          return openCodexAuthSession({
            adapterPath: await options.resolveCodexExecutable(
              settings.codex?.resolvedPath,
              settings.codex?.nativePath
            ),
            nativePath: settings.codex?.nativePath,
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
          isEncryptionAvailable: () => isEncryptionAvailable()
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
      if (reimport) onAuthenticationReimported()
    } else if (request.type === 'codex-isolated' && existing?.codexAuthMode !== 'isolated') {
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
    this.codexIsolatedLoginGeneration += 1
    await Promise.all([
      Promise.resolve().then(() => this.codexAuth.cancelLogin()),
      Promise.resolve().then(() => this.claudeIsolatedAuth.cancelLogin()),
      Promise.resolve().then(() => this.claudeSharedAuth.cancelLogin())
    ])
  }

  async loginIsolatedCodex(): Promise<ValidateProviderResult> {
    const loginGeneration = ++this.codexIsolatedLoginGeneration
    const result = this.codexAuthValidationResult(await this.codexAuth.loginIsolated())
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === codexSubscriptionProviderIdentity().id
    )
    if (provider?.type !== 'codex-isolated' || provider.codexAuthMode !== 'isolated') {
      return { ...result, applied: false }
    }

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
    this.codexIsolatedLoginGeneration += 1
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === codexSubscriptionProviderIdentity().id
    )
    if (provider?.type !== 'codex-isolated' || provider.codexAuthMode !== 'isolated') {
      return {
        ok: false,
        category: 'unknown',
        message: 'No isolated Open Science Codex login is configured.'
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
        message: 'The Open Science Codex login could not be removed.'
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
          endpoint: 'anthropic'
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
          endpoint: 'anthropic'
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

  async isProviderKeyUsable(provider: StoredProvider): Promise<boolean> {
    if (isCodexSubscriptionProvider(provider.type)) return true
    if (provider.type === 'claude-shared') {
      if (provider.disconnectedAt !== undefined) return false
      return this.getClaudeSharedAuthStatus()
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
          ? 'No existing Codex login was found. Run `codex login` or use the isolated Open Science login.'
          : isolatedFallback)
    }
  }
}

export { CLAUDE_SHARED_DISCONNECTED_MESSAGE, ProviderAuthLifecycleOwner }
export type { ProviderAuthLifecycleOwnerOptions }
