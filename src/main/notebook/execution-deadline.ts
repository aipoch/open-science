// Human approval time is not workload execution time. Cancellation remains independent.
export class ExecutionDeadline {
  private timer?: ReturnType<typeof setTimeout>
  private remaining: number
  private startedAt = 0
  private cancelled = false

  constructor(
    milliseconds: number,
    private readonly expire: () => void,
    paused = false
  ) {
    this.remaining = milliseconds
    this.setPaused(paused)
  }

  setPaused(paused: boolean): void {
    if (this.cancelled) return
    if (paused) {
      if (!this.timer) return
      clearTimeout(this.timer)
      this.timer = undefined
      this.remaining = Math.max(0, this.remaining - (performance.now() - this.startedAt))
    } else if (!this.timer) {
      this.startedAt = performance.now()
      this.timer = setTimeout(() => {
        this.cancelled = true
        this.expire()
      }, this.remaining)
    }
  }

  cancel(): void {
    this.cancelled = true
    clearTimeout(this.timer)
  }
}
