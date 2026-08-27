type ReviewerProjectAdmission = Readonly<{
  signal: AbortSignal
  abort: () => void
  release: () => void
}>

type ActiveReviewerOperation = Readonly<{
  signalAbort: () => void
  settled: Promise<void>
}>

// Owns Project-scoped Reviewer admission independently from the command adapter. It is constructed
// before deletion recovery starts, so a restored durable intent can fence Reviewer commands even
// before the Reviewer model/runtime composition is available.
class ReviewerProjectRuntimeOwner {
  private readonly deletingProjectIds = new Set<string>()
  private readonly activeByProject = new Map<string, Map<symbol, ActiveReviewerOperation>>()

  admit(projectId: string): ReviewerProjectAdmission {
    if (this.deletingProjectIds.has(projectId)) {
      throw new Error('Project is being deleted.')
    }

    const token = Symbol('reviewer-project-operation')
    const controller = new AbortController()
    let settle!: () => void
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const active = this.activeByProject.get(projectId) ?? new Map()
    active.set(token, { signalAbort: () => controller.abort(), settled })
    this.activeByProject.set(projectId, active)

    let released = false
    return Object.freeze({
      signal: controller.signal,
      abort: () => controller.abort(),
      release: () => {
        if (released) return
        released = true
        active.delete(token)
        if (active.size === 0 && this.activeByProject.get(projectId) === active) {
          this.activeByProject.delete(projectId)
        }
        settle()
      }
    })
  }

  isProjectBusy(projectId: string): boolean {
    return (this.activeByProject.get(projectId)?.size ?? 0) > 0
  }

  async quiesceProject(projectId: string): Promise<void> {
    this.restoreProjectDeletion(projectId)
    for (;;) {
      const active = Array.from(this.activeByProject.get(projectId)?.values() ?? [])
      if (active.length === 0) return
      for (const operation of active) operation.signalAbort()
      await Promise.all(active.map((operation) => operation.settled))
    }
  }

  restoreProjectDeletion(projectId: string): void {
    this.deletingProjectIds.add(projectId)
  }

  releaseProjectDeletion(projectId: string): void {
    this.deletingProjectIds.delete(projectId)
  }
}

export { ReviewerProjectRuntimeOwner }
export type { ReviewerProjectAdmission }
