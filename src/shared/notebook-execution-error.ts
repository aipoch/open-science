import type { NotebookExecutionRecovery } from './execution-recovery'

// A failed stop is an execution-integrity failure, not an ordinary user-code error or cancellation.
// Keep its identity across in-process Notebook, ACP, and Task boundaries; never persist the instance.
export class NotebookExecutionStopError extends Error {
  readonly recovery?: NotebookExecutionRecovery

  constructor(
    message = 'Notebook process tree could not be stopped.',
    options?: ErrorOptions & { recovery?: NotebookExecutionRecovery }
  ) {
    super(message, options)
    this.name = 'NotebookExecutionStopError'
    this.recovery = options?.recovery
  }
}

// Typed host evidence survives cleanup failures without trusting text printed by executed code.
export class NotebookKernelExitError extends Error {
  constructor(
    message: string,
    public recovery: NotebookExecutionRecovery
  ) {
    super(message)
    this.name = 'NotebookKernelExitError'
  }
}

export const notebookErrorRecovery = (error: unknown): NotebookExecutionRecovery | undefined => {
  if (error instanceof NotebookKernelExitError) return error.recovery
  if (error instanceof NotebookExecutionStopError && error.recovery) return error.recovery
  if (error instanceof NotebookExecutionStopError && error.cause instanceof NotebookKernelExitError)
    return error.cause.recovery
  return undefined
}
