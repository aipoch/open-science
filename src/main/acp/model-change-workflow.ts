import type { AgentModelChangeTarget } from '../agent-framework'

type AcpModelChangeWorkflowOptions = Readonly<{
  canApply: (target: AgentModelChangeTarget) => boolean
  matchesCurrent: (target: AgentModelChangeTarget) => boolean
  isGenerationBusy: () => boolean
  applyTarget: (target: AgentModelChangeTarget) => Promise<boolean>
  requestReconnect: () => Promise<void>
  recoverFailedReconnect: () => void
  reportReconnectFailure: (error: unknown) => void
}>

// Owns the generation-local latest-wins queue and its prompt-admission barrier. Runtime supplies
// target policy and transport application; callers only need to apply, cancel, or signal activity.
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
    if (!this.options.canApply(target)) return false

    if (!this.drainPromise && this.options.matchesCurrent(target)) {
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

      if (!this.options.canApply(target) || !(await this.options.applyTarget(target))) {
        this.pending = undefined
        try {
          await this.options.requestReconnect()
        } catch (error) {
          this.options.reportReconnectFailure(error)
          this.options.recoverFailedReconnect()
        }
        return
      }
    }
  }
}

export { AcpModelChangeWorkflow }
export type { AcpModelChangeWorkflowOptions }
