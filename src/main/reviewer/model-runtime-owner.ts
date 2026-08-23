import { homedir } from 'node:os'

import { releaseResolvedAgentBackendLeases, type ResolvedAgentBackend } from '../agent-framework'
import type {
  AgentBackendResolutionContext,
  ExplicitAgentBackendTarget
} from '../settings/backend-resolver'
import { composeAcpRuntimeBaseOwners } from '../acp/runtime-base-composition'
import { composeAcpRuntimeSessionOwners } from '../acp/runtime-session-composition'
import { AcpRuntime, type AcpRuntimeOptions } from '../acp/runtime'
import type { ReviewerAcpRuntime } from './acp-runtime'

type CapturedReviewerModel = Readonly<{
  model: string
  fixedTarget?: ExplicitAgentBackendTarget
}>

type OwnedReviewerAcpRuntime = ReviewerAcpRuntime & Pick<AcpRuntime, 'shutdownForQuit'>

type ActiveReviewerRuntime = Readonly<{
  runtime: OwnedReviewerAcpRuntime
  close: () => Promise<{ reaped: boolean }>
}>

type ReviewerModelRuntimeAdmission = Readonly<{
  model: string
  reviewerAcpRuntime?: ReviewerAcpRuntime
  release: () => Promise<void>
}>

type ReviewerModelRuntimeOwnerOptions = Readonly<{
  appVersion: string
  captureModel: () => Promise<CapturedReviewerModel>
  resolveTarget: (
    target: ExplicitAgentBackendTarget,
    context: AgentBackendResolutionContext
  ) => Promise<ResolvedAgentBackend>
  createRuntime?: (options: AcpRuntimeOptions) => OwnedReviewerAcpRuntime
}>

const createRuntime = (options: AcpRuntimeOptions): OwnedReviewerAcpRuntime => {
  const base = composeAcpRuntimeBaseOwners(options)
  return new AcpRuntime(options, base, composeAcpRuntimeSessionOwners(options, base))
}

const unavailableRuntime = (error: unknown): ReviewerAcpRuntime => {
  const detail = error instanceof Error ? error.message : String(error)
  const fail = async (): Promise<never> => {
    throw new Error(`The configured Reviewer model is unavailable: ${detail}`)
  }
  return Object.freeze({
    buildReviewerSession: fail,
    disposeReviewerSession: () => ({
      rejectedToolCalls: 0,
      reviewerBridgeScoped: undefined
    }),
    sendPrompt: fail,
    sendApplicationPrompt: fail
  })
}

class ReviewerModelRuntimeOwner {
  private readonly runtimeFactory: NonNullable<ReviewerModelRuntimeOwnerOptions['createRuntime']>
  private readonly activeRuntimes = new Set<ActiveReviewerRuntime>()
  private readonly activeSharedRuntimeAdmissions = new Set<object>()
  private readonly pendingAdmissions = new Set<Promise<void>>()
  private updateGatePromise: Promise<{ reaped: boolean }> | undefined
  private shuttingDown = false

  constructor(private readonly options: ReviewerModelRuntimeOwnerOptions) {
    this.runtimeFactory = options.createRuntime ?? createRuntime
  }

  admit(): Promise<ReviewerModelRuntimeAdmission> {
    if (this.updateGatePromise) {
      return Promise.reject(
        new Error(
          'Reviewer cannot start while an update is preparing to install. Retry if the update does not proceed.'
        )
      )
    }
    const admission = this.admitOwned()
    const settled = admission.then(
      () => undefined,
      () => undefined
    )
    this.pendingAdmissions.add(settled)
    void settled.finally(() => this.pendingAdmissions.delete(settled))
    return admission
  }

  hasActiveWork(): boolean {
    return (
      this.activeRuntimes.size > 0 ||
      this.activeSharedRuntimeAdmissions.size > 0 ||
      this.pendingAdmissions.size > 0
    )
  }

  private async admitOwned(): Promise<ReviewerModelRuntimeAdmission> {
    if (this.shuttingDown) throw new Error('Reviewer model runtime is shutting down.')
    const captured = await this.options.captureModel()
    if (this.shuttingDown) throw new Error('Reviewer model runtime is shutting down.')
    if (!captured.fixedTarget) {
      const admission = Object.freeze({})
      this.activeSharedRuntimeAdmissions.add(admission)
      return Object.freeze({
        model: captured.model,
        release: async () => {
          this.activeSharedRuntimeAdmissions.delete(admission)
        }
      })
    }

    const target = captured.fixedTarget
    let backend: ResolvedAgentBackend
    try {
      backend = await this.options.resolveTarget(target, {
        forcedSkillIds: [],
        systemPromptAppends: [],
        includeBaselineSystemPromptGuidance: false
      })
    } catch (error) {
      if (this.shuttingDown) throw new Error('Reviewer model runtime is shutting down.')
      return Object.freeze({
        model: captured.model,
        reviewerAcpRuntime: unavailableRuntime(error),
        release: async () => undefined
      })
    }
    if (this.shuttingDown) {
      await releaseResolvedAgentBackendLeases(backend)
      throw new Error('Reviewer model runtime is shutting down.')
    }

    let claimed = false
    let runtime: OwnedReviewerAcpRuntime
    try {
      runtime = this.runtimeFactory({
        appVersion: this.options.appVersion,
        defaultCwd: homedir(),
        resolveBackend: () => {
          if (claimed) {
            throw new Error('The admitted Reviewer backend connection is no longer available.')
          }
          claimed = true
          return backend
        }
      })
    } catch (error) {
      await releaseResolvedAgentBackendLeases(backend)
      throw error
    }

    let closePromise: Promise<{ reaped: boolean }> | undefined
    const active: ActiveReviewerRuntime = Object.freeze({
      runtime,
      close: () => {
        closePromise ??= (async () => {
          try {
            return await runtime.shutdownForQuit()
          } finally {
            if (!claimed) await releaseResolvedAgentBackendLeases(backend)
          }
        })()
        return closePromise
      }
    })
    this.activeRuntimes.add(active)
    return Object.freeze({
      model: captured.model,
      reviewerAcpRuntime: runtime,
      release: async () => {
        if (!this.activeRuntimes.has(active)) return
        try {
          await active.close()
        } finally {
          this.activeRuntimes.delete(active)
        }
      }
    })
  }

  shutdownForUpdateGate(): Promise<{ reaped: boolean }> {
    if (this.shuttingDown) return this.shutdown()
    if (this.updateGatePromise) return this.updateGatePromise

    const gate = this.closeActiveRuntimes()
    this.updateGatePromise = gate
    void gate.finally(() => {
      if (this.updateGatePromise === gate) this.updateGatePromise = undefined
    })
    return gate
  }

  async shutdown(): Promise<{ reaped: boolean }> {
    this.shuttingDown = true
    const updateGateOutcome = await this.updateGatePromise
    const activeOutcome = await this.closeActiveRuntimes()
    return {
      reaped: (updateGateOutcome?.reaped ?? true) && activeOutcome.reaped
    }
  }

  private async closeActiveRuntimes(): Promise<{ reaped: boolean }> {
    await Promise.all([...this.pendingAdmissions])
    const runtimes = [...this.activeRuntimes]
    let outcomes: PromiseSettledResult<{ reaped: boolean }>[] = []
    try {
      outcomes = await Promise.allSettled(runtimes.map((runtime) => runtime.close()))
    } finally {
      for (const runtime of runtimes) this.activeRuntimes.delete(runtime)
    }
    return {
      reaped: outcomes.every(
        (outcome) => outcome.status === 'fulfilled' && outcome.value.reaped === true
      )
    }
  }
}

export { ReviewerModelRuntimeOwner }
export type {
  CapturedReviewerModel,
  ReviewerModelRuntimeAdmission,
  ReviewerModelRuntimeOwnerOptions
}
