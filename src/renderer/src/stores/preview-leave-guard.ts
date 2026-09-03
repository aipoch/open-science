type PreviewLeaveAction = () => boolean | void
type PreviewLeaveGuard = (action: PreviewLeaveAction) => boolean

class PreviewLeaveGuardCoordinator {
  private readonly guards = new Map<string, PreviewLeaveGuard>()

  register(scope: string, guard: PreviewLeaveGuard): () => void {
    this.guards.set(scope, guard)
    return () => {
      if (this.guards.get(scope) === guard) this.guards.delete(scope)
    }
  }

  request(scope: string | undefined, action: PreviewLeaveAction): boolean {
    const guard = scope ? this.guards.get(scope) : undefined
    if (guard && !guard(action)) return false
    return action() !== false
  }

  clear(): void {
    this.guards.clear()
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
