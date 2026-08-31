/** Tracks connected UI clients that can answer app-owned permission requests. */
export class PermissionApprovalPresence {
  private clients = 0

  isAvailable(): boolean {
    return this.clients > 0
  }

  acquire(): () => void {
    this.clients += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.clients -= 1
    }
  }
}
