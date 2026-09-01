type PreviewLeaveGuard = () => boolean

class PreviewLeaveGuardCoordinator {
  private readonly guards = new Map<string, PreviewLeaveGuard>()

  register(scope: string, guard: PreviewLeaveGuard): () => void {
    this.guards.set(scope, guard)
    return () => {
      if (this.guards.get(scope) === guard) this.guards.delete(scope)
    }
  }

  request(scope: string | undefined, action: () => void): boolean {
    if (scope && this.guards.get(scope)?.() === false) return false
    action()
    return true
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
