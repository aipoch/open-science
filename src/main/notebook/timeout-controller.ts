// Two-stage interrupt/kill state machine for one in-flight exec-loop request. Kept separate from the
// executor (and with injectable timers/kill) so its arm -> soft(SIGINT) -> hard(SIGKILL) transitions
// are unit-testable without a real child process.

// Node-side wait before interrupting a run at all.
export const DEFAULT_TIMEOUT_MS = 120_000
// After SIGINT, how long we wait for the loop to actually stop before escalating to SIGKILL.
export const HARD_GRACE_MS = 2_000

// Opaque timer identity; the default scheduler returns a NodeJS.Timeout, tests return a number.
type TimerHandle = unknown
type ScheduleTimer = (fn: () => void, ms: number) => TimerHandle
type CancelTimer = (handle: TimerHandle) => void

export type TimeoutControllerDeps = {
  // Sends a signal to the target process; injected so the state machine needs no real child.
  kill: (signal: NodeJS.Signals) => void
  // Invoked once SIGINT has been ignored through the hard grace and SIGKILL was sent; the driver
  // then drops the wedged process and rejects the pending run as a timeout.
  onHardTimeout: () => void
  schedule?: ScheduleTimer
  cancel?: CancelTimer
  hardGraceMs?: number
}

// Real scheduler: unref'd so a pending timeout alone never keeps the process alive.
const defaultSchedule: ScheduleTimer = (fn, ms) => {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return timer
}

const defaultCancel: CancelTimer = (handle) => clearTimeout(handle as NodeJS.Timeout)

export class TimeoutController {
  private softTimer: TimerHandle | undefined
  private hardTimer: TimerHandle | undefined
  private softFired = false
  private readonly schedule: ScheduleTimer
  private readonly cancel: CancelTimer
  private readonly hardGraceMs: number

  constructor(private readonly deps: TimeoutControllerDeps) {
    this.schedule = deps.schedule ?? defaultSchedule
    this.cancel = deps.cancel ?? defaultCancel
    this.hardGraceMs = deps.hardGraceMs ?? HARD_GRACE_MS
  }

  // Starts the soft-timeout countdown for one request.
  arm(timeoutMs: number): void {
    this.softTimer = this.schedule(() => this.onSoftTimeout(), timeoutMs)
  }

  // True once the soft timeout fired (an interrupt was sent), so any reply that still arrives is
  // reported as a timeout rather than trusted as a clean completion.
  get timedOut(): boolean {
    return this.softFired
  }

  // Clears any outstanding timers; called when the matching response arrives or the run is abandoned.
  disarm(): void {
    if (this.softTimer !== undefined) {
      this.cancel(this.softTimer)
      this.softTimer = undefined
    }
    if (this.hardTimer !== undefined) {
      this.cancel(this.hardTimer)
      this.hardTimer = undefined
    }
  }

  // Soft deadline hit: interrupt the loop and give it a grace window before the hard kill.
  private onSoftTimeout(): void {
    this.softTimer = undefined
    this.softFired = true
    this.deps.kill('SIGINT')
    this.hardTimer = this.schedule(() => this.onHardTimeout(), this.hardGraceMs)
  }

  // SIGINT was ignored: force-kill the loop and hand control back to the driver.
  private onHardTimeout(): void {
    this.hardTimer = undefined
    this.deps.kill('SIGKILL')
    this.deps.onHardTimeout()
  }
}
