type PreviewLeaveAction = () => boolean | void
type PreviewLeaveGuard = (action: PreviewLeaveAction) => boolean

class PreviewLeaveGuardCoordinator {
  private readonly guards = new Map<string, PreviewLeaveGuard>()
  private approvedScope: string | undefined

  register(scope: string, guard: PreviewLeaveGuard): () => void {
    this.guards.set(scope, guard)
    return () => {
      if (this.guards.get(scope) === guard) this.guards.delete(scope)
    }
  }

  request(scope: string | undefined, action: PreviewLeaveAction): boolean {
    if (scope && scope === this.approvedScope) {
      this.approvedScope = undefined
      return action() !== false
    }
    const guard = scope ? this.guards.get(scope) : undefined
    if (guard && !guard(action)) return false
    return action() !== false
  }

  runApproved(scope: string | undefined, action: PreviewLeaveAction): boolean {
    const previousApprovedScope = this.approvedScope
    this.approvedScope = scope
    try {
      return action() !== false
    } finally {
      this.approvedScope = previousApprovedScope
    }
  }

  clear(): void {
    this.guards.clear()
    this.approvedScope = undefined
  }
}

const workbenchPreviewGuardScope = (
  projectId: string | undefined,
  itemId: string | undefined
): string | undefined => (projectId && itemId ? `workbench:${projectId}:${itemId}` : undefined)

const dialogPreviewGuardScope = (
  projectId: string | undefined,
  itemId: string | undefined
): string | undefined => (itemId ? `dialog:${projectId ?? ''}:${itemId}` : undefined)

const previewLeaveGuards = new PreviewLeaveGuardCoordinator()

export { dialogPreviewGuardScope, previewLeaveGuards, workbenchPreviewGuardScope }
