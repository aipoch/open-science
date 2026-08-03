export type DiagnosticFlushOutcome = 'flushed' | 'failed' | 'timeout'

export const flushDiagnosticsWithTimeout = async (
  flush: () => Promise<void>,
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
        () => 'flushed' as const,
        () => 'failed' as const
      ),
    timeout
  ])
  if (timer) clearTimeout(timer)
  return result
}
