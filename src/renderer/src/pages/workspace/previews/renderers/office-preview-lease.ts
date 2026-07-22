type OfficePreviewLeaseListener = (active: boolean) => void

type OfficePreviewLeaseEntry = {
  id: string
  listener: OfficePreviewLeaseListener
}

// Grants the single parent-window Office runtime to the most recently mounted preview surface.
class OfficePreviewHostLeaseCoordinator {
  private readonly entries: OfficePreviewLeaseEntry[] = []

  register(id: string, listener: OfficePreviewLeaseListener): () => void {
    const previous = this.entries.at(-1)
    previous?.listener(false)

    const entry = { id, listener }
    this.entries.push(entry)
    listener(true)

    return () => {
      const index = this.entries.indexOf(entry)
      if (index < 0) return

      const wasActive = index === this.entries.length - 1
      this.entries.splice(index, 1)
      if (wasActive) this.entries.at(-1)?.listener(true)
    }
  }
}

const officePreviewHostLeaseCoordinator = new OfficePreviewHostLeaseCoordinator()

export { OfficePreviewHostLeaseCoordinator, officePreviewHostLeaseCoordinator }
