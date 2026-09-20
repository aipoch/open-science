import type { LogFlushResult } from '../logger'

export type DiagnosticFlush = () => Promise<LogFlushResult | void>

export type DiagnosticFlushOutcome = 'flushed' | 'failed' | 'timeout'

export const flushDiagnosticsWithTimeout = async (
  flush: DiagnosticFlush,
  timeoutMs: number
): Promise<DiagnosticFlushOutcome> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
    timer.unref?.()
  })
  const result = await Promise.race([
    Promise.resolve()
      .then(flush)
      .then(
        (result) => (result?.failed ? ('failed' as const) : ('flushed' as const)),
        () => 'failed' as const
      ),
    timeout
  ])
  if (timer) clearTimeout(timer)
  return result
}
