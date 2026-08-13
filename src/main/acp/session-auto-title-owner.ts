import type { AcpTurnTokenUsage } from '../../shared/acp'
import { sanitizeSessionTitle } from '../../shared/session-persistence'

const DEFAULT_SESSION_AUTO_TITLE_GRACE_MS = 250
const DEFAULT_SESSION_AUTO_TITLE_DEADLINE_MS = 15_000
const DEFAULT_SESSION_AUTO_TITLE_SHUTDOWN_DEADLINE_MS = 5_000

type SessionAutoTitleGeneration = Readonly<{
  title: string
  usage?: AcpTurnTokenUsage
}>

type SessionAutoTitleOwnerOptions = Readonly<{
  graceMs?: number
  deadlineMs?: number
  shutdownDeadlineMs?: number
  generate: (input: { prompt: string; signal: AbortSignal }) => Promise<SessionAutoTitleGeneration>
  dispose?: () => Promise<void>
  onCleanupTimeout?: (details: { activeAttempts: number }) => void
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}>

type ActiveTitleAttempt = {
  sessionId: string
  controller: AbortController
  generation?: Promise<void>
}

type SessionAutoTitleOutcome =
  | Readonly<{ kind: 'framework'; attempted: boolean; usage?: AcpTurnTokenUsage }>
  | Readonly<{ kind: 'generated'; title: string; usage?: AcpTurnTokenUsage }>
  | Readonly<{ kind: 'unavailable'; attempted: boolean; usage?: AcpTurnTokenUsage }>

// Owns the intentionally small race between a framework-native title and the tool-less app fallback.
// Callers see one outcome; timers, abort forwarding, title sanitization, and shutdown stay private.
class SessionAutoTitleOwner {
  private readonly frameworkTitles = new Set<string>()
  private readonly promptMessageIds = new Map<string, string>()
  private readonly active = new Map<string, Set<ActiveTitleAttempt>>()

  constructor(private readonly options: SessionAutoTitleOwnerOptions) {}

  registerPrompt(sessionId: string, promptMessageId: string | undefined): void {
    if (promptMessageId && !this.promptMessageIds.has(sessionId)) {
      this.promptMessageIds.set(sessionId, promptMessageId)
    }
  }

  observeFrameworkTitle(sessionId: string): string | undefined {
    this.frameworkTitles.add(sessionId)
    for (const attempt of this.active.get(sessionId) ?? []) attempt.controller.abort()
    return this.promptMessageIds.get(sessionId)
  }

  async complete(input: {
    sessionId: string
    prompt: string
    signal: AbortSignal
    isCurrent: () => boolean
  }): Promise<SessionAutoTitleOutcome> {
    if (this.frameworkTitles.delete(input.sessionId)) return { kind: 'framework', attempted: false }
    if (!input.prompt.trim() || input.signal.aborted || !input.isCurrent()) {
      return { kind: 'unavailable', attempted: false }
    }
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    input.signal.addEventListener('abort', abort, { once: true })
    const attempt: ActiveTitleAttempt = { sessionId: input.sessionId, controller }
    const sessionAttempts = this.active.get(input.sessionId) ?? new Set<ActiveTitleAttempt>()
    sessionAttempts.add(attempt)
    this.active.set(input.sessionId, sessionAttempts)
    try {
      await this.waitForFrameworkGrace(controller.signal)
      if (this.frameworkTitles.delete(input.sessionId)) {
        return { kind: 'framework', attempted: false }
      }
      if (controller.signal.aborted || !input.isCurrent()) {
        return { kind: 'unavailable', attempted: false }
      }
      const result = await this.generateWithinDeadline(input.prompt, attempt)
      const frameworkWon = this.frameworkTitles.delete(input.sessionId)
      if (frameworkWon) {
        return {
          kind: 'framework',
          attempted: true,
          ...(result.kind === 'completed' && result.value.usage
            ? { usage: result.value.usage }
            : {})
        }
      }
      if (result.kind !== 'completed' || !input.isCurrent()) {
        return { kind: 'unavailable', attempted: true }
      }
      const generation = result.value
      const title = sanitizeSessionTitle(generation.title)
      return title
        ? { kind: 'generated', title, ...(generation.usage ? { usage: generation.usage } : {}) }
        : {
            kind: 'unavailable',
            attempted: true,
            ...(generation.usage ? { usage: generation.usage } : {})
          }
    } finally {
      input.signal.removeEventListener('abort', abort)
      if (!attempt.generation) this.removeAttempt(input.sessionId, attempt)
    }
  }

  clearSession(sessionId: string): void {
    this.frameworkTitles.delete(sessionId)
    this.promptMessageIds.delete(sessionId)
    for (const attempt of this.active.get(sessionId) ?? []) attempt.controller.abort()
  }

  shutdown(): Promise<void> {
    const attempts = Array.from(this.active.values()).flatMap((sessionAttempts) => [
      ...sessionAttempts
    ])
    for (const attempt of attempts) attempt.controller.abort()
    this.frameworkTitles.clear()
    this.promptMessageIds.clear()
    const generations = Promise.allSettled(
      attempts.flatMap((attempt) => (attempt.generation ? [attempt.generation] : []))
    ).then(() => undefined)
    const disposer = this.options.dispose
      ? Promise.resolve().then(() => this.options.dispose?.())
      : Promise.resolve()
    const cleanup = Promise.all([generations, disposer]).then(() => undefined)
    return this.waitForShutdownCleanup(cleanup, attempts.length)
  }

  private async generateWithinDeadline(
    prompt: string,
    attempt: ActiveTitleAttempt
  ): Promise<
    | Readonly<{ kind: 'completed'; value: SessionAutoTitleGeneration }>
    | Readonly<{ kind: 'failed' | 'cancelled' | 'timed-out' }>
  > {
    const setTimer = this.options.setTimer ?? setTimeout
    const clearTimer = this.options.clearTimer ?? clearTimeout
    const deadline = this.options.deadlineMs ?? DEFAULT_SESSION_AUTO_TITLE_DEADLINE_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    let removeAbortListener = (): void => undefined
    const interrupted = new Promise<Readonly<{ kind: 'cancelled' | 'timed-out' }>>((resolve) => {
      const onAbort = (): void => resolve({ kind: 'cancelled' })
      attempt.controller.signal.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () => attempt.controller.signal.removeEventListener('abort', onAbort)
      if (deadline <= 0) {
        attempt.controller.abort()
        resolve({ kind: 'timed-out' })
        return
      }
      timer = setTimer(() => {
        attempt.controller.abort()
        resolve({ kind: 'timed-out' })
      }, deadline)
    })
    const generated = Promise.resolve()
      .then(() => this.options.generate({ prompt, signal: attempt.controller.signal }))
      .then((value) => ({ kind: 'completed' as const, value }))
      .catch(() => ({ kind: 'failed' as const }))
    attempt.generation = generated.then(() => undefined)
    void attempt.generation.finally(() => this.removeAttempt(attempt.sessionId, attempt))
    try {
      return await Promise.race([generated, interrupted])
    } finally {
      if (timer !== undefined) clearTimer(timer)
      removeAbortListener()
    }
  }

  private removeAttempt(sessionId: string, attempt: ActiveTitleAttempt): void {
    const sessionAttempts = this.active.get(sessionId)
    sessionAttempts?.delete(attempt)
    if (sessionAttempts?.size === 0) this.active.delete(sessionId)
  }

  private async waitForShutdownCleanup(
    cleanup: Promise<void>,
    activeAttempts: number
  ): Promise<void> {
    const deadline =
      this.options.shutdownDeadlineMs ?? DEFAULT_SESSION_AUTO_TITLE_SHUTDOWN_DEADLINE_MS
    if (deadline <= 0) {
      void cleanup.catch(() => undefined)
      this.options.onCleanupTimeout?.({ activeAttempts })
      return
    }
    const setTimer = this.options.setTimer ?? setTimeout
    const clearTimer = this.options.clearTimer ?? clearTimeout
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timed-out'>((resolve) => {
      timer = setTimer(() => resolve('timed-out'), deadline)
    })
    let result: 'completed' | 'timed-out'
    try {
      result = await Promise.race([cleanup.then(() => 'completed' as const), timedOut])
    } finally {
      if (timer !== undefined) clearTimer(timer)
    }
    if (result === 'timed-out') this.options.onCleanupTimeout?.({ activeAttempts })
  }

  private waitForFrameworkGrace(signal: AbortSignal): Promise<void> {
    const delay = this.options.graceMs ?? DEFAULT_SESSION_AUTO_TITLE_GRACE_MS
    if (delay <= 0 || signal.aborted) return Promise.resolve()
    const setTimer = this.options.setTimer ?? setTimeout
    const clearTimer = this.options.clearTimer ?? clearTimeout
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimer(timer)
        signal.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimer(finish, delay)
      signal.addEventListener('abort', finish, { once: true })
    })
  }
}

export {
  DEFAULT_SESSION_AUTO_TITLE_DEADLINE_MS,
  DEFAULT_SESSION_AUTO_TITLE_GRACE_MS,
  DEFAULT_SESSION_AUTO_TITLE_SHUTDOWN_DEADLINE_MS,
  SessionAutoTitleOwner
}
export type { SessionAutoTitleGeneration, SessionAutoTitleOutcome, SessionAutoTitleOwnerOptions }
