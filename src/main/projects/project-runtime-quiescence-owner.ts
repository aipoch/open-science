type ProjectAcpRuntime = {
  listSessionIds(): readonly string[]
  liveSessionProjectId(sessionId: string): string | undefined
  deleteSession(sessionId: string): Promise<unknown>
}

type ProjectDelegationRuntime = {
  listActiveSessions(): readonly { projectId: string; sessionId: string }[]
  deleteSession(sessionId: string): Promise<void>
}

type ProjectNotebookRuntime = {
  shutdownProject(projectId: string): Promise<unknown>
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
  sideChat: ProjectSideChatRuntime
  compute: ProjectComputeRuntime
}

// Owns the single fail-closed runtime boundary that every Project deletion entry must cross before
// durable deletion begins. Each subsystem is attempted even when another teardown fails, while the
// aggregate rejection keeps Project and Session authority intact for an explicit retry.
class ProjectRuntimeQuiescenceOwner {
  constructor(private readonly options: ProjectRuntimeQuiescenceOptions) {}

  async quiesceProject(projectId: string): Promise<void> {
    const failures: unknown[] = []
    const acpSessionIds = this.projectAcpSessionIds(projectId, failures)
    const delegatedSessionIds = this.projectDelegatedSessionIds(projectId, failures).filter(
      (sessionId) => !acpSessionIds.has(sessionId)
    )

    await this.capture(failures, () => this.options.sideChat.invalidateProject(projectId))
    await this.captureAll(
      failures,
      [...acpSessionIds].map((sessionId) => () => this.options.acp.deleteSession(sessionId))
    )
    await this.captureAll(
      failures,
      delegatedSessionIds.map((sessionId) => () => this.options.delegation.deleteSession(sessionId))
    )
    await this.capture(failures, () => this.options.notebook.shutdownProject(projectId))
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

  private projectDelegatedSessionIds(projectId: string, failures: unknown[]): string[] {
    try {
      return [
        ...new Set(
          this.options.delegation
            .listActiveSessions()
            .filter((session) => session.projectId === projectId)
            .map((session) => session.sessionId)
        )
      ]
    } catch (error) {
      failures.push(error)
      return []
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
  ProjectRuntimeQuiescenceOptions,
  ProjectSideChatRuntime
}
