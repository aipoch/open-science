import type { SessionKey } from './durable-delegated-work-contract'

type DelegatedCleanupScope = Readonly<{
  session: SessionKey
  frameId: string
  attemptId: string
}>

type CleanupErrorReporter = (scope: DelegatedCleanupScope, error: unknown) => void

type DelegatedCleanup = Readonly<{
  report(scope: DelegatedCleanupScope, operation: string, error: unknown): void
  start(
    scope: DelegatedCleanupScope,
    operation: string,
    cleanup: () => unknown | Promise<unknown>,
    reportsOwnFailure?: boolean
  ): void
  retryable(
    scope: DelegatedCleanupScope,
    operationName: string,
    operation: () => Promise<void>
  ): () => Promise<void>
}>

const createDelegatedCleanup = (onCleanupError?: CleanupErrorReporter): DelegatedCleanup => {
  const report = (scope: DelegatedCleanupScope, operation: string, error: unknown): void => {
    const cleanupError = new AggregateError(
      [error],
      `Detached Subagent cleanup failed during ${operation}.`
    )
    try {
      if (onCleanupError) {
        onCleanupError(scope, cleanupError)
        return
      }
      console.error('[delegated-work] Detached Subagent cleanup failed.', {
        ...scope,
        operation,
        error
      })
    } catch (reportError) {
      console.error('[delegated-work] Could not report detached Subagent cleanup failure.', {
        ...scope,
        operation,
        error,
        reportError
      })
    }
  }

  const start = (
    scope: DelegatedCleanupScope,
    operation: string,
    cleanup: () => unknown | Promise<unknown>,
    reportsOwnFailure = false
  ): void => {
    let result: unknown | Promise<unknown>
    try {
      result = cleanup()
    } catch (error) {
      report(scope, operation, error)
      return
    }
    void Promise.resolve(result).catch((error) => {
      if (!reportsOwnFailure) report(scope, operation, error)
    })
  }

  const retryable = (
    scope: DelegatedCleanupScope,
    operationName: string,
    operation: () => Promise<void>
  ): (() => Promise<void>) => {
    let completed = false
    let inFlight: Promise<void> | undefined
    let queuedRetry: Promise<void> | undefined
    const runStep = (): Promise<void> => {
      if (completed) return Promise.resolve()
      if (inFlight) {
        if (!queuedRetry) {
          const current = inFlight
          const retry = current.catch(() => runStep())
          queuedRetry = retry
          void retry.then(
            () => {
              if (queuedRetry === retry) queuedRetry = undefined
            },
            () => {
              if (queuedRetry === retry) queuedRetry = undefined
            }
          )
        }
        return queuedRetry
      }
      let started: Promise<void>
      try {
        started = operation()
      } catch (error) {
        report(scope, operationName, error)
        return Promise.reject(error)
      }
      const current = started.then(
        () => {
          completed = true
          inFlight = undefined
        },
        (error) => {
          inFlight = undefined
          report(scope, operationName, error)
          throw error
        }
      )
      inFlight = current
      return current
    }
    return runStep
  }

  return { report, retryable, start }
}

export { createDelegatedCleanup }
export type { DelegatedCleanupScope }
