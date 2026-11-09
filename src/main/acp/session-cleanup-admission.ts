import { createLogger } from '@aipoch/diagnostics/node'

const log = createLogger('acp-session-cleanup')
const DEFAULT_TRANSITION_TIMEOUT_MS = 10_000

type AcpSessionCleanupAdmissionOptions = Readonly<{
  activeTransition: () => Readonly<{ kind: string; completion: Promise<unknown> }> | undefined
  withActivity: <Result>(work: () => Promise<Result>) => Promise<Result>
  assertReady: () => void
  diagnosticContext: () => Readonly<Record<string, unknown>>
}>

// Cleanup may bypass queued intents, but never an executing connection or model transition.
class AcpSessionCleanupAdmission {
  constructor(private readonly options: AcpSessionCleanupAdmissionOptions) {}

  async run<Result>(work: () => Promise<Result>): Promise<Result> {
    const deadline = Date.now() + DEFAULT_TRANSITION_TIMEOUT_MS
    for (;;) {
      const transition = this.options.activeTransition()
      if (!transition) {
        // Keep the stable-state check and activity acquisition in the same synchronous turn.
        // The lease blocks reconnect, model application, and retirement until cleanup finishes.
        return this.options.withActivity(async () => {
          this.options.assertReady()
          return work()
        })
      }
      this.reportWaiting(transition.kind)
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw this.timeoutError()
      await this.waitForTransition(transition.completion, remaining)
      // Re-read ownership after every await; another transition may already have started.
    }
  }

  private async waitForTransition(completion: Promise<unknown>, remaining: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        completion,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(this.timeoutError()), remaining)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
    // Only the observation is timed out. No deferred callback can run cleanup after failure.
  }

  private timeoutError(): Error {
    return new Error('ACP Session cleanup timed out waiting for an active lifecycle transition.')
  }

  private reportWaiting(transition: string): void {
    try {
      log.info('session cleanup waiting for active transition', {
        ...this.options.diagnosticContext(),
        transition
      })
    } catch {
      // Diagnostics must not change cleanup admission or the original failure.
    }
  }
}

export { AcpSessionCleanupAdmission }
export type { AcpSessionCleanupAdmissionOptions }
