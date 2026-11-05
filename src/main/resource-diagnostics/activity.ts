// Event-driven activity only: observing this state must never poll the OS or start a timer.
export class ResourceActivity {
  private foreground = false
  private suspended = false
  private work = 0
  private readonly listeners = new Set<() => void>()

  get state(): Readonly<{ sampling: boolean; suspended: boolean }> {
    return {
      sampling: !this.suspended && (this.foreground || this.work > 0),
      suspended: this.suspended
    }
  }

  setDesktop(state: { foreground: boolean; suspended: boolean }): void {
    this.change(() => {
      this.foreground = state.foreground
      this.suspended = state.suspended
    })
  }

  begin(): () => void {
    this.change(() => this.work++)
    let ended = false
    return () => {
      if (ended) return
      ended = true
      this.change(() => this.work--)
    }
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    const end = this.begin()
    try {
      return await work()
    } finally {
      end()
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private change(update: () => void): void {
    const before = this.state
    update()
    const after = this.state
    if (before.sampling === after.sampling && before.suspended === after.suspended) return
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // Diagnostic observers must not affect task admission or completion.
      }
    }
  }
}

export const resourceActivity = new ResourceActivity()
