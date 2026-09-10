type PreviewLeaveAction = () => boolean | void
type PreviewLeaveGuard = (action: PreviewLeaveAction) => boolean

class PreviewLeaveGuardCoordinator {
  private readonly guards = new Map<string, { guard: PreviewLeaveGuard; isDirty: () => boolean }>()
  private approvedScope: string | undefined

  register(
    scope: string,
    guard: PreviewLeaveGuard,
    isDirty: () => boolean = () => false
  ): () => void {
    this.guards.set(scope, { guard, isDirty })
    return () => {
      if (this.guards.get(scope)?.guard === guard) this.guards.delete(scope)
    }
  }

  request(scope: string | undefined, action: PreviewLeaveAction): boolean {
    if (scope && scope === this.approvedScope) {
      this.approvedScope = undefined
      return action() !== false
    }
    const guard = scope ? this.guards.get(scope)?.guard : undefined
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

  requestAll(action: () => void): void {
    const scopes = [...this.guards.keys()]
    const visit = (index: number): void => {
      if (index === scopes.length) {
        action()
        return
      }
      // Each confirmation discards only its own draft. Canceling a later confirmation stops
      // the page action, without undoing an earlier explicit discard.
      this.request(scopes[index], () => visit(index + 1))
    }
    visit(0)
  }

  hasUnsavedChanges(): boolean {
    return [...this.guards.values()].some(({ isDirty }) => isDirty())
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
