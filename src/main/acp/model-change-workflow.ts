import * as acp from '@agentclientprotocol/sdk'
import type { ActiveSession, SessionConfigOption } from '@agentclientprotocol/sdk'

import type { AcpStateSnapshot } from '../../shared/acp'
import type { ResolvedReasoningEffort } from '../../shared/reasoning-effort'
import type { AgentModelChangeTarget } from '../agent-framework'
import { createLogger, diagnosticErrorFields } from '../logger'
import type { AcpBackendGenerationOwner } from './backend-generation-owner'
import type { AcpConnectionResourceOwner } from './connection-resource-owner'
import type { ContextUsageTracker, SessionEstimateInput } from './context-usage-tracker'
import { matchSessionModelOption, resolveSessionEffortOption } from './session-config'
import type { AcpSessionConfigurator } from './session-configurator'
import type { AcpSessionRegistry } from './session-registry'

const log = createLogger('acp')

type AcpModelChangeWorkflowOptions = Readonly<{
  backendGeneration: Pick<
    AcpBackendGenerationOwner,
    'current' | 'updateModel' | 'updateReasoningEffort'
  >
  connectionResources: Pick<
    AcpConnectionResourceOwner,
    | 'epoch'
    | 'connection'
    | 'isShuttingDown'
    | 'anthropicBridgeAvailable'
    | 'providerTransportAvailable'
    | 'assertCurrentConnection'
    | 'setProviderTransportTarget'
    | 'setAnthropicBridgeTarget'
    | 'setBridgeModelTarget'
    | 'setBridgeReasoningEffort'
  >
  registry: Pick<AcpSessionRegistry, 'entries' | 'lookup'>
  configurator: Pick<AcpSessionConfigurator, 'applyLiveEffort'>
  contextUsage: Pick<ContextUsageTracker, 'clear' | 'beginSession'>
  currentStatus: () => AcpStateSnapshot['status']
  providerReconnectPending: () => boolean
  isGenerationBusy: () => boolean
  contextEstimateInput: (sessionId: string) => SessionEstimateInput
  hasReplayableImageHistory?: (projectId: string, sessionId: string) => Promise<boolean>
  emitState: () => void
  requestReconnect: () => Promise<void>
  recoverFailedReconnect: (disconnectedGeneration: number) => void
  reportReconnectFailure: (error: unknown) => void
  diagnosticContext: () => Readonly<Record<string, unknown>>
}>

// Owns generation-local model/effort policy, the latest-wins queue, transport application, and the
// prompt-admission barrier; callers only apply, cancel, or signal activity.
class AcpModelChangeWorkflow {
  private pending: AgentModelChangeTarget | undefined
  private barrierPromise: Promise<void> | undefined
  private resolveBarrier: (() => void) | undefined
  private drainPromise: Promise<void> | undefined

  constructor(private readonly options: AcpModelChangeWorkflowOptions) {}

  get barrier(): Promise<void> | undefined {
    return this.barrierPromise
  }

  async apply(target: AgentModelChangeTarget): Promise<boolean> {
    if (!this.canApply(target)) return false

    if (!this.drainPromise && this.matchesCurrent(target)) {
      this.cancel()
      return true
    }

    this.pending = target
    this.armBarrier()
    if (this.options.isGenerationBusy()) return true

    await this.drain()
    return true
  }

  activityChanged(): void {
    if (this.pending && !this.options.isGenerationBusy()) void this.drain()
  }

  cancel(): void {
    this.pending = undefined
    if (!this.drainPromise) this.completeBarrier()
  }

  async cancelAndDrain(): Promise<void> {
    this.cancel()
    await this.drainPromise
  }

  async applyReasoningEffort(effort: ResolvedReasoningEffort): Promise<boolean> {
    const barrier = this.barrier
    if (barrier) {
      await barrier
      return this.applyReasoningEffort(effort)
    }

    // The incoming effort belongs to the provider/model waiting behind reconnect, not the old
    // generation that is still published while its in-flight turn drains.
    if (this.options.providerReconnectPending()) return false

    const backend = this.options.backendGeneration.updateReasoningEffort(effort)
    this.options.connectionResources.setBridgeReasoningEffort(backend.session.effort)
    const connection = this.options.connectionResources.connection
    if (!connection) return backend.framework.supportsLiveEffortChange

    const facts = await this.options.configurator.applyLiveEffort({
      backend,
      connection,
      effort,
      sessions: this.activeSessions().map(([appSessionId, session]) => ({
        session,
        configOptions:
          (this.options.registry.lookup(appSessionId)?.aggregate.snapshot().configOptions as
            readonly SessionConfigOption[] | undefined) ??
          (session as { newSessionResponse?: { configOptions?: SessionConfigOption[] | null } })
            .newSessionResponse?.configOptions,
        assertCurrent: () => {
          if (this.activeSession(appSessionId) !== session) {
            throw new Error('ACP session startup was superseded.')
          }
        }
      }))
    })
    return !facts.reconnectRequired
  }

  private armBarrier(): void {
    if (this.barrierPromise) return
    this.barrierPromise = new Promise<void>((resolve) => {
      this.resolveBarrier = resolve
    })
  }

  private completeBarrier(): void {
    const resolve = this.resolveBarrier
    this.barrierPromise = undefined
    this.resolveBarrier = undefined
    resolve?.()
  }

  private drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise

    const drain = this.drainQueue()
    this.drainPromise = drain
    const finalize = (): void => {
      if (this.drainPromise !== drain) return
      this.drainPromise = undefined
      if (this.pending && !this.options.isGenerationBusy()) {
        void this.drain()
      } else if (!this.pending) {
        this.completeBarrier()
      }
    }
    void drain.then(finalize, finalize)
    return drain
  }

  private async drainQueue(): Promise<void> {
    while (this.pending && !this.options.isGenerationBusy()) {
      const target = this.pending
      this.pending = undefined

      if (!this.canApply(target) || !(await this.applyTarget(target))) {
        this.pending = undefined
        const disconnectedGeneration = this.options.connectionResources.epoch
        try {
          await this.options.requestReconnect()
        } catch (error) {
          this.options.reportReconnectFailure(error)
          this.options.recoverFailedReconnect(disconnectedGeneration)
        }
        return
      }
    }
  }

  private canApply(target: AgentModelChangeTarget): boolean {
    const backend = this.options.backendGeneration.current
    const resources = this.options.connectionResources
    const backendCompatible =
      backend.backendId === target.backendId ||
      (backend.framework.id === 'claude-code' &&
        target.route === 'claude-anthropic' &&
        target.anthropicBridgeTargetId !== undefined &&
        resources.anthropicBridgeAvailable) ||
      (target.providerTransportTargetId !== undefined && resources.providerTransportAvailable)
    return (
      !resources.isShuttingDown &&
      !this.options.providerReconnectPending() &&
      this.options.currentStatus() === 'connected' &&
      resources.connection !== undefined &&
      this.activeSessions().length > 0 &&
      backend.framework.id === target.frameworkId &&
      backendCompatible &&
      backend.modelRoute === target.route
    )
  }

  private matchesCurrent(target: AgentModelChangeTarget): boolean {
    const backend = this.options.backendGeneration.current
    return (
      backend.backendId === target.backendId &&
      backend.providerId === target.providerId &&
      backend.context.model === target.model &&
      backend.session.model === target.sessionModel &&
      backend.context.supportsImageInput === target.supportsImageInput &&
      (backend.session.effort ?? 'default') === target.reasoningEffort
    )
  }

  private async applyTarget(target: AgentModelChangeTarget): Promise<boolean> {
    const connection = this.options.connectionResources.connection
    if (!connection) return false
    const backend = this.options.backendGeneration.current
    // ACP Sessions retain provider-side context that the host cannot inspect. Crossing the image
    // capability boundary requires a fresh Session only when canonical history contains images;
    // without replayable image history, the native and evidence projections are equivalent.
    if (
      backend.context.supportsImageInput !== target.supportsImageInput &&
      (await this.hasReplayableImageHistory())
    ) {
      return false
    }
    if (
      backend.framework.id === 'codex' &&
      target.route !== 'codex-bridge' &&
      backend.backendId !== target.backendId &&
      backend.session.model === target.sessionModel
    ) {
      return false
    }
    try {
      if (
        target.providerTransportTargetId &&
        !this.options.connectionResources.setProviderTransportTarget(
          target.providerTransportTargetId
        )
      ) {
        return false
      }
      if (
        target.anthropicBridgeTargetId &&
        !this.options.connectionResources.setAnthropicBridgeTarget(target.anthropicBridgeTargetId)
      ) {
        return false
      }
      if (
        target.bridge &&
        !this.options.connectionResources.setBridgeModelTarget({
          ...target.bridge,
          ...(target.reasoningEffort === 'default'
            ? { reasoningEffort: undefined }
            : { reasoningEffort: target.reasoningEffort })
        })
      ) {
        return false
      }

      const results = new Map<
        string,
        { appliedModel: string; configOptions: SessionConfigOption[] | null | undefined }
      >()
      for (const [appSessionId, session] of this.activeSessions()) {
        const priorOptions =
          (this.options.registry.lookup(appSessionId)?.aggregate.snapshot().configOptions as
            readonly SessionConfigOption[] | undefined) ??
          (session as { newSessionResponse?: { configOptions?: SessionConfigOption[] | null } })
            .newSessionResponse?.configOptions
        let configOptions: SessionConfigOption[] | null | undefined = priorOptions
          ? structuredClone([...priorOptions])
          : priorOptions
        let appliedModel = target.sessionModel

        if (target.route !== 'codex-bridge') {
          const selection = matchSessionModelOption(configOptions, target.sessionModel)
          if (!selection) return false
          appliedModel = selection.value

          if (!selection.alreadyCurrent) {
            this.options.connectionResources.assertCurrentConnection(connection)
            const response = (await connection.agent.request(
              acp.methods.agent.session.setConfigOption,
              {
                sessionId: session.sessionId,
                configId: selection.configId,
                value: selection.value
              }
            )) as { configOptions?: SessionConfigOption[] | null }
            configOptions = response?.configOptions ?? configOptions
          }

          const shouldApplyEffort =
            backend.framework.supportsLiveEffortChange &&
            (target.reasoningEffort !== 'default' || backend.session.effort !== undefined)
          if (shouldApplyEffort) {
            const effortSelection = resolveSessionEffortOption(
              configOptions,
              target.reasoningEffort,
              backend.framework.adaptSessionEffort
            )
            if (!effortSelection) return false
            const response = (await connection.agent.request(
              acp.methods.agent.session.setConfigOption,
              {
                sessionId: session.sessionId,
                configId: effortSelection.configId,
                value: effortSelection.value
              }
            )) as { configOptions?: SessionConfigOption[] | null }
            configOptions = response?.configOptions ?? configOptions
          }
        }
        results.set(appSessionId, { appliedModel, configOptions })
      }

      this.options.connectionResources.assertCurrentConnection(connection)
      this.options.backendGeneration.updateModel(target)
      for (const [appSessionId, result] of results) {
        this.options.registry
          .lookup(appSessionId)
          ?.aggregate.updateModel(result.appliedModel, result.configOptions, target.backendId)
      }
      this.options.contextUsage.clear()
      for (const appSessionId of results.keys()) {
        if (this.activeSession(appSessionId)) {
          this.options.contextUsage.beginSession(
            appSessionId,
            this.options.contextEstimateInput(appSessionId)
          )
        }
      }
      this.options.emitState()
      log.info('session model change applied', this.options.diagnosticContext())
      return true
    } catch (error) {
      log.warn('live session model change failed', {
        ...diagnosticErrorFields(error),
        ...this.options.diagnosticContext()
      })
      return false
    }
  }

  private async hasReplayableImageHistory(): Promise<boolean> {
    const inspect = this.options.hasReplayableImageHistory
    if (!inspect) return true
    for (const [sessionId] of this.activeSessions()) {
      const projectId = this.options.registry.lookup(sessionId)?.aggregate.snapshot().projectId
      if (!projectId) return true
      try {
        if (await inspect(projectId, sessionId)) return true
      } catch {
        // An unavailable durable projection cannot safely prove both capability projections equal.
        return true
      }
    }
    return false
  }

  private activeSession(appSessionId: string): ActiveSession | undefined {
    return this.options.registry.lookup(appSessionId)?.attachment?.session
  }

  private activeSessions(): Array<readonly [string, ActiveSession]> {
    return this.options.registry
      .entries(true)
      .flatMap(({ appSessionId, attachment }) =>
        attachment ? [[appSessionId, attachment.session] as const] : []
      )
  }
}

export { AcpModelChangeWorkflow }
export type { AcpModelChangeWorkflowOptions }
