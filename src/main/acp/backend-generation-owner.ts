import type { ModelReasoningEffort, ResolvedReasoningEffort } from '../../shared/reasoning-effort'
import type {
  AgentFramework,
  AgentModelChangeTarget,
  AgentModelRoute,
  ResolvedAgentBackend
} from '../agent-framework'

type AcpBackendGenerationAttemptIdentity = Readonly<{
  epoch: number
  assertCurrent: () => void
}>

export type AcpBackendGenerationView = Readonly<{
  framework: AgentFramework
  providerId?: string
  backendId?: string
  modelRoute?: AgentModelRoute
  providerContinuityToken?: string
  session: Readonly<{
    model?: string
    modelRequired: boolean
    effort?: ModelReasoningEffort
    options?: Readonly<Record<string, unknown>>
  }>
  prompt: Readonly<{
    systemPromptAppends: readonly string[]
    persistentSystemPrompt?: string
  }>
  context: Readonly<{
    window?: number
    model?: string
    supportsImageInput: boolean
  }>
  adapter: Readonly<{
    claudeConfigDir?: string
    codexHome?: string
    nativeMcpEnabled: boolean
    bridgeMcpAliasesEnabled: boolean
  }>
}>

type PreparedAttempt = {
  identity: AcpBackendGenerationAttemptIdentity
  view: AcpBackendGenerationView
  initializeMaterial: AcpBackendInitializeMaterial | undefined
  openCodeUsageApi: AcpOpenCodeUsageApi | undefined
  published: boolean
  failed: boolean
}

export type AcpBackendInitializeMaterial = Readonly<{
  authentication?: ResolvedAgentBackend['authentication']
  providerConfiguration?: ResolvedAgentBackend['providerConfiguration']
}>

export type AcpOpenCodeUsageApi = Readonly<NonNullable<ResolvedAgentBackend['opencodeUsageApi']>>

export type AcpBackendGenerationAttempt = Readonly<{
  publish: () => AcpBackendGenerationView
  consumeInitializeMaterial: () => AcpBackendInitializeMaterial | undefined
  fail: () => void
}>

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

const generationView = (backend: ResolvedAgentBackend): AcpBackendGenerationView => {
  const claudeConfigDir =
    backend.framework.id === 'claude-code' && backend.env.CLAUDE_CONFIG_DIR?.trim()
      ? backend.env.CLAUDE_CONFIG_DIR
      : undefined
  const codexHome =
    backend.framework.id === 'codex' && typeof backend.env.CODEX_HOME === 'string'
      ? backend.env.CODEX_HOME
      : undefined
  const bridgeMcpAliasesEnabled =
    backend.framework.id === 'codex' && backend.providerConfiguration !== undefined

  return Object.freeze({
    framework: backend.framework,
    ...(backend.providerId ? { providerId: backend.providerId } : {}),
    ...(backend.backendId ? { backendId: backend.backendId } : {}),
    ...(backend.modelRoute ? { modelRoute: backend.modelRoute } : {}),
    ...(backend.providerContinuityToken
      ? { providerContinuityToken: backend.providerContinuityToken }
      : {}),
    session: Object.freeze({
      ...(backend.sessionModel ? { model: backend.sessionModel } : {}),
      modelRequired: backend.sessionModelRequired ?? false,
      ...(backend.sessionEffort ? { effort: backend.sessionEffort } : {}),
      ...(backend.sessionOptions
        ? { options: deepFreeze(structuredClone(backend.sessionOptions)) }
        : {})
    }),
    prompt: Object.freeze({
      systemPromptAppends: Object.freeze([...(backend.systemPromptAppends ?? [])]),
      ...(backend.persistentSystemPrompt
        ? { persistentSystemPrompt: backend.persistentSystemPrompt }
        : {})
    }),
    context: Object.freeze({
      ...(backend.contextWindow ? { window: backend.contextWindow } : {}),
      ...(backend.contextUsageModel ? { model: backend.contextUsageModel } : {}),
      supportsImageInput: backend.supportsImageInput === true
    }),
    adapter: Object.freeze({
      ...(claudeConfigDir ? { claudeConfigDir } : {}),
      ...(codexHome ? { codexHome } : {}),
      nativeMcpEnabled: backend.framework.id !== 'codex' || !bridgeMcpAliasesEnabled,
      bridgeMcpAliasesEnabled
    })
  })
}

// Owns one runtime generation's derived backend behavior. Attempt material remains provisional until
// the corresponding connection attempt proves current and publishes the complete secret-free view.
export class AcpBackendGenerationOwner {
  private currentView: AcpBackendGenerationView
  private prepared: PreparedAttempt | undefined
  private currentOpenCodeUsageApi: AcpOpenCodeUsageApi | undefined

  constructor(initialFramework: AgentFramework) {
    this.currentView = generationView({
      framework: initialFramework,
      executablePath: '',
      env: {}
    })
  }

  get current(): AcpBackendGenerationView {
    return this.currentView
  }

  openCodeUsageApi(): AcpOpenCodeUsageApi | undefined {
    return this.currentOpenCodeUsageApi
  }

  supersede(throughEpoch: number): void {
    if (this.prepared && this.prepared.identity.epoch <= throughEpoch) {
      this.clearAttempt(this.prepared)
    }
  }

  updateReasoningEffort(effort: ResolvedReasoningEffort): AcpBackendGenerationView {
    const session = { ...this.currentView.session }
    if (effort === 'default') delete session.effort
    else session.effort = effort
    this.currentView = Object.freeze({
      ...this.currentView,
      session: Object.freeze(session)
    })
    return this.currentView
  }

  updateModel(target: AgentModelChangeTarget): AcpBackendGenerationView {
    const session = {
      ...this.currentView.session,
      model: target.sessionModel,
      modelRequired: target.sessionModelRequired
    }
    if (target.reasoningEffort === 'default') delete session.effort
    else session.effort = target.reasoningEffort
    this.currentView = Object.freeze({
      ...this.currentView,
      providerId: target.providerId,
      backendId: target.backendId,
      modelRoute: target.route,
      session: Object.freeze(session),
      context: Object.freeze({
        model: target.model,
        ...(target.contextWindow ? { window: target.contextWindow } : {}),
        supportsImageInput: target.supportsImageInput
      })
    })
    return this.currentView
  }

  prepare(
    identity: AcpBackendGenerationAttemptIdentity,
    backend: ResolvedAgentBackend
  ): AcpBackendGenerationAttempt {
    identity.assertCurrent()
    if (this.prepared) this.clearAttempt(this.prepared)
    const initializeMaterial =
      backend.authentication || backend.providerConfiguration
        ? Object.freeze({
            ...(backend.authentication ? { authentication: backend.authentication } : {}),
            ...(backend.providerConfiguration
              ? { providerConfiguration: backend.providerConfiguration }
              : {})
          })
        : undefined
    const prepared: PreparedAttempt = {
      identity,
      view: generationView(backend),
      initializeMaterial,
      openCodeUsageApi: backend.opencodeUsageApi
        ? Object.freeze({ ...backend.opencodeUsageApi })
        : undefined,
      published: false,
      failed: false
    }
    this.prepared = prepared

    return Object.freeze({
      publish: () => {
        this.assertCurrent(prepared)
        this.currentView = prepared.view
        this.currentOpenCodeUsageApi = prepared.openCodeUsageApi
        prepared.openCodeUsageApi = undefined
        prepared.published = true
        return this.currentView
      },
      consumeInitializeMaterial: () => {
        if (prepared.failed) return undefined
        this.assertCurrent(prepared)
        if (!prepared.published) throw new Error('ACP backend generation is not published.')
        const material = prepared.initializeMaterial
        prepared.initializeMaterial = undefined
        return material
      },
      fail: () => this.clearAttempt(prepared)
    })
  }

  private assertCurrent(prepared: PreparedAttempt): void {
    try {
      prepared.identity.assertCurrent()
      if (this.prepared === prepared) return
    } catch (error) {
      this.clearAttempt(prepared)
      throw error
    }
    this.clearAttempt(prepared)
    throw new Error('ACP backend generation was superseded.')
  }

  private clearAttempt(prepared: PreparedAttempt): void {
    prepared.initializeMaterial = undefined
    prepared.openCodeUsageApi = undefined
    prepared.failed = true
    if (prepared.published && this.prepared === prepared) {
      this.currentOpenCodeUsageApi = undefined
    }
    if (this.prepared === prepared) this.prepared = undefined
  }
}
