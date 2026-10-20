import type { ChildProcess } from 'node:child_process'

const TERMINATION_GRACE_MS = 2_000
const FORCE_KILL_EVENT_GRACE_MS = 1_000

type TerminableChild = Pick<ChildProcess, 'kill' | 'stderr' | 'stdout' | 'unref'> & {
  on(event: 'error', listener: (error: Error) => void): unknown
}

/**
 * Gives a child a short graceful shutdown window, escalates to SIGKILL, then crosses a final hard
 * boundary even if Node never observes close. The owner still decides how its operation settles.
 */
export class BoundedChildTermination {
  private terminationTimer: NodeJS.Timeout | undefined
  private finalBoundaryTimer: NodeJS.Timeout | undefined
  private requested = false
  private processExited = false

  constructor(
    private readonly child: TerminableChild,
    private readonly onFinalBoundary: () => void
  ) {}

  request(): void {
    if (this.requested) return
    this.requested = true

    if (this.processExited) {
      this.scheduleFinalBoundary()
      return
    }

    this.safeKill('SIGTERM')
    this.terminationTimer = setTimeout(() => {
      this.terminationTimer = undefined
      this.safeKill('SIGKILL')
      this.scheduleFinalBoundary()
    }, TERMINATION_GRACE_MS)
  }

  observeExit(): void {
    this.processExited = true
    this.clearTimer(this.terminationTimer)
    this.terminationTimer = undefined
    if (this.requested) this.scheduleFinalBoundary()
  }

  stop(): void {
    this.clearTimer(this.terminationTimer)
    this.clearTimer(this.finalBoundaryTimer)
    this.terminationTimer = undefined
    this.finalBoundaryTimer = undefined
  }

  private scheduleFinalBoundary(): void {
    if (this.finalBoundaryTimer !== undefined) return
    this.finalBoundaryTimer = setTimeout(() => {
      this.finalBoundaryTimer = undefined
      this.detachChild()
      this.onFinalBoundary()
    }, FORCE_KILL_EVENT_GRACE_MS)
  }

  private safeKill(signal: NodeJS.Signals): void {
    try {
      this.child.kill(signal)
    } catch {
      // A failed signal delivery must not defeat the final settlement boundary.
    }
  }

  private detachChild(): void {
    // Late signal errors must not become unhandled after the caller no longer owns the child.
    this.child.on('error', () => undefined)
    this.child.stdout?.destroy()
    this.child.stderr?.destroy()
    this.child.unref()
  }

  private clearTimer(timer: NodeJS.Timeout | undefined): void {
    if (timer !== undefined) clearTimeout(timer)
  }
}
