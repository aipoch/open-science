type OfficePreviewLeaseListener = (active: boolean) => void

// Grants the single parent-window Office runtime to the most recently mounted preview surface.
class OfficePreviewHostLeaseCoordinator {
  private readonly listeners: OfficePreviewLeaseListener[] = []

  register(listener: OfficePreviewLeaseListener): () => void {
    this.listeners.at(-1)?.(false)

    this.listeners.push(listener)
    listener(true)

    return () => {
      const index = this.listeners.indexOf(listener)
      if (index < 0) return

      const wasActive = index === this.listeners.length - 1
      this.listeners.splice(index, 1)
      if (wasActive) this.listeners.at(-1)?.(true)
    }
  }
}

const officePreviewHostLeaseCoordinator = new OfficePreviewHostLeaseCoordinator()

export { OfficePreviewHostLeaseCoordinator, officePreviewHostLeaseCoordinator }
