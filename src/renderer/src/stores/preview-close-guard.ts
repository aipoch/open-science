// Closing a Side chat tab deletes its saved conversation; switching or collapsing does not.
class PreviewCloseGuards {
  private guards = new Map<string, (approve: () => void) => void>()
  private approved = new Set<string>()

  register(id: string, confirm: (approve: () => void) => void): () => void {
    this.guards.set(id, confirm)
    return () => {
      if (this.guards.get(id) === confirm) this.guards.delete(id)
    }
  }

  runApproved(ids: string[], action: () => unknown): void {
    const previous = this.approved
    this.approved = new Set([...previous, ...ids])
    try {
      action()
    } finally {
      this.approved = previous
    }
  }

  request(ids: string[], retry: () => unknown): boolean {
    const pending = ids.filter((id) => this.guards.has(id) && !this.approved.has(id))
    if (!pending.length) return true
    const confirm = (index: number): void => {
      if (index === pending.length) {
        this.runApproved(pending, retry)
        return
      }
      const guard = this.guards.get(pending[index])
      if (guard) guard(() => confirm(index + 1))
      else confirm(index + 1)
    }
    confirm(0)
    return false
  }
}
export const previewCloseGuards = new PreviewCloseGuards()
