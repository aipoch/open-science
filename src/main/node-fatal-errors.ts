/** Fatal failures cannot leave a half-alive local service holding its directory lock. */
export function installNodeFatalErrors(options: {
  process: Pick<NodeJS.Process, 'on' | 'off' | 'exit'>
  report(error: unknown, kind: 'uncaughtException' | 'unhandledRejection'): void
}): () => void {
  let exiting = false
  const fail = (error: unknown, kind: 'uncaughtException' | 'unhandledRejection'): void => {
    if (exiting) return
    exiting = true
    try {
      options.report(error, kind)
    } finally {
      // A throwing log sink must not convert a fatal failure into an orphan service.
      options.process.exit(1)
    }
  }
  const exception = (error: unknown): void => fail(error, 'uncaughtException')
  const rejection = (error: unknown): void => fail(error, 'unhandledRejection')
  options.process.on('uncaughtException', exception)
  options.process.on('unhandledRejection', rejection)
  return () => {
    options.process.off('uncaughtException', exception)
    options.process.off('unhandledRejection', rejection)
  }
}
