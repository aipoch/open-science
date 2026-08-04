import type { CallerContext } from '../caller-context'
import { diagnosticErrorFields, type Logger } from '../logger'

type IpcRejectionLogger = Pick<Logger, 'warn'>

type IpcRejectionDiagnosticInput<T> = {
  channel: string
  callerContext: Pick<CallerContext, 'surface' | 'location' | 'principalKind' | 'actionOrigin'>
  invoke: () => T | PromiseLike<T>
  log: IpcRejectionLogger
  now?: () => number
}

const safeNow = (now: () => number): number => {
  try {
    const value = now()
    return Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

/**
 * Adds the universal rejected-request floor around an IPC invocation.
 *
 * This adapter deliberately has no access to the request arguments or result. Its entire diagnostic
 * vocabulary is fixed caller metadata plus a coarse error category, and all diagnostic work is
 * best-effort so it can never replace the handler's authoritative result or rejection.
 */
export const invokeWithIpcRejectionDiagnostics = <T>(
  input: IpcRejectionDiagnosticInput<T>
): T | PromiseLike<T> => {
  const now = input.now ?? performance.now.bind(performance)
  const startedAt = safeNow(now)
  const recordRejection = (error: unknown): void => {
    try {
      input.log.warn('ipc handler rejected', {
        channel: input.channel,
        surface: input.callerContext.surface,
        location: input.callerContext.location,
        principalKind: input.callerContext.principalKind,
        actionOrigin: input.callerContext.actionOrigin,
        durationMs: Math.max(0, safeNow(now) - startedAt),
        ...diagnosticErrorFields(error)
      })
    } catch {
      // Diagnostic failures must never replace the handler's original rejection.
    }
  }

  try {
    const result = input.invoke()
    if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
      const then = (result as { then?: unknown }).then
      if (typeof then !== 'function') return result

      // Promise.resolve(result) would read a thenable's `then` getter a second time. Assimilate the
      // cached function on a microtask instead, matching native timing while preserving one-shot or
      // side-effectful thenables and their authoritative rejection value.
      const assimilated = new Promise<T>((resolve, reject) => {
        queueMicrotask(() => {
          try {
            Reflect.apply(then, result, [resolve, reject])
          } catch (error) {
            reject(error)
          }
        })
      })
      return assimilated.catch((error: unknown) => {
        recordRejection(error)
        throw error
      })
    }
    return result
  } catch (error) {
    recordRejection(error)
    throw error
  }
}

export type { IpcRejectionDiagnosticInput, IpcRejectionLogger }
