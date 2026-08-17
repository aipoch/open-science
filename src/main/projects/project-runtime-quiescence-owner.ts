type ProjectAcpRuntime = {
  listSessionIds(): readonly string[]
  liveSessionProjectId(sessionId: string): string | undefined
  deleteSession(sessionId: string): Promise<unknown>
}

type ProjectDelegationRuntime = {
  deleteProject(projectId: string): Promise<void>
}

type ProjectNotebookRuntime = {
  shutdownProject(projectId: string): Promise<unknown>
}

type ProjectReviewerRuntime = {
  quiesceProject(projectId: string): Promise<void>
}

type ProjectSideChatRuntime = {
  invalidateProject(projectId: string): Promise<void>
}

type ProjectComputeRuntime = {
  reconcileProject(projectId: string): Promise<void>
}

type ProjectRuntimeQuiescenceOptions = {
  acp: ProjectAcpRuntime
  delegation: ProjectDelegationRuntime
  notebook: ProjectNotebookRuntime
  reviewer: ProjectReviewerRuntime
  sideChat: ProjectSideChatRuntime
  compute: ProjectComputeRuntime
}

// Owns the single fail-closed runtime boundary that every Project deletion entry crosses after its
// durable intent is written and before Project/Session authority is removed. Each subsystem is
// attempted even when another teardown fails; aggregate rejection retains the intent for recovery.
class ProjectRuntimeQuiescenceOwner {
  constructor(private readonly options: ProjectRuntimeQuiescenceOptions) {}

  async quiesceProject(projectId: string): Promise<void> {
    const failures: unknown[] = []

    // Reviewer owns fire-and-forget ACP/MCP work and correction loops outside the primary ACP Session
    // index. Fence and drain it before the first ACP ownership snapshot so it cannot publish a late
    // reviewer or correction Session while Project teardown is already in progress.
    await this.capture(failures, () => this.options.reviewer.quiesceProject(projectId))
    const acpSessionIds = this.projectAcpSessionIds(projectId, failures)
    await this.capture(failures, () => this.options.sideChat.invalidateProject(projectId))
    await this.captureAll(
      failures,
      [...acpSessionIds].map((sessionId) => () => this.options.acp.deleteSession(sessionId))
    )
    // ACP teardown and Notebook shutdown close both sources of new delegated work. Delete the
    // authoritative Project workspace only after those drains so cached, late, and dormant Frame
    // state are covered together.
    await this.capture(failures, () => this.options.notebook.shutdownProject(projectId))
    await this.capture(failures, () => this.options.delegation.deleteProject(projectId))
    const remainingAcpSessionIds = this.projectAcpSessionIds(projectId, failures)
    await this.captureAll(
      failures,
      [...remainingAcpSessionIds].map(
        (sessionId) => () => this.options.acp.deleteSession(sessionId)
      )
    )
    await this.capture(failures, () => this.options.compute.reconcileProject(projectId))

    if (failures.length > 0) {
      throw new AggregateError(failures, 'Project runtime cleanup failed: ' + projectId)
    }
  }

  private projectAcpSessionIds(projectId: string, failures: unknown[]): Set<string> {
    try {
      return new Set(
        this.options.acp
          .listSessionIds()
          .filter((sessionId) => this.options.acp.liveSessionProjectId(sessionId) === projectId)
      )
    } catch (error) {
      failures.push(error)
      return new Set()
    }
  }

  private async capture(failures: unknown[], operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation()
    } catch (error) {
      failures.push(error)
    }
  }

  private async captureAll(
    failures: unknown[],
    operations: readonly (() => Promise<unknown>)[]
  ): Promise<void> {
    const results = await Promise.allSettled(
      operations.map((operation) => Promise.resolve().then(operation))
    )
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason)
    }
  }
}

export { ProjectRuntimeQuiescenceOwner }
export type {
  ProjectAcpRuntime,
  ProjectComputeRuntime,
  ProjectDelegationRuntime,
  ProjectNotebookRuntime,
  ProjectReviewerRuntime,
  ProjectRuntimeQuiescenceOptions,
  ProjectSideChatRuntime
}
