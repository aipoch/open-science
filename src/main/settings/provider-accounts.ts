import {
  decodeCatalogParameters,
  providerCatalogState,
  type ProviderCatalogState
} from '../../shared/provider-model-catalog-codec'
import {
  WORKBUDDY_PROFILE_MESSAGE,
  codeBuddyAccounts,
  codeBuddySiteForId,
  readCodeBuddyAccountRequest,
  type CodeBuddyAccountRequest,
  type CodeBuddyAuthMode,
  type CodeBuddySite
} from '../../shared/codebuddy-subscription'
import { hasWorkBuddyProfile } from './codebuddy-profile'
import { runCodeBuddyAuth } from './codebuddy-auth'
import { isDeepStrictEqual } from 'node:util'
import {
  BootstrapError,
  type BootstrapRequest,
  type BootstrapResult,
  type BootstrapProviderCredentialTarget,
  type BootstrapProviderOptions
} from '../../shared/bootstrap'
import {
  OFFICIAL_VENDORS,
  getOfficialVendor,
  type ModelProtocol,
  isOfficialVendorId
} from '@aipoch/providers'
import { defaultVendorModel, getOfficialVendorModelIds } from '../../shared/provider-model-policy'
import {
  customProviderRequiresKey,
  providerAllowsAnonymousAccess,
  getCustomProviderBaseUrlError
} from '../../shared/provider-url-policy'
import { type ReasoningEffortProfile } from '../../shared/reasoning-effort'
import { isModelStreamingCompatible } from '../../shared/agent-framework-id'

import type {
  ProviderDeletionScenarioModelHandling,
  ProviderDraft,
  ProviderValidationTarget,
  ProviderView,
  RefreshProviderModelsRequest,
  RefreshProviderModelsResult,
  SaveValidatedProviderResult,
  UpsertProviderRequest,
  ValidateProviderRequest,
  ValidateProviderResult,
  XaiOAuthLoginResult,
  XaiOAuthDeviceAuthorization
} from '../../shared/settings'
import {
  CLAUDE_ISOLATED_PROVIDER_ID,
  CLAUDE_SHARED_PROVIDER_ID,
  ENDPOINT_PATHS,
  LAB_PROVIDER_ID,
  XAI_SUBSCRIPTION_PROVIDER_ID,
  claudeIsolatedProviderIdentity,
  claudeSharedProviderIdentity,
  codexSubscriptionProviderIdentity,
  isClaudeSubscriptionProvider,
  isCodexSubscriptionProvider,
  isProviderUsableByFramework,
  isLabProvider,
  isXaiSubscriptionProvider,
  DEFAULT_ENDPOINT_ORDER,
  preferredEndpoint,
  providerEndpoints,
  providerValidationSucceeded,
  requiresChatCompletionsBridge,
  xaiSubscriptionProviderIdentity
} from '../../shared/settings-runtime'
import {
  DEFAULT_AGENT_FRAMEWORK_ID,
  getAgentFramework,
  type AgentFrameworkId
} from '../agent-framework'
import { netFetchStandard } from '../network-fetch'
import { type ClaudeIsolatedAuthControllerPort } from './claude-isolated-auth'
import { type ClaudeSharedAuthControllerPort } from './claude-shared-auth'
import { ensureCodexAuthHome, type CodexAuthControllerPort } from './codex-auth'
import { encryptKey, maskKey, tryDecryptKey } from './crypto'
import type { DeviceCredentialStore } from './device-credentials'
import {
  CLAUDE_SHARED_DISCONNECTED_MESSAGE,
  ProviderAuthLifecycleOwner
} from './provider-auth-lifecycle'
import { resolveProviderDraft } from './provider-draft-projection'
import type { ResolvedProvider } from './provider-env'
import { ProviderModelCatalogOwner } from './provider-model-catalog-owner'
import {
  assertProviderCapacity,
  assertProviderDraftLimits,
  assertProviderModelLimit
} from './provider-resource-limits'
import {
  ProviderRuntimeProjectionOwner,
  requiresNativeResponsesCompatibility,
  type ProviderRuntimeTarget,
  type RuntimeProviderModelSelection
} from './provider-runtime-projection'
import { resolveCustomTokenLimits } from './provider-token-limits'
import {
  reconcileCatalogHealth,
  buildProviderValidationPatch,
  targetForValidationResult
} from './provider-validation-state'
import type { SettingsRepository } from './repository'
import type { SystemProxyEnvironment } from './system-proxy'
import type { StoredProvider, StoredSettings } from './types'
import { buildValidationRequest, validateProvider as validateProviderTarget } from './validate'
import type { XaiOAuthControllerPort } from './xai-oauth'
import { XaiProviderAccountOwner } from './xai-provider-account-owner'
type ProviderAccountsModuleOptions = {
  repository: SettingsRepository
  storageRoot: string
  userClaudeDir: string
  userCodexDir: string
  allocateSettingsIdSequence: () => number
  resolveCodeBuddyExecutable?: (path?: string) => Promise<string>
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
  runAcpValidation?: (
    provider: ResolvedProvider,
    settings: StoredSettings
  ) => Promise<ValidateProviderResult>
  codexAuth?: CodexAuthControllerPort
  claudeIsolatedAuth?: ClaudeIsolatedAuthControllerPort
  claudeSharedAuth?: ClaudeSharedAuthControllerPort
  xaiOAuth?: XaiOAuthControllerPort
  // The optional Lab account owner; supplies the "signed in" probe without owning provider records.
  lab?: { isUsable: () => Promise<boolean> }
}
type PreparedProvider = {
  provider: StoredProvider
  settings: StoredSettings
  catalogBaseline?: ProviderCatalogState
}
type TaskProviderSetupRequest = Extract<
  BootstrapRequest,
  {
    action:
      'provider-options' | 'provider-save' | 'provider-activate' | 'provider-credential-target'
  }
>
type TaskProviderDraft = Extract<
  TaskProviderSetupRequest,
  { action: 'provider-save' | 'provider-credential-target' }
>

const LAB_PROVIDER_MANAGED_MESSAGE = 'The Lab provider is managed in Settings → Lab.'

// Owns durable provider records and every provider-specific validation/authentication lifecycle;
// executable installation, runtime spawn, live ACP reconnect, and transports remain outside.
class ProviderAccountsModule {
  private readonly codeBuddyOperations = new Set<{
    site: CodeBuddySite
    action: Exclude<CodeBuddyAccountRequest['action'], 'cancel'>
    controller: AbortController
    settled: Promise<void>
  }>()
  private codeBuddyHolds = 0
  private readonly repository: SettingsRepository
  private readonly runtimeProjection = new ProviderRuntimeProjectionOwner()
  private readonly auth: ProviderAuthLifecycleOwner
  private readonly xai: XaiProviderAccountOwner
  private readonly modelCatalog: ProviderModelCatalogOwner
  private readonly providerValidationGenerations = new Map<string, number>()

  constructor(private readonly options: ProviderAccountsModuleOptions) {
    this.repository = options.repository
    this.auth = new ProviderAuthLifecycleOwner({
      ...options,
      resolveProvider: (provider, model) => this.runtimeProjection.resolveProvider(provider, model)
    })
    this.xai = new XaiProviderAccountOwner(
      this.repository,
      (operation) => this.auth.serializeAccountMutation(operation),
      options.xaiOAuth
    )
    this.modelCatalog = new ProviderModelCatalogOwner(
      this.repository,
      (provider) => this.resolveProvider(provider),
      () => this.xai.getAccessCredential()
    )
  }

  async dispose(): Promise<void> {
    this.codeBuddyHolds++
    await this.stopCodeBuddyOperations()
    await Promise.all([this.auth.dispose(), this.xai.dispose()])
  }

  private stopCodeBuddyOperations(): Promise<unknown> {
    const operations = [...this.codeBuddyOperations]
    for (const operation of operations) operation.controller.abort()
    return Promise.all(operations.map((operation) => operation.settled))
  }

  quiesceAuthentication(): ReturnType<XaiProviderAccountOwner['quiesce']> {
    this.codeBuddyHolds++
    let released = false
    const codeBuddy = this.stopCodeBuddyOperations()
    const xai = this.xai.quiesce()
    const codex = this.auth.quiesceCodexHarnessCredentials()
    return {
      settled: Promise.all([xai.settled, codex.settled, codeBuddy]).then(() => undefined),
      release: () => {
        if (released) return
        released = true
        this.codeBuddyHolds--
        codex.release()
        xai.release()
      }
    }
  }

  async prepareBootstrapCodex(): Promise<void> {
    await this.auth.serializeAccountMutation(async () => {
      const settings = await this.repository.getSettings()
      if (settings.agentFrameworkId !== 'codex') throw new BootstrapError('configuration_conflict')
      const identity = codexSubscriptionProviderIdentity()
      const existing = settings.providers.find(({ id }) => id === identity.id)
      if (
        (settings.providers.length > 0 && !existing) ||
        (existing &&
          (existing.type !== 'codex-isolated' || existing.codexAuthMode !== 'isolated')) ||
        (settings.activeProviderId && settings.activeProviderId !== identity.id)
      )
        throw new BootstrapError('configuration_conflict')
      // The historical CLI may have already signed in to this app-owned home. Creating the
      // provider through ordinary upsert would clear that authentication; never import or clear it.
      await ensureCodexAuthHome('isolated', this.options.storageRoot, existing?.codexTransport)
      if (!existing)
        await this.repository.publishBootstrapProvider(
          settings,
          {
            ...identity,
            type: 'codex-isolated',
            codexAuthMode: 'isolated',
            apiEndpoints: ['responses']
          },
          false
        )
    })
  }

  async completeBootstrapCodex(): Promise<string> {
    return this.auth.serializeAccountMutation(async () => {
      const settings = await this.repository.getSettings()
      if (settings.agentFrameworkId !== 'codex') throw new BootstrapError('configuration_conflict')
      if (settings.agentFrameworkId !== 'codex') throw new BootstrapError('configuration_conflict')
      const identity = codexSubscriptionProviderIdentity()
      const provider = settings.providers.find(({ id }) => id === identity.id)
      if (provider?.type !== 'codex-isolated' || provider.codexAuthMode !== 'isolated')
        throw new BootstrapError('configuration_conflict')
      const result = await this.auth.validateProviderAuth(
        this.resolveProvider(provider),
        settings,
        provider
      )
      if (!result?.ok || !(await this.auth.isProviderKeyUsable(provider)))
        throw new BootstrapError('credential_invalid')
      await this.repository.publishBootstrapProvider(
        settings,
        {
          ...provider,
          ...buildProviderValidationPatch(provider, result, undefined)
        },
        true
      )
      return provider.id
    })
  }

  async bootstrapOpenAi(key: string, model: string): Promise<string> {
    const settings = await this.repository.getSettings()
    const framework = settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID
    const id = 'cli-openai'
    const existing = settings.providers.find((provider) => provider.id === id)
    if (
      (framework !== DEFAULT_AGENT_FRAMEWORK_ID && framework !== 'codex') ||
      settings.providers.some((provider) => provider.id !== id) ||
      (settings.activeProviderId && settings.activeProviderId !== id) ||
      (existing &&
        (existing.type !== 'official' ||
          existing.vendorId !== 'openai' ||
          (settings.activeModel ?? existing.model) !== model ||
          !existing.keyRef ||
          tryDecryptKey(existing.keyRef) !== key))
    )
      throw new BootstrapError('configuration_conflict')
    if (
      this.resolveActiveModel(
        existing ?? { id, type: 'official', vendorId: 'openai', name: 'OpenAI', model },
        model
      ) !== model
    )
      throw new BootstrapError('invalid_request')
    const draft = { type: 'official' as const, vendorId: 'openai' as const, model, key }
    const result = await this.validateProvider({ draft })
    if (!result.ok) throw new BootstrapError('credential_invalid')
    const provider: StoredProvider = {
      ...existing,
      id,
      type: 'official',
      vendorId: 'openai',
      name: existing?.name ?? 'OpenAI',
      model: existing?.model ?? model,
      keyRef: existing?.keyRef ?? encryptKey(key),
      keyMask: maskKey(key)
    }
    await this.repository.publishBootstrapProvider(
      settings,
      {
        ...provider,
        ...buildProviderValidationPatch(
          provider,
          result,
          result.testedTarget ?? { model, endpoint: 'responses' }
        )
      },
      true
    )
    return id
  }

  async bootstrapApiProvider(
    request: TaskProviderSetupRequest,
    credentials: DeviceCredentialStore
  ): Promise<BootstrapResult> {
    const settings = await this.repository.getSettings()
    if (request.action === 'provider-options') {
      return {
        ok: true,
        providerOptions: await this.taskProviderOptions(settings, credentials, request.framework)
      }
    }
    if (settings.agentFrameworkId !== request.framework)
      throw new BootstrapError('configuration_conflict')

    const { framework, model } = request
    if (request.action === 'provider-credential-target') {
      return {
        ok: true,
        providerCredentialTarget: this.taskCredentialTarget(request, settings)
      }
    }
    const providerId =
      request.action === 'provider-save'
        ? await this.saveTaskProvider(request, settings, credentials)
        : await this.activateTaskProvider(request, settings)
    return {
      ok: true,
      providerSetup: {
        providerId,
        model,
        framework,
        saved: true,
        validation: 'passed',
        active: request.action === 'provider-activate'
      }
    }
  }

  private async taskProviderOptions(
    settings: StoredSettings,
    credentials: DeviceCredentialStore,
    framework = settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID
  ): Promise<BootstrapProviderOptions> {
    const runtime = getAgentFramework(framework)
    const modelOption = (
      provider: StoredProvider,
      id: string
    ): BootstrapProviderOptions['official'][number]['models'][number] => {
      const apiEndpoints = this.resolveProviderApiEndpoints(provider, id)
      return {
        id,
        apiEndpoints,
        compatible:
          isProviderUsableByFramework({ type: provider.type, apiEndpoints }, runtime) &&
          isModelStreamingCompatible(framework, provider.modelStreaming?.[id]),
        credentialRequired: !providerAllowsAnonymousAccess({ ...provider, model: id })
      }
    }
    return {
      framework,
      selectedFramework: settings.agentFrameworkId ?? null,
      active: {
        providerId: settings.activeProviderId ?? null,
        model: settings.activeModel ?? null
      },
      providers: settings.providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        type: provider.type,
        models: this.toProviderView(provider).models.map((id) => modelOption(provider, id)),
        ...(provider.lastValidatedAt &&
        provider.lastValidatedTarget?.model &&
        provider.lastValidatedTarget.endpoint
          ? {
              lastValidated: {
                model: provider.lastValidatedTarget.model,
                protocol: provider.lastValidatedTarget.endpoint
              }
            }
          : {}),
        authentication:
          provider.type === 'official' || provider.type === 'custom'
            ? 'api'
            : isLabProvider(provider.type)
              ? 'app-managed'
              : 'user-sign-in'
      })),
      official: OFFICIAL_VENDORS.flatMap((vendor) =>
        (vendor.regions ?? [undefined]).map((region) => ({
          vendorId: vendor.id,
          name: vendor.label,
          ...(region ? { region: region.id, regionLabel: region.label } : {}),
          models: getOfficialVendorModelIds(vendor.id, region?.id).map((id) =>
            modelOption(
              {
                id: vendor.id,
                name: vendor.label,
                type: 'official',
                vendorId: vendor.id,
                region: region?.id
              },
              id
            )
          )
        }))
      ),
      customProtocols: [...runtime.supportedApiTypes],
      credentialRefs: (await credentials.list()).flatMap((credential) =>
        credential.kind !== 'oauth'
          ? [{ id: credential.id, displayName: credential.displayName }]
          : []
      )
    }
  }

  private taskProviderDraft(request: TaskProviderDraft): StoredProvider {
    const { providerType: type, model, baseUrl, protocol, vendorId, region } = request
    const vendor = isOfficialVendorId(vendorId) ? getOfficialVendor(vendorId) : undefined
    if (
      type === 'official'
        ? !vendor ||
          baseUrl ||
          protocol ||
          (region && !vendor.regions?.some(({ id }) => id === region))
        : !baseUrl || !protocol || vendorId || region || getCustomProviderBaseUrlError(baseUrl)
    )
      throw new BootstrapError('invalid_request')
    return {
      id: request.providerId ?? this.createProviderId(),
      type,
      model,
      name: request.name ?? vendor?.label ?? 'Custom API provider',
      ...(vendor ? { vendorId: vendor.id, region } : { baseUrl, apiEndpoints: [protocol!] })
    }
  }

  private taskCredentialTarget(
    request: TaskProviderDraft,
    settings: StoredSettings
  ): BootstrapProviderCredentialTarget {
    if (settings.providers.some(({ id }) => id === request.providerId))
      throw new BootstrapError('configuration_conflict')
    const resolved = this.taskModelTarget(
      this.taskProviderDraft(request),
      request.model,
      request.framework
    )
    const { endpoint, url } = buildValidationRequest(
      resolved,
      false,
      this.validationFrameworkEndpoints(resolved, settings)
    )
    if (!endpoint) throw new BootstrapError('provider_validation_failed', 'incompatible')
    return { protocol: endpoint, endpoint: url }
  }

  private async saveTaskProvider(
    request: Extract<TaskProviderSetupRequest, { action: 'provider-save' }>,
    settings: StoredSettings,
    credentials: DeviceCredentialStore
  ): Promise<string> {
    const {
      credentialRef,
      framework,
      providerId: targetId,
      expectedProtocol,
      expectedEndpoint
    } = request
    const draft = this.taskProviderDraft(request)
    if (
      (request.key && credentialRef) ||
      Boolean(targetId) !== Boolean(expectedProtocol) ||
      Boolean(targetId) !== Boolean(expectedEndpoint)
    )
      throw new BootstrapError('invalid_request')
    if (targetId) {
      const target = this.taskCredentialTarget(request, settings)
      if (target.protocol !== expectedProtocol || target.endpoint !== expectedEndpoint)
        throw new BootstrapError('configuration_conflict')
    }

    let key = request.key
    if (credentialRef) {
      try {
        key = await credentials.resolveStatic(credentialRef, { kind: 'env', name: 'API_KEY' })
      } catch {
        throw new BootstrapError('credential_invalid')
      }
    }
    if (!key && !providerAllowsAnonymousAccess(draft))
      throw new BootstrapError(credentialRef ? 'credential_invalid' : 'provider_credential_missing')

    const { validation, providerId } = await this.saveValidatedProvider(
      { ...draft, ...(key ? { key } : {}) },
      framework,
      Boolean(targetId)
    )
    if (!providerId) throw new BootstrapError('provider_validation_failed', validation.category)
    return providerId
  }

  private taskModelTarget(
    provider: StoredProvider,
    model: string,
    framework: AgentFrameworkId
  ): ResolvedProvider {
    let target: ProviderRuntimeTarget
    try {
      target = this.resolveRuntimeTarget(
        provider,
        { kind: 'required', model },
        getAgentFramework(framework)
      )
    } catch {
      throw new BootstrapError('provider_validation_failed', 'model-not-found')
    }
    if (!target.frameworkCompatible || !target.modelBridgeSupported)
      throw new BootstrapError('provider_validation_failed', 'incompatible')
    return target.provider
  }

  private async activateTaskProvider(
    request: Extract<TaskProviderSetupRequest, { action: 'provider-activate' }>,
    settings: StoredSettings
  ): Promise<string> {
    const { providerId, model, framework, expectedActiveProviderId, expectedActiveModel } = request
    const checkSelection = (current: StoredSettings): void => {
      if (
        current.agentFrameworkId !== framework ||
        (current.activeProviderId ?? null) !== expectedActiveProviderId ||
        (current.activeModel ?? null) !== expectedActiveModel
      )
        throw new BootstrapError('configuration_conflict')
    }
    checkSelection(settings)
    const provider = settings.providers.find(({ id }) => id === providerId)
    if (!provider || (provider.type !== 'official' && provider.type !== 'custom'))
      throw new BootstrapError('invalid_request')
    const tested = this.taskModelTarget(provider, model, framework)
    if (!tested.key && !providerAllowsAnonymousAccess(tested))
      throw new BootstrapError('credential_invalid')
    const validation = await this.validateResolvedProvider({ providerId, model }, settings, {
      provider: tested,
      storedId: providerId
    })
    if (validation.applied === false) throw new BootstrapError('configuration_conflict')
    if (!validation.ok || validation.frameworkIncompatible)
      throw new BootstrapError(
        'provider_validation_failed',
        validation.frameworkIncompatible ? 'incompatible' : validation.category
      )
    const evidence = targetForValidationResult(validation, {
      model,
      endpoint: preferredEndpoint(
        tested.apiEndpoints ?? ['messages'],
        this.validationFrameworkEndpoints(tested, settings) ?? DEFAULT_ENDPOINT_ORDER
      )
    })

    await this.repository.setActiveProvider(providerId, model, (current) => {
      checkSelection(current)
      const candidate = current.providers.find(({ id }) => id === providerId)
      if (
        !candidate ||
        (candidate.configRevision ?? 0) !== (provider.configRevision ?? 0) ||
        !this.sameValidationTarget(tested, this.taskModelTarget(candidate, model, framework)) ||
        !evidence ||
        !providerValidationSucceeded(candidate, evidence)
      )
        throw new BootstrapError('configuration_conflict')
    })
    return providerId
  }

  // Keeps provider-before-Connector ordering in SettingsService's whole-settings migration path.
  async migrateLegacyKeyRefs(providers: readonly StoredProvider[]): Promise<boolean> {
    let changed = false
    for (const provider of providers) {
      if (!provider.keyRef?.startsWith('plain:')) continue
      const key = tryDecryptKey(provider.keyRef)
      if (!key) continue
      await this.repository.upsertProvider({ ...provider, keyRef: encryptKey(key) })
      changed = true
    }
    return changed
  }
  async upsertProvider(request: UpsertProviderRequest): Promise<void> {
    return this.auth.serializeAccountMutation(() => this.upsertProviderNow(request))
  }
  private async prepareProvider(request: UpsertProviderRequest): Promise<PreparedProvider> {
    if (isLabProvider(request.type) || request.id === LAB_PROVIDER_ID) {
      throw new Error(LAB_PROVIDER_MANAGED_MESSAGE)
    }
    assertProviderDraftLimits(request)
    const settings = await this.repository.getSettings()
    if (
      request.type === 'codebuddy-subscription' ||
      (request.id &&
        codeBuddySiteForId(request.id) &&
        !settings.providers.some(
          (provider) => provider.id === request.id && provider.type !== 'codebuddy-subscription'
        ))
    )
      throw new Error('Use the CodeBuddy account sign-in to configure this provider.')
    if (
      request.requireExisting &&
      (!request.id || !settings.providers.some((provider) => provider.id === request.id))
    ) {
      throw new Error('Provider no longer exists.')
    }
    if (request.expectedConfigRevision !== undefined) {
      const source = settings.providers.find(({ id }) => id === request.id)
      if (
        !Number.isSafeInteger(request.expectedConfigRevision) ||
        request.expectedConfigRevision < 0 ||
        !source ||
        (source.configRevision ?? 0) !== request.expectedConfigRevision
      )
        throw new Error('Provider configuration changed. Your draft has not been saved.')
    }
    const subscriptionIdentity = isCodexSubscriptionProvider(request.type)
      ? codexSubscriptionProviderIdentity()
      : request.type === 'claude-isolated'
        ? claudeIsolatedProviderIdentity()
        : request.type === 'claude-shared'
          ? claudeSharedProviderIdentity()
          : request.type === 'xai-subscription'
            ? xaiSubscriptionProviderIdentity()
            : undefined
    const requestedId = subscriptionIdentity?.id ?? request.id
    const existing = requestedId
      ? settings.providers.find((provider) => provider.id === requestedId)
      : undefined
    assertProviderCapacity(settings.providers.length, existing !== undefined)
    const reimportCodexAuthentication =
      request.type === 'codex-shared' && request.reimportCodexAuthentication === true
    await this.auth.prepareCodexProviderUpsert(request, existing, () => {
      if (reimportCodexAuthentication && requestedId) {
        this.advanceProviderValidationGeneration(requestedId)
      }
    })

    const provider: StoredProvider = {
      id: subscriptionIdentity?.id ?? existing?.id ?? request.id ?? this.createProviderId(),
      type: request.type === 'codex-shared' ? 'codex-isolated' : request.type,
      name:
        subscriptionIdentity?.name ??
        (request.name?.trim() || existing?.name || 'Untitled provider')
    }

    const carryKey = (): boolean => {
      if (request.key) {
        provider.keyRef = encryptKey(request.key)
        provider.keyMask = maskKey(request.key)
      } else if (
        existing?.keyRef &&
        existing.type === provider.type &&
        existing.vendorId === provider.vendorId
      ) {
        provider.keyRef = existing.keyRef
        provider.keyMask = existing.keyMask
      }
      return Boolean(provider.keyRef)
    }

    let credentialsChanged = false
    if (isCodexSubscriptionProvider(request.type)) {
      provider.apiEndpoints = ['responses']
      provider.codexAuthMode = request.type === 'codex-shared' ? 'imported' : 'isolated'
      provider.codexTransport = request.codexTransport ?? existing?.codexTransport ?? 'auto'
      if (
        provider.codexTransport === 'auto' &&
        (existing?.codexTransport ?? 'auto') === 'auto' &&
        existing?.codexAutoUseHttps !== undefined
      ) {
        provider.codexAutoUseHttps = existing.codexAutoUseHttps
      }
      credentialsChanged =
        existing !== undefined &&
        (existing.codexAuthMode !== provider.codexAuthMode || reimportCodexAuthentication)
    } else if (request.type === 'xai-subscription') {
      provider.apiEndpoints = ['messages', 'chat-completions', 'responses']
      provider.model = request.model?.trim() || existing?.model || defaultVendorModel('xai')
      if (existing?.fetchedModels) provider.fetchedModels = existing.fetchedModels
      if (existing?.keyRef) provider.keyRef = existing.keyRef
      if (existing?.accountEmail) provider.accountEmail = existing.accountEmail
      credentialsChanged = provider.model !== existing?.model
    } else if (request.type === 'claude-isolated') {
      provider.apiEndpoints = ['messages']
      if (existing?.keyRef) {
        provider.keyRef = existing.keyRef
        provider.keyMask = existing.keyMask
      }
      if (existing?.expiresAt !== undefined) provider.expiresAt = existing.expiresAt
      const model =
        request.model === undefined ? existing?.model : request.model.trim() || undefined
      credentialsChanged = model !== existing?.model
      if (model) provider.model = model
    } else if (request.type === 'claude-shared') {
      provider.apiEndpoints = ['messages']
      const model =
        request.model === undefined ? existing?.model : request.model.trim() || undefined
      credentialsChanged = model !== existing?.model
      if (model) provider.model = model
      if (existing?.disconnectedAt !== undefined) provider.disconnectedAt = existing.disconnectedAt
    } else if (request.type === 'official') {
      const vendorId = isOfficialVendorId(request.vendorId) ? request.vendorId : existing?.vendorId
      if (!vendorId) throw new Error('A vendor is required for an official provider.')
      const region =
        request.region ?? (vendorId === existing?.vendorId ? existing.region : undefined)
      provider.vendorId = vendorId
      if (region) provider.region = region
      provider.catalogParameters =
        request.catalogParameters === undefined
          ? vendorId === existing?.vendorId && region === existing.region
            ? existing.catalogParameters
            : undefined
          : decodeCatalogParameters(request.catalogParameters)
      if (request.catalogParameters && !provider.catalogParameters)
        throw new Error('Invalid catalog parameters.')
      if (
        existing &&
        vendorId === existing.vendorId &&
        region === existing.region &&
        !request.key &&
        isDeepStrictEqual(provider.catalogParameters ?? {}, existing.catalogParameters ?? {})
      ) {
        Object.assign(provider, providerCatalogState(existing))
      }
      carryKey()
      credentialsChanged =
        Boolean(request.key) ||
        provider.vendorId !== existing?.vendorId ||
        provider.region !== existing?.region
    } else if (request.type === 'custom') {
      const baseUrl = request.baseUrl?.trim() || existing?.baseUrl
      const model = request.model?.trim() || existing?.model
      const tokenLimits = resolveCustomTokenLimits(request, existing)
      if (!baseUrl) throw new Error('Base URL is required for a custom provider.')
      const baseUrlError = getCustomProviderBaseUrlError(baseUrl)
      if (baseUrlError) throw new Error(baseUrlError)
      if (!model) throw new Error('Model is required for a custom provider.')
      // Local loopback gateways serve without a key; a remote gateway still requires one.
      if (!carryKey() && customProviderRequiresKey(baseUrl)) {
        throw new Error('API key is required for a custom provider.')
      }
      provider.baseUrl = baseUrl
      provider.model = model
      Object.assign(provider, tokenLimits)
      provider.supportsImageInput =
        request.supportsImageInput ?? existing?.supportsImageInput ?? false
      provider.reasoningEffortPreset =
        request.reasoningEffortPreset ?? existing?.reasoningEffortPreset ?? 'standard-5'
      provider.reasoningEffortTransport =
        request.reasoningEffortTransport ?? existing?.reasoningEffortTransport ?? 'reasoning-effort'
      provider.apiEndpoints = request.apiEndpoints ?? existing?.apiEndpoints ?? ['messages']
      credentialsChanged =
        Boolean(request.key) ||
        provider.baseUrl !== existing?.baseUrl ||
        provider.model !== existing?.model ||
        provider.apiEndpoints.join(',') !== (existing?.apiEndpoints ?? []).join(',')
    }

    if (existing?.lastValidatedAt !== undefined && !credentialsChanged)
      provider.lastValidatedAt = existing.lastValidatedAt
    if (existing?.lastValidatedTarget !== undefined && !credentialsChanged)
      provider.lastValidatedTarget = existing.lastValidatedTarget
    const preserveValidationFailure =
      !credentialsChanged ||
      (provider.type === 'claude-shared' && provider.disconnectedAt !== undefined)
    if (existing?.lastValidationFailure !== undefined && preserveValidationFailure)
      provider.lastValidationFailure = existing.lastValidationFailure

    const catalogBaseline = this.modelCatalog.applyDraft(
      request.catalogDraftToken,
      provider,
      existing
    )
    if (
      provider.type === 'official' &&
      !provider.keyRef &&
      !providerAllowsAnonymousAccess({ ...provider, model: request.model ?? provider.model })
    )
      throw new Error('API key is required for an official provider.')
    return {
      provider: existing ? reconcileCatalogHealth(existing, provider) : provider,
      settings,
      catalogBaseline
    }
  }

  private async upsertProviderNow(request: UpsertProviderRequest): Promise<void> {
    const { provider, settings, catalogBaseline } = await this.prepareProvider(request)
    const editId = request.requireExisting ? request.id : undefined
    if (isClaudeSubscriptionProvider(provider.type)) {
      const outgoingId =
        provider.type === 'claude-shared' ? CLAUDE_ISOLATED_PROVIDER_ID : CLAUDE_SHARED_PROVIDER_ID
      const collapsedCardWasActive =
        settings.activeProviderId === provider.id || settings.activeProviderId === outgoingId
      await this.repository.upsertProvider(provider, editId, {
        expectedConfigRevision: request.expectedConfigRevision
      })
      if (collapsedCardWasActive) {
        await this.repository.setActiveProvider(provider.id, this.resolveActiveModel(provider))
      }
      return
    }

    await this.repository.upsertProvider(provider, editId, {
      catalogBaseline,
      expectedConfigRevision: request.expectedConfigRevision
    })
  }

  private async prepareProviderEdit(request: UpsertProviderRequest): Promise<
    PreparedProvider & {
      requireExisting: boolean
      expectedConfigRevision?: number
    }
  > {
    if (request.type !== 'custom' && request.type !== 'official')
      throw new Error('Connection testing edits requires an API-key provider.')
    const prepared = await this.prepareProvider(request)
    const existing = prepared.settings.providers.find(({ id }) => id === prepared.provider.id)
    return {
      ...prepared,
      requireExisting: Boolean(existing),
      expectedConfigRevision: existing ? (existing.configRevision ?? 0) : undefined
    }
  }

  async saveValidatedProvider(
    request: UpsertProviderRequest,
    expectedFramework?: AgentFrameworkId,
    createOnly = false
  ): Promise<SaveValidatedProviderResult> {
    const prepared = await this.prepareProviderEdit(request)
    if (expectedFramework !== undefined && prepared.settings.agentFrameworkId !== expectedFramework)
      throw new BootstrapError('configuration_conflict')
    const saved = prepared.settings.providers.find(({ id }) => id === prepared.provider.id)
    if (createOnly && saved) throw new BootstrapError('configuration_conflict')
    // Validation metadata can change without a configuration revision. A successful probe of the
    // same connection must not overwrite a newer health observation while waiting to commit.
    const tested =
      expectedFramework !== undefined && request.model
        ? this.taskModelTarget(prepared.provider, request.model, expectedFramework)
        : this.resolveProvider(
            prepared.provider,
            request.type === 'official' ? request.model?.trim() || undefined : undefined
          )
    const expectedValidationState =
      saved && this.sameValidationTarget(tested, this.resolveProvider(saved))
        ? {
            lastValidatedAt: saved.lastValidatedAt,
            lastValidatedTarget: saved.lastValidatedTarget,
            lastValidationFailure: saved.lastValidationFailure
          }
        : undefined
    const validation = await this.validateProviderEdit(prepared.provider, prepared.settings, tested)
    if (expectedFramework !== undefined && validation.applied === false)
      throw new BootstrapError('configuration_conflict')
    if (!validation.ok) return { validation }
    if (validation.applied === false)
      throw new Error(
        'Provider connection status changed. Your changes have not been saved. Test the connection again.'
      )
    const target = targetForValidationResult(validation, validation.testedTarget)
    const provider = {
      ...prepared.provider,
      ...buildProviderValidationPatch(
        expectedValidationState && saved ? saved : prepared.provider,
        validation,
        target
      )
    }
    await this.auth.serializeAccountMutation(async () => {
      const current = await this.repository.getSettings()
      const exists = current.providers.some(({ id }) => id === provider.id)
      if (!prepared.requireExisting && exists)
        throw createOnly
          ? new BootstrapError('configuration_conflict')
          : new Error('Provider configuration changed. Your draft has not been saved.')
      assertProviderCapacity(current.providers.length, exists)
      await this.repository.upsertProvider(
        provider,
        prepared.requireExisting ? provider.id : undefined,
        {
          expectedFramework,
          createOnly,
          catalogBaseline: prepared.catalogBaseline,
          expectedConfigRevision: prepared.expectedConfigRevision,
          expectedValidationState,
          validationMatches: (merged) => {
            const matches = this.sameValidationTarget(
              tested,
              this.resolveProvider(merged, tested.model)
            )
            if (!matches) validation.applied = false
            return matches
          }
        }
      )
    })
    return { validation, providerId: provider.id }
  }

  async deleteProvider(
    id: string,
    scenarioModelHandling?: ProviderDeletionScenarioModelHandling
  ): Promise<void> {
    const settings = await this.repository.getSettings()
    if (settings.providers.some((provider) => provider.id === id && isLabProvider(provider.type))) {
      throw new Error(LAB_PROVIDER_MANAGED_MESSAGE)
    }
    if (settings.providers.some((provider) => provider.id === id && isXaiRecord(provider))) {
      await this.xai.logout()
    }

    const remove = (): Promise<void> =>
      this.auth.serializeAccountMutation(async () => {
        await this.auth.cleanupProviderBeforeDelete(id)
        await this.repository.deleteProvider(id, scenarioModelHandling)
      })
    const record = settings.providers.find((provider) => provider.id === id)
    const site = record?.type === 'codebuddy-subscription' ? codeBuddySiteForId(id) : undefined
    if (!site) return remove()
    await this.withCodeBuddyOperation(site, 'logout', async (signal) => {
      if (record?.codeBuddyAuthMode !== 'shared') await this.runCodeBuddy(site, 'logout', signal)
      await remove()
    })
  }

  beginXaiOAuthLogin(): Promise<XaiOAuthDeviceAuthorization> {
    return this.xai.beginLogin()
  }

  async waitXaiOAuthLogin(): Promise<XaiOAuthLoginResult> {
    const account = await this.xai.waitForLogin()
    const validation = await this.validateProvider({ providerId: XAI_SUBSCRIPTION_PROVIDER_ID })
    return { ...account, validation }
  }

  cancelXaiOAuthLogin(): void {
    this.xai.cancelLogin()
  }

  async logoutXaiOAuth(): Promise<void> {
    this.advanceProviderValidationGeneration(XAI_SUBSCRIPTION_PROVIDER_ID)
    await this.xai.logout()
  }

  bindCodexHarnessConnection(
    target: ProviderRuntimeTarget
  ): ReturnType<ProviderAuthLifecycleOwner['bindCodexHarnessConnection']> {
    return this.auth.bindCodexHarnessConnection(
      target.providerId,
      target.providerType,
      target.configRevision
    )
  }

  getXaiOAuthAccessToken(forceRefresh = false): Promise<string> {
    return this.xai.getAccessToken(forceRefresh)
  }

  private async runCodeBuddy(
    site: CodeBuddySite,
    action: Exclude<CodeBuddyAccountRequest['action'], 'cancel'>,
    signal: AbortSignal,
    mode: CodeBuddyAuthMode = 'isolated'
  ): ReturnType<typeof runCodeBuddyAuth> {
    const settings = await this.repository.getSettings()
    if (!this.options.resolveCodeBuddyExecutable) throw new Error('CodeBuddy runtime unavailable.')
    const executable = await this.options.resolveCodeBuddyExecutable(settings.codebuddyPath)
    signal.throwIfAborted()
    return runCodeBuddyAuth(executable, this.options.storageRoot, site, action, signal, mode)
  }

  async codeBuddyAccount(input: CodeBuddyAccountRequest): Promise<ValidateProviderResult> {
    const { site, action, mode: requestedMode } = readCodeBuddyAccountRequest(input)
    if (action === 'cancel') {
      const pending = [...this.codeBuddyOperations].find(
        (op) => op.site === site && op.action === 'login'
      )
      if (pending) {
        pending.controller.abort()
        await pending.settled
      }
      return { ok: true, category: 'ok' }
    }
    const identity = codeBuddyAccounts[site]
    return this.withCodeBuddyOperation(site, action, async (signal) => {
      const before = await this.repository.getSettings()
      const prior = before.providers.find((provider) => provider.id === identity.id)
      if (prior && prior.type !== 'codebuddy-subscription')
        throw new Error('The CodeBuddy account ID is already in use.')
      const mode = prior ? (prior.codeBuddyAuthMode ?? 'isolated') : (requestedMode ?? 'isolated')
      if (requestedMode && requestedMode !== mode)
        throw new Error('Provider configuration changed. Your draft has not been saved.')
      if (prior?.disconnectedAt !== undefined && (action === 'status' || action === 'refresh'))
        return { ok: false, category: 'auth' }
      if (action === 'status') {
        const { authenticated } = await this.runCodeBuddy(site, action, signal, mode)
        return authenticated ? { ok: true, category: 'ok' } : { ok: false, category: 'auth' }
      }
      this.advanceProviderValidationGeneration(identity.id)
      if (action === 'login') assertProviderCapacity(before.providers.length, Boolean(prior))
      if (action === 'refresh' && !prior) return { ok: false, category: 'auth' }
      const sharedDisconnect = mode === 'shared' && action === 'logout'
      const outcome = sharedDisconnect
        ? { authenticated: false }
        : await this.runCodeBuddy(site, action, signal, mode)
      if (action === 'login' && !outcome.authenticated) {
        return {
          ok: false,
          category: 'auth',
          ...(mode === 'shared' && hasWorkBuddyProfile() && { message: WORKBUDDY_PROFILE_MESSAGE })
        }
      }
      if (action === 'refresh' && outcome.authenticated && !outcome.models?.length)
        return { ok: false, category: 'unknown' }
      return await this.auth.serializeAccountMutation(async () => {
        signal.throwIfAborted()
        const settings = await this.repository.getSettings()
        const existing = settings.providers.find((p) => p.id === identity.id)
        if (action === 'logout' && !existing) return { ok: true, category: 'ok' }
        if (existing && existing.type !== 'codebuddy-subscription')
          throw new Error('The CodeBuddy account ID is already in use.')
        assertProviderCapacity(settings.providers.length, Boolean(existing))
        const health: ValidateProviderResult = outcome.authenticated
          ? { ok: true, category: 'ok' }
          : { ok: false, category: 'auth' }
        const provider: StoredProvider = {
          ...existing,
          ...identity,
          type: 'codebuddy-subscription',
          ...(mode === 'shared' && {
            codeBuddyAuthMode: mode,
            disconnectedAt: sharedDisconnect ? Date.now() : undefined
          }),
          apiEndpoints: ['chat-completions'],
          model: outcome.authenticated ? (outcome.model ?? existing?.model) : undefined,
          fetchedModels: outcome.authenticated
            ? (outcome.models ?? existing?.fetchedModels)
            : undefined,
          modelReasoningEfforts: outcome.authenticated
            ? (outcome.modelReasoningEfforts ?? existing?.modelReasoningEfforts)
            : undefined
        }
        await this.repository.upsertProvider({
          ...provider,
          ...buildProviderValidationPatch(provider, health, undefined)
        })
        return action === 'refresh' ? health : { ok: true, category: 'ok' }
      })
    })
  }

  private async withCodeBuddyOperation<T>(
    site: CodeBuddySite,
    action: Exclude<CodeBuddyAccountRequest['action'], 'cancel'>,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (this.codeBuddyHolds) throw new Error('CodeBuddy authentication is shutting down.')
    if (
      action !== 'status' &&
      [...this.codeBuddyOperations].some((op) => op.site === site && op.action !== 'status')
    )
      throw new Error('CodeBuddy account operation is in progress.')
    const controller = new AbortController()
    const { promise: settled, resolve: finish } = Promise.withResolvers<void>()
    const active = { site, action, controller, settled }
    this.codeBuddyOperations.add(active)
    try {
      return await operation(controller.signal)
    } finally {
      this.codeBuddyOperations.delete(active)
      finish()
    }
  }

  cancelCodexLogin(): void {
    this.auth.cancelCodexLogin()
  }

  cancelClaudeLogin(): void {
    this.auth.cancelClaudeLogin()
  }

  async loginIsolatedCodex(): Promise<ValidateProviderResult> {
    return this.auth.loginIsolatedCodex()
  }

  async logoutIsolatedCodex(): Promise<ValidateProviderResult> {
    return this.auth.serializeAccountMutation(() => this.auth.logoutIsolatedCodex())
  }

  async loginIsolatedClaude(token: string): Promise<ValidateProviderResult> {
    return this.auth.loginIsolatedClaude(token)
  }

  async loginIsolatedClaudeBrowser(): Promise<ValidateProviderResult> {
    return this.auth.loginIsolatedClaudeBrowser()
  }

  async cancelClaudeIsolatedLogin(): Promise<void> {
    return this.auth.cancelClaudeIsolatedLogin()
  }

  async logoutIsolatedClaude(): Promise<ValidateProviderResult> {
    return this.auth.logoutIsolatedClaude()
  }

  async loginClaudeShared(): Promise<ValidateProviderResult> {
    return this.auth.loginClaudeShared()
  }

  async logoutClaudeShared(): Promise<ValidateProviderResult> {
    return this.auth.logoutClaudeShared()
  }

  async getClaudeSharedStatus(): Promise<ValidateProviderResult> {
    return this.auth.getClaudeSharedStatus()
  }

  async getClaudeIsolatedStatus(): Promise<ValidateProviderResult> {
    return this.auth.getClaudeIsolatedStatus()
  }
  async setActiveProvider(id: string, model?: string): Promise<void> {
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find((candidate) => candidate.id === id)
    await this.repository.setActiveProvider(id, this.resolveActiveModel(provider, model))
  }
  async validateProvider(request: ValidateProviderRequest): Promise<ValidateProviderResult> {
    if ([request.providerId, request.draft, request.edit].filter(Boolean).length > 1)
      throw new Error('Choose exactly one provider validation target.')
    if (request.edit) {
      if (request.model !== undefined) throw new Error('Edit validation uses the form model.')
      const prepared = await this.prepareProviderEdit(request.edit)
      const result = await this.validateProviderEdit(prepared.provider, prepared.settings)
      const current = (await this.repository.getSettings()).providers.find(
        ({ id }) => id === prepared.provider.id
      )
      if (
        prepared.requireExisting &&
        (!current || (current.configRevision ?? 0) !== prepared.expectedConfigRevision)
      )
        return { ...result, applied: false }
      if (current) {
        const model = result.testedTarget.model
        const original = prepared.settings.providers.find(({ id }) => id === current.id)
        if (original && !isDeepStrictEqual(original.modelCatalog, current.modelCatalog)) {
          const tested = this.resolveProvider(prepared.provider, model)
          if (
            this.sameValidationTarget(tested, this.resolveProvider(original, model)) &&
            !this.sameValidationTarget(tested, this.resolveProvider(current, model))
          )
            return { ...result, applied: false }
        }
      }
      return result
    }
    if (request.draft) {
      if (isLabProvider(request.draft.type)) throw new Error(LAB_PROVIDER_MANAGED_MESSAGE)
      assertProviderDraftLimits(request.draft)
      if (request.draft.type === 'custom') {
        const baseUrlError = getCustomProviderBaseUrlError(request.draft.baseUrl?.trim() ?? '')
        if (baseUrlError) throw new Error(baseUrlError)
      }
    }
    assertProviderModelLimit(request.model)
    const settings = await this.repository.getSettings()
    const stored = settings.providers.find((provider) => provider.id === request.providerId)
    if (request.providerId === LAB_PROVIDER_ID || (stored && isLabProvider(stored.type))) {
      return {
        ok: false,
        category: 'unknown',
        message: LAB_PROVIDER_MANAGED_MESSAGE,
        applied: false
      }
    }
    if (stored) {
      const model =
        request.model ??
        (settings.activeProviderId === stored.id ? settings.activeModel : undefined)
      return this.validateResolvedProvider(request, settings, {
        provider: this.resolveProvider(stored, model),
        storedId: stored.id
      })
    }
    if (request.draft) {
      return this.validateResolvedProvider(request, settings, {
        provider: this.resolveDraft(request.draft)
      })
    }
    return { ok: false, category: 'unknown', message: 'No provider to validate.' }
  }

  private async validateProviderEdit(
    candidate: StoredProvider,
    settings: StoredSettings,
    provider = this.resolveProvider(candidate)
  ): Promise<ValidateProviderResult & { testedTarget: ProviderValidationTarget }> {
    const saved = settings.providers.find(({ id }) => id === candidate.id)
    // A failure belongs to the saved connection only when the tested input resolves to that exact
    // connection. Candidate credentials and routes must never change the original account's health.
    const storedId =
      saved && this.sameValidationTarget(provider, this.resolveProvider(saved))
        ? saved.id
        : undefined
    const result = await this.validateResolvedProvider(
      { model: provider.model },
      settings,
      { provider, storedId },
      'definitive-failures'
    )
    return {
      ...result,
      testedTarget: result.testedTarget ?? {
        model: provider.model,
        endpoint: preferredEndpoint(
          provider.apiEndpoints ?? ['messages'],
          this.validationFrameworkEndpoints(provider, settings) ?? DEFAULT_ENDPOINT_ORDER
        )
      }
    }
  }

  private validationFrameworkEndpoints(
    provider: ResolvedProvider,
    settings: StoredSettings
  ): readonly ModelProtocol[] | undefined {
    const framework = getAgentFramework(settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID)
    const incompatibility = this.frameworkIncompatibilityMessage(provider, framework)
    return isXaiSubscriptionProvider(provider.type)
      ? ['responses']
      : !incompatibility &&
          framework.id === 'codebuddy' &&
          requiresChatCompletionsBridge(provider, framework)
        ? DEFAULT_ENDPOINT_ORDER
        : incompatibility || framework.id === 'codex'
          ? undefined
          : framework.supportedApiTypes
  }

  private async validateResolvedProvider(
    request: ValidateProviderRequest,
    settings: StoredSettings,
    resolved: { provider: ResolvedProvider; storedId?: string },
    healthPolicy: 'all' | 'definitive-failures' = 'all'
  ): Promise<ValidateProviderResult> {
    const storedValidationTarget = resolved.storedId
      ? settings.providers.find((provider) => provider.id === resolved.storedId)
      : undefined
    const validationGeneration = resolved.storedId
      ? this.advanceProviderValidationGeneration(resolved.storedId)
      : undefined
    const framework = getAgentFramework(settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID)
    // Subscription providers (Codex, both Claude modes) are framework-bound by credential, not by
    // endpoint: under a foreign framework their auth-status check owns the verdict, and a pairing
    // flag on top of it would only invite a probe against a base URL they do not have.
    const incompatibility =
      isCodexSubscriptionProvider(resolved.provider.type) ||
      isClaudeSubscriptionProvider(resolved.provider.type)
        ? undefined
        : this.frameworkIncompatibilityMessage(resolved.provider, framework)

    let expectedKeyRef = storedValidationTarget?.keyRef
    let xaiAuthResult: ValidateProviderResult | undefined
    let validationProvider = resolved.provider
    if (storedValidationTarget && isXaiSubscriptionProvider(storedValidationTarget.type)) {
      try {
        const credential = await this.xai.getAccessCredential()
        expectedKeyRef = credential.keyRef
        validationProvider = {
          ...resolved.provider,
          key: credential.token,
          apiEndpoints: ['responses']
        }
      } catch (error) {
        xaiAuthResult = {
          ok: false,
          category: 'auth',
          message: error instanceof Error ? error.message : 'xAI sign-in is unavailable.'
        }
      }
    }
    // A model without a route fails locally, but its validation still has to reach the saved card.
    const localResult: ValidateProviderResult | undefined =
      resolved.provider.vendorId && resolved.provider.apiEndpoints?.length === 0
        ? { ok: false, category: 'model-not-found' }
        : resolved.provider.type === 'codebuddy-subscription' && resolved.provider.codeBuddySite
          ? await this.codeBuddyAccount({ site: resolved.provider.codeBuddySite, action: 'status' })
          : incompatibility || xaiAuthResult
            ? undefined
            : await this.auth.validateProviderAuth(
                resolved.provider,
                settings,
                storedValidationTarget
              )
    const usesCompatibilityTransport = requiresChatCompletionsBridge(resolved.provider, framework)
    // An incompatible pairing no longer replaces the probe: compatibility is a derivable
    // (provider, framework) relationship, not an endpoint-health fact. The probe still runs —
    // framework-agnostic, against the provider's own declared routes (same as Codex) — so a
    // passing test stays valid across framework switches; the mismatch rides along as a flag.
    const validationFrameworkEndpoints = this.validationFrameworkEndpoints(
      resolved.provider,
      settings
    )
    let probeResult =
      xaiAuthResult ??
      localResult ??
      (await validateProviderTarget(validationProvider, {
        fetchImpl: netFetchStandard,
        requireBridgeToolCall: framework.id === 'codex' && usesCompatibilityTransport,
        requireNativeResponsesCompatibility:
          !isXaiSubscriptionProvider(resolved.provider.type) &&
          requiresNativeResponsesCompatibility(resolved.provider, framework),
        frameworkEndpoints: validationFrameworkEndpoints
      }))
    // HTTP is the fast path. Every failed request gets one native attempt, without interpreting
    // upstream status codes or messages. Subscription authentication keeps its existing owner.
    if (
      !probeResult.ok &&
      !incompatibility &&
      !localResult &&
      !xaiAuthResult &&
      (validationProvider.type === 'custom' || validationProvider.type === 'official') &&
      this.options.runAcpValidation
    ) {
      const native = await this.options.runAcpValidation(validationProvider, settings)
      probeResult = native.ok
        ? {
            ...native,
            testedTarget: {
              ...native.testedTarget,
              model: validationProvider.model,
              endpoint: preferredEndpoint(
                validationProvider.apiEndpoints ?? ['messages'],
                validationFrameworkEndpoints ?? DEFAULT_ENDPOINT_ORDER
              )
            }
          }
        : {
            ...probeResult,
            message: `HTTP: ${probeResult.message ?? probeResult.category}${probeResult.status ? ` (${probeResult.status})` : ''}; ACP: ${native.message ?? native.category}`
          }
    }
    const result = incompatibility
      ? {
          ...probeResult,
          frameworkIncompatible: true,
          // A verified endpoint pairs its success with the specific route mismatch; a failed probe
          // keeps its own actionable category message.
          ...(probeResult.ok ? { message: incompatibility } : {})
        }
      : probeResult

    if ((await this.repository.getSettings()).agentFrameworkId !== settings.agentFrameworkId)
      return { ...result, applied: false }

    if (
      resolved.storedId &&
      this.providerValidationGenerations.get(resolved.storedId) !== validationGeneration
    ) {
      return { ...result, applied: false }
    }
    if (result.applied === false) return result
    // Harness capability is projected per framework, never persisted as an account-wide failure.
    if (
      framework.id === 'open-science-agent' &&
      isCodexSubscriptionProvider(resolved.provider.type) &&
      result.frameworkIncompatible
    )
      return result
    if (
      healthPolicy === 'definitive-failures' &&
      (result.ok ||
        !(
          (result.category === 'auth' && (result.status === 401 || result.status === 403)) ||
          result.category === 'model-not-found'
        ))
    )
      return result
    if (!resolved.storedId) return result

    const latestSettings = await this.repository.getSettings()
    const stored = latestSettings.providers.find((provider) => provider.id === resolved.storedId)
    if (!stored) return { ...result, applied: false }
    const model =
      request.model ??
      (latestSettings.activeProviderId === stored.id ? latestSettings.activeModel : undefined)
    const latestResolved = this.resolveProvider(stored, model)
    if (!this.sameValidationTarget(resolved.provider, latestResolved)) {
      return { ...result, applied: false }
    }

    const validationTarget: ProviderValidationTarget | undefined =
      isCodexSubscriptionProvider(resolved.provider.type) ||
      resolved.provider.type === 'claude-isolated'
        ? undefined
        : targetForValidationResult(result, {
            model: resolved.provider.model,
            endpoint: preferredEndpoint(
              resolved.provider.apiEndpoints ?? ['messages'],
              validationFrameworkEndpoints ?? DEFAULT_ENDPOINT_ORDER
            )
          })
    const validationPatch = buildProviderValidationPatch(stored, result, validationTarget)

    if (stored.type === 'claude-shared') {
      if (storedValidationTarget?.type !== 'claude-shared') {
        return { ...result, applied: false }
      }
      const applied = await this.repository.updateClaudeSharedValidationIfUnchanged(
        storedValidationTarget,
        settings.claudeSubscriptionProviderId,
        resolved.provider.model,
        validationPatch
      )
      return { ...result, applied }
    }

    const applied = await this.repository.updateProviderValidationIfTargetMatches(
      stored.id,
      (current, currentSettings) => {
        const currentModel =
          request.model ??
          (currentSettings.activeProviderId === current.id
            ? currentSettings.activeModel
            : undefined)
        return (
          this.providerValidationGenerations.get(current.id) === validationGeneration &&
          currentSettings.agentFrameworkId === settings.agentFrameworkId &&
          current.keyRef === expectedKeyRef &&
          (!result.ok ||
            (current.lastValidatedAt === storedValidationTarget?.lastValidatedAt &&
              isDeepStrictEqual(
                current.lastValidatedTarget,
                storedValidationTarget?.lastValidatedTarget
              ) &&
              isDeepStrictEqual(
                current.lastValidationFailure,
                storedValidationTarget?.lastValidationFailure
              ))) &&
          (healthPolicy !== 'definitive-failures' ||
            (current.lastValidatedAt === storedValidationTarget?.lastValidatedAt &&
              !(
                result.category === 'model-not-found' &&
                current.lastValidationFailure?.category === 'auth' &&
                current.lastValidationFailure.target === undefined
              ))) &&
          (current.configRevision ?? 0) === (storedValidationTarget?.configRevision ?? 0) &&
          this.sameValidationTarget(resolved.provider, this.resolveProvider(current, currentModel))
        )
      },
      result,
      validationTarget
    )
    return { ...result, applied }
  }

  async refreshProviderModels(
    request: RefreshProviderModelsRequest
  ): Promise<RefreshProviderModelsResult> {
    return this.modelCatalog.refresh(request)
  }

  resolveProviderApiEndpoints(provider: StoredProvider, activeModel?: string): ModelProtocol[] {
    return this.runtimeProjection.resolveProviderApiEndpoints(provider, activeModel)
  }

  toProviderView(provider: StoredProvider, activeModel?: string): ProviderView {
    return this.runtimeProjection.toProviderView(provider, activeModel)
  }

  async isProviderKeyUsable(
    provider: StoredProvider,
    frameworkId?: AgentFrameworkId
  ): Promise<boolean | undefined> {
    if (provider.type === 'codebuddy-subscription') {
      const site = codeBuddySiteForId(provider.id)
      if (!site) return false
      return this.codeBuddyAccount({ site, action: 'status' }).then(
        (result) => result.ok,
        () => undefined
      )
    }
    if (isXaiSubscriptionProvider(provider.type)) return this.xai.isUsable()
    if (isLabProvider(provider.type)) return (await this.options.lab?.isUsable()) ?? false
    if (!isCodexSubscriptionProvider(provider.type)) return this.auth.isProviderKeyUsable(provider)
    return this.auth.isProviderKeyUsable(
      provider,
      frameworkId ?? (await this.repository.getSettings()).agentFrameworkId
    )
  }

  resolveActiveModel(provider: StoredProvider | undefined, requested?: string): string | undefined {
    return this.runtimeProjection.resolveActiveModel(provider, requested)
  }

  // Produces an ephemeral backend input without mutating selection or entering authentication;
  // a persisted or explicitly required model must still exist in the current catalog.
  resolveRuntimeTarget(
    storedProvider: StoredProvider,
    selection: RuntimeProviderModelSelection,
    framework: { id: AgentFrameworkId; supportedApiTypes: readonly ModelProtocol[] }
  ): ProviderRuntimeTarget {
    return this.runtimeProjection.resolveRuntimeTarget(storedProvider, selection, framework)
  }

  resolveRuntimeModelCatalog(
    storedProvider: StoredProvider,
    framework: { id: AgentFrameworkId; supportedApiTypes: readonly ModelProtocol[] }
  ): ProviderRuntimeTarget[] {
    return this.runtimeProjection.resolveRuntimeModelCatalog(storedProvider, framework)
  }

  resolveRuntimeReasoningEffortProfile(
    storedProvider: StoredProvider,
    requestedModel?: string
  ): ReasoningEffortProfile {
    return this.runtimeProjection.resolveRuntimeReasoningEffortProfile(
      storedProvider,
      requestedModel
    )
  }

  resolveProvider(provider: StoredProvider, modelOverride?: string): ResolvedProvider {
    return this.runtimeProjection.resolveProvider(provider, modelOverride)
  }

  private resolveDraft(draft: ProviderDraft): ResolvedProvider {
    return resolveProviderDraft(draft)
  }

  // The route-mismatch sentence for a provider the active framework cannot drive, or undefined
  // when the pairing works. Subscription providers never reach this (their auth-status check owns
  // the verdict), so no credential-specific branch is needed here.
  private frameworkIncompatibilityMessage(
    provider: ResolvedProvider,
    framework: ReturnType<typeof getAgentFramework>
  ): string | undefined {
    if (!isModelStreamingCompatible(framework.id, provider.streaming)) {
      return `Not compatible with ${framework.displayName}: this model does not support streaming. Pick another model or switch the agent framework.`
    }
    if (
      isProviderUsableByFramework(
        { apiEndpoints: provider.apiEndpoints, type: provider.type },
        framework
      )
    ) {
      return undefined
    }

    return `Not compatible with ${framework.displayName}: it needs ${framework.supportedApiTypes
      .map((endpoint) => ENDPOINT_PATHS[endpoint])
      .join(' or ')}, but this provider speaks ${providerEndpoints(provider)
      .map((endpoint) => ENDPOINT_PATHS[endpoint])
      .join(' or ')}. Change the API format or switch the agent framework.`
  }

  private sameValidationTarget(left: ResolvedProvider, right: ResolvedProvider): boolean {
    return (
      left.type === right.type &&
      left.codeBuddyAuthMode === right.codeBuddyAuthMode &&
      left.codexAuthMode === right.codexAuthMode &&
      left.codexTransport === right.codexTransport &&
      left.baseUrl === right.baseUrl &&
      left.chatCompletionsBaseUrl === right.chatCompletionsBaseUrl &&
      left.responsesBaseUrl === right.responsesBaseUrl &&
      left.model === right.model &&
      left.key === right.key &&
      (left.apiEndpoints ?? []).join(',') === (right.apiEndpoints ?? []).join(',')
    )
  }

  private advanceProviderValidationGeneration(providerId: string): number {
    const generation = (this.providerValidationGenerations.get(providerId) ?? 0) + 1
    this.providerValidationGenerations.set(providerId, generation)
    return generation
  }

  private createProviderId(): string {
    return `p_${Date.now()}_${this.options.allocateSettingsIdSequence()}`
  }
}

const isXaiRecord = (provider: StoredProvider): boolean => isXaiSubscriptionProvider(provider.type)

export {
  CLAUDE_SHARED_DISCONNECTED_MESSAGE,
  ProviderAccountsModule,
  requiresNativeResponsesCompatibility
}
export type { ProviderAccountsModuleOptions, ProviderRuntimeTarget, RuntimeProviderModelSelection }
