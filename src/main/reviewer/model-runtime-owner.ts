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
  close: () => Promise<void>
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
    sendPrompt: fail
  })
}

class ReviewerModelRuntimeOwner {
  private readonly runtimeFactory: NonNullable<ReviewerModelRuntimeOwnerOptions['createRuntime']>
  private readonly activeRuntimes = new Set<ActiveReviewerRuntime>()
  private readonly pendingAdmissions = new Set<Promise<void>>()
  private shuttingDown = false

  constructor(private readonly options: ReviewerModelRuntimeOwnerOptions) {
    this.runtimeFactory = options.createRuntime ?? createRuntime
  }

  admit(): Promise<ReviewerModelRuntimeAdmission> {
    const admission = this.admitOwned()
    const settled = admission.then(
      () => undefined,
      () => undefined
    )
    this.pendingAdmissions.add(settled)
    void settled.finally(() => this.pendingAdmissions.delete(settled))
    return admission
  }

  private async admitOwned(): Promise<ReviewerModelRuntimeAdmission> {
    if (this.shuttingDown) throw new Error('Reviewer model runtime is shutting down.')
    const captured = await this.options.captureModel()
    if (this.shuttingDown) throw new Error('Reviewer model runtime is shutting down.')
    if (!captured.fixedTarget) {
      return Object.freeze({ model: captured.model, release: async () => undefined })
    }

    const target = captured.fixedTarget
    let backend: ResolvedAgentBackend
    try {
      backend = await this.options.resolveTarget(target, {
        forcedSkillIds: [],
        systemPromptAppends: []
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

    let closePromise: Promise<void> | undefined
    const active: ActiveReviewerRuntime = Object.freeze({
      runtime,
      close: () => {
        closePromise ??= (async () => {
          try {
            await runtime.shutdownForQuit()
          } finally {
            if (!claimed) await releaseResolvedAgentBackendLeases(backend)
          }
        })()
        return closePromise
      }
    })
    this.activeRuntimes.add(active)
    return Object.freeze({
      model: backend.contextUsageModel ?? captured.model,
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

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    await Promise.all([...this.pendingAdmissions])
    const runtimes = [...this.activeRuntimes]
    try {
      await Promise.all(runtimes.map((runtime) => runtime.close()))
    } finally {
      for (const runtime of runtimes) this.activeRuntimes.delete(runtime)
    }
  }
}

export { ReviewerModelRuntimeOwner }
export type {
  CapturedReviewerModel,
  ReviewerModelRuntimeAdmission,
  ReviewerModelRuntimeOwnerOptions
}
